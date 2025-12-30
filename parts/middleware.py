"""Convierte excepciones en respuestas JSON y refuerza manejo de sesión expirada."""
import secrets
import uuid
from urllib.parse import urlencode

from django.conf import settings
from django.core.exceptions import PermissionDenied, DisallowedHost
from django.http import Http404, JsonResponse
from django.shortcuts import resolve_url

import logging

from .logging_context import set_context, reset_context

logger = logging.getLogger('parts.middleware')


class SecurityHeadersMiddleware:
    """Asegura encabezados CSP/Referrer-Policy en todas las respuestas."""

    SCRIPT_CDN_SOURCES = (
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net/npm",
        "https://unpkg.com",
        "https://static.cloudflareinsights.com",  # Cloudflare Web Analytics
    )
    STYLE_CDN_SOURCES = (
        "https://fonts.googleapis.com",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
    )
    CONNECT_EXTRA = (
        "https://api.openai.com",
        "https://cdn.jsdelivr.net",
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        nonce = secrets.token_urlsafe(16)
        setattr(request, 'csp_nonce', nonce)
        response = self.get_response(request)
        if not response:
            return response

        # NOTA: No usamos scripts inline para compatibilidad con Turbo SPA.
        # Todos los scripts están en archivos externos con nonce.
        # Ver: Calidad/PRACTICAS_DESARROLLO.txt - Sección CSP + Turbo
        script_src = ["'self'", f"'nonce-{nonce}'", *self.SCRIPT_CDN_SOURCES]
        nonce_token = f"'nonce-{nonce}'"
        # Hashes de estilos inline específicos usados por la aplicación
        # (Turbo puede generar algunos estilos inline durante parseHTMLDocument)
        # Ver: Calidad/PRACTICAS_DESARROLLO.txt - Sección CSP + Turbo
        inline_style_hashes = [
            "'sha256-slBAuFS8II/0OVyG1iq6TGX+ou4IKWv71VWltRryO34='",
            "'sha256-qcbli+4DCLc3PNbu8bzKxrKaoXNugvRN2fsUg8ejCe4='",
            "'sha256-ZPR/EMn2/zndixTCtRDHU6AaRXXSrBvMQiyJP1+3J7U='",  # Turbo parseHTMLDocument
            "'sha256-U2ttywS9yS9QakQPvf8mcRFMVDtnPepmQNIG7WTBg1w='",  # Container max-width inline
            "'sha256-NQuzntng+8Pt8oGSWsZWkKKX41P/R36eJ4VH/Kp2X88='",  # Turbo renderElement frame
        ]
        style_src = ["'self'", nonce_token, *inline_style_hashes, *self.STYLE_CDN_SOURCES]
        style_src_elem = ["'self'", nonce_token, *inline_style_hashes, *self.STYLE_CDN_SOURCES]
        style_src_attr = ["'unsafe-inline'"]
        # IMPORTANT: avoid allowing ws:/wss: to arbitrary hosts in production.
        # Allow WebSocket connections only to the current allowed host.
        connect_src = ["'self'"]
        host = ''
        try:
            host = (request.get_host() or '').strip()
        except Exception:
            host = ''
        if host:
            connect_src.append(f"wss://{host}")
            if getattr(settings, 'DEBUG', False):
                connect_src.append(f"ws://{host}")
        # Dev convenience for local testing
        if getattr(settings, 'DEBUG', False):
            connect_src.extend([
                'ws://localhost:8000',
                'ws://127.0.0.1:8000',
                'wss://localhost:8000',
                'wss://127.0.0.1:8000',
            ])
        connect_src.extend(self.CONNECT_EXTRA)
        img_src = ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"]
        font_src = ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"]
        # script-src-elem hereda de script-src pero lo definimos explícitamente para mayor control
        script_src_elem = script_src.copy()

        csp = (
            f"default-src 'self'; "
            f"base-uri 'self'; "
            f"form-action 'self'; "
            f"object-src 'none'; "
            f"frame-ancestors 'self'; "
            f"script-src {' '.join(script_src)}; "
            f"script-src-elem {' '.join(script_src_elem)}; "
            f"style-src {' '.join(style_src)}; "
            f"style-src-elem {' '.join(style_src_elem)}; "
            f"style-src-attr {' '.join(style_src_attr)}; "
            f"img-src {' '.join(img_src)}; "
            f"font-src {' '.join(font_src)}; "
            f"connect-src {' '.join(connect_src)}; "
            "upgrade-insecure-requests"
        )

        response.headers.setdefault('Content-Security-Policy', csp)
        response.headers.setdefault('Referrer-Policy', 'same-origin')
        
        # Permissions-Policy (sintaxis correcta)
        permissions_rules = [
            "camera=(self)",
            "microphone=(self)",
            "geolocation=()",
            "fullscreen=(self)"
        ]
        response.headers.setdefault('Permissions-Policy', ', '.join(permissions_rules))
        
        # Eliminar Feature-Policy deprecado si existe
        response.headers.pop('Feature-Policy', None)
        
        response.headers.setdefault('Cross-Origin-Opener-Policy', 'same-origin')
        return response


class RequestContextMiddleware:
    """Inyecta request_id / correlation_id en el request y en el contexto de logging."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        header_request = request.META.get('HTTP_X_REQUEST_ID') or request.headers.get('X-Request-ID')
        request_id = header_request or f"req-{uuid.uuid4().hex[:12]}"
        setattr(request, 'request_id', request_id)

        header_corr = request.META.get('HTTP_X_CORRELATION_ID') or request.headers.get('X-Correlation-ID')
        qs_corr = request.GET.get('correlation_id') or request.POST.get('correlation_id')
        correlation_id = header_corr or qs_corr or getattr(request, 'correlation_id', None) or request_id
        setattr(request, 'correlation_id', correlation_id)

        session_id = ''
        if hasattr(request, 'session') and request.session.session_key:
            session_id = request.session.session_key
        user_id = ''
        if hasattr(request, 'user') and request.user.is_authenticated:
            user_id = str(request.user.id)

        tokens = set_context(
            request_id=request_id,
            correlation_id=correlation_id,
            session_id=session_id,
            user_id=user_id,
        )
        try:
            response = self.get_response(request)
        finally:
            reset_context(tokens)

        if response is not None:
            response['X-Request-ID'] = request_id
            response['X-Correlation-ID'] = correlation_id
        return response


class SessionExpiryMiddleware:
    """Detecta redirecciones al login para peticiones AJAX/Turbo y responde 401 controlado."""

    REDIRECT_CODES = {301, 302, 303, 307, 308}

    def __init__(self, get_response):
        self.get_response = get_response
        self.login_path = resolve_url(getattr(settings, 'LOGIN_URL', '/login/'))
        self._static_url = getattr(settings, 'STATIC_URL', '/static/')
        self._media_url = getattr(settings, 'MEDIA_URL', '/media/')

    def __call__(self, request):
        response = self.get_response(request)
        if not response:
            return response

        if request.user.is_authenticated:
            return response

        if self._es_ruta_publica(request.path):
            return response

        if not self._es_peticion_js(request):
            return response

        if self._responde_login_redirect(response):
            return self._respuesta_expirada(request)

        return response

    def _es_peticion_js(self, request):
        ajax_flag = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        turbo_flag = bool(request.headers.get('Turbo-Frame') or request.headers.get('Turbo-Visit'))
        accept_json = 'application/json' in (request.headers.get('Accept') or '')
        return ajax_flag or turbo_flag or accept_json

    def _responde_login_redirect(self, response):
        if response.status_code not in self.REDIRECT_CODES:
            return False
        destino = getattr(response, 'url', None) or response.headers.get('Location')
        return bool(destino and self.login_path in destino)

    def _es_ruta_publica(self, path):
        if not path:
            return False
        if path.startswith(self.login_path):
            return True
        if self._static_url and path.startswith(self._static_url):
            return True
        if self._media_url and path.startswith(self._media_url):
            return True
        return False

    def _respuesta_expirada(self, request):
        next_url = request.get_full_path()
        login_url = self._build_login_url(next_url)
        payload = {
            'success': False,
            'detail': 'sesion_expirada',
            'login_url': login_url,
            'next': next_url,
        }
        resp = JsonResponse(payload, status=401)
        resp['X-Session-Expired'] = '1'
        resp['Location'] = login_url
        return resp

    def _build_login_url(self, next_url):
        if not next_url:
            return self.login_path
        if '?' in self.login_path:
            return f"{self.login_path}&{urlencode({'next': next_url})}"
        return f"{self.login_path}?{urlencode({'next': next_url})}"


class AjaxErrorMiddleware:
    """Captura excepciones comunes y las devuelve en un JSON amigable."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        return response

    def process_exception(self, request, exception):
        """Solo interviene cuando la llamada viene desde JS."""
        es_ajax = (
            request.headers.get('X-Requested-With') == 'XMLHttpRequest' or
            request.POST.get('ajax') == 'true' or
            request.GET.get('ajax') == 'true'
        )
        
        if not es_ajax:
            return None
        
        logger.error(f"Error en petición AJAX: {type(exception).__name__}: {exception}")
        
        # Convertir excepciones comunes a JSON
        if isinstance(exception, PermissionDenied):
            return JsonResponse({
                'success': False,
                'error': 'Permiso denegado',
                'detail': str(exception)
            }, status=403)
        
        elif isinstance(exception, Http404):
            return JsonResponse({
                'success': False,
                'error': 'No encontrado',
                'detail': str(exception)
            }, status=404)
        
        elif isinstance(exception, DisallowedHost):
            return JsonResponse({
                'success': False,
                'error': 'Host no permitido',
                'detail': str(exception)
            }, status=400)
        
        else:
            # Error genérico (ocultar detalles sensibles)
            logger.exception("Error inesperado en petición AJAX", exc_info=exception)
            return JsonResponse({
                'success': False,
                'error': 'Error del servidor',
                'detail': 'Se produjo un error inesperado. Intenta nuevamente.'
            }, status=500)
