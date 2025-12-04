"""
Middleware para manejar requests desde apps Capacitor.
Detecta User-Agent de Capacitor y fuerza revalidación de cache.
"""


class CapacitorNoCacheMiddleware:
    """
    Deshabilita cache para requests desde apps Capacitor en modo desarrollo.
    Detecta el User-Agent modificado por capacitor.config.json y añade headers
    que fuerzan al WebView a revalidar contenido en cada petición.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        # Detectar si viene desde app Capacitor
        user_agent = request.META.get('HTTP_USER_AGENT', '')
        is_capacitor = 'CarInventoryApp' in user_agent or 'Capacitor' in user_agent

        if is_capacitor:
            # Solo aplicar no-cache a HTML (páginas dinámicas)
            # Los assets estáticos (JS/CSS con ?v=...) siguen cacheables
            content_type = response.get('Content-Type', '')
            
            if 'text/html' in content_type:
                # Headers agresivos para forzar revalidación en WebView
                response['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
                response['Pragma'] = 'no-cache'
                response['Expires'] = '0'
                
                # Header custom para debugging
                response['X-Capacitor-Mode'] = 'development'

        return response
