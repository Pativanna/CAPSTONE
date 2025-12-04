import csv
import re
import unicodedata
from collections import Counter
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from parts.models import Part


class Command(BaseCommand):
    """
    Restaura la columna Part.details usando la información proveniente de BD_MANUAL.

    Busca coincidencias por (vehiculo, nombre_original) dentro del archivo consolidado y
    reconstruye el bloque multi-línea que describe cada repuesto.
    """

    help = "Importa o reescribe Part.details a partir de los CSV de BD_MANUAL"

    DEFAULT_FILE = "BD_MANUAL/inventario_consolidado_ultimate_v2.csv"

    def add_arguments(self, parser):
        parser.add_argument(
            "--file",
            default=self.DEFAULT_FILE,
            help="Ruta al CSV consolidado (por defecto: %(default)s)",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Calcula los cambios sin escribir en la base de datos",
        )
        parser.add_argument(
            "--limit",
            type=int,
            help="Procesa solo N piezas (útil para depuración)",
        )
        parser.add_argument(
            "--only-missing",
            action="store_true",
            help="Solo intenta rellenar piezas con details vacío o nulo",
        )

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _clean_str(value):
        if value is None:
            return ""
        return str(value).strip()

    @staticmethod
    def _normalize(value):
        text = Command._clean_str(value)
        if not text:
            return ""
        text = unicodedata.normalize("NFKD", text)
        text = "".join(ch for ch in text if not unicodedata.combining(ch))
        text = re.sub(r"\s+", " ", text)
        return text.upper()

    def _load_dataset(self, csv_path: Path):
        if not csv_path.exists():
            raise CommandError(f"El archivo '{csv_path}' no existe.")

        records = {}
        stats = Counter()

        with csv_path.open("r", encoding="utf-8", newline="") as handler:
            reader = csv.DictReader(handler)
            required_cols = {"vehiculo", "nombre_original"}
            if not required_cols.issubset(set(reader.fieldnames or [])):
                raise CommandError(
                    f"El CSV debe incluir las columnas {', '.join(sorted(required_cols))}"
                )

            for row in reader:
                vehiculo = self._clean_str(row.get("vehiculo"))
                nombre = self._clean_str(row.get("nombre_original") or row.get("nombre"))
                if not vehiculo or not nombre:
                    stats["filas_sin_clave"] += 1
                    continue

                key = (self._normalize(vehiculo), self._normalize(nombre))
                if key in records:
                    stats["duplicados"] += 1
                    continue

                records[key] = {
                    "vehiculo": vehiculo,
                    "nombre_original": nombre,
                    "posicion": self._clean_str(row.get("posicion")),
                    "ubicacion": self._clean_str(row.get("ubicacion")),
                    "nota": self._clean_str(row.get("nota")),
                    "observaciones": self._clean_str(row.get("observaciones")),
                }
                stats["filas_validas"] += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Dataset cargado: {stats['filas_validas']} filas válidas "
                f"(duplicados ignorados: {stats.get('duplicados', 0)}, "
                f"sin clave: {stats.get('filas_sin_clave', 0)})"
            )
        )
        return records

    @staticmethod
    def _build_details(record):
        """
        Replica el formato histórico de BD_MANUAL:

            NOMBRE ORIGINAL
            Vehículo: XXX
            Posición: YYY
            Ubicación: ZZZ
            Nota: ...
            Observaciones: ...
        """

        def line(label, value):
            value = value or ""
            return f"{label}: {value}" if value else f"{label}: "

        lines = []
        nombre = record.get("nombre_original") or ""
        if nombre:
            lines.append(nombre)
        lines.append(line("Vehículo", record.get("vehiculo")))
        lines.append(line("Posición", record.get("posicion")))
        lines.append(line("Ubicación", record.get("ubicacion")))
        lines.append(line("Nota", record.get("nota")))
        lines.append(line("Observaciones", record.get("observaciones")))
        return "\n".join(lines)

    def _name_candidates(self, part):
        candidates = []
        for value in [
            getattr(part, "name", "") or "",
            getattr(part, "catalog_name", "") or "",
        ]:
            clean = self._clean_str(value)
            if clean and clean not in candidates:
                candidates.append(clean)

        details = self._clean_str(getattr(part, "details", ""))
        if details:
            first_line = self._clean_str(details.splitlines()[0])
            if first_line and first_line not in candidates:
                candidates.append(first_line)

        return candidates

    def _vehicle_candidates(self, part):
        candidates = []
        auto = getattr(part, "auto", None)
        if not auto:
            return candidates

        base = self._clean_str(auto.brand_model)
        if base:
            candidates.append(base)
        if auto.year:
            combo = self._clean_str(f"{auto.brand_model} {auto.year}".strip())
            if combo and combo not in candidates:
                candidates.append(combo)

        details = self._clean_str(getattr(part, "details", ""))
        if details:
            for line in details.splitlines():
                stripped = line.strip()
                if not stripped or ":" not in stripped:
                    continue
                label, value = stripped.split(":", 1)
                if self._normalize(label) == "VEHICULO":
                    value = self._clean_str(value)
                    if value and value not in candidates:
                        candidates.append(value)
                    break
        return candidates

    def handle(self, *args, **options):
        csv_path = Path(options["file"])
        if not csv_path.is_absolute():
            csv_path = Path(settings.BASE_DIR) / csv_path

        dataset = self._load_dataset(csv_path)
        if not dataset:
            self.stdout.write(self.style.WARNING("No se encontraron registros para importar."))
            return

        qs = Part.objects.select_related("auto").order_by("id")
        if options["only_missing"]:
            qs = qs.filter(Q(details__isnull=True) | Q(details__exact=""))

        limit = options.get("limit")
        if limit:
            qs = qs[:limit]

        dry_run = options["dry_run"]
        stats = Counter()
        missing_samples = []

        for part in qs.iterator(chunk_size=500):
            name_candidates = self._name_candidates(part)
            if not name_candidates:
                stats["sin_nombre"] += 1
                missing_samples.append((part.id, "sin nombre"))
                continue

            vehicle_candidates = self._vehicle_candidates(part)
            if not vehicle_candidates:
                stats["sin_vehiculo"] += 1
                missing_samples.append((part.id, "sin vehiculo"))
                continue

            record = None
            for vehiculo in vehicle_candidates:
                veh_key = self._normalize(vehiculo)
                for nombre in name_candidates:
                    rec = dataset.get((veh_key, self._normalize(nombre)))
                    if rec:
                        record = rec
                        break
                if record:
                    break

            if not record:
                stats["sin_match"] += 1
                missing_samples.append((part.id, f"{vehicle_candidates[0]} | {name_candidates[0]}"))
                continue

            new_details = self._build_details(record)
            if (part.details or "").strip() == new_details.strip():
                stats["sin_cambios"] += 1
                continue

            stats["actualizados"] += 1
            if not dry_run:
                Part.objects.filter(pk=part.pk).update(details=new_details)

        summary = ", ".join(f"{k}={v}" for k, v in sorted(stats.items()))
        if dry_run:
            self.stdout.write(self.style.WARNING(f"[DRY-RUN] {summary or 'Sin cambios'}"))
        else:
            self.stdout.write(self.style.SUCCESS(summary or "Sin cambios"))

        if missing_samples:
            ejemplos = ", ".join(f"id={pid}:{ctx}" for pid, ctx in missing_samples[:10])
            self.stdout.write(
                self.style.HTTP_INFO(
                    f"Piezas sin coincidencia: {stats.get('sin_match', 0)} (ej: {ejemplos})"
                )
            )
