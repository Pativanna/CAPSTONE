###############################################################
# Imagen multi-stage optimizada para aiortc/av en Python 3.11
# Objetivo: evitar explosión de dependencias (ffmpeg completo) y
# el agotamiento de espacio observado (error dpkg No space left).
# Estrategia:
#  1. Usar Python 3.12 (wheels disponibles para varias libs).
#  2. Etapa builder con sólo headers y libs mínimas de FFmpeg.
#  3. Construir wheels en /wheels y copiar al runtime slim limpio.
#  4. El runtime NO incluye toolchain ni headers -> más pequeño.
#  5. collectstatic se ejecuta en build para servir desde Nginx.
###############################################################

FROM python:3.11-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

## Instalamos toolchain y dependencias mínimas y construiremos FFmpeg moderno (>=7) para satisfacer PyAV 11
## Eliminamos libs ffmpeg de Debian (version vieja) que no contienen AV_OPT_TYPE_CHANNEL_LAYOUT
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libffi-dev \
    libssl-dev \
    libopus-dev \
    libsrtp2-dev \
    yasm \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

## Construcción minimizada de FFmpeg 7.x (shared libs requeridas por PyAV)
ENV FFmpeg_VERSION=7.0
RUN set -eux; \
    wget -O ffmpeg.tar.bz2 https://ffmpeg.org/releases/ffmpeg-${FFmpeg_VERSION}.tar.bz2; \
    mkdir -p /tmp/ffmpeg-src; \
    tar -xf ffmpeg.tar.bz2 -C /tmp/ffmpeg-src --strip-components=1; \
    cd /tmp/ffmpeg-src; \
    ./configure --prefix=/usr/local --enable-shared --disable-static --disable-doc --disable-ffplay --disable-ffprobe --disable-debug; \
    make -j"$(nproc)"; \
    make install; \
    ldconfig; \
    cd /; rm -rf /tmp/ffmpeg-src ffmpeg.tar.bz2

COPY requirements.txt ./

# Construimos wheels locales para poder copiarlas sin toolchain luego
## Workaround: PyAV 11 espera AV_OPT_TYPE_CHANNEL_LAYOUT pero FFmpeg entregado expone AV_OPT_TYPE_CHLAYOUT.
## Definimos macro para compatibilidad hacia atrás.
ENV CFLAGS="-DAV_OPT_TYPE_CHANNEL_LAYOUT=AV_OPT_TYPE_CHLAYOUT"
RUN pip install --upgrade pip && pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

COPY . .

# Ejecutamos collectstatic en builder (requiere código completo)
RUN python manage.py collectstatic --noinput || true

###############################################################
# Etapa runtime mínima
###############################################################
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DJANGO_SETTINGS_MODULE=car_inventory.settings

WORKDIR /app

# Añadimos ffmpeg en runtime para soportar conversión de audio en /parts/upload-audio/
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copiamos sólo wheels y las instalamos (sin compilar nada aquí)
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir /wheels/*.whl && rm -rf /wheels

# Copiamos código y staticfiles ya recolectados
COPY --from=builder /app /app

EXPOSE 8000

# Por docker-compose se sobreescribe el comando a daphne para Channels.
# Dejamos fallback a gunicorn (WSGI) si se inicia la imagen sin compose.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "300", "--graceful-timeout", "300", "car_inventory.wsgi:application"]
