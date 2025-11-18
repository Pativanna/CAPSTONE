# Car Inventory - Instrucciones para Agentes de IA

## Arquitectura General

Sistema Django de inventario de autopartes con **reconocimiento de voz hands-free** para ingreso rápido de piezas. Arquitectura multi-contenedor (web + Vosk + Ollama + Redis + NGINX) con IA híbrida (local + nube).

### Componentes Principales

1. **Django + Daphne (contenedor `web`)**: App principal con WebSockets (Channels)
2. **Vosk (integrado en Django)**: Reconocimiento de voz en español (modelo `vosk-model-es-0.42`)
3. **Ollama (contenedor `ollama`)**: LLM local (`mistral:instruct`) para extracción de datos
4. **OpenAI API**: GPT-4 para transcripción/extracción de alta precisión (opcional, requiere `OPENAI_API_KEY`)
5. **Redis**: Backend de Channels para WebSockets
6. **NGINX**: Proxy reverso + archivos estáticos

### Flujo de Ingreso por Voz

```
Usuario → Micrófono (WebRTC/AudioWorklet)
       → WebSocket (voice-vosk.js → VoskConsumer)
       → Vosk (transcripción español)
       → Comandos detectados ("iniciar proceso" / "finalizar proceso")
       → Entre comandos: captura con is_capturing=True
       → Al finalizar: extracción con Ollama/GPT-4
       → Formulario Django llenado automáticamente
```

**Archivos clave del flujo:**
- `parts/static/parts/voice-vosk.js`: Cliente WebSocket + captura de audio
- `parts/consumers.py`: `VoskConsumer` - reconocedor Vosk integrado
- `parts/vosk_views.py`: Endpoints `/log-transcription`, `/process-session`
- `parts/vocabulario_automotriz.py`: **339 palabras** del dominio (rueda, parachoque, etc.)

## Convenciones del Proyecto

### ⛔ REGLAS CRÍTICAS - CUMPLIR ESTRICTAMENTE

**Lee este archivo de instrucciones antes de cualquier acción y cúmplelo estrictamente.**

1. **Responde solo en español** - todas las respuestas, explicaciones y comentarios
2. **Variables en español** - mantén nombres de variables, funciones y comentarios en español
3. **NUNCA usar emojis** - ni en código, comentarios, commits o documentación
4. **NUNCA crear archivos .md** - a menos que el usuario lo solicite EXPLÍCITAMENTE
5. **Análisis profundo antes de corregir** - busca TODAS las posibles causas del error
6. **Cambios end-to-end** - código debe quedar completamente funcional de punta a punta
7. **Ejecuta los comandos** - aplica migraciones, collectstatic, reinicios y reporta resultado
8. **Pide clarificación** - si requerimientos son ambiguos, solicita más detalles

### Idioma: **Español Estricto**
- Variables, funciones, comentarios: SIEMPRE en español
- Ejemplo: `nombre_pieza`, `extraer_datos_vehiculo()`, `# Procesar transcripción`
- Excepción: nombres de modelos Django y clases (ej: `Part`, `VoskConsumer`)

### ⛔ PROHIBIDO: Archivos .md de Documentación
- **NUNCA crear archivos .md** a menos que el usuario lo solicite EXPLÍCITAMENTE
- Esto incluye: CHANGELOG.md, CAMBIOS_*.md, CORRECCION_*.md, RESUMEN_*.md, etc.
- Al terminar un cambio: reportar verbalmente, NO crear archivo
- Violación: crear .md sin autorización = incumplimiento crítico

### ⛔ PROHIBIDO: Emojis
- **NUNCA** usar emojis en código, comentarios, commits o documentación
- Ejemplo prohibido: `# Procesar datos 📊` ❌
- Correcto: `# Procesar datos` ✓

### Cambios End-to-End
Al modificar código, considerar impacto completo:
- **Backend**: vistas, modelos, migraciones, URLs
- **Frontend**: templates, JavaScript, CSS
- **Infraestructura**: Docker restart, migraciones, collectstatic

Ejemplo: agregar campo a `Part` requiere:
1. `models.py`: agregar campo
2. `python manage.py makemigrations parts`
3. `python manage.py migrate parts`
4. `forms.py`: agregar al formulario
5. `templates/parts/part_form.html`: agregar input
6. `docker compose restart web`

### Verificación y Observabilidad
- **Ejecuta verificación rápida** y reporta estado después de cambios:
  - Build = PASS/FAIL
  - Lint/Typecheck = PASS/FAIL
  - Tests = PASS/FAIL
- Si falla algo, intenta hasta tres correcciones; si persiste, explica el motivo
- **Incluye los comandos necesarios** para aplicar cambios (migraciones, collectstatic, reinicios)
- **Si es posible, ejecútalos** y reporta el resultado
- Logs, métricas mínimas, archivos temporales, limpieza/rotación si corresponde

### Manejo de Ambigüedad
- Si un requerimiento es ambiguo o incompleto, **solicita más detalles** antes de proceder
- Reitera hasta que no haya ambigüedades
- Al aplicar cambios, proporciona **explicación detallada** de cambios y razonamiento

## Comandos Esenciales

### Desarrollo
```bash
# Reiniciar servidor después de cambios Python
docker compose restart web

# Ver logs en tiempo real
docker compose logs -f web

# Aplicar migraciones
docker compose exec web python manage.py makemigrations parts
docker compose exec web python manage.py migrate parts

# Recolectar estáticos (producción)
docker compose exec web python manage.py collectstatic --noinput

# Verificar integridad Django
docker compose exec web python manage.py check

# Shell Django para debugging
docker compose exec web python manage.py shell
```

### Debugging de Voz
```bash
# Ver transcripciones Vosk en tiempo real
docker compose logs -f web | grep "parts.voice"

# Verificar sesiones de voz en BD
docker compose exec web python manage.py shell
>>> from parts.models import VoiceSession, VoiceTranscription
>>> VoiceSession.objects.latest('timestamp')
>>> VoiceTranscription.objects.filter(is_capturing=True).count()

# Probar vocabulario
docker compose exec web python test_vocabulario.py
```

## Patrones de Código

### Modelos con Campos de Auditoría
```python
class Part(models.Model):
    sold = models.BooleanField(default=False)
    sold_at = models.DateTimeField(blank=True, null=True)  # Fecha de venta automática
    
    def save(self, *args, **kwargs):
        if self.sold and not self.sold_at:
            self.sold_at = timezone.now()
        super().save(*args, **kwargs)
```

### WebSocket Consumers (Channels)
```python
class VoskConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        # Cargar modelo Vosk lazy (compartido entre conexiones)
        model = await self.get_model()
        # Crear recognizer con vocabulario personalizado
        from parts.vocabulario_automotriz import obtener_vocabulario_json
        vocabulario = obtener_vocabulario_json()
        self.recognizer = await asyncio.to_thread(
            KaldiRecognizer, model, 16000, vocabulario
        )
```

### Logging Estructurado
```python
import logging
logger = logging.getLogger('parts.voice')

# Logs van a logs/app.jsonl y logs/voice.jsonl
logger.info(f"Sesión {session_id}: captura iniciada")
logger.warning(f"Transcripción vacía para sesión {session_id}")
```

### IA Híbrida (Local + Nube)
```python
use_cloud = request.POST.get('use_cloud') == 'true'

if use_cloud:
    # OpenAI GPT-4 (requiere OPENAI_API_KEY)
    client = OpenAI(api_key=settings.OPENAI_API_KEY)
    response = client.chat.completions.create(model="gpt-4", ...)
else:
    # Ollama local (mistral:instruct)
    requests.post(f"{settings.OLLAMA_HOST}/api/generate", ...)
```

## Gestión de Transcripciones

### Sistema `is_capturing`
Las transcripciones entre "iniciar proceso" y "finalizar proceso" se marcan con `is_capturing=True`:

```python
# En vosk_views.py log_transcription
if comando == 'iniciar_proceso':
    sesion.is_capturing = True
    sesion.save()

# Guardar transcripción con estado de sesión
VoiceTranscription.objects.create(
    session_id=session_id,
    text=texto,
    type='final',  # 'partial' o 'final'
    is_capturing=sesion.is_capturing  # Heredar de sesión
)

# Procesar solo transcripciones capturadas
transcripts = VoiceTranscription.objects.filter(
    session_id=session_id,
    is_capturing=True,
    type='final'
).order_by('timestamp')
```

### Vocabulario Personalizado
El archivo `parts/vocabulario_automotriz.py` contiene **209 piezas reales** de la BD:
- Rueda, Parachoque, Guardafango, Turbo, Neblinero, etc.
- Vosk usa este vocabulario restringido para mejor precisión
- Agregar términos editando `PIEZAS_AUTOMOTRICES` y reiniciando

## Integraciones Externas

### Ollama (LLM Local)
- Host: `http://ollama:11434` (Docker) o `http://localhost:11434` (local)
- Modelo: `mistral:instruct` (config: `OLLAMA_MODEL`)
- Timeout: 60 segundos para generación
- Uso: extracción de datos de transcripciones de voz

### OpenAI API (Opcional)
- Whisper: transcripción de audio (mejor que Vosk para ruido)
- GPT-4: extracción de datos estructurados (mejor que Ollama)
- Configurar: `OPENAI_API_KEY` en `.env`

### Vosk (Reconocimiento de Voz)
- Modelo: `vosk-model-es-0.42` (42 MB, español)
- Sample rate: **16000 Hz** (crítico, no cambiar)
- Path: `/app/vosk-models/vosk-model-es-0.42`
- Alternativa: `vosk-model-large-es` (1.4 GB, mejor precisión)

## Testing

### Verificación Rápida
```bash
# Django check
docker compose exec web python manage.py check

# Probar vocabulario Vosk
docker compose exec web python test_vocabulario.py

# Estado de contenedores
docker compose ps
```

### Casos de Prueba de Voz
1. **Flujo completo**: "iniciar proceso la rueda delantera derecha finalizar proceso"
2. **Comando ignorado**: "la rueda delantera derecha finalizar proceso rota" (>6 palabras)
3. **Sin captura**: transcripciones fuera de "iniciar/finalizar" tienen `is_capturing=False`

## Troubleshooting Común

### Error: "Modelo Vosk no disponible"
- Verificar: `ls /app/vosk-models/vosk-model-es-0.42`
- Descargar modelo si falta (ver `Dockerfile.vosk`)

### WebSocket no conecta
- Verificar Redis: `docker compose ps redis`
- Logs: `docker compose logs -f web | grep "channels"`

### Transcripción imprecisa
1. Verificar vocabulario: `docker compose exec web python test_vocabulario.py`
2. Revisar modo captura: localStorage `voiceCaptureMode` (RAW vs CLEAN)
3. Considerar modelo grande: `vosk-model-large-es`

### Ollama no responde
- Verificar: `docker compose ps ollama` (debe estar "Up")
- Probar: `curl http://ollama:11434/api/generate -d '{"model":"mistral:instruct","prompt":"test"}'`
- Logs: `docker compose logs ollama | tail -50`

## Archivos de Configuración

- `.env`: Variables de entorno (SECRET_KEY, OPENAI_API_KEY, etc.)
- `docker-compose.yml`: Orquestación de servicios
- `car_inventory/settings.py`: Configuración Django (OLLAMA_HOST, VOSK_MODEL_PATH)
- `.github/instructions/Prompt.instructions.md`: **Reglas estrictas del proyecto** (leer antes de cambios)

## Referencias

- Documentación Vosk: https://alphacephei.com/vosk/
- Django Channels: https://channels.readthedocs.io/
- Vocabulario del proyecto: `parts/vocabulario_automotriz.py` (339 palabras)
- Logs estructurados: `logs/app.jsonl` y `logs/voice.jsonl`
