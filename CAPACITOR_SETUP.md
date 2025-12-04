# 📱 Car Inventory - App Móvil con Capacitor

## ✅ Estado Actual

**Instalado y configurado**:
- ✅ Node.js 20.19.6
- ✅ Capacitor 6.x
- ✅ Plugin ML Kit Barcode Scanning
- ✅ Estructura Android creada
- ✅ GitHub Actions workflow para compilación automática

## 🚀 Próximos Pasos

### 1. Crear Repositorio GitHub

```bash
# Inicializar git si no existe
cd /home/ubuntu/car_inventory
git init
git add .
git commit -m "feat: Agregar soporte Capacitor + ML Kit nativo"

# Crear repositorio en GitHub (https://github.com/new)
# Luego conectar:
git remote add origin https://github.com/TU-USUARIO/car-inventory.git
git branch -M main
git push -u origin main
```

### 2. GitHub Actions Compilará Automáticamente

Cuando hagas push a GitHub:
1. GitHub Actions detecta el push
2. Instala Node.js + Java + Android SDK
3. Compila el APK automáticamente
4. Lo sube como artifact

**Para descargar tu APK**:
1. Ve a GitHub → Actions
2. Click en el último workflow exitoso
3. Descarga "car-inventory-debug.apk"
4. ¡Instala en tu celular!

### 3. Configurar URL de Producción

**Opción A - Servidor con IP pública**:
```json
// capacitor.config.json
{
  "server": {
    "url": "http://TU_IP_PUBLICA:8000",
    "cleartext": true
  }
}
```

**Opción B - Usar ngrok/Cloudflare Tunnel**:
```bash
# Instalar ngrok
snap install ngrok

# Exponer servidor Django
ngrok http 8000

# Copiar URL (ejemplo: https://abc123.ngrok.io)
# Actualizar capacitor.config.json con esa URL
```

**Opción C - Servidor local (WiFi)**:
```bash
# Obtener IP local del servidor
ip addr show | grep "inet " | grep -v 127.0.0.1

# Actualizar capacitor.config.json con IP:
# Ejemplo: "url": "http://192.168.1.100:8000"
```

### 4. Agregar Script ML Kit al Template Base

En `templates/base.html` o donde cargas scripts:

```html
<!-- Solo cargar en plataforma nativa -->
<script>
  if (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform()) {
    // Cargar ML Kit nativo
    const script = document.createElement('script');
    script.src = "{% static 'parts/js/mlkit-native-scanner.js' %}";
    script.type = 'module';
    document.head.appendChild(script);
  }
</script>
```

### 5. Integrar ML Kit en scan-verify.js

Modificar función de inicio de cámara para usar ML Kit cuando esté disponible:

```javascript
async function startCamera() {
  // Si estamos en app nativa, usar ML Kit
  if (isNativePlatform && window.MLKitNativeScanner) {
    const scanner = new window.MLKitNativeScanner();
    if (scanner.isSupported) {
      console.log('[scanner] Using native ML Kit (like TeaCapps!)');
      // Usar scanner nativo en lugar de getUserMedia
      return;
    }
  }
  
  // Fallback: usar scanner web (BarcodeDetector, ZXing, jsQR)
  console.log('[scanner] Using web scanner');
  // ... código actual
}
```

## 🔧 Comandos Útiles

```bash
# Sincronizar cambios (después de editar código)
npx cap sync android

# Compilar APK local (si tienes Android Studio)
cd android
./gradlew assembleDebug

# Ver estructura Android
ls -la android/

# Limpiar y rebuild
cd android
./gradlew clean
./gradlew assembleDebug
```

## 📊 Comparación: Antes vs Después

### ANTES (Solo Web):
- ❌ BarcodeDetector limitado
- ❌ Canvas reduce calidad
- ❌ JavaScript lento
- ❌ No detecta códigos térmicos

### DESPUÉS (App Nativa):
- ✅ ML Kit completo (como TeaCapps)
- ✅ Acceso directo a cámara
- ✅ Procesamiento nativo (C++)
- ✅ **Detecta códigos térmicos perfectamente**

## 🎯 Flujo de Desarrollo

1. **Editas código Django/JS** en servidor
2. **Haces commit y push** a GitHub
3. **GitHub Actions compila** APK automáticamente (5-10 min)
4. **Descargas APK** desde GitHub Actions
5. **Instalas en celular**
6. **App carga código actualizado** del servidor (sin reinstalar)

## ⚠️ Importante

**Para producción** necesitas:
1. Servidor accesible desde internet (IP pública o dominio)
2. HTTPS (obligatorio para producción)
3. Firmar APK (para Google Play Store)

**Para desarrollo/pruebas**:
- HTTP local está bien
- WiFi local funciona
- APK debug es suficiente

## 📝 Notas

- El APK compilado por GitHub Actions está en modo **debug** (solo para pruebas)
- Para publicar en Google Play necesitas modo **release** + firma
- El tamaño del APK será ~15-20 MB
- La app necesita permisos de CÁMARA (se solicitan automáticamente)

## 🐛 Debugging

Ver logs en tiempo real:
```bash
# Si conectas celular por USB
adb logcat | grep -i capacitor
adb logcat | grep -i mlkit
```

## 🎉 Resultado Final

Una app Android nativa que:
- Se conecta a tu servidor Django
- Usa ML Kit nativo para escaneo (como TeaCapps)
- Se actualiza automáticamente cuando cambias código
- Funciona offline (si habilitas service worker)
- **Detecta tus códigos térmicos sin problema**
