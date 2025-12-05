"""
Vista para recibir logs del scanner desde la app móvil
"""
import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.utils import timezone
import logging

logger = logging.getLogger(__name__)

@csrf_exempt
@require_http_methods(["POST"])
def receive_scanner_logs(request):
    """
    Endpoint para recibir logs del scanner móvil
    POST /api/scanner-logs/
    Body: {
        "logs": [
            {"timestamp": "2024-12-05T10:30:00", "level": "info", "message": "..."},
            ...
        ],
        "device": "...",
        "session": "..."
    }
    """
    try:
        data = json.loads(request.body)
        logs = data.get('logs', [])
        device = data.get('device', 'unknown')
        session = data.get('session', 'unknown')
        
        # Log cada mensaje recibido
        for log_entry in logs:
            level = log_entry.get('level', 'info').lower()
            message = log_entry.get('message', '')
            timestamp = log_entry.get('timestamp', '')
            
            log_line = f"[SCANNER-{device}][{session}][{timestamp}] {message}"
            
            if level == 'error':
                logger.error(log_line)
            elif level == 'warning':
                logger.warning(log_line)
            else:
                logger.info(log_line)
        
        return JsonResponse({
            'status': 'ok',
            'received': len(logs)
        })
        
    except Exception as e:
        logger.error(f"Error receiving scanner logs: {e}")
        return JsonResponse({
            'status': 'error',
            'message': str(e)
        }, status=400)


@require_http_methods(["GET"])
def view_scanner_logs(request):
    """
    Vista simple para ver los últimos logs del scanner
    GET /parts/scanner-logs/
    """
    from django.shortcuts import render
    
    # Leer últimas 200 líneas del log file
    import os
    log_file = os.path.join(os.path.dirname(__file__), '../../logs/scanner.log')
    
    try:
        with open(log_file, 'r') as f:
            lines = f.readlines()
            recent_logs = lines[-200:] if len(lines) > 200 else lines
    except FileNotFoundError:
        recent_logs = ["No hay logs disponibles aún"]
    
    return render(request, 'parts/scanner_logs.html', {
        'logs': recent_logs
    })
