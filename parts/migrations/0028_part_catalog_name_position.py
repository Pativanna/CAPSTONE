from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('parts', '0027_importacioninventario_correccionortografica_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='part',
            name='catalog_name',
            field=models.CharField(blank=True, help_text="Valor curado desde BD manual (columna 'nombre')", max_length=150, null=True, verbose_name='Nombre catálogo'),
        ),
        migrations.AddField(
            model_name='part',
            name='position',
            field=models.CharField(blank=True, help_text='Lado/posición exacta según BD manual', max_length=80, null=True, verbose_name='Posición'),
        ),
    ]
