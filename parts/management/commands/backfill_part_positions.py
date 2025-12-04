import re

from django.core.management.base import BaseCommand
from django.db.models import Q

from parts.models import Part


class Command(BaseCommand):
    """
    Intenta completar Part.position y Part.catalog_name a partir del campo details,
    que en la importación desde BD_MANUAL suele contener líneas como:

        VIDRIO PUERTA DELANTERA LH
        Vehículo: IQ 2019
        Posición: Izquierda Delantera
        ...
    """

    help = "Extrae la posición (y opcionalmente nombre catálogo) desde Part.details"

    POS_PATTERN = re.compile(r"posici[oó]n\s*:\s*(.+)", re.IGNORECASE)

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Muestra cuántos registros se actualizarían sin guardar cambios",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        updated_position = 0
        updated_catalog = 0

        queryset = Part.objects.filter(
            Q(position__isnull=True) | Q(position__exact="") | Q(catalog_name__isnull=True) | Q(catalog_name__exact="")
        )

        for part in queryset.iterator(chunk_size=500):
            if not part.details:
                continue

            lines = [line.strip() for line in part.details.splitlines() if line.strip()]
            if not lines:
                continue

            new_catalog = None
            if not part.catalog_name:
                first_line = lines[0]
                # Evitar repetir el mismo nombre ya existente
                if first_line.lower() != (part.name or "").lower():
                    new_catalog = first_line.title()

            new_position = None
            if not part.position:
                for line in lines:
                    match = self.POS_PATTERN.search(line)
                    if match:
                        candidate = match.group(1).strip(" .")
                        if candidate:
                            new_position = candidate
                            break

            if not new_position and not new_catalog:
                continue

            if new_position:
                part.position = new_position
                updated_position += 1
            if new_catalog:
                part.catalog_name = new_catalog
                updated_catalog += 1

            if not dry_run:
                fields = []
                if new_position:
                    fields.append("position")
                if new_catalog:
                    fields.append("catalog_name")
                part.save(update_fields=fields)

        summary = f"positions: {updated_position}, catalog_names: {updated_catalog}"
        if dry_run:
            self.stdout.write(self.style.WARNING(f"[DRY-RUN] {summary}"))
        else:
            self.stdout.write(self.style.SUCCESS(summary))
