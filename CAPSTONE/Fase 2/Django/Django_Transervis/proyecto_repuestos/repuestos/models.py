from django.db import models

class ESTADO(models.Model):
    id_estado = models.AutoField(primary_key=True)
    nombre_estado = models.CharField(max_length=40)

    def __str__(self):
        return self.nombre_estado
    
class MODELO_AUTO(models.Model):
    id_modelo = models.AutoField(primary_key=True)
    nombre_modelo = models.CharField(max_length=200)
    año = models.IntegerField()

    def __str__(self):
        return f"{self.nombre_modelo} ({self.año})"

class TALLER(models.Model):
    id_taller = models.AutoField(primary_key=True)
    nombre_taller = models.CharField(max_length=100)
    dirrecion = models.CharField(max_length=400)

    def __str__(self):
        return self.nombre_taller
    
class POSICION(models.Model):
    id_posicion = models.AutoField(primary_key=True)
    nombre_posicion = models.CharField(max_length=100)

    def __str__(self):
        return self.nombre_posicion
    
class REPUESTO(models.Model):
    id_repuesto = models.AutoField(primary_key=True)
    nombre_repuesto = models.CharField(max_length=200)
    fec_ingreso = models.DateField(blank=True, null=True)
    notas = models.TextField(blank=True)
    id_estado = models.ForeignKey(ESTADO, on_delete=models.CASCADE)
    id_modelo = models.ForeignKey(MODELO_AUTO, on_delete=models.CASCADE)
    id_taller = models.ForeignKey(TALLER, on_delete=models.CASCADE)
    id_posicion = models.ForeignKey(POSICION, on_delete=models.CASCADE)

    def __str__(self):
        return self.nombre_repuesto
#aquí
class REPUESTO_VENTA(models.Model):
    id_repuesto_venta = models.AutoField(primary_key=True)
    id_repuesto = models.ForeignKey()
    fec_venta = models.DateField(blank=True, null=True)
    precio = models.DecimalField(max_digits=12, decimal_places=2, default=0, null=True)
    ultimo_precio = models.DecimalField(max_digits=12, decimal_places=2, default=0, null=True)