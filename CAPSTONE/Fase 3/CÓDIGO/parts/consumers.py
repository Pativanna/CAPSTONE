"""
WebSocket consumers for voice recognition.
"""

import json
import tempfile
import os
import asyncio
import base64
import re
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

logger = logging.getLogger(__name__)
from .voice_logger import voice_logger


class VoskConsumer(AsyncWebsocketConsumer):
    """
    Consumer de Django Channels que integra el servidor Vosk para reconocimiento de voz.
    Reemplaza el servidor Vosk standalone para tener mejor integración con Django.
    """
    
    # Configuración de Vosk
    SAMPLE_RATE = 16000
    VOSK_MODEL_PATH = os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42')
    
    # Comandos de entrenamiento (para documentación y futuras referencias)
    COMANDOS_ENTRENAMIENTO = {
        'iniciar_proceso': ['iniciar', 'inicia', 'inicio'],
        'finalizar_proceso': ['detener', 'deten', 'detengo'],
        'confirmar_datos': ['confirmar', 'confirmo', 'confirma'],
        'cancelar_proceso': ['cancelar', 'cancela'],
        'repetir_proceso': ['repetir', 'repite']
    }
    
    # Modelo Vosk compartido (se carga una sola vez para todos los consumers)
    _model = None
    _model_lock = asyncio.Lock()
    
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
        self.FEED_MIN_MUESTRAS = int(os.getenv('VOSK_FEED_MIN_SAMPLES', '1200'))  # ~75ms a 16kHz
        self.FEED_MAX_INTERVALO_MS = int(os.getenv('VOSK_FEED_MAX_INTERVAL_MS', '120'))  # Empuja flush cada 120ms
        self.FEED_MIN_BYTES = self.FEED_MIN_MUESTRAS * 2
        self.ultimo_feed_bytes = 0
        self.ultimo_chunk_recibido_ms = 0
        self.inicio_captura_ms = 0
        
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
        self.SILENCE_TIMEOUT_MS = 500  # 500ms = pausa natural entre frases
        self.last_audio_timestamp = 0  # Timestamp del último audio recibido
        
        # NUEVO: Acumulador de texto completo (solo parciales)
        self.accumulated_text = ""  # Texto completo acumulado durante captura
        self.last_sent_partial = ""  # Último partial enviado para evitar duplicados
        self.ultimo_texto_comando_transcripcion = ""
        self._transcripcion_no_disponible_reportada = False
        
    async def connect(self):
        """Acepta la conexión WebSocket e inicializa reconocedores"""
        await self.accept()
        
        # Obtener usuario_id de query params si está disponible
        query_string = self.scope.get('query_string', b'').decode('utf-8')
        if query_string:
            params = parse_qs(query_string)
            self.usuario_id = params.get('usuario_id', [None])[0] or params.get('user_id', [None])[0]
        
        # Si no hay usuario_id en query, intentar obtenerlo del scope (usuario autenticado)
        if not self.usuario_id and self.scope.get('user') and self.scope['user'].is_authenticated:
            self.usuario_id = str(self.scope['user'].id)
        
        self.client_id = id(self)
        
        logger.info(f" Cliente Vosk conectado - client_id: {self.client_id}, usuario_id: {self.usuario_id}")
        
        # Cargar modelo Vosk
        model = await self.get_model()
        if not model:
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
                logger.info(" Transcripción Vosk habilitada para esta sesión")
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
                        logger.info(" SetMaxRecognitionDelay configurado a 0.8s (captura palabras cortas)")
                except Exception as e_config:
                    logger.debug(f"SetMaxRecognitionDelay no disponible: {e_config}")
            else:
                logger.info(" Transcripción Vosk deshabilitada: se usará solo detección de comandos")

            # Reconocedor para comandos con gramática expandida
            # Incluye todas las variantes de comandos para mejor detección
            command_grammar = json.dumps([
                "iniciar", "inicia", "inicio",
                "detener", "deten", "detengo", "detén",
                "confirmar", "confirmo", "confirma",
                "cancelar", "cancela",
                "repetir", "repite"
            ])
            
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
            logger.error(f" Error inicializando reconocedores: {e}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'Error de inicialización: {str(e)}'
            }))
            await self.close()
    
    async def disconnect(self, close_code):
        """Maneja la desconexión y guarda el estado de adaptación"""
        logger.info(f" Cliente Vosk desconectado - client_id: {self.client_id}, code: {close_code}")
        
        # CRÍTICO: Solicitar resultado final antes de desconectar para capturar últimos segundos
        if self.recognizer:
            try:
                logger.info(" Solicitando resultado final antes de desconectar...")
                final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                result_json = json.loads(final_result)
                final_text = result_json.get('text', '')
                
                if final_text:
                    logger.info(f" Resultado final capturado: {final_text}")
                    # Enviar resultado final al cliente antes de cerrar
                    await self.send(text_data=json.dumps({
                        'type': 'final',
                        'text': final_text,
                        'is_disconnect': True
                    }))
                else:
                    logger.info("ℹ Resultado final vacío")
            except Exception as e:
                logger.error(f" Error obteniendo resultado final: {e}")
        
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
                    logger.info(" Solicitud de resultado final recibida")
                    if self.recognizer:
                        try:
                            # Enviar silencio para forzar que Vosk procese todo
                            silence = bytes(6400)  # 200ms de silencio a 16kHz
                            await asyncio.to_thread(self.recognizer.AcceptWaveform, silence)
                            
                            final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                            result_json = json.loads(final_result)
                            final_text = result_json.get('text', '')
                            
                            logger.info(f" Resultado final obtenido: '{final_text}'")
                            
                            await self.send(text_data=json.dumps({
                                'type': 'final',
                                'text': final_text,
                                'source': 'request_final'
                            }))
                        except Exception as e:
                            logger.error(f" Error obteniendo resultado final: {e}")
                    return
                
                if message_type == 'identificacion':
                    nuevo_usuario_id = payload.get('usuario_id') or payload.get('user_id')
                    if nuevo_usuario_id and nuevo_usuario_id != self.usuario_id:
                        self.usuario_id = nuevo_usuario_id
                        await self.cargar_estado_usuario()
                        logger.info(f" Usuario identificado: {self.usuario_id}")
                        
            except json.JSONDecodeError:
                logger.warning(f" JSON inválido recibido")
            return
        
        # Mensajes binarios (audio)
        if bytes_data:
            self.audio_chunks_received += 1
            
            # Log periódico
            if self.audio_chunks_received <= 5 or self.audio_chunks_received % 50 == 0:
                logger.info(f" Chunk #{self.audio_chunks_received}, {len(bytes_data)} bytes")
            
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
        
        # Logging de RMS para debugging
        if rms > 0.001:  # Solo loguear si hay señal significativa
            logger.info(f"Audio con señal: RMS={rms:.6f}, bytes={len(feed_data)}")
        
        # Enviar diagnóstico cada 10 chunks
        if self.audio_chunks_received % 10 == 0:
            await self.send(text_data=json.dumps({
                'type': 'diag',
                'feed_bytes': len(feed_data),
                'chunks': self.audio_chunks_received,
                'rms': rms
            }))
        
        # Alimentar reconocedores en threads separados
        try:
            # ==========================================
            # RECONOCEDOR DE COMANDOS - DETECCIÓN INSTANTÁNEA
            # ==========================================
            # Estrategia: procesar resultado completo cuando exista y resetear recognizer
            cmd_emitido = False
            resultado_aceptado = await asyncio.to_thread(self.recognizer_cmd.AcceptWaveform, feed_data)

            if resultado_aceptado:
                cmd_result = json.loads(self.recognizer_cmd.Result())
                cmd_final_text = cmd_result.get('text', '')
                if cmd_final_text:
                    logger.info(f"Final CMD detectado: '{cmd_final_text}'")
                    cmd_emitido = await self.maybe_send_command(cmd_final_text, origen='command_recognizer_final')
                    if cmd_emitido:
                        self.recognizer_cmd.Reset()

            if not cmd_emitido:
                # Verificar PartialResult para detección instantánea
                cmd_partial = json.loads(self.recognizer_cmd.PartialResult())
                cmd_partial_text = cmd_partial.get('partial', '')
                
                if cmd_partial_text:
                    logger.info(f"Parcial CMD detectado: '{cmd_partial_text}'")
                    cmd_emitido = await self.maybe_send_command(cmd_partial_text, origen='command_recognizer')
                    if cmd_emitido:
                        self.recognizer_cmd.Reset()
            
            # ==========================================
            # RECONOCEDOR DE TRANSCRIPCIÓN - SOLO PARCIALES
            # ==========================================
            if self.recognizer:
                # Alimentamos el recognizer pero IGNORAMOS el resultado de AcceptWaveform
                # Solo procesamos PartialResult() para capturar TODO
                await asyncio.to_thread(self.recognizer.AcceptWaveform, feed_data)

                # SIEMPRE obtener partial (incluso si Vosk dice que es "final")
                partial = json.loads(self.recognizer.PartialResult())
                partial_text = partial.get('partial', '')

                now = self._now_ms()

                if partial_text:
                    if self.transcripcion_habilitada and partial_text != self.ultimo_texto_comando_transcripcion:
                        await self.maybe_send_command(partial_text, origen='transcripcion')
                        self.ultimo_texto_comando_transcripcion = partial_text
                    
                    if self.audio_chunks_received % 10 == 0:
                        logger.info(f" Parcial: {partial_text[:40]}...")

                    texto_acumulado_para_cliente = partial_text

                    if self.is_capturing_session:
                        if len(partial_text) > len(self.accumulated_text):
                            new_part = partial_text[len(self.accumulated_text):]
                            self.accumulated_text = partial_text
                            logger.debug(f" Acumulando: '{new_part}'")
                        elif partial_text != self.accumulated_text and not self.accumulated_text.endswith(partial_text):
                            if self.accumulated_text:
                                self.accumulated_text += " " + partial_text
                            else:
                                self.accumulated_text = partial_text
                            logger.debug(f" Nueva frase acumulada: '{partial_text}'")
                        texto_acumulado_para_cliente = self.accumulated_text or partial_text
                    else:
                        # Mantener acumulador limpio cuando no hay sesión activa
                        self.accumulated_text = ""

                    if partial_text != self.last_sent_partial:
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
                            len(self.last_partial_text.strip()) > 0):

                            logger.info(f" Silencio detectado después de '{self.last_partial_text[:30]}...' → enviando padding")

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
                logger.warning(" Transcripción habilitada pero recognizer no disponible")
                self._transcripcion_no_disponible_reportada = True
                        
        except Exception as e:
            logger.error(f" Error procesando audio: {e}")
    
    async def maybe_send_command(self, text, origen='command_recognizer'):
        """
        Detecta y envía comandos con debounce mejorado.
        Procesa tanto parciales (detección rápida) como finales (detección confiable).
        """
        # Log diagnóstico unificado de entrada bruta
        logger.info(
            "maybe_send_command_raw",
            extra={
                'event': 'voice_cmd_raw',
                'raw_text': text,
                'origen': origen,
                'usuario_id': self.usuario_id,
                'client_id': self.client_id,
            }
        )

        cmd = self.normalize_command(text)
        if not cmd:
            logger.debug(
                "voice_cmd_normalize_miss",
                extra={
                    'event': 'voice_cmd_normalize_miss',
                    'raw_text': text,
                    'origen': origen,
                    'usuario_id': self.usuario_id,
                    'client_id': self.client_id,
                }
            )
            return False
        
        now = self._now_ms()
        
        # Evitar ejecutar comandos fuera de orden
        if cmd == 'iniciar_proceso' and self.is_capturing_session:
            logger.debug(
                "voice_cmd_ignored_active_capture",
                extra={
                    'event': 'voice_cmd_ignored',
                    'reason': 'already_capturing',
                    'cmd': cmd,
                    'raw_text': text,
                    'origen': origen,
                    'usuario_id': self.usuario_id,
                    'client_id': self.client_id,
                }
            )
            return False
        if cmd == 'finalizar_proceso' and not self.is_capturing_session:
            logger.debug(
                "voice_cmd_ignored_no_capture",
                extra={
                    'event': 'voice_cmd_ignored',
                    'reason': 'no_active_capture',
                    'cmd': cmd,
                    'raw_text': text,
                    'origen': origen,
                    'usuario_id': self.usuario_id,
                    'client_id': self.client_id,
                }
            )
            return False
        
        # Debounce agresivo para evitar detecciones múltiples
        last_sent = self.last_cmd_sent_at.get(cmd, 0)
        time_since_last = now - last_sent
        
        # Debounce de 1500ms para evitar spam de comandos repetidos
        min_debounce = 1500
        
        if time_since_last < min_debounce:
            logger.debug(
                "voice_cmd_debounced",
                extra={
                    'event': 'voice_cmd_ignored',
                    'reason': 'debounce',
                    'cmd': cmd,
                    'raw_text': text,
                    'origen': origen,
                    'usuario_id': self.usuario_id,
                    'client_id': self.client_id,
                    'time_since_last_ms': time_since_last,
                    'min_debounce_ms': min_debounce,
                }
            )
            return False
        
        self.last_cmd_sent_at[cmd] = now
        if origen == 'transcripcion':
            self.ultimo_texto_comando_transcripcion = ""
        
        latencia_procesamiento_ms = max(0, now - self.ultimo_feed_ms) if self.ultimo_feed_ms else 0
        logger.info(
            "voice_cmd_detected",
            extra={
                'event': 'voice_cmd_detected',
                'cmd': cmd,
                'raw_text': text,
                'origen': origen,
                'usuario_id': self.usuario_id,
                'client_id': self.client_id,
                'latencia_ms': latencia_procesamiento_ms,
                'feed_bytes': self.ultimo_feed_bytes,
            }
        )

        # Registrar también en el logger estructurado de voz (JSONL)
        try:
            voice_logger.log_command(cmd, text or cmd)
        except Exception as e:
            logger.error(
                "voice_cmd_log_error",
                extra={
                    'event': 'voice_cmd_log_error',
                    'cmd': cmd,
                    'raw_text': text,
                    'origen': origen,
                    'error': str(e),
                }
            )
        
        # ACTIVAR captura completa al iniciar proceso
        if cmd == 'iniciar_proceso':
            logger.info(" INICIANDO captura de texto acumulado")
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
                    logger.info(f" Texto acumulado capturado: '{self.accumulated_text}'")
                    
                    await self.send(text_data=json.dumps({
                        'type': 'final',
                        'text': self.accumulated_text.strip(),
                        'source': 'accumulated_partials',
                        'words': []
                    }))
                elif self.transcripcion_habilitada:
                    logger.warning(f" No se capturó texto durante la sesión")
                    
                if self.inicio_captura_ms:
                    duracion_captura_ms = max(0, now - self.inicio_captura_ms)
                    logger.info(f" Duración de captura: {duracion_captura_ms}ms")
                self.inicio_captura_ms = 0

            except Exception as e:
                logger.error(f" Error enviando texto acumulado: {e}")
        
        # Manejo de cancelar proceso
        if cmd == 'cancelar_proceso':
            logger.info(" CANCELANDO proceso - limpiando estado")
            self.is_capturing_session = False
            if self.transcripcion_habilitada:
                self.accumulated_text = ""
                self.last_sent_partial = ""
            self.inicio_captura_ms = 0
        
        # Manejo de repetir proceso
        if cmd == 'repetir_proceso':
            logger.info(" REPITIENDO proceso - limpiando para reiniciar")
            if self.transcripcion_habilitada:
                self.accumulated_text = ""
                self.last_sent_partial = ""
            # Mantener is_capturing_session en True para continuar grabando
        
        logger.info(f" COMANDO: {cmd} ('{text}')")
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
        await self.send(text_data=json.dumps(respuesta))
        return True
    
    def normalize_command(self, text):
        """
        Detecta comandos aceptando únicamente palabras exactas.
        Palabras válidas: iniciar, detener, confirmar, cancelar y repetir.
        """
        if not text:
            return None

        # Normalizar: minúsculas, remover puntuación/símbolos que puedan pegarse a las palabras
        t = text.lower().strip()
        t = re.sub(r'[^a-záéíóúñü0-9\s]', ' ', t)
        tokens = [tok for tok in re.split(r'\s+', t) if tok]
        if not tokens:
            return None

        relleno = {'um', 'mmm', 'mm', 'uh', 'uhm', 'eh', 'em', 'este', 'pues', 'ah', 'ehh'}
        comando_map = {
            'iniciar': 'iniciar_proceso',
            'inicia': 'iniciar_proceso',
            'inicio': 'iniciar_proceso',
            'detener': 'finalizar_proceso',
            'deten': 'finalizar_proceso',
            'detengo': 'finalizar_proceso',
            'confirmar': 'confirmar_datos',
            'confirmo': 'confirmar_datos',
            'confirma': 'confirmar_datos',
            'cancelar': 'cancelar_proceso',
            'cancela': 'cancelar_proceso',
            'repetir': 'repetir_proceso',
            'repite': 'repetir_proceso'
        }

        for token in tokens:
            if token in relleno:
                continue
            cmd = comando_map.get(token)
            if cmd:
                return cmd
        return None

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
    
    def _calcular_rms(self, pcm_data):
        """Calcula RMS del audio PCM"""
        try:
            import array
            arr = array.array('h')
            arr.frombytes(pcm_data)
            if len(arr) > 0:
                suma = sum(v * v for v in arr)
                return (suma / len(arr)) ** 0.5 / 32768.0
            return 0.0
        except Exception:
            return 0.0
