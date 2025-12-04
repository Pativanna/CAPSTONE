from __future__ import annotations

import hashlib
import json
import time
from decimal import Decimal
from typing import Optional, Dict, Any

from django.conf import settings
from django.utils import timezone

from parts.models import OpenAILlamada


# Precios de referencia (USD por 1K tokens) y por minuto para whisper/tts (estimados)
# Nota: Ajustar si cambian tarifas. Fuente aproximada: documentación OpenAI 2024.
PRECIO_TOKENS = {
    # Chat
    'gpt-4': {'prompt': Decimal('0.03'), 'completion': Decimal('0.06')},
    'gpt-4o-mini': {'prompt': Decimal('0.00015'), 'completion': Decimal('0.0006')},
    'gpt-4o': {'prompt': Decimal('0.0025'), 'completion': Decimal('0.01')},
}

# Whisper y TTS varían por minuto/audio; dejamos costo_estimado en None, salvo que provengamos con metadatos (duración seg).
PRECIO_POR_MINUTO = {
    'whisper-1': Decimal('0.006'),  # USD/min aprox.
    'tts-1': Decimal('0.015'),
    'tts-1-hd': Decimal('0.030'),
}


def _sha_prompt(texto: Optional[str]) -> str:
    if not texto:
        return ''
    try:
        return hashlib.sha256(texto.encode('utf-8')).hexdigest()
    except Exception:
        return ''


def _calcular_costo_chat(modelo: str, tokens_prompt: Optional[int], tokens_resp: Optional[int]) -> Optional[Decimal]:
    precios = PRECIO_TOKENS.get(modelo)
    if not precios:
        return None
    tp = Decimal(tokens_prompt or 0)
    tr = Decimal(tokens_resp or 0)
    costo = (tp / Decimal(1000)) * precios['prompt'] + (tr / Decimal(1000)) * precios['completion']
    return costo.quantize(Decimal('0.000001'))


def _calcular_costo_audio(modelo: str, duracion_segundos: Optional[float]) -> Optional[Decimal]:
    if not duracion_segundos:
        return None
    pm = PRECIO_POR_MINUTO.get(modelo)
    if not pm:
        return None
    minutos = Decimal(duracion_segundos) / Decimal(60)
    costo = minutos * pm
    return costo.quantize(Decimal('0.000001'))


def registrar_llamada(
    *,
    tipo: str,
    modelo: str,
    inicio_monotonic: float,
    ok: bool,
    codigo_http: Optional[int] = None,
    error_texto: str = '',
    tokens_prompt: Optional[int] = None,
    tokens_respuesta: Optional[int] = None,
    prompt_texto_para_hash: Optional[str] = None,
    usuario_id: Optional[str] = None,
    origen: str = '',
    request_id: str = '',
    meta: Optional[Dict[str, Any]] = None,
) -> OpenAILlamada:
    """Crea un registro de llamada en BD con costo estimado y métricas básicas."""
    duracion_ms = int((time.monotonic() - inicio_monotonic) * 1000)

    costo_estimado = None
    if tipo == 'chat':
        costo_estimado = _calcular_costo_chat(modelo, tokens_prompt, tokens_respuesta)
    elif tipo in ('whisper', 'tts'):
        duracion_seg = None
        if meta and isinstance(meta.get('duracion_segundos'), (int, float)):
            duracion_seg = float(meta['duracion_segundos'])
        costo_estimado = _calcular_costo_audio(modelo, duracion_seg)

    registro = OpenAILlamada.objects.create(
        tipo=tipo,
        modelo=modelo,
        tokens_prompt=tokens_prompt,
        tokens_respuesta=tokens_respuesta,
        costo_estimado=costo_estimado,
        duracion_ms=duracion_ms,
        exito=bool(ok),
        codigo_http=codigo_http,
        error_texto=(error_texto or '')[:2000],
        hash_prompt=_sha_prompt(prompt_texto_para_hash),
        usuario_id=str(usuario_id or ''),
        origen=origen[:120] if origen else '',
        request_id=request_id[:60] if request_id else '',
        meta=meta or {},
    )
    return registro
