"""
WebSocket URL routing for parts app.
Maps WebSocket connections to consumers.
"""

from django.urls import re_path
from . import consumers
from .voice_webrtc_ws import WebRTCAudioConsumer

websocket_urlpatterns = [
    # WebSocket endpoint para WebRTC híbrido
    re_path(r'ws/webrtc-audio/$', WebRTCAudioConsumer.as_asgi()),
    # Servidor Vosk: solo comandos (transcripción deshabilitada por configuración)
    re_path(r'vosk-ws/$', consumers.VoskConsumer.as_asgi()),
]
