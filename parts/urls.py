from django.urls import path
from . import views
from . import auth_views
from . import vosk_views
from . import barcode_views  # Nuevo: vistas de códigos de barras
from . import views as parts_views

# Namespace de la aplicación
app_name = 'parts'

# Import condicional de WebRTC para evitar error 500 si 'aiortc' no está instalado.
# Causa original del 500: ModuleNotFoundError: No module named 'aiortc' al importar webrtc_views.
# Estrategia de degradación: si falta dependencia se omiten las rutas WebRTC y se deja
# funcional el resto del sitio. Se registra un warning en logs.
try:
    from . import webrtc_views  # requiere aiortc, av, webrtcvad (opcional)
    _WEBRTC_HABILITADO = True
except ModuleNotFoundError as e:
    import logging
    logging.getLogger('parts').warning('WebRTC deshabilitado (dependencia faltante): %s', e)
    webrtc_views = None
    _WEBRTC_HABILITADO = False

urlpatterns = [
    # Authentication
    path('', views.part_list, name='home'),  # Redirect root to part_list
    path('login/', auth_views.login_view, name='login'),
    path('logout/', auth_views.logout_view, name='logout'),
    
    # User Management (Admin only)
    path('users/', auth_views.user_list, name='user_list'),
    path('users/create/', auth_views.user_create, name='user_create'),
    path('users/edit/<int:user_id>/', auth_views.user_edit, name='user_edit'),
    path('users/delete/<int:user_id>/', auth_views.user_delete, name='user_delete'),
    
    # Parts
    path('parts/', views.part_list, name='part_list'),
    path('parts/add/', views.part_create, name='part_create'),
    path('parts/edit/<int:pk>/', views.part_edit, name='part_edit'),
    path('parts/delete/<int:pk>/', views.part_delete, name='part_delete'),
    path('parts/<int:pk>/toggle-sold/', views.toggle_part_sold, name='toggle_part_sold'),
    path('parts/<int:pk>/update-field/', views.update_part_field, name='update_part_field'),
    path('parts/<int:pk>/photos/', views.part_photos_list, name='part_photos_list'),
    path('parts/<int:pk>/photos/upload/', views.part_photos_upload, name='part_photos_upload'),
    # Etiqueta con código de barras/QR
    path('parts/<int:pk>/label/', views.part_label, name='part_label'),
    path('parts/upload/', views.upload_audio, name='upload_audio'),
    path('parts/upload-audio/', views.upload_audio, name='upload_audio_alt'),
    path('parts/detect-command/', views.detect_command, name='detect_command'),
    path('parts/generate-tts/', views.generate_tts, name='generate_tts'),
    # Alias adicional para compatibilidad con clientes que llaman a /generate-tts/
    path('generate-tts/', views.generate_tts, name='generate_tts_alias'),
    path('parts/process-voice-text/', views.process_voice_text, name='process_voice_text'),
    
    # Rutas Vosk reactivadas para flujo manos libres
    path('parts/voice/log-transcription/', vosk_views.log_transcription, name='log_transcription'),
    path('parts/voice/log-command/', vosk_views.log_command, name='log_command'),
    path('parts/voice/start-session/', vosk_views.start_voice_session, name='start_voice_session'),
    path('parts/voice/close-session/', vosk_views.close_voice_session, name='close_voice_session'),
    path('parts/voice/check-result/', vosk_views.check_extraction_result, name='check_extraction_result'),
    path('parts/voice/process-session/', vosk_views.process_session_transcript, name='process_session_transcript'),
    path('parts/vosk-api/transcribe-hybrid', vosk_views.transcribe_hybrid, name='transcribe_hybrid'),
    path('parts/voice-search/transcribe/', vosk_views.voice_search_transcribe, name='voice_search_transcribe'),
    path('parts/voice-search/transcribe-openai/', vosk_views.voice_search_transcribe_openai, name='voice_search_transcribe_openai'),
    
    path('parts/api/catalog-cache/', views.parts_catalog_cache, name='parts_catalog_cache'),
    path('parts/api/search/suggest/', views.search_suggest, name='search_suggest'),
    path('parts/api/filter/suggest/', views.filter_suggest, name='filter_suggest'),
    # Endpoints adicionales se habilitarán cuando el módulo esté listo

    # Mic config & test
    # path('parts/mic-config/', vosk_views.get_mic_config, name='get_mic_config'),
    # path('parts/mic-config/submit/', vosk_views.submit_mic_config, name='submit_mic_config'),

    # Reportes y Dashboard
    path('reports/', views.report_page, name='report_page'),
    path('reports/preview/', views.report_preview, name='report_preview'),
    path('dashboard/', views.dashboard, name='dashboard'),
    path('dashboard/stats/', views.dashboard_stats, name='dashboard_stats'),
    
    # API Explorer
    path('api-explorer/', views.api_explorer, name='api_explorer'),
    
    # Logs (solo staff)
    path('logs/', views.logs_page, name='logs_page'),
    path('api/logs/', views.logs_api, name='logs_api'),
    path('api/logs/audit/', views.logs_audit_api, name='logs_audit_api'),
    path('synonyms/', views.synonym_manager, name='synonym_manager'),
    
    # WebSocket test page
    path('parts/websocket-test/', views.websocket_test, name='websocket_test'),

    # Autos
    path('autos/', views.auto_list, name='auto_list'),
    path('autos/add/', views.auto_create, name='auto_create'),
    path('autos/edit/<int:pk>/', views.auto_edit, name='auto_edit'),
    path('autos/delete/<int:pk>/', views.auto_delete, name='auto_delete'),
    path('autos/<int:pk>/update-field/', views.update_auto_field, name='update_auto_field'),

    # Workshops
    path('workshops/', views.workshop_list, name='workshop_list'),
    path('workshops/add/', views.workshop_create, name='workshop_create'),
    path('workshops/edit/<int:pk>/', views.workshop_edit, name='workshop_edit'),
    path('workshops/delete/<int:pk>/', views.workshop_delete, name='workshop_delete'),
    path('workshops/<int:pk>/update-field/', views.update_workshop_field, name='update_workshop_field'),

    # Barcode & Printing (GOOJPRT PT210)
    path('parts/<int:part_id>/barcode/', barcode_views.generar_codigo_barras, name='part_barcode'),
    path('parts/<int:part_id>/etiqueta/', barcode_views.generar_etiqueta, name='part_etiqueta'),
    path('parts/<int:part_id>/etiqueta/preview/', barcode_views.preview_etiqueta, name='part_etiqueta_preview'),
    path('parts/<int:part_id>/etiqueta/escpos/', barcode_views.generar_etiqueta_escpos, name='part_etiqueta_escpos'),
    path('parts/<int:part_id>/imprimir/', barcode_views.imprimir_etiqueta, name='part_imprimir'),
    path('parts/imprimir-multiples/', barcode_views.imprimir_multiples, name='part_imprimir_multiples'),
    path('parts/impresora/test/', barcode_views.test_impresora, name='impresora_test'),
    path('parts/impresora/detectar/', barcode_views.detectar_impresora, name='impresora_detectar'),

    # Hub de impresora Bluetooth (ventana dedicada)
    path('parts/impresora/hub/', views.printer_hub, name='printer_hub'),

    # Verificador de Código de Barras (ML Kit Scanner)
    path('verificador/', views.verificador_view, name='verificador'),
    path('verificador/search/', views.verificador_search, name='verificador_search'),
    path('verificador/log/', views.verificador_log, name='verificador_log'),

    # Asistente para publicaciones externas
    path('parts/publicar/', views.part_publish_redirect, name='part_publish_root'),
    path('parts/publicar/<int:pk>/', views.part_publish_helper, name='part_publish'),
    path('parts/publicar/<int:pk>/ai-description/', views.part_publish_ai_description, name='part_publish_ai_description'),
    path('parts/publicar/<int:pk>/fotos.zip', views.part_publish_download_photos, name='part_publish_download'),

    # Logging de eventos Bluetooth (frontend -> backend)
    path('parts/bluetooth/log/', parts_views.bluetooth_log, name='bluetooth_log'),
    path('parts/activity/log/', parts_views.frontend_activity_log, name='frontend_activity_log'),

]

# Rutas WebRTC solo si las dependencias están presentes
if _WEBRTC_HABILITADO:
    urlpatterns += [
        path('webrtc/offer/', webrtc_views.webrtc_offer, name='webrtc_offer'),
    ]
