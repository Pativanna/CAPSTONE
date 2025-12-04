"""
WebRTC Híbrido: Captura con WebRTC (AEC/NS/AGC) + Transcripción directa en este consumer.
ANTES: Este consumer intentaba conectarse a un servidor Vosk externo (contenedor separado).
AHORA: Usa el modelo Vosk integrado (mismo enfoque que VoskConsumer) eliminando dependencia
de un contenedor deshabilitado y resolviendo la falta de audio/transcripciones.
"""
import asyncio
import json
import logging
import re
import os
import base64
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings

from .voice_logger import voice_logger
from .voice_commands import (
    STRICT_COMMAND_GRAMMAR,
    match_strict_command,
    normalize_command_text,
)

logger = logging.getLogger('parts.voice')

# Intentar importar Vosk (manejar ausencia elegantemente)
try:
    from vosk import Model, KaldiRecognizer
    VOSK_DISPONIBLE = True
except ImportError:
    VOSK_DISPONIBLE = False


class WebRTCAudioConsumer(AsyncWebsocketConsumer):
    """Consumer que recibe audio PCM procesado por WebRTC y realiza transcripción local.

    Flujo:
    1. Cliente envía PCM 16kHz S16LE por WebSocket (AudioWorklet preprocesado con AEC/NS/AGC).
    2. Se acumulan bytes y se alimenta a dos reconocedores:
       - recognizer_cmd (gramática de comandos cortos)
       - recognizer (transcripción general con vocabulario automotriz)
    3. Detecta comandos con debounce y envía partials/final acumulado.
    4. Al finalizar o silencio prolongado se fuerza resultado final.
    """

    SAMPLE_RATE = 16000
    VOSK_MODEL_PATH = getattr(settings, 'VOSK_MODEL_PATH', os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42'))

    _modelo_compartido = None
    _modelo_lock = asyncio.Lock()

    @classmethod
    async def obtener_modelo(cls):
        if not VOSK_DISPONIBLE:
            logger.error("Vosk no disponible: instalar paquete vosk")
            return None
        async with cls._modelo_lock:
            if cls._modelo_compartido is None:
                try:
                    logger.info(f"[WebRTC] Cargando modelo Vosk en {cls.VOSK_MODEL_PATH}")
                    cls._modelo_compartido = await asyncio.to_thread(Model, cls.VOSK_MODEL_PATH)
                except Exception as e:
                    logger.error(f"[WebRTC] Error cargando modelo: {e}")
                    return None
            return cls._modelo_compartido

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.recognizer = None
        self.recognizer_cmd = None
        self.usuario_id = None
        self.pcm_buffer = bytearray()
        self.ultimo_feed_ms = 0
        self.chunks_audio = 0
        self.last_cmd_sent_at = {
            'iniciar_proceso': 0,
            'finalizar_proceso': 0,
            'guardar_pieza': 0,
            'confirmar_datos': 0,
            'cancelar_proceso': 0,
            'repetir_proceso': 0
        }
        self.CMD_DEBOUNCE_MS = 500
        self.is_capturing_session = False
        self.texto_acumulado = ""
        self.last_sent_partial = ""
        self.cmd_require_final = os.getenv('VOICE_CMD_REQUIRE_FINAL', 'true').lower() == 'true'
        self.empty_partial_count = 0
        self.last_partial_text = ""
        self.last_partial_token_count = 0
        self.last_partial_timestamp = 0
        self.last_general_tokens = []
        self.pending_cmd_candidate = None
        self.CMD_CONFIRMATION_WINDOW_MS = int(os.getenv('VOICE_CMD_CONFIRM_WINDOW_MS', '600'))
        self._last_command_token = None
        self._last_command_phrase = None
        self._last_command_phrase_tokens = None
        self.SILENCE_TIMEOUT_MS = 500
        self.FEED_MIN_MUESTRAS = int(os.getenv('VOSK_FEED_MIN_SAMPLES', '2000'))
        self.FEED_MAX_INTERVALO_MS = int(os.getenv('VOSK_FEED_MAX_INTERVAL_MS', '200'))
        self.FEED_MIN_BYTES = self.FEED_MIN_MUESTRAS * 2
        self.ENABLE_SILENCE_PADDING = os.getenv('VOICE_ENABLE_SILENCE_PADDING', 'false').lower() == 'true'

    def _confidence_stats(self, payload):
        palabras = payload.get('result') or []
        confs = [w.get('conf') for w in palabras if isinstance(w.get('conf'), (int, float))]
        stats = {'vosk_word_count': len(palabras)}
        if confs:
            stats.update({
                'vosk_conf_avg': round(sum(confs) / len(confs), 4),
                'vosk_conf_min': round(min(confs), 4),
                'vosk_conf_max': round(max(confs), 4),
            })
        return stats

    def _log_flow(self, message, *, level='info', event='voice_webrtc', **extra):
        payload = {'event': event, 'consumer': 'webrtc_ws'}
        payload.update({k: v for k, v in extra.items() if v is not None})
        getattr(logger, level, logger.info)(message, extra=payload)

    def _tokenize_text(self, text):
        if not text:
            return []
        normalized = normalize_command_text(text)
        return [tok for tok in normalized.split() if tok]

    def _cmd_debounce_ms(self, cmd):
        if cmd in ['iniciar_proceso', 'finalizar_proceso']:
            return 400
        return self.CMD_DEBOUNCE_MS

    def _is_within_debounce(self, cmd):
        ahora = self._now_ms()
        ultimo = self.last_cmd_sent_at.get(cmd, 0)
        return (ahora - ultimo) < self._cmd_debounce_ms(cmd)

    def _general_tokens_include(self, phrase_tokens):
        if not phrase_tokens or not self.last_general_tokens:
            return False
        if isinstance(phrase_tokens, (str, bytes)):
            phrase_tokens = str(phrase_tokens).split()
        if not phrase_tokens:
            return False
        haystack = self.last_general_tokens[-len(phrase_tokens) * 2 :]
        for idx in range(0, len(haystack) - len(phrase_tokens) + 1):
            if haystack[idx : idx + len(phrase_tokens)] == phrase_tokens:
                return True
        return False

    def _texto_contiene_frase(self, text, phrase):
        if not text or not phrase:
            return False
        normalized = normalize_command_text(text)
        phrase_tokens = phrase.split()
        tokens = normalized.split()
        for idx in range(len(tokens) - len(phrase_tokens) + 1):
            if tokens[idx : idx + len(phrase_tokens)] == phrase_tokens:
                return True
        return False

    def _set_pending_command(self, cmd, texto, metrics, *, last_token=None, phrase=None, phrase_tokens=None):
        now = self._now_ms()
        self.pending_cmd_candidate = {
            'cmd': cmd,
            'token': last_token,
            'phrase': phrase,
            'phrase_tokens': phrase_tokens,
            'text': texto,
            'metrics': metrics,
            'timestamp': now
        }
        self._log_flow(
            'cmd_pending_confirmation',
            level='debug',
            event='voice_cmd_pending_confirmation',
            cmd=cmd,
            token=last_token
        )

    async def _maybe_confirm_pending_command(self):
        if self.cmd_require_final:
            return
        pending = self.pending_cmd_candidate
        if not pending:
            return
        now = self._now_ms()
        phrase_tokens = pending.get('phrase_tokens')
        if phrase_tokens and self._general_tokens_include(phrase_tokens):
            self.pending_cmd_candidate = None
            await self._handle_confirmed_command(
                pending['cmd'],
                pending['text'],
                metrics=pending.get('metrics'),
                matched_token=pending['token']
            )
            return
        if (now - pending['timestamp']) > self.CMD_CONFIRMATION_WINDOW_MS:
            self._log_flow(
                'cmd_pending_expired',
                level='debug',
                event='voice_cmd_pending_expired',
                cmd=pending['cmd'],
                token=pending['token']
            )
            self.pending_cmd_candidate = None

    async def _handle_confirmed_command(self, cmd, texto, *, metrics=None, matched_token=None):
        if self._is_within_debounce(cmd):
            return
        self.pending_cmd_candidate = None
        ahora = self._now_ms()
        self.last_cmd_sent_at[cmd] = ahora

        if cmd == 'iniciar_proceso':
            self.is_capturing_session = True
            self.texto_acumulado = ""
            self.last_sent_partial = ""
        elif cmd == 'finalizar_proceso':
            self.is_capturing_session = False
            if self.texto_acumulado.strip():
                final_text = self.texto_acumulado.strip()
                await self.send(text_data=json.dumps({'type': 'final', 'text': final_text, 'source': 'accumulated_partials'}))
                voice_logger.log_transcription(
                    final_text,
                    'final',
                    {'source': 'webrtc_ws_accumulated'}
                )
        elif cmd == 'cancelar_proceso':
            self.is_capturing_session = False
            self.texto_acumulado = ""
            self.last_sent_partial = ""
        elif cmd == 'repetir_proceso':
            self.texto_acumulado = ""
            self.last_sent_partial = ""
            self.is_capturing_session = True

        log_extra = dict(metrics or {})
        if matched_token:
            log_extra['token'] = matched_token
        self._log_flow(
            'cmd_detectado',
            event='voice_cmd_detected',
            cmd=cmd,
            raw_text=texto,
            **log_extra
        )
        try:
            metadata = {'source': 'webrtc_ws'}
            if metrics:
                metadata.update(metrics)
            voice_logger.log_command(cmd, texto or cmd, metadata=metadata)
        except Exception as exc:
            self._log_flow(
                'cmd_log_error',
                level='error',
                event='voice_cmd_log_error',
                error=str(exc),
                cmd=cmd
            )

        payload = {'type': 'command', 'command': cmd, 'text': texto}
        if metrics:
            payload['confidence'] = metrics
        await self.send(text_data=json.dumps(payload))
        await self._send_command_feedback(
            'accepted',
            command=cmd,
            raw_text=texto,
            confidence=(metrics or {}).get('vosk_conf_avg')
        )

    async def connect(self):
        await self.accept()
        self._log_flow('cliente_conectado', event='voice_webrtc_connected')
        modelo = await self.obtener_modelo()
        if not modelo:
            self._log_flow(
                'modelo_no_disponible',
                level='error',
                event='voice_model_missing',
                model_path=self.VOSK_MODEL_PATH
            )
            await self.send(text_data=json.dumps({'type': 'error', 'message': 'Modelo Vosk no disponible'}))
            await self.close()
            return

        try:
            # Vocabulario automotriz para mejorar precisión
            from parts.vocabulario_automotriz import obtener_vocabulario_json
            vocabulario_json = obtener_vocabulario_json()
            self.recognizer = await asyncio.to_thread(KaldiRecognizer, modelo, self.SAMPLE_RATE, vocabulario_json)
            self.recognizer.SetWords(True)
            self.recognizer.SetMaxAlternatives(10)
            self.recognizer.SetPartialWords(True)
            if hasattr(self.recognizer, 'SetMaxRecognitionDelay'):
                try:
                    self.recognizer.SetMaxRecognitionDelay(0.8)
                except Exception:
                    pass

            # Gramática de comandos (solo palabras clave)
            grammar_cmd = json.dumps(STRICT_COMMAND_GRAMMAR)
            try:
                self.recognizer_cmd = await asyncio.to_thread(KaldiRecognizer, modelo, self.SAMPLE_RATE, grammar_cmd)
                self.recognizer_cmd.SetWords(True)
            except Exception:
                self.recognizer_cmd = await asyncio.to_thread(KaldiRecognizer, modelo, self.SAMPLE_RATE)
                self.recognizer_cmd.SetWords(True)

            await self.send(text_data=json.dumps({
                'type': 'connected',
                'message': 'Servidor WebRTC integrado listo',
                'sample_rate': self.SAMPLE_RATE
            }))
        except Exception as e:
            self._log_flow(
                'error_inicializando',
                level='error',
                event='voice_webrtc_init_error',
                error=str(e)
            )
            await self.send(text_data=json.dumps({'type': 'error', 'message': f'Error inicialización: {e}'}))
            await self.close()

    async def disconnect(self, close_code):
        self._log_flow(
            'cliente_desconectado',
            event='voice_webrtc_disconnected',
            close_code=close_code
        )
        if self.recognizer:
            try:
                final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                datos = json.loads(final_result)
                texto_final = datos.get('text', '')
                if texto_final:
                    voice_logger.log_transcription(
                        texto_final,
                        'final',
                        {'source': 'webrtc_ws_disconnect'}
                    )
                    await self.send(text_data=json.dumps({'type': 'final', 'text': texto_final, 'is_disconnect': True}))
            except Exception as e:
                self._log_flow(
                    'error_final_desconexion',
                    level='warning',
                    event='voice_webrtc_final_error',
                    error=str(e)
                )

    def _now_ms(self):
        import time
        return int(time.time() * 1000)

    async def receive(self, text_data=None, bytes_data=None):
        if text_data:
            try:
                data = json.loads(text_data)
                if data.get('type') == 'request_final' and self.recognizer:
                    await self._forzar_final()
            except Exception:
                pass
            return
        if bytes_data:
            self.chunks_audio += 1
            self.pcm_buffer.extend(bytes_data)
            ahora = self._now_ms()
            debe_feedear = False
            if len(self.pcm_buffer) >= self.FEED_MIN_BYTES:
                debe_feedear = True
            elif self.ultimo_feed_ms == 0 or (ahora - self.ultimo_feed_ms) >= self.FEED_MAX_INTERVALO_MS:
                debe_feedear = len(self.pcm_buffer) > 0
            if not debe_feedear:
                return
            feed = bytes(self.pcm_buffer)
            self.pcm_buffer.clear()
            self.ultimo_feed_ms = ahora
            await self._procesar_feed(feed)

    async def _procesar_feed(self, feed_data):
        if not self.recognizer:
            return
        try:
            # Comandos rápidos
            if self.recognizer_cmd:
                await asyncio.to_thread(self.recognizer_cmd.AcceptWaveform, feed_data)
                parcial_cmd = json.loads(self.recognizer_cmd.PartialResult()).get('partial', '')
                if parcial_cmd:
                    await self._detectar_comando(parcial_cmd, source='cmd_partial')
                final_payload = json.loads(self.recognizer_cmd.FinalResult())
                final_cmd = final_payload.get('text', '')
                cmd_metrics = self._confidence_stats(final_payload)
                if final_cmd and final_cmd != parcial_cmd:
                    await self._detectar_comando(final_cmd, metrics=cmd_metrics, source='cmd_final')

            # Transcripción (solo parciales)
            await asyncio.to_thread(self.recognizer.AcceptWaveform, feed_data)
            parcial = json.loads(self.recognizer.PartialResult()).get('partial', '')
            ahora = self._now_ms()
            if parcial:
                tokens_normalized = self._tokenize_text(parcial)
                if tokens_normalized:
                    self.last_general_tokens.extend(tokens_normalized)
                    self.last_general_tokens = self.last_general_tokens[-12:]
                await self._maybe_confirm_pending_command()
                if self.is_capturing_session and parcial != self.last_sent_partial:
                    if len(parcial) > len(self.texto_acumulado):
                        nuevo = parcial[len(self.texto_acumulado):]
                        self.texto_acumulado = parcial
                        logger.debug(f"[WebRTC] Acumulando:'{nuevo}'")
                    elif parcial != self.texto_acumulado and not self.texto_acumulado.endswith(parcial):
                        if self.texto_acumulado:
                            self.texto_acumulado += " " + parcial
                        else:
                            self.texto_acumulado = parcial
                    await self.send(text_data=json.dumps({'type': 'partial', 'text': parcial, 'accumulated': self.texto_acumulado}))
                    self.last_sent_partial = parcial
                self.empty_partial_count = 0
                tokens = [t for t in parcial.strip().split(' ') if t]
                if len(tokens) > self.last_partial_token_count:
                    nueva = tokens[-1]
                    if nueva and re.match(r'^[a-zA-ZáéíóúñÑüÜ]+$', nueva):
                        await self.send(text_data=json.dumps({'type': 'word', 'text': nueva}))
                    self.last_partial_token_count = len(tokens)
                    self.last_partial_text = parcial
                    self.last_partial_timestamp = ahora
                elif len(tokens) < self.last_partial_token_count:
                    self.last_partial_token_count = len(tokens)
                    self.last_partial_text = parcial
                    self.last_partial_timestamp = ahora
                elif parcial != self.last_partial_text:
                    self.last_partial_text = parcial
                    self.last_partial_timestamp = ahora
            else:
                self.empty_partial_count += 1
                if (self.ENABLE_SILENCE_PADDING and
                    self.empty_partial_count >= 3 and
                    self.last_partial_text and
                    len(self.last_partial_text.strip()) > 0):
                    logger.info("[WebRTC] Silencio detectado → forzar final parcial previo")
                    await self._forzar_final()
                    self.empty_partial_count = 0
                    self.last_partial_text = ""
                await self._maybe_confirm_pending_command()
        except Exception as e:
            logger.error(f"[WebRTC] Error procesando feed: {e}")

    async def _forzar_final(self):
        if not self.recognizer:
            return
        try:
            if self.ENABLE_SILENCE_PADDING:
                silencio = b'\x00' * int(self.SAMPLE_RATE * 2 * 0.5)
                await asyncio.to_thread(self.recognizer.AcceptWaveform, silencio)
            final = json.loads(await asyncio.to_thread(self.recognizer.FinalResult))
            texto_final = final.get('text', '')
            if texto_final:
                voice_logger.log_transcription(
                    texto_final,
                    'final',
                    {'source': 'webrtc_ws_forced'}
                )
                await self.send(text_data=json.dumps({'type': 'final', 'text': texto_final, 'source': 'forced'}))
        except Exception as e:
            logger.warning(f"[WebRTC] Error forzando final: {e}")

    async def _detectar_comando(self, texto, *, metrics=None, source='cmd_partial'):
        allow_partial = source not in ('cmd_partial', 'cmd_final')
        cmd = self._normalizar_comando(texto, allow_partial=allow_partial)
        phrase = getattr(self, '_last_command_phrase', None)
        phrase_tokens = getattr(self, '_last_command_phrase_tokens', None)
        token = getattr(self, '_last_command_token', None)
        if not cmd or not phrase or not phrase_tokens:
            return
        if self._is_within_debounce(cmd):
            return

        from_cmd_recognizer = source in ('cmd_partial', 'cmd_final')
        if from_cmd_recognizer:
            if self.cmd_require_final and source == 'cmd_partial':
                self._log_flow(
                    'cmd_partial_blocked',
                    level='debug',
                    event='voice_cmd_pending',
                    cmd=cmd,
                    token=token,
                    reason='partial_blocked'
                )
                self._set_pending_command(
                    cmd,
                    texto,
                    metrics,
                    last_token=token,
                    phrase=phrase,
                    phrase_tokens=phrase_tokens,
                )
                return
            if self._general_tokens_include(phrase_tokens):
                await self._handle_confirmed_command(
                    cmd,
                    texto,
                    metrics=metrics,
                    matched_token=phrase,
                )
            else:
                self._set_pending_command(
                    cmd,
                    texto,
                    metrics,
                    last_token=token,
                    phrase=phrase,
                    phrase_tokens=phrase_tokens,
                )
            return

        if not self._texto_contiene_frase(texto, phrase):
            return
        await self._handle_confirmed_command(
            cmd,
            texto,
            metrics=metrics,
            matched_token=phrase,
        )

    def _normalizar_comando(self, text, *, allow_partial=False):
        if not text:
            return None
        self._last_command_token = None
        self._last_command_phrase = None
        self._last_command_phrase_tokens = None
        cmd, phrase = match_strict_command(text, allow_partial=allow_partial)
        if cmd and phrase:
            self._last_command_phrase = phrase
            self._last_command_token = phrase.split()[-1]
            self._last_command_phrase_tokens = phrase.split()
        return cmd

    async def _send_command_feedback(self, status, *, command=None, raw_text='', confidence=None, reason=None):
        payload = {
            'type': 'command_feedback',
            'status': status,
            'command': command,
            'raw_text': raw_text,
            'confidence': confidence,
            'reason': reason,
        }
        try:
            await self.send(text_data=json.dumps(payload))
        except Exception:
            pass
