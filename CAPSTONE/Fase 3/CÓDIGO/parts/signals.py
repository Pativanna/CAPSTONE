"""
Django Signals para el sistema de voz y mitigaciones de SQLite (WAL/timeout)
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from .models import Part
from .voice_logger import voice_logger
import logging
from django.db import connection
from django.db.backends.signals import connection_created

logger = logging.getLogger('parts.voice')


@receiver(post_save, sender=Part)
def close_voice_session_on_part_save(sender, instance, created, **kwargs):
    """
    Cierra la sesión de logging de voz cuando se guarda un Part
    """
    if created:
        # Solo al crear (no al editar)
        session_id = voice_logger.close_session(reason='part_saved')
        if session_id:
            logger.info(
                "cierre_sesion_por_part",
                extra={
                    'event': 'voice_session_auto_close',
                    'session_id': session_id,
                    'part_id': instance.id,
                    'part_name': instance.name,
                    'reason': 'part_saved'
                }
            )


@receiver(connection_created)
def set_sqlite_wal(sender, connection, **kwargs):
    """Activa WAL y busy_timeout en SQLite para mitigar 'database is locked'.

    Solo aplica si el backend es SQLite.
    """
    try:
        if connection.vendor == 'sqlite':
            cursor = connection.cursor()
            try:
                cursor.execute("PRAGMA journal_mode=WAL;")
            except Exception:
                pass
            try:
                cursor.execute("PRAGMA busy_timeout = 5000;")  # 5s
            except Exception:
                pass
            try:
                cursor.execute("PRAGMA synchronous=NORMAL;")
            except Exception:
                pass
    except Exception:
        # No bloquear el arranque si falla aplicar PRAGMA
        pass
