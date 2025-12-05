# CONTROL DE CALIDAD - SISTEMA DE GESTIÓN
## Sistema de Inventario de Autopartes

**Fecha Creación:** 2025-12-05  
**Versión:** 1.0  
**Estado:** ACTIVO

---

## 🔴 INSTRUCCIÓN CRÍTICA PARA EL ASISTENTE

**CADA MENSAJE DEBE COMENZAR CON:**

```
📖 LEÍDO: Calidad/CONTROL_DE_CALIDAD.md (v1.0)
📖 LEÍDO: Documentacion/Procedimientos/[último_procedimiento].md
🔄 SIGUIENTE PROMPT: Debo leer estos documentos nuevamente antes de responder
```

**SI NO SE LEE ESTE DOCUMENTO AL INICIO DEL PROMPT:**
- ❌ La respuesta es INVÁLIDA
- ❌ Se considera fuera de procedimiento
- ❌ Debe comenzarse de nuevo

---

## 1. POLÍTICA DE CALIDAD

### 1.1 Principios Fundamentales
- **Trazabilidad Total:** Todo cambio debe documentarse
- **Validación Continua:** Test antes de deploy
- **Rollback Siempre Disponible:** Cada fase es reversible
- **Documentación Obligatoria:** No hay cambio sin documento

### 1.2 Estándares Aplicables
- **ISO 27001:** Gestión de cambios de software
- **ISO 9001:** Gestión de calidad (adaptado)
- **Git Flow:** Control de versiones
- **Atomic Commits:** Un cambio = un commit

---

## 2. PROCESO DE CONTROL DE CALIDAD

### 2.1 Antes de Cualquier Cambio

#### PASO 1: Leer Documentación Obligatoria
```bash
# El asistente DEBE leer:
cat Calidad/CONTROL_DE_CALIDAD.md
cat Documentacion/Procedimientos/[último_procedimiento].md
```

#### PASO 2: Verificar Contexto
- ¿Qué se va a cambiar?
- ¿Por qué se va a cambiar?
- ¿Qué impacto tiene?
- ¿Hay plan de rollback?

#### PASO 3: Crear Procedimiento
```bash
# Crear nuevo documento en Documentacion/Procedimientos/
# Formato: PROC_YYYYMMDD_HHMM_descripcion.md
```

### 2.2 Durante el Cambio

#### Registro Continuo
- Cada comando ejecutado → documentado
- Cada archivo modificado → listado
- Cada error encontrado → registrado
- Cada decisión tomada → justificada

#### Validación de Fase
- ✅ Criterio de éxito definido
- ✅ Resultado obtenido
- ✅ Comparación exitosa
- ✅ Commit atómico realizado

### 2.3 Después del Cambio

#### Verificación
- [ ] Todos los tests pasan
- [ ] No hay errores en logs
- [ ] Funcionalidad operativa
- [ ] Documentación actualizada

#### Cierre de Procedimiento
- Actualizar documento de procedimiento
- Marcar como COMPLETADO o REVERTIDO
- Registrar métricas
- Lecciones aprendidas

---

## 3. ESTRUCTURA DE DOCUMENTACIÓN

### 3.1 Carpeta Calidad/
```
Calidad/
├── CONTROL_DE_CALIDAD.md (este archivo)
├── metricas/
│   └── YYYY-MM-DD_metricas.md
└── auditorias/
    └── YYYY-MM-DD_auditoria.md
```

### 3.2 Carpeta Documentacion/Procedimientos/
```
Documentacion/Procedimientos/
├── PROC_20251205_1600_eliminacion_mlkit.md
├── PROC_20251205_1700_implementacion_zxing.md
└── README.md (índice de procedimientos)
```

### 3.3 Formato de Procedimiento
```markdown
# PROCEDIMIENTO: [Título]
**ID:** PROC_YYYYMMDD_HHMM
**Estado:** EN PROGRESO / COMPLETADO / REVERTIDO
**Responsable:** Sistema Asistente

## Objetivo
[Descripción clara]

## Cambios Realizados
- Archivo X: modificado líneas Y-Z
- Archivo A: eliminado
- Archivo B: creado

## Comandos Ejecutados
```bash
comando1
comando2
```

## Resultados
- ✅ Éxito / ❌ Fallo
- Logs adjuntos
- Métricas obtenidas

## Rollback (si aplica)
```bash
git revert <hash>
```
```

---

## 4. CHECKLIST DE CALIDAD

### Antes de Cada Cambio
- [ ] Leído CONTROL_DE_CALIDAD.md
- [ ] Leído último procedimiento
- [ ] Plan ISO 27001 consultado
- [ ] Rama de trabajo creada
- [ ] Backup/tag establecido

### Durante Cada Cambio
- [ ] Procedimiento documentándose en tiempo real
- [ ] Commits atómicos
- [ ] Tests ejecutándose
- [ ] Logs monitoreándose

### Después de Cada Cambio
- [ ] Procedimiento cerrado
- [ ] Tests validados
- [ ] Documentación actualizada
- [ ] Métricas registradas

---

## 5. MÉTRICAS DE CALIDAD

### 5.1 Indicadores Clave (KPIs)

| Métrica | Objetivo | Medición |
|---------|----------|----------|
| Tasa de Éxito | > 95% | Cambios exitosos / Total |
| Tiempo de Rollback | < 5 min | Tiempo desde detección a reversión |
| Cobertura de Docs | 100% | Procedimientos documentados / Total |
| Test Coverage | > 80% | Tests pasados / Total casos |

### 5.2 Registro de Métricas
- Cada procedimiento registra sus métricas
- Consolidación mensual en `metricas/`
- Revisión trimestral de tendencias

---

## 6. AUDITORÍAS

### 6.1 Auditoría Interna
**Frecuencia:** Cada 10 procedimientos o mensual

**Verificar:**
- ✅ Todos los procedimientos tienen documentación
- ✅ Todos los commits tienen mensaje descriptivo
- ✅ Todos los cambios tienen tests
- ✅ Todos los rollbacks están documentados

### 6.2 Auditoría de Código
**Herramientas:**
- Git log analysis
- Grep de TODOs pendientes
- Verificación de archivos huérfanos

---

## 7. GESTIÓN DE NO CONFORMIDADES

### 7.1 Clasificación

| Nivel | Descripción | Acción |
|-------|-------------|--------|
| CRÍTICO | Sistema inoperativo | Rollback inmediato |
| ALTO | Funcionalidad clave afectada | Rollback + análisis |
| MEDIO | Funcionalidad secundaria | Fix + documentar |
| BAJO | Cosmético o menor | Registrar para futuro |

### 7.2 Proceso de Resolución
1. Detectar no conformidad
2. Clasificar nivel
3. Ejecutar acción correspondiente
4. Documentar causa raíz
5. Implementar prevención
6. Actualizar procedimientos

---

## 8. MEJORA CONTINUA

### 8.1 Ciclo PDCA (Plan-Do-Check-Act)

**PLAN:** Definir cambio con ISO 27001  
**DO:** Ejecutar según procedimiento  
**CHECK:** Validar contra criterios  
**ACT:** Ajustar proceso si es necesario  

### 8.2 Lecciones Aprendidas
- Cada procedimiento incluye sección "Lecciones"
- Consolidación mensual
- Actualización de este documento

---

## 9. CONTROL DE VERSIONES DE ESTE DOCUMENTO

| Versión | Fecha | Cambios | Autor |
|---------|-------|---------|-------|
| 1.0 | 2025-12-05 16:00 | Creación inicial | Sistema |

---

## 10. RECORDATORIO FINAL

### 🔴 AL INICIO DE CADA PROMPT LEER:
1. `Calidad/CONTROL_DE_CALIDAD.md`
2. `Documentacion/Procedimientos/[último].md`
3. Indicar en respuesta: "He leído estos documentos y en el próximo prompt debo leerlos de nuevo"

### 🔴 SIN LECTURA = SIN ACCIÓN

**FIN DEL DOCUMENTO**
