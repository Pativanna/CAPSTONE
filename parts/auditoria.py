# parts/auditoria.py
"""
Sistema de Auditoría Centralizado

Proporciona funciones de alto nivel para registrar eventos del sistema
y mantener un log completo de auditoría para diagnóstico y compliance.
"""

import logging
import time
import uuid
from contextlib import contextmanager
from functools import wraps
from typing import Optional, Dict, Any
from django.contrib.auth.models import User
from django.http import HttpRequest

from .logging_context import (
    set_context,
    reset_context,
    get_context,
    ensure_request_id,
    ensure_correlation_id,
    use_context,
)
from .audit_alerts import AuditAlertEngine
from .utils.privacy import anonymize_ip

logger = logging.getLogger('parts.auditoria')


def obtener_request_id(request: Optional[HttpRequest] = None) -> str:
    """Reutiliza o genera un ID corto para correlacionar eventos."""
    if request and getattr(request, 'request_id', None):
        ensure_request_id(request.request_id)
        return request.request_id
    new_id = ensure_request_id()
    if request:
        setattr(request, 'request_id', new_id)
    return new_id


def obtener_correlation_id(request: Optional[HttpRequest] = None, correlation_id: Optional[str] = None) -> str:
    """Obtiene un correlation_id consistente."""
    if correlation_id:
        ensure_correlation_id(correlation_id)
        if request:
            setattr(request, 'correlation_id', correlation_id)
        return correlation_id

    if request and getattr(request, 'correlation_id', None):
        ensure_correlation_id(request.correlation_id)
        return request.correlation_id

    header_corr = None
    if request:
        header_corr = (
            request.META.get('HTTP_X_CORRELATION_ID') or
            request.headers.get('X-Correlation-ID') or
            request.GET.get('correlation_id') or
            request.POST.get('correlation_id')
        )
    if header_corr:
        ensure_correlation_id(header_corr)
        if request:
            setattr(request, 'correlation_id', header_corr)
        return header_corr

    ctx_corr = get_context().get('correlation_id')
    if ctx_corr:
        return ctx_corr

    new_corr = ensure_correlation_id()
    if request:
        setattr(request, 'correlation_id', new_corr)
    return new_corr


def obtener_ip_cliente(request: Optional[HttpRequest]) -> Optional[str]:
    """Devuelve la IP anonimizada del cliente considerando proxies."""
    if not request:
        return None
    
    # Intentar obtener IP real detrás de proxy
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        raw_ip = x_forwarded_for.split(',')[0].strip()
    else:
        raw_ip = request.META.get('REMOTE_ADDR')
    return anonymize_ip(raw_ip)


def obtener_user_agent(request: Optional[HttpRequest]) -> str:
    """Extrae el User-Agent del request."""
    if not request:
        return ''
    return request.META.get('HTTP_USER_AGENT', '')[:256]


class Auditoria:
    """
    Clase principal de auditoría con métodos estáticos para registrar eventos.
    
    Uso:
        from parts.auditoria import Auditoria
        
        # Registro simple
        Auditoria.pieza_creada(pieza, usuario, request)
        
        # Registro con contexto adicional
        Auditoria.evento(
            categoria='barcode',
            accion='generar_codigo',
            descripcion='Código de barras generado',
            pieza=pieza,
            datos={'codigo': barcode, 'formato': 'CODE128'}
        )
    """
    
    @staticmethod
    @staticmethod
    @contextmanager
    def correlacion(correlation_id: Optional[str] = None):
        """Contexto para forzar un correlation_id específico."""
        corr = correlation_id or uuid.uuid4().hex[:12]
        tokens = set_context(correlation_id=corr)
        try:
            yield corr
        finally:
            reset_context(tokens)
    
    @staticmethod
    def evento(categoria: str, accion: str, descripcion: str, 
               nivel: str = 'info', usuario: Optional[User] = None,
               pieza=None, sesion_voz=None, datos: Optional[Dict] = None,
               exito: bool = True, error_mensaje: str = '',
               duracion_ms: Optional[int] = None, request: Optional[HttpRequest] = None,
               correlation_id: Optional[str] = None, parent_event: Optional['EventoSistema'] = None):
        """
        Registra un evento genérico en el sistema de auditoría.
        
        Args:
            categoria: Categoría del evento (pieza, barcode, voz, etc.)
            accion: Acción realizada (crear, modificar, eliminar, etc.)
            descripcion: Descripción detallada del evento
            nivel: Nivel de log (debug, info, warning, error, critical)
            usuario: Usuario que realizó la acción
            pieza: Pieza relacionada con el evento
            sesion_voz: Sesión de voz relacionada
            datos: Diccionario con datos adicionales
            exito: Si la operación fue exitosa
            error_mensaje: Mensaje de error si aplica
            duracion_ms: Duración de la operación en milisegundos
            request: Request HTTP para extraer contexto
        """
        from .models import EventoSistema
        
        try:
            # Extraer contexto del request
            request_id = obtener_request_id(request)
            corr_id = obtener_correlation_id(request, correlation_id)
            ip_origen = obtener_ip_cliente(request)
            user_agent = obtener_user_agent(request)
            
            # Si no se proporcionó usuario pero hay request, intentar obtenerlo
            if not usuario and request and hasattr(request, 'user') and request.user.is_authenticated:
                usuario = request.user
            
            context_tokens = set_context(request_id=request_id, correlation_id=corr_id)
            try:
                evento = EventoSistema.registrar(
                    categoria=categoria,
                    accion=accion,
                    descripcion=descripcion,
                    nivel=nivel,
                    usuario=usuario,
                    pieza=pieza,
                    sesion_voz=sesion_voz,
                    datos=datos or {},
                    exito=exito,
                    error_mensaje=error_mensaje,
                    duracion_ms=duracion_ms,
                    request_id=request_id,
                    correlation_id=corr_id,
                    parent=parent_event,
                    ip_origen=ip_origen,
                    user_agent=user_agent
                )
                log_method = getattr(logger, nivel, logger.info)
                estado = '✓' if exito else '✗'
                session_id = ''
                if request and hasattr(request, 'session') and request.session.session_key:
                    session_id = request.session.session_key
                log_method(
                    f"[{request_id}] {estado} {categoria}:{accion} - {descripcion}",
                    extra={
                        'request_id': request_id,
                        'correlation_id': corr_id,
                        'session_id': session_id,
                        'user_id': getattr(usuario, 'id', '') or '',
                    }
                )
                try:
                    AuditAlertEngine.evaluate(evento)
                except Exception:
                    logger.exception("Error evaluando alertas de auditoría")
                return evento
            finally:
                reset_context(context_tokens)
            
        except Exception as e:
            # Si falla el registro de auditoría, no debe detener la operación
            logger.exception(f"Error registrando evento de auditoría: {e}")
            return None
    
    # ========================================
    # MÉTODOS DE CONVENIENCIA PARA PIEZAS
    # ========================================
    
    @staticmethod
    def pieza_creada(pieza, usuario=None, request=None, datos_extra=None):
        """Logea una alta de pieza."""
        datos = {
            'pieza_id': pieza.id,
            'nombre': pieza.name,
            'auto': str(pieza.auto),
            'taller': str(pieza.workshop),
            'barcode': pieza.barcode,
            'precio_max': pieza.max_value,
            'precio_min': pieza.min_value,
        }
        if datos_extra:
            datos.update(datos_extra)
        
        return Auditoria.evento(
            categoria='pieza',
            accion='crear_pieza',
            descripcion=f'Pieza creada: {pieza.name} ({pieza.auto})',
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def pieza_modificada(pieza, usuario=None, request=None, campos_modificados=None):
        """Guarda que se actualizó una pieza."""
        datos = {
            'pieza_id': pieza.id,
            'nombre': pieza.name,
            'campos_modificados': campos_modificados or []
        }
        
        return Auditoria.evento(
            categoria='pieza',
            accion='modificar_pieza',
            descripcion=f'Pieza modificada: {pieza.name} (ID: {pieza.id})',
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def pieza_eliminada(pieza, usuario=None, request=None):
        """Logea la eliminación de una pieza."""
        datos = {
            'pieza_id': pieza.id,
            'nombre': pieza.name,
            'auto': str(pieza.auto),
            'barcode': pieza.barcode
        }
        
        return Auditoria.evento(
            categoria='pieza',
            accion='eliminar_pieza',
            descripcion=f'Pieza eliminada: {pieza.name} (ID: {pieza.id})',
            nivel='warning',
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def pieza_vendida(pieza, usuario=None, request=None):
        """Registra una venta concretada."""
        datos = {
            'pieza_id': pieza.id,
            'nombre': pieza.name,
            'precio': pieza.max_value,
            'fecha_venta': pieza.sold_at.isoformat() if pieza.sold_at else None
        }
        
        return Auditoria.evento(
            categoria='pieza',
            accion='vender_pieza',
            descripcion=f'Pieza vendida: {pieza.name} (${pieza.max_value})',
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            request=request
        )
    
    # ========================================
    # MÉTODOS PARA CÓDIGOS DE BARRAS
    # ========================================
    
    @staticmethod
    def barcode_generado(pieza, codigo, formato='CODE128', usuario=None, request=None):
        """Se genera un código de barras/QR."""
        datos = {
            'pieza_id': pieza.id,
            'codigo': codigo,
            'formato': formato,
            'nombre_pieza': pieza.name
        }
        
        return Auditoria.evento(
            categoria='barcode',
            accion='generar_codigo',
            descripcion=f'Código de barras generado para {pieza.name}: {codigo}',
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def barcode_impreso(pieza, exito=True, metodo='usb', error=None, usuario=None, request=None):
        """Registra que se intentó imprimir una etiqueta."""
        datos = {
            'pieza_id': pieza.id,
            'codigo': pieza.barcode,
            'metodo_impresion': metodo,
            'nombre_pieza': pieza.name
        }
        
        nivel = 'info' if exito else 'error'
        descripcion = f'Etiqueta impresa para {pieza.name}' if exito else f'Error imprimiendo etiqueta para {pieza.name}'
        
        return Auditoria.evento(
            categoria='impresion',
            accion='imprimir_etiqueta',
            descripcion=descripcion,
            nivel=nivel,
            usuario=usuario,
            pieza=pieza,
            datos=datos,
            exito=exito,
            error_mensaje=error or '',
            request=request
        )
    
    # ========================================
    # MÉTODOS PARA VOZ
    # ========================================
    
    @staticmethod
    def sesion_voz_iniciada(sesion_voz, usuario=None, request=None):
        """Marca el inicio de una sesión manos libres."""
        datos = {
            'session_id': sesion_voz.session_id,
        }
        
        return Auditoria.evento(
            categoria='voz',
            accion='iniciar_sesion',
            descripcion=f'Sesión de voz iniciada: {sesion_voz.session_id}',
            usuario=usuario,
            sesion_voz=sesion_voz,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def sesion_voz_cerrada(sesion_voz, transcripciones_totales=0, usuario=None, request=None):
        """Se cerró la sesión Vosk/WebRTC."""
        datos = {
            'session_id': sesion_voz.session_id,
            'duracion_segundos': (sesion_voz.ended_at - sesion_voz.started_at).total_seconds() if sesion_voz.ended_at else None,
            'transcripciones_totales': transcripciones_totales,
            'partials': sesion_voz.partial_count,
            'finals': sesion_voz.final_count,
            'comandos': sesion_voz.command_count
        }
        
        return Auditoria.evento(
            categoria='voz',
            accion='cerrar_sesion',
            descripcion=f'Sesión de voz cerrada: {sesion_voz.session_id} ({transcripciones_totales} transcripciones)',
            usuario=usuario,
            sesion_voz=sesion_voz,
            datos=datos,
            request=request
        )
    
    @staticmethod
    def voz_proceso_extraido(sesion_voz, datos_extraidos, pieza=None, usuario=None, request=None):
        """Datos estructurados obtenidos desde la voz."""
        datos = {
            'session_id': sesion_voz.session_id,
            'datos_extraidos': datos_extraidos,
            'pieza_id': pieza.id if pieza else None
        }
        
        return Auditoria.evento(
            categoria='voz',
            accion='extraer_datos',
            descripcion=f'Datos extraídos de voz para pieza: {datos_extraidos.get("parte", "N/A")}',
            usuario=usuario,
            pieza=pieza,
            sesion_voz=sesion_voz,
            datos=datos,
            request=request
        )
    
    # ========================================
    # MÉTODOS PARA ERRORES
    # ========================================
    
    @staticmethod
    def error_sistema(descripcion, error_exception=None, categoria='sistema', 
                      accion='error', usuario=None, request=None, datos_extra=None):
        """Captura errores de cualquier módulo."""
        import traceback
        
        error_mensaje = ''
        if error_exception:
            error_mensaje = f"{type(error_exception).__name__}: {str(error_exception)}\n\n{traceback.format_exc()}"
        
        datos = datos_extra or {}
        datos['tipo_error'] = type(error_exception).__name__ if error_exception else 'Unknown'
        
        return Auditoria.evento(
            categoria=categoria,
            accion=accion,
            descripcion=descripcion,
            nivel='error',
            usuario=usuario,
            datos=datos,
            exito=False,
            error_mensaje=error_mensaje,
            request=request
        )


# ========================================
# DECORADOR PARA AUDITORÍA AUTOMÁTICA
# ========================================

def auditar_operacion(categoria: str, accion: str, obtener_descripcion=None):
    """
    Decorador para auditar automáticamente una función.
    
    Uso:
        @auditar_operacion('pieza', 'crear', lambda result, *args, **kwargs: f'Pieza {result.name} creada')
        def crear_pieza(...):
            ...
    """
    def decorador(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            inicio = time.time()
            request = None
            usuario = None
            error = None
            resultado = None
            
            # Intentar extraer request y usuario de los argumentos
            for arg in args:
                if isinstance(arg, HttpRequest):
                    request = arg
                    if hasattr(request, 'user') and request.user.is_authenticated:
                        usuario = request.user
                    break
            
            try:
                resultado = func(*args, **kwargs)
                exito = True
                error_mensaje = ''
            except Exception as e:
                exito = False
                error = e
                error_mensaje = str(e)
                raise
            finally:
                duracion_ms = int((time.time() - inicio) * 1000)
                
                # Generar descripción
                if obtener_descripcion:
                    try:
                        descripcion = obtener_descripcion(resultado, *args, **kwargs)
                    except:
                        descripcion = f'{accion} ejecutado'
                else:
                    descripcion = f'{accion} ejecutado'
                
                # Registrar evento
                Auditoria.evento(
                    categoria=categoria,
                    accion=accion,
                    descripcion=descripcion,
                    usuario=usuario,
                    exito=exito,
                    error_mensaje=error_mensaje,
                    duracion_ms=duracion_ms,
                    request=request
                )
            
            return resultado
        return wrapper
    return decorador
