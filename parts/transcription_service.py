"""
Servicio de transcripción inteligente con soporte para:
- Vosk (offline, rápido, comandos cortos)
- OpenAI Whisper con prompting (online, preciso, vocabulario personalizado)

Autor: Sistema Car Inventory
Fecha: 2025-11-11
"""

import logging
import os
import time
from typing import Optional
from django.conf import settings

try:
    from openai import OpenAI
    from openai import APIConnectionError, APITimeoutError
except ImportError:  # pragma: no cover - dependencia opcional
    OpenAI = None
    APIConnectionError = APITimeoutError = Exception


logger = logging.getLogger('parts.transcription')

OPENAI_TIMEOUT_SECONDS = int(getattr(settings, 'OPENAI_TIMEOUT_SECONDS', 60))
OPENAI_MAX_RETRIES = max(1, int(getattr(settings, 'OPENAI_MAX_RETRIES', 2)))

# ============================================================================
# VOCABULARIO DINÁMICO
# ============================================================================

def obtener_vocabulario_desde_bd():
    """
    Obtiene vocabulario actualizado desde la base de datos.
    Se actualiza automáticamente con nuevas piezas ingresadas.
    """
    from parts.models import Part, Auto
    
    try:
        # Obtener nombres de piezas únicas
        piezas = Part.objects.values_list('name', flat=True).distinct()
        piezas_validas = [p for p in piezas if p and len(p) > 2][:100]
        
        # Obtener marcas/modelos de autos (campo combinado brand_model)
        autos = Auto.objects.values_list('brand_model', flat=True).distinct()
        autos_validos = [a for a in autos if a and len(a) > 2][:50]
        
        return {
            'piezas': list(set(piezas_validas)),
            'autos': list(set(autos_validos))
        }
    except Exception as e:
        logger.error(f"Error obteniendo vocabulario desde BD: {e}")
        return {'piezas': [], 'autos': []}


def generar_prompt_automotriz():
    """
    Genera prompt personalizado con vocabulario automotriz.
    
    Este prompt mejora dramáticamente la precisión de OpenAI Whisper para:
    - Marcas y modelos de autos
    - Autopartes (parachoques, guardafango, calavera, etc.)
    
    Returns:
        str: Prompt optimizado para transcripción automotriz
    """
    from parts.vocabulario_automotriz import PIEZAS_AUTOMOTRICES
    
    vocab = obtener_vocabulario_desde_bd()
    
    # Construir prompt estructurado
    prompt_parts = [
        "Transcripción de inventario de autopartes en español.",
    ]
    
    if vocab['autos']:
        prompt_parts.append(f"Vehículos: {', '.join(vocab['autos'][:30])}.")
    
    if vocab['piezas']:
        prompt_parts.append(f"Piezas registradas: {', '.join(vocab['piezas'][:40])}.")
    
    # Agregar piezas más comunes del vocabulario estático
    piezas_lista = list(PIEZAS_AUTOMOTRICES)[:40]
    prompt_parts.append(f"Partes comunes: {', '.join(piezas_lista)}.")
    
    prompt = " ".join(prompt_parts)
    
    # Whisper tiene límite de ~224 tokens para prompt
    if len(prompt) > 800:  # ~200 tokens aprox
        prompt = prompt[:800] + "..."
    
    logger.debug(f"Prompt generado ({len(prompt)} caracteres): {prompt[:100]}...")
    return prompt


# ============================================================================
# TRANSCRIPCIÓN CON OPENAI + PROMPTING
# ============================================================================

def transcribir_openai_con_vocabulario(audio_path: str) -> Optional[str]:
    """
    Transcribe audio usando OpenAI Whisper con vocabulario personalizado.
    
    Ventajas vs Vosk:
    - Mejor precisión para nombres propios (marcas, modelos)
    - Maneja ruido y acentos mejor
    - Vocabulario ilimitado
    
    Args:
        audio_path: Ruta al archivo de audio (webm, mp3, wav, etc.)
    
    Returns:
        str: Texto transcrito o None si falla
    """
    if OpenAI is None:
        logger.error("Librería openai no instalada. Instalar: pip install openai")
        return None

    if not settings.OPENAI_API_KEY:
        logger.warning("OPENAI_API_KEY no configurada, no se puede usar OpenAI")
        return None

    if not os.path.exists(audio_path):
        logger.error(f"Archivo de audio no existe: {audio_path}")
        return None

    client = OpenAI(api_key=settings.OPENAI_API_KEY)

    for attempt in range(1, OPENAI_MAX_RETRIES + 1):
        # Generar prompt con vocabulario automotriz
        prompt_personalizado = generar_prompt_automotriz()
        
        logger.info(f"Transcribiendo con OpenAI: {audio_path}")
        
        try:
            with open(audio_path, "rb") as audio_file:
                transcription = client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",  # Económico y preciso
                    file=audio_file,
                    language="es",  # Español
                    prompt=prompt_personalizado,  # ← CLAVE PARA PRECISIÓN
                    response_format="text",  # Cambio de verbose_json a text (compatible con gpt-4o-mini-transcribe)
                    timeout=OPENAI_TIMEOUT_SECONDS,
                )
            texto = transcription if isinstance(transcription, str) else transcription.text
            logger.info(f"OpenAI transcripción exitosa: '{texto}'")
            return texto
        except (APIConnectionError, APITimeoutError) as exc:
            logger.warning(
                "OpenAI timeout/conexión fallido (%s/%s): %s",
                attempt,
                OPENAI_MAX_RETRIES,
                exc,
            )
            if attempt == OPENAI_MAX_RETRIES:
                logger.error("OpenAI no respondió tras %s intentos", OPENAI_MAX_RETRIES)
                return None
            time.sleep(min(2 ** attempt, 5))
        except Exception as exc:
            logger.error(f"Error en transcripción OpenAI: {exc}")
            return None


def transcribir_openai_streaming(audio_path: str, callback=None):
    """
    Transcribe audio con streaming (resultados parciales en tiempo real).
    
    Útil para UX mejorada: mostrar transcripción mientras se procesa.
    
    Args:
        audio_path: Ruta al archivo de audio
        callback: Función que recibe texto parcial: callback(texto_parcial)
    
    Returns:
        str: Texto transcrito completo
    """
    try:
        if OpenAI is None or not settings.OPENAI_API_KEY:
            return None
        
        client = OpenAI(api_key=settings.OPENAI_API_KEY)
        prompt_personalizado = generar_prompt_automotriz()
        
        with open(audio_path, "rb") as audio_file:
            stream = client.audio.transcriptions.create(
                model="gpt-4o-mini-transcribe",
                file=audio_file,
                language="es",
                prompt=prompt_personalizado,
                response_format="text",
                stream=True  # ← Habilitar streaming
            )
        
        texto_completo = ""
        for event in stream:
            if hasattr(event, 'text'):
                texto_completo += event.text
                if callback:
                    callback(texto_completo)
        
        logger.info(f"OpenAI streaming completo: '{texto_completo}'")
        return texto_completo
        
    except Exception as e:
        logger.error(f"Error en streaming OpenAI: {e}")
        return None


# ============================================================================
# TRANSCRIPCIÓN INTELIGENTE (HÍBRIDO)
# ============================================================================

def transcribir_inteligente(
    audio_path: str,
    duracion_segundos: float,
    usar_openai: bool = True
) -> Optional[str]:
    """
    Selecciona automáticamente el mejor motor de transcripción.
    
    Estrategia:
    - Audio corto (<3s): Vosk (rápido, offline, suficiente para comandos)
    - Audio largo (>3s): OpenAI (preciso, maneja vocabulario complejo)
    
    Args:
        audio_path: Ruta al archivo de audio
        duracion_segundos: Duración del audio en segundos
        usar_openai: Si False, siempre usa Vosk
    
    Returns:
        str: Texto transcrito o None si falla
    """
    
    # Comandos cortos: usar Vosk (rápido, offline)
    if duracion_segundos <= 3 or not usar_openai:
        logger.info(f"Usando Vosk para audio corto ({duracion_segundos}s)")
        return transcribir_vosk_local(audio_path)
    
    # Descripciones largas: usar OpenAI (preciso, vocabulario)
    logger.info(f"Usando OpenAI para audio largo ({duracion_segundos}s)")
    resultado_openai = transcribir_openai_con_vocabulario(audio_path)
    
    # Fallback a Vosk si OpenAI falla
    if resultado_openai is None:
        logger.warning("OpenAI falló, usando Vosk como fallback")
        return transcribir_vosk_local(audio_path)
    
    return resultado_openai


def transcribir_vosk_local(audio_path: str) -> Optional[str]:
    """
    Transcribe con Vosk (implementación actual del proyecto).
    
    Esta función debe conectarse con tu código existente de Vosk.
    """
    # TODO: Integrar con tu implementación actual de Vosk
    # Por ahora, retornar None para indicar que no está implementado aquí
    logger.debug(f"Llamando a transcripción Vosk local: {audio_path}")
    
    # Ejemplo de integración:
    # from parts.vosk_views import transcribir_con_vosk
    # return transcribir_con_vosk(audio_path)
    
    return None


# ============================================================================
# UTILIDADES
# ============================================================================

def estimar_costo_transcripcion(duracion_segundos: float, modelo: str = "gpt-4o-mini-transcribe") -> float:
    """
    Estima el costo de transcribir con OpenAI.
    
    Precios (Nov 2025):
    - whisper-1: $0.006 / minuto
    - gpt-4o-mini-transcribe: $0.02 / minuto
    - gpt-4o-transcribe: $0.06 / minuto
    
    Args:
        duracion_segundos: Duración del audio
        modelo: Modelo de OpenAI a usar
    
    Returns:
        float: Costo estimado en USD
    """
    minutos = duracion_segundos / 60
    
    precios = {
        "whisper-1": 0.006,
        "gpt-4o-mini-transcribe": 0.02,
        "gpt-4o-transcribe": 0.06,
    }
    
    precio_por_minuto = precios.get(modelo, 0.02)
    costo = minutos * precio_por_minuto
    
    return round(costo, 4)


def calcular_duracion_audio(audio_path: str) -> float:
    """
    Calcula la duración de un archivo de audio en segundos.
    
    Requiere ffprobe (parte de ffmpeg).
    """
    import subprocess
    import json
    
    try:
        cmd = [
            'ffprobe',
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            audio_path
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        data = json.loads(result.stdout)
        duracion = float(data['format']['duration'])
        
        logger.debug(f"Duración de {audio_path}: {duracion}s")
        return duracion
        
    except Exception as e:
        logger.error(f"Error calculando duración: {e}")
        return 0.0


# ============================================================================
# EJEMPLO DE USO
# ============================================================================

if __name__ == "__main__":
    # Configurar logging para pruebas
    logging.basicConfig(level=logging.DEBUG)
    
    # Ejemplo 1: Transcripción con vocabulario
    audio_test = "/path/to/audio.webm"
    
    if os.path.exists(audio_test):
        texto = transcribir_openai_con_vocabulario(audio_test)
        print(f"Transcripción: {texto}")
    
    # Ejemplo 2: Transcripción inteligente
    duracion = calcular_duracion_audio(audio_test)
    texto = transcribir_inteligente(audio_test, duracion)
    print(f"Transcripción inteligente: {texto}")
    
    # Ejemplo 3: Estimar costos
    costo = estimar_costo_transcripcion(5.0, "gpt-4o-mini-transcribe")
    print(f"Costo estimado para 5s: ${costo} USD")
