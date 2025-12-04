"""
WebSocket consumers for voice recognition.
"""

import json
import tempfile
import os
import asyncio
import base64
import re
import array
import time
import resource
import sys
from urllib.parse import parse_qs, urlparse
from channels.generic.websocket import AsyncWebsocketConsumer
from asgiref.sync import sync_to_async
from django.db import transaction
from django.conf import settings
import logging

try:
    from vosk import Model, KaldiRecognizer
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False

logger = logging.getLogger('parts.voice')
from .voice_logger import voice_logger
from .voice_commands import (
    STRICT_COMMAND_PHRASES,
    STRICT_COMMAND_GRAMMAR,
    match_strict_command,
    normalize_command_text,
)

CPU_CORES = os.cpu_count() or 1


class VoskConsumer(AsyncWebsocketConsumer):
    """
    Consumer de Django Channels que integra el servidor Vosk para reconocimiento de voz.
    Reemplaza el servidor Vosk standalone para tener mejor integración con Django.
    """
    
    # Configuración de Vosk
    SAMPLE_RATE = 16000
    VOSK_MODEL_PATH = getattr(settings, 'VOSK_MODEL_PATH', os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42'))
    
    # Comandos de entrenamiento (para documentación y futuras referencias)
    COMANDOS_ENTRENAMIENTO = {
        command: [phrase]
        for phrase, command in STRICT_COMMAND_PHRASES
    }
    
    # Modelo Vosk compartido (se carga una sola vez para todos los consumers)
    _model = None
    _model_lock = asyncio.Lock()
    MAX_CONNECTIONS_PER_USER = int(os.getenv('VOICE_WS_MAX_CONNECTIONS', '3'))
    _active_connections = {}
    _active_connections_lock = asyncio.Lock()
    
    @classmethod
    async def get_model(cls):
        """Carga el modelo Vosk de forma lazy y thread-safe"""
        if not VOSK_AVAILABLE:
            logger.error(" Vosk no está disponible. Instalar con: pip install vosk")
            return None
            
        async with cls._model_lock:
            if cls._model is None:
                logger.info(f" Cargando modelo Vosk desde {cls.VOSK_MODEL_PATH}")
                try:
                    # Cargar modelo en thread separado para no bloquear event loop
                    cls._model = await asyncio.to_thread(Model, cls.VOSK_MODEL_PATH)
                    logger.info(" Modelo Vosk cargado exitosamente")
                except Exception as e:
                    logger.error(f" Error cargando modelo Vosk: {e}")
                    return None
            return cls._model
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.recognizer = None
        self.recognizer_cmd = None
        self.transcripcion_habilitada = getattr(settings, 'VOICE_TRANSCRIPCION_VOSK_ACTIVA', False)
        self.usuario_id = None
        self.client_id = None
        self.audio_chunks_received = 0
        
        # Acumulación de PCM
        self.pcm_acumulado = bytearray()
        self.ultimo_feed_ms = 0
        
        # SOLO PARCIALES: Acumular texto, no audio
        self.is_capturing_session = False  # True entre "iniciar_proceso" y "finalizar_proceso"
        
        # Configuración de feed
        self.FEED_MIN_MUESTRAS = int(os.getenv('VOSK_FEED_MIN_SAMPLES', '800'))  # ventanas más cortas (~50ms)
        self.FEED_MAX_INTERVALO_MS = int(os.getenv('VOSK_FEED_MAX_INTERVAL_MS', '120'))  # Empuja flush cada 120ms
        self.FEED_MIN_BYTES = self.FEED_MIN_MUESTRAS * 2
        self.CMD_MIN_RMS = float(os.getenv('VOSK_CMD_MIN_RMS', '0.00005'))
        self.CMD_TARGET_RMS = float(os.getenv('VOSK_CMD_TARGET_RMS', '0.015'))
        self.CMD_MAX_GAIN = float(os.getenv('VOSK_CMD_MAX_GAIN', '8.0'))
        self.ultimo_feed_bytes = 0
        self.ultimo_chunk_recibido_ms = 0
        self.inicio_captura_ms = 0
        self.cmd_require_final = os.getenv('VOICE_CMD_REQUIRE_FINAL', 'true').lower() == 'true'
        
        # Control de comandos (debounce)
        self.last_cmd_sent_at = {
            'iniciar_proceso': 0,
            'finalizar_proceso': 0,
            'guardar_pieza': 0,
            'confirmar_datos': 0
        }
        # Debounce más corto para permitir reenfoque rápido (~0.5s)
        self.CMD_DEBOUNCE_MS = 500
        
        # Tracking de transcripciones parciales
        self.last_partial_text = ""
        self.last_partial_token_count = 0
        self.last_partial_timestamp = 0
        self.empty_partial_count = 0
        self.SILENCE_TIMEOUT_MS = int(os.getenv('VOICE_SILENCE_TIMEOUT_MS', '0'))
        self.last_audio_timestamp = 0  # Timestamp del último audio recibido
        
        # NUEVO: Acumulador de texto completo (solo parciales)
        self.accumulated_text = ""  # Texto completo acumulado durante captura
        self.last_sent_partial = ""  # Último partial enviado para evitar duplicados
        self.ultimo_texto_comando_transcripcion = ""
        self._transcripcion_no_disponible_reportada = False
        self.command_fillers = {
            'um', 'mmm', 'mm', 'uh', 'uhm', 'eh', 'em', 'este', 'pues', 'ah', 'ehh',
            'por', 'favor', 'porfavor', 'por_favor', 'please', 'gracias',
            'la', 'el', 'los', 'las', 'al', 'del', 'de', 'lo', 'le'
        }
        self.command_context_words = {
            'proceso', 'captura', 'capturar', 'capturando', 'grabacion', 'grabación',
            'grabar', 'grabando', 'voz', 'sistema', 'datos', 'registro'
        }
        self._last_command_token = None
        self._last_command_phrase = None
        self.command_allow_anywhere = os.getenv('VOICE_CMD_ALLOW_ANYWHERE', 'false').lower() == 'true'
        self.CMD_ALLOW_LOW_RMS = os.getenv('VOSK_CMD_ALLOW_LOW_RMS', 'true').lower() == 'true'
        self.ENABLE_SILENCE_PADDING = os.getenv('VOICE_ENABLE_SILENCE_PADDING', 'false').lower() == 'true'
        self.CMD_MIN_CONFIDENCE = float(os.getenv('VOICE_CMD_MIN_CONFIDENCE', '0.65'))
        self._last_usage_sample = None
        self.pending_command_confidence = None
        self.fast_cmd_candidate = None
        self.PENDING_CONFIDENCE_WINDOW_MS = int(os.getenv('VOICE_CMD_CONF_WINDOW_MS', '5000'))
        self.FAST_CMD_CONFIRMATION_MS = int(os.getenv('VOICE_CMD_FAST_CONFIRM_MS', '350'))
        self.AUDIO_RMS_LOW = float(os.getenv('VOICE_AUDIO_RMS_LOW', '0.0015'))
        self.AUDIO_RMS_HIGH = float(os.getenv('VOICE_AUDIO_RMS_HIGH', '0.12'))
        self._connection_user_key = None
        
    async def connect(self):
        """Acepta la conexión WebSocket e inicializa reconocedores"""
        user = self.scope.get('user')
        if not user or not user.is_authenticated:
            await self.close(code=4401)
            return

        authenticated_user_id = str(user.id)

        # Obtener usuario_id de query params si está disponible
        query_string = self.scope.get('query_string', b'').decode('utf-8')
        provided_user_id = None
        if query_string:
            params = parse_qs(query_string)
            provided_user_id = params.get('usuario_id', [None])[0] or params.get('user_id', [None])[0]

        if provided_user_id and provided_user_id != authenticated_user_id:
            self._log_flow(
                'user_mismatch',
                level='warning',
                event='voice_ws_user_mismatch',
                provided_user_id=provided_user_id,
                authenticated_user_id=authenticated_user_id
            )
            await self.close(code=4403)
            return

        allowed, active_count = await self._register_connection(authenticated_user_id)
        if not allowed:
            self._log_flow(
                'connection_limit',
                level='warning',
                event='voice_ws_limit_reached',
                usuario_id=authenticated_user_id
            )
            await self.close(code=4429)
            return

        self._connection_user_key = authenticated_user_id
        self.usuario_id = authenticated_user_id

        try:
            await self.accept()
        except Exception:
            await self._release_connection()
            raise

        self.client_id = id(self)
        usage = self._collect_usage_metrics()
        self._log_flow(
            'client_connected',
            event='voice_ws_connected',
            usuario_id=self.usuario_id,
            active_connections=active_count,
            **usage
        )
        
        # Cargar modelo Vosk
        model = await self.get_model()
        if not model:
            self._log_flow(
                'model_not_available',
                level='error',
                event='voice_model_missing',
                model_path=self.VOSK_MODEL_PATH
            )
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': 'Modelo Vosk no disponible'
            }))
            await self.close()
            return
        
        # Crear reconocedores en thread separado
        try:
            # Importar vocabulario automotriz
            from parts.vocabulario_automotriz import obtener_vocabulario_json
            
            if self.transcripcion_habilitada:
                self._log_flow('transcripcion_habilitada', event='voice_transcription_enabled')
                vocabulario_json = obtener_vocabulario_json()
                self.recognizer = await asyncio.to_thread(
                    KaldiRecognizer, model, self.SAMPLE_RATE, vocabulario_json
                )
                
                self.recognizer.SetWords(True)
                self.recognizer.SetMaxAlternatives(10)
                self.recognizer.SetPartialWords(True)
                self.recognizer.SetNLSML(False)
                
                try:
                    if hasattr(self.recognizer, 'SetMaxRecognitionDelay'):
                        self.recognizer.SetMaxRecognitionDelay(0.8)
                        self._log_flow(
                            'max_delay_configured',
                            event='voice_config',
                            recognition_delay=0.8
                        )
                except Exception as e_config:
                    self._log_flow(
                        'max_delay_unavailable',
                        level='debug',
                        event='voice_config_warning',
                        error=str(e_config)
                    )
            else:
                self._log_flow('transcripcion_deshabilitada', event='voice_transcription_disabled')

            # Reconocedor para comandos con gramática estricta (sólo palabras exactas)
            base_terms = STRICT_COMMAND_GRAMMAR
            command_grammar = json.dumps(base_terms)
            
            try:
                self.recognizer_cmd = await asyncio.to_thread(
                    KaldiRecognizer, model, self.SAMPLE_RATE, command_grammar
                )
                self.recognizer_cmd.SetWords(True)
            except Exception:
                # Fallback sin gramática
                self.recognizer_cmd = await asyncio.to_thread(
                    KaldiRecognizer, model, self.SAMPLE_RATE
                )
                self.recognizer_cmd.SetWords(True)
            
            # Cargar estado de adaptación del usuario si existe
            if self.usuario_id:
                await self.cargar_estado_usuario()
            
            # Enviar confirmación al cliente
            await self.send(text_data=json.dumps({
                'type': 'connected',
                'message': 'Servidor Vosk listo (Django Channels)',
                'sample_rate': self.SAMPLE_RATE,
                'usuario_id': self.usuario_id,
                'transcripcion_activa': self.transcripcion_habilitada
            }))
            
        except Exception as e:
            self._log_flow(
                'error_inicializando_reconocedores',
                level='error',
                event='voice_ws_init_error',
                error=str(e)
            )
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'Error de inicialización: {str(e)}'
            }))
            await self.close()
    
    async def disconnect(self, close_code):
        """Maneja la desconexión y guarda el estado de adaptación"""
        self._log_flow(
            'client_disconnected',
            event='voice_ws_disconnected',
            close_code=close_code
        )
        await self._release_connection()

    async def _register_connection(self, user_key: str) -> tuple[bool, int]:
        async with self._active_connections_lock:
            count = self._active_connections.get(user_key, 0)
            if count >= self.MAX_CONNECTIONS_PER_USER:
                return False, count
            self._active_connections[user_key] = count + 1
            return True, count + 1

    async def _release_connection(self) -> None:
        if not self._connection_user_key:
            return
        async with self._active_connections_lock:
            current = self._active_connections.get(self._connection_user_key, 0)
            if current <= 1:
                self._active_connections.pop(self._connection_user_key, None)
            else:
                self._active_connections[self._connection_user_key] = current - 1
        self._connection_user_key = None
        
        # CRÍTICO: Solicitar resultado final antes de desconectar para capturar últimos segundos
        if self.recognizer:
            try:
                self._log_flow('solicitando_final', event='voice_final_request')
                final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                result_json = json.loads(final_result)
                final_text = result_json.get('text', '')
                
                if final_text:
                    stats = self._confidence_stats(result_json)
                    self._log_flow(
                        'resultado_final',
                        event='voice_final_before_disconnect',
                        text=final_text,
                        **stats
                    )
                    # Enviar resultado final al cliente antes de cerrar
                    await self.send(text_data=json.dumps({
                        'type': 'final',
                        'text': final_text,
                        'is_disconnect': True
                    }))
                else:
                    self._log_flow('final_vacio', level='debug', event='voice_final_empty')
            except Exception as e:
                self._log_flow(
                    'error_final_result',
                    level='error',
                    event='voice_final_error',
                    error=str(e)
                )
        
        # Guardar estado de adaptación si hay usuario
        if self.usuario_id and self.recognizer:
            try:
                await self.guardar_estado_usuario()
            except Exception as e:
                logger.error(f" Error guardando estado de adaptación: {e}")
    
    async def receive(self, text_data=None, bytes_data=None):
        """Recibe mensajes del cliente"""
        
        # Mensajes de texto (control)
        if text_data:
            try:
                payload = json.loads(text_data)
                message_type = payload.get('type')
                
                # Solicitud de resultado final (capturar últimas palabras)
                if message_type == 'request_final':
                    self._log_flow('request_final', event='voice_request_final')
                    if self.recognizer:
                        try:
                            # Enviar silencio para forzar que Vosk procese todo
                            silence = bytes(6400)  # 200ms de silencio a 16kHz
                            await asyncio.to_thread(self.recognizer.AcceptWaveform, silence)
                            
                            final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                            result_json = json.loads(final_result)
                            final_text = result_json.get('text', '')
                            
                            self._log_flow(
                                'resultado_request_final',
                                event='voice_request_final_result',
                                text=final_text
                            )
                            
                            await self.send(text_data=json.dumps({
                                'type': 'final',
                                'text': final_text,
                                'source': 'request_final'
                            }))
                        except Exception as e:
                            self._log_flow(
                                'request_final_error',
                                level='error',
                                event='voice_request_final_error',
                                error=str(e)
                            )
                    return
                
                if message_type == 'identificacion':
                    nuevo_usuario_id = payload.get('usuario_id') or payload.get('user_id')
                    if nuevo_usuario_id and nuevo_usuario_id != self.usuario_id:
                        self.usuario_id = nuevo_usuario_id
                        await self.cargar_estado_usuario()
                        self._log_flow(
                            'usuario_identificado',
                            event='voice_ws_identified',
                            usuario_id=self.usuario_id
                        )
                        
            except json.JSONDecodeError:
                self._log_flow('json_invalido', level='warning', event='voice_ws_bad_json')
            return
        
        # Mensajes binarios (audio)
        if bytes_data:
            self.audio_chunks_received += 1
            
            if self.audio_chunks_received <= 5 or self.audio_chunks_received % 50 == 0:
                usage = self._collect_usage_metrics()
                self._log_flow(
                    'chunk_recibido',
                    event='voice_chunk_received',
                    chunk_index=self.audio_chunks_received,
                    chunk_bytes=len(bytes_data),
                    **usage
                )
            
            # Procesar audio
            await self.process_audio_chunk(bytes_data)
    
    async def process_audio_chunk(self, audio_data):
        """Procesa un chunk de audio y alimenta los reconocedores"""
        
        # Asumimos que el audio ya viene en formato PCM S16LE mono 16kHz
        # (el frontend debe hacer la conversión)
        pcm_data = audio_data
        
        # Acumular PCM
        self.pcm_acumulado.extend(pcm_data)
        
        # Decidir si alimentar los reconocedores
        now_ms = self._now_ms()
        self.ultimo_chunk_recibido_ms = now_ms
        self.last_audio_timestamp = now_ms
        debe_feedear = False
        
        if len(self.pcm_acumulado) >= self.FEED_MIN_BYTES:
            debe_feedear = True
        elif self.ultimo_feed_ms == 0 or (now_ms - self.ultimo_feed_ms) >= self.FEED_MAX_INTERVALO_MS:
            debe_feedear = len(self.pcm_acumulado) > 0
        
        if not debe_feedear:
            return
        
        # Extraer datos a procesar
        feed_data = bytes(self.pcm_acumulado)
        self.pcm_acumulado.clear()
        self.ultimo_feed_ms = now_ms
        self.ultimo_feed_bytes = len(feed_data)
        
        # Calcular RMS para diagnóstico
        rms = self._calcular_rms(feed_data)

        if self.audio_chunks_received <= 3 or self.audio_chunks_received % 25 == 0:
            usage = self._collect_usage_metrics()
            self._log_flow(
                'chunk_procesado',
                event='voice_chunk',
                chunk_index=self.audio_chunks_received,
                chunk_bytes=len(feed_data),
                rms=round(rms, 6),
                **usage
            )

        # Enviar diagnóstico cada 10 chunks
        if self.audio_chunks_received % 10 == 0:
            quality, quality_hint = self._classify_audio_quality(rms)
            await self.send(text_data=json.dumps({
                'type': 'diag',
                'feed_bytes': len(feed_data),
                'chunks': self.audio_chunks_received,
                'rms': rms,
                'audio_quality': quality,
                'audio_hint': quality_hint
            }))
        
        # Alimentar reconocedores en threads separados
        try:
            cmd_feed_data, cmd_rms = self._prepare_command_chunk(feed_data, rms)
            # ==========================================
            # RECONOCEDOR DE COMANDOS - DETECCIÓN INSTANTÁNEA
            # ==========================================
            # Estrategia: procesar resultado completo cuando exista y resetear recognizer
            cmd_emitido = False
            resultado_aceptado = False
            if cmd_feed_data is not None:
                resultado_aceptado = await asyncio.to_thread(self.recognizer_cmd.AcceptWaveform, cmd_feed_data)

                if resultado_aceptado:
                    cmd_result = json.loads(self.recognizer_cmd.Result())
                    cmd_final_text = cmd_result.get('text', '')
                    cmd_metrics = self._confidence_stats(cmd_result)
                    if cmd_final_text:
                        self._log_flow(
                            'voice_cmd_final_candidate',
                            event='voice_cmd_candidate',
                            raw_text=cmd_final_text,
                            **cmd_metrics
                        )
                        cmd_emitido = await self.maybe_send_command(
                            cmd_final_text,
                            origen='command_recognizer_final',
                            metrics=cmd_metrics
                        )
                        await self._maybe_update_pending_confidence(cmd_final_text, cmd_metrics, source='command_recognizer_final_result')
                        if cmd_emitido:
                            self.recognizer_cmd.Reset()

                if not cmd_emitido:
                    # Verificar PartialResult para detección instantánea
                    cmd_partial = json.loads(self.recognizer_cmd.PartialResult())
                    cmd_partial_text = cmd_partial.get('partial', '')
                    
                    if cmd_partial_text:
                        self._log_flow(
                            'voice_cmd_partial_candidate',
                            event='voice_cmd_candidate',
                            raw_text=cmd_partial_text
                        )
                        cmd_emitido = await self.maybe_send_command(cmd_partial_text, origen='command_recognizer')
                        if cmd_emitido:
                            self.recognizer_cmd.Reset()
            else:
                self._log_flow(
                    'command_chunk_skipped_low_rms',
                    level='debug',
                    event='voice_cmd_skipped',
                    reason='low_rms',
                    rms=rms
                )
            
            # ==========================================
            # RECONOCEDOR DE TRANSCRIPCIÓN - SOLO PARCIALES
            # ==========================================
            if self.recognizer:
                result_ready = await asyncio.to_thread(self.recognizer.AcceptWaveform, feed_data)
                partial = json.loads(self.recognizer.PartialResult())
                partial_text = partial.get('partial', '')
                now = self._now_ms()

                if partial_text:
                    if self.transcripcion_habilitada and partial_text != self.ultimo_texto_comando_transcripcion:
                        await self.maybe_send_command(partial_text, origen='transcripcion')
                        self.ultimo_texto_comando_transcripcion = partial_text

                    if self.audio_chunks_received % 10 == 0:
                        self._log_flow(
                            'partial_preview',
                            event='voice_partial_preview',
                            partial_sample=partial_text[:40],
                            partial_len=len(partial_text)
                        )

                    texto_acumulado_para_cliente = partial_text

                    if self.is_capturing_session:
                        if len(partial_text) > len(self.accumulated_text):
                            new_part = partial_text[len(self.accumulated_text):]
                            self.accumulated_text = partial_text
                            self._log_flow(
                                'partial_accumulated',
                                level='debug',
                                event='voice_partial_accumulated',
                                appended=new_part
                            )
                        elif partial_text != self.accumulated_text and not self.accumulated_text.endswith(partial_text):
                            if self.accumulated_text:
                                self.accumulated_text += " " + partial_text
                            else:
                                self.accumulated_text = partial_text
                            self._log_flow(
                                'partial_accumulated_new_phrase',
                                level='debug',
                                event='voice_partial_accumulated',
                                appended=partial_text
                            )
                        texto_acumulado_para_cliente = self.accumulated_text or partial_text
                    else:
                        self.accumulated_text = ""

                    if partial_text != self.last_sent_partial:
                        self._log_flow(
                            'partial_emit',
                            event='voice_partial',
                            partial_len=len(partial_text),
                            partial_sample=partial_text[:80]
                        )
                        await self.send(text_data=json.dumps({
                            'type': 'partial',
                            'text': partial_text,
                            'accumulated': texto_acumulado_para_cliente
                        }))
                        self.last_sent_partial = partial_text

                    self.empty_partial_count = 0

                    tokens = [t for t in partial_text.strip().split(' ') if t]
                    if len(tokens) > self.last_partial_token_count:
                        new_token = tokens[-1]
                        if new_token and re.match(r'^[a-zA-ZáéíóúñÑüÜ]+$', new_token):
                            await self.send(text_data=json.dumps({
                                'type': 'word',
                                'text': new_token
                            }))

                        self.last_partial_token_count = len(tokens)
                        self.last_partial_text = partial_text
                        self.last_partial_timestamp = now
                    elif len(tokens) < self.last_partial_token_count:
                        self.last_partial_token_count = len(tokens)
                        self.last_partial_text = partial_text
                        self.last_partial_timestamp = now
                    elif partial_text != self.last_partial_text:
                        self.last_partial_text = partial_text
                        self.last_partial_timestamp = now
                    else:
                        self.empty_partial_count += 1

                        if (self.empty_partial_count >= 3 and
                            self.last_partial_text and
                            len(self.last_partial_text.strip()) > 0 and
                            self.ENABLE_SILENCE_PADDING):

                            self._log_flow(
                                'silence_padding',
                                event='voice_silence_padding',
                                sample=self.last_partial_text[:30]
                            )

                            silence_duration = 0.5
                            silence_bytes = int(self.SAMPLE_RATE * 2 * silence_duration)
                            silence_buffer = b'\x00' * silence_bytes

                            chunk_size = 4000
                            for i in range(0, len(silence_buffer), chunk_size):
                                chunk = silence_buffer[i:i+chunk_size]
                                await asyncio.to_thread(self.recognizer.AcceptWaveform, chunk)
                                await asyncio.sleep(0.01)

                            self.empty_partial_count = 0
                            self.last_partial_text = ""
                elif self.transcripcion_habilitada and not self._transcripcion_no_disponible_reportada:
                    self._log_flow(
                        'recognizer_no_disponible',
                        level='warning',
                        event='voice_transcription_warning'
                    )
                    self._transcripcion_no_disponible_reportada = True

                if result_ready:
                    final_payload = await asyncio.to_thread(self._safe_result_payload, self.recognizer, 'Result')
                    final_text = final_payload.get('text', '')
                    if final_text:
                        stats = self._confidence_stats(final_payload)
                        metadata = {
                            'source': 'vosk_ws_partial_stream',
                            'chunk_bytes': len(feed_data),
                            'rms': rms,
                            **stats
                        }
                        self._log_flow(
                            'transcripcion_final',
                            event='voice_transcription_final',
                            text=final_text,
                            **stats
                        )
                        self._log_transcription_entry(final_text, 'final', metadata)
                        await self._maybe_update_pending_confidence(final_text, stats, source='recognizer_final')
                        
        except Exception as e:
            self._log_flow(
                'error_procesando_audio',
                level='error',
                event='voice_chunk_error',
                error=str(e)
            )
    
    async def maybe_send_command(self, text, origen='command_recognizer', metrics=None):
        """
        Detecta y envía comandos con debounce mejorado.
        Procesa tanto parciales (detección rápida) como finales (detección confiable).
        """
        # Log diagnóstico unificado de entrada bruta
        self._log_flow(
            'cmd_raw',
            event='voice_cmd_raw',
            raw_text=text,
            origen=origen
        )

        confidence = None
        if metrics:
            confidence = metrics.get('vosk_conf_avg')

        allow_partial = origen not in ('command_recognizer', 'command_recognizer_final')
        cmd = self.normalize_command(text, allow_partial=allow_partial)
        if not cmd:
            self._log_flow(
                'cmd_normalize_miss',
                level='debug',
                event='voice_cmd_normalize_miss',
                raw_text=text,
                origen=origen
            )
            return False
        
        matched_token = self._last_command_token
        matched_phrase = self._last_command_phrase
        if not self._phrase_in_text(text, matched_phrase or matched_token):
            self._log_flow(
                'voice_cmd_ignored_token_boundary',
                level='debug',
                event='voice_cmd_ignored',
                reason='token_not_isolated',
                cmd=cmd,
                raw_text=text,
                origen=origen
            )
            return False
        if origen in ('command_recognizer', 'command_recognizer_final'):
            normalized_phrase = normalize_command_text(text)
            if matched_phrase and normalized_phrase != matched_phrase:
                self._log_flow(
                    'voice_cmd_ignored_non_exact',
                    level='debug',
                    event='voice_cmd_ignored',
                    reason='non_exact_match',
                    cmd=cmd,
                    raw_text=text,
                    origen=origen,
                    normalized_phrase=normalized_phrase,
                    expected=matched_phrase
                )
                return False
        if origen not in ('command_recognizer', 'command_recognizer_final'):
            if not self._command_phrase_is_isolated(text, matched_phrase):
                self._log_flow(
                    'voice_cmd_ignored_context',
                    level='debug',
                    event='voice_cmd_ignored',
                    reason='context_not_isolated',
                    cmd=cmd,
                    raw_text=text,
                    origen=origen
                )
                return False
        now = self._now_ms()
        confirmation_required = confidence is None and origen == 'command_recognizer'
        if confirmation_required:
            candidate = self.fast_cmd_candidate
            if candidate and candidate.get('cmd') == cmd:
                if now - candidate.get('timestamp', 0) <= self.FAST_CMD_CONFIRMATION_MS:
                    # necesitamos confirmación adicional: esperar un evento no parcial
                    if origen == 'command_recognizer':
                        return False
                else:
                    self.fast_cmd_candidate = None
            if self.FAST_CMD_CONFIRMATION_MS > 0:
                self.fast_cmd_candidate = {
                    'cmd': cmd,
                    'timestamp': now,
                    'raw_text': text
                }
                self._log_flow(
                    'voice_cmd_pending_fast_confirmation',
                    level='debug',
                    event='voice_cmd_pending',
                    cmd=cmd,
                    raw_text=text,
                    origen=origen
                )
                return False
        else:
            self.fast_cmd_candidate = None

        # Si tenemos una actualización pendiente de confianza para el mismo comando,
        # permitir que pase incluso si cae dentro de las ventanas de debounce.
        if metrics and confidence is not None and self.pending_command_confidence:
            pending = self.pending_command_confidence
            if pending['cmd'] == cmd:
                elapsed = now - pending['timestamp']
                if elapsed <= self.PENDING_CONFIDENCE_WINDOW_MS:
                    self.pending_command_confidence = None
                    self._log_flow(
                        'voice_cmd_confidence_update',
                        event='voice_cmd_confidence_update',
                        cmd=cmd,
                        raw_text=text,
                        confidence=confidence,
                        elapsed_ms=elapsed
                    )
                    await self._send_command_feedback(
                        'accepted',
                        command=cmd,
                        raw_text=text,
                        confidence=confidence,
                        reason='confidence_update'
                    )
                    return True
                else:
                    self._log_flow(
                        'voice_cmd_confidence_expired',
                        level='debug',
                        event='voice_cmd_confidence_expired',
                        cmd=cmd,
                        raw_text=text,
                        elapsed_ms=elapsed
                    )
                    self.pending_command_confidence = None

        if confidence is not None and confidence < self.CMD_MIN_CONFIDENCE:
            self._log_flow(
                'voice_cmd_low_conf',
                level='debug',
                event='voice_cmd_ignored',
                reason='low_confidence',
                cmd=cmd,
                raw_text=text,
                origen=origen,
                confidence=confidence,
                min_confidence=self.CMD_MIN_CONFIDENCE
            )
            await self._send_command_feedback(
                'rejected',
                command=cmd or matched_token,
                raw_text=text,
                confidence=confidence,
                reason='low_confidence'
            )
            return False
        
        # Evitar ejecutar comandos fuera de orden
        if cmd == 'iniciar_proceso' and self.is_capturing_session:
            self._log_flow(
                'voice_cmd_ignored_active_capture',
                level='debug',
                event='voice_cmd_ignored',
                reason='already_capturing',
                cmd=cmd,
                raw_text=text,
                origen=origen
            )
            return False
        if cmd == 'finalizar_proceso' and not self.is_capturing_session:
            self._log_flow(
                'voice_cmd_ignored_no_capture',
                level='debug',
                event='voice_cmd_ignored',
                reason='no_active_capture',
                cmd=cmd,
                raw_text=text,
                origen=origen
            )
            return False
        
        # Debounce agresivo para evitar detecciones múltiples
        last_sent = self.last_cmd_sent_at.get(cmd, 0)
        time_since_last = now - last_sent
        
        # Debounce de 1500ms para evitar spam de comandos repetidos
        min_debounce = 1500
        
        if time_since_last < min_debounce:
            self._log_flow(
                'voice_cmd_debounced',
                level='debug',
                event='voice_cmd_ignored',
                reason='debounce',
                cmd=cmd,
                raw_text=text,
                origen=origen,
                time_since_last_ms=time_since_last,
                min_debounce_ms=min_debounce
            )
            return False
        
        self.last_cmd_sent_at[cmd] = now
        if origen == 'transcripcion':
            self.ultimo_texto_comando_transcripcion = ""
        
        latencia_procesamiento_ms = max(0, now - self.ultimo_feed_ms) if self.ultimo_feed_ms else 0
        usage = self._collect_usage_metrics()
        self._log_flow(
            'voice_cmd_detected',
            event='voice_cmd_detected',
            cmd=cmd,
            raw_text=text,
            origen=origen,
            latencia_ms=latencia_procesamiento_ms,
            feed_bytes=self.ultimo_feed_bytes,
            **usage,
            **(metrics or {})
        )

        # Registrar también en el logger estructurado de voz (JSONL)
        try:
            metadata = {
                'origen': origen,
                'latencia_ms': latencia_procesamiento_ms,
                'feed_bytes': self.ultimo_feed_bytes,
            }
            if metrics:
                metadata.update(metrics)
            voice_logger.log_command(cmd, text or cmd, metadata=metadata)
        except Exception as e:
            self._log_flow(
                'voice_cmd_log_error',
                level='error',
                event='voice_cmd_log_error',
                cmd=cmd,
                raw_text=text,
                origen=origen,
                error=str(e)
            )
        
        # ACTIVAR captura completa al iniciar proceso
        if cmd == 'iniciar_proceso':
            self._log_flow('iniciando_captura', event='voice_capture_start')
            self.is_capturing_session = True
            if self.transcripcion_habilitada:
                self.accumulated_text = ""
                self.last_sent_partial = ""
            self.inicio_captura_ms = now
        
        # ==========================================
        # NUEVO: Enviar texto acumulado (solo parciales)
        # ==========================================
        duracion_captura_ms = None
        if cmd == 'finalizar_proceso':
            try:
                # Detener captura
                self.is_capturing_session = False
                
                # Enviar texto acumulado como "final"
                if self.transcripcion_habilitada and self.accumulated_text and self.accumulated_text.strip():
                    self._log_flow(
                        'texto_acumulado',
                        event='voice_capture_result',
                        text=self.accumulated_text
                    )
                    
                    await self.send(text_data=json.dumps({
                        'type': 'final',
                        'text': self.accumulated_text.strip(),
                        'source': 'accumulated_partials',
                        'words': []
                    }))
                elif self.transcripcion_habilitada:
                    self._log_flow(
                        'sin_texto_acumulado',
                        level='warning',
                        event='voice_capture_empty'
                    )
                    
                if self.inicio_captura_ms:
                    duracion_captura_ms = max(0, now - self.inicio_captura_ms)
                    self._log_flow(
                        'duracion_captura',
                        event='voice_capture_duration',
                        duracion_ms=duracion_captura_ms
                    )
                self.inicio_captura_ms = 0

            except Exception as e:
                self._log_flow(
                    'error_texto_acumulado',
                    level='error',
                    event='voice_capture_error',
                    error=str(e)
                )
        
        # Manejo de cancelar proceso
        if cmd == 'cancelar_proceso':
            self._log_flow('cancelando_proceso', event='voice_capture_cancel')
            self.is_capturing_session = False
            if self.transcripcion_habilitada:
                self.accumulated_text = ""
                self.last_sent_partial = ""
            self.inicio_captura_ms = 0
        
        # Manejo de repetir proceso
        if cmd == 'repetir_proceso':
            self._log_flow('repitiendo_proceso', event='voice_capture_repeat')
            if self.transcripcion_habilitada:
                self.accumulated_text = ""
                self.last_sent_partial = ""
            # Mantener is_capturing_session en True para continuar grabando
        
        respuesta = {
            'type': 'command',
            'command': cmd,
            'text': text,
            'latencia_ms': int(latencia_procesamiento_ms),
            'bytes_alimentados': self.ultimo_feed_bytes,
            'origen': origen
        }
        if duracion_captura_ms is not None:
            respuesta['duracion_captura_ms'] = int(duracion_captura_ms)
        if metrics:
            respuesta['confidence'] = metrics
        await self.send(text_data=json.dumps(respuesta))
        if confidence is None:
            self.pending_command_confidence = {
                'cmd': cmd,
                'raw_text': text,
                'timestamp': now,
                'token': matched_token,
                'phrase': matched_phrase,
                'source': origen
            }
        else:
            self.pending_command_confidence = None
        await self._send_command_feedback(
            'accepted',
            command=cmd,
            raw_text=text,
            confidence=confidence,
            reason='confidence_pending' if confidence is None else None
        )
        return True
    
    def normalize_command(self, text, *, allow_partial=False):
        """
        Detecta comandos aceptando únicamente las frases definidas en voice_commands.
        """
        self._last_command_token = None
        self._last_command_phrase = None
        cmd, phrase = match_strict_command(text, allow_partial=allow_partial)
        if cmd and phrase:
            self._last_command_phrase = phrase
            self._last_command_token = phrase.split()[-1]
        return cmd

    def _peek_normalized_command(self, text):
        """Obtiene el comando normalizado sin modificar el último token usado por la sesión."""
        prev_token = self._last_command_token
        prev_phrase = self._last_command_phrase
        cmd = self.normalize_command(text)
        self._last_command_token = prev_token
        self._last_command_phrase = prev_phrase
        return cmd

    def _matches_pending_command(self, pending, candidate_text):
        if not pending or not candidate_text:
            return False
        candidate_cmd = self._peek_normalized_command(candidate_text)
        if candidate_cmd and candidate_cmd == pending.get('cmd'):
            return True
        token = pending.get('token')
        if token and self._phrase_in_text(candidate_text, pending.get('phrase') or token):
            return True
        return False

    async def _maybe_update_pending_confidence(self, candidate_text, metrics, *, source='recognizer_final'):
        pending = self.pending_command_confidence
        if not pending or not metrics:
            return False
        confidence = metrics.get('vosk_conf_avg')
        if confidence is None:
            return False
        if not self._matches_pending_command(pending, candidate_text):
            return False
        elapsed = self._now_ms() - pending.get('timestamp', self._now_ms())
        self.pending_command_confidence = None
        self.pending_confidence_token = None
        self._log_flow(
            'voice_cmd_confidence_update',
            event='voice_cmd_confidence_update',
            cmd=pending.get('cmd'),
            raw_text=pending.get('raw_text'),
            confidence=confidence,
            elapsed_ms=elapsed,
            source=source
        )
        await self._send_command_feedback(
            'accepted',
            command=pending.get('cmd'),
            raw_text=pending.get('raw_text'),
            confidence=confidence,
            reason='confidence_update'
        )
        return True

    async def cargar_estado_usuario(self):
        """Carga el estado de adaptación del usuario desde la BD"""
        if not self.usuario_id:
            return
        
        try:
            usuario_int = int(self.usuario_id)
            estado = await self._cargar_estado_sync(usuario_int)
            
            if estado and self.recognizer:
                estado_deserializado = self._deserializar_estado(estado)
                if estado_deserializado:
                    await asyncio.to_thread(
                        self.recognizer.SetAdaptationState, estado_deserializado
                    )
                    if self.recognizer_cmd:
                        await asyncio.to_thread(
                            self.recognizer_cmd.SetAdaptationState, estado_deserializado
                        )
                    logger.info(f" Estado de adaptación cargado para usuario {self.usuario_id}")
                    
        except Exception as e:
            logger.error(f" Error cargando estado: {e}")
    
    async def guardar_estado_usuario(self):
        """Guarda el estado de adaptación del usuario en la BD"""
        if not self.usuario_id or not self.recognizer:
            return
        
        try:
            estado = await asyncio.to_thread(self.recognizer.GetAdaptationState)
            estado_serializado = self._serializar_estado(estado)
            
            if estado_serializado:
                usuario_int = int(self.usuario_id)
                await self._guardar_estado_sync(usuario_int, estado_serializado)
                logger.info(f" Estado de adaptación guardado para usuario {self.usuario_id}")
                
        except Exception as e:
            logger.error(f" Error guardando estado: {e}")
    
    @sync_to_async
    def _cargar_estado_sync(self, usuario_id):
        """Carga el estado desde la BD (sync)"""
        try:
            from django.contrib.auth import get_user_model
            from .models import PerfilVozUsuario
            Usuario = get_user_model()
            usuario = Usuario.objects.get(pk=usuario_id)
            perfil, _ = PerfilVozUsuario.objects.get_or_create(usuario=usuario)
            return perfil.estado_adaptacion or ''
        except Exception:
            return ''
    
    @sync_to_async
    def _guardar_estado_sync(self, usuario_id, estado_serializado):
        """Guarda el estado en la BD (sync)"""
        if not estado_serializado:
            return
        try:
            from django.contrib.auth import get_user_model
            from .models import PerfilVozUsuario
            Usuario = get_user_model()
            usuario = Usuario.objects.get(pk=usuario_id)
            with transaction.atomic():
                perfil, _ = PerfilVozUsuario.objects.select_for_update().get_or_create(usuario=usuario)
                perfil.estado_adaptacion = estado_serializado
                perfil.save(update_fields=['estado_adaptacion', 'actualizado_en'])
        except Exception as e:
            logger.error(f"Error guardando estado: {e}")
    
    def _serializar_estado(self, estado):
        """Serializa el estado de adaptación"""
        if estado is None:
            return ''
        if isinstance(estado, str):
            return estado
        if isinstance(estado, (bytes, bytearray)):
            return 'b64:' + base64.b64encode(estado).decode('ascii')
        try:
            return str(estado)
        except Exception:
            return ''
    
    def _deserializar_estado(self, valor):
        """Deserializa el estado de adaptación"""
        if not valor:
            return None
        if isinstance(valor, (bytes, bytearray)):
            return valor
        if isinstance(valor, str) and valor.startswith('b64:'):
            try:
                return base64.b64decode(valor[4:])
            except Exception:
                return None
        return valor
    
    def _now_ms(self):
        """Retorna timestamp actual en milisegundos"""
        import time
        return int(time.time() * 1000)
    
    def _prepare_command_chunk(self, pcm_data, rms=None):
        """
        Normaliza el PCM antes de alimentar el recognizer de comandos.
        - Descarta silencio absoluto
        - Aplica ganancia moderada para acercar RMS al objetivo
        """
        if not pcm_data:
            return None, rms
        if rms is None:
            rms = self._calcular_rms(pcm_data)
        if rms < self.CMD_MIN_RMS and not self.CMD_ALLOW_LOW_RMS:
            return None, rms
        if rms < self.CMD_TARGET_RMS:
            gain = min(self.CMD_TARGET_RMS / max(rms, 1e-6), self.CMD_MAX_GAIN)
            samples = array.array('h')
            samples.frombytes(pcm_data)
            for idx, sample in enumerate(samples):
                amplified = int(sample * gain)
                if amplified > 32767:
                    amplified = 32767
                elif amplified < -32768:
                    amplified = -32768
                samples[idx] = amplified
            pcm_data = samples.tobytes()
            rms = self._calcular_rms(pcm_data)
        return pcm_data, rms
    
    def _command_phrase_is_isolated(self, text, phrase):
        """
        Valida que el comando detectado esté 'solo' o rodeado únicamente por relleno permitido.
        Evita falsos positivos cuando provienen de transcripciones largas.
        """
        if not text or not phrase:
            return False
        if self.command_allow_anywhere:
            return True
        normalized = normalize_command_text(text)
        tokens = normalized.split()
        if not tokens:
            return False
        phrase_tokens = phrase.split()
        def remove_once(seq, target):
            for idx in range(len(seq) - len(target) + 1):
                if seq[idx:idx + len(target)] == target:
                    return seq[:idx] + seq[idx + len(target):]
            return seq
        remaining = remove_once(tokens, phrase_tokens)
        if remaining == tokens:
            return False
        allowed = set(self.command_fillers) | set(self.command_context_words)
        extras = [tok for tok in remaining if tok not in allowed]
        if not extras:
            return True
        if len(remaining) <= 4 and len(extras) <= 1:
            return True
        return False

    def _phrase_in_text(self, text, phrase):
        """Valida que la frase aparezca como secuencia completa."""
        if not text or not phrase:
            return False
        normalized = normalize_command_text(text)
        if not normalized:
            return False
        if normalized == phrase:
            return True
        tokens = normalized.split()
        phrase_tokens = phrase.split()
        if not tokens or len(tokens) < len(phrase_tokens):
            return False
        for idx in range(len(tokens) - len(phrase_tokens) + 1):
            if tokens[idx:idx + len(phrase_tokens)] == phrase_tokens:
                return True
        return False
    
    def _calcular_rms(self, pcm_data):
        """Calcula RMS del audio PCM"""
        try:
            arr = array.array('h')
            arr.frombytes(pcm_data)
            if len(arr) > 0:
                suma = sum(v * v for v in arr)
                return (suma / len(arr)) ** 0.5 / 32768.0
            return 0.0
        except Exception:
            return 0.0

    def _classify_audio_quality(self, rms):
        if rms is None:
            return ('unknown', 'Nivel de audio desconocido')
        if rms < self.AUDIO_RMS_LOW:
            return ('too_low', 'Señal muy baja, acerca el micrófono')
        if rms > self.AUDIO_RMS_HIGH:
            return ('too_high', 'Demasiado ruido / micrófono saturado')
        return ('ok', 'Nivel de audio estable')

    def _collect_usage_metrics(self):
        """Recolecta métricas ligeras de CPU/RAM para diagnóstico."""
        metrics = {}
        try:
            ru = resource.getrusage(resource.RUSAGE_SELF)
        except Exception:
            return metrics

        now = time.perf_counter()
        cpu_time = ru.ru_utime + ru.ru_stime
        if self._last_usage_sample:
            last_time, last_cpu = self._last_usage_sample
            dt = max(now - last_time, 1e-6)
            cpu_delta = max(cpu_time - last_cpu, 0.0)
            cpu_percent = (cpu_delta / dt) * 100.0 / CPU_CORES
            metrics['cpu_percent'] = round(cpu_percent, 2)
        self._last_usage_sample = (now, cpu_time)

        # ru_maxrss viene en KB en Linux, bytes en macOS; convertir a MB aprox.
        rss_mb = ru.ru_maxrss / 1024.0
        if sys.platform == 'darwin':
            rss_mb = ru.ru_maxrss / (1024.0 * 1024.0)
        metrics['mem_mb'] = round(rss_mb, 2)

        try:
            load1, load5, load15 = os.getloadavg()
            metrics['load1'] = round(load1, 2)
            metrics['load5'] = round(load5, 2)
        except OSError:
            pass

        return metrics

    def _confidence_stats(self, result_json):
        """Extrae métricas básicas de confianza de la respuesta Vosk."""
        words = result_json.get('result') or []
        confidences = [w.get('conf') for w in words if isinstance(w.get('conf'), (int, float))]
        stats = {'vosk_word_count': len(words)}
        if confidences:
            stats.update({
                'vosk_conf_avg': round(sum(confidences) / len(confidences), 4),
                'vosk_conf_min': round(min(confidences), 4),
                'vosk_conf_max': round(max(confidences), 4),
            })
        return stats

    def _safe_result_payload(self, recognizer, method_name='Result'):
        """Obtiene y parsea JSON desde el recognizer (Result/FinalResult)."""
        try:
            raw = getattr(recognizer, method_name)()
            return json.loads(raw) if raw else {}
        except Exception as exc:
            self._log_flow(
                'vosk_parse_error',
                level='error',
                event='voice_vosk_parse_error',
                error=str(exc),
                method=method_name
            )
            return {}

    def _log_flow(self, message, *, level='info', event='voice_flow', **extra):
        """Helper para enviar logs estructurados al logger unificado."""
        log_extra = {
            'event': event,
            'consumer': 'vosk_ws',
            'client_id': self.client_id,
            'usuario_id': self.usuario_id,
        }
        for key, value in extra.items():
            if value is not None:
                log_extra[key] = value

        log_fn = getattr(logger, level, logger.info)
        log_fn(message, extra=log_extra)

    def _log_transcription_entry(self, text, transcription_type, metadata):
        """Loggea la transcripción en el logger central y en voice_logger."""
        if not text:
            return
        meta = metadata or {}
        try:
            voice_logger.log_transcription(text, transcription_type, meta)
        except Exception as exc:
            self._log_flow(
                'voice_logger_error',
                level='error',
                event='voice_logger_error',
                error=str(exc),
                transcription_type=transcription_type
            )

    async def _send_command_feedback(self, status, *, command=None, raw_text='', confidence=None, reason=None):
        """Envía feedback al cliente para mostrar en UI."""
        payload = {
            'type': 'command_feedback',
            'status': status,
            'command': command,
            'raw_text': raw_text,
            'confidence': confidence,
            'threshold': self.CMD_MIN_CONFIDENCE,
            'reason': reason,
        }
        try:
            await self.send(text_data=json.dumps(payload))
        except Exception as exc:
            self._log_flow(
                'command_feedback_error',
                level='debug',
                event='voice_command_feedback_error',
                error=str(exc)
            )
