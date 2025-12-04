from django.db import migrations


def uppercase_parts(apps, schema_editor):
    Part = apps.get_model('parts', 'Part')
    fields = ['name', 'catalog_name', 'position']
    batch = []
    for part in Part.objects.all().iterator():
        updated = {}
        for field in fields:
            value = getattr(part, field, None)
            if value:
                upper = value.strip().upper()
                if upper != value:
                    updated[field] = upper
        if updated:
            for field, value in updated.items():
                setattr(part, field, value)
            part.save(update_fields=list(updated.keys()))


class Migration(migrations.Migration):

    dependencies = [
        ('parts', '0028_part_catalog_name_position'),
    ]

    operations = [
        migrations.RunPython(uppercase_parts, migrations.RunPython.noop),
    ]
