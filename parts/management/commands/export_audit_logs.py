from __future__ import annotations

import json
import gzip
import os
from datetime import datetime
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from parts.models import EventoSistema


class Command(BaseCommand):
    help = "Exporta eventos de auditoría (EventoSistema) verificando la cadena de hashes."

    def add_arguments(self, parser):
        parser.add_argument('--output-dir', default='backups/audit_exports', help='Directorio destino del JSONL exportado')
        parser.add_argument('--since', help='Fecha inicial (YYYY-MM-DD)')
        parser.add_argument('--limit', type=int, help='Máximo de registros a exportar')
        parser.add_argument('--compress', action='store_true', help='Generar archivo comprimido .gz')
        parser.add_argument('--s3-bucket', help='Nombre de bucket S3 para subir el resultado')
        parser.add_argument('--s3-prefix', default='', help='Prefijo opcional para el objeto en S3')

    def handle(self, *args, **options):
        output_dir = Path(options['output_dir']).expanduser()
        output_dir.mkdir(parents=True, exist_ok=True)
        since = options.get('since')
        limit = options.get('limit')
        compress = options.get('compress')
        bucket = options.get('s3_bucket')
        prefix = options.get('s3_prefix') or ''

        qs = EventoSistema.objects.order_by('timestamp', 'id')
        if since:
            try:
                since_dt = datetime.strptime(since, '%Y-%m-%d')
                since_dt = timezone.make_aware(since_dt)
            except ValueError as exc:
                raise CommandError(f"Formato inválido para --since: {exc}") from exc
            qs = qs.filter(timestamp__gte=since_dt)
        if limit:
            qs = qs[:limit]

        timestamp_str = timezone.now().strftime('%Y%m%d_%H%M%S')
        base_name = f"audit_events_{timestamp_str}.jsonl"
        file_path = output_dir / (base_name + ('.gz' if compress else ''))

        previous_hash = ''
        mismatch = []
        count = 0
        records = qs.iterator()

        if compress:
            opener = lambda path: gzip.open(path, 'wt', encoding='utf-8')
        else:
            opener = lambda path: open(path, 'w', encoding='utf-8')

        with opener(file_path) as handler:
            for event in records:
                count += 1
                if event.hash_previo and previous_hash and event.hash_previo != previous_hash:
                    mismatch.append(event.id)
                payload = {
                    'id': event.id,
                    'timestamp': event.timestamp.isoformat(),
                    'categoria': event.categoria,
                    'accion': event.accion,
                    'descripcion': event.descripcion,
                    'nivel': event.nivel,
                    'usuario_id': event.usuario_id,
                    'pieza_id': event.pieza_id,
                    'sesion_voz_id': event.sesion_voz_id,
                    'datos': event.datos,
                    'exito': event.exito,
                    'error_mensaje': event.error_mensaje,
                    'duracion_ms': event.duracion_ms,
                    'request_id': event.request_id,
                    'correlation_id': event.correlation_id,
                    'hash_previo': event.hash_previo,
                    'hash_actual': event.hash_actual,
                }
                handler.write(json.dumps(payload, ensure_ascii=False) + '\n')
                previous_hash = event.hash_actual

        self.stdout.write(self.style.SUCCESS(f"Exportados {count} eventos a {file_path}"))
        if mismatch:
            self.stdout.write(self.style.WARNING(f"Se detectaron {len(mismatch)} inconsistencias de hash. IDs: {mismatch[:5]}..."))

        if bucket:
            self._upload_to_s3(file_path, bucket, prefix)

    def _upload_to_s3(self, file_path: Path, bucket: str, prefix: str):
        try:
            import boto3  # noqa
        except ImportError:
            raise CommandError("boto3 no está instalado; instálalo para subir a S3.") from None

        s3 = boto3.client('s3')
        key = os.path.join(prefix.rstrip('/'), file_path.name) if prefix else file_path.name
        self.stdout.write(f"Subiendo {file_path} a s3://{bucket}/{key} ...")
        s3.upload_file(str(file_path), bucket, key)
        self.stdout.write(self.style.SUCCESS("Upload a S3 completado"))
