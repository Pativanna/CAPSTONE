from django.http import JsonResponse
import logging
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from django.contrib.auth.decorators import login_required
import base64
import contextlib
import json
import time
import os
import re
import tempfile
import wave
from pathlib import Path
from threading import Lock

from openai import OpenAI
from openai import APIConnectionError, APITimeoutError
import requests
try:
    from vosk import Model, KaldiRecognizer
except ImportError:  # pragma: no cover - entorno sin Vosk instalado
    Model = None
    KaldiRecognizer = None
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .voice_logger import voice_logger
# Fallbacks de extracción (Ollama y heurística local)
try:
    from .views import _extract_with_ollama, extract_vehicle_info_local
except Exception:
    _extract_with_ollama = None
    extract_vehicle_info_local = None
logger = logging.getLogger('parts.voice')
from .voice_ingest_service import (
    record_session_activity,
    close_session as close_session_db,
    save_ingest_result,
)
from parts.text_normalization import normalize_transcript
from .audio_preprocessing import transcode_webm_bytes_to_clean_wav
from .models import (
    VoiceTranscription,
    VoiceSession,
    VoiceIngestResult,
)
from parts.utils.permissions import ensure_voice_ingest_permission
from .voice_commands import match_strict_command, normalize_command_text, STRICT_COMMAND_PHRASES


VOSK_SAMPLE_RATE = 16000
OPENAI_TIMEOUT_SECONDS = int(getattr(settings, 'OPENAI_TIMEOUT_SECONDS', 60))
OPENAI_MAX_RETRIES = max(1, int(getattr(settings, 'OPENAI_MAX_RETRIES', 2)))
_modelo_vosk = None
_bloqueo_modelo = Lock()

# Palabras a remover al limpiar transcripciones
COMANDOS_CONTROL = [phrase for phrase, _ in STRICT_COMMAND_PHRASES]

def obtener_modelo_vosk():
    if Model is None:
        raise RuntimeError('Vosk no está disponible en el entorno actual')
    global _modelo_vosk
    if _modelo_vosk is not None:
        return _modelo_vosk
    with _bloqueo_modelo:
        if _modelo_vosk is None:
            ruta_modelo = getattr(settings, 'VOSK_MODEL_PATH', os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42'))
            _modelo_vosk = Model(ruta_modelo)
    return _modelo_vosk


def vosk_operativo():
    """Indica si el entorno puede realizar adaptación con Vosk.
    No carga el modelo (para evitar latencia), solo verifica disponibilidad básica.
    """
    try:
        if KaldiRecognizer is None:
            return False
        ruta_modelo = getattr(settings, 'VOSK_MODEL_PATH', os.getenv('VOSK_MODEL_PATH', '/app/vosk-models/vosk-model-es-0.42'))
        return os.path.isdir(ruta_modelo)
    except Exception:
        return False


def serializar_estado_adaptacion(estado):
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


def deserializar_estado_adaptacion(valor):
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


def aplicar_estado_en_reconocedor(reconocedor, estado_serializado):
    if not estado_serializado:
        logger.debug("[ADAPTACION] No hay estado serializado para aplicar")
        return False
    
    if not hasattr(reconocedor, 'SetAdaptationState'):
        logger.warning("[ADAPTACION] Reconocedor no tiene método SetAdaptationState")
        return False
    
    estado = deserializar_estado_adaptacion(estado_serializado)
    if estado is None:
        logger.warning("[ADAPTACION] No se pudo deserializar el estado")
        return False
    
    logger.debug(f"[ADAPTACION] Intentando aplicar estado - Tipo: {type(estado)}, Tamaño: {len(estado) if hasattr(estado, '__len__') else 'N/A'}")
    
    try:
        reconocedor.SetAdaptationState(estado)
        logger.info("[ADAPTACION] Estado aplicado exitosamente")
        return True
    except TypeError:
        if isinstance(estado, (bytes, bytearray)):
            try:
                reconocedor.SetAdaptationState(estado.decode('utf-8'))
                logger.info("[ADAPTACION] Estado aplicado exitosamente (decodificado)")
                return True
            except Exception as e:
                logger.error(f"[ADAPTACION] Error al aplicar estado decodificado: {e}")
                return False
        logger.error(f"[ADAPTACION] TypeError al aplicar estado: tipo={type(estado)}")
        return False
    except Exception as e:
        logger.error(f"[ADAPTACION] Error al aplicar estado: {e}")
        return False


def capturar_estado_de_reconocedor(reconocedor):
    """
    Captura el estado de adaptación del reconocedor Vosk.
    
    NOTA: El modelo vosk-model-es-0.42 NO soporta adaptación de speaker.
    Los métodos GetAdaptationState/SetAdaptationState no están disponibles en modelos pequeños.
    Para habilitar adaptación real, se necesita un modelo con soporte de speaker adaptation
    como vosk-model-large-es o modelos entrenados específicamente con esta funcionalidad.
    """
    if not hasattr(reconocedor, 'GetAdaptationState'):
        logger.debug("[ADAPTACION] Reconocedor no tiene método GetAdaptationState - Modelo sin soporte de adaptación")
        return ''
    try:
        logger.debug("[ADAPTACION] Intentando capturar estado con GetAdaptationState()")
        estado = reconocedor.GetAdaptationState()
        logger.debug(f"[ADAPTACION] Estado capturado - Tipo: {type(estado)}, Tamaño: {len(estado) if estado else 0}")
    except Exception as e:
        logger.error(f"[ADAPTACION] Error al capturar estado: {e}")
        return ''
    
    estado_serializado = serializar_estado_adaptacion(estado)
    logger.debug(f"[ADAPTACION] Estado serializado - Tamaño: {len(estado_serializado)}")
    return estado_serializado


def _texto_normalizado(texto):
    if not texto:
        return ''
    return ' '.join(str(texto).lower().split())


def _transcribir_audio_corto_vosk(audio_path: str, sample_rate: int = VOSK_SAMPLE_RATE) -> str:
    """Transcribe un fragmento breve usando Vosk directamente desde un archivo WAV."""
    if KaldiRecognizer is None:
        raise RuntimeError('Vosk no está disponible en el servidor')
    modelo = obtener_modelo_vosk()
    if modelo is None:
        raise RuntimeError('No se pudo cargar el modelo de Vosk')

    recognizer = KaldiRecognizer(modelo, sample_rate)
    recognizer.SetWords(True)

    with wave.open(audio_path, 'rb') as wf:
        if wf.getnchannels() != 1 or wf.getframerate() != sample_rate:
            raise RuntimeError('Formato de audio inválido para Vosk (se espera mono 16 kHz)')
        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            recognizer.AcceptWaveform(data)

    resultado = recognizer.FinalResult() or ''
    try:
        data = json.loads(resultado)
        texto = (data.get('text') or '').strip()
    except Exception:
        texto = resultado.strip()
    return texto


def _digits_only(value) -> str:
    if value is None:
        return ''
    return ''.join(ch for ch in str(value) if ch.isdigit())


def _sanitize_extracted_fields(payload: dict | None) -> dict:
    fields = {
        'parte': '',
        'valor': '',
        'min_value': '',
        'detalles': ''
    }
    if not isinstance(payload, dict):
        return fields
    raw_detalles = (payload.get('detalles') or '').strip()
    raw_parte = (payload.get('parte') or '').strip()
    if raw_detalles:
        parte_lower = raw_parte.lower()
        detalles_lower = raw_detalles.lower()
        idx = parte_lower.find(detalles_lower)
        if idx != -1:
            raw_parte = raw_parte[:idx].rstrip(', .-')
    parte_clean = normalize_transcript(raw_parte).lower()
    if not parte_clean and raw_detalles:
        parte_clean = normalize_transcript(raw_detalles).lower()
    fields['parte'] = parte_clean
    fields['valor'] = _digits_only(payload.get('valor'))
    fields['min_value'] = _digits_only(payload.get('min_value'))
    fields['detalles'] = normalize_transcript(raw_detalles)
    return fields


@login_required
@csrf_protect
@require_http_methods(["POST"])
def extract_from_transcript(request):
    """
    Extrae datos estructurados de un texto transcrito usando GPT-4
    (Ya no necesitamos Whisper porque Vosk ya hizo la transcripción)
    """
    ensure_voice_ingest_permission(request.user)
    try:
        # Leer JSON del body (no POST form data)
        body = json.loads(request.body)
        transcript = body.get('transcript', '').strip()

        if not transcript:
            return JsonResponse({
                'success': False,
                'error': 'No se recibió ningún texto'
            }, status=400)

        logger.info("transcripcion_recibida", extra={'event': 'transcript_received', 'len': len(transcript)})

        # Aplicar limpieza ROBUSTA de transcripción Vosk
        from parts.text_normalization import limpiar_transcripcion_vosk_robusta
        transcript_original = transcript
        transcript = limpiar_transcripcion_vosk_robusta(transcript)
        
        logger.info("transcripcion_limpiada", extra={
            'event': 'transcript_cleaned',
            'original_len': len(transcript_original),
            'cleaned_len': len(transcript),
            'original': transcript_original[:100],
            'cleaned': transcript[:100]
        })
        
        # Prompt optimizado y ROBUSTO para manejar transcripciones con repeticiones
        system_prompt = """Eres un especialista en inventario de repuestos automotrices en español chileno. Recibirás transcripciones de voz ruidosas (repeticiones, palabras truncadas, comandos). Debes extraer SOLO la información final y confirmada para registrar la pieza.

CONSIDERA:
- El usuario describe piezas de autos (parachoques, guardafangos, puertas, ruedas, etc.) y puede corregirse sobre la marcha.
- Los comandos "Iniciar ingreso", "Detener ingreso", "Cancelar ingreso", "Confirmar ingreso" o "Repetir ingreso" NO deben formar parte de los datos.
- Si la frase repite partes de forma incremental ("rueda... rueda delantera... rueda delantera derecha"), quédate con la versión más completa (rueda delantera derecha).
- Corrige errores comunes de reconocimiento: "huevo"→"nuevo", "del antero"→"delantero", "cerezo"→"pesos", "parachoques"→"parachoque".

CAMPOS A ENTREGAR (JSON estricto):
{
  "parte": "Nombre completo de la pieza con posición/lado (ej: parachoque delantero, puerta trasera izquierda)",
  "valor": "Último precio general mencionado (no descuento). Solo dígitos, sin símbolos ni palabras. Ej: 'ciento veinte mil' → 120000. Si no existe, usar \"\".",
  "min_value": "Último precio mencionado como oferta/último precio/descuento. Si nunca se mencionó, usar \"\".",
  "detalles": "Estado o notas sobre la pieza (ej: perfecto estado, con rayones, nuevo). No incluir comandos ni repetir el nombre."
}

REGLAS ESTRICTAS:
1. No inventes datos ni agregues colores/modelos. Es mejor devolver "".
2. Si hay múltiples valores para una categoría, conserva SOLO el último que se dijo.
3. Chile trabaja con enteros: elimina puntos, comas o palabras como "mil". No incluyas "$" ni "pesos".
4. Si el usuario menciona "rebajado a", "último precio", "oferta", ese valor va en "min_value".
5. Detalles solo describe estado/condición; no repite la parte ni incluye precios.
6. Responde exclusivamente con JSON válido, sin markdown ni explicaciones extras.

EJEMPLOS RAPIDOS:
Entrada: "la rueda la rueda delantera derecha en perfecto estado"
Salida: {"parte":"rueda delantera derecha","valor":"","min_value":"","detalles":"perfecto estado"}

Entrada: "parachoque delantero con rayones vale cien mil pesos rebajado a noventa mil"
Salida: {"parte":"parachoque delantero","valor":"100000","min_value":"90000","detalles":"con rayones"}

Entrada: "capó del yaris buen estado ciento veinte mil detener"
Salida: {"parte":"capó","valor":"120000","min_value":"","detalles":"buen estado"}
"""
        
        use_cloud = body.get('use_cloud', True)
        openai_key = getattr(settings, 'OPENAI_API_KEY', None)
        should_use_openai = bool(openai_key) and bool(use_cloud)
        data = None

        if should_use_openai:
            from parts.utils.openai_logger import registrar_llamada
            inicio = time.monotonic()
            tokens_p = tokens_c = None
            request_id = ''
            codigo_http = 200
            try:
                client = OpenAI(api_key=openai_key)
                response = client.chat.completions.create(
                    model="gpt-4",
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Descripción de voz: {transcript}"}
                    ],
                    temperature=0.2,
                    max_tokens=800
                )
                extracted_json = response.choices[0].message.content.strip()
                usage = getattr(response, 'usage', None)
                if usage:
                    tokens_p = getattr(usage, 'prompt_tokens', None)
                    tokens_c = getattr(usage, 'completion_tokens', None)
                request_id = getattr(response, 'id', '') or ''

                if extracted_json.startswith('```'):
                    extracted_json = extracted_json.split('```')[1]
                    if extracted_json.startswith('json'):
                        extracted_json = extracted_json[4:]
                    extracted_json = extracted_json.strip()

                if not extracted_json.strip().startswith('{'):
                    import re as _re
                    m = _re.search(r"\{[\s\S]*\}", extracted_json)
                    if m:
                        extracted_json = m.group(0)

                data = json.loads(extracted_json)
                registrar_llamada(
                    tipo='chat', modelo='gpt-4', inicio_monotonic=inicio, ok=True, codigo_http=codigo_http,
                    error_texto='', tokens_prompt=tokens_p, tokens_respuesta=tokens_c,
                    prompt_texto_para_hash=transcript, origen='vosk_views.extract_from_transcript', request_id=request_id,
                    meta={'modo': 'campos'}
                )
                logger.info("extraccion_campos", extra={'event': 'extraction_fields', 'backend': 'OpenAI'})
            except Exception as e:
                registrar_llamada(
                    tipo='chat', modelo='gpt-4', inicio_monotonic=inicio, ok=False, codigo_http=500,
                    error_texto=str(e), tokens_prompt=tokens_p, tokens_respuesta=tokens_c,
                    prompt_texto_para_hash=transcript, origen='vosk_views.extract_from_transcript', request_id=request_id,
                    meta={'modo': 'campos'}
                )
                logger.warning("Fallo extracción con OpenAI, usando fallback", exc_info=True)
                data = None

        if data is None:
            fallback_payload = None
            if not use_cloud and _extract_with_ollama:
                with contextlib.suppress(Exception):
                    fallback_payload = _extract_with_ollama(transcript)
            if not fallback_payload and extract_vehicle_info_local:
                with contextlib.suppress(Exception):
                    fallback_payload = extract_vehicle_info_local(transcript)
            if not fallback_payload:
                fallback_payload = {
                    "parte": transcript[:120],
                    "valor": "",
                    "min_value": "",
                    "detalles": ""
                }
            data = fallback_payload
            logger.info("extraccion_campos", extra={'event': 'extraction_fields', 'backend': 'fallback'})

        cleaned_fields = _sanitize_extracted_fields(data)
        return JsonResponse({
            'success': True,
            'fields': cleaned_fields,
            'transcript': transcript,
            'transcript_original': transcript_original
        })
        
    except json.JSONDecodeError as e:
        logger.error("error_parse_json_gpt", extra={'event': 'json_parse_error', 'error': str(e)})
        return JsonResponse({
            'success': False,
            'error': f'Error parseando respuesta de GPT-4: {str(e)}'
        }, status=500)
        
    except Exception as e:
        logger.error("error_extraccion_campos", extra={'event': 'extraction_error', 'error': str(e)})
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def log_transcription(request):
    """
    Endpoint para logging continuo de transcripciones
    Guarda TODAS las transcripciones parciales y finales en tiempo real
    Detecta comandos "Iniciar ingreso" y "Detener ingreso" para marcar is_capturing
    """
    ensure_voice_ingest_permission(request.user)
    try:
        if not getattr(settings, 'VOICE_TRANSCRIPCION_VOSK_ACTIVA', False):
            logger.info("log_transcription_ignorado", extra={'event': 'transcription_disabled'})
            return JsonResponse({
                'success': True,
                'disabled': True,
                'message': 'Transcripción Vosk deshabilitada'
            })

        body = json.loads(request.body)
        text = body.get('text', '').strip()
        transcription_type = body.get('type', 'partial')  # 'partial' o 'final'
        metadata = body.get('metadata', {})
        session_id_from_client = body.get('session_id')  # NUEVO: session_id explícito del cliente
        
        if not text:
            return JsonResponse({
                'success': False,
                'error': 'No se recibió texto'
            }, status=400)
        
        # Registrar en el log (JSONL continuo)
        log_entry = voice_logger.log_transcription(
            text=text,
            transcription_type=transcription_type,
            metadata=metadata
        )

        # Obtener session_id: priorizar el del cliente, fallback al del logger
        sid = session_id_from_client if session_id_from_client else voice_logger.get_current_session_id()
        
        cmd_detected, phrase_detected = match_strict_command(text, allow_partial=True)
        is_start_command = cmd_detected == 'iniciar_proceso'
        is_end_command = cmd_detected == 'finalizar_proceso'
        is_confirm_command = cmd_detected == 'confirmar_datos'
        
        # NUEVO: Si el cliente envía isCapturing en metadata, usarlo (tiene prioridad)
        client_is_capturing = metadata.get('isCapturing') if metadata else None
        
        # Obtener estado actual de captura de la sesión
        from .models import VoiceSession, VoiceTranscription
        from django.utils import timezone
        from datetime import timedelta
        is_capturing = False
        try:
            session_obj, _ = VoiceSession.objects.get_or_create(
                session_id=sid,
                defaults={'status': VoiceSession.Status.ACTIVE}
            )
            
            # PRIORIDAD 1: Si el cliente envía isCapturing explícitamente, usarlo
            if client_is_capturing is not None:
                is_capturing = client_is_capturing
                logger.info(f"Usando is_capturing del cliente: {is_capturing} para sesión {sid}")
            # PRIORIDAD 2: Actualizar estado según comandos ANTES de guardar la transcripción
            elif is_start_command and session_obj.estado_grabacion in [VoiceSession.EstadoGrabacion.INACTIVO, VoiceSession.EstadoGrabacion.FINALIZADO]:
                session_obj.is_capturing = True
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.INICIADO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
                logger.info(f"Captura iniciada para sesión {sid}")
                is_capturing = True  # Esta transcripción ya es parte del proceso
                
                # NUEVO: Retroactivar transcripciones recientes (últimos 5 segundos)
                # Esto captura contenido que llegó justo antes/durante la detección del comando
                tiempo_buffer = timezone.now() - timedelta(seconds=5)
                VoiceTranscription.objects.filter(
                    session_id=sid,
                    is_capturing=False,
                    timestamp__gte=tiempo_buffer
                ).update(is_capturing=True)
                logger.info(f"Retroactivadas transcripciones recientes de sesión {sid}")
                
            elif is_end_command and session_obj.estado_grabacion == VoiceSession.EstadoGrabacion.INICIADO:
                # Guardar esta transcripción todavía con is_capturing=True
                is_capturing = True
                session_obj.is_capturing = False
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.FINALIZADO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
                logger.info(f"Captura finalizada para sesión {sid}; esperando confirmación")
            elif is_confirm_command and session_obj.estado_grabacion == VoiceSession.EstadoGrabacion.FINALIZADO:
                # Fase de confirmación: ya no se captura más texto, marcamos esperando_confirmación -> luego retorno a inactivo
                is_capturing = False
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.ESPERANDO_CONFIRMACION
                session_obj.save(update_fields=['estado_grabacion'])
                logger.info(f"Sesión {sid} en estado ESPERANDO_CONFIRMACION")
            elif session_obj.estado_grabacion == VoiceSession.EstadoGrabacion.ESPERANDO_CONFIRMACION:
                # Ignorar transcripciones adicionales hasta nueva orden de iniciar
                is_capturing = False
            elif session_obj.estado_grabacion == VoiceSession.EstadoGrabacion.INICIADO:
                is_capturing = True
            else:
                is_capturing = False
        except Exception as e_session:
            logger.warning(f"error_actualizar_capturing_state: {e_session}")

        # NUEVO: Guardar también en base de datos con estado is_capturing
        try:
            VoiceTranscription.objects.create(
                session_id=sid,
                text=text,
                type=transcription_type,
                metadata=metadata,
                is_capturing=is_capturing
            )
        except Exception as e_db:
            logger.warning("error_guardando_transcription_bd", extra={'event':'db_save_error','error':str(e_db)})

        # Actualizar/crear sesión en BD y contadores
        try:
            record_session_activity(
                sid,
                partial_inc=1 if transcription_type == 'partial' else 0,
                final_inc=1 if transcription_type == 'final' else 0,
                meta={'last_timestamp': log_entry.get('timestamp_unix')}
            )
        except Exception as _e_db:
            logger.warning("error_actualizar_voice_session", extra={'event':'session_update_error','error':str(_e_db)})

        # DESHABILITADO TEMPORALMENTE: Sistema de archivos .txt para watchdog
        # Se usa solo sistema de comandos por voz en tiempo real
        """
        # Además: mantener transcripción EN TIEMPO REAL basada en parciales y finales
        # - transcript_full_{session}.txt acumula SOLO finales (histórico consolidado)
        # - transcript_{session}.txt refleja full + el parcial actual (snapshot vivo para watchdog)
        try:
            session_id = voice_logger.get_current_session_id()
            transcripts_dir = Path(settings.BASE_DIR) / 'voice_logs'
            transcripts_dir.mkdir(exist_ok=True)
            transcript_path = transcripts_dir / f'transcript_{session_id}.txt'
            transcript_full_path = transcripts_dir / f'transcript_full_{session_id}.txt'

            def _normalize_concat(a: str, b: str) -> str:
                a = (a or '').strip()
                b = (b or '').strip()
                if not a:
                    return b
                if not b:
                    return a
                # Unir con un único espacio y colapsar dobles
                return (a + ' ' + b).replace('  ', ' ').strip()

            # Leer el FULL actual (solo finales consolidados)
            full_text = ''
            if transcript_full_path.exists():
                try:
                    full_text = transcript_full_path.read_text(encoding='utf-8')
                except Exception:
                    full_text = ''

            def _atomic_write(path: Path, content: str):
                tmp = path.with_suffix(path.suffix + '.tmp')
                tmp.write_text(content, encoding='utf-8')
                # rename es atómico en Linux, evita lecturas intermedias del watchdog
                tmp.replace(path)

            if transcription_type == 'final':
                # Acumular FINAL al histórico completo
                new_full = _normalize_concat(full_text, text)
                _atomic_write(transcript_full_path, new_full)
                # Snapshot vivo = exactamente lo full consolidado tras el final
                _atomic_write(transcript_path, new_full)
            else:
                # Snapshot vivo = FULL + PARCIAL actual (reemplaza el temporal anterior)
                live_text = _normalize_concat(full_text, text)
                _atomic_write(transcript_path, live_text)
        except Exception as e2:
            logger.warning("error_actualizando_transcript_txt", extra={'event':'transcript_txt_error','error':str(e2)})
        """
        
        return JsonResponse({
            'success': True,
            'session_id': voice_logger.get_current_session_id(),
            'timestamp': log_entry['timestamp']
        })
        
    except Exception as e:
        logger.error("error_log_transcription", extra={'event':'log_transcription_error','error':str(e)})
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def log_command(request):
    """
    Endpoint para registrar comandos de voz detectados
    """
    ensure_voice_ingest_permission(request.user)
    try:
        body = json.loads(request.body)
        command = body.get('command', '')
        text = body.get('text', '')
        session_id_from_client = body.get('session_id')
        
        if not command:
            return JsonResponse({
                'success': False,
                'error': 'No se especificó comando'
            }, status=400)
        
        # Registrar comando en el log JSONL
        log_entry = voice_logger.log_command(
            command_name=command,
            command_text=text
        )

        # Persistir comando en BD y actualizar estado de sesión
        try:
            sid = session_id_from_client or voice_logger.get_current_session_id()
            from .models import VoiceSession, VoiceTranscription
            from django.utils import timezone
            from datetime import timedelta

            session_obj, _ = VoiceSession.objects.get_or_create(
                session_id=sid,
                defaults={'status': VoiceSession.Status.ACTIVE}
            )

            # Crear transcripción tipo 'command'
            VoiceTranscription.objects.create(
                session_id=sid,
                text=text or command,
                type='command',
                metadata={'command': command, 'source': 'client'}
            )

            # Transiciones de estado
            if command == 'iniciar_proceso':
                session_obj.is_capturing = True
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.INICIADO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
                # Retroactivar últimos 5s como capturados
                try:
                    inicio_buffer = timezone.now() - timedelta(seconds=5)
                    VoiceTranscription.objects.filter(
                        session_id=sid,
                        is_capturing=False,
                        timestamp__gte=inicio_buffer
                    ).update(is_capturing=True)
                except Exception:
                    pass
            elif command in ['finalizar_proceso', 'detener_proceso']:
                # Este comando aún marca esta transcripción como parte de la captura
                session_obj.is_capturing = False
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.FINALIZADO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
            elif command in ['confirmar_datos', 'confirmar']:
                session_obj.is_capturing = False
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.ESPERANDO_CONFIRMACION
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
            elif command in ['cancelar_proceso', 'cancelar']:
                session_obj.is_capturing = False
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.INACTIVO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
            elif command in ['repetir_proceso', 'reiniciar']:
                session_obj.is_capturing = True
                session_obj.estado_grabacion = VoiceSession.EstadoGrabacion.INICIADO
                session_obj.save(update_fields=['is_capturing','estado_grabacion'])
        except Exception as e_cmd:
            logger.warning("error_persistiendo_comando", extra={'event':'command_db_error','error':str(e_cmd)})

        # Incrementar contador de comandos en BD
        try:
            sid = session_id_from_client or voice_logger.get_current_session_id()
            record_session_activity(
                sid,
                command_inc=1,
                meta={'last_command': command, 'last_timestamp': log_entry.get('timestamp_unix')}
            )
        except Exception as _e_db:
            logger.warning("error_actualizar_voice_session_comando", extra={'event':'session_update_command_error','error':str(_e_db)})
        
        return JsonResponse({
            'success': True,
            'session_id': voice_logger.get_current_session_id(),
            'timestamp': log_entry['timestamp']
        })
        
    except Exception as e:
        logger.error("error_log_command", extra={'event':'log_command_error','error':str(e)})
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def transcribe_hybrid(request):
    """
    Endpoint híbrido para modo nube:
    1. Recibe audio completo capturado entre "Iniciar ingreso" y "Detener ingreso"
    2. Transcribe con OpenAI Whisper + vocabulario automotriz
    3. Extrae datos estructurados con GPT-4/Ollama
    4. Retorna JSON para llenar formulario
    
    Ventajas vs modo local:
    - Mejor precisión en marcas/modelos de autos
    - Vocabulario ilimitado
    - Maneja acentos y ruido mejor
    - No requiere modelo Vosk grande
    """
    temp_audio_path = None  # Inicializar para evitar error en finally
    
    ensure_voice_ingest_permission(request.user)
    try:
        from parts.transcription_service import (
            transcribir_openai_con_vocabulario,
            calcular_duracion_audio
        )
        
        # Validar que haya audio
        if 'audio' not in request.FILES:
            return JsonResponse({
                'success': False,
                'error': 'No se recibió archivo de audio'
            }, status=400)
        
        audio_file = request.FILES['audio']
        session_id = request.POST.get('session_id', 'unknown')
        duration_reported = int(request.POST.get('duration', 0))
        
        logger.info(f"[HYBRID] Solicitud de transcripción híbrida. Sesión: {session_id}, Duración reportada: {duration_reported}s, Tamaño: {audio_file.size} bytes")
        
        # Guardar audio temporalmente
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as temp_audio:
            for chunk in audio_file.chunks():
                temp_audio.write(chunk)
            temp_audio_path = temp_audio.name
        
        # Intentar calcular duración real (opcional, puede fallar si ffprobe no está disponible)
        duracion_real = calcular_duracion_audio(temp_audio_path)
        logger.info(f"[HYBRID] Duración real del audio: {duracion_real:.2f}s")
        
        # Validar duración mínima (usar duración reportada si ffprobe falló)
        duracion_validar = duracion_real if duracion_real > 0 else duration_reported
        if duracion_validar < 0.5:
            logger.warning(f"[HYBRID] Audio rechazado: duración {duracion_validar:.2f}s < 0.5s")
            return JsonResponse({
                'success': False,
                'error': f'Audio demasiado corto: {duracion_validar:.1f}s (mínimo 0.5s)'
            }, status=400)
        
        logger.info(f"[HYBRID] Duración validada: {duracion_validar:.2f}s")
        
        # Transcribir con OpenAI + vocabulario automotriz
        logger.info("[HYBRID] Transcribiendo con OpenAI Whisper + vocabulario personalizado...")
        texto_transcrito = transcribir_openai_con_vocabulario(temp_audio_path)
        
        if not texto_transcrito:
            return JsonResponse({
                'success': False,
                'error': 'No se pudo transcribir el audio. Verifica OPENAI_API_KEY.'
            }, status=500)
        
        logger.info(f"[HYBRID] Transcripción exitosa: '{texto_transcrito}'")
        
        # Extraer datos estructurados con OpenAI
        logger.info("[HYBRID] Extrayendo datos estructurados...")
        datos_extraidos = extraer_datos_vehiculo_nativo(texto_transcrito)
        
        if not datos_extraidos:
            return JsonResponse({
                'success': False,
                'error': 'No se pudieron extraer datos del texto transcrito'
            }, status=500)
        
        logger.info(f"[HYBRID] Datos extraídos: {datos_extraidos}")
        
        # Registrar en sesión de voz si existe
        try:
            from .models import VoiceSession
            session = VoiceSession.objects.filter(session_id=session_id).first()
            if session:
                session.text_captured = texto_transcrito
                session.save()
                logger.info(f"[HYBRID] Sesión {session_id} actualizada con transcripción")
        except Exception as e:
            logger.warning(f"[HYBRID] No se pudo actualizar sesión: {e}")
        
        return JsonResponse({
            'success': True,
            'transcription': texto_transcrito,
            'extracted_data': datos_extraidos,
            'duration': duracion_real,
            'mode': 'hybrid_openai'
        })
    
    except ImportError as e:
        logger.error(f"[HYBRID] Error de importación: {e}")
        return JsonResponse({
            'success': False,
            'error': 'Servicio de transcripción no disponible. Falta módulo openai.'
        }, status=500)
    
    except Exception as e:
        logger.error(f"[HYBRID] Error en transcripción híbrida: {e}", exc_info=True)
        return JsonResponse({
            'success': False,
            'error': f'Error interno: {str(e)}'
        }, status=500)
    
    finally:
        # Limpiar archivo temporal si fue creado
        if temp_audio_path:
            try:
                os.remove(temp_audio_path)
                logger.debug(f"[HYBRID] Archivo temporal eliminado: {temp_audio_path}")
            except Exception as e:
                logger.warning(f"[HYBRID] No se pudo eliminar archivo temporal {temp_audio_path}: {e}")


@login_required
@csrf_protect
@require_http_methods(["POST"])
def voice_search_transcribe(request):
    """
    Transcribe un audio corto (grabado desde el buscador) usando Vosk y retorna el texto.
    Pensado para búsquedas rápidas de piezas.
    """
    if not vosk_operativo():
        return JsonResponse({
            'success': False,
            'error': 'Vosk no está disponible en este servidor'
        }, status=503)

    audio_file = request.FILES.get('audio')
    if not audio_file:
        return JsonResponse({
            'success': False,
            'error': 'No se recibió audio'
        }, status=400)

    temp_webm = None
    wav_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as temp_audio:
            for chunk in audio_file.chunks():
                temp_audio.write(chunk)
            temp_webm = temp_audio.name

        wav_path = transcode_webm_bytes_to_clean_wav(temp_webm, target_sr=VOSK_SAMPLE_RATE)
        transcript = _transcribir_audio_corto_vosk(wav_path)
        if not transcript:
            return JsonResponse({
                'success': False,
                'error': 'No se detectó ninguna frase. Intenta acercarte más al micrófono.'
            }, status=422)

        normalized = normalize_transcript(transcript)
        return JsonResponse({
            'success': True,
            'transcript': transcript,
            'normalized': normalized
        })
    except RuntimeError as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)
    except Exception as exc:
        logger.error('voice_search_transcribe_error', extra={'error': str(exc)}, exc_info=True)
        return JsonResponse({'success': False, 'error': 'No se pudo transcribir el audio'}, status=500)
    finally:
        for path in (wav_path, temp_webm):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass


@login_required
@csrf_protect
@require_http_methods(["POST"])
def voice_search_transcribe_openai(request):
    """
    Variante premium: usa OpenAI Whisper + vocabulario automotriz para transcribir
    la búsqueda dictada presionando el botón principal.
    """
    audio_file = request.FILES.get('audio')
    if not audio_file:
        return JsonResponse({'success': False, 'error': 'No se recibió audio'}, status=400)

    temp_webm = None
    wav_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as temp_audio:
            for chunk in audio_file.chunks():
                temp_audio.write(chunk)
            temp_webm = temp_audio.name

        wav_path = transcode_webm_bytes_to_clean_wav(temp_webm, target_sr=VOSK_SAMPLE_RATE)
        try:
            from parts.transcription_service import transcribir_openai_con_vocabulario
        except ImportError as exc:
            logger.error('openai_module_missing', extra={'error': str(exc)})
            return JsonResponse({'success': False, 'error': 'Servicio OpenAI no disponible'}, status=500)

        transcript = transcribir_openai_con_vocabulario(wav_path or temp_webm)
        if not transcript:
            return JsonResponse({'success': False, 'error': 'OpenAI no devolvió texto'}, status=500)

        normalized = normalize_transcript(transcript)
        return JsonResponse({
            'success': True,
            'transcript': transcript.strip(),
            'normalized': normalized
        })
    except Exception as exc:
        logger.error('voice_search_openai_error', extra={'error': str(exc)}, exc_info=True)
        return JsonResponse({'success': False, 'error': 'No se pudo transcribir el audio'}, status=500)
    finally:
        for path in (wav_path, temp_webm):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass


def extraer_datos_vehiculo_nativo(texto):
    """
    Extrae datos estructurados de una transcripción usando OpenAI GPT-4.
    
    Args:
        texto: Transcripción del audio
    
    Returns:
        dict: Datos extraídos (marca, modelo, año, color, pieza, etc.)
    """
    if not texto or len(texto.strip()) < 3:
        logger.warning("Texto vacío o muy corto para extraer datos")
        return {}
    
    # Prompt para extracción estructurada
    system_prompt = """Eres un experto en autopartes. Extrae SOLO la información que está EXPLÍCITAMENTE mencionada en el texto.

Reglas estrictas:
1. Si una marca NO está mencionada, NO la inventes
2. Si un modelo NO está mencionado, NO lo inventes
3. Si un año NO está mencionado, NO lo inventes
4. Si un color NO está mencionado, NO lo inventes
5. SOLO extrae lo que está claramente dicho

Formatos aceptados:
- Años: "dos mil veinte" = 2020, "noventa y ocho" = 1998, "2015" = 2015
- Marcas comunes: Toyota, Nissan, Honda, Chevrolet, Ford, Mazda, Hyundai, Kia, Volkswagen
- Modelos comunes: Tsuru, Sentra, Versa, Corolla, Civic, Jetta, Aveo, Accent

Responde SOLO con JSON válido, sin texto adicional:
{
  "marca": "string o null",
  "modelo": "string o null",
  "año": number o null,
  "color": "string o null",
  "pieza": "string (REQUERIDO)",
  "ubicacion": "string o null",
  "precio": number o null,
  "observaciones": "string o null"
}"""
    
    user_prompt = f"Texto de descripción:\n\n{texto}"
    
    if not settings.OPENAI_API_KEY:
        logger.warning("[EXTRACCION] OPENAI_API_KEY no configurada")
        return {}
    
    client = OpenAI(api_key=settings.OPENAI_API_KEY)
    
    for attempt in range(1, OPENAI_MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",  # Rápido y económico
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
                max_tokens=500,
                timeout=OPENAI_TIMEOUT_SECONDS,
            )
            
            resultado = json.loads(response.choices[0].message.content)
            logger.info(f"[EXTRACCION] OpenAI extrajo: {resultado}")
            return resultado
        
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "[EXTRACCION] OpenAI timeout/conexión (%s/%s): %s",
                attempt,
                OPENAI_MAX_RETRIES,
                exc,
            )
            if attempt == OPENAI_MAX_RETRIES:
                break
            time.sleep(min(2 ** attempt, 5))
        except Exception as e:
            logger.error(f"[EXTRACCION] Error: {e}", exc_info=True)
            break
    return {}


# ============================================================
#  API DE SESIONES DE VOZ (REST) - REACTIVADA 2025-11
# ============================================================

def _obtener_payload(request):
    if request.content_type and 'application/json' in request.content_type:
        try:
            raw = request.body.decode('utf-8') if request.body else '{}'
            return json.loads(raw or '{}')
        except Exception:
            logger.warning('JSON inválido recibido en endpoint de voz', exc_info=True)
            return {}
    if request.method == 'POST':
        return {k: request.POST.get(k) for k in request.POST.keys()}
    return {}


def _valor_booleano(valor, default=False):
    if isinstance(valor, bool):
        return valor
    if isinstance(valor, (int, float)):
        return valor != 0
    if isinstance(valor, str):
        return valor.strip().lower() in {'1', 'true', 'si', 'sí', 'on', 'yes'}
    return default


def _limpiar_comandos(texto):
    limpio = texto or ''
    for comando in COMANDOS_CONTROL:
        limpio = re.sub(re.escape(comando), ' ', limpio, flags=re.IGNORECASE)
    limpio = re.sub(r'\s+', ' ', limpio).strip()
    return limpio


def _transcripciones_captura(session_id):
    finales = list(
        VoiceTranscription.objects.filter(
            session_id=session_id,
            type=VoiceTranscription.Type.FINAL,
            is_capturing=True
        ).order_by('timestamp')
    )
    if finales:
        return finales
    return list(
        VoiceTranscription.objects.filter(
            session_id=session_id,
            type=VoiceTranscription.Type.PARTIAL,
            is_capturing=True
        ).order_by('timestamp')
    )


def _construir_texto_sesion(session_id):
    registros = _transcripciones_captura(session_id)
    if not registros:
        return '', None, None
    fragmentos = []
    inicio = registros[0].timestamp
    fin = registros[-1].timestamp
    ultimo = ''
    for registro in registros:
        texto = _limpiar_comandos(registro.text or '')
        if not texto:
            continue
        if texto == ultimo:
            continue
        fragmentos.append(texto)
        ultimo = texto
    combinado = ' '.join(fragmentos).strip()
    combinado = normalize_transcript(combinado)
    return combinado, inicio, fin


def _guardar_resultado_archivo(session_id, transcript, fields):
    try:
        voice_logs_dir = Path(settings.BASE_DIR) / 'voice_logs'
        voice_logs_dir.mkdir(exist_ok=True)
        payload = {
            'session_id': session_id,
            'transcript': transcript,
            'fields': fields,
            'timestamp': timezone.now().isoformat()
        }
        destino = voice_logs_dir / f"result_{session_id}.json"
        destino.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        logger.warning('No se pudo escribir resultado JSON de voz', exc_info=True)


def _extraer_campos(texto):
    if not texto:
        return {}
    api_key = getattr(settings, 'OPENAI_API_KEY', '')
    if not api_key:
        return _extraer_campos_heuristico(texto)
    prompt_sistema = (
        "Eres un asistente experto en repuestos automotrices. Extrae únicamente información explícita "
        "y responde con JSON que contenga las claves parte, valor, min_value y detalles. "
        "Precio normal (valor) = último monto general mencionado. Precio mínimo (min_value) = último monto considerado "
        "oferta/último precio. Todos los precios deben ir solo con dígitos, sin símbolos ni palabras. Usa \"\" cuando un dato falte."
    )
    try:
        client = OpenAI(api_key=api_key)
        respuesta = client.chat.completions.create(
            model=getattr(settings, 'VOICE_GPT_MODEL', 'gpt-4o-mini'),
            messages=[
                {'role': 'system', 'content': prompt_sistema},
                {'role': 'user', 'content': f'Descripción capturada: {texto}'}
            ],
            temperature=0.15,
            max_tokens=400,
            response_format={'type': 'json_object'}
        )
        contenido = respuesta.choices[0].message.content.strip()
        campos = json.loads(contenido)
        return campos
    except Exception:
        logger.warning('Fallo extracción con OpenAI, usando heurística', exc_info=True)
        return _extraer_campos_heuristico(texto)


def _extraer_campos_heuristico(texto):
    texto = texto or ''
    precio = None
    match = re.findall(r'(\d{2,3}(?:[\s.,]\d{3})+|\d{4,6})', texto)
    if match:
        precio = int(re.sub(r'[^0-9]', '', match[-1]))
    descuento = None
    m_desc = re.search(r'(ultimo|último|minimo|mínimo|rebajado|oferta)[^0-9]*([0-9]+(?:[.,][0-9]{3})*)', texto, re.IGNORECASE)
    if m_desc:
        descuento = int(re.sub(r'[^0-9]', '', m_desc.group(2)))
    return {
        'parte': texto[:80].strip() or None,
        'detalles': texto,
        'valor': precio,
        'min_value': descuento
    }


def _registrar_estado_sesion(session_id, **updates):
    session, _ = VoiceSession.objects.get_or_create(
        session_id=session_id,
        defaults={'started_at': timezone.now(), 'status': VoiceSession.Status.ACTIVE}
    )
    campos = []
    if 'is_capturing' in updates:
        session.is_capturing = bool(updates['is_capturing'])
        campos.append('is_capturing')
    if 'estado' in updates:
        session.estado_grabacion = updates['estado']
        campos.append('estado_grabacion')
    if 'meta' in updates and updates['meta']:
        meta = session.meta or {}
        meta.update(updates['meta'])
        session.meta = meta
        campos.append('meta')
    if campos:
        session.save(update_fields=campos)
    return session


@login_required
@csrf_protect
@require_http_methods(["POST"])
def start_voice_session(request):
    ensure_voice_ingest_permission(request.user)
    try:
        session_id = voice_logger.start_new_session()
        record_session_activity(session_id, meta={'user_id': getattr(request.user, 'id', None)})
        _registrar_estado_sesion(session_id, is_capturing=False, estado=VoiceSession.EstadoGrabacion.INACTIVO)
        return JsonResponse({'success': True, 'session_id': session_id})
    except Exception as exc:
        logger.error('No se pudo iniciar sesión de voz', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def log_transcription(request):
    ensure_voice_ingest_permission(request.user)
    data = _obtener_payload(request)
    session_id = data.get('session_id') or voice_logger.get_current_session_id()
    texto = (data.get('text') or '').strip()
    tipo = (data.get('type') or VoiceTranscription.Type.PARTIAL).lower()
    metadata = data.get('metadata') or {}
    if not isinstance(metadata, dict):
        metadata = {'valor_original': metadata}
    if not session_id:
        return JsonResponse({'success': False, 'error': 'session_id requerido'}, status=400)
    if tipo not in VoiceTranscription.Type.values:
        tipo = VoiceTranscription.Type.PARTIAL
    if not texto:
        return JsonResponse({'success': True, 'ignored': True})

    is_capturing = _valor_booleano(data.get('is_capturing'), metadata.get('isCapturing'))
    try:
        VoiceTranscription.objects.create(
            session_id=session_id,
            text=texto,
            type=tipo,
            metadata=metadata,
            is_capturing=is_capturing
        )
        parciales = 1 if tipo == VoiceTranscription.Type.PARTIAL else 0
        finales = 1 if tipo == VoiceTranscription.Type.FINAL else 0
        record_session_activity(session_id, partial_inc=parciales, final_inc=finales, meta={'ultima_transcripcion': texto})
        _registrar_estado_sesion(session_id, is_capturing=is_capturing)
        voice_logger.log_transcription(texto, tipo, metadata)
        return JsonResponse({'success': True})
    except Exception as exc:
        logger.error('Error registrando transcripción', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def log_command(request):
    ensure_voice_ingest_permission(request.user)
    data = _obtener_payload(request)
    session_id = data.get('session_id') or voice_logger.get_current_session_id()
    comando = (data.get('command') or '').strip().lower()
    texto = (data.get('text') or '').strip()
    metadata = data.get('metadata') or {}
    if not isinstance(metadata, dict):
        metadata = {'raw': metadata}
    metadata['command'] = comando
    if not session_id or not comando:
        return JsonResponse({'success': False, 'error': 'Parámetros incompletos'}, status=400)
    try:
        VoiceTranscription.objects.create(
            session_id=session_id,
            text=texto or comando,
            type=VoiceTranscription.Type.COMMAND,
            metadata=metadata,
            is_capturing=metadata.get('is_capturing', False)
        )
        record_session_activity(session_id, command_inc=1, meta={'ultimo_comando': comando})
        estado = None
        capturando = None
        if comando == 'iniciar_proceso':
            estado = VoiceSession.EstadoGrabacion.INICIADO
            capturando = True
        elif comando in ('finalizar_proceso', 'detener_proceso'):
            estado = VoiceSession.EstadoGrabacion.FINALIZADO
            capturando = False
        elif comando == 'confirmar_datos':
            estado = VoiceSession.EstadoGrabacion.ESPERANDO_CONFIRMACION
        _registrar_estado_sesion(session_id, estado=estado, is_capturing=capturando)
        voice_logger.log_command(comando, texto or comando)
        return JsonResponse({'success': True})
    except Exception as exc:
        logger.error('Error registrando comando', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def close_voice_session(request):
    ensure_voice_ingest_permission(request.user)
    data = _obtener_payload(request)
    reason = data.get('reason', 'manual')
    try:
        closed_session = voice_logger.close_session(reason=reason)
        if closed_session:
            close_session_db(closed_session, reason=reason)
        return JsonResponse({'success': True, 'closed_session_id': closed_session})
    except Exception as exc:
        logger.error('Error cerrando sesión de voz', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
@require_http_methods(["GET"])
def check_extraction_result(request):
    session_id = request.GET.get('session_id')
    if not session_id:
        return JsonResponse({'success': False, 'error': 'session_id requerido'}, status=400)
    try:
        resultado = VoiceIngestResult.objects.filter(session__session_id=session_id).order_by('-created_at').first()
        if resultado:
            return JsonResponse({
                'success': True,
                'has_result': True,
                'fields': resultado.fields,
                'transcript': resultado.transcript
            })
        archivo = Path(settings.BASE_DIR) / 'voice_logs' / f"result_{session_id}.json"
        if archivo.exists():
            data = json.loads(archivo.read_text(encoding='utf-8'))
            return JsonResponse({
                'success': True,
                'has_result': True,
                'fields': data.get('fields', {}),
                'transcript': data.get('transcript', '')
            })
        return JsonResponse({'success': True, 'has_result': False})
    except Exception as exc:
        logger.error('Error verificando resultado de extracción', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
@csrf_protect
@require_http_methods(["POST"])
def process_session_transcript(request):
    ensure_voice_ingest_permission(request.user)
    data = _obtener_payload(request)
    session_id = data.get('session_id') or voice_logger.get_current_session_id()
    if not session_id:
        return JsonResponse({'success': False, 'error': 'session_id requerido'}, status=400)

    transcript_text = data.get('transcript') or data.get('accumulated_text')
    if not transcript_text:
        transcript_text, inicio, fin = _construir_texto_sesion(session_id)
    else:
        inicio = timezone.now()
        fin = inicio

    if not transcript_text:
        return JsonResponse({'success': False, 'error': 'No hay texto capturado para procesar'}, status=422)

    campos = _extraer_campos(transcript_text)
    if not campos:
        return JsonResponse({'success': False, 'error': 'La IA no pudo extraer datos'}, status=502)

    try:
        start_ts = inicio.timestamp() if inicio else timezone.now().timestamp()
        end_ts = fin.timestamp() if fin else start_ts + 1
        save_ingest_result(
            session_id=session_id,
            start_ts=start_ts,
            end_ts=end_ts,
            transcript=transcript_text,
            fields=campos,
            source='realtime'
        )
        _registrar_estado_sesion(
            session_id,
            estado=VoiceSession.EstadoGrabacion.ESPERANDO_CONFIRMACION,
            is_capturing=False,
            meta={'ultimo_resultado': campos}
        )
        _guardar_resultado_archivo(session_id, transcript_text, campos)
        return JsonResponse({'success': True, 'fields': campos, 'transcript': transcript_text})
    except Exception as exc:
        logger.error('Error procesando transcripción de sesión', exc_info=True)
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)
