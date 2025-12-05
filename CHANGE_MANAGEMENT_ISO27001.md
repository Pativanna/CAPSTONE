# ISO 27001 - PLAN DE GESTIÓN DE CAMBIOS
## Eliminación Completa de MLKit y Migración a Scanner Web Nativo

**Fecha:** 2025-12-05  
**Responsable:** Sistema de Gestión de Cambios  
**Clasificación:** CAMBIO CRÍTICO - Alto Riesgo  
**Estado:** PLANIFICACIÓN

---

## 1. SOLICITUD DE CAMBIO (Change Request)

### 1.1 Descripción del Cambio
Eliminar completamente la implementación de Google ML Kit para escaneo de códigos de barras y migrar a una solución 100% web basada en ZXing.js que funcione en navegadores móviles sin dependencias nativas.

### 1.2 Justificación
- **Problema Actual:** MLKit plugin no está disponible en Capacitor después de 25+ intentos de compilación
- **Impacto en Negocio:** Funcionalidad de scanner completamente bloqueada
- **Riesgo de No Cambiar:** Sistema de verificación de piezas inoperativo
- **Beneficio Esperado:** Scanner funcional sin dependencias de plugins nativos

### 1.3 Alcance del Cambio
- **Archivos Java a Eliminar:** 4 archivos
- **Archivos JavaScript a Modificar:** 3 archivos  
- **Archivos de Configuración:** build.gradle, MainActivity.java
- **Archivos HTML a Actualizar:** scan_verify.html

---

## 2. EVALUACIÓN DE RIESGOS (Risk Assessment)

### 2.1 Riesgo: ALTO
**Justificación:** Cambio afecta funcionalidad crítica del negocio

### 2.2 Análisis de Impacto

| Área | Impacto | Mitigación |
|------|---------|------------|
| Funcionalidad | Alto - Scanner completo | Implementar ZXing.js con soporte multi-formato |
| Seguridad | Medio - Permisos de cámara | Usar API estándar getUserMedia() |
| Rendimiento | Bajo - Procesamiento en JavaScript | Optimizar con Web Workers si es necesario |
| Compatibilidad | Bajo - Solo navegadores modernos | Validar soporte de getUserMedia |
| Reversibilidad | Alta - Git rollback disponible | Commits atómicos por fase |

### 2.3 Plan de Rollback
```bash
# Si falla en cualquier fase:
git revert <commit-hash>
git push origin traspaso-app
# Rebuild APK anterior desde GitHub Actions
```

---

## 3. PLAN DE PRUEBAS (Testing Plan)

### 3.1 Ambiente de Pruebas
- **Staging:** Servidor web local (http://localhost:8000)
- **Testing Device:** Navegador móvil Android Chrome/Firefox
- **Test Data:** Códigos de barras de prueba (EAN13, Code128, QR)

### 3.2 Casos de Prueba

#### TC-001: Eliminar archivos MLKit sin romper build
- **Pre-condición:** APK compila actualmente
- **Pasos:** Eliminar archivos Java MLKit
- **Esperado:** Build exitoso sin errores
- **Criterio:** GitHub Actions build SUCCESS

#### TC-002: Scanner web detecta códigos EAN13
- **Pre-condición:** Página cargada en móvil
- **Pasos:** Apuntar cámara a código de barras
- **Esperado:** Detección y lectura correcta
- **Criterio:** Código mostrado en pantalla

#### TC-003: Permisos de cámara funcionan
- **Pre-condición:** Primera carga de página
- **Pasos:** Hacer clic en "Iniciar Scanner"
- **Esperado:** Prompt de permisos de navegador
- **Criterio:** Cámara se activa tras aceptar

#### TC-004: Búsqueda de pieza por código
- **Pre-condición:** Código detectado
- **Pasos:** Sistema busca en base de datos
- **Esperado:** Pieza encontrada si existe
- **Criterio:** Resultado mostrado en UI

### 3.3 Registro de Pruebas
Todas las pruebas deben documentarse en `/home/ubuntu/car_inventory/logs/testing_ISO27001.log`

---

## 4. PLAN DE IMPLEMENTACIÓN (Implementation Plan)

### FASE 1: Preparación (5 min)
**Objetivo:** Crear backup y rama de trabajo

```bash
# 1.1 Crear rama de implementación
git checkout -b feature/remove-mlkit-iso27001

# 1.2 Verificar estado actual
git status
docker compose ps

# 1.3 Crear punto de restauración
git tag backup-before-mlkit-removal
```

**Criterio de Éxito:** Rama creada, tag de backup establecido  
**Rollback:** `git checkout traspaso-app && git branch -D feature/remove-mlkit-iso27001`

---

### FASE 2: Eliminación de Código Nativo MLKit (10 min)
**Objetivo:** Eliminar completamente archivos Java y dependencias MLKit

```bash
# 2.1 Eliminar archivos Java
rm android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin.java
rm android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_Camera1_BACKUP.java
rm android/app/src/main/java/com/carinventory/app/MLKitScannerPlugin_OLD.java
rm android/app/src/main/java/com/carinventory/app/scanner/MLKitBarcodeProcessor.java

# 2.2 Eliminar scripts de soporte
rm scripts/inject-mlkit-plugin.js
rm templates/mlkit-scanner-helper.js

# 2.3 Commit atómico
git add -A
git commit -m "phase2: Remove all MLKit Java files and support scripts (ISO 27001)"
```

**Criterio de Éxito:** Archivos eliminados, commit registrado  
**Rollback:** `git revert HEAD`

---

### FASE 3: Actualizar MainActivity.java (5 min)
**Objetivo:** Eliminar registro del plugin MLKit

**Archivo:** `android/app/src/main/java/com/carinventory/app/MainActivity.java`

```java
// ANTES:
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(MLKitScannerPlugin.class); // ← ELIMINAR
    }
}

// DESPUÉS:
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // MLKit plugin removed - using web-based scanner
    }
}
```

```bash
git add MainActivity.java
git commit -m "phase3: Remove MLKitScanner plugin registration (ISO 27001)"
```

**Criterio de Éxito:** Archivo actualizado sin errores de sintaxis  
**Rollback:** `git revert HEAD`

---

### FASE 4: Actualizar build.gradle (5 min)
**Objetivo:** Eliminar dependencias de ML Kit y CameraX

**Archivo:** `android/app/build.gradle`

```gradle
// ELIMINAR estas líneas:
def camerax_version = "1.3.1"
implementation "androidx.camera:camera-core:${camerax_version}"
implementation "androidx.camera:camera-camera2:${camerax_version}"
implementation "androidx.camera:camera-lifecycle:${camerax_version}"
implementation "androidx.camera:camera-view:${camerax_version}"
implementation 'com.google.mlkit:barcode-scanning:17.3.0'
```

```bash
git add build.gradle
git commit -m "phase4: Remove ML Kit and CameraX dependencies (ISO 27001)"
```

**Criterio de Éxito:** Gradle sync exitoso  
**Rollback:** `git revert HEAD`

---

### FASE 5: Compilar APK Limpia (8 min)
**Objetivo:** Verificar que build funciona sin MLKit

```bash
# 5.1 Push a GitHub
git push origin feature/remove-mlkit-iso27001

# 5.2 Crear PR y trigger GitHub Actions
# Esperar resultado del build

# 5.3 Verificar logs de compilación
# Criterio: No errores relacionados a MLKit o CameraX
```

**Criterio de Éxito:** APK compila exitosamente  
**Rollback:** Cerrar PR, volver a rama anterior

---

### FASE 6: Implementar Scanner Web con ZXing (15 min)
**Objetivo:** Reemplazar mlkit-native-scanner.js con implementación web pura

**Archivo:** `parts/static/parts/js/web-barcode-scanner.js` (NUEVO)

```javascript
/**
 * Web-based Barcode Scanner usando ZXing.js
 * NO requiere plugins nativos - 100% navegador
 */

class WebBarcodeScanner {
  constructor() {
    this.stream = null;
    this.codeReader = null;
    this.isScanning = false;
  }

  async initialize() {
    // Importar ZXing.js desde CDN
    if (!window.ZXing) {
      await this.loadZXing();
    }
    this.codeReader = new window.ZXing.BrowserMultiFormatReader();
  }

  async loadZXing() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/@zxing/library@latest';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async checkPermissions() {
    try {
      const result = await navigator.permissions.query({ name: 'camera' });
      return { camera: result.state }; // 'granted', 'denied', 'prompt'
    } catch {
      return { camera: 'prompt' };
    }
  }

  async requestPermissions() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      this.stream.getTracks().forEach(track => track.stop());
      return { camera: 'granted' };
    } catch (error) {
      return { camera: 'denied' };
    }
  }

  async startScan(videoElement, callback) {
    if (this.isScanning) return;
    
    this.isScanning = true;
    
    try {
      await this.codeReader.decodeFromVideoDevice(
        null, // Use default camera
        videoElement,
        (result, error) => {
          if (result) {
            callback({
              value: result.text,
              format: result.format,
              timestamp: Date.now()
            });
          }
        }
      );
    } catch (error) {
      this.isScanning = false;
      throw error;
    }
  }

  async stopScan() {
    if (this.codeReader) {
      this.codeReader.reset();
    }
    this.isScanning = false;
  }

  isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
}

window.WebBarcodeScanner = WebBarcodeScanner;
```

```bash
git add parts/static/parts/js/web-barcode-scanner.js
git commit -m "phase6: Implement web-based barcode scanner with ZXing (ISO 27001)"
```

**Criterio de Éxito:** Archivo creado sin errores  
**Rollback:** `git revert HEAD`

---

### FASE 7: Actualizar scan-verify.js (10 min)
**Objetivo:** Reemplazar lógica MLKit por scanner web

```javascript
// ANTES: Usar MLKitNativeScanner
async function initMLKitScanner() {
  mlKitScanner = new window.MLKitNativeScanner();
  // ...
}

// DESPUÉS: Usar WebBarcodeScanner
async function initWebScanner() {
  if (webScanner) return webScanner;
  
  if (!window.WebBarcodeScanner) {
    console.error('[scanner] WebBarcodeScanner not found');
    return null;
  }
  
  webScanner = new window.WebBarcodeScanner();
  await webScanner.initialize();
  
  if (webScanner.isSupported()) {
    console.log('[scanner] ✅ Web scanner ready');
    return webScanner;
  }
  
  return null;
}
```

```bash
git add parts/static/parts/js/scan-verify.js
git commit -m "phase7: Update scan-verify to use web scanner (ISO 27001)"
```

**Criterio de Éxito:** Sintaxis correcta, no errores de lint  
**Rollback:** `git revert HEAD`

---

### FASE 8: Actualizar scan_verify.html (5 min)
**Objetivo:** Cargar nuevo script de scanner web

```html
<!-- ANTES -->
<script src="{% static 'parts/js/mlkit-native-scanner.js' %}?v=20251205j"></script>

<!-- DESPUÉS -->
<script src="{% static 'parts/js/web-barcode-scanner.js' %}?v=20251205k"></script>
<script src="{% static 'parts/js/scan-verify.js' %}?v=20251205k"></script>
```

```bash
git add parts/templates/parts/scan_verify.html
git commit -m "phase8: Update HTML to load web scanner (ISO 27001)"
```

**Criterio de Éxito:** HTML válido  
**Rollback:** `git revert HEAD`

---

### FASE 9: Testing en Staging (15 min)
**Objetivo:** Validar todos los casos de prueba

```bash
# 9.1 Reiniciar servidor web
docker compose restart web

# 9.2 Ejecutar casos de prueba TC-001 a TC-004
# Documentar resultados en logs/testing_ISO27001.log

# 9.3 Validar:
# - Scanner se carga sin errores
# - Permisos de cámara funcionan
# - Detección de códigos funciona
# - Búsqueda de piezas funciona
```

**Criterio de Éxito:** Todos los test cases pasan  
**Rollback:** Documentar fallas, ejecutar rollback completo

---

### FASE 10: Merge y Deploy a Producción (10 min)
**Objetivo:** Integrar cambios a rama principal

```bash
# 10.1 Merge a traspaso-app
git checkout traspaso-app
git merge feature/remove-mlkit-iso27001

# 10.2 Push a producción
git push origin traspaso-app

# 10.3 Compilar APK final
# Esperar GitHub Actions build

# 10.4 Descargar e instalar APK
# URL: https://github.com/Pativanna/CAPSTONE/actions
```

**Criterio de Éxito:** APK instalada y funcionando en producción  
**Rollback:** `git revert <merge-commit> && git push`

---

## 5. DOCUMENTACIÓN (Documentation)

### 5.1 Archivos Eliminados
- `MLKitScannerPlugin.java` (730 líneas)
- `MLKitScannerPlugin_Camera1_BACKUP.java` (275 líneas)
- `MLKitScannerPlugin_OLD.java` (archivo completo)
- `MLKitBarcodeProcessor.java` (archivo completo)
- `mlkit-native-scanner.js` (200 líneas)
- `inject-mlkit-plugin.js` (archivo completo)
- `mlkit-scanner-helper.js` (archivo completo)

### 5.2 Archivos Nuevos
- `web-barcode-scanner.js` (~120 líneas)

### 5.3 Archivos Modificados
- `MainActivity.java` (eliminada línea de registro)
- `build.gradle` (eliminadas 6 dependencias)
- `scan-verify.js` (lógica de scanner reemplazada)
- `scan_verify.html` (scripts actualizados)

### 5.4 Dependencias Eliminadas
```
- androidx.camera:camera-core:1.3.1
- androidx.camera:camera-camera2:1.3.1
- androidx.camera:camera-lifecycle:1.3.1
- androidx.camera:camera-view:1.3.1
- com.google.mlkit:barcode-scanning:17.3.0
```

### 5.5 Dependencias Nuevas
```
- ZXing.js (CDN): https://unpkg.com/@zxing/library@latest
```

---

## 6. REVISIÓN POST-IMPLEMENTACIÓN (Post-Implementation Review)

### 6.1 Objetivos Cumplidos
- [ ] Scanner funciona sin dependencias nativas
- [ ] APK compila sin errores
- [ ] Detección de códigos de barras operativa
- [ ] Búsqueda de piezas funciona
- [ ] Sin errores en logs de producción

### 6.2 Métricas de Éxito
- **Tiempo de Implementación:** < 90 minutos
- **Test Cases Pasados:** 4/4 (100%)
- **Errores en Producción:** 0
- **Rollbacks Necesarios:** 0

### 6.3 Lecciones Aprendidas
- Documentar en esta sección después de completar implementación

---

## 7. APROBACIÓN

| Rol | Nombre | Fecha | Firma |
|-----|--------|-------|-------|
| Solicitante | Sistema | 2025-12-05 | ✓ |
| Revisor Técnico | Pendiente | - | - |
| Aprobador Final | Usuario | - | - |

---

## 8. CONTROL DE VERSIONES

| Versión | Fecha | Cambios | Autor |
|---------|-------|---------|-------|
| 1.0 | 2025-12-05 | Plan inicial creado | Sistema |

---

**NOTA IMPORTANTE:** Este plan debe seguirse **paso por paso** sin saltarse fases. Cada fase tiene su criterio de éxito y rollback definido. No continuar a la siguiente fase si la anterior falla.
