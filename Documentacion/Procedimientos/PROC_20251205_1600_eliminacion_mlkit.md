# PROCEDIMIENTO: Eliminación Completa de MLKit según ISO 27001
**ID:** PROC_20251205_1600_eliminacion_mlkit  
**Estado:** EN PROGRESO  
**Responsable:** Sistema Asistente  
**Plan Base:** CHANGE_MANAGEMENT_ISO27001.md

---

## 📖 DOCUMENTOS LEÍDOS

- ✅ `Calidad/CONTROL_DE_CALIDAD.md` (v1.0)
- ✅ `CHANGE_MANAGEMENT_ISO27001.md` (Plan maestro)
- 🔄 **PRÓXIMO PROMPT:** Debo leer estos documentos nuevamente

---

## OBJETIVO

Eliminar completamente la implementación de Google ML Kit y migrar a scanner web 100% basado en ZXing.js, siguiendo el plan ISO 27001 aprobado.

**Clasificación de Riesgo:** ALTO  
**Impacto:** Funcionalidad crítica del negocio  
**Reversibilidad:** Alta (Git rollback en cada fase)

---

## FASES DEL PROCEDIMIENTO

### ✅ FASE 1: Preparación (COMPLETADA)
**Tiempo:** 16:00 - 16:05  
**Objetivo:** Crear rama de trabajo y backup

#### Comandos Ejecutados
```bash
# Crear rama de implementación
git checkout -b feature/remove-mlkit-iso27001

# Crear tag de backup
git tag backup-before-mlkit-removal

# Commit de documentación
git add CHANGE_MANAGEMENT_ISO27001.md Calidad/ Documentacion/
git commit -m "docs: Add ISO 27001 quality control..."
```

#### Resultados
```
✅ Switched to a new branch 'feature/remove-mlkit-iso27001'
✅ Tag backup-before-mlkit-removal created
✅ Commit 176ca36: 4 files changed, 981 insertions(+)
```

#### Criterio de Éxito
- [x] Rama `feature/remove-mlkit-iso27001` creada
- [x] Tag `backup-before-mlkit-removal` establecido
- [x] Documentación committeada

#### Plan de Rollback
```bash
git checkout traspaso-app
git branch -D feature/remove-mlkit-iso27001
git tag -d backup-before-mlkit-removal
```

---

### 🔄 FASE 2: Eliminación de Código Nativo MLKit
**Estado:** EN PROGRESO  
**Tiempo:** 16:05 - 16:15  
**Objetivo:** Eliminar archivos Java y scripts de soporte

#### Archivos a Eliminar
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin.java` (730 líneas)
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_Camera1_BACKUP.java` (275 líneas)
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_OLD.java`
- `android/app/src/main/java/com/carinventory/app/scanner/MLKitBarcodeProcessor.java`
- `scripts/inject-mlkit-plugin.js`
- `templates/mlkit-scanner-helper.js`
- `parts/static/parts/js/mlkit-native-scanner.js` (200 líneas)

---

### ⏳ FASE 3: Actualizar MainActivity.java
**Estado:** PENDIENTE

---

### ⏳ FASE 4: Actualizar build.gradle
**Estado:** PENDIENTE

---

### ⏳ FASE 5: Compilar APK Limpia
**Estado:** PENDIENTE

---

### ⏳ FASE 6: Implementar Scanner Web con ZXing
**Estado:** PENDIENTE

---

### ⏳ FASE 7: Actualizar scan-verify.js
**Estado:** PENDIENTE

---

### ⏳ FASE 8: Actualizar scan_verify.html
**Estado:** PENDIENTE

---

### ⏳ FASE 9: Testing en Staging
**Estado:** PENDIENTE

---

### ⏳ FASE 10: Merge y Deploy
**Estado:** PENDIENTE

---

## REGISTRO DE CAMBIOS

### 2025-12-05 16:00-16:15
- ✅ FASE 1 COMPLETADA: Rama y backup creados (commit 176ca36)
- ✅ FASE 2 COMPLETADA: 7 archivos MLKit eliminados, 2,198 líneas (commit f078380)
- ✅ FASE 3 COMPLETADA: MainActivity.java actualizado (commit 77672a1)
- ✅ FASE 4 COMPLETADA: 6 dependencias eliminadas de build.gradle (commit 258e53e)
- ⏳ FASE 5 PENDIENTE: Compilar APK limpia
- ⏳ FASES 6-10 PENDIENTES: Implementación scanner web

---

## MÉTRICAS (Actualización continua)

| Métrica | Valor Actual | Objetivo |
|---------|--------------|----------|
| Fases Completadas | 4/10 | 10/10 |
| Tiempo Transcurrido | 15 min | 90 min |
| Archivos Eliminados | 7 | 7 |
| Archivos Modificados | 2 | 4 |
| Archivos Creados | 0 | 1 |
| Líneas Eliminadas | 2,198 | ~2,500 |
| Dependencias Eliminadas | 6 | 6 |
| Commits Realizados | 4 | 10 |
| Tests Pasados | 0/4 | 4/4 |

---

## ISSUES ENCONTRADOS

Ninguno aún.

---

## LECCIONES APRENDIDAS

Se documentarán al finalizar el procedimiento.

---

## ESTADO ACTUAL

🟢 **EN PROGRESO** - 40% completado (4/10 fases)

**Última Fase:** Fase 4 - Dependencias eliminadas ✅  
**Próxima Acción:** Fase 5 - Push a GitHub y compilar APK limpia

### Resumen de Eliminación Exitosa
- ✅ 2,198 líneas de código MLKit eliminadas
- ✅ 7 archivos Java/JS removidos
- ✅ 6 dependencias de build removidas
- ✅ MainActivity limpio (sin plugin registration)
- ✅ 4 commits atómicos con rollback disponible

### APK Esperado
- Reducción de tamaño: ~5-8 MB
- Sin dependencias MLKit/CameraX
- Build debería completar sin errores

---

**FIN DEL REGISTRO - Actualización continua**
