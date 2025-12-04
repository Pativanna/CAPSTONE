# parts/models.py
import hashlib
import json
import re
import unicodedata

from decimal import Decimal
from django.db import models
from django.utils import timezone
from django.utils.functional import cached_property

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
    notes = models.CharField(max_length=400, verbose_name="Notas", blank=True, null=True)
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
    catalog_name = models.CharField(
        max_length=150,
        blank=True,
        null=True,
        verbose_name="Nombre catálogo",
        help_text="Valor curado desde BD manual (columna 'nombre')"
    )
    position = models.CharField(
        max_length=80,
        blank=True,
        null=True,
        verbose_name="Posición",
        help_text="Lado/posición exacta según BD manual"
    )
    date_added = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # 🟢 Defaults
    sold = models.BooleanField(default=False)  # 0 = not sold
    # Fecha/hora de venta (para métricas por semana/mes). Se completa automáticamente
    sold_at = models.DateTimeField(blank=True, null=True)
    state = models.BooleanField(default=True)  # 1 = active/available
    max_value = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))
    min_value = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))

    # Gestión de fotos (opcional)
    image = models.ImageField(upload_to='part_images/', blank=True, null=True)
    
    # Código de barras generado automáticamente
    barcode = models.CharField(max_length=50, blank=True, null=True, db_index=True, help_text="Código de barras único generado automáticamente")

    # relations
    auto = models.ForeignKey('Auto', on_delete=models.CASCADE, related_name='parts')
    workshop = models.ForeignKey('Workshop', on_delete=models.CASCADE, related_name='parts')

    REQUIRED_FIELD_LABELS = {
        'name': 'Nombre',
        'min_value': 'Último precio',
        'workshop': 'Ubicación',
    }
    REQUIRED_FIELD_ORDER = ['name', 'min_value', 'workshop']
    DETAILS_BREAK_INSERT_REGEX = re.compile(
        r'(?<!^)(?<!\n)(?=(?:veh[ií]culo|vehiculo|auto|posici[oó]n|ubicaci[oó]n|nota|observaciones?|detalle|precio es|último precio|ultimo precio)\s*:?)',
        re.IGNORECASE
    )
    DETAILS_META_PREFIXES = {'vehiculo', 'auto', 'posicion', 'ubicacion', 'nota', 'precio es', 'ultimo precio'}
    DETAILS_OBS_PREFIXES = {'observaciones', 'observacion'}
    DETAILS_DETAIL_PREFIXES = {'detalle'}
    DETAILS_FORBIDDEN_PATTERN = re.compile(r'\b[úu]ltimo\b', re.IGNORECASE)

    def __str__(self):
        return f"{self.name} ({self.auto.brand_model} {self.auto.year})"
    
    def generar_codigo_barras(self):
        """Genera código de barras único basado en ID y año del auto"""
        if not self.barcode and self.id and self.auto:
            self.barcode = f"INV{self.id:06d}{self.auto.year}"
        return self.barcode

    @staticmethod
    def _upper_or_none(value):
        if value is None:
            return None
        value = str(value).strip()
        return value.upper() if value else None

    def save(self, *args, **kwargs):
        """Asegura mantener sold_at cuando la pieza se marca como vendida.

        - Si pasa de no vendida a vendida y no tenemos sold_at, se fija ahora.
        - Si se desmarca como vendida, conservamos sold_at como histórico.
        - Genera código de barras automáticamente si no existe
        """
        # Normalizar campos de texto críticos en mayúsculas
        self.name = self._upper_or_none(self.name) or ""
        self.catalog_name = self._upper_or_none(self.catalog_name)
        self.position = self._upper_or_none(self.position)

        # Depurar detalles antes de guardar
        if self.details:
            self.details = self.clean_details_value(self.details)

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

    @cached_property
    def missing_required_fields(self):
        """Campos críticos faltantes para marcar disponibilidad."""
        missing = []
        for field in self.REQUIRED_FIELD_ORDER:
            if field == 'name':
                if not (self.name or '').strip():
                    missing.append(field)
            elif field == 'min_value':
                if not (self.min_value or 0):
                    missing.append(field)
            elif field == 'workshop':
                workshop_name = ''
                workshop = getattr(self, 'workshop', None)
                if workshop:
                    workshop_name = (workshop.name or '').strip()
                if not workshop_name:
                    missing.append(field)
        return missing

    @property
    def missing_required_fields_labels(self):
        return [
            self.REQUIRED_FIELD_LABELS.get(field, field)
            for field in self.missing_required_fields
        ]

    @property
    def is_incomplete(self):
        return bool(self.missing_required_fields)

    @property
    def next_missing_label(self):
        labels = self.missing_required_fields_labels
        return labels[0] if labels else ''

    @property
    def availability_status(self):
        if self.sold:
            return 'vendido'
        if self.is_incomplete:
            return 'no_disponible'
        return 'disponible'

    @property
    def availability_label(self):
        return {
            'vendido': 'Vendido',
            'no_disponible': 'No disponible',
            'disponible': 'Disponible',
        }[self.availability_status]

    @classmethod
    def _parse_details_text(cls, text):
        if not text:
            return {'detail': '', 'observations': ''}
        prepared = cls.DETAILS_BREAK_INSERT_REGEX.sub('\n', text.replace('\r', '\n'))
        lines = [line.strip() for line in prepared.splitlines() if line.strip()]
        detail_parts = []
        observations = []
        for line in lines:
            prefix_key = cls._normalize_prefix(line)
            value_part = line.split(':', 1)[-1].strip() if ':' in line else ''
            if any(prefix_key.startswith(prefix) for prefix in cls.DETAILS_OBS_PREFIXES):
                if value_part:
                    observations.append(value_part)
                continue
            if any(prefix_key.startswith(prefix) for prefix in cls.DETAILS_META_PREFIXES):
                continue
            if any(prefix_key.startswith(prefix) for prefix in cls.DETAILS_DETAIL_PREFIXES):
                if value_part:
                    detail_parts.append(value_part)
                continue
            detail_parts.append(line)
        return {
            'detail': ' '.join(detail_parts).strip(),
            'observations': ' '.join(observations).strip()
        }

    @classmethod
    def _strip_forbidden_terms(cls, text):
        if not text:
            return ''
        cleaned = cls.DETAILS_FORBIDDEN_PATTERN.sub(' ', text)
        return re.sub(r'\s{2,}', ' ', cleaned).strip()

    @classmethod
    def _serialize_details(cls, parsed):
        lines = []
        detail = cls._strip_forbidden_terms((parsed or {}).get('detail', '').strip())
        observations = cls._strip_forbidden_terms((parsed or {}).get('observations', '').strip())
        if detail:
            lines.append(detail)
        if observations:
            lines.append(f"Observaciones: {observations}")
        return '\n'.join(lines).strip()

    @classmethod
    def clean_details_value(cls, value):
        return cls._serialize_details(cls._parse_details_text(value))

    @cached_property
    def parsed_details(self):
        return self._parse_details_text(self.details)

    @property
    def details_display(self):
        return self.parsed_details.get('detail', '')

    @property
    def details_serialized(self):
        return self.clean_details_value(self.details)

    @property
    def detail_sections(self):
        sections = []
        if self.catalog_name:
            sections.append({'label': 'Nombre original', 'value': self.catalog_name})
        parsed = self.parsed_details
        detail_text = parsed.get('detail')
        if detail_text:
            sections.append({'label': 'Detalle', 'value': detail_text})
        observations = parsed.get('observations')
        if observations:
            sections.append({'label': 'Observaciones', 'value': observations})
        return sections

    @staticmethod
    def _normalize_prefix(value):
        base = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore').decode('ascii')
        return base.split(':', 1)[0].strip().lower()


class PartPhoto(models.Model):
    part = models.ForeignKey(Part, on_delete=models.CASCADE, related_name='photos')
    image = models.ImageField(upload_to='part_photos/')
    created_at = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=50, default='manual', help_text="Origen de la foto (ej: handsfree)")

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f"Foto {self.id} de {self.part.name}"


def normalize_synonym_text(value: str) -> str:
    if not value:
        return ''
    normalized = unicodedata.normalize('NFKD', value.strip().lower())
    return ''.join(ch for ch in normalized if not unicodedata.combining(ch))


class SynonymGroup(models.Model):
    """Agrupa términos equivalentes (pieza, ubicación, estado, etc.)."""

    class Category(models.TextChoices):
        PART = 'part', 'Pieza'
        POSITION = 'position', 'Posición'
        STATE = 'state', 'Estado'
        GENERIC = 'generic', 'Genérico'

    name = models.CharField(max_length=120, unique=True)
    category = models.CharField(max_length=32, choices=Category.choices, default=Category.PART)
    description = models.CharField(max_length=255, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class SynonymTerm(models.Model):
    """Variantes textuales pertenecientes a un grupo."""

    group = models.ForeignKey(SynonymGroup, on_delete=models.CASCADE, related_name='terms')
    term = models.CharField(max_length=120)
    normalized_term = models.CharField(max_length=120, db_index=True, editable=False)
    priority = models.PositiveSmallIntegerField(default=0, help_text="Menor valor = mayor prioridad")
    locale = models.CharField(max_length=16, blank=True, default='', help_text="Región/idioma opcional")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['group', 'priority', 'term']
        unique_together = [('group', 'term')]
        indexes = [
            models.Index(fields=['normalized_term']),
            models.Index(fields=['group', 'priority']),
        ]

    def save(self, *args, **kwargs):
        self.normalized_term = normalize_synonym_text(self.term)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.term} → {self.group.name}"


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
    is_capturing: True entre "Iniciar ingreso" y "Detener ingreso"
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
    correlation_id = models.CharField(max_length=64, blank=True, default='', db_index=True, help_text="ID para agrupar eventos correlacionados")
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='subeventos')
    ip_origen = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=256, blank=True, default='')
    hash_previo = models.CharField(max_length=64, blank=True, default='', help_text="Hash del evento anterior en la cadena")
    hash_actual = models.CharField(max_length=64, blank=True, default='', help_text="Hash SHA256 del evento actual")
    
    class Meta:
        verbose_name = "Evento del Sistema"
        verbose_name_plural = "Eventos del Sistema"
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp', 'categoria']),
            models.Index(fields=['-timestamp', 'nivel']),
            models.Index(fields=['request_id']),
            models.Index(fields=['correlation_id', '-timestamp']),
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
                  request_id='', correlation_id='', parent=None, ip_origen=None, user_agent=''):
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
        now = timezone.now()
        raw_data = datos or {}
        try:
            safe_data = json.loads(json.dumps(raw_data, default=str))
        except TypeError:
            safe_data = json.loads(json.dumps(str(raw_data), default=str))

        payload = {
            'timestamp': now.isoformat(),
            'categoria': categoria,
            'accion': accion,
            'descripcion': descripcion,
            'nivel': nivel,
            'usuario_id': getattr(usuario, 'id', None),
            'pieza_id': getattr(pieza, 'id', None),
            'sesion_voz_id': getattr(sesion_voz, 'id', None),
            'datos': safe_data,
            'exito': exito,
            'error_mensaje': error_mensaje,
            'duracion_ms': duracion_ms,
            'request_id': request_id or '',
            'correlation_id': correlation_id or '',
            'parent_id': getattr(parent, 'id', None),
            'ip_origen': ip_origen,
            'user_agent': user_agent or '',
        }
        previous_hash = cls.objects.order_by('-timestamp', '-id').values_list('hash_actual', flat=True).first() or ''
        payload_str = json.dumps(payload, sort_keys=True, default=str)
        hash_actual = hashlib.sha256(f"{previous_hash}|{payload_str}".encode('utf-8')).hexdigest()

        return cls.objects.create(
            categoria=categoria,
            nivel=nivel,
            accion=accion,
            descripcion=descripcion,
            usuario=usuario,
            pieza=pieza,
            sesion_voz=sesion_voz,
            datos=safe_data,
            exito=exito,
            error_mensaje=error_mensaje,
            duracion_ms=duracion_ms,
            request_id=request_id or '',
            correlation_id=correlation_id or '',
            parent=parent,
            ip_origen=ip_origen,
            user_agent=user_agent or '',
            hash_previo=previous_hash,
            hash_actual=hash_actual
        )


class AlertaSistema(models.Model):
    """Alertas disparadas automáticamente por reglas de auditoría."""

    class Severidad(models.TextChoices):
        BAJA = 'low', 'Baja'
        MEDIA = 'medium', 'Media'
        ALTA = 'high', 'Alta'
        CRITICA = 'critical', 'Crítica'

    creada_en = models.DateTimeField(auto_now_add=True, db_index=True)
    tipo = models.CharField(max_length=100, db_index=True)
    severidad = models.CharField(max_length=16, choices=Severidad.choices, default=Severidad.MEDIA)
    descripcion = models.TextField()
    metadatos = models.JSONField(default=dict, blank=True)
    evento = models.ForeignKey(EventoSistema, null=True, blank=True, on_delete=models.SET_NULL, related_name='alertas')
    correlation_id = models.CharField(max_length=64, blank=True, default='', db_index=True)
    request_id = models.CharField(max_length=64, blank=True, default='')
    acknowledged = models.BooleanField(default=False)
    acknowledged_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='alertas_aceptadas')
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-creada_en']
        indexes = [
            models.Index(fields=['-creada_en', 'tipo']),
            models.Index(fields=['severidad', '-creada_en']),
            models.Index(fields=['correlation_id']),
        ]

    def __str__(self):
        return f"Alerta({self.get_severidad_display()} - {self.tipo})"
