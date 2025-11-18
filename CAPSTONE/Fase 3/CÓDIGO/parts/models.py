# parts/models.py
from django.db import models
from django.utils import timezone

# Import custom User models
from .user_models import UserProfile, AuditLog

class Workshop(models.Model):
    name = models.CharField(max_length=100, verbose_name="Nombre")
    direction = models.CharField(max_length=200, verbose_name="Dirección")

    def __str__(self):
        return self.name


class Auto(models.Model):
    brand_model = models.CharField(max_length=100, verbose_name="Marca y Modelo")
    year = models.PositiveIntegerField(verbose_name="Año")
    color = models.CharField(max_length=50, verbose_name="Color")
    license_plate = models.CharField(max_length=20, verbose_name="Placa/Patente", blank=True, null=True)
    date_added = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-year', 'brand_model']

    def __str__(self):
        # Formato: "Marca Modelo Año - Patente" o solo "Marca Modelo Año" si no tiene patente
        if self.license_plate:
            return f"{self.brand_model} {self.year} - {self.license_plate}"
        return f"{self.brand_model} {self.year}"



class Part(models.Model):
    name = models.CharField(max_length=100)
    # Usar TextField para no truncar y guardar todos los detalles literalmente
    details = models.TextField(blank=True, null=True)
    date_added = models.DateTimeField(auto_now_add=True)

    # 🟢 Defaults
    sold = models.BooleanField(default=False)  # 0 = not sold
    # Fecha/hora de venta (para métricas por semana/mes). Se completa automáticamente
    sold_at = models.DateTimeField(blank=True, null=True)
    state = models.BooleanField(default=True)  # 1 = active/available
    max_value = models.PositiveIntegerField(default=0)
    min_value = models.PositiveIntegerField(default=0)

    # Gestión de fotos (opcional)
    image = models.ImageField(upload_to='part_images/', blank=True, null=True)
    
    # Código de barras generado automáticamente
    barcode = models.CharField(max_length=50, blank=True, null=True, db_index=True, help_text="Código de barras único generado automáticamente")

    # relations
    auto = models.ForeignKey('Auto', on_delete=models.CASCADE, related_name='parts')
    workshop = models.ForeignKey('Workshop', on_delete=models.CASCADE, related_name='parts')

    def __str__(self):
        return f"{self.name} ({self.auto.brand_model} {self.auto.year})"
    
    def generar_codigo_barras(self):
        """Genera código de barras único basado en ID y año del auto"""
        if not self.barcode and self.id and self.auto:
            self.barcode = f"INV{self.id:06d}{self.auto.year}"
        return self.barcode

    def save(self, *args, **kwargs):
        """Asegura mantener sold_at cuando la pieza se marca como vendida.

        - Si pasa de no vendida a vendida y no tenemos sold_at, se fija ahora.
        - Si se desmarca como vendida, conservamos sold_at como histórico.
        - Genera código de barras automáticamente si no existe
        """
        # Detectar estado anterior si existe en BD
        if self.pk is not None:
            try:
                prev = Part.objects.only('sold', 'sold_at').get(pk=self.pk)
            except Part.DoesNotExist:
                prev = None
        else:
            prev = None

        if self.sold and (not getattr(self, 'sold_at', None)):
            # Si se marca vendida y no hay fecha, usar ahora
            self.sold_at = timezone.now()
        elif prev is not None and (not self.sold) and prev.sold and self.sold_at is None:
            # Se "revierte" la venta; mantenemos histórico sin tocar sold_at
            pass

        # Guardar primero para obtener ID
        es_nueva = self.pk is None
        super().save(*args, **kwargs)
        
        # Generar código de barras si es una pieza nueva o no tiene código
        if not self.barcode:
            self.generar_codigo_barras()
            # Guardar nuevamente solo si se generó el código
            if self.barcode and es_nueva:
                super().save(update_fields=['barcode'])


# === Reportes automatizados ===
from django.conf import settings

class ReportSchedule(models.Model):
    """Programación de generación/envío de reportes PDF."""
    class Frequency(models.TextChoices):
        DAILY = 'daily', 'Diario'
        WEEKLY = 'weekly', 'Semanal'
        MONTHLY = 'monthly', 'Mensual'

    name = models.CharField(max_length=100)
    frequency = models.CharField(max_length=20, choices=Frequency.choices, default=Frequency.WEEKLY)
    recipients = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='report_schedules')
    last_generated = models.DateTimeField(blank=True, null=True)

    def __str__(self):
        return f"{self.name} ({self.get_frequency_display()})"


class ReportLog(models.Model):
    """Historial de reportes generados, con archivo PDF opcional."""
    schedule = models.ForeignKey(ReportSchedule, on_delete=models.CASCADE, related_name='logs')
    generated_at = models.DateTimeField(default=timezone.now)
    file = models.FileField(upload_to='reports/', blank=True, null=True)

    def __str__(self):
        return f"Reporte {self.generated_at.strftime('%d %b %Y, %H:%M')}"


# === Voz: Sesiones y resultados de ingesta ===
class VoiceSession(models.Model):
    """Sesión de captura de voz asociada a los logs en disco.

    session_id: coincide con el usado en archivos session_*.jsonl y transcript_*.txt
    counters: métricas básicas para auditoría/diagnóstico
    status: estado de la sesión (ACTIVA/CERRADA)
    is_capturing: True entre "iniciar proceso" y "finalizar proceso"
    """

    class Status(models.TextChoices):
        ACTIVE = 'ACTIVE', 'Activa'
        CLOSED = 'CLOSED', 'Cerrada'

    session_id = models.CharField(max_length=64, unique=True, db_index=True)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)

    partial_count = models.PositiveIntegerField(default=0)
    final_count = models.PositiveIntegerField(default=0)
    command_count = models.PositiveIntegerField(default=0)

    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    is_capturing = models.BooleanField(default=False, help_text="True durante un proceso activo de captura")
    class EstadoGrabacion(models.IntegerChoices):
        INACTIVO = 0, 'Inactivo'
        INICIADO = 1, 'Iniciado'
        FINALIZADO = 2, 'Finalizado'
        ESPERANDO_CONFIRMACION = 3, 'Esperando confirmación'
    estado_grabacion = models.PositiveSmallIntegerField(
        choices=EstadoGrabacion.choices,
        default=EstadoGrabacion.INACTIVO,
        db_index=True,
        help_text="Ciclo de captura: 0 Inactivo, 1 Iniciado, 2 Finalizado, 3 Esperando confirmación"
    )
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Sesión de Voz"
        verbose_name_plural = "Sesiones de Voz"
        ordering = ['-started_at']

    def __str__(self):
        return f"{self.session_id} ({self.get_status_display()})"

class VoiceIngestResult(models.Model):
    """Resultado estructurado de una ventana [iniciar..finalizar] dentro de una sesión.

    pair_key: clave única para evitar duplicados (sessionId_startTs_endTs)
    fields: JSON con los campos extraídos (parte, detalles, modelo, valor, color)
    source: de dónde proviene (watchdog basado en JSONL, procesador realtime, etc.)
    """

    class Source(models.TextChoices):
        WATCHDOG = 'watchdog', 'Watchdog (JSONL)'
        REALTIME = 'realtime', 'Procesador en tiempo real'

    session = models.ForeignKey(VoiceSession, on_delete=models.CASCADE, related_name='ingests')
    pair_key = models.CharField(max_length=128, unique=True)
    start_ts = models.FloatField()
    end_ts = models.FloatField()
    transcript = models.TextField()
    fields = models.JSONField(default=dict)
    source = models.CharField(max_length=16, choices=Source.choices, default=Source.WATCHDOG)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Resultado de Ingesta de Voz"
        verbose_name_plural = "Resultados de Ingesta de Voz"
        indexes = [
            models.Index(fields=['-created_at']),
            models.Index(fields=['pair_key']),
            models.Index(fields=['session', '-created_at']),
        ]

    def __str__(self):
        return f"{self.session.session_id} [{self.start_ts:.3f}..{self.end_ts:.3f}]"


# === Configuración de Micrófono por Dispositivo ===
class MicConfig(models.Model):
    """Configuración óptima de micrófono por dispositivo/navegador.

    device_id: identificador persistente generado en el cliente (localStorage), único por dispositivo
    user: usuario opcional asociado
    user_agent: cadena del navegador para referencia
    config: JSON con parámetros de audio (voiceCaptureMode, enableCompressor, micPreGain, audioBufferSize, agc...)
    score: puntaje de la evaluación (mayor es mejor)
    last_tested: última vez que se corrió el autotune
    """

    device_id = models.CharField(max_length=128, unique=True, db_index=True)
    user = models.ForeignKey('auth.User', null=True, blank=True, on_delete=models.SET_NULL, related_name='mic_configs')
    user_agent = models.CharField(max_length=256, blank=True, default='')
    config = models.JSONField(default=dict, blank=True)
    score = models.FloatField(default=0.0)
    last_tested = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Configuración de Micrófono"
        verbose_name_plural = "Configuraciones de Micrófono"
        ordering = ['-updated_at']

    def __str__(self):
        return f"MicConfig({self.device_id}) score={self.score:.2f}"


class PerfilVozUsuario(models.Model):
    """Estado de adaptación del reconocedor Vosk para cada usuario.

    Guarda el estado de adaptación incremental del reconocedor, junto con
    métricas básicas de cuántas muestras de entrenamiento se registraron
    por comando. Esto permite ajustar el modelo a la voz de cada persona.
    """

    usuario = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='perfil_voz')
    estado_adaptacion = models.TextField(blank=True, default='')
    muestras_totales = models.PositiveIntegerField(default=0)
    conteo_por_comando = models.JSONField(default=dict, blank=True)
    creado_en = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Perfil de Voz"
        verbose_name_plural = "Perfiles de Voz"

    def __str__(self):
        return f"PerfilVozUsuario({self.usuario_id}) muestras={self.muestras_totales}"


class VoiceTranscription(models.Model):
    """Transcripciones individuales (partial/final/command) almacenadas en BD.
    
    Permite reconstruir sesiones completas desde la base de datos en lugar
    de leer archivos JSONL. Útil para procesamiento diferido con IA.
    
    session_id: ID de la sesión de voz
    text: texto transcrito
    type: partial|final|command
    timestamp: marca temporal de la transcripción
    metadata: datos adicionales (confianza, duración, etc.)
    """
    
    class Type(models.TextChoices):
        PARTIAL = 'partial', 'Parcial'
        FINAL = 'final', 'Final'
        COMMAND = 'command', 'Comando'
    
    session_id = models.CharField(max_length=64, db_index=True)
    text = models.TextField()
    type = models.CharField(max_length=16, choices=Type.choices, default=Type.PARTIAL)
    timestamp = models.DateTimeField(default=timezone.now, db_index=True)
    metadata = models.JSONField(default=dict, blank=True)
    is_capturing = models.BooleanField(default=False, db_index=True, help_text="True si se capturó durante un proceso activo")
    
    class Meta:
        verbose_name = "Transcripción de Voz"
        verbose_name_plural = "Transcripciones de Voz"
        ordering = ['session_id', 'timestamp']
        indexes = [
            models.Index(fields=['session_id', 'timestamp']),
            models.Index(fields=['session_id', 'type']),
            models.Index(fields=['session_id', 'is_capturing', 'type']),
        ]
    
    def __str__(self):
        return f"{self.session_id} [{self.type}] {self.text[:50]}"


# === Logging de llamadas a OpenAI ===
class OpenAILlamada(models.Model):
    """Registro persistente de cada llamada a la API de OpenAI (chat, whisper, tts, otros).

    Se guarda para auditoría de costos y diagnóstico de picos de uso.

    Campos clave:
    - tipo: chat|whisper|tts|otros
    - modelo: nombre del modelo (gpt-4, gpt-4o-mini, whisper-1, tts-1-hd, etc.)
    - tokens_prompt / tokens_respuesta: si el endpoint provee usage
    - costo_estimado: cálculo aproximado basado en pricing estático (USD)
    - duracion_ms: latencia total de la petición
    - exito: True/False
    - codigo_http: código HTTP devuelto (requests) o 200 implícito en SDK
    - error_texto: stack/error si falla
    - hash_prompt: SHA256 del prompt para correlación sin exponer texto completo
    - usuario_id: opcional (si se conoce el usuario que originó la solicitud)
    - origen: string corto para ubicar el punto lógico (ej: 'views._extract_with_openai')
    - request_id: id retornado por OpenAI si existe
    """

    class Tipo(models.TextChoices):
        CHAT = 'chat', 'Chat'
        WHISPER = 'whisper', 'Whisper'
        TTS = 'tts', 'TTS'
        OTROS = 'otros', 'Otros'

    creado_en = models.DateTimeField(auto_now_add=True, db_index=True)
    tipo = models.CharField(max_length=16, choices=Tipo.choices)
    modelo = models.CharField(max_length=64)
    tokens_prompt = models.PositiveIntegerField(null=True, blank=True)
    tokens_respuesta = models.PositiveIntegerField(null=True, blank=True)
    costo_estimado = models.DecimalField(max_digits=10, decimal_places=6, null=True, blank=True)
    duracion_ms = models.PositiveIntegerField(null=True, blank=True)
    exito = models.BooleanField(default=True)
    codigo_http = models.PositiveIntegerField(null=True, blank=True)
    error_texto = models.TextField(blank=True, default='')
    hash_prompt = models.CharField(max_length=64, blank=True, default='')
    usuario_id = models.CharField(max_length=64, blank=True, default='')
    origen = models.CharField(max_length=128, blank=True, default='')
    request_id = models.CharField(max_length=64, blank=True, default='')
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Llamada OpenAI"
        verbose_name_plural = "Llamadas OpenAI"
        ordering = ['-creado_en']
        indexes = [
            models.Index(fields=['-creado_en']),
            models.Index(fields=['modelo']),
            models.Index(fields=['tipo']),
        ]

    def __str__(self):
        ok = 'OK' if self.exito else 'ERR'
        return f"OpenAILlamada({self.modelo} {self.tipo} {ok} {self.duracion_ms or 0}ms)"


# === Sistema de Auditoría Centralizado ===
class EventoSistema(models.Model):
    """Registro centralizado de eventos del sistema para auditoría y diagnóstico.
    
    Captura todos los eventos importantes del sistema:
    - Creación/modificación/eliminación de piezas
    - Generación e impresión de códigos de barras
    - Llamadas a APIs externas (OpenAI, etc.)
    - Sesiones de voz y transcripciones
    - Errores y excepciones
    - Acciones de usuario
    
    Permite reconstruir el estado completo del sistema en cualquier momento
    y diagnosticar problemas con contexto completo.
    """
    
    class Categoria(models.TextChoices):
        PIEZA = 'pieza', 'Pieza'
        BARCODE = 'barcode', 'Código de Barras'
        VOZ = 'voz', 'Voz'
        USUARIO = 'usuario', 'Usuario'
        SISTEMA = 'sistema', 'Sistema'
        ERROR = 'error', 'Error'
        API_EXTERNA = 'api_externa', 'API Externa'
        IMPRESION = 'impresion', 'Impresión'
    
    class Nivel(models.TextChoices):
        DEBUG = 'debug', 'Debug'
        INFO = 'info', 'Info'
        WARNING = 'warning', 'Warning'
        ERROR = 'error', 'Error'
        CRITICAL = 'critical', 'Critical'
    
    # Metadatos del evento
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)
    categoria = models.CharField(max_length=20, choices=Categoria.choices, db_index=True)
    nivel = models.CharField(max_length=20, choices=Nivel.choices, default=Nivel.INFO, db_index=True)
    
    # Descripción del evento
    accion = models.CharField(max_length=100, help_text="Acción realizada (crear_pieza, generar_barcode, etc.)")
    descripcion = models.TextField(help_text="Descripción detallada del evento")
    
    # Contexto
    usuario = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='eventos')
    pieza = models.ForeignKey('Part', null=True, blank=True, on_delete=models.SET_NULL, related_name='eventos')
    sesion_voz = models.ForeignKey('VoiceSession', null=True, blank=True, on_delete=models.SET_NULL, related_name='eventos')
    
    # Datos adicionales en JSON
    datos = models.JSONField(default=dict, blank=True, help_text="Datos contextuales del evento")
    
    # Resultado
    exito = models.BooleanField(default=True)
    error_mensaje = models.TextField(blank=True, default='')
    duracion_ms = models.PositiveIntegerField(null=True, blank=True, help_text="Duración de la operación en ms")
    
    # Trazabilidad
    request_id = models.CharField(max_length=64, blank=True, default='', db_index=True, help_text="ID de request HTTP para correlacionar eventos")
    ip_origen = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=256, blank=True, default='')
    
    class Meta:
        verbose_name = "Evento del Sistema"
        verbose_name_plural = "Eventos del Sistema"
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp', 'categoria']),
            models.Index(fields=['-timestamp', 'nivel']),
            models.Index(fields=['request_id']),
            models.Index(fields=['usuario', '-timestamp']),
            models.Index(fields=['pieza', '-timestamp']),
            models.Index(fields=['exito', '-timestamp']),
        ]
    
    def __str__(self):
        estado = '✓' if self.exito else '✗'
        return f"[{self.timestamp.strftime('%Y-%m-%d %H:%M:%S')}] {estado} {self.get_categoria_display()}: {self.accion}"
    
    @classmethod
    def registrar(cls, categoria, accion, descripcion, nivel='info', usuario=None, pieza=None, 
                  sesion_voz=None, datos=None, exito=True, error_mensaje='', duracion_ms=None,
                  request_id='', ip_origen=None, user_agent=''):
        """
        Método de conveniencia para registrar eventos.
        
        Ejemplo:
            EventoSistema.registrar(
                categoria='pieza',
                accion='crear_pieza',
                descripcion=f'Pieza creada: {part.name}',
                usuario=request.user,
                pieza=part,
                datos={'auto': part.auto.brand_model, 'barcode': part.barcode}
            )
        """
        return cls.objects.create(
            categoria=categoria,
            nivel=nivel,
            accion=accion,
            descripcion=descripcion,
            usuario=usuario,
            pieza=pieza,
            sesion_voz=sesion_voz,
            datos=datos or {},
            exito=exito,
            error_mensaje=error_mensaje,
            duracion_ms=duracion_ms,
            request_id=request_id,
            ip_origen=ip_origen,
            user_agent=user_agent
        )
