# Diagnóstico: App Móvil con ML Kit Scanner

## Estado Actual

### ✅ Configuración Correcta
1. **Plugin Nativo registrado**: `MLKitScannerPlugin.java` con `@CapacitorPlugin(name = "MLKitScanner")`
2. **MainActivity registra el plugin**: `registerPlugin(MLKitScannerPlugin.class)`
3. **Capacitor config apunta al servidor**: `"url": "https://www.transervis.cl"`
4. **CORS configurado**: `capacitor://localhost` permitido
5. **Template tiene el script**: `scan_verify.html` carga `mlkit-native-scanner.js`
6. **Vista habilita MLKit**: `mlkit_enabled: True`

### ❓ Puntos a Verificar

## 1. ¿La app carga la página web?

**Síntoma**: Pantalla en blanco
**Causa posible**: 
- Problema de red
- CORS bloqueado
- Certificado SSL no confiable

**Verificar**:
```bash
# En Android Studio Logcat:
adb logcat | grep -i capacitor
adb logcat | grep -i webview
adb logcat | grep -i mlkit
```

**Solución**:
- Si ves errores CORS → Verificar que servidor tiene CORS actualizado
- Si ves errores SSL → Agregar excepción para dominio en `network_security_config.xml`

## 2. ¿La página carga pero escáner no funciona?

**Síntoma**: Página carga OK, pero al abrir escáner no pasa nada
**Causa posible**: Plugin no está disponible en `window.Capacitor.Plugins`

**Verificar en Chrome DevTools Remote**:
1. Conectar celular via USB
2. Abrir Chrome → `chrome://inspect`
3. En console ejecutar:
```javascript
console.log(window.Capacitor);
console.log(window.Capacitor.Plugins);
console.log(window.Capacitor.Plugins.MLKitScanner);
```

**Esperado**:
```javascript
{
  MLKitScanner: {
    checkPermissions: f(),
    requestPermissions: f(),
    startScan: f(),
    stopScan: f()
  }
}
```

## 3. ¿Plugin está pero no se llama?

**Síntoma**: Plugin existe en Capacitor.Plugins pero no se ejecuta
**Causa posible**: JavaScript no detecta que está en app nativa

**Verificar en scan_verify.html línea 7**:
```html
<div ... data-mlkit-enabled="true">
```

**Y en mlkit-native-scanner.js línea 25**:
```javascript
console.log('[MLKitScanner] Capacitor available, platform:', window.Capacitor.getPlatform());
```

**Debe mostrar**: `platform: android`

## 4. Pasos de Diagnóstico Completos

### A. Verificar que APK tenga archivos correctos

```bash
# Extraer APK
unzip app-debug.apk -d extracted/

# Verificar assets
ls -la extracted/assets/public/
cat extracted/assets/capacitor.config.json | grep server

# Debe mostrar:
# "server": { "url": "https://www.transervis.cl" }
```

### B. Conectar Chrome DevTools

1. Habilitar depuración USB en celular
2. Conectar cable USB
3. Chrome → `chrome://inspect`
4. Click en "inspect" bajo tu app
5. En console verificar:

```javascript
// 1. Verificar Capacitor
window.Capacitor.getPlatform() // debe ser 'android'

// 2. Verificar plugins disponibles
Object.keys(window.Capacitor.Plugins)

// 3. Verificar MLKitScanner específicamente
window.Capacitor.Plugins.MLKitScanner

// 4. Probar llamada directa
await window.Capacitor.Plugins.MLKitScanner.checkPermissions()
```

### C. Ver logs nativos

```bash
# Terminal conectado al celular
adb logcat | grep -E "(Capacitor|MLKit|Scanner)"

# Buscar líneas como:
# - "Plugin initialized successfully"
# - "MLKitScanner registered"
# - "Starting scan"
# - Errores de permisos
```

## 5. Problemas Comunes y Soluciones

### Problema 1: "Plugin NOT found in Capacitor.Plugins"
**Causa**: Plugin no compilado o no registrado
**Solución**:
```bash
cd android
./gradlew clean
./gradlew assembleDebug
```

### Problema 2: "SecurityException: Camera permission denied"
**Causa**: Permisos no otorgados
**Solución**: 
- Verificar que app pida permisos
- Verificar en Configuración → Apps → Car Inventory → Permisos

### Problema 3: "ERR_CLEARTEXT_NOT_PERMITTED"
**Causa**: Android bloqueando HTTP
**Verificación**: Buscar en logcat
**Solución**: Ya está aplicada en `AndroidManifest.xml` (`usesCleartextTraffic="true"`)

### Problema 4: Página en blanco
**Causa**: CORS bloqueado o certificado SSL
**Verificación**: 
```bash
adb logcat | grep -i "cors\|ssl\|certificate"
```
**Solución**: 
- Verificar CORS en servidor Django está actualizado
- Agregar excepción SSL si es necesario

## 6. Verificación Final Pre-Build

Antes de generar APK, verificar localmente:

```bash
# 1. Verificar que index.html correcto esté en parts/static/
cat parts/static/index.html | grep -A5 "<body>"

# 2. Hacer collectstatic
FORCE_SQLITE=true DEBUG=True ALLOW_DEV_SECRET=true python manage.py collectstatic --noinput --clear

# 3. Verificar que se copió
ls -la staticfiles/index.html

# 4. Sync Capacitor
npx cap sync android

# 5. Verificar assets copiados
ls -la android/app/src/main/assets/public/index.html
cat android/app/src/main/assets/capacitor.config.json | grep server

# 6. Build APK
cd android
./gradlew assembleDebug
```

## 7. Siguiente Paso

Una vez descargues la APK de GitHub Actions:

1. **Instalar en celular**
2. **Abrir la app**
3. **¿Qué ves?**
   - [ ] Pantalla completamente en blanco
   - [ ] Loading spinner "Cargando Car Inventory..."
   - [ ] Página web carga correctamente
   - [ ] Página carga pero al abrir escáner no funciona

4. **Conectar Chrome DevTools** y ejecutar verificaciones de la sección B

5. **Reportar resultados** con screenshots de:
   - Console de Chrome DevTools
   - Logs de `adb logcat`
   - Pantalla de la app

---

## Resumen

El sistema está configurado correctamente en teoría:
- ✅ Plugin nativo compilado
- ✅ Capacitor config con server.url
- ✅ CORS permitido
- ✅ Template con script correcto

**Lo que falta verificar**: ¿Qué está pasando realmente en el dispositivo?

Necesitamos logs de ejecución real para diagnosticar si es:
- Problema de carga (red/CORS/SSL)
- Problema de plugin (no registrado)
- Problema de lógica (no se llama al plugin)
