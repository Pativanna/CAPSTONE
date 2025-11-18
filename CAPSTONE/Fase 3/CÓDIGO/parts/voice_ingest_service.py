"""
Utilidades para registrar sesiones y resultados de ingesta de voz en la base de datos.

Nota (2025-11-07): hoy casi todo pasa por views directas, pero este módulo
sigue siendo la capa limpia para futuras integraciones.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any
from django.db import transaction
from django.db import OperationalError
import time
import logging
from django.utils import timezone

from .models import VoiceSession, VoiceIngestResult

logger = logging.getLogger('parts.voice')


def _ejecutar_con_reintentos(fn, *, retries: int = 5, base_sleep: float = 0.05):
    """Envuelve una operación crítica con reintentos exponenciales si SQLite está bloqueado."""
    attempt = 0
    while True:
        try:
            return fn()
        except OperationalError as e:
            msg = str(e).lower()
            if 'locked' in msg or 'database is locked' in msg:
                if attempt >= retries:
                    logger.error("db_locked_max_retries", extra={'event': 'db_locked', 'attempts': attempt + 1})
                    raise
                sleep_s = base_sleep * (2 ** attempt)
                time.sleep(sleep_s)
                attempt += 1
                continue
            raise


@dataclass
class ContadorSesion:
    parcial: int = 0
    final: int = 0
    comando: int = 0


def record_session_activity(session_id: str, *, partial_inc: int = 0, final_inc: int = 0,
                            command_inc: int = 0, meta: Optional[Dict[str, Any]] = None) -> VoiceSession:
    """Crea/actualiza la fila de VoiceSession e incrementa contadores en forma atómica."""
    def _op():
        with transaction.atomic():
            session, _created = VoiceSession.objects.select_for_update().get_or_create(
                session_id=session_id,
                defaults={
                    'started_at': timezone.now(),
                    'status': VoiceSession.Status.ACTIVE,
                }
            )

            # Update counters
            if partial_inc:
                session.partial_count = (session.partial_count or 0) + int(partial_inc)
            if final_inc:
                session.final_count = (session.final_count or 0) + int(final_inc)
            if command_inc:
                session.command_count = (session.command_count or 0) + int(command_inc)

            if meta:
                current = session.meta or {}
                current.update(meta)
                session.meta = current

            session.save(update_fields=['partial_count', 'final_count', 'command_count', 'meta'])
            return session

    return _ejecutar_con_reintentos(_op)


def close_session(session_id: str, *, reason: str = 'manual') -> Optional[VoiceSession]:
    """Marca una sesión como cerrada y rellena ended_at. Devuelve None si no existía."""
    def _op():
        with transaction.atomic():
            try:
                session = VoiceSession.objects.select_for_update().get(session_id=session_id)
            except VoiceSession.DoesNotExist:
                return None

            session.status = VoiceSession.Status.CLOSED
            session.ended_at = timezone.now()

            meta = session.meta or {}
            meta['close_reason'] = reason
            session.meta = meta

            session.save(update_fields=['status', 'ended_at', 'meta'])
            return session

    return _ejecutar_con_reintentos(_op)


def save_ingest_result(*, session_id: str, start_ts: float, end_ts: float, transcript: str,
                       fields: Dict[str, Any], source: str) -> VoiceIngestResult:
    """Guarda un resultado de ingesta asegurando idempotencia vía pair_key."""
    def _op():
        with transaction.atomic():
            session, _ = VoiceSession.objects.select_for_update().get_or_create(
                session_id=session_id,
                defaults={
                    'started_at': timezone.now(),
                    'status': VoiceSession.Status.ACTIVE,
                }
            )

            pair_key = f"{session_id}_{start_ts}_{end_ts}"

            obj, _created = VoiceIngestResult.objects.get_or_create(
                pair_key=pair_key,
                defaults={
                    'session': session,
                    'start_ts': float(start_ts),
                    'end_ts': float(end_ts),
                    'transcript': transcript or '',
                    'fields': fields or {},
                    'source': source,
                }
            )

            if not _created:
                changed = False
                if transcript and obj.transcript != transcript:
                    obj.transcript = transcript
                    changed = True
                if fields and obj.fields != fields:
                    obj.fields = fields
                    changed = True
                if source and obj.source != source:
                    obj.source = source
                    changed = True
                if changed:
                    obj.save(update_fields=['transcript', 'fields', 'source'])

            return obj

    return _ejecutar_con_reintentos(_op)
