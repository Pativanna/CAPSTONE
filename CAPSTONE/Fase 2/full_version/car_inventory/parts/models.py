# parts/models.py
from django.db import models

class Workshop(models.Model):
    name = models.CharField(max_length=100, verbose_name="Nombre")
    direction = models.CharField(max_length=200, verbose_name="Dirección")

    def __str__(self):
        return self.name


class Auto(models.Model):
    brand_model = models.CharField(max_length=100, verbose_name="Marca y Modelo")
    year = models.PositiveIntegerField(verbose_name="Año")
    color = models.CharField(max_length=50)
    date_added = models.DateField(auto_now_add=True)

    class Meta:
        ordering = ['-year', 'brand_model']

    def __str__(self):
        # Mostrar solo marca/modelo y año para etiquetas y selects
        return f"{self.brand_model} ({self.year})"



class Part(models.Model):
    name = models.CharField(max_length=100)
    # Usar TextField para no truncar y guardar todos los detalles literalmente
    details = models.TextField(blank=True, null=True)
    date_added = models.DateField(auto_now_add=True)

    # 🟢 Defaults
    sold = models.BooleanField(default=False)  # 0 = not sold
    state = models.BooleanField(default=True)  # 1 = active/available
    max_value = models.PositiveIntegerField(default=0)
    min_value = models.PositiveIntegerField(default=0)

    # relations
    auto = models.ForeignKey('Auto', on_delete=models.CASCADE, related_name='parts')
    workshop = models.ForeignKey('Workshop', on_delete=models.CASCADE, related_name='parts')

    def __str__(self):
        return f"{self.name} ({self.auto.brand_model} {self.auto.year})"
