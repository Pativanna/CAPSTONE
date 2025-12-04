"""Constantes y utilidades para comandos estrictos del modo manos libres."""
from __future__ import annotations

import re
import unicodedata
from typing import Tuple

STRICT_COMMAND_PHRASES: tuple[tuple[str, str], ...] = (
    ('iniciar ingreso', 'iniciar_proceso'),
    ('detener ingreso', 'finalizar_proceso'),
    ('cancelar ingreso', 'cancelar_proceso'),
    ('confirmar ingreso', 'confirmar_datos'),
    ('repetir ingreso', 'repetir_proceso'),
)

STRICT_COMMAND_GRAMMAR = [phrase for phrase, _ in STRICT_COMMAND_PHRASES]
STRICT_COMMAND_MAP = dict(STRICT_COMMAND_PHRASES)

_CLEAN_PATTERN = re.compile(r'[^a-z0-9áéíóúñü\s]', flags=re.IGNORECASE)


def _normalize(text: str | None) -> str:
    if not text:
        return ''
    lowered = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    lowered = lowered.lower()
    cleaned = _CLEAN_PATTERN.sub(' ', lowered)
    tokens = [tok for tok in cleaned.split() if tok]
    return ' '.join(tokens)


def match_strict_command(text: str | None, *, allow_partial: bool = False) -> Tuple[str | None, str | None]:
    """Devuelve (command_name, phrase) cuando el texto coincide con una de las frases permitidas."""
    normalized = _normalize(text)
    if not normalized:
        return None, None
    for phrase, command in STRICT_COMMAND_PHRASES:
        if normalized == phrase:
            return command, phrase
    if allow_partial:
        for phrase, command in STRICT_COMMAND_PHRASES:
            if phrase in normalized:
                return command, phrase
    return None, None


def normalize_command_text(text: str | None) -> str:
    """Normaliza texto para compararlo con las frases estrictas."""
    return _normalize(text)


def tokenize_command_text(text: str | None) -> list[str]:
    """Compatibilidad: devuelve los tokens normalizados del texto entregado."""
    normalized = _normalize(text)
    if not normalized:
        return []
    return normalized.split()
