#!/bin/bash
# Verificación de Redis para car_inventory

echo "=========================================="
echo "Verificación de Redis"
echo "=========================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "1. Verificando si Redis está activo..."
if docker ps | grep -q car_inventory_redis; then
    echo -e "${GREEN}[OK] Redis está corriendo${NC}"
else
    echo -e "${RED}[ERROR] Redis NO está corriendo${NC}"
    echo "  Ejecuta: docker compose up -d redis"
    exit 1
fi
echo ""

echo "2. Verificando rol de Redis..."
REDIS_ROLE=$(docker exec car_inventory_redis redis-cli INFO replication | grep "role:" | cut -d: -f2 | tr -d '\r')
if [ "$REDIS_ROLE" = "master" ]; then
    echo -e "${GREEN}[OK] Redis es MASTER (escribible)${NC}"
else
    echo -e "${RED}[ERROR] Redis es: $REDIS_ROLE${NC}"
    echo "  Redis debe ser master para permitir escrituras"
    echo "  Verifica la configuración y que no esté en modo réplica"
fi
echo ""

echo "3. Verificando persistencia..."
AOF_ENABLED=$(docker exec car_inventory_redis redis-cli CONFIG GET appendonly | grep -A1 appendonly | tail -n1 | tr -d '\r')
if [ "$AOF_ENABLED" = "yes" ]; then
    echo -e "${GREEN}[OK] AOF (Append Only File) está habilitado${NC}"
else
    echo -e "${YELLOW}[!] AOF está deshabilitado (no crítico pero recomendado)${NC}"
fi
echo ""

echo "4. Probando escritura en Redis..."
TEST_KEY="test_write_$(date +%s)"
TEST_VALUE="test_value_$(date +%s)"
if docker exec car_inventory_redis redis-cli SET "$TEST_KEY" "$TEST_VALUE" > /dev/null 2>&1; then
    echo -e "${GREEN}[OK] Escritura exitosa${NC}"
    docker exec car_inventory_redis redis-cli DEL "$TEST_KEY" > /dev/null 2>&1
else
    echo -e "${RED}[ERROR] No se puede escribir en Redis${NC}"
    echo "  Este es el problema que causa ReadOnlyError"
fi
echo ""

echo "5. Variables de entorno del servicio web..."
if docker ps | grep -q car_inventory_web; then
    echo "Variables Redis en servicio web:"
    docker exec car_inventory_web env | grep -E "REDIS_(URL|HOST|PORT)" || echo "  No se encontraron variables REDIS_*"
else
    echo -e "${YELLOW}[!] Servicio web no está corriendo${NC}"
fi
echo ""

echo "6. Información de Redis..."
echo "Versión:"
docker exec car_inventory_redis redis-cli INFO server | grep "redis_version:" | cut -d: -f2 | tr -d '\r'
echo ""
echo "Clientes conectados:"
docker exec car_inventory_redis redis-cli INFO clients | grep "connected_clients:" | cut -d: -f2 | tr -d '\r'
echo ""

echo "=========================================="
echo "RESUMEN"
echo "=========================================="
if [ "$REDIS_ROLE" = "master" ]; then
    echo -e "${GREEN}Redis configurado correctamente${NC}"
    echo ""
    echo "Acciones sugeridas:"
    echo "1. docker compose restart (para aplicar cambios)"
    echo "2. Probar el WebSocket /vosk-ws/ desde el navegador"
    echo "3. Revisar logs: docker compose logs -f web"
else
    echo -e "${RED}Redis NO está configurado correctamente${NC}"
    echo ""
    echo "Solución:"
    echo "1. docker compose down"
    echo "2. Verifica que docker-compose.yml tenga: command: redis-server --appendonly yes"
    echo "3. docker compose up -d"
fi
echo "=========================================="
