#!/usr/bin/env bash
#
# Smoke-test que verifica que las rutas críticas respondan 200 y que
# la vista de workshops incluya el turbo-frame esperado.
#
# Uso:
#   BASE_URL=https://www.transervis.cl scripts/healthcheck.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-https://www.transervis.cl}"
declare -A PATHS=(
  ["home"]="/parts/"
  ["workshops"]="/workshops/"
)

function check_endpoint() {
  local name="$1"
  local path="$2"
  local url="${BASE_URL%/}${path}"
  echo "[healthcheck] Probando ${name}: ${url}"
  response="$(curl -fsS --max-time 10 --retry 2 --retry-connrefused "$url")"
  if [[ "$name" == "workshops" ]]; then
    if ! grep -q '<turbo-frame id="app-frame"' <<<"$response"; then
      echo "[healthcheck] ❌ La respuesta de /workshops/ no contiene <turbo-frame id=\"app-frame\">"
      return 1
    fi
  fi
  echo "[healthcheck] ✅ ${name} OK"
}

for key in "${!PATHS[@]}"; do
  check_endpoint "$key" "${PATHS[$key]}"
done

echo "[healthcheck] Todos los endpoints respondieron correctamente."
