"""Motor sencillo de alertas para eventos de auditoría."""
from __future__ import annotations

from datetime import timedelta
from typing import Iterable

from django.utils import timezone

from .models import EventoSistema, AlertaSistema
from .logging_context import get_context

class AuditAlertEngine:
    """Evalúa reglas simples contra eventos recién creados."""

    RULES = (
        'bulk_delete_piezas',
        'voice_command_failures',
    )

    @classmethod
    def evaluate(cls, evento: EventoSistema):
        for rule_name in cls.RULES:
            handler = getattr(cls, f'_rule_{rule_name}', None)
            if handler:
                handler(evento)

    @staticmethod
    def _create_alert(tipo: str, severidad: AlertaSistema.Severidad, descripcion: str,
                      evento: EventoSistema, datos: dict | None = None):
        ctx = get_context()
        AlertaSistema.objects.create(
            tipo=tipo,
            severidad=severidad,
            descripcion=descripcion,
            metadatos=datos or {},
            evento=evento,
            correlation_id=evento.correlation_id or ctx.get('correlation_id', ''),
            request_id=evento.request_id or ctx.get('request_id', '')
        )

    @classmethod
    def _rule_bulk_delete_piezas(cls, evento: EventoSistema):
        """Dispara alerta si se eliminan demasiadas piezas en una ventana corta."""
        if evento.categoria != EventoSistema.Categoria.PIEZA or evento.accion != 'eliminar_pieza':
            return
        window = timezone.now() - timedelta(minutes=10)
        count = EventoSistema.objects.filter(
            categoria=EventoSistema.Categoria.PIEZA,
            accion='eliminar_pieza',
            timestamp__gte=window,
            usuario=evento.usuario
        ).count()
        if count >= 5:
            cls._create_alert(
                tipo='bulk_delete_piezas',
                severidad=AlertaSistema.Severidad.ALTA,
                descripcion=f"Se eliminaron {count} piezas por {evento.usuario or 'sistema'} en los últimos 10 minutos.",
                evento=evento,
                datos={'contador': count}
            )

    @classmethod
    def _rule_voice_command_failures(cls, evento: EventoSistema):
        """Detecta múltiples errores del motor de voz."""
        if evento.categoria != EventoSistema.Categoria.VOZ or evento.exito:
            return
        window = timezone.now() - timedelta(minutes=5)
        count = EventoSistema.objects.filter(
            categoria=EventoSistema.Categoria.VOZ,
            exito=False,
            timestamp__gte=window
        ).count()
        if count >= 3:
            cls._create_alert(
                tipo='voice_command_failures',
                severidad=AlertaSistema.Severidad.MEDIA,
                descripcion=f"Se registraron {count} errores consecutivos del motor de voz en 5 minutos.",
                evento=evento,
                datos={'contador': count}
            )
