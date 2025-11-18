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



## Soporte

Para soporte, contactar a través de:
- Email: soporte@transervis.cl
- Website: https://www.transervis.cl
