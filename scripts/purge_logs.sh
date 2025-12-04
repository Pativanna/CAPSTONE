#!/usr/bin/env bash
#
# Ejecuta la limpieza de logs/voice_logs respetando LOG_RETENTION_DAYS y VOICE_LOG_RETENTION_DAYS.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python manage.py cleanup_logs "$@"
