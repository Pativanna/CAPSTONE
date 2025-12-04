# parts/inventory_models.py
"""
Modelos extendidos para gestión de inventario importado desde Excel.

Este módulo complementa los modelos existentes con información específica
del proceso de importación masiva desde archivos Excel.
"""

from django.db import models
from django.utils import timezone
from django.conf import settings


class VehiculoInventario(models.Model):
    """
    Vehículos del inventario (complementa al modelo Auto existente).
    
    Representa vehículos desde los cuales se obtienen repuestos.
    Un vehículo puede no estar registrado como Auto si solo sirve
    como fuente de piezas.
    """
    
    # Identificación del vehículo
    nombre = models.CharField(max_length=100, unique=True, db_index=True, 
                             help_text="Nombre del vehículo (ej: 116I 2006, OTROS, NEW SAIL 2021)")
    marca_modelo = models.CharField(max_length=100, blank=True, 
                                   help_text="Marca y modelo extraído del nombre")
    anio = models.PositiveIntegerField(null=True, blank=True, 
                                      help_text="Año del vehículo si se puede extraer")
    
    # Relación opcional con Auto existente
    auto_relacionado = models.ForeignKey('Auto', null=True, blank=True, 
                                        on_delete=models.SET_NULL,
                                        related_name='inventarios',
                                        help_text="Auto en sistema si existe")
    
    # Metadata de importación
    fecha_primera_importacion = models.DateTimeField(auto_now_add=True)
    fecha_ultima_actualizacion = models.DateTimeField(auto_now=True)
    total_piezas = models.PositiveIntegerField(default=0)
    piezas_disponibles = models.PositiveIntegerField(default=0)
    piezas_vendidas = models.PositiveIntegerField(default=0)
    
    # Estado
    activo = models.BooleanField(default=True)
    notas = models.TextField(blank=True, help_text="Notas sobre el vehículo fuente")
    
    class Meta:
        verbose_name = "Vehículo de Inventario"
        verbose_name_plural = "Vehículos de Inventario"
        ordering = ['nombre']
    
    def __str__(self):
        return self.nombre
    
    def actualizar_contadores(self):
        """Actualiza contadores de piezas"""
        piezas = self.piezas_inventario.all()
        self.total_piezas = piezas.count()
        self.piezas_disponibles = piezas.filter(stock__in=['DISPONIBLE', 'POR CONFIRMAR']).count()
        self.piezas_vendidas = piezas.filter(stock='VENDIDO').count()
        self.save(update_fields=['total_piezas', 'piezas_disponibles', 'piezas_vendidas', 'fecha_ultima_actualizacion'])


class ImportacionInventario(models.Model):
    """
    Registro de cada importación de inventario desde Excel/CSV.
    
    Mantiene trazabilidad completa de cuándo y cómo se importaron
    los datos, permitiendo auditar cambios y revertir si es necesario.
    """
    
    class Tipo(models.TextChoices):
        EXCEL = 'excel', 'Excel'
        CSV = 'csv', 'CSV'
        MANUAL = 'manual', 'Manual'
        API = 'api', 'API'
    
    class Estado(models.TextChoices):
        EN_PROCESO = 'en_proceso', 'En Proceso'
        COMPLETADA = 'completada', 'Completada'
        FALLIDA = 'fallida', 'Fallida'
        REVERTIDA = 'revertida', 'Revertida'
    
    # Identificación de la importación
    fecha_importacion = models.DateTimeField(auto_now_add=True, db_index=True)
    usuario = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, 
                               null=True, blank=True, related_name='importaciones')
    
    # Información del archivo fuente
    tipo_fuente = models.CharField(max_length=20, choices=Tipo.choices, default=Tipo.EXCEL)
    nombre_archivo = models.CharField(max_length=255, help_text="Nombre del archivo importado")
    ruta_archivo = models.CharField(max_length=500, blank=True, help_text="Ruta completa del archivo")
    
    # Metadata del archivo Excel (si aplica)
    fecha_creacion_archivo = models.DateTimeField(null=True, blank=True,
                                                  help_text="Fecha de creación del Excel según metadata")
    fecha_modificacion_archivo = models.DateTimeField(null=True, blank=True,
                                                      help_text="Última modificación del Excel según metadata")
    autor_archivo = models.CharField(max_length=200, blank=True,
                                    help_text="Autor del archivo según metadata")
    
    # Estadísticas de la importación
    total_filas_procesadas = models.PositiveIntegerField(default=0)
    filas_exitosas = models.PositiveIntegerField(default=0)
    filas_con_errores = models.PositiveIntegerField(default=0)
    filas_con_warnings = models.PositiveIntegerField(default=0)
    
    # Correcciones aplicadas
    total_correcciones_ortografia = models.PositiveIntegerField(default=0)
    total_posiciones_extraidas = models.PositiveIntegerField(default=0)
    total_nombres_persona_detectados = models.PositiveIntegerField(default=0)
    total_estados_anomalos = models.PositiveIntegerField(default=0)
    
    # Estado y resultado
    estado = models.CharField(max_length=20, choices=Estado.choices, default=Estado.EN_PROCESO)
    duracion_segundos = models.FloatField(null=True, blank=True, help_text="Duración del proceso en segundos")
    
    # Logs y errores
    log_resumen = models.TextField(blank=True, help_text="Resumen del proceso de importación")
    errores = models.JSONField(default=list, blank=True, help_text="Lista de errores encontrados")
    warnings = models.JSONField(default=list, blank=True, help_text="Lista de advertencias")
    
    # Datos estadísticos detallados
    estadisticas = models.JSONField(default=dict, blank=True, 
                                   help_text="Estadísticas detalladas de la importación")
    
    # Archivo de reporte generado
    archivo_reporte = models.FileField(upload_to='importaciones/reportes/', 
                                      null=True, blank=True,
                                      help_text="Reporte JSON/PDF de la importación")
    
    class Meta:
        verbose_name = "Importación de Inventario"
        verbose_name_plural = "Importaciones de Inventario"
        ordering = ['-fecha_importacion']
        indexes = [
            models.Index(fields=['-fecha_importacion', 'estado']),
            models.Index(fields=['usuario', '-fecha_importacion']),
        ]
    
    def __str__(self):
        return f"Importación {self.nombre_archivo} - {self.fecha_importacion.strftime('%Y-%m-%d %H:%M')}"


class PiezaInventario(models.Model):
    """
    Pieza de inventario importada desde Excel/CSV.
    
    Complementa al modelo Part existente con información específica
    del inventario masivo. Puede vincularse a un Part existente o
    crear uno nuevo durante el proceso de sincronización.
    """
    
    class EstadoStock(models.TextChoices):
        DISPONIBLE = 'DISPONIBLE', 'Disponible'
        VENDIDO = 'VENDIDO', 'Vendido'
        NO_DISPONIBLE = 'NO DISPONIBLE', 'No Disponible'
        POR_CONFIRMAR = 'POR CONFIRMAR', 'Por Confirmar'
        CONFIRMAR = 'CONFIRMAR', 'Confirmar'
    
    # Relaciones
    vehiculo = models.ForeignKey(VehiculoInventario, on_delete=models.CASCADE,
                                related_name='piezas_inventario')
    importacion = models.ForeignKey(ImportacionInventario, on_delete=models.SET_NULL,
                                   null=True, blank=True,
                                   related_name='piezas_importadas')
    part_relacionado = models.ForeignKey('Part', null=True, blank=True,
                                        on_delete=models.SET_NULL,
                                        related_name='inventarios',
                                        help_text="Part en sistema si ya se sincronizó")
    
    # Datos originales del Excel (tal cual vienen)
    nombre_original = models.TextField(help_text="Nombre exacto como viene en el Excel")
    
    # Datos normalizados y procesados
    nombre_normalizado = models.CharField(max_length=200, db_index=True,
                                         help_text="Nombre normalizado (sin posiciones, corregido)")
    posicion = models.CharField(max_length=100, blank=True,
                               help_text="Posición extraída (Izquierda/Derecha, Delantera/Trasera, etc)")
    
    # Stock y ubicación
    stock = models.CharField(max_length=20, choices=EstadoStock.choices, default=EstadoStock.DISPONIBLE)
    ubicacion = models.CharField(max_length=100, blank=True,
                                help_text="Ubicación física del repuesto")
    
    # Precios
    precio = models.DecimalField(max_digits=10, decimal_places=2, default=0,
                                help_text="Precio actual de venta")
    ultimo_precio = models.DecimalField(max_digits=10, decimal_places=2, default=0,
                                       help_text="Último precio registrado (histórico)")
    
    # Información adicional
    venta = models.CharField(max_length=200, blank=True,
                            help_text="Información de venta si aplica")
    nota = models.TextField(blank=True,
                           help_text="Notas adicionales del Excel")
    observaciones = models.TextField(blank=True,
                                    help_text="Observaciones automáticas: errores detectados, warnings, etc")
    
    # Metadata de procesamiento
    tiene_errores_ortografia = models.BooleanField(default=False)
    tiene_nombre_persona = models.BooleanField(default=False)
    tiene_estado_anomalo = models.BooleanField(default=False)
    tiene_precio_anomalo = models.BooleanField(default=False)
    sin_ubicacion = models.BooleanField(default=False)
    es_multiple_piezas = models.BooleanField(default=False, help_text="JUEGO, KIT, PAR detectado")
    
    # Flags de calidad
    calidad_datos = models.PositiveSmallIntegerField(default=100,
                                                     help_text="Calidad de 0-100 según anomalías detectadas")
    requiere_revision = models.BooleanField(default=False, db_index=True,
                                           help_text="Marcado para revisión manual")
    revisado = models.BooleanField(default=False)
    revisado_por = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                    on_delete=models.SET_NULL,
                                    related_name='piezas_revisadas')
    fecha_revision = models.DateTimeField(null=True, blank=True)
    
    # Sincronización con Part
    sincronizado = models.BooleanField(default=False, db_index=True,
                                      help_text="True si ya se creó/actualizó un Part correspondiente")
    fecha_sincronizacion = models.DateTimeField(null=True, blank=True)
    
    # Timestamps
    fecha_ingesta_excel = models.DateTimeField(null=True, blank=True,
                                              help_text="Fecha aproximada cuando se ingresó en el Excel")
    fecha_importacion = models.DateTimeField(auto_now_add=True)
    fecha_actualizacion = models.DateTimeField(auto_now=True)
    
    # Hash para detección de duplicados
    hash_contenido = models.CharField(max_length=64, blank=True, db_index=True,
                                     help_text="SHA256 de campos clave para detectar duplicados")
    
    class Meta:
        verbose_name = "Pieza de Inventario"
        verbose_name_plural = "Piezas de Inventario"
        ordering = ['vehiculo', 'nombre_normalizado']
        indexes = [
            models.Index(fields=['vehiculo', 'stock']),
            models.Index(fields=['stock', 'sincronizado']),
            models.Index(fields=['requiere_revision', '-calidad_datos']),
            models.Index(fields=['sincronizado', 'fecha_importacion']),
            models.Index(fields=['hash_contenido']),
        ]
    
    def __str__(self):
        return f"{self.vehiculo.nombre} - {self.nombre_normalizado}"
    
    def calcular_calidad(self):
        """Calcula score de calidad de datos (0-100)"""
        calidad = 100
        
        # Penalizaciones
        if self.tiene_errores_ortografia:
            calidad -= 10
        if self.tiene_nombre_persona:
            calidad -= 15
        if self.tiene_estado_anomalo:
            calidad -= 20
        if self.tiene_precio_anomalo:
            calidad -= 15
        if self.sin_ubicacion:
            calidad -= 10
        if not self.nombre_normalizado:
            calidad -= 30
        if self.precio <= 0 and self.stock == 'DISPONIBLE':
            calidad -= 10
        
        self.calidad_datos = max(0, calidad)
        return self.calidad_datos
    
    def generar_hash(self):
        """Genera hash único para detectar duplicados"""
        import hashlib
        contenido = f"{self.vehiculo_id}|{self.nombre_original}|{self.ubicacion}|{self.precio}"
        self.hash_contenido = hashlib.sha256(contenido.encode('utf-8')).hexdigest()
        return self.hash_contenido
    
    def save(self, *args, **kwargs):
        """Override save para calcular calidad y hash automáticamente"""
        self.calcular_calidad()
        self.generar_hash()
        
        # Marcar para revisión si calidad < 70
        if self.calidad_datos < 70:
            self.requiere_revision = True
        
        super().save(*args, **kwargs)


class CorreccionOrtografica(models.Model):
    """
    Registro de correcciones ortográficas aplicadas durante importación.
    
    Permite auditar qué correcciones se hicieron y con qué frecuencia
    aparecen ciertos errores.
    """
    
    palabra_original = models.CharField(max_length=100, db_index=True)
    palabra_corregida = models.CharField(max_length=100)
    frecuencia = models.PositiveIntegerField(default=0,
                                             help_text="Cuántas veces se encontró este error")
    
    # Relaciones
    importacion = models.ForeignKey(ImportacionInventario, on_delete=models.CASCADE,
                                   related_name='correcciones')
    
    # Contexto
    ejemplos = models.JSONField(default=list, blank=True,
                               help_text="Ejemplos de textos donde apareció el error")
    
    fecha_primera_deteccion = models.DateTimeField(auto_now_add=True)
    fecha_ultima_deteccion = models.DateTimeField(auto_now=True)
    
    class Meta:
        verbose_name = "Corrección Ortográfica"
        verbose_name_plural = "Correcciones Ortográficas"
        ordering = ['-frecuencia', 'palabra_original']
        unique_together = [['importacion', 'palabra_original']]
    
    def __str__(self):
        return f"{self.palabra_original} → {self.palabra_corregida} ({self.frecuencia}x)"


class AnomaliaInventario(models.Model):
    """
    Anomalías detectadas durante el procesamiento del inventario.
    
    Registra problemas encontrados para facilitar limpieza de datos
    y mejora continua del proceso de importación.
    """
    
    class Tipo(models.TextChoices):
        NOMBRE_PERSONA = 'nombre_persona', 'Nombre de Persona'
        ESTADO_ANOMALO = 'estado_anomalo', 'Estado Anómalo'
        PRECIO_INVALIDO = 'precio_invalido', 'Precio Inválido'
        SIN_UBICACION = 'sin_ubicacion', 'Sin Ubicación'
        DUPLICADO = 'duplicado', 'Duplicado'
        TEXTO_DUPLICADO = 'texto_duplicado', 'Texto Duplicado (DE DE)'
        MULTIPLE_PIEZAS = 'multiple_piezas', 'Múltiples Piezas'
        INCONSISTENCIA = 'inconsistencia', 'Inconsistencia de Datos'
    
    class Severidad(models.TextChoices):
        BAJA = 'baja', 'Baja'
        MEDIA = 'media', 'Media'
        ALTA = 'alta', 'Alta'
    
    # Relaciones
    pieza = models.ForeignKey(PiezaInventario, on_delete=models.CASCADE,
                             related_name='anomalias')
    importacion = models.ForeignKey(ImportacionInventario, on_delete=models.CASCADE,
                                   related_name='anomalias')
    
    # Clasificación
    tipo = models.CharField(max_length=30, choices=Tipo.choices, db_index=True)
    severidad = models.CharField(max_length=10, choices=Severidad.choices, default=Severidad.MEDIA)
    
    # Descripción
    descripcion = models.TextField(help_text="Descripción detallada de la anomalía")
    valor_detectado = models.CharField(max_length=200, blank=True,
                                      help_text="Valor que causó la anomalía")
    campo_afectado = models.CharField(max_length=50, blank=True,
                                     help_text="Campo donde se detectó (nombre, precio, etc)")
    
    # Resolución
    resuelta = models.BooleanField(default=False)
    fecha_resolucion = models.DateTimeField(null=True, blank=True)
    resuelto_por = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                    on_delete=models.SET_NULL,
                                    related_name='anomalias_resueltas')
    notas_resolucion = models.TextField(blank=True)
    
    fecha_deteccion = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        verbose_name = "Anomalía de Inventario"
        verbose_name_plural = "Anomalías de Inventario"
        ordering = ['-severidad', '-fecha_deteccion']
        indexes = [
            models.Index(fields=['tipo', 'resuelta']),
            models.Index(fields=['severidad', '-fecha_deteccion']),
            models.Index(fields=['pieza', 'tipo']),
        ]
    
    def __str__(self):
        return f"{self.get_tipo_display()} - {self.pieza.nombre_normalizado[:50]}"
