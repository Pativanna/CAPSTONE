from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone


class Command(BaseCommand):
    help = "Elimina archivos de log y registros de voz que exceden las políticas de retención."

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Muestra qué archivos se eliminarían sin borrarlos.'
        )
        parser.add_argument(
            '--include-current',
            action='store_true',
            help='Permite eliminar archivos incluso si no tienen extensión de respaldo (usar con precaución).'
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        include_current = options['include_current']

        log_retention_days = getattr(settings, 'LOG_RETENTION_DAYS', 30)
        voice_retention_days = getattr(settings, 'VOICE_LOG_RETENTION_DAYS', 14)
        now = timezone.now()

        log_cutoff = now - timedelta(days=log_retention_days)
        voice_cutoff = now - timedelta(days=voice_retention_days)

        removed = []
        removed += self._purge_directory(
            base_dir=getattr(settings, 'LOG_DIR', Path(settings.BASE_DIR) / 'logs'),
            cutoff=log_cutoff,
            dry_run=dry_run,
            include_current=include_current,
            label='app-log'
        )
        removed += self._purge_directory(
            base_dir=getattr(settings, 'VOICE_LOG_DIR', Path(settings.BASE_DIR) / 'voice_logs'),
            cutoff=voice_cutoff,
            dry_run=dry_run,
            include_current=True,  # archivos de voz siempre se eliminan cuando vencen
            label='voice-log'
        )

        if dry_run:
            self.stdout.write(self.style.WARNING(f"[DRY RUN] {len(removed)} archivos marcados para eliminación."))
        else:
            self.stdout.write(self.style.SUCCESS(f"{len(removed)} archivos eliminados."))

    def _purge_directory(self, base_dir: Path, cutoff, dry_run: bool, include_current: bool, label: str):
        base_dir = Path(base_dir)
        if not base_dir.exists():
            return []

        removed = []
        for item in base_dir.iterdir():
            if not item.is_file():
                continue
            if not include_current and item.suffix == '.jsonl':
                # mantener archivos activos de logging; la rotación se encarga de ellos
                continue
            modified = datetime_from_timestamp(item.stat().st_mtime)
            if modified >= cutoff:
                continue
            removed.append(str(item))
            if dry_run:
                self.stdout.write(f"[DRY RUN] {label}: eliminar {item}")
            else:
                try:
                    item.unlink()
                    self.stdout.write(f"{label}: eliminado {item}")
                except OSError as exc:
                    self.stderr.write(f"No se pudo eliminar {item}: {exc}")
        return removed


def datetime_from_timestamp(ts: float):
    """Helper para compatibilidad con tz-aware conversions."""
    return timezone.datetime.fromtimestamp(ts, tz=timezone.utc)
