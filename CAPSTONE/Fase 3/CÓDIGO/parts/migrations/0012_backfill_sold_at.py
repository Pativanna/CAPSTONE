from django.db import migrations
from django.utils import timezone


def backfill_sold_at(apps, schema_editor):
    Part = apps.get_model('parts', 'Part')
    from django.db.models import F
    # Para registros ya vendidos sin fecha, usar date_added como aproximación
    Part.objects.filter(sold=True, sold_at__isnull=True).update(sold_at=F('date_added'))


class Migration(migrations.Migration):
    dependencies = [
        ('parts', '0011_part_sold_at'),
    ]

    operations = [
        migrations.RunPython(backfill_sold_at, migrations.RunPython.noop),
    ]
