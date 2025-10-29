# parts/models.py
from django.db import models

class Workshop(models.Model):
    name = models.CharField(max_length=100)
    direction = models.CharField(max_length=200)

    def __str__(self):
        return self.name


class Auto(models.Model):
    model = models.CharField(max_length=100)
    color = models.CharField(max_length=50)
    date_added = models.DateField(auto_now_add=True)

    def __str__(self):
        return f"{self.model} ({self.color})"



class Part(models.Model):
    name = models.CharField(max_length=100)
    details = models.CharField(max_length=200, blank=True, null=True)
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
        return f"{self.name} ({self.auto.model})"
