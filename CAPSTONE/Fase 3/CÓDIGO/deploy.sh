#!/bin/bash
# Deploy del sistema Car Inventory
# Uso: ./deploy.sh [dev|prod]

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}>> $1${NC}"
}

log_success() {
    echo -e "${GREEN}[OK] $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}[!] $1${NC}"
}

log_error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

echo -e "${BLUE}"
echo "============================================="
echo "  Car Inventory - Deploy"
echo "============================================="
echo -e "${NC}"

ENV=${1:-dev}
COMPOSE_FILE="docker-compose.yml"

if [ "$ENV" = "prod" ]; then
    COMPOSE_FILE="docker-compose.prod.yml"
    log_info "Modo: PRODUCCIÓN"
else
    log_info "Modo: DESARROLLO"
fi

if [ ! -f .env ]; then
    log_error "No se encontró el archivo .env"
    cp .env.example .env
    log_warning "Se creó .env desde .env.example - Configúralo antes de continuar"
    exit 1
fi

log_info "Verificando Docker..."
if ! command -v docker &> /dev/null; then
    log_error "Docker no está instalado"
    exit 1
fi
log_success "Docker OK"

log_info "Verificando Docker Compose..."
if ! docker compose version &> /dev/null; then
    log_error "Docker Compose no está instalado"
    exit 1
fi
log_success "Docker Compose OK"

log_info "Verificando modelos Vosk..."
if [ ! -d "/opt/vosk-models" ]; then
    log_warning "Faltan modelos Vosk en /opt/vosk-models"
    log_info "Descarga desde: https://alphacephei.com/vosk/models"
else
    log_success "Modelos Vosk OK"
fi

log_info "Deteniendo contenedores..."
docker compose -f $COMPOSE_FILE down 2>/dev/null || true
log_success "Contenedores detenidos"

log_info "Construyendo imágenes..."
docker compose -f $COMPOSE_FILE build --no-cache
log_success "Imágenes construidas"

log_info "Levantando servicios..."
docker compose -f $COMPOSE_FILE up -d
log_success "Servicios iniciados"

log_info "Esperando inicialización (10 seg)..."
sleep 10

log_info "Ejecutando migraciones..."
docker compose -f $COMPOSE_FILE exec -T web python manage.py migrate --noinput
log_success "Base de datos actualizada"

log_info "Recolectando archivos estáticos..."
docker compose -f $COMPOSE_FILE exec -T web python manage.py collectstatic --noinput
log_success "Archivos estáticos listos"

if [ -f "./verificar_redis.sh" ]; then
    log_info "Verificando Redis..."
    chmod +x ./verificar_redis.sh
    ./verificar_redis.sh
fi

echo ""
log_info "Últimos logs:"
docker compose -f $COMPOSE_FILE logs --tail=15

echo ""
echo -e "${GREEN}"
echo "============================================="
echo "  Deploy completado"
echo "============================================="
echo -e "${NC}"
echo ""
log_info "Estado de servicios:"
docker compose -f $COMPOSE_FILE ps
echo ""
echo "Comandos útiles:"
echo "  Ver logs:    docker compose -f $COMPOSE_FILE logs -f"
echo "  Detener:     docker compose -f $COMPOSE_FILE down"
echo "  Reiniciar:   docker compose -f $COMPOSE_FILE restart"
echo ""

if [ "$ENV" = "dev" ]; then
    log_info "Acceso: http://localhost"
else
    log_info "Sistema desplegado en producción"
    log_warning "Recuerda configurar SSL con certbot"
fi
