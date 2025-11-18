"""Convierte excepciones en respuestas JSON y refuerza manejo de sesión expirada."""
from urllib.parse import urlencode

from django.conf import settings
from django.core.exceptions import PermissionDenied, DisallowedHost
from django.http import Http404, JsonResponse
from django.shortcuts import resolve_url

import logging

logger = logging.getLogger('parts.middleware')


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
            # Error genérico
            return JsonResponse({
                'success': False,
                'error': 'Error del servidor',
                'detail': str(exception),
                'type': type(exception).__name__
            }, status=500)
