#!/usr/bin/env bash
#
# Genera un respaldo versionado de db.sqlite3 respetando la convención usada en Windows.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d_%H%M%S)"
target="${BACKUP_DIR}/db_backup_${timestamp}.sqlite3"

if [[ ! -f "db.sqlite3" ]]; then
  echo "[backup] No se encontró db.sqlite3 en ${ROOT_DIR}" >&2
  exit 1
fi

cp db.sqlite3 "$target"
echo "[backup] Copia creada en $target"

if command -v gzip >/dev/null 2>&1 && [[ "${COMPRESS_BACKUP:-false}" == "true" ]]; then
  gzip "$target"
  echo "[backup] Archivo comprimido con gzip"
fi
