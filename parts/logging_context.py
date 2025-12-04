"""Contexto compartido para logging estructurado con request/correlation IDs."""
from __future__ import annotations

import uuid
from contextvars import ContextVar
from contextlib import contextmanager
from typing import Dict, Any

_request_id_var = ContextVar('request_id', default='')
_correlation_id_var = ContextVar('correlation_id', default='')
_session_id_var = ContextVar('session_id', default='')
_user_id_var = ContextVar('user_id', default='')

_VAR_MAP = {
    'request_id': _request_id_var,
    'correlation_id': _correlation_id_var,
    'session_id': _session_id_var,
    'user_id': _user_id_var,
}


def _set(var: ContextVar, value: str):
    return var.set(value or '')


def _reset(var: ContextVar, token):
    try:
        var.reset(token)
    except LookupError:
        pass


def set_context(**kwargs) -> Dict[str, Any]:
    """Setea valores en el contexto actual. Devuelve tokens para revertir."""
    tokens = {}
    for key, value in kwargs.items():
        var = _VAR_MAP.get(key)
        if not var:
            continue
        tokens[key] = _set(var, value or '')
    return tokens


def reset_context(tokens: Dict[str, Any]):
    """Restaura valores previos usando los tokens devueltos por set_context."""
    for key, token in tokens.items():
        var = _VAR_MAP.get(key)
        if var:
            _reset(var, token)


@contextmanager
def use_context(**kwargs):
    """Context manager para setear valores temporales en el contexto."""
    tokens = set_context(**kwargs)
    try:
        yield
    finally:
        reset_context(tokens)


def clear_context():
    """Limpia el contexto actual."""
    set_context(request_id='', correlation_id='', session_id='', user_id='')


def get_context() -> Dict[str, str]:
    return {
        'request_id': _request_id_var.get(''),
        'correlation_id': _correlation_id_var.get(''),
        'session_id': _session_id_var.get(''),
        'user_id': _user_id_var.get(''),
    }


def ensure_request_id(value: str | None = None) -> str:
    """Garantiza que exista request_id y lo devuelve."""
    current = _request_id_var.get('')
    if current:
        return current
    new_value = value or uuid.uuid4().hex[:12]
    _request_id_var.set(new_value)
    return new_value


def ensure_correlation_id(value: str | None = None) -> str:
    current = _correlation_id_var.get('')
    if current:
        return current
    new_value = value or uuid.uuid4().hex[:12]
    _correlation_id_var.set(new_value)
    return new_value


class LoggingContextFilter:
    """Filtro que inyecta IDs de contexto en cada record."""

    def filter(self, record):
        record.request_id = _request_id_var.get('')
        record.correlation_id = _correlation_id_var.get('')
        record.session_id = _session_id_var.get('')
        record.user_id = _user_id_var.get('')
        return True
