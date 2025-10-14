from django.contrib import admin
from .models import ESTADO, MODELO_AUTO, TALLER, REPUESTO, POSICION

admin.site.register(ESTADO)
admin.site.register(MODELO_AUTO)
admin.site.register(TALLER)
admin.site.register(REPUESTO)
admin.site.register(POSICION)