# Car Inventory - Sistema de Gestión de Autopartes

Sistema de inventario con reconocimiento de voz, WebRTC, impresión térmica Bluetooth y API REST. Desarrollado con Django Channels, Vosk, OpenAI Whisper y WebSocket.

## Características

### Ingreso de Voz Manos Libres
- Reconocimiento de voz en español (Vosk offline + OpenAI Whisper online)
- Sistema híbrido que combina velocidad local con precisión cloud
- Vocabulario automotriz que aprende de las piezas ingresadas
- WebRTC con cancelación de eco para ambientes ruidosos
- Comandos de voz para control del sistema

### Gestión de Inventario
- CRUD completo de piezas, autos y talleres
- Sistema de auditoría con tracking de cambios
- Búsqueda avanzada y filtros
- Control de estados y ubicaciones
- Historial de ventas

### Impresión Térmica Bluetooth
- Compatible con impresora GOOJPRT PT210
- Generación automática de códigos de barras (CODE128, EAN13)
- Códigos QR
- Etiquetas térmicas de 58mm
- Impresión directa desde navegador

### Dashboard y Reportes
- Dashboard con métricas en tiempo real
- Generación de reportes PDF
- Estadísticas de inventario y ventas
- Logs estructurados con rotación automática

### API REST
- API completa con Django REST Framework
- Documentación interactiva Swagger/OpenAPI
- Autenticación por tokens
- Endpoints para piezas, autos, talleres y reportes

## Stack Tecnológico

**Backend**
- Django 5.2.7
- Django Channels 4.0 (WebSocket)
- Daphne (servidor ASGI)
- Redis 7
- SQLite (recomendado PostgreSQL para producción)

**IA y Voz**
- Vosk 0.3.45 (reconocimiento offline)
- OpenAI Whisper (transcripción)
- OpenAI GPT-4o-mini (extracción de datos)
- FFmpeg 7.0

**WebRTC y Audio**
- aiortc 1.14.0
- PyAV 16.0.1
- webrtcvad 2.0.10

**Frontend**
- Bootstrap 5.3.2
- Turbo 7.3.0 (navegación SPA)
- JavaScript vanilla
- Font Awesome 6.5

**Infraestructura**
- Docker & Docker Compose
- Nginx (reverse proxy)
- Let's Encrypt (SSL/TLS)

## Instalación

### Prerrequisitos
- Docker y Docker Compose
- Modelo Vosk español
- OpenAI API Key
- Certificados SSL (opcional, producción)

### Pasos

1. **Clonar repositorio**
```bash
git clone https://github.com/tu-usuario/car_inventory.git
cd car_inventory
```

2. **Configurar variables de entorno**
```bash
cp .env.example .env
nano .env
```

Configurar:
```bash
SECRET_KEY=tu-clave-secreta
DEBUG=False
ALLOWED_HOSTS=tu-dominio.com
OPENAI_API_KEY=tu-api-key
PUBLIC_IP=tu-ip-publica
```

3. **Descargar modelo Vosk**
```bash
mkdir -p /opt/vosk-models
cd /opt/vosk-models
wget https://alphacephei.com/vosk/models/vosk-model-es-0.42.zip
unzip vosk-model-es-0.42.zip
```

4. **Deploy**
```bash
./deploy.sh dev  # desarrollo
./deploy.sh prod # producción
```

O manualmente:
```bash
docker compose build
docker compose up -d
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser
docker compose exec web python manage.py collectstatic --noinput
```

5. **Acceder**
- App: http://localhost
- Admin: http://localhost/admin
- API: http://localhost/api/docs/

## Comandos Útiles

### Ver Logs
```bash
docker compose logs -f web
docker compose logs -f redis
docker compose logs -f nginx
```

### Verificar Estado de Redis
```bash
./verificar_redis.sh
```

### Reiniciar Servicios
```bash
docker compose restart web
docker compose restart redis
docker compose restart nginx
```

### Backup de Base de Datos
```bash
docker compose exec web python manage.py dumpdata > backup.json
```

### Ejecutar Tests
```bash
docker compose exec web python manage.py test
```

## Estructura del Proyecto

```
car_inventory/
├── car_inventory/          # Configuración Django principal
│   ├── settings.py         # Configuración (Redis, Channels, etc)
│   ├── urls.py             # URLs principales
│   ├── asgi.py             # ASGI application
│   └── wsgi.py             # WSGI application
├── parts/                  # App principal
│   ├── consumers.py        # WebSocket consumers (Vosk)
│   ├── models.py           # Modelos de datos
│   ├── views.py            # Vistas Django
│   ├── api_views.py        # ViewSets DRF
│   ├── serializers.py      # Serializers DRF
│   ├── transcription_service.py  # Servicios de transcripción
│   ├── barcode_generator.py     # Generación de códigos
│   ├── static/             # JavaScript y CSS
│   └── templates/          # Templates HTML
├── docker-compose.yml      # Orquestación de contenedores
├── Dockerfile              # Imagen Docker optimizada
├── nginx.conf              # Configuración Nginx
├── requirements.txt        # Dependencias Python
└── .env.example            # Ejemplo de variables de entorno
```

## Seguridad

- Autenticación requerida para todas las vistas
- Protección CSRF habilitada
- Django Axes para protección contra fuerza bruta
- Tokens de autenticación para API
- SSL/TLS en producción
- Redis con contraseña (configurar en producción)
- Logs de auditoría completos

## Arquitectura de Procesamiento de Voz

```
┌─────────────────────────────────────────────────────┐
│ Frontend (Navegador)                                 │
│ ├─ MediaRecorder API (WebRTC)                       │
│ ├─ Audio Context API                                │
│ └─ WebSocket Client                                 │
└─────────────────────────────────────────────────────┘
                       ↓ WebSocket
┌─────────────────────────────────────────────────────┐
│ Backend (Django Channels)                            │
│ ├─ VoskConsumer (WebSocket handler)                 │
│ ├─ Audio preprocessing                              │
│ ├─ Vosk (reconocimiento local)                      │
│ ├─ OpenAI Whisper (transcripción precisa)           │
│ └─ GPT-4o-mini (extracción de datos)                │
└─────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│ Sistema de Extracción de Datos                      │
│ ├─ Regex patterns para autopartes                   │
│ ├─ Text normalization                               │
│ └─ Vocabulario automotriz personalizado             │
└─────────────────────────────────────────────────────┘
```

## Puertos Utilizados

- **80** - HTTP (redirect a HTTPS)
- **443** - HTTPS (producción)
- **8000** - Django/Daphne (interno)
- **6379** - Redis (interno)
- **10000-10100/UDP** - WebRTC ICE/RTP

## Contribuir

Las contribuciones son bienvenidas. Por favor:

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/NuevaFuncionalidad`)
3. Commit tus cambios (`git commit -m 'Agregar nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/NuevaFuncionalidad`)
5. Abre un Pull Request

## Licencia

Este proyecto es privado. Todos los derechos reservados.

## Autor

**Transervis** - Sistema de Inventario de Autopartes

## Agradecimientos

- OpenAI por Whisper y GPT models
- Alpha Cephei por Vosk
- Hotwired por Turbo
- Django Software Foundation
- Toda la comunidad open source

## Soporte

Para soporte, contactar a través de:
- Email: soporte@transervis.cl
- Website: https://www.transervis.cl
