#!/bin/bash
# Inicialización de Git para el proyecto

set -e

echo "Inicializando repositorio Git..."

if [ ! -d .git ]; then
    git init
    echo "Git inicializado"
else
    echo "El repositorio ya existe"
fi

echo "Configurando Git..."
git config user.name "Transervis"
git config user.email "dev@transervis.cl"

echo "Agregando archivos..."
git add .

if git ls-files | grep -q "^.env$"; then
    echo "Advertencia: .env está siendo trackeado, removiéndolo..."
    git rm --cached .env 2>/dev/null || true
fi

echo "Creando commit inicial..."
git commit -m "Initial commit: Car Inventory System

Sistema de gestión de inventario de autopartes con IA

Características principales:
- Reconocimiento de voz (Vosk + OpenAI Whisper)
- WebRTC para audio en tiempo real
- Impresión térmica Bluetooth (GOOJPRT PT210)
- Generación de códigos de barras y QR
- API REST con documentación Swagger
- WebSockets para comunicación en tiempo real
- Sistema de auditoría completo

Stack técnico:
- Django 5.2.7 + Channels 4.0
- Redis 7 + Daphne
- Docker + Nginx
- Bootstrap 5 + Turbo
" || echo "Ya existe un commit"

echo ""
echo "Git configurado correctamente"
echo ""
echo "Pasos siguientes:"
echo "  1. Crear repo en GitHub/GitLab"
echo "  2. git remote add origin https://github.com/tu-usuario/car_inventory.git"
echo "  3. git push -u origin main"
echo ""
echo "Archivos ignorados:"
echo "  - .env (credenciales)"
echo "  - db.sqlite3 (datos locales)"
echo "  - logs/ (archivos de log)"
echo ""
