#!/bin/bash
# Build Android APK usando Docker con ambiente completo de Android SDK
# Soluciona el problema de AAPT2 en ambientes con glibc incompatible

set -e

echo "🏗️  Building Android APK using Docker..."
echo ""

# Verificar que Docker esté instalado
if ! command -v docker &> /dev/null; then
    echo "❌ Docker no está instalado"
    echo "Instalar con: sudo apt-get install docker.io"
    exit 1
fi

# Crear Dockerfile temporal
cat > /tmp/Dockerfile.android-build << 'EOF'
FROM cimg/android:2024.01.1

# Actualizar SDK
RUN yes | sdkmanager --licenses
RUN sdkmanager "build-tools;34.0.0" "platforms;android-34"

WORKDIR /project

# Copiar proyecto
COPY . .

# Dar permisos a gradlew
RUN chmod +x android/gradlew

# Limpiar y sincronizar
RUN npx cap sync android || true

# Build APK
WORKDIR /project/android
RUN ./gradlew clean assembleDebug

# Copiar APK a output
RUN mkdir -p /output && \
    cp app/build/outputs/apk/debug/app-debug.apk /output/ || \
    echo "APK not found"
EOF

echo "📦 Dockerfile creado en /tmp/Dockerfile.android-build"
echo ""

# Build imagen Docker
echo "🔨 Building Docker image..."
cd /home/ubuntu/car_inventory
docker build -f /tmp/Dockerfile.android-build -t carinventory-android-builder .

echo ""
echo "🚀 Running build..."
# Extraer APK
docker run --rm \
  -v "$(pwd)/android/app/build:/build" \
  carinventory-android-builder \
  bash -c "cp /output/app-debug.apk /build/ && echo '✅ APK copied to android/app/build/'"

echo ""
echo "✅ Build completado!"
echo "📱 APK ubicado en: android/app/build/app-debug.apk"
echo ""
echo "Para instalar en dispositivo:"
echo "  adb install -r android/app/build/app-debug.apk"
