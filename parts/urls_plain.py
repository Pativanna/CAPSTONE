from django.urls import path
from . import views
from . import vosk_views

# Endpoints legacy sin namespace para compatibilidad con tests antiguos
# NOTA: No definir app_name aquí para permitir reverse('nombre') directo.

from django.http import JsonResponse

def entrenamiento_requiere_auth(request):
    # Compatibilidad con tests legacy: debe responder 401 si no autenticado
    if not request.user.is_authenticated:
        return JsonResponse({'detail': 'authentication required'}, status=401)
    # Si está autenticado, mantener semántica de endpoints deshabilitados
    return JsonResponse({'detalle': 'entrenamiento de voz deshabilitado'}, status=410)

urlpatterns = [
    path('parts/', views.part_list, name='part_list'),
    path('autos/', views.auto_list, name='auto_list'),
    path('workshops/', views.workshop_list, name='workshop_list'),
    path('dashboard/', views.dashboard, name='dashboard'),
    path('parts/add/', views.part_create, name='part_create'),
    path('parts/<int:pk>/label/', views.part_label, name='part_label'),
    path('parts/websocket-test/', views.websocket_test, name='websocket_test'),
    path('reports/', views.report_page, name='report_page'),
    path('reports/preview/', views.report_preview, name='report_preview'),
    path('parts/extract-from-transcript/', vosk_views.extract_from_transcript, name='extract_from_transcript'),
    # Rutas legacy de entrenamiento (retornan 404 controlado)
    path('parts/voice/registrar-muestra/', entrenamiento_requiere_auth, name='registrar_muestra_entrenamiento'),
    path('parts/voice/estado-entrenamiento/', entrenamiento_requiere_auth, name='estado_entrenamiento_usuario'),
    # Asistente de publicaciones (alias sin namespace)
    path('parts/publicar/', views.part_publish_redirect, name='part_publish_root'),
    path('parts/publicar/<int:pk>/', views.part_publish_helper, name='part_publish'),
]
