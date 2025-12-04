from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('parts', '0022_remove_voicesession_captura_iniciada_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='PartPhoto',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('image', models.ImageField(upload_to='part_photos/')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('source', models.CharField(default='manual', help_text='Origen de la foto (ej: handsfree)', max_length=50)),
                ('part', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='photos', to='parts.part')),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
    ]
