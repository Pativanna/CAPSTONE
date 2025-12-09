# NOTAS DE DEPLOY - APK y Servidor

## ⚠️ INSTRUCCIÓN PARA IA/COPILOT

**ANTES de implementar cualquier cambio, DEBES leer:**
1. `Calidad/ISO_AUDIT.txt` - Auditoría de cumplimiento ISO
2. `Calidad/PRACTICAS_DESARROLLO.txt` - Patrones y buenas prácticas

---

## Error Común: "Unable to find plugin: ZXingScanner"

### Causa
La APK es un contenedor WebView que carga contenido desde el servidor remoto (`https://www.transervis.cl`). Cuando se hace un build del APK pero NO se actualiza el servidor, la APK nueva carga código viejo que aún tiene referencias a plugins eliminados.

### Solución
**SIEMPRE ejecutar `./aplicar_cambios.sh` ANTES de probar la APK.**

```bash
cd /home/ubuntu/car_inventory
./aplicar_cambios.sh
```

Este script:
1. Hace `git pull` de los últimos cambios
2. Ejecuta `collectstatic` para actualizar archivos estáticos
3. Reinicia los servicios (Django/Daphne/Gunicorn)

### Flujo Correcto de Deploy

1. ✅ Hacer cambios en el código
2. ✅ Commit y push a GitHub
3. ✅ Esperar que GitHub Actions genere el APK
4. ✅ **Ejecutar `./aplicar_cambios.sh` en el servidor**
5. ✅ Descargar e instalar la APK

### Por qué ocurre esto

La arquitectura de la app es:
```
APK (Capacitor WebView) --> carga --> https://www.transervis.cl
```

El APK NO contiene el código de la app, solo:
- El contenedor nativo Android
- Capacitor bridge para comunicación nativa
- Configuración para conectar al servidor

Todo el HTML/JS/CSS se sirve desde el servidor Django.

---
**Fecha:** 2025-12-09
**Última actualización:** Implementación de Lector de Códigos de Barras con ML Kit

---

## Archivos de Calidad

| Archivo | Propósito |
|---------|-----------|
| `ISO_AUDIT.txt` | Auditoría de cumplimiento de normas ISO |
| `PRACTICAS_DESARROLLO.txt` | Patrones de código y buenas prácticas |
| `NOTAS_DEPLOY.md` | Este archivo - Proceso de deploy |
