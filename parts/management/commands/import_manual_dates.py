import csv
from collections import Counter
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from parts.inventory_models import PiezaInventario


class Command(BaseCommand):
    """
    Usa los CSV dentro de BD_MANUAL para cargar la columna fecha_ingesta_estimada
    (cuando exista) en PiezaInventario.fecha_ingesta_excel.
    """

    help = "Importa fechas desde los CSV de BD_MANUAL hacia PiezaInventario"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dir",
            default="BD_MANUAL",
            help="Directorio que contiene los CSV (por defecto: %(default)s)",
        )
        parser.add_argument(
            "--pattern",
            default="*.csv",
            help="Patrón glob para archivos (por defecto: %(default)s)",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Muestra los cambios pero no los guarda",
        )
        parser.add_argument(
            "--overwrite",
            action="store_true",
            help="Reemplaza fechas existentes (por defecto solo rellena vacíos)",
        )

    # --- Helpers ---------------------------------------------------------
    @staticmethod
    def _parse_timestamp(value):
        """
        Intenta parsear distintos formatos comunes: ISO, con o sin zona, o con 'T'.
        """
        if not value:
            return None
        value = str(value).strip()
        if not value:
            return None
        cleaned = value.replace("T", " ")
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(cleaned)
        except ValueError:
            pass
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(cleaned, fmt)
            except ValueError:
                continue
        return None

    @staticmethod
    def _aware(dt_value):
        if dt_value is None:
            return None
        if timezone.is_naive(dt_value):
            return timezone.make_aware(dt_value, timezone.get_current_timezone())
        return dt_value

    def _collect_dates(self, base_dir, pattern):
        base_path = Path(settings.BASE_DIR) / base_dir
        if not base_path.exists():
            raise CommandError(f"El directorio '{base_path}' no existe.")

        files = sorted(base_path.glob(pattern))
        if not files:
            raise CommandError(f"No se encontraron archivos que coincidan con {pattern} en {base_path}")

        hash_to_date = {}
        stats = Counter()

        for file_path in files:
            with file_path.open("r", encoding="utf-8", newline="") as handler:
                reader = csv.DictReader(handler)
                if not reader.fieldnames:
                    stats["sin_encabezado"] += 1
                    continue
                if "fecha_ingesta_estimada" not in reader.fieldnames:
                    stats["sin_columna_fecha"] += 1
                    continue
                for row in reader:
                    fecha_raw = (row.get("fecha_ingesta_estimada") or "").strip()
                    if not fecha_raw:
                        stats["sin_fecha"] += 1
                        continue
                    hash_val = (row.get("hash_contenido") or "").strip()
                    if not hash_val:
                        stats["sin_hash"] += 1
                        continue
                    parsed = self._parse_timestamp(fecha_raw)
                    if not parsed:
                        stats["fecha_invalida"] += 1
                        continue
                    hash_to_date.setdefault(hash_val, parsed)
                    stats["fechas_cargadas"] += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Fechas recolectadas: {len(hash_to_date)} registros únicos "
                f"(detalles: {', '.join(f'{k}={v}' for k, v in stats.items())})"
            )
        )
        return hash_to_date

    # --- Command ---------------------------------------------------------
    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        overwrite = options["overwrite"]

        hash_map = self._collect_dates(options["dir"], options["pattern"])
        if not hash_map:
            self.stdout.write(self.style.WARNING("No se encontró ninguna fecha para importar."))
            return

        qs = PiezaInventario.objects.filter(hash_contenido__in=hash_map.keys()).only(
            "id", "hash_contenido", "fecha_ingesta_excel"
        )

        stats = Counter()
        to_update = []
        pending_hashes = set(hash_map.keys())

        for pieza in qs.iterator(chunk_size=500):
            pending_hashes.discard(pieza.hash_contenido)
            nueva_fecha = self._aware(hash_map[pieza.hash_contenido])
            if pieza.fecha_ingesta_excel and not overwrite:
                stats["conservar_existente"] += 1
                continue
            if pieza.fecha_ingesta_excel == nueva_fecha:
                stats["sin_cambios"] += 1
                continue
            pieza.fecha_ingesta_excel = nueva_fecha
            to_update.append(pieza)

        if to_update and not dry_run:
            PiezaInventario.objects.bulk_update(to_update, ["fecha_ingesta_excel"], batch_size=500)

        stats["actualizados"] = len(to_update)
        stats["no_encontrados"] = len(pending_hashes)

        summary = ", ".join(f"{k}: {v}" for k, v in sorted(stats.items()))
        if dry_run:
            self.stdout.write(self.style.WARNING(f"[DRY-RUN] {summary}"))
        else:
            self.stdout.write(self.style.SUCCESS(summary))

        if pending_hashes:
            ejemplos = ", ".join(list(pending_hashes)[:10])
            self.stdout.write(
                self.style.HTTP_INFO(
                    f"Hashes sin match en BD (mostrando 10): {ejemplos}"
                )
            )
