# Migración del Escáner de Códigos de Barras - Documentación

**Fecha**: 2025-12-09  
**Estado**: Implementación limpia con ML Kit  
**Proyecto de prueba**: https://github.com/Pativanna/scanner-test

---

## Resumen Ejecutivo

Después de múltiples intentos fallidos con ZXing y problemas de integración con Capacitor, se realizó una prueba aislada creando una app Android nativa mínima (`scanner-test`) que probó dos enfoques:

1. **ZXing** (biblioteca open-source de códigos de barras)
2. **ML Kit** (solución on-device de Google)

**Resultado**: Ambos funcionaron en la app de prueba, pero **ML Kit demostró ser más confiable y rápido**. Se decidió implementar únicamente ML Kit en el proyecto principal.

---

## Problemas Identificados con la Implementación Anterior

### 1. Arquitectura Compleja
- Plugin Capacitor personalizado (`ZXingScannerPlugin`) con demasiada lógica UI
- Múltiples capas de abstracción innecesarias (`BarcodeProcessor`, `CameraSource`, `FrameMetadata`)
- Bridge JavaScript complejo para comunicación Capacitor ↔ nativo

### 2. Problemas de Integración
- El plugin se registraba pero la cámara no se mostraba
- Conflictos entre el WebView de Capacitor y la preview de cámara nativa
- Logs indicaban inicialización exitosa pero la UI no respondía

### 3. Ciclo de Desarrollo Lento
- 5-7 minutos por build + prueba
- Difícil depurar sin poder aislar el problema

---

## Solución: App de Prueba Aislada

Se creó `scanner-test` (repo separado) con:
- Android puro (sin Capacitor)
- Dos botones: "Escanear con ZXing" y "Escanear con ML Kit"
- CameraX para preview de cámara
- Código mínimo y directo

**Resultado**: Ambos métodos funcionaron perfectamente, confirmando que:
- El código Java base era correcto
- El problema estaba en la integración con Capacitor

---

## Nueva Implementación: ML Kit Limpio

### Archivos Eliminados (Implementación Antigua)
```
android/app/src/main/java/com/carinventory/app/
├── ZXingScannerPlugin.java          # Plugin Capacitor antiguo
└── scanner/
    ├── BarcodeProcessor.java        # Interface abstracta
    ├── ZXingBarcodeProcessor.java   # Procesador ZXing
    ├── CameraSource.java            # Fuente de cámara legacy
    ├── CameraSourcePreview.java     # Preview legacy
    └── FrameMetadata.java           # Metadata de frames

parts/static/parts/js/
├── zxing-native-scanner.js          # Bridge JS para ZXing
├── zxing-plugin-register.js         # Registro del plugin
├── scan-verify-OLD-web-version.js   # Versión web antigua
└── vendor/zxing-index.min.js        # Biblioteca ZXing JS
```

### Archivos Nuevos (ML Kit)
```
android/app/src/main/java/com/carinventory/app/
└── MLKitScannerPlugin.java          # Plugin Capacitor limpio

parts/static/parts/js/
└── mlkit-native-scanner.js          # Bridge JS para ML Kit (actualizado)
```

### Dependencias en build.gradle
```gradle
// ELIMINADO:
// implementation 'com.google.zxing:core:3.5.3'

// AGREGADO:
implementation 'com.google.mlkit:barcode-scanning:17.2.0'

// MANTENIDO (CameraX):
def camerax_version = "1.3.1"
implementation "androidx.camera:camera-core:${camerax_version}"
implementation "androidx.camera:camera-camera2:${camerax_version}"
implementation "androidx.camera:camera-lifecycle:${camerax_version}"
implementation "androidx.camera:camera-view:${camerax_version}"
```

---

## Ventajas de ML Kit sobre ZXing

| Aspecto | ZXing | ML Kit |
|---------|-------|--------|
| Mantenimiento | Comunidad | Google oficial |
| Velocidad | Moderada | Rápida |
| Precisión | Buena | Excelente |
| Tamaño APK | +500KB | +2MB (modelo incluido) |
| Rotación auto | Manual | Automática |
| Formatos | Muchos | Todos los comunes |

---

## Formatos de Código Soportados

- EAN-13, EAN-8
- UPC-A, UPC-E
- Code 128, Code 39
- QR Code
- Data Matrix

---

## Flujo de Escaneo (Nueva Implementación)

1. Usuario toca botón "Escanear" en la app web
2. JavaScript llama a `Capacitor.Plugins.MLKitScanner.startScan()`
3. Plugin nativo abre Activity con CameraX + ML Kit
4. ML Kit procesa frames en tiempo real
5. Al detectar código, emite evento `barcodeScanned`
6. JavaScript recibe el código y actualiza la UI
7. Usuario confirma o cancela

---

## Comandos Útiles

```bash
# Build local (requiere Android SDK)
cd android && ./gradlew assembleDebug

# Build via GitHub Actions
gh workflow run build-android.yml --ref traspaso-app

# Ver logs del último build
gh run view --log

# Descargar APK del último build exitoso
gh run download
```

---

## Próximos Pasos

1. ✅ Documentar cambios (este archivo)
2. ✅ Eliminar código ZXing antiguo
3. 🔄 Implementar MLKitScannerPlugin limpio
4. 🔄 Actualizar mlkit-native-scanner.js
5. 🔄 Probar en dispositivo
6. 🔄 Integrar con flujo de verificación de partes

---

## Referencias

- [ML Kit Barcode Scanning](https://developers.google.com/ml-kit/vision/barcode-scanning)
- [CameraX Overview](https://developer.android.com/training/camerax)
- [Capacitor Plugins Guide](https://capacitorjs.com/docs/plugins)
- [Scanner Test App](https://github.com/Pativanna/scanner-test)
