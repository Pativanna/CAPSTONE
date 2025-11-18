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

logger = logging.getLogger(__name__)

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
    VOSK_MODEL_PATH = os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42')

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
        self.empty_partial_count = 0
        self.last_partial_text = ""
        self.last_partial_token_count = 0
        self.last_partial_timestamp = 0
        self.SILENCE_TIMEOUT_MS = 500
        self.FEED_MIN_MUESTRAS = int(os.getenv('VOSK_FEED_MIN_SAMPLES', '2000'))
        self.FEED_MAX_INTERVALO_MS = int(os.getenv('VOSK_FEED_MAX_INTERVAL_MS', '200'))
        self.FEED_MIN_BYTES = self.FEED_MIN_MUESTRAS * 2

    async def connect(self):
        await self.accept()
        logger.info("[WebRTC] Cliente conectado")
        modelo = await self.obtener_modelo()
        if not modelo:
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
            grammar_cmd = json.dumps([
                "iniciar", "inicia", "inicio",
                "detener", "deten", "detengo",
                "confirmar", "confirmo", "confirma",
                "cancelar", "cancela",
                "repetir", "repite"
            ])
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
            logger.error(f"[WebRTC] Error inicializando reconocedores: {e}")
            await self.send(text_data=json.dumps({'type': 'error', 'message': f'Error inicialización: {e}'}))
            await self.close()

    async def disconnect(self, close_code):
        logger.info(f"[WebRTC] Cliente desconectado code={close_code}")
        if self.recognizer:
            try:
                final_result = await asyncio.to_thread(self.recognizer.FinalResult)
                datos = json.loads(final_result)
                texto_final = datos.get('text', '')
                if texto_final:
                    await self.send(text_data=json.dumps({'type': 'final', 'text': texto_final, 'is_disconnect': True}))
            except Exception as e:
                logger.warning(f"[WebRTC] Error obteniendo resultado final: {e}")

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
                    await self._detectar_comando(parcial_cmd)
                final_cmd = json.loads(self.recognizer_cmd.FinalResult()).get('text', '')
                if final_cmd and final_cmd != parcial_cmd:
                    await self._detectar_comando(final_cmd)

            # Transcripción (solo parciales)
            await asyncio.to_thread(self.recognizer.AcceptWaveform, feed_data)
            parcial = json.loads(self.recognizer.PartialResult()).get('partial', '')
            ahora = self._now_ms()
            if parcial:
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
                if (self.empty_partial_count >= 3 and self.last_partial_text and len(self.last_partial_text.strip()) > 0):
                    logger.info("[WebRTC] Silencio detectado → forzar final parcial previo")
                    await self._forzar_final()
                    self.empty_partial_count = 0
                    self.last_partial_text = ""
        except Exception as e:
            logger.error(f"[WebRTC] Error procesando feed: {e}")

    async def _forzar_final(self):
        if not self.recognizer:
            return
        try:
            silencio = b'\x00' * int(self.SAMPLE_RATE * 2 * 0.5)
            await asyncio.to_thread(self.recognizer.AcceptWaveform, silencio)
            final = json.loads(await asyncio.to_thread(self.recognizer.FinalResult))
            texto_final = final.get('text', '')
            if texto_final:
                await self.send(text_data=json.dumps({'type': 'final', 'text': texto_final, 'source': 'forced'}))
        except Exception as e:
            logger.warning(f"[WebRTC] Error forzando final: {e}")

    async def _detectar_comando(self, texto):
        cmd = self._normalizar_comando(texto)
        if not cmd:
            return
        ahora = self._now_ms()
        ultimo = self.last_cmd_sent_at.get(cmd, 0)
        if cmd in ['iniciar_proceso', 'finalizar_proceso']:
            debounce = 400
        else:
            debounce = self.CMD_DEBOUNCE_MS
        if (ahora - ultimo) < debounce:
            return
        self.last_cmd_sent_at[cmd] = ahora
        # Estados especiales
        if cmd == 'iniciar_proceso':
            self.is_capturing_session = True
            self.texto_acumulado = ""
            self.last_sent_partial = ""
        if cmd == 'finalizar_proceso':
            self.is_capturing_session = False
            if self.texto_acumulado.strip():
                await self.send(text_data=json.dumps({'type': 'final', 'text': self.texto_acumulado.strip(), 'source': 'accumulated_partials'}))
        if cmd == 'cancelar_proceso':
            self.is_capturing_session = False
            self.texto_acumulado = ""
            self.last_sent_partial = ""
        if cmd == 'repetir_proceso':
            self.texto_acumulado = ""
            self.last_sent_partial = ""
            self.is_capturing_session = True
        await self.send(text_data=json.dumps({'type': 'command', 'command': cmd, 'text': texto}))

    def _normalizar_comando(self, text):
        if not text:
            return None
        tokens = [tok for tok in re.split(r'\s+', text.lower().strip()) if tok]
        if not tokens:
            return None
        relleno = {'um', 'mmm', 'mm', 'uh', 'uhm', 'eh', 'em', 'este', 'pues', 'ah', 'ehh'}
        mapa = {
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
            cmd = mapa.get(token)
            if cmd:
                return cmd
        return None
