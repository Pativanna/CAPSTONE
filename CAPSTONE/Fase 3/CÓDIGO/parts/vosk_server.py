#!/usr/bin/env python3
"""
Vosk WebSocket Server for Real-Time Speech Recognition
Receives continuous audio stream from browser and returns transcriptions
"""

import asyncio
from aiohttp import web
import base64
import json
import logging
import os
import sys
import tempfile
import subprocess
import wave
import contextlib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import websockets
from vosk import Model, KaldiRecognizer

import django
from django.db import transaction
from django.contrib.auth import get_user_model

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.append(str(BASE_DIR))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'car_inventory.settings')
django.setup()

from parts.models import PerfilVozUsuario


Usuario = get_user_model()


def _serializar_estado(estado):
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


def _deserializar_estado(valor):
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


def _cargar_estado_sync(usuario_id: int) -> str:
    try:
        usuario = Usuario.objects.get(pk=usuario_id)
    except Usuario.DoesNotExist:
        return ''
    perfil, _ = PerfilVozUsuario.objects.get_or_create(usuario=usuario)
    return perfil.estado_adaptacion or ''


def _guardar_estado_sync(usuario_id: int, estado_serializado: str):
    if not estado_serializado:
        return
    try:
        usuario = Usuario.objects.get(pk=usuario_id)
    except Usuario.DoesNotExist:
        return
    with transaction.atomic():
        perfil, _ = PerfilVozUsuario.objects.select_for_update().get_or_create(usuario=usuario)
        perfil.estado_adaptacion = estado_serializado
        perfil.save(update_fields=['estado_adaptacion', 'actualizado_en'])


async def _obtener_estado_usuario(usuario_id):
    try:
        usuario_int = int(usuario_id)
    except (TypeError, ValueError):
        return ''
    return await asyncio.to_thread(_cargar_estado_sync, usuario_int)


async def _persistir_estado_usuario(usuario_id, estado_serializado):
    if not estado_serializado:
        return
    try:
        usuario_int = int(usuario_id)
    except (TypeError, ValueError):
        return
    await asyncio.to_thread(_guardar_estado_sync, usuario_int, estado_serializado)


def _aplicar_estado(reconocedor, estado_serializado):
    if not estado_serializado or not hasattr(reconocedor, 'SetAdaptationState'):
        return False
    estado = _deserializar_estado(estado_serializado)
    if estado is None:
        return False
    try:
        reconocedor.SetAdaptationState(estado)
        return True
    except TypeError:
        if isinstance(estado, (bytes, bytearray)):
            try:
                reconocedor.SetAdaptationState(estado.decode('utf-8'))
                return True
            except Exception:
                return False
        return False
    except Exception:
        return False


def _capturar_estado(reconocedor):
    if not hasattr(reconocedor, 'GetAdaptationState'):
        return ''
    try:
        estado = reconocedor.GetAdaptationState()
    except Exception:
        return ''
    return _serializar_estado(estado)

from pythonjsonlogger import jsonlogger

# Configuración de logging estructurado JSON para el servidor Vosk.
# Formato incluye campos clave y permite añadir extras como evento, usuario_id y client_id.
_handler = logging.StreamHandler()
_formatter = jsonlogger.JsonFormatter()
_handler.setFormatter(_formatter)
logger = logging.getLogger('vosk_server')
logger.setLevel(logging.INFO)
logger.handlers = []  # Evitar duplicados si se recarga el módulo
logger.addHandler(_handler)
logger.propagate = False

# Configuración
VOSK_MODEL_PATH = os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42')
SAMPLE_RATE = 16000
WEBSOCKET_PORT = 8765

# Cargar modelo Vosk al inicio
logger.info("Cargando modelo Vosk", extra={'evento': 'modelo_cargando', 'model_path': VOSK_MODEL_PATH})
model = Model(VOSK_MODEL_PATH)
logger.info("Modelo Vosk cargado exitosamente", extra={'evento': 'modelo_cargado', 'model_path': VOSK_MODEL_PATH})

# Comandos de entrenamiento (frases aceptadas para cada categoría)
COMANDOS_ENTRENAMIENTO = {
    'iniciar_proceso': [
        'iniciar proceso', 'iniciar el proceso', 'inicio proceso', 'inicia el proceso'
    ],
    'detener_proceso': [
        'detener proceso', 'detener el proceso', 'finalizar proceso', 'finalizar el proceso',
        'terminar proceso', 'terminar el proceso'
    ],
    'guardar_pieza': [
        'guardar pieza', 'guardar la pieza'
    ]
}

def _texto_normalizado(texto: str) -> str:
    if not texto:
        return ''
    return ' '.join(str(texto).lower().split())

def _comando_desde_texto(texto: str) -> str:
    texto_norm = _texto_normalizado(texto)
    if not texto_norm:
        return ''
    for clave, frases in COMANDOS_ENTRENAMIENTO.items():
        for frase in frases:
            if frase in texto_norm:
                return clave
    return ''


async def process_audio_stream(websocket, path):
    """
    Procesa stream de audio continuo desde el cliente
    """
    # Reconocedor libre (dictado general)
    recognizer = KaldiRecognizer(model, SAMPLE_RATE)
    
    # MEJORA 1: Habilitar características avanzadas
    recognizer.SetWords(True)  # Obtener timestamps de palabras
    parsed = urlparse(path or '')
    query_params = parse_qs(parsed.query)
    usuario_id = (query_params.get('usuario_id') or query_params.get('user_id') or [None])[0]
    estado_cargado = False
    estado_serializado_actual = ''
    recognizer.SetMaxAlternatives(3)  # Considerar múltiples alternativas
    recognizer.SetPartialWords(True)  # Palabras parciales más precisas
    
    # MEJORA CRÍTICA: Reducir latencia para respuesta más rápida
    # Estos parámetros hacen que el modelo devuelva resultados parciales más frecuentemente
    recognizer.SetNLSML(False)  # Desactivar NLSML para menos overhead
    
    # RECOGNIZER COMANDOS (KWS/Gramática): estricto con "proceso" para evitar falsos positivos
    # Usamos un segundo recognizer con gramática cerrada que solo detecta estas frases.
    # Si el modelo no soporta gramática, el constructor igualmente acepta la lista.
    COMMAND_GRAMMAR = json.dumps([
        # INICIAR
        "iniciar proceso", "iniciar el proceso", "inicio proceso", "inicia el proceso",
        # FINALIZAR / TERMINAR / DETENER
        "finalizar proceso", "finalizar el proceso",
        "terminar proceso", "terminar el proceso",
        "detener proceso", "detener el proceso",
        # GUARDAR
        "guardar pieza"
    ])
    try:
        recognizer_cmd = KaldiRecognizer(model, SAMPLE_RATE, COMMAND_GRAMMAR)
        recognizer_cmd.SetWords(True)
    except Exception:
        # Fallback: si falla gramática, usar otro recognizer libre y filtrar por texto
        recognizer_cmd = KaldiRecognizer(model, SAMPLE_RATE)
        recognizer_cmd.SetWords(True)
    
    client_id = id(websocket)
    logger.info("Cliente conectado", extra={'evento': 'cliente_conectado', 'client_id': client_id, 'usuario_id': usuario_id})

    async def cargar_estado_usuario(force=False):
        nonlocal estado_cargado, estado_serializado_actual
        if not usuario_id:
            return
        if estado_cargado and not force:
            return
        estado_serializado_actual = await _obtener_estado_usuario(usuario_id)
        if estado_serializado_actual:
            if _aplicar_estado(recognizer, estado_serializado_actual):
                _aplicar_estado(recognizer_cmd, estado_serializado_actual)
                estado_cargado = True
                try:
                    await websocket.send(json.dumps({
                        'type': 'adaptacion',
                        'estado': 'aplicada'
                    }))
                except Exception:
                    pass

    await cargar_estado_usuario()
    
    audio_chunks_received = 0  # Contador de chunks recibidos
    bytes_acumulados = 0       # Total de bytes recibidos
    primer_sniff_hecho = False # Detección de formato en primer chunk
    modo_transcodificacion = 'none'  # 'none' | 'ffmpeg'
    ffmpeg_proc = None
    ffmpeg_reader_task = None
    from collections import deque
    pcm_buffer_deque = deque()  # buffer de salida de ffmpeg
    
    # Acumulación y umbrales de alimentación al recognizer (para evitar troceado 256/512 bytes)
    # AJUSTE 2: Reducimos umbrales para aumentar frecuencia de parciales sin volver a 0.25s.
    # Objetivo: obtener parciales visibles y finales de longitud aceptable.
    FEED_MIN_MUESTRAS = int(os.getenv('VOSK_FEED_MIN_SAMPLES', '8000'))  # ~0.5s @16kHz
    FEED_MAX_INTERVALO_MS = int(os.getenv('VOSK_FEED_MAX_INTERVAL_MS', '300'))  # flush por tiempo máx.
    FEED_MIN_BYTES = FEED_MIN_MUESTRAS * 2  # Int16 → 2 bytes
    pcm_acumulado = bytearray()
    ultimo_feed_ms = 0

    async def _ffmpeg_reader(proc):
        try:
            while True:
                data = await proc.stdout.read(4096)
                if not data:
                    break
                pcm_buffer_deque.append(data)
        except Exception:
            pass
    last_partial_token_count = 0  # Para emitir palabras incrementales (desde 'partial')
    last_partial_text = ""
    last_partial_words_count = 0  # Para emitir palabras incrementales (desde 'partial_result')
    last_partial_words_list = []  # Lista de palabras de la última hipótesis parcial (para fallback)
    
    # Debounce de eventos de comando para no spamear
    last_cmd_sent_at = {
        'iniciar_proceso': 0,
        'finalizar_proceso': 0,
        'terminar_proceso': 0,
        'detener_proceso': 0,
        'listo_proceso': 0,
        'confirmar': 0,
        'guardar': 0,
        'guardar_pieza': 0
    }
    CMD_DEBOUNCE_MS = 1000
    last_word_sent_ms = 0
    WORD_THROTTLE_MS = 60

    def _now_ms():
        return int(asyncio.get_event_loop().time() * 1000)

    def normalize_command(text: str):
        t = (text or '').lower()
        # Normalizar espacios
        t = ' '.join(t.split())
        
        # VALIDACIÓN ESTRICTA: El comando debe estar prácticamente solo
        # Si el texto tiene más de 6 palabras, probablemente NO es un comando intencional
        palabras = t.split()
        if len(palabras) > 6:
            return None
        
        # INICIAR (variantes)
        if ('iniciar proceso' in t) or ('iniciar el proceso' in t) or ('inicio proceso' in t) or ('inicia el proceso' in t):
            return 'iniciar_proceso'
        # FINALIZAR / TERMINAR / DETENER (todas → finalizar_proceso)
        if ('finalizar proceso' in t) or ('finalizar el proceso' in t) \
           or ('terminar proceso' in t) or ('terminar el proceso' in t) \
           or ('detener proceso' in t) or ('detener el proceso' in t):
            return 'finalizar_proceso'
        # GUARDAR
        if 'guardar pieza' in t:
            return 'guardar_pieza'
        return None

    async def maybe_send_command(text: str):
        cmd = normalize_command(text)
        if not cmd:
            return
        now = _now_ms()
        if now - last_cmd_sent_at.get(cmd, 0) < CMD_DEBOUNCE_MS:
            return
        last_cmd_sent_at[cmd] = now
        logger.info(f" COMANDO DETECTADO [{client_id}]: {cmd} ('{text}')")
        await websocket.send(json.dumps({
            'type': 'command',
            'command': cmd,
            'text': text
        }))

        # FLUSH ON END-COMMAND: si es un comando de finalización, forzar envío de un 'final'
        # usando el mejor texto disponible (último parcial o palabras incrementales)
        if cmd in {'finalizar_proceso', 'terminar_proceso', 'detener_proceso', 'listo_proceso'}:
            # Construir candidato a texto final
            candidate = (last_partial_text or '').strip()
            if not candidate or len(candidate) < 4:
                try:
                    candidate = ' '.join([w for w in last_partial_words_list if isinstance(w, str)]).strip()
                except Exception:
                    candidate = candidate or ''

            # Limpiar comandos del texto candidato
            if candidate:
                import re
                patterns = [
                    r"iniciar(\s+el)?\s+proceso", r"inicio\s+proceso", r"comenzar\s+proceso",
                    r"finalizar(\s+el)?\s+proceso", r"terminar(\s+el)?\s+proceso", r"detener(\s+el)?\s+proceso",
                    r"finalizar", r"terminar", r"detener", r"listo", r"lista", r"proceso", r"procesos"
                ]
                for pat in patterns:
                    candidate = re.sub(pat, "", candidate, flags=re.IGNORECASE)
                candidate = re.sub(r"\s+", " ", candidate).strip()

            if candidate:
                try:
                    await websocket.send(json.dumps({
                        'type': 'final',
                        'text': candidate,
                        'words': []
                    }))
                except Exception:
                    pass

    try:
        # Enviar confirmación de conexión
        await websocket.send(json.dumps({
            'type': 'connected',
            'message': 'Servidor Vosk listo',
            'sample_rate': SAMPLE_RATE
        }))
        
        async for message in websocket:
            if isinstance(message, str):
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if payload.get('type') == 'identificacion':
                    posible_id = payload.get('usuario_id') or payload.get('user_id')
                    if posible_id and posible_id != usuario_id:
                        usuario_id = posible_id
                        estado_cargado = False
                        await cargar_estado_usuario(force=True)
                continue

            # El mensaje es audio binario (idealmente PCM S16LE @16k mono)
            if isinstance(message, bytes):
                audio_chunks_received += 1
                
                # LOG: Confirmar recepción de audio (primeros 5 y cada 50)
                if audio_chunks_received <= 5 or audio_chunks_received % 50 == 0:
                    try:
                        blen = len(message)
                    except Exception:
                        blen = None
                    logger.info("Chunk audio recibido", extra={'evento': 'audio_chunk', 'client_id': client_id, 'chunks': audio_chunks_received, 'bytes': blen})
                
                # Procesar chunk de audio
                # 1) Sniff inicial y, si hace falta, preparar transcodificación con ffmpeg
                if not primer_sniff_hecho:
                    try:
                        b = message[:8]
                        magic = b.hex()
                        formato = 'raw_pcm'
                        if b[:4] == b'RIFF':
                            formato = 'wav_riff'
                        elif b[:4] == b'OggS':
                            formato = 'ogg_opus'
                        elif b[:4] == b'webm' or magic.startswith('1a45dfa3'):
                            formato = 'webm_ebml'
                        # Calcular RMS aproximado del primer chunk
                        rms = None
                        try:
                            import array as _arr
                            arr = _arr.array('h')
                            arr.frombytes(message[:min(len(message), 8000)])  # hasta 4k muestras
                            if len(arr) > 0:
                                s = 0
                                for v in arr:
                                    s += (v*v)
                                rms = (s / len(arr)) ** 0.5 / 32768.0
                        except Exception:
                            rms = None
                        # Log explícito del sniff del primer paquete
                        try:
                            logger.info("Sniff primer chunk", extra={'evento': 'sniff', 'client_id': client_id, 'bytes': len(message), 'magic': magic[:16], 'formato': formato, 'sample_rate_esperado': SAMPLE_RATE, 'rms_aprox': rms})
                        except Exception:
                            pass
                        # Si no es raw PCM, levantar pipeline ffmpeg
                        if formato != 'raw_pcm':
                            modo_transcodificacion = 'ffmpeg'
                            ffmpeg_proc = await asyncio.create_subprocess_exec(
                                'ffmpeg', '-loglevel', 'error', '-hide_banner',
                                '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', str(SAMPLE_RATE), 'pipe:1',
                                stdin=asyncio.subprocess.PIPE,
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE
                            )
                            ffmpeg_reader_task = asyncio.create_task(_ffmpeg_reader(ffmpeg_proc))
                            logger.info("Transcodificación activada", extra={'evento': 'ffmpeg_start', 'client_id': client_id, 'detected': formato})
                    except Exception:
                        pass
                    primer_sniff_hecho = True

                # 2) Obtener bytes PCM para alimentar recognizers
                data_to_feed = b''
                if modo_transcodificacion == 'ffmpeg' and ffmpeg_proc and ffmpeg_proc.stdin:
                    try:
                        ffmpeg_proc.stdin.write(message)
                        await ffmpeg_proc.stdin.drain()
                        # Drenar todo lo disponible convertido a PCM
                        if pcm_buffer_deque:
                            data_to_feed = b''.join(pcm_buffer_deque)
                            pcm_buffer_deque.clear()
                    except Exception:
                        data_to_feed = b''
                else:
                    # Asumimos raw PCM S16LE @16k mono
                    data_to_feed = message

                # 2.5) Acumular PCM y decidir cuándo alimentar el recognizer
                if data_to_feed:
                    pcm_acumulado.extend(data_to_feed)
                now_ms = _now_ms()
                debe_feedear = False
                if len(pcm_acumulado) >= FEED_MIN_BYTES:
                    debe_feedear = True
                elif ultimo_feed_ms == 0 or (now_ms - ultimo_feed_ms) >= FEED_MAX_INTERVALO_MS:
                    # Hacer flush periódico aunque el tamaño sea pequeño para no retrasar parciales
                    debe_feedear = len(pcm_acumulado) > 0

                if not debe_feedear:
                    # No hay PCM suficiente todavía
                    continue

                feed_data = bytes(pcm_acumulado)
                pcm_acumulado.clear()
                ultimo_feed_ms = now_ms

                # Calcular RMS del feed para diagnóstico
                try:
                    import array as _arr
                    _arrh = _arr.array('h')
                    _arrh.frombytes(feed_data)
                    if len(_arrh) > 0:
                        _s = 0
                        for _v in _arrh:
                            _s += (_v*_v)
                        feed_rms = (_s / len(_arrh)) ** 0.5 / 32768.0
                    else:
                        feed_rms = 0.0
                except Exception:
                    feed_rms = None

                # Log de alimentación al recognizer (cada ~10 feeds) y diagnóstico cada ~10
                try:
                    if (audio_chunks_received % 10) == 0:
                        logger.info("Feed al recognizer", extra={'evento': 'feed_pcm', 'client_id': client_id, 'feed_bytes': len(feed_data), 'rms': feed_rms})
                        # Enviar diagnóstico ligero al cliente (no bloqueante)
                        try:
                            await websocket.send(json.dumps({
                                'type': 'diag',
                                'feed_bytes': len(feed_data),
                                'chunks': audio_chunks_received,
                                'rms': feed_rms
                            }))
                        except Exception:
                            pass
                except Exception:
                    pass

                # 3) Alimentar ambos recognizers con PCM
                cmd_is_final = recognizer_cmd.AcceptWaveform(feed_data)
                if cmd_is_final:
                    try:
                        cmd_result = json.loads(recognizer_cmd.Result())
                        cmd_text = cmd_result.get('text', '')
                        if cmd_text:
                            logger.info(f"Comando candidato (final): '{cmd_text}'", extra={'evento': 'cmd_candidate_final', 'client_id': client_id, 'text': cmd_text})
                            await maybe_send_command(cmd_text)
                    except Exception as e:
                        logger.error(f"Error procesando comando final: {e}")
                # DESHABILITADO: No detectar comandos en parciales (muy propenso a falsos positivos)
                # else:
                #     try:
                #         cmd_partial = json.loads(recognizer_cmd.PartialResult())
                #         if cmd_partial.get('partial'):
                #             await maybe_send_command(cmd_partial.get('partial', ''))
                #     except Exception:
                #         pass

                if recognizer.AcceptWaveform(feed_data):
                    # Resultado final (cuando detecta pausa o frase completa)
                    result = json.loads(recognizer.Result())
                    if result.get('text'):
                        logger.info("Transcripcion final", extra={'evento': 'final', 'client_id': client_id, 'usuario_id': usuario_id})
                        await websocket.send(json.dumps({
                            'type': 'final',
                            'text': result['text'],
                            'words': result.get('result', [])
                        }))
                else:
                    # Resultado parcial (mientras habla)
                    partial = json.loads(recognizer.PartialResult())
                    partial_text = partial.get('partial', '')
                    if partial_text:
                        # LOG: Mostrar resultados parciales (cada 10 para no saturar)
                        if audio_chunks_received % 10 == 0:
                            logger.info("Transcripcion parcial", extra={'evento': 'parcial', 'client_id': client_id, 'usuario_id': usuario_id, 'preview': partial_text[:40]})

                        # Emitir palabra incremental si hay un nuevo token desde 'partial'
                        try:
                            tokens = [t for t in partial_text.strip().split(' ') if t]
                            if len(tokens) > last_partial_token_count:
                                new_token = tokens[-1]
                                # Emitir incluso palabras de 1 letra si son alfabéticas (p. ej., "y")
                                if new_token and __import__('re').match(r'^[a-zA-ZáéíóúñÑüÜ]+$', new_token):
                                    await websocket.send(json.dumps({
                                        'type': 'word',
                                        'text': new_token
                                    }))
                                last_partial_token_count = len(tokens)
                                last_partial_text = partial_text
                            elif len(tokens) < last_partial_token_count:
                                # El motor reajustó la hipótesis; actualizamos el contador
                                last_partial_token_count = len(tokens)
                                last_partial_text = partial_text
                        except Exception:
                            pass

                    # También usar 'partial_result' (si SetPartialWords(True)) para detectar palabras cortas
                    try:
                        pr = partial.get('partial_result') or []
                        if isinstance(pr, list):
                            if len(pr) > last_partial_words_count:
                                # Emitir cualquier palabra nueva agregada al final
                                new_items = pr[last_partial_words_count:]
                                for w in new_items:
                                    wtext = w.get('word') if isinstance(w, dict) else None
                                    if wtext and __import__('re').match(r'^[a-zA-ZáéíóúñÑüÜ]+$', wtext):
                                        now_ms = _now_ms()
                                        if (now_ms - last_word_sent_ms) >= WORD_THROTTLE_MS:
                                            await websocket.send(json.dumps({
                                                'type': 'word',
                                                'text': wtext
                                            }))
                                            last_word_sent_ms = now_ms
                                last_partial_words_count = len(pr)
                                # Actualizar lista completa de palabras parciales actuales (para fallback)
                                try:
                                    last_partial_words_list = [
                                        (w.get('word') if isinstance(w, dict) else None)
                                        for w in pr
                                    ]
                                    last_partial_words_list = [w for w in last_partial_words_list if isinstance(w, str)]
                                except Exception:
                                    pass
                            elif len(pr) < last_partial_words_count:
                                # Hipótesis reajustada
                                last_partial_words_count = len(pr)
                                try:
                                    last_partial_words_list = [
                                        (w.get('word') if isinstance(w, dict) else None)
                                        for w in pr
                                    ]
                                    last_partial_words_list = [w for w in last_partial_words_list if isinstance(w, str)]
                                except Exception:
                                    pass
                    except Exception:
                        pass

                    # Enviar resultado parcial al cliente (incluyendo texto actual si lo hay)
                    await websocket.send(json.dumps({
                        'type': 'partial',
                        'text': partial_text or ''
                    }))
                
                # Métricas de entrada: tamaño de chunk y acumulado
                try:
                    bytes_len = len(message)
                    bytes_acumulados += bytes_len
                    # Logear cada 50 chunks el tamaño y acumulado
                    if audio_chunks_received % 50 == 0:
                        logger.info("Chunk audio recibido", extra={'evento': 'audio_chunk', 'client_id': client_id, 'chunks': audio_chunks_received, 'bytes': bytes_len, 'bytes_total': bytes_acumulados})
                except Exception:
                    pass
            
    except websockets.exceptions.ConnectionClosed:
        logger.info("Cliente desconectado", extra={'evento': 'cliente_desconectado', 'client_id': client_id, 'chunks': audio_chunks_received, 'usuario_id': usuario_id})
    except Exception as e:
        logger.error(f"Error procesando audio: {e}", extra={'evento': 'error_audio', 'client_id': client_id, 'usuario_id': usuario_id}, exc_info=True)
        await websocket.send(json.dumps({
            'type': 'error',
            'message': str(e)
        }))
    finally:
        # Cerrar pipeline ffmpeg si estaba activo
        try:
            if ffmpeg_proc:
                if ffmpeg_proc.stdin:
                    try:
                        ffmpeg_proc.stdin.close()
                    except Exception:
                        pass
                if ffmpeg_reader_task:
                    try:
                        ffmpeg_reader_task.cancel()
                    except Exception:
                        pass
                try:
                    await asyncio.wait_for(ffmpeg_proc.wait(), timeout=1.0)
                except Exception:
                    try:
                        ffmpeg_proc.kill()
                    except Exception:
                        pass
        except Exception:
            pass
        if usuario_id:
            estado_final = _capturar_estado(recognizer)
            if estado_final:
                estado_serializado_actual = estado_final
                await _persistir_estado_usuario(usuario_id, estado_final)
                logger.info("Estado de adaptación persistido", extra={'evento': 'estado_persistido', 'usuario_id': usuario_id})


async def handle_health(request):
    return web.json_response({"status": "ok", "model_path": VOSK_MODEL_PATH})

async def handle_adaptation_status(request):
    usuario_id = request.query.get('usuario_id')
    if not usuario_id:
        return web.json_response({'success': False, 'error': 'usuario_id requerido'}, status=400)
    estado = await asyncio.to_thread(_cargar_estado_sync, int(usuario_id))
    return web.json_response({'success': True, 'usuario_id': usuario_id, 'estado_aplicado': bool(estado), 'tam_estado': len(estado or '')})

async def handle_train_muestra(request):
    """Endpoint HTTP para registrar una muestra de entrenamiento directamente en el contenedor Vosk.

    Acepta multipart/form-data o JSON con:
      - usuario_id (int)
      - comando (clave interna: iniciar_proceso | detener_proceso | guardar_pieza)
      - audio (archivo .webm / .wav) o audio_b64 (string base64, opcional 'data:...' prefix)

    Flujo:
      1. Validar usuario y comando.
      2. Cargar estado de adaptación previo y aplicarlo al reconocedor.
      3. Transcodificar a PCM mono 16k.
      4. Alimentar reconocedor y validar que la frase concuerda con el comando objetivo.
      5. Capturar nuevo estado y persistirlo + actualizar conteos.
    """
    try:
        if request.content_type.startswith('multipart/'):
            data = await request.post()
            usuario_id = (data.get('usuario_id') or '').strip()
            comando = (data.get('comando') or '').strip().lower()
            audio_file = data.get('audio')
            audio_b64 = None
        else:
            body = await request.text()
            try:
                j = json.loads(body)
            except json.JSONDecodeError:
                return web.json_response({'success': False, 'error': 'JSON inválido'}, status=400)
            usuario_id = str(j.get('usuario_id') or '').strip()
            comando = str(j.get('comando') or '').strip().lower()
            audio_b64 = j.get('audio_b64')
            audio_file = None

        if not usuario_id.isdigit():
            return web.json_response({'success': False, 'error': 'usuario_id inválido'}, status=400)
        usuario_id_int = int(usuario_id)
        if comando not in COMANDOS_ENTRENAMIENTO:
            return web.json_response({'success': False, 'error': 'Comando inválido'}, status=400)
        if not audio_file and not audio_b64:
            return web.json_response({'success': False, 'error': 'Audio requerido'}, status=400)

        # Preparar archivo temporal de entrada
        tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
        try:
            if audio_file:
                # Leer en bloques
                if hasattr(audio_file, 'file'):
                    tmp_in.write(audio_file.file.read())
                else:
                    tmp_in.write(audio_file.read())
            else:
                raw_b64 = audio_b64
                if raw_b64.startswith('data:'):
                    # Remover encabezado data URI
                    raw_b64 = raw_b64.split(',', 1)[-1]
                try:
                    tmp_in.write(base64.b64decode(raw_b64))
                except Exception:
                    return web.json_response({'success': False, 'error': 'Base64 de audio inválido'}, status=400)
            tmp_in.flush()
        finally:
            tmp_in.close()

        # Transcodificar a WAV mono 16k
        tmp_wav = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
        tmp_wav.close()
        cmd = [
            'ffmpeg', '-y', '-i', tmp_in.name,
            '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'wav', tmp_wav.name
        ]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        except subprocess.CalledProcessError as e:
            os.unlink(tmp_in.name)
            os.unlink(tmp_wav.name)
            return web.json_response({'success': False, 'error': f'ffmpeg falló: {e}'}, status=500)

        # Cargar PCM
        try:
            with contextlib.closing(wave.open(tmp_wav.name, 'rb')) as wf:
                if wf.getframerate() != SAMPLE_RATE:
                    raise ValueError('Frecuencia incorrecta tras transcodificación')
                if wf.getnchannels() != 1:
                    raise ValueError('Audio debe ser mono')
                frames = wf.readframes(wf.getnframes())
        except Exception as e:
            os.unlink(tmp_in.name)
            os.unlink(tmp_wav.name)
            return web.json_response({'success': False, 'error': f'No se pudo leer WAV: {e}'}, status=400)

        # Reconocedor con gramática restringida a frases del comando objetivo (para forcing)
        grammar = json.dumps(COMANDOS_ENTRENAMIENTO[comando])
        recognizer_train = KaldiRecognizer(model, SAMPLE_RATE, grammar)
        recognizer_train.SetWords(True)

        # Aplicar adaptación previa
        estado_prev = await asyncio.to_thread(_cargar_estado_sync, usuario_id_int)
        if estado_prev:
            _aplicar_estado(recognizer_train, estado_prev)

        recognizer_train.AcceptWaveform(frames)
        resultado_json = {}
        try:
            resultado_json = json.loads(recognizer_train.Result() or '{}')
        except Exception:
            resultado_json = {}
        texto_reconocido = resultado_json.get('text', '').strip()
        comando_detectado = _comando_desde_texto(texto_reconocido)
        if comando_detectado != comando:
            os.unlink(tmp_in.name)
            os.unlink(tmp_wav.name)
            return web.json_response({
                'success': False,
                'error': 'La frase no coincide con el comando esperado',
                'transcripcion': texto_reconocido
            }, status=409)

        # Capturar nuevo estado y persistirlo
        nuevo_estado = _capturar_estado(recognizer_train)
        if nuevo_estado:
            await _persistir_estado_usuario(usuario_id_int, nuevo_estado)

        # Actualizar conteos en DB
        from django.db import transaction
        from django.contrib.auth import get_user_model
        from parts.models import PerfilVozUsuario
        UsuarioLocal = get_user_model()
        try:
            usuario_obj = UsuarioLocal.objects.get(pk=usuario_id_int)
        except UsuarioLocal.DoesNotExist:
            os.unlink(tmp_in.name)
            os.unlink(tmp_wav.name)
            return web.json_response({'success': False, 'error': 'Usuario no encontrado'}, status=404)
        with transaction.atomic():
            perfil, _ = PerfilVozUsuario.objects.select_for_update().get_or_create(usuario=usuario_obj)
            conteo = perfil.conteo_por_comando or {}
            conteo[comando] = int(conteo.get(comando, 0)) + 1
            perfil.conteo_por_comando = conteo
            perfil.muestras_totales = int(perfil.muestras_totales or 0) + 1
            if nuevo_estado:
                perfil.estado_adaptacion = nuevo_estado
            perfil.save()

        os.unlink(tmp_in.name)
        os.unlink(tmp_wav.name)
        return web.json_response({
            'success': True,
            'usuario_id': usuario_id_int,
            'comando': comando,
            'transcripcion': texto_reconocido,
            'conteo': conteo,
            'tam_estado': len(nuevo_estado or ''),
            'estado_aplicado': bool(nuevo_estado)
        })
    except Exception as e:
        logger.error(f"Error en entrenamiento dentro de contenedor Vosk: {e}", extra={'evento': 'error_entrenamiento'}, exc_info=True)
        return web.json_response({'success': False, 'error': str(e)}, status=500)

async def start_servers():
    logger.info("Iniciando servidor WebSocket", extra={'evento': 'inicio_ws', 'model_path': VOSK_MODEL_PATH})
    ws_server = websockets.serve(
        process_audio_stream,
        "0.0.0.0",
        WEBSOCKET_PORT,
        ping_interval=20,
        ping_timeout=20,
        max_size=10 * 1024 * 1024
    )
    await ws_server
    logger.info("WebSocket listo", extra={'evento': 'ws_listo'})

    # HTTP app para endpoints ligeros (diagnóstico / adaptación)
    app = web.Application()
    app.router.add_get('/health', handle_health)
    app.router.add_get('/adaptation-status', handle_adaptation_status)
    app.router.add_post('/train-muestra', handle_train_muestra)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8770)
    await site.start()
    logger.info("HTTP listo", extra={'evento': 'http_listo'})
    # Mantener procesos vivos
    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(start_servers())
