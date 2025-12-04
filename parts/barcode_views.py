# parts/barcode_views.py
"""
Vistas para generación e impresión de códigos de barras
"""

from django.shortcuts import render, get_object_or_404
from django.http import JsonResponse, HttpResponse
from django.views.decorators.http import require_http_methods
from django.contrib.auth.decorators import login_required
from .models import Part
from .barcode_generator import GeneradorEtiquetaPieza, GestorImpresoraTermica
import logging

logger = logging.getLogger('parts.barcode')


@login_required
@require_http_methods(["GET"])
def generar_codigo_barras(request, part_id):
    """Entrega solo el dibujo del código (sin etiquetas ni extras)."""
    try:
        part = get_object_or_404(Part, id=part_id)
        generator = GeneradorEtiquetaPieza(part)
        
        formato = request.GET.get('formato', 'CODE128')
        include_text = request.GET.get('texto', '1') not in ('0', 'false', 'False')
        output = (request.GET.get('output') or 'png').lower()
        vector_flag = request.GET.get('vector')
        wants_svg = output in ('svg', 'vector')
        if not wants_svg and vector_flag:
            wants_svg = vector_flag.lower() in ('1', 'true', 'svg', 'vector')

        if wants_svg:
            barcode_buffer = generator.generar_svg_barcode(formato=formato, include_text=include_text)
            content_type = 'image/svg+xml'
        else:
            barcode_buffer = generator.generar_imagen_barcode(formato=formato, include_text=include_text)
            content_type = 'image/png'
        
        return HttpResponse(barcode_buffer.getvalue(), content_type=content_type)
    
    except Exception as e:
        logger.error(f"Error generando código de barras para pieza {part_id}: {str(e)}")
        return JsonResponse({
            'error': 'Error generando código de barras',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["GET"])
def generar_etiqueta(request, part_id):
    """Etiqueta completa pensada para 58 mm y la PT210."""
    try:
        part = get_object_or_404(Part, id=part_id)
        generator = GeneradorEtiquetaPieza(part)
        
        # Generar etiqueta completa
        etiqueta_buffer = generator.generar_etiqueta_completa()
        
        # Retornar imagen
        return HttpResponse(etiqueta_buffer.getvalue(), content_type='image/png')
    
    except Exception as e:
        logger.error(f"Error generando etiqueta para pieza {part_id}: {str(e)}")
        return JsonResponse({
            'error': 'Error generando etiqueta',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["GET"])
def generar_etiqueta_escpos(request, part_id):
    """
    Genera etiqueta en formato ESC/POS lista para impresora térmica.
    """
    try:
        part = get_object_or_404(Part, id=part_id)
        generator = GeneradorEtiquetaPieza(part)
        escpos_bytes = generator.generar_etiqueta_escpos()
        response = HttpResponse(escpos_bytes, content_type='application/octet-stream')
        response['Content-Disposition'] = f'attachment; filename=etiqueta_{part_id}.escpos'
        return response
    except Exception as e:
        logger.error(f"Error generando etiqueta ESC/POS para pieza {part_id}: {str(e)}")
        return JsonResponse({
            'error': 'Error generando etiqueta ESC/POS',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["POST"])
def imprimir_etiqueta(request, part_id):
    """
    Imprime etiqueta en impresora térmica GOOJPRT PT210
    
    POST /parts/{part_id}/imprimir/
    Response: JSON con resultado de impresión
    """
    try:
        part = get_object_or_404(Part, id=part_id)
        
        # Obtener configuración de impresora desde request
        tipo_conexion = request.POST.get('tipo_conexion', 'usb')
        ruta_dispositivo = request.POST.get('ruta_dispositivo', None)
        
        # Crear gestor de impresora
        printer = GestorImpresoraTermica(
            tipo_conexion=tipo_conexion,
            ruta_dispositivo=ruta_dispositivo
        )
        
        # Imprimir etiqueta
        printer.imprimir_parte(part)
        printer.desconectar()
        
        logger.info(f"Etiqueta impresa exitosamente para pieza {part_id}")
        
        return JsonResponse({
            'success': True,
            'mensaje': f'Etiqueta impresa para: {part.name}',
            'part_id': part_id,
            'codigo_barras': GeneradorEtiquetaPieza.generar_codigo_desde_parte(part)
        })
    
    except Exception as e:
        logger.error(f"Error imprimiendo etiqueta para pieza {part_id}: {str(e)}")
        return JsonResponse({
            'success': False,
            'error': 'Error imprimiendo etiqueta',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["POST"])
def test_impresora(request):
    """
    Prueba de impresión para verificar conexión con GOOJPRT PT210
    
    POST /parts/impresora/test/
    Body (JSON): {
        "tipo_conexion": "usb|bluetooth|network",
        "ruta_dispositivo": "/dev/usb/lp0" (opcional),
        "direccion_ip": "192.168.1.100" (para network)
    }
    Response: JSON con resultado de prueba
    """
    try:
        import json
        
        # Intentar parsear JSON o usar POST data
        if request.content_type == 'application/json':
            data = json.loads(request.body)
            tipo_conexion = data.get('tipo_conexion', 'usb')
            ruta_dispositivo = data.get('ruta_dispositivo', None)
            direccion_ip = data.get('direccion_ip', None)
        else:
            tipo_conexion = request.POST.get('tipo_conexion', 'usb')
            ruta_dispositivo = request.POST.get('ruta_dispositivo', None)
            direccion_ip = request.POST.get('direccion_ip', None)
        
        # Crear gestor de impresora
        printer = GestorImpresoraTermica(
            tipo_conexion=tipo_conexion,
            ruta_dispositivo=ruta_dispositivo
        )
        
        # Intentar conectar primero
        if not printer.conectar():
            raise Exception(f"No se pudo conectar a la impresora por {tipo_conexion}")
        
        # Ejecutar prueba
        printer.test_impresion()
        printer.desconectar()
        
        logger.info(f"Prueba de impresora exitosa: {tipo_conexion}")
        
        return JsonResponse({
            'success': True,
            'message': f'Impresora conectada correctamente por {tipo_conexion.upper()}',
            'details': {
                'printer_model': 'GOOJPRT PT210',
                'tipo_conexion': tipo_conexion,
                'ruta_dispositivo': printer.ruta_dispositivo or 'Autodetectado',
                'direccion_ip': direccion_ip if tipo_conexion == 'network' else None
            }
        })
    
    except Exception as e:
        logger.error(f"Error en prueba de impresora: {str(e)}")
        
        # Diagnóstico detallado con comandos ejecutables
        diagnostico = []
        comandos_diagnostico = []
        
        if tipo_conexion == 'usb':
            diagnostico.append(" IMPRESORA USB NO DETECTADA")
            diagnostico.append("")
            diagnostico.append("Posibles causas:")
            diagnostico.append("1. Impresora no está conectada al servidor")
            diagnostico.append("2. Falta permisos para acceder al dispositivo USB")
            diagnostico.append("3. El dispositivo tiene otro nombre")
            diagnostico.append("")
            diagnostico.append(" Comandos para diagnosticar:")
            
            # Verificar dispositivos USB
            import subprocess
            try:
                # Listar dispositivos USB
                usb_devices = subprocess.run(['ls', '-l', '/dev/usb/'], 
                                           capture_output=True, text=True, timeout=2)
                if usb_devices.returncode == 0 and usb_devices.stdout:
                    diagnostico.append(f"Dispositivos en /dev/usb/:")
                    for line in usb_devices.stdout.strip().split('\n')[-5:]:
                        diagnostico.append(f"  {line}")
                else:
                    diagnostico.append(" /dev/usb/ no existe o está vacío")
                
                # Listar dispositivos ttyUSB
                tty_devices = subprocess.run(['ls', '-l', '/dev/ttyUSB*'], 
                                           capture_output=True, text=True, timeout=2, shell=True)
                if tty_devices.returncode == 0 and tty_devices.stdout:
                    diagnostico.append("")
                    diagnostico.append(f"Dispositivos ttyUSB:")
                    for line in tty_devices.stdout.strip().split('\n')[-3:]:
                        diagnostico.append(f"  {line}")
                        
                # lsusb para ver todas las impresoras USB
                lsusb_output = subprocess.run(['lsusb'], 
                                            capture_output=True, text=True, timeout=2)
                if lsusb_output.returncode == 0:
                    diagnostico.append("")
                    diagnostico.append("Dispositivos USB conectados (lsusb):")
                    for line in lsusb_output.stdout.strip().split('\n'):
                        if any(keyword in line.lower() for keyword in ['printer', 'goojprt', 'pos', 'thermal']):
                            diagnostico.append(f"   {line}")
                        else:
                            diagnostico.append(f"    {line}")
                            
            except Exception as diag_error:
                diagnostico.append(f"Error ejecutando diagnóstico: {diag_error}")
            
            comandos_diagnostico = [
                "docker exec car_inventory_web ls -l /dev/usb/",
                "docker exec car_inventory_web lsusb",
                "docker exec car_inventory_web chmod 666 /dev/usb/lp0"
            ]
            
        elif tipo_conexion == 'bluetooth':
            diagnostico.append(" BLUETOOTH: CONFIGURACIÓN REQUERIDA EN EL SERVIDOR")
            diagnostico.append("")
            diagnostico.append("" * 60)
            diagnostico.append("IMPORTANTE: Docker NO tiene acceso directo al Bluetooth")
            diagnostico.append("" * 60)
            diagnostico.append("")
            diagnostico.append("El Bluetooth debe configurarse en el SERVIDOR HOST (Ubuntu),")
            diagnostico.append("no dentro del contenedor Docker.")
            diagnostico.append("")
            diagnostico.append(" PASOS PARA CONFIGURAR (ejecutar en el servidor):")
            diagnostico.append("")
            diagnostico.append("1⃣ Encender la impresora GOOJPRT PT210")
            diagnostico.append("   - Presiona el botón de encendido")
            diagnostico.append("   - Espera a que el LED azul parpadee (modo emparejamiento)")
            diagnostico.append("")
            diagnostico.append("2⃣ Instalar herramientas Bluetooth:")
            diagnostico.append("   $ sudo apt-get update")
            diagnostico.append("   $ sudo apt-get install -y bluez bluetooth")
            diagnostico.append("")
            diagnostico.append("3⃣ Escanear dispositivos disponibles:")
            diagnostico.append("   $ sudo hcitool scan")
            diagnostico.append("   Busca algo como: XX:XX:XX:XX:XX:XX  GOOJPRT PT210")
            diagnostico.append("")
            diagnostico.append("4⃣ Emparejar con bluetoothctl:")
            diagnostico.append("   $ sudo bluetoothctl")
            diagnostico.append("   [bluetooth]# power on")
            diagnostico.append("   [bluetooth]# agent on")
            diagnostico.append("   [bluetooth]# scan on")
            diagnostico.append("   [bluetooth]# pair XX:XX:XX:XX:XX:XX")
            diagnostico.append("   [bluetooth]# trust XX:XX:XX:XX:XX:XX")
            diagnostico.append("   [bluetooth]# connect XX:XX:XX:XX:XX:XX")
            diagnostico.append("   [bluetooth]# exit")
            diagnostico.append("")
            diagnostico.append("5⃣ Crear conexión serial (rfcomm):")
            diagnostico.append("   $ sudo rfcomm bind /dev/rfcomm0 XX:XX:XX:XX:XX:XX 1")
            diagnostico.append("")
            diagnostico.append("6⃣ Dar permisos al dispositivo:")
            diagnostico.append("   $ sudo chmod 666 /dev/rfcomm0")
            diagnostico.append("")
            diagnostico.append("7⃣ Montar el dispositivo en Docker:")
            diagnostico.append("   Editar docker-compose.yml, agregar en 'web':")
            diagnostico.append("   devices:")
            diagnostico.append("     - /dev/rfcomm0:/dev/rfcomm0")
            diagnostico.append("")
            diagnostico.append("8⃣ Reiniciar contenedor:")
            diagnostico.append("   $ docker restart car_inventory_web")
            diagnostico.append("")
            diagnostico.append("" * 60)
            diagnostico.append("ALTERNATIVA MÁS SIMPLE: Usar conexión USB")
            diagnostico.append("" * 60)
            diagnostico.append("Si la impresora tiene puerto USB, es más confiable:")
            diagnostico.append("1. Conecta la impresora por USB al servidor")
            diagnostico.append("2. Verifica: ls -l /dev/usb/lp*")
            diagnostico.append("3. Cambia método a 'USB' en configuración")
            
            # Verificar estado actual del sistema
            import subprocess
            diagnostico.append("")
            diagnostico.append("" * 60)
            diagnostico.append("ESTADO ACTUAL DEL SISTEMA:")
            diagnostico.append("" * 60)
            
            try:
                # Verificar si hcitool está instalado
                hcitool_check = subprocess.run(['which', 'hcitool'], 
                                              capture_output=True, text=True, timeout=2)
                if hcitool_check.returncode == 0:
                    diagnostico.append(" hcitool instalado en: " + hcitool_check.stdout.strip())
                    
                    # Nota: No ejecutar scan porque puede tardar mucho
                    diagnostico.append("   (Para escanear BT, ejecutar manualmente en el servidor)")
                else:
                    diagnostico.append(" hcitool NO instalado (necesario para BT)")
                    
                # Verificar dispositivos rfcomm existentes
                rfcomm_check = subprocess.run(['test', '-e', '/dev/rfcomm0'], 
                                            capture_output=True, timeout=1)
                if rfcomm_check.returncode == 0:
                    diagnostico.append(" /dev/rfcomm0 existe")
                    # Verificar permisos
                    perms = subprocess.run(['ls', '-l', '/dev/rfcomm0'],
                                         capture_output=True, text=True, timeout=1)
                    if perms.returncode == 0:
                        diagnostico.append(f"   Permisos: {perms.stdout.strip()}")
                else:
                    diagnostico.append(" /dev/rfcomm0 NO existe (BT no configurado)")
                    
            except Exception as diag_error:
                diagnostico.append(f" Error en diagnóstico: {diag_error}")
            
            comandos_diagnostico = [
                "# Ejecutar en el SERVIDOR (no en Docker):",
                "sudo apt-get install -y bluez bluetooth",
                "sudo hcitool scan",
                "sudo bluetoothctl",
                "# Luego en bluetoothctl: pair/trust/connect XX:XX:XX:XX:XX:XX",
                "sudo rfcomm bind /dev/rfcomm0 <MAC_ADDRESS> 1",
                "sudo chmod 666 /dev/rfcomm0",
                "# Editar docker-compose.yml para montar /dev/rfcomm0",
                "docker restart car_inventory_web"
            ]
            
        elif tipo_conexion == 'network':
            diagnostico.append(" IMPRESORA DE RED NO ACCESIBLE")
            diagnostico.append("")
            diagnostico.append(f"IP configurada: {direccion_ip or 'NO ESPECIFICADA'}")
            diagnostico.append("")
            diagnostico.append("Verifica:")
            diagnostico.append("1. La impresora está conectada a la red")
            diagnostico.append("2. La IP es correcta")
            diagnostico.append("3. El servidor puede acceder a esa IP")
            
            if direccion_ip:
                import subprocess
                try:
                    ping_result = subprocess.run(['ping', '-c', '2', direccion_ip], 
                                               capture_output=True, text=True, timeout=5)
                    if ping_result.returncode == 0:
                        diagnostico.append("")
                        diagnostico.append(f" Ping a {direccion_ip} exitoso")
                    else:
                        diagnostico.append("")
                        diagnostico.append(f" No se puede hacer ping a {direccion_ip}")
                except Exception as ping_error:
                    diagnostico.append(f"Error en ping: {ping_error}")
            
            comandos_diagnostico = [
                f"ping -c 2 {direccion_ip or '192.168.x.x'}",
                f"nmap -p 9100 {direccion_ip or '192.168.x.x'}"
            ]
        
        return JsonResponse({
            'success': False,
            'message': str(e),
            'details': {
                'error_type': type(e).__name__,
                'tipo_conexion': tipo_conexion,
                'diagnostico': diagnostico,
                'comandos_sugeridos': comandos_diagnostico
            }
        }, status=500)


@login_required
@require_http_methods(["GET"])
def preview_etiqueta(request, part_id):
    """
    Vista HTML para previsualizar etiqueta antes de imprimir
    
    GET /parts/{part_id}/etiqueta/preview/
    Response: HTML con preview de etiqueta
    """
    try:
        part = get_object_or_404(Part, id=part_id)
        generator = GeneradorEtiquetaPieza(part)
        
        context = {
            'part': part,
            'codigo_barras': generator.codigo_barras,
            'etiqueta_url': f'/parts/{part_id}/etiqueta/',
        }
        
        return render(request, 'parts/barcode_preview.html', context)
    
    except Exception as e:
        logger.error(f"Error en preview de etiqueta para pieza {part_id}: {str(e)}")
        return JsonResponse({
            'error': 'Error generando preview',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["POST"])
def imprimir_multiples(request):
    """
    Imprime etiquetas para múltiples piezas
    
    POST /parts/imprimir-multiples/
    Body: {"part_ids": [1, 2, 3, ...], "tipo_conexion": "usb"}
    Response: JSON con resultado de impresiones
    """
    try:
        import json
        data = json.loads(request.body)
        part_ids = data.get('part_ids', [])
        tipo_conexion = data.get('tipo_conexion', 'usb')
        ruta_dispositivo = data.get('ruta_dispositivo', None)
        
        if not part_ids:
            return JsonResponse({
                'success': False,
                'error': 'No se proporcionaron IDs de piezas'
            }, status=400)
        
        # Crear gestor de impresora (una sola conexión para todas)
        printer = GestorImpresoraTermica(
            tipo_conexion=tipo_conexion,
            ruta_dispositivo=ruta_dispositivo
        )
        
        resultados = []
        errores = []
        
        for part_id in part_ids:
            try:
                part = Part.objects.get(id=part_id)
                printer.imprimir_parte(part)
                resultados.append({
                    'part_id': part_id,
                    'nombre': part.name,
                    'exito': True
                })
                logger.info(f"Etiqueta impresa para pieza {part_id}")
            except Part.DoesNotExist:
                errores.append({
                    'part_id': part_id,
                    'error': 'Pieza no encontrada'
                })
            except Exception as e:
                errores.append({
                    'part_id': part_id,
                    'error': str(e)
                })
                logger.error(f"Error imprimiendo pieza {part_id}: {str(e)}")
        
        printer.desconectar()
        
        return JsonResponse({
            'success': True,
            'total': len(part_ids),
            'exitosas': len(resultados),
            'fallidas': len(errores),
            'resultados': resultados,
            'errores': errores
        })
    
    except Exception as e:
        logger.error(f"Error en impresión múltiple: {str(e)}")
        return JsonResponse({
            'success': False,
            'error': 'Error en impresión múltiple',
            'detalle': str(e)
        }, status=500)


@login_required
@require_http_methods(["GET"])
def detectar_impresora(request):
    """
    Detecta impresoras térmicas conectadas
    
    GET /parts/impresora/detectar/
    Response: JSON con impresoras detectadas
    """
    try:
        printer_manager = GestorImpresoraTermica()
        dispositivo_detectado = printer_manager.ruta_dispositivo
        
        # Intentar detectar más info con lsusb (si está disponible)
        import subprocess
        try:
            lsusb_output = subprocess.check_output(['lsusb'], text=True)
            impresoras_usb = []
            for line in lsusb_output.split('\n'):
                if 'printer' in line.lower() or 'goojprt' in line.lower():
                    impresoras_usb.append(line.strip())
        except:
            impresoras_usb = []
        
        return JsonResponse({
            'dispositivo_detectado': dispositivo_detectado,
            'impresoras_usb': impresoras_usb,
            'mensaje': 'Impresora detectada' if dispositivo_detectado else 'No se detectó ninguna impresora',
            'instrucciones': {
                'usb': 'Conecta la impresora vía USB y asegúrate de tener permisos',
                'serial': 'Usa /dev/ttyUSB0 o similar para conexión serial',
                'permisos': 'Ejecuta: sudo chmod 666 /dev/usb/lp0 si hay errores de permisos'
            }
        })
    
    except Exception as e:
        logger.error(f"Error detectando impresora: {str(e)}")
        return JsonResponse({
            'error': 'Error detectando impresora',
            'detalle': str(e)
        }, status=500)
