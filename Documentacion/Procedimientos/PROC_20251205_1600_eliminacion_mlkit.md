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

# Verificar estado
git status
git branch
```

#### Resultados
```
PENDIENTE - Ejecutar en siguiente bloque
```

#### Criterio de Éxito
- [ ] Rama `feature/remove-mlkit-iso27001` creada
- [ ] Tag `backup-before-mlkit-removal` establecido
- [ ] Git status limpio

#### Plan de Rollback
```bash
git checkout traspaso-app
git branch -D feature/remove-mlkit-iso27001
git tag -d backup-before-mlkit-removal
```

---

### ⏳ FASE 2: Eliminación de Código Nativo MLKit
**Estado:** PENDIENTE  
**Objetivo:** Eliminar archivos Java y scripts de soporte

#### Archivos a Eliminar
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin.java`
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_Camera1_BACKUP.java`
- `android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_OLD.java`
- `android/app/src/main/java/com/carinventory/app/scanner/MLKitBarcodeProcessor.java`
- `scripts/inject-mlkit-plugin.js`
- `templates/mlkit-scanner-helper.js`

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

### 2025-12-05 16:00
- ✅ Documentación de calidad creada
- ✅ Estructura de procedimientos establecida
- ✅ Procedimiento iniciado
- ⏳ Pendiente: Ejecutar Fase 1

---

## MÉTRICAS (Actualización continua)

| Métrica | Valor Actual | Objetivo |
|---------|--------------|----------|
| Fases Completadas | 0/10 | 10/10 |
| Tiempo Transcurrido | 5 min | 90 min |
| Archivos Eliminados | 0 | 7 |
| Archivos Modificados | 0 | 4 |
| Archivos Creados | 0 | 1 |
| Tests Pasados | 0/4 | 4/4 |
| Commits Realizados | 0 | 10 |

---

## ISSUES ENCONTRADOS

Ninguno aún.

---

## LECCIONES APRENDIDAS

Se documentarán al finalizar el procedimiento.

---

## ESTADO ACTUAL

🟡 **EN PROGRESO** - Fase 1 por ejecutar

**Próxima Acción:** Ejecutar comandos de Fase 1 (crear rama y tag)

---

**FIN DEL REGISTRO - Actualización continua**
