# PROCEDIMIENTO: Implementación Scanner Web con ZXing.js
**ID:** PROC_20251205_1700_scanner_web_zxing  
**Estado:** INICIANDO  
**Responsable:** Sistema Asistente  
**Plan Base:** CHANGE_MANAGEMENT_ISO27001.md (Fases 6-8)

---

## 📖 DOCUMENTOS LEÍDOS

- ✅ `Calidad/CONTROL_DE_CALIDAD.md` (v1.0)
- ✅ `CHANGE_MANAGEMENT_ISO27001.md` (Fases 6-8)
- ✅ `PROC_20251205_1600_eliminacion_mlkit.md` (precedente)
- 🔄 **PRÓXIMO PROMPT:** Debo leer estos documentos nuevamente

---

## OBJETIVO

Implementar scanner de códigos de barras 100% web usando ZXing.js, reemplazando completamente la lógica de MLKit nativo.

**Clasificación de Riesgo:** ALTO  
**Impacto:** Funcionalidad crítica del negocio  
**Reversibilidad:** Alta (Git rollback disponible)

---

## DIAGNÓSTICO DEL PROBLEMA ACTUAL

### ❌ Error Actual en Logs
```
[scanner] ❌ MLKit plugin not available
Error starting camera: Error: MLKit plugin not available
```

### 🔍 Causa Raíz
1. **APK instalada:** Versión antigua (pre-eliminación MLKit)
2. **HTML carga:** `mlkit-native-scanner.js` (ya no existe en servidor)
3. **JavaScript intenta:** Usar `window.MLKitNativeScanner` (indefinido)
4. **Resultado:** "Escáner no disponible"

### 📋 Archivos que Necesitan Cambio
- ✅ `parts/static/parts/js/mlkit-native-scanner.js` - ELIMINADO (correcto)
- ❌ `parts/static/parts/js/scan-verify.js` - AÚN USA MLKit
- ❌ `parts/templates/parts/scan_verify.html` - AÚN CARGA mlkit-native-scanner.js

---

## FASES DEL PROCEDIMIENTO

### 🔄 FASE 6: Implementar Scanner Web con ZXing
**Estado:** EN PROGRESO  
**Objetivo:** Crear `web-barcode-scanner.js` con ZXing.js

#### Archivos a Crear
- `parts/static/parts/js/web-barcode-scanner.js` (NUEVO)

#### Funcionalidad Requerida
- Detección de códigos: EAN13, Code128, QR
- Acceso a cámara: `navigator.mediaDevices.getUserMedia()`
- Sin dependencias nativas
- Compatible con Capacitor WebView

---

### ⏳ FASE 7: Actualizar scan-verify.js
**Estado:** PENDIENTE  
**Objetivo:** Reemplazar lógica MLKit por scanner web

#### Cambios Necesarios
- Eliminar: `initMLKitScanner()`
- Agregar: `initWebScanner()`
- Reemplazar: Todas las referencias a `MLKitNativeScanner`

---

### ⏳ FASE 8: Actualizar scan_verify.html
**Estado:** PENDIENTE  
**Objetivo:** Cargar nuevo script de scanner web

#### Cambios Necesarios
- Eliminar: `<script src="mlkit-native-scanner.js">`
- Agregar: `<script src="web-barcode-scanner.js">`
- Agregar: Elemento `<video>` para preview de cámara

---

## REGISTRO DE CAMBIOS

### 2025-12-05 17:05
- ✅ Procedimiento creado
- ✅ Diagnóstico completado
- ⏳ FASE 6: Iniciar implementación de web-barcode-scanner.js

---

## MÉTRICAS

| Métrica | Valor Actual | Objetivo |
|---------|--------------|----------|
| Fases Completadas | 0/3 | 3/3 |
| Archivos Creados | 0 | 1 |
| Archivos Modificados | 0 | 2 |
| Tests Pasados | 0/3 | 3/3 |

---

## ESTADO ACTUAL

🟡 **INICIANDO** - Análisis completado, listo para implementación

**Próxima Acción:** Crear `web-barcode-scanner.js` con ZXing.js

---

**FIN DEL REGISTRO**
