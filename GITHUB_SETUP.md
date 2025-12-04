# 🚀 Configuración GitHub Actions - Pasos Siguientes

## ✅ Todo Está Listo

Ya tienes configurado:
- ✅ Capacitor con soporte Android
- ✅ Plugin ML Kit nativo
- ✅ GitHub Actions workflow
- ✅ Estructura de proyecto

## 📋 Pasos para Activar Compilación Automática

### 1. Crear Repositorio en GitHub

Ve a https://github.com/new y crea un repo nuevo:
- **Nombre**: `car-inventory` (o el que prefieras)
- **Visibilidad**: Privado (recomendado) o Público
- **NO** marques "Initialize with README"

### 2. Conectar tu Proyecto al Repositorio

```bash
cd /home/ubuntu/car_inventory

# Inicializar git (si no está inicializado)
git init

# Agregar todo el código
git add .

# Crear commit inicial
git commit -m "feat: Configuración inicial con Capacitor + ML Kit"

# Conectar con GitHub (reemplaza TU-USUARIO con tu usuario de GitHub)
git remote add origin https://github.com/TU-USUARIO/car-inventory.git

# Cambiar a rama main
git branch -M main

# Subir código
git push -u origin main
```

### 3. GitHub Actions Compilará Automáticamente

Después del push, GitHub Actions:
1. Detecta el workflow en `.github/workflows/build-android.yml`
2. Ejecuta compilación automática (~8-10 minutos)
3. Genera APK listo para instalar

**Ver progreso**:
1. Ve a tu repositorio en GitHub
2. Click en pestaña "Actions"
3. Verás el workflow "Build Android APK" ejecutándose

### 4. Descargar tu APK

Cuando termine (ícono verde ✓):
1. Click en el workflow completado
2. Scroll hasta "Artifacts"
3. Descarga `car-inventory-debug.apk`
4. Transfiere a tu celular Android
5. Instala (habilita "Orígenes desconocidos" si pide)

## 🔧 Configurar URL del Servidor

**ANTES de compilar**, actualiza `capacitor.config.json`:

### Opción A: Servidor Local (WiFi)
```bash
# Obtener IP del servidor
ip addr show | grep "inet " | grep -v 127.0.0.1
# Ejemplo: 192.168.1.100
```

Edita `capacitor.config.json`:
```json
{
  "server": {
    "url": "http://192.168.1.100:8000",
    "cleartext": true,
    "androidScheme": "http"
  }
}
```

### Opción B: Servidor con Dominio/IP Pública
```json
{
  "server": {
    "url": "https://tudominio.com",
    "cleartext": false
  }
}
```

### Opción C: Usar ngrok (Desarrollo)
```bash
# Instalar ngrok
sudo snap install ngrok

# Exponer puerto 8000
ngrok http 8000

# Copiar URL que aparece (ej: https://abc123.ngrok.io)
```

Edita `capacitor.config.json`:
```json
{
  "server": {
    "url": "https://abc123.ngrok.io"
  }
}
```

## 📱 Probar la App

1. **Instala el APK** en tu celular Android
2. **Abre la app** "Car Inventory"
3. Debería cargar tu servidor Django
4. **Usa el escáner** → Verás que usa ML Kit nativo (mucho mejor)

## 🔄 Actualizar la App

**Para cambios de código (95% casos)**:
```bash
# 1. Edita tus archivos (JS, CSS, templates, etc)
# 2. Commit y push
git add .
git commit -m "fix: Mejora en scanner"
git push

# 3. La app carga cambios automáticamente (solo pull-to-refresh)
# NO necesitas reinstalar
```

**Para cambios en plugins/configuración (5% casos)**:
```bash
# 1. Edita código
# 2. Commit y push
git add .
git commit -m "feat: Agregar plugin GPS"
git push

# 3. GitHub Actions compila nuevo APK
# 4. Descarga e instala nuevo APK
```

## 🎯 Ventajas de Este Setup

- ✅ **Compilación 100% en la nube** (no usa espacio de tu servidor)
- ✅ **Automatizado** (solo haces push)
- ✅ **Gratis** (GitHub Actions tiene 2000 minutos/mes gratis)
- ✅ **APK siempre disponible** para descargar
- ✅ **No necesitas Android Studio**
- ✅ **Funciona desde cualquier PC**

## 📊 Recursos de GitHub Actions

GitHub te da **GRATIS**:
- 2000 minutos/mes (repo privado)
- Ilimitado (repo público)
- Cada build usa ~8-10 minutos
- Puedes compilar ~200 veces al mes gratis

## 🐛 Troubleshooting

### "Workflow not running"
- Verifica que el archivo esté en `.github/workflows/build-android.yml`
- Revisa la pestaña Actions esté habilitada en Settings

### "Build failed"
- Click en el workflow rojo para ver logs
- Usualmente es por falta de `package-lock.json` → Commit el archivo

### "APK no instala"
- Habilita "Instalar apps de orígenes desconocidos"
- Verifica que sea Android 6.0 o superior

## 🎉 ¡Listo!

Ahora tienes:
- 🚀 Compilación automática en la nube
- 📱 App nativa con ML Kit (como TeaCapps)
- 🔄 Actualizaciones sin reinstalar
- 💰 Gratis y escalable

**Siguiente comando**:
```bash
git push
```

Y espera tu primer APK en GitHub Actions! 🎊
