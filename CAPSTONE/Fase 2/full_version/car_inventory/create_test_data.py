"""
Script para crear datos de prueba en el sistema
"""
import os
import django
from datetime import date, timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'car_inventory.settings')
django.setup()

from parts.models import Workshop, Auto, Part

# Limpiar datos existentes
print("Limpiando datos existentes...")
Part.objects.all().delete()
Auto.objects.all().delete()
Workshop.objects.all().delete()

# Crear talleres
print("\nCreando talleres...")
talleres = [
    Workshop(name="Taller Central", direction="Av. Libertador Bernardo O'Higgins 1234, Santiago"),
    Workshop(name="AutoService Express", direction="Calle Los Olivos 567, Providencia"),
    Workshop(name="Mecánica Don Pedro", direction="Av. Grecia 890, Ñuñoa"),
]
Workshop.objects.bulk_create(talleres)
print(f"✓ Creados {len(talleres)} talleres")

# Crear autos
print("\nCreando autos...")
autos = [
    Auto(brand_model="Toyota Yaris", year=2010, color="Gris"),
    Auto(brand_model="Hyundai Accent", year=2015, color="Blanco"),
    Auto(brand_model="Chevrolet Spark", year=2012, color="Rojo"),
    Auto(brand_model="Nissan Versa", year=2018, color="Negro"),
    Auto(brand_model="Suzuki Swift", year=2016, color="Azul"),
    Auto(brand_model="Kia Rio", year=2014, color="Plateado"),
]
Auto.objects.bulk_create(autos)
print(f"✓ Creados {len(autos)} autos")

# Recuperar objetos creados
talleres = list(Workshop.objects.all())
autos = list(Auto.objects.all())

# Crear piezas
print("\nCreando piezas...")
piezas_data = [
    # Toyota Yaris 2010
    {"name": "Motor 1.3L", "auto": autos[0], "workshop": talleres[0], "min_value": 450000, "max_value": 520000, "details": "Motor completo, funcionando perfectamente", "sold": False},
    {"name": "Caja de cambios", "auto": autos[0], "workshop": talleres[0], "min_value": 180000, "max_value": 220000, "details": "Transmisión manual 5 velocidades", "sold": True},
    {"name": "Parachoques delantero", "auto": autos[0], "workshop": talleres[1], "min_value": 35000, "max_value": 45000, "details": "Con pequeños rayones", "sold": False},
    
    # Hyundai Accent 2015
    {"name": "Motor 1.4L", "auto": autos[1], "workshop": talleres[0], "min_value": 550000, "max_value": 650000, "details": "Motor en excelente estado, 80.000 km", "sold": False},
    {"name": "Puerta delantera izquierda", "auto": autos[1], "workshop": talleres[1], "min_value": 75000, "max_value": 95000, "details": "Incluye vidrio y mecanismo elevalunas", "sold": False},
    {"name": "Capot", "auto": autos[1], "workshop": talleres[2], "min_value": 55000, "max_value": 70000, "details": "Sin abolladuras, pintura original", "sold": True},
    {"name": "Radiador", "auto": autos[1], "workshop": talleres[1], "min_value": 45000, "max_value": 60000, "details": "Funcionando correctamente", "sold": False},
    
    # Chevrolet Spark 2012
    {"name": "Motor 1.0L", "auto": autos[2], "workshop": talleres[2], "min_value": 350000, "max_value": 420000, "details": "Motor económico, ideal para ciudad", "sold": True},
    {"name": "Neumáticos 155/70 R13", "auto": autos[2], "workshop": talleres[2], "min_value": 80000, "max_value": 100000, "details": "Set de 4 neumáticos, 60% vida útil", "sold": False},
    {"name": "Faros delanteros", "auto": autos[2], "workshop": talleres[1], "min_value": 25000, "max_value": 35000, "details": "Par de faros completos", "sold": False},
    
    # Nissan Versa 2018
    {"name": "Motor 1.6L", "auto": autos[3], "workshop": talleres[0], "min_value": 750000, "max_value": 850000, "details": "Motor con 60.000 km, como nuevo", "sold": False},
    {"name": "Parachoques trasero", "auto": autos[3], "workshop": talleres[1], "min_value": 45000, "max_value": 60000, "details": "Estado impecable", "sold": False},
    {"name": "Asientos delanteros", "auto": autos[3], "workshop": talleres[2], "min_value": 120000, "max_value": 150000, "details": "Par de asientos en cuero, excelente estado", "sold": True},
    
    # Suzuki Swift 2016
    {"name": "Caja de cambios automática", "auto": autos[4], "workshop": talleres[0], "min_value": 280000, "max_value": 350000, "details": "Transmisión automática CVT", "sold": False},
    {"name": "Sistema de escape completo", "auto": autos[4], "workshop": talleres[2], "min_value": 95000, "max_value": 120000, "details": "Desde colector hasta silenciador", "sold": False},
    
    # Kia Rio 2014
    {"name": "Computadora de motor (ECU)", "auto": autos[5], "workshop": talleres[1], "min_value": 180000, "max_value": 220000, "details": "ECU programada y funcionando", "sold": False},
    {"name": "Bomba de combustible", "auto": autos[5], "workshop": talleres[2], "min_value": 55000, "max_value": 70000, "details": "Bomba con módulo incluido", "sold": True},
    {"name": "Alternador", "auto": autos[5], "workshop": talleres[0], "min_value": 65000, "max_value": 85000, "details": "Alternador 90A", "sold": False},
]

# Crear fechas distribuidas en los últimos 30 días
base_date = date.today()
for i, pieza_dict in enumerate(piezas_data):
    days_ago = (i * 2) % 30
    pieza_dict['date_added'] = base_date - timedelta(days=days_ago)

piezas = [Part(**pieza_dict) for pieza_dict in piezas_data]
Part.objects.bulk_create(piezas)
print(f"✓ Creadas {len(piezas)} piezas")

# Mostrar resumen
print("\n" + "="*50)
print("RESUMEN DE DATOS CREADOS")
print("="*50)
print(f"Talleres: {Workshop.objects.count()}")
print(f"Autos: {Auto.objects.count()}")
print(f"Piezas totales: {Part.objects.count()}")
print(f"  - Disponibles: {Part.objects.filter(sold=False).count()}")
print(f"  - Vendidas: {Part.objects.filter(sold=True).count()}")
print("\n¡Datos de prueba creados exitosamente!")
