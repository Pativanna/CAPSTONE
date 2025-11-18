import os
import re
import json
import time
import tempfile
import subprocess
from django.conf import settings
from django.core.mail import EmailMessage
from django.contrib.auth import get_user_model
from django.utils import timezone
from django.http import JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.contrib.auth.decorators import login_required
from django.db.models import Q, Count
from .models import Part, Auto, Workshop, ReportSchedule, ReportLog
from .forms import PartForm, AutoForm, WorkshopForm, ReportScheduleForm
from .utils.report_generator import generate_report_bytes
from collections import deque
from pathlib import Path
import logging

# Logger dedicado para eventos Bluetooth del frontend
bluetooth_logger = logging.getLogger('parts.bluetooth')

@csrf_exempt
def bluetooth_log(request):
    """Recibe eventos de log del sistema Bluetooth del frontend y los envía al logger centralizado.
    POST /parts/bluetooth/log/
    Body JSON: {"evento": str, "datos": dict, "ts": int, "url": str, "ua": str}
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Método no permitido'}, status=405)
    try:
        payload = json.loads(request.body.decode('utf-8')) if request.body else {}
    except Exception as e:
        return JsonResponse({'error': 'JSON inválido', 'detalle': str(e)}, status=400)

    evento = payload.get('evento', 'desconocido')
    datos = payload.get('datos', {})
    ts = payload.get('ts')
    page_url = payload.get('url')
    ua = payload.get('ua')

    try:
        bluetooth_logger.info('BT_EVENT', extra={
            'evento': evento,
            'datos': datos,
            'ts': ts,
            'page_url': page_url,
            'user_agent': ua,
            'remote_ip': request.META.get('REMOTE_ADDR'),
            'user_id': request.user.id if hasattr(request, 'user') and request.user.is_authenticated else None,
        })
    except Exception:
        # Evitar fallar por logging; responder OK igualmente
        pass

    return JsonResponse({'ok': True})


def _es_peticion_ajax(request) -> bool:
    """Detecta rápidamente si la petición viene del frontend AJAX."""
    return (
        request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        or request.POST.get('ajax') == 'true'
        or request.GET.get('ajax') == 'true'
    )


def _usuario_es_admin(user) -> bool:
    """Centraliza validación de privilegios de administrador."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False):
        return True
    perfil = getattr(user, 'profile', None)
    return bool(perfil and getattr(perfil, 'is_admin', False))


def _format_clp(value):
    """Formatea un entero como CLP con puntos."""
    try:
        value_int = int(value)
    except (TypeError, ValueError):
        return "Sin precio"
    return f"${value_int:,.0f}".replace(",", ".")


def _render_admin_denied(request, message):
    return render(request, 'parts/access_denied.html', {
        'title': 'Acceso restringido',
        'message': message,
    }, status=403)

# ---------------------------------
# HUB DE IMPRESORA BLUETOOTH (VENTANA DEDICADA)
# Mantiene conexión persistente mientras el usuario navega.
# ---------------------------------
@login_required
def printer_hub(request):
    """Renderiza una ventana mínima que mantiene la conexión Bluetooth.
    Esta ventana se abre en segundo plano y se comunica por BroadcastChannel
    con la página principal. No carga datos pesados para reducir uso de recursos.
    """
    return render(request, 'parts/printer_hub.html', {})


# -------------------------------
# PART CRUD
# -------------------------------
@login_required
def part_list(request):
    filtro_modelo = (request.GET.get('modelo') or request.GET.get('brand_model') or '').strip()
    filtro_anio = (request.GET.get('anio') or request.GET.get('year') or '').strip()

    modelos_disponibles = (
        Auto.objects.values_list('brand_model', flat=True)
        .distinct()
        .order_by('brand_model')
    )

    if filtro_modelo:
        anios_disponibles = (
            Auto.objects.filter(brand_model=filtro_modelo)
            .values_list('year', flat=True)
            .distinct()
            .order_by('-year')
        )
    else:
        anios_disponibles = (
            Auto.objects.values_list('year', flat=True)
            .distinct()
            .order_by('-year')
        )

    piezas = (
        Part.objects.select_related('auto', 'workshop')
        .order_by('-date_added')
    )
    if filtro_modelo:
        piezas = piezas.filter(auto__brand_model=filtro_modelo)
    if filtro_anio:
        piezas = piezas.filter(auto__year=filtro_anio)

    talleres = Workshop.objects.order_by('name')

    return render(request, 'parts/part_list.html', {
        'piezas': piezas,
        'modelos_disponibles': modelos_disponibles,
        'anios_disponibles': anios_disponibles,
        'modelo_filtrado': filtro_modelo,
        'anio_filtrado': filtro_anio,
        'talleres_disponibles': talleres,
        'total_piezas': piezas.count(),
        'filtros_partes_abiertos': bool(request.GET),
    })

@login_required
def part_create(request):
    logger = logging.getLogger('parts.views')

    datos_audio = request.session.pop('vehicle_info', None)
    es_ingreso_por_voz = isinstance(datos_audio, dict)

    datos_iniciales = {}
    if es_ingreso_por_voz:
        descripcion_capturada = datos_audio.get('detalles')
        valor_estimado = datos_audio.get('valor')
        ultimo_valor = datos_audio.get('min_value') or valor_estimado
        datos_iniciales = {
            'name': datos_audio.get('parte'),
            'details': descripcion_capturada,
            'max_value': valor_estimado,
            'min_value': ultimo_valor,
        }

    if request.method == 'POST':
        form = PartForm(request.POST, request.FILES or None)
    else:
        form = PartForm(initial=datos_iniciales)

    autos_disponibles = Auto.objects.order_by('-date_added')

    if request.method == 'POST' and form.is_valid():
        from .auditoria import Auditoria
        import time

        marca_tiempo = time.time()
        nueva_pieza = form.save()

        Auditoria.pieza_creada(nueva_pieza, request.user, request, datos_extra={
            'metodo_ingreso': 'voz' if es_ingreso_por_voz else 'manual'
        })
        if nueva_pieza.barcode:
            Auditoria.barcode_generado(nueva_pieza, nueva_pieza.barcode, usuario=request.user, request=request)

        try:
            if getattr(nueva_pieza, 'auto', None):
                request.session['last_used_auto_id'] = str(nueva_pieza.auto.id)
                request.session['last_used_auto_label'] = f"{nueva_pieza.auto.brand_model} ({nueva_pieza.auto.year})"
                request.session.modified = True
        except Exception:
            pass

        impresion_automatica = request.POST.get('auto_print', 'false').lower() == 'true'
        impresion_exitosa = False
        error_impresion = None
        metodo_impresion = request.POST.get('printer_method', 'usb')

        if impresion_automatica:
            barcode_logger = logging.getLogger('parts.barcode')
            try:
                from .barcode_generator import GeneradorEtiquetaPieza, GestorImpresoraTermica

                generador = GeneradorEtiquetaPieza(nueva_pieza)
                etiqueta = generador.generar_etiqueta_completa()
                gestor = GestorImpresoraTermica(connection_type=metodo_impresion)

                if gestor.conectar():
                    gestor.imprimir_etiqueta(etiqueta)
                    gestor.desconectar()
                    impresion_exitosa = True
                    barcode_logger.info("Etiqueta enviada a %s para pieza %s", metodo_impresion, nueva_pieza.id)
                    Auditoria.barcode_impreso(nueva_pieza, exito=True, metodo=metodo_impresion,
                                              usuario=request.user, request=request)
                else:
                    error_impresion = "La impresora no respondió"
                    barcode_logger.warning("No se pudo conectar a la impresora (%s)", metodo_impresion)
                    Auditoria.barcode_impreso(nueva_pieza, exito=False, metodo=metodo_impresion,
                                              error=error_impresion, usuario=request.user, request=request)
            except Exception as exc:
                error_impresion = str(exc)
                barcode_logger = logging.getLogger('parts.barcode')
                barcode_logger.error("Error imprimiendo etiqueta: %s", exc)
                Auditoria.barcode_impreso(nueva_pieza, exito=False, metodo=metodo_impresion,
                                          error=error_impresion, usuario=request.user, request=request)

        duracion_ms = int((time.time() - marca_tiempo) * 1000)
        logger.info("Pieza %s creada en %sms", nueva_pieza.id, duracion_ms)

        if _es_peticion_ajax(request):
            from django.urls import reverse

            payload = {
                'success': True,
                'part_id': nueva_pieza.id,
                'part_name': nueva_pieza.name,
                'barcode': getattr(nueva_pieza, 'barcode', None),
                'message': f'Pieza "{nueva_pieza.name}" guardada correctamente',
                'print_url': reverse('parts:part_etiqueta', args=[nueva_pieza.id]) if nueva_pieza.id else None,
            }
            if impresion_automatica:
                payload.update({
                    'print_attempted': True,
                    'print_success': impresion_exitosa,
                    'print_error': error_impresion,
                })
            return JsonResponse(payload)

        return redirect('parts:part_list')

    if request.method == 'POST' and _es_peticion_ajax(request):
        logger.warning("Formulario inválido al crear pieza: %s", form.errors)
        return JsonResponse({
            'success': False,
            'error': 'Formulario inválido',
            'errors': form.errors.get_json_data() if hasattr(form.errors, 'get_json_data') else dict(form.errors)
        }, status=400)

    ultimo_auto_id = request.session.get('last_used_auto_id', '')
    ultimo_auto_etiqueta = request.session.get('last_used_auto_label', '')
    logger.info("Renderizando formulario de creación de piezas")
    return render(request, 'parts/part_form.html', {
        'form': form,
        'autos': autos_disponibles,
        'workshops': Workshop.objects.order_by('name'),
        'last_used_auto_id': ultimo_auto_id,
        'last_used_auto_label': ultimo_auto_etiqueta,
    })

@login_required
def part_edit(request, pk):
    pieza = get_object_or_404(Part, pk=pk)
    formulario = PartForm(request.POST or None, request.FILES or None, instance=pieza)
    if formulario.is_valid():
        formulario.save()
        return redirect('parts:part_list')

    return render(request, 'parts/part_form_clean.html', {'form': formulario})


@login_required
def part_delete(request, pk):
    pieza = get_object_or_404(Part, pk=pk)
    if request.method == 'POST':
        pieza.delete()
        return redirect('parts:part_list')
    return render(request, 'parts/confirm_delete.html', {'part': pieza})


# -------------------------------
# AJAX ENDPOINTS
# -------------------------------
@csrf_exempt
def toggle_part_sold(request, pk):
    """Cambia el estado vendido/disponible de una pieza."""
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=400)

    pieza = get_object_or_404(Part, pk=pk)
    pieza.sold = not pieza.sold
    pieza.save()
    return JsonResponse({'success': True, 'sold': pieza.sold})


@csrf_exempt
def update_part_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida."""
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=400)
    try:
        pieza = get_object_or_404(Part, pk=pk)
        payload = json.loads(request.body or '{}')
        campo = payload.get('field')
        valor = payload.get('value')

        campos_permitidos = ['name', 'details', 'max_value', 'min_value']
        if campo not in campos_permitidos:
            return JsonResponse({'success': False, 'error': 'Campo no editable'}, status=400)

        if campo in ['max_value', 'min_value']:
            valor = int(valor) if valor else 0

        setattr(pieza, campo, valor)
        pieza.save()

        return JsonResponse({'success': True, 'field': campo, 'value': valor})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


# -------------------------------
# REPORTS & DASHBOARD (integración fullversion_pato)
# -------------------------------

def _has_reports_access(user) -> bool:
    try:
        # Preferir política basada en perfil: admin o can_manage_users
        profile = getattr(user, 'profile', None)
        if profile and (profile.is_admin or profile.can_manage_users()):
            return True
    except Exception:
        pass
    # Fallback: superuser
    return bool(user and user.is_authenticated and user.is_superuser)


@login_required
@xframe_options_sameorigin
def report_preview(request):
    if not _has_reports_access(request.user):
        return render(request, 'parts/access_denied.html', {
            'title': 'Acceso denegado',
            'message': 'No tienes permiso para ver el reporte.',
        }, status=403)

    try:
        # Frecuencia opcional por query (?frequency=weekly)
        frequency = request.GET.get('frequency', 'weekly')
        pdf = generate_report_bytes(frequency=frequency)
        
        if not pdf:
            return JsonResponse({
                'error': 'No se pudo generar el PDF'
            }, status=500)
        
        from django.http import HttpResponse
        resp = HttpResponse(pdf, content_type='application/pdf')
        resp['Content-Disposition'] = 'inline; filename="InventoryEye_Report.pdf"'
        resp['Content-Length'] = len(pdf)
        resp['X-Content-Type-Options'] = 'nosniff'
        resp['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp['Pragma'] = 'no-cache'
        resp['Expires'] = '0'
        return resp
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"Error generando reporte: {error_trace}")
        return JsonResponse({
            'error': 'Error al generar el reporte',
            'details': str(e)
        }, status=500)


@login_required
def report_page(request):
    if not _has_reports_access(request.user):
        return render(request, 'parts/access_denied.html', {
            'title': 'Acceso denegado',
            'message': 'No tienes permiso para administrar reportes.',
        }, status=403)

    message = None

    if request.method == 'POST' and 'send_now' in request.POST:
        try:
            # Obtener datos del formulario
            name = request.POST.get('name', 'Reporte')
            frequency = request.POST.get('frequency', 'weekly')
            recipient_ids = request.POST.getlist('recipients')
            
            if not recipient_ids:
                message = 'Error: Debes seleccionar al menos un destinatario.'
            else:
                # Generar PDF con la frecuencia seleccionada
                pdf_bytes = generate_report_bytes(frequency=frequency)

                # Crear schedule
                schedule = ReportSchedule.objects.create(
                    name=name,
                    frequency=frequency,
                    last_generated=timezone.now()
                )
                
                # Agregar destinatarios
                User = get_user_model()
                recipients = User.objects.filter(id__in=recipient_ids)
                schedule.recipients.set(recipients)

                # Guardar archivo PDF
                filename = f"report_{timezone.now().strftime('%Y%m%d_%H%M%S')}.pdf"
                log = ReportLog(schedule=schedule)
                from django.core.files.base import ContentFile
                log.file.save(filename, ContentFile(pdf_bytes))
                log.save()

                # Enviar email
                emails = [u.email for u in recipients if u.email]
                if emails:
                    from_email = getattr(settings, 'DEFAULT_FROM_EMAIL', 'noreply@transervis.cl')
                    try:
                        email = EmailMessage(
                            subject=f"[Transervis][InventoryEye] Reporte de Inventario - {timezone.now().strftime('%d/%m/%Y')}",
                            body=f"Adjuntamos el reporte {frequency} del inventario.\n\nFecha: {timezone.now().strftime('%d/%m/%Y %H:%M')}\nPeríodo: {frequency.capitalize()}\n\nSaludos,\nSistema Transervis",
                            from_email=from_email,
                            to=emails,
                        )
                        email.attach(filename, pdf_bytes, 'application/pdf')
                        email.send(fail_silently=False)
                        message = f' Reporte generado y enviado exitosamente a {len(emails)} destinatario(s).'
                    except Exception as e:
                        message = f' Reporte generado pero error al enviar email: {str(e)}'
                else:
                    message = ' Reporte generado pero ningún destinatario tiene email configurado.'
        except Exception as e:
            import traceback
            traceback.print_exc()
            message = f' Error al generar/enviar reporte: {str(e)}'

    # Obtener schedules y usuarios
    schedules = ReportSchedule.objects.prefetch_related('logs', 'recipients').order_by('-last_generated')
    users = get_user_model().objects.filter(email__isnull=False).exclude(email='').order_by('username')
    
    return render(request, 'parts/report_page.html', {
        'message': message,
        'schedules': schedules,
        'users': users,
    })


@login_required
def dashboard(request):
    """Dashboard con KPIs y gráficos bonitos (inspirado en fullversion_pato)."""
    from collections import Counter
    from datetime import datetime, time, timedelta

    tz = timezone.get_current_timezone()
    today = timezone.now().date()
    since_days = 13  # últimos 14 días (0..13)
    start_date = today - timezone.timedelta(days=since_days)
    start_dt = timezone.make_aware(datetime.combine(start_date, time.min), tz)
    end_dt = timezone.make_aware(datetime.combine(today + timedelta(days=1), time.min), tz)

    # KPI básicos
    total_parts = Part.objects.count()
    available_parts = Part.objects.filter(state=True, sold=False).count()
    sold_parts = Part.objects.filter(sold=True).count()
    total_autos = Auto.objects.count()
    total_workshops = Workshop.objects.count()

    # Series de Piezas (por día), Taller, Modelo Auto
    parts_qs = (
        Part.objects
        .filter(date_added__gte=start_dt, date_added__lt=end_dt)
        .select_related('workshop', 'auto')
    )
    parts_by_day = Counter()
    parts_by_workshop = Counter()
    parts_by_auto_model = Counter()
    for p in parts_qs:
        d = (p.date_added.astimezone(tz).date() if hasattr(p.date_added, 'astimezone') else p.date_added.date())
        parts_by_day[d] += 1
        ws_name = getattr(getattr(p, 'workshop', None), 'name', None) or 'Desconocido'
        parts_by_workshop[ws_name] += 1
        auto_name = getattr(getattr(p, 'auto', None), 'brand_model', None) or 'Desconocido'
        parts_by_auto_model[auto_name] += 1

    # Autos por color (todas las fechas)
    autos_by_color = Counter(Auto.objects.values_list('color', flat=True))

    # Voice KPIs (si existen)
    voice_sessions_last = []
    ingests_last = []
    try:
        from .models import VoiceSession, VoiceIngestResult, MicConfig
        # Sesiones por día
        sess_qs = VoiceSession.objects.filter(started_at__gte=start_dt, started_at__lt=end_dt)
        sessions_by_day = Counter(
            [(s.started_at.astimezone(tz).date() if hasattr(s.started_at, 'astimezone') else s.started_at.date()) for s in sess_qs]
        )
        # Ingestas por día
        ing_qs = VoiceIngestResult.objects.filter(created_at__gte=start_dt, created_at__lt=end_dt)
        ingests_by_day = Counter(
            [(i.created_at.astimezone(tz).date() if hasattr(i.created_at, 'astimezone') else i.created_at.date()) for i in ing_qs]
        )
        # Totales para cards
        voice_sessions_last = sum(sessions_by_day.values())
        ingests_last = sum(ingests_by_day.values())
        mic_configs_count = MicConfig.objects.count()
    except Exception:
        sessions_by_day = Counter()
        ingests_by_day = Counter()
        mic_configs_count = 0

    # Construir ejes de fechas con 14 días
    date_axis = [start_date + timezone.timedelta(days=i) for i in range(since_days + 1)]
    labels_days = [d.strftime('%d %b') for d in date_axis]
    values_parts_day = [int(parts_by_day.get(d, 0)) for d in date_axis]
    values_sessions_day = [int(sessions_by_day.get(d, 0)) for d in date_axis]
    values_ingests_day = [int(ingests_by_day.get(d, 0)) for d in date_axis]

    # Distribuciones
    ws_sorted = sorted(parts_by_workshop.items(), key=lambda x: x[1], reverse=True)
    labels_workshop = [name for name, _ in ws_sorted]
    values_workshop = [cnt for _, cnt in ws_sorted]

    auto_sorted = sorted(parts_by_auto_model.items(), key=lambda x: x[1], reverse=True)
    labels_autos = [name for name, _ in auto_sorted]
    values_autos = [cnt for _, cnt in auto_sorted]

    color_sorted = sorted(autos_by_color.items(), key=lambda x: x[1], reverse=True)
    labels_colors = [c or 'Desconocido' for c, _ in color_sorted]
    values_colors = [cnt for _, cnt in color_sorted]

    # Disponibilidad (disco doughnut)
    availability_labels = ['Disponibles', 'Vendidas']
    availability_values = [available_parts, sold_parts]

    context = {
        # KPI cards
        'total_parts': total_parts,
        'available_parts': available_parts,
        'sold_parts': sold_parts,
        'total_autos': total_autos,
        'total_workshops': total_workshops,
        'mic_configs_count': mic_configs_count,
        'voice_sessions_last': voice_sessions_last,
        'ingests_last': ingests_last,
        # Series
        'labels_days': labels_days,
        'values_parts_day': values_parts_day,
        'values_sessions_day': values_sessions_day,
        'values_ingests_day': values_ingests_day,
        # Distribuciones
        'labels_workshop': labels_workshop,
        'values_workshop': values_workshop,
        'labels_autos': labels_autos,
        'values_autos': values_autos,
        'labels_colors': labels_colors,
        'values_colors': values_colors,
        # Availability
        'availability_labels': availability_labels,
        'availability_values': availability_values,
    }

    return render(request, 'parts/dashboard.html', context)


# -------------------------------
# LOGS: Visor y API
# -------------------------------

@login_required
def logs_page(request):
    if not _usuario_es_admin(request.user):
        return _render_admin_denied(request, 'Solo el administrador puede ver los logs.')

    # Parámetros por query
    q_session = request.GET.get('session_id', '').strip()
    q_level = request.GET.get('level', '').strip().upper()
    q_module = request.GET.get('module', '').strip()
    q_user = request.GET.get('user_id', '').strip()
    try:
        limit = max(10, min(2000, int(request.GET.get('limit', '300'))))
    except Exception:
        limit = 300

    return render(request, 'parts/logs.html', {
        'session_id': q_session,
        'level': q_level,
        'module': q_module,
        'user_id': q_user,
        'limit': limit,
    })


@login_required
def logs_api(request):
    if not _usuario_es_admin(request.user):
        return JsonResponse({'success': False, 'error': 'Solo administrador'}, status=403)

    q_session = request.GET.get('session_id', '').strip()
    q_level = request.GET.get('level', '').strip().upper()
    q_module = request.GET.get('module', '').strip()
    q_user = request.GET.get('user_id', '').strip()
    try:
        limit = max(10, min(2000, int(request.GET.get('limit', '300'))))
    except Exception:
        limit = 300

    log_file = Path(settings.BASE_DIR) / 'logs' / 'voice.jsonl'
    items = []
    if log_file.exists():
        # Leer últimas N líneas
        dq = deque(maxlen=limit)
        try:
            with open(log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    dq.append(line)
        except Exception as e:
            return JsonResponse({'success': False, 'error': str(e)}, status=500)

        for line in dq:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            # Filtros
            if q_session and q_session not in json.dumps(obj, ensure_ascii=False):
                continue
            if q_level and (obj.get('levelname') or obj.get('level', '')).upper() != q_level:
                continue
            if q_module and q_module not in (obj.get('name') or ''):
                continue
            if q_user:
                found_user = str(obj.get('user_id') or obj.get('meta', {}).get('user_id') or '').strip()
                if not found_user or found_user != q_user:
                    continue
            items.append(obj)

    return JsonResponse({'success': True, 'count': len(items), 'logs': items})


# -------------------------------
# ASISTENTE DE PUBLICACIÓN MANUAL
# -------------------------------


@login_required
def part_publish_redirect(request):
    if not _usuario_es_admin(request.user):
        return _render_admin_denied(request, 'Solo el administrador puede usar el asistente.')

    primer_id = (
        Part.objects.order_by('-date_added', '-id')
        .values_list('id', flat=True)
        .first()
    )
    if not primer_id:
        return render(request, 'parts/publish_helper.html', {
            'part': None,
            'part_ids': [],
            'current_index': -1,
            'previous_id': None,
            'next_id': None,
            'total_parts': 0,
            'generated_title': '',
            'generated_description': '',
            'tag_line': '',
            'price_display': 'Sin precio',
            'category_label': 'Repuestos y accesorios',
            'contact_line': getattr(settings, 'PUBLISH_CONTACT_LINE', 'Escríbenos para coordinar retiro o despacho.'),
            'missing_data': ['No hay repuestos disponibles'],
        })
    return redirect('parts:part_publish', pk=primer_id)


@login_required
def part_publish_helper(request, pk):
    if not _usuario_es_admin(request.user):
        return _render_admin_denied(request, 'Solo el administrador puede usar el asistente.')

    queryset = Part.objects.select_related('auto', 'workshop').order_by('-date_added', '-id')
    ids = list(queryset.values_list('id', flat=True))
    if not ids:
        return part_publish_redirect(request)

    part = get_object_or_404(queryset, pk=pk)
    total = len(ids)
    try:
        index = ids.index(part.id)
    except ValueError:
        return redirect('parts:part_publish', pk=ids[0])

    prev_id = ids[index - 1] if index > 0 else None
    next_id = ids[index + 1] if index < total - 1 else None

    auto_desc = f"{part.auto.brand_model} {part.auto.year}"
    title = f"{part.name} {auto_desc}".strip()
    condition_text = "Disponible" if part.state else "En pausa"

    price_display = _format_clp(part.max_value or part.min_value)
    workshop_line = f"{part.workshop.name} - {part.workshop.direction}"
    contact_line = getattr(
        settings,
        'PUBLISH_CONTACT_LINE',
        'Escríbenos por WhatsApp para coordinar entrega en el taller.'
    )

    detail_lines = [
        f"Pieza: {part.name}",
        f"Auto: {auto_desc}",
        f"Estado: {condition_text}",
        f"Taller: {workshop_line}",
        f"Precio ref: {price_display}",
    ]

    if part.details:
        detail_lines.append(part.details.strip())
    else:
        detail_lines.append('Agrega una nota corta sobre golpes, rayas o estado real.')

    detail_lines.append(contact_line)

    description = "\n".join(detail_lines)
    tags = [part.name, part.auto.brand_model, str(part.auto.year)]
    if part.workshop.name not in tags:
        tags.append(part.workshop.name)
    tag_line = ", ".join(filter(None, tags))

    missing = []
    if not part.image:
        missing.append('Agrega al menos dos fotos nítidas antes de publicar.')
    if not part.details:
        missing.append('Faltan detalles: describe golpes, rayas o estado real.')
    if part.max_value == 0 and part.min_value == 0:
        missing.append('No hay precio referencial, confirma uno antes de publicar.')

    return render(request, 'parts/publish_helper.html', {
        'part': part,
        'part_ids': ids,
        'current_index': index,
        'previous_id': prev_id,
        'next_id': next_id,
        'total_parts': total,
        'auto_desc': auto_desc,
        'generated_title': title,
        'generated_description': description,
        'tag_line': tag_line,
        'price_display': price_display,
        'condition_text': condition_text,
        'workshop_line': workshop_line,
        'category_label': 'Repuestos y accesorios',
        'contact_line': contact_line,
        'missing_data': missing,
    })


@login_required
def dashboard_stats(request):
    """JSON para dashboard interactivo: semanal, mensual y especiales.

    Nota: "vendidas" se estima con sold=True agrupado por date_added (hasta agregar sold_at).
    """
    from collections import Counter
    tz = timezone.get_current_timezone()

    weeks = int(request.GET.get('weeks', '12'))
    months = int(request.GET.get('months', '12'))

    now = timezone.now()
    today = now.date()

    # Ejes mensuales (YYYY-MM) últimos N meses
    def month_key(dt):
        return dt.strftime('%Y-%m')
    month_axis = []
    y, m = today.year, today.month
    for _ in range(months):
        month_axis.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    month_axis = list(reversed(month_axis))

    # Ejes semanales (YYYY-Www) últimas N semanas
    def week_label(d):
        iso = d.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    week_axis = []
    d = today
    seen = set()
    while len(week_axis) < weeks:
        lbl = week_label(d)
        if lbl not in seen:
            week_axis.append(lbl)
            seen.add(lbl)
        d = d - timezone.timedelta(days=1)
    week_axis = list(reversed(week_axis))

    parts_all = Part.objects.select_related('auto', 'workshop').all()

    # Mensual
    added_by_month = Counter()
    sold_by_month = Counter()
    for p in parts_all:
        dt = p.date_added.astimezone(tz) if hasattr(p.date_added, 'astimezone') else p.date_added
        mk = month_key(dt)
        added_by_month[mk] += 1
        if p.sold:
            # Preferir sold_at si existe; fallback a date_added
            sdt = getattr(p, 'sold_at', None) or dt
            if hasattr(sdt, 'astimezone'):
                sdt = sdt.astimezone(tz)
            mk_s = month_key(sdt)
            sold_by_month[mk_s] += 1

    # Semanal
    sold_by_week = Counter()
    for p in parts_all:
        if p.sold:
            base_dt = getattr(p, 'sold_at', None) or p.date_added
            dd = (base_dt.astimezone(tz).date() if hasattr(base_dt, 'astimezone') else base_dt.date())
            sold_by_week[week_label(dd)] += 1

    # Sesiones de voz por semana
    try:
        from .models import VoiceSession
        sessions_all = VoiceSession.objects.all()
    except Exception:
        sessions_all = []
    sessions_by_week = Counter()
    for s in sessions_all:
        dd = (s.started_at.astimezone(tz).date() if hasattr(s.started_at, 'astimezone') else s.started_at.date())
        sessions_by_week[week_label(dd)] += 1

    # Especiales
    available = [p for p in parts_all if (p.state and not p.sold)]
    from collections import Counter as C2
    available_by_workshop = C2()
    for p in available:
        name = getattr(getattr(p, 'workshop', None), 'name', None) or 'Desconocido'
        available_by_workshop[name] += 1

    parts_by_model = C2()
    value_sum_by_model = C2()
    for p in available:
        model_name = getattr(getattr(p, 'auto', None), 'brand_model', None) or 'Desconocido'
        parts_by_model[model_name] += 1
        try:
            avg_price = (float(p.max_value or 0) + float(p.min_value or 0)) / 2.0
        except Exception:
            avg_price = 0.0
        value_sum_by_model[model_name] += avg_price

    # Ordenar especiales desc
    ws_sorted = sorted(available_by_workshop.items(), key=lambda x: x[1], reverse=True)
    mdl_sorted_count = sorted(parts_by_model.items(), key=lambda x: x[1], reverse=True)
    mdl_sorted_value = sorted(value_sum_by_model.items(), key=lambda x: x[1], reverse=True)

    data = {
        'weekly': {
            'axis': week_axis,
            'sold': [int(sold_by_week.get(w, 0)) for w in week_axis],
            'voice_sessions': [int(sessions_by_week.get(w, 0)) for w in week_axis],
        },
        'monthly': {
            'axis': month_axis,
            'sold': [int(sold_by_month.get(m, 0)) for m in month_axis],
            'added': [int(added_by_month.get(m, 0)) for m in month_axis],
        },
        'special': {
            'available_by_workshop': {
                'labels': [k for k, _ in ws_sorted],
                'values': [int(v) for _, v in ws_sorted],
            },
            'parts_by_model': {
                'labels': [k for k, _ in mdl_sorted_count],
                'values': [int(v) for _, v in mdl_sorted_count],
            },
            'model_value_sum': {
                'labels': [k for k, _ in mdl_sorted_value],
                'values': [round(float(v), 2) for _, v in mdl_sorted_value],
            }
        }
    }
    return JsonResponse({'success': True, 'data': data})


@login_required
def part_label(request, pk):
    part = get_object_or_404(Part, pk=pk)
    auto_print = request.GET.get('auto', '1') == '1'
    from django.urls import reverse
    label_url = request.build_absolute_uri(reverse('parts:part_etiqueta', args=[part.id]))
    escpos_url = request.build_absolute_uri(reverse('parts:part_etiqueta_escpos', args=[part.id]))
    return render(request, 'parts/part_label.html', {
        'part': part,
        'auto_print': auto_print,
        'print_image_url': label_url,
        'print_escpos_url': escpos_url,
    })


# -------------------------------
# AUTO CRUD
# -------------------------------
@login_required
def auto_list(request):
    orden_param = (request.GET.get('orden') or request.GET.get('order_by') or '-date_added')
    ordenes_validas = ['year', '-year', 'date_added', '-date_added', 'brand_model', '-brand_model', 'parts_total', '-parts_total']
    if orden_param not in ordenes_validas:
        orden_param = '-date_added'
    orden_labels = {
        '-date_added': 'Más recientes',
        'date_added': 'Más antiguos',
        'brand_model': 'Modelo A-Z',
        '-brand_model': 'Modelo Z-A',
        '-year': 'Año (nuevo a antiguo)',
        'year': 'Año (antiguo a nuevo)',
        '-parts_total': 'Inventario alto → bajo',
        'parts_total': 'Inventario bajo → alto',
    }

    autos = Auto.objects.annotate(parts_total=Count('parts'))

    busqueda = (request.GET.get('q') or '').strip()
    if busqueda:
        autos = autos.filter(
            Q(brand_model__icontains=busqueda) |
            Q(color__icontains=busqueda) |
            Q(license_plate__icontains=busqueda)
        )

    def _limpiar_entero(valor):
        try:
            return int(valor)
        except (TypeError, ValueError):
            return None

    year_desde = _limpiar_entero(request.GET.get('anio_desde'))
    year_hasta = _limpiar_entero(request.GET.get('anio_hasta'))
    if year_desde:
        autos = autos.filter(year__gte=year_desde)
    if year_hasta:
        autos = autos.filter(year__lte=year_hasta)

    color_filtro = (request.GET.get('color') or '').strip()
    if color_filtro:
        autos = autos.filter(color__iexact=color_filtro)

    patente_filtro = request.GET.get('placa') or ''
    if patente_filtro == 'con':
        autos = autos.exclude(license_plate__isnull=True).exclude(license_plate__exact='')
    elif patente_filtro == 'sin':
        autos = autos.filter(Q(license_plate__isnull=True) | Q(license_plate__exact=''))

    inventario_filtro = request.GET.get('inventario') or ''
    if inventario_filtro == 'con_partes':
        autos = autos.filter(parts_total__gt=0)
    elif inventario_filtro == 'sin_partes':
        autos = autos.filter(parts_total__exact=0)

    autos = autos.order_by(orden_param)

    anios_disponibles = Auto.objects.values_list('year', flat=True).distinct().order_by('-year')
    colores_disponibles = (
        Auto.objects.exclude(color__isnull=True)
        .exclude(color__exact='')
        .values_list('color', flat=True)
        .distinct()
        .order_by('color')
    )

    return render(request, 'parts/auto_list.html', {
        'autos': autos,
        'orden_activo': orden_param,
        'orden_label': orden_labels.get(orden_param),
        'busqueda_actual': busqueda,
        'anio_desde': year_desde or '',
        'anio_hasta': year_hasta or '',
        'color_filtrado': color_filtro,
        'placa_filtrada': patente_filtro,
        'inventario_filtrado': inventario_filtro,
        'anios_disponibles': anios_disponibles,
        'colores_disponibles': colores_disponibles,
        'total_autos': autos.count(),
        'filtros_autos_abiertos': bool(request.GET),
    })

@login_required
def auto_create(request):
    formulario = AutoForm(request.POST or None)
    if formulario.is_valid():
        formulario.save()
        return redirect('parts:auto_list')
    return render(request, 'parts/auto_form.html', {'form': formulario})

@login_required
def auto_edit(request, pk):
    auto = get_object_or_404(Auto, pk=pk)
    formulario = AutoForm(request.POST or None, instance=auto)
    if formulario.is_valid():
        formulario.save()
        return redirect('parts:auto_list')
    return render(request, 'parts/auto_form.html', {'form': formulario})

@login_required
def auto_delete(request, pk):
    auto_obj = get_object_or_404(Auto, pk=pk)
    if request.method == 'POST':
        auto_obj.delete()
        return redirect('parts:auto_list')
    return render(request, 'parts/confirm_delete.html', {'object': auto_obj, 'type': 'Auto'})

@login_required
def update_auto_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida de autos."""
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=400)
    try:
        auto = get_object_or_404(Auto, pk=pk)
        payload = json.loads(request.body or '{}')
        campo = payload.get('field')
        valor = payload.get('value')

        campos_permitidos = ['brand_model', 'year', 'color', 'license_plate']
        if campo not in campos_permitidos:
            return JsonResponse({'success': False, 'error': 'Campo no editable'}, status=400)

        if campo == 'year':
            valor = int(valor) if valor else None

        setattr(auto, campo, valor)
        auto.save()

        return JsonResponse({'success': True, 'field': campo, 'value': valor})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


# -------------------------------
# WORKSHOP CRUD
# -------------------------------
@login_required
def workshop_list(request):
    orden_param = (request.GET.get('orden') or request.GET.get('order_by') or '-id')
    ordenes_validas = ['name', '-name', 'direction', '-direction', 'id', '-id', 'parts_total', '-parts_total']
    if orden_param not in ordenes_validas:
        orden_param = '-id'
    orden_labels = {
        '-id': 'Más recientes',
        'id': 'Más antiguos',
        'name': 'Nombre A-Z',
        '-name': 'Nombre Z-A',
        'direction': 'Dirección A-Z',
        '-direction': 'Dirección Z-A',
        '-parts_total': 'Inventario alto → bajo',
        'parts_total': 'Inventario bajo → alto',
    }

    talleres = Workshop.objects.annotate(parts_total=Count('parts'))

    busqueda = (request.GET.get('q') or '').strip()
    if busqueda:
        talleres = talleres.filter(
            Q(name__icontains=busqueda) |
            Q(direction__icontains=busqueda)
        )

    inventario_filtro = request.GET.get('inventario') or ''
    if inventario_filtro == 'con_partes':
        talleres = talleres.filter(parts_total__gt=0)
    elif inventario_filtro == 'sin_partes':
        talleres = talleres.filter(parts_total__exact=0)

    talleres = talleres.order_by(orden_param)

    return render(request, 'parts/workshop_list.html', {
        'talleres': talleres,
        'orden_activo': orden_param,
        'orden_label': orden_labels.get(orden_param),
        'busqueda_actual': busqueda,
        'inventario_filtrado': inventario_filtro,
        'total_talleres': talleres.count(),
        'filtros_talleres_abiertos': bool(request.GET),
    })

@login_required
def workshop_create(request):
    formulario = WorkshopForm(request.POST or None)
    if formulario.is_valid():
        formulario.save()
        return redirect('parts:workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': formulario})

@login_required
def workshop_edit(request, pk):
    taller = get_object_or_404(Workshop, pk=pk)
    formulario = WorkshopForm(request.POST or None, instance=taller)
    if formulario.is_valid():
        formulario.save()
        return redirect('parts:workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': formulario})

@login_required
def workshop_delete(request, pk):
    taller = get_object_or_404(Workshop, pk=pk)
    if request.method == 'POST':
        taller.delete()
        return redirect('parts:workshop_list')
    return render(request, 'parts/confirm_delete.html', {'object': taller, 'type': 'Workshop'})

@login_required
def update_workshop_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida de talleres."""
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=400)
    try:
        workshop = get_object_or_404(Workshop, pk=pk)
        payload = json.loads(request.body or '{}')
        campo = payload.get('field')
        valor = payload.get('value')

        campos_permitidos = ['name', 'direction']
        if campo not in campos_permitidos:
            return JsonResponse({'success': False, 'error': 'Campo no editable'}, status=400)

        setattr(workshop, campo, valor)
        workshop.save()

        return JsonResponse({'success': True, 'field': campo, 'value': valor})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)

@csrf_exempt
def upload_audio(request):
    if request.method != 'POST' or 'audio' not in request.FILES:
        return JsonResponse({"error": "No audio uploaded"}, status=400)

    audio_file = request.FILES['audio']
    
    # Check file size (limit to 10MB to prevent memory issues)
    max_size = 10 * 1024 * 1024  # 10MB
    if audio_file.size > max_size:
        return JsonResponse({
            "error": f"Audio demasiado largo. Máximo {max_size // (1024*1024)}MB. Intenta grabar un audio más corto."
        }, status=400)

    # 1) Save uploaded browser audio (usually webm/opus)
    with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_in:
        for chunk in audio_file.chunks():
            tmp_in.write(chunk)
        in_path = tmp_in.name

    # 2) Convert to 16-bit PCM WAV @ 16 kHz mono (what whisper-cli expects)
    wav_path = in_path + ".wav"

    # Prefer system ffmpeg if available
    from shutil import which
    ffmpeg_exec = which('ffmpeg') or 'ffmpeg'
    ffmpeg_cmd = [
        ffmpeg_exec, "-y", "-i", in_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_path
    ]
    try:
        conv = subprocess.run(ffmpeg_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if conv.returncode != 0 or not os.path.exists(wav_path):
            return JsonResponse({"error": "Error al convertir el audio. Intenta de nuevo."}, status=500)
    except subprocess.TimeoutExpired:
        return JsonResponse({"error": "La conversión del audio tomó demasiado tiempo. Intenta con un audio más corto."}, status=500)
    except FileNotFoundError:
        return JsonResponse({"error": "ffmpeg no encontrado. Contacta al administrador."}, status=500)

    # 2.5) Pre-procesamiento robusto (denoise + normalización)
    try:
        from .audio_preprocessing import preprocess_audio_file
        clean_wav_path = preprocess_audio_file(wav_path, target_sr=16000)
    except Exception:
        clean_wav_path = wav_path

    # Get AI model preference from request (default to local)
    use_cloud = request.POST.get('use_cloud', 'false').lower() == 'true'
    
    # 3) Transcription: Check if cloud mode is enabled first
    result_text = None
    
    if use_cloud:
        print("Using OpenAI Whisper API for transcription...")
        result_text = transcribe_with_openai_api(clean_wav_path)
        if result_text:
            print(f"OpenAI transcription: {len(result_text)} characters")
        else:
            print("Advertencia: OpenAI transcription failed, falling back to local transcription")
    
    # If cloud transcription failed or not enabled, use local transcription
    if not result_text:
        def transcribe_with_python_whisper(wav_file):
            try:
                import whisper
            except Exception:
                return None
            try:
                # Use 'small' model for better accuracy (466MB)
                # Options: tiny (39MB, fast but less accurate), base (142MB, ok accuracy), 
                #          small (466MB, good accuracy), medium (1.5GB, slow), large (2.9GB, very slow)
                # Changed to 'small' for better Spanish transcription quality
                model_name = getattr(settings, 'WHISPER_PY_MODEL', 'small')
                
                print(f"Loading Whisper model: {model_name}...")
                model = whisper.load_model(model_name)
                
                print(f"Transcribing audio file: {wav_file}...")
                # Transcribe with Spanish language and better options
                res = model.transcribe(
                    wav_file, 
                    language='es',
                    task='transcribe',  # Explicitly transcribe (not translate)
                    fp16=False,  # Better compatibility
                    verbose=False,
                    initial_prompt="Transcripción de audio sobre piezas de automóviles en español chileno. Incluye marcas, modelos, colores y precios.",  # Context hint
                    condition_on_previous_text=False  # Don't hallucinate based on previous text
                )
                
                # Extract text and ensure proper encoding
                text = res.get('text', '') if isinstance(res, dict) else ''
                print(f"Transcription completed: {len(text)} characters")
                return text.strip()
            except MemoryError as e:
                print(f"Advertencia: Whisper ran out of memory: {e}")
                return None
            except Exception as e:
                print(f"Advertencia: Whisper transcription error: {e}")
                import traceback
                traceback.print_exc()
                return None

        def transcribe_with_binary(wav_file):
            if getattr(settings, 'WINDOWS_MODE', False):
                win_paths = getattr(settings, 'WINDOWS_PATHS', {})
                whisper_bin = win_paths.get('whisper_bin', 'whisper-cli')
                model_path = win_paths.get('model_path', 'ggml-small.bin')
            else:
                whisper_bin = "/home/purplesheep/Code/transcription/whisper.cpp/build/bin/whisper-cli"
                model_path  = "/home/purplesheep/Code/transcription/whisper.cpp/models/ggml-small.bin"
            cmd = [
                whisper_bin,
                "-m", model_path,
                "-f", wav_file,
                "-ac", "768",
                "-t", "8",
                "-l", "es",
                "--print-progress", "false",
                "--print-special", "false",
            ]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
                if p.returncode == 0:
                    return p.stdout.strip()
            except FileNotFoundError:
                return None
            return None

        # Try python whisper first, then whisper binary
        result_text = transcribe_with_python_whisper(clean_wav_path)
        if not result_text:
            result_text = transcribe_with_binary(clean_wav_path)

    # Optional: remove temp files
    try:
        os.remove(in_path)
        if os.path.exists(wav_path) and wav_path != clean_wav_path:
            os.remove(wav_path)
        if os.path.exists(clean_wav_path) and clean_wav_path != in_path:
            os.remove(clean_wav_path)
    except OSError:
        pass

    out = (result_text or "").strip()
    if not out:
        return JsonResponse({"error": "Transcription failed: no transcription backend available or transcription returned empty."}, status=500)

    # Try extracting vehicle info using selected model; fallback to local heuristic
    vehicle = extract_vehicle_info(out, use_cloud=use_cloud)
    if not vehicle:
        try:
            vehicle = extract_vehicle_info_local(out)
        except Exception:
            vehicle = None

    if vehicle:
        save_vehicle_result(vehicle, source=wav_path)

    # Store vehicle info in session for form pre-population
    if vehicle:
        # Ensure we're storing clean data in the session
        clean_vehicle = _force_schema(vehicle)
        request.session['vehicle_info'] = clean_vehicle
        print("Storing in session:", clean_vehicle)  # Debug print
        
        # Ensure session is saved immediately
        request.session.modified = True

    response = JsonResponse({
        "transcription": out,
        "vehicle_info": vehicle
    }, json_dumps_params={'ensure_ascii': False})
    response['Content-Type'] = 'application/json; charset=utf-8'
    return response


@csrf_exempt
def generate_tts(request):
    """Generate TTS audio for confirmation message"""
    if request.method != 'POST':
        return JsonResponse({'error': 'Only POST allowed'}, status=405)
    
    try:
        data = json.loads(request.body)
        text = data.get('text', '')
        use_cloud = data.get('use_cloud', False)
        
        if not text:
            return JsonResponse({'error': 'No text provided'}, status=400)
        
        # Only generate TTS if cloud mode is enabled
        if not use_cloud:
            return JsonResponse({
                'success': False,
                'message': 'TTS solo disponible en modo Nube'
            })
        
        print(f"Generando TTS para: '{text}'")
        
        # Generate TTS audio
        audio_data = generate_tts_with_openai(text)
        
        if not audio_data:
            return JsonResponse({
                'success': False,
                'error': 'Error generando audio TTS'
            }, status=500)
        
        # Return audio as base64 for easy embedding
        import base64
        audio_base64 = base64.b64encode(audio_data).decode('utf-8')
        
        return JsonResponse({
            'success': True,
            'audio': audio_base64,
            'format': 'mp3'
        })
        
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    except Exception as e:
        print(f"Error en generate_tts: {e}")
        import traceback
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)


def websocket_test(request):
    """WebSocket diagnostic page"""
    return render(request, 'parts/websocket_test.html')


# ---- Vehicle extraction helpers (inline) ----
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "results.json")
SCHEMA_KEYS = ("parte", "valor", "min_value", "detalles")

def _force_schema(obj):
    """Garantiza claves esperadas y deja vacíos como cadenas \"\"."""
    clean = {}
    for key in SCHEMA_KEYS:
        value = (obj.get(key) if isinstance(obj, dict) else None)
        if value in ("", "null", "None", None):
            clean[key] = ""
        elif isinstance(value, str):
            clean[key] = value.strip("'\"")
        else:
            clean[key] = value
    print("Schema after cleaning:", clean)
    return clean

def extract_vehicle_info(text: str, use_cloud: bool = False):
    """
    Extrae información de pieza de auto usando modelos locales (Ollama) o en la nube (GPT-4o).
    
    Args:
        text: Texto a analizar
        use_cloud: Si True, usa GPT-4o; si False, usa Ollama (local)
    
    Returns:
        dict con claves: parte, valor, min_value, detalles
    """
    prompt = f"""
    Contexto: estás extrayendo información de descripciones habladas de repuestos automotrices (español chileno) para inventariar piezas. Responde SOLO con JSON y sigue estas reglas estrictas (usa "" cuando falte información):
Campos:
- "parte": nombre completo de la pieza incluyendo posición/lado (ej. "puerta trasera izquierda"). Nunca reubiques la posición en detalles.
- "valor": precio principal NORMAL (el último mencionado que no sea descuento/oferta). Debe ser un Int. Convierte expresiones de moneda CLP a INT.
- "min_value": último precio mencionado como oferta, descuento, rebaja o "último precio". Si no existe, escribe "".
- "detalles": estado/condición o información relevante de la pieza (ej. "perfecto estado", "tiene abollón leve"). No repitas el nombre de la pieza ni incluyas precios aquí.

Reglas adicionales:
1. Solo usa datos explícitos del texto; no inventes marcas, colores ni modelos (se seleccionan aparte).
2. Si escuchas múltiples valores de una misma categoría, conserva únicamente el ÚLTIMO dicho (el más reciente).
3. Los precios dejalos como Int y lo sigas en formato CLP.
4. Si un precio incluye palabras como "rebajado a" o "último precio", trata ese número como `min_value`.

Texto: "{text}"

Responde exactamente:
{{
  "parte": "",
  "valor": "",
  "min_value": "",
  "detalles": ""
}}
"""
    
    if use_cloud:
        # Use OpenAI GPT-4o (Cloud)
        return _extract_with_openai(prompt, text)
    else:
        # Use Ollama (Local)
        return _extract_with_ollama(prompt)


def _extract_with_openai(prompt: str, text: str):
    """Extrae información usando OpenAI GPT-4o API con logging persistente en BD"""
    import requests
    import time
    from parts.utils.openai_logger import registrar_llamada
    
    api_key = getattr(settings, 'OPENAI_API_KEY', None)
    if not api_key:
        print("ERROR: OPENAI_API_KEY no está configurada")
        return None
    
    try:
        start = time.time()
        print("Llamando a OpenAI GPT-4o API")
        
        inicio = time.monotonic()
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": "gpt-4o-mini",  # Usar mini para 60% menos costo y 2x velocidad
                "messages": [
                    {
                        "role": "system",
                        "content": "Eres un asistente experto en extracción de información de piezas de automóviles. Responde SOLO con JSON válido, sin texto adicional."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "temperature": 0.1,
                "max_tokens": 200,
                "response_format": {"type": "json_object"}  # Force JSON response
            },
            timeout=15  # Reduce timeout
        )
        
        elapsed = time.time() - start
        
        if response.status_code != 200:
            print(f"OpenAI API error: {response.status_code} - {response.text}")
            try:
                jr = response.json()
            except Exception:
                jr = {}
            usage = jr.get('usage', {}) if isinstance(jr, dict) else {}
            registrar_llamada(
                tipo='chat', modelo='gpt-4o-mini', inicio_monotonic=inicio, ok=False,
                codigo_http=response.status_code, error_texto=response.text[:500],
                tokens_prompt=usage.get('prompt_tokens'), tokens_respuesta=usage.get('completion_tokens'),
                prompt_texto_para_hash=prompt, origen='views._extract_with_openai', request_id=jr.get('id') if isinstance(jr, dict) else '',
                meta={'endpoint': 'chat.completions'}
            )
            return None
        
        result = response.json()
        content = result["choices"][0]["message"]["content"]
        usage = result.get('usage', {}) if isinstance(result, dict) else {}
        registrar_llamada(
            tipo='chat', modelo='gpt-4o-mini', inicio_monotonic=inicio, ok=True,
            codigo_http=response.status_code,
            tokens_prompt=usage.get('prompt_tokens'), tokens_respuesta=usage.get('completion_tokens'),
            prompt_texto_para_hash=prompt, origen='views._extract_with_openai', request_id=result.get('id', ''),
            meta={'endpoint': 'chat.completions'}
        )
        
        print(f"GPT-4o-mini response ({elapsed:.2f}s):", content[:100])
        
        # Parse JSON response
        try:
            return _force_schema(json.loads(content))
        except json.JSONDecodeError as e:
            print(f"Advertencia: Error parsing GPT-4o JSON: {e}")
            return None
            
    except requests.exceptions.RequestException as e:
        print(f"Advertencia: No se pudo conectar a OpenAI API: {e}")
        return None
    except Exception as e:
        print(f"Error llamando a OpenAI API: {e}")
        import traceback
        traceback.print_exc()
        return None


def transcribe_with_openai_api(audio_file_path: str):
    """Transcribe audio usando OpenAI Whisper API con logging en BD"""
    import requests
    import time
    import wave
    from parts.utils.openai_logger import registrar_llamada
    
    api_key = getattr(settings, 'OPENAI_API_KEY', None)
    if not api_key:
        print("ERROR: OPENAI_API_KEY no está configurada")
        return None
    
    try:
        start = time.time()
        print("Transcribiendo con OpenAI Whisper API...")
        
        inicio = time.monotonic()
        # Intentar estimar duración del audio si es WAV
        duracion_seg = None
        try:
            with wave.open(audio_file_path, 'rb') as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                duracion_seg = frames / float(rate or 1)
        except Exception:
            pass

        with open(audio_file_path, 'rb') as audio_file:
            response = requests.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={
                    "Authorization": f"Bearer {api_key}"
                },
                files={
                    "file": audio_file
                },
                data={
                    "model": "whisper-1",
                    "language": "es",
                    "prompt": "Transcripción de audio sobre piezas de automóviles en español chileno. Incluye marcas, modelos, colores y precios.",
                    "response_format": "text"
                },
                timeout=60
            )
        
        elapsed = time.time() - start
        
        if response.status_code != 200:
            print(f"OpenAI Whisper API error: {response.status_code} - {response.text}")
            registrar_llamada(
                tipo='whisper', modelo='whisper-1', inicio_monotonic=inicio, ok=False,
                codigo_http=response.status_code, error_texto=response.text[:500],
                prompt_texto_para_hash=None, origen='views.transcribe_with_openai_api', request_id='',
                meta={'endpoint': 'audio.transcriptions', 'duracion_segundos': duracion_seg}
            )
            return None
        
        transcription = response.text.strip()
        print(f"OpenAI Whisper transcription: {len(transcription)} characters ({elapsed:.2f}s)")
        registrar_llamada(
            tipo='whisper', modelo='whisper-1', inicio_monotonic=inicio, ok=True,
            codigo_http=response.status_code,
            prompt_texto_para_hash=None, origen='views.transcribe_with_openai_api', request_id='',
            meta={'endpoint': 'audio.transcriptions', 'duracion_segundos': duracion_seg}
        )
        return transcription
        
    except requests.exceptions.RequestException as e:
        print(f"Advertencia: No se pudo conectar a OpenAI Whisper API: {e}")
        return None
    except Exception as e:
        print(f"Error llamando a OpenAI Whisper API: {e}")
        import traceback
        traceback.print_exc()
        return None


@login_required
def detect_command(request):
    """Detectar comandos de voz en audio corto"""
    if request.method != 'POST':
        return JsonResponse({'error': 'Método no permitido'}, status=405)
    
    if 'audio' not in request.FILES:
        return JsonResponse({'error': 'No se envió archivo de audio'}, status=400)
    
    audio_file = request.FILES['audio']
    
    # Guardar temporalmente
    with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp:
        for chunk in audio_file.chunks():
            tmp.write(chunk)
        webm_path = tmp.name
    
    try:
        # Convertir a WAV
        wav_path = webm_path.replace('.webm', '.wav')
        result = subprocess.run(
            ['ffmpeg', '-i', webm_path, '-ar', '16000', '-ac', '1', wav_path, '-y'],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode != 0:
            return JsonResponse({'command_detected': False})
        
        # Pre-procesamiento robusto
        try:
            from .audio_preprocessing import preprocess_audio_file
            clean_wav = preprocess_audio_file(wav_path, target_sr=16000)
        except Exception:
            clean_wav = wav_path

        # Transcribir con Whisper (preferir OpenAI si está en modo nube)
        text = transcribe_with_openai_api(clean_wav)
        
        if not text:
            # Fallback a Whisper local
            try:
                import whisper
                model = whisper.load_model("base")
                result = model.transcribe(clean_wav, language='es')
                text = result['text'].strip().lower()
            except:
                return JsonResponse({'command_detected': False})
        else:
            text = text.lower()
        
        # Detectar comandos específicos
        command_detected = None
        command_name = None
        
        # Comando INICIAR (nuevo sistema de manos libres)
        if any(word in text for word in ['iniciar', 'comenzar', 'empezar', 'inicio', 'start']):
            command_detected = True
            command_name = 'iniciar'
        # Comando FINALIZAR
        elif any(word in text for word in ['finalizar', 'terminar', 'listo', 'fin', 'terminé', 'termine']):
            command_detected = True
            command_name = 'finalizar'
        # Comando CONFIRMAR
        elif any(word in text for word in ['confirmar', 'guardar', 'sí', 'si', 'correcto', 'ok', 'vale']):
            command_detected = True
            command_name = 'confirmar'
        # Comando CANCELAR
        elif any(word in text for word in ['cancelar', 'volver', 'reintentar', 'no', 'repetir']):
            command_detected = True
            command_name = 'cancelar'
        # Comando legacy: ingresar pieza
        elif ('ingresar' in text or 'agregar' in text or 'nueva' in text) and 'pieza' in text:
            command_detected = True
            command_name = 'ingresar_pieza'
        
        # Limpiar archivos
        try:
            os.unlink(webm_path)
            if os.path.exists(wav_path) and wav_path != clean_wav:
                os.unlink(wav_path)
            if os.path.exists(clean_wav) and clean_wav != webm_path:
                os.unlink(clean_wav)
        except:
            pass
        
        if command_detected:
            print(f"Comando detectado: {command_name} ('{text}')")
            return JsonResponse({
                'command_detected': True,
                'command': command_name,
                'text': text
            })
        else:
            return JsonResponse({'command_detected': False})
            
    except Exception as e:
        print(f"Error en detección de comando: {e}")
        return JsonResponse({'command_detected': False})


def generate_tts_with_openai(text: str):
    """Genera audio TTS usando OpenAI TTS API con logging en BD"""
    import requests
    import time
    from parts.utils.openai_logger import registrar_llamada
    
    api_key = getattr(settings, 'OPENAI_API_KEY', None)
    if not api_key:
        print("ERROR: OPENAI_API_KEY no está configurada")
        return None
    
    try:
        start = time.time()
        print(f"Generando TTS con OpenAI: '{text}'")
        
        inicio = time.monotonic()
        response = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": "tts-1-hd",  # HD quality - 2x cost but much better quality
                "input": text,
                "voice": "shimmer",  # shimmer: warm, expressive (great for Spanish)
                # Other options for testing:
                # "nova": friendly, upbeat (good for Spanish)
                # "onyx": deep, authoritative (male voice)
                # "alloy": neutral, balanced
                # "echo": warm male voice
                # "fable": expressive, storytelling
                "response_format": "mp3",
                "speed": 1.0  # Normal speed for better clarity
            },
            timeout=15  # Reduce timeout since TTS is usually fast
        )
        
        elapsed = time.time() - start
        
        if response.status_code != 200:
            print(f"OpenAI TTS API error: {response.status_code} - {response.text}")
            registrar_llamada(
                tipo='tts', modelo='tts-1-hd', inicio_monotonic=inicio, ok=False,
                codigo_http=response.status_code, error_texto=response.text[:500],
                prompt_texto_para_hash=text, origen='views.generate_tts_with_openai', request_id='',
                meta={'endpoint': 'audio.speech'}
            )
            return None
        
        print(f"TTS generado: {len(response.content)} bytes ({elapsed:.2f}s)")
        registrar_llamada(
            tipo='tts', modelo='tts-1-hd', inicio_monotonic=inicio, ok=True,
            codigo_http=response.status_code, prompt_texto_para_hash=text,
            origen='views.generate_tts_with_openai', request_id='', meta={'endpoint': 'audio.speech'}
        )
        return response.content  # Returns binary audio data (MP3)
        
    except requests.exceptions.RequestException as e:
        print(f"Advertencia: No se pudo conectar a OpenAI TTS API: {e}")
        return None
    except Exception as e:
        print(f"Error llamando a OpenAI TTS API: {e}")
        import traceback
        traceback.print_exc()
        return None


def _extract_with_ollama(prompt: str):
    """Extrae información usando Ollama API"""
    import requests
    
    ollama_host = getattr(settings, 'OLLAMA_HOST', 'http://ollama:11434')
    model_name = getattr(settings, 'OLLAMA_MODEL', 'llama3.2:1b')
    
    try:
        print("Llamando a Ollama API:", ollama_host, "con modelo:", model_name)
        
        response = requests.post(
            f"{ollama_host}/api/generate",
            json={
                "model": model_name,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 200,
                    "top_p": 0.9,
                }
            },
            timeout=60
        )
        
        if response.status_code != 200:
            print(f"Ollama API error: {response.status_code}")
            return None
            
        result = response.json()
        out = result.get("response", "").strip()
        
        print("Ollama response:", out)
        
    except requests.exceptions.RequestException as e:
        print("Advertencia: No se pudo conectar a Ollama:", str(e))
        return None
    except Exception as e:
        print("Error llamando a Ollama API:", str(e))
        return None

    # 1) Intento de parseo directo
    try:
        return _force_schema(json.loads(out))
    except json.JSONDecodeError:
        pass

    # 2) Extraer el primer bloque JSON si vino con texto adicional
    m = re.search(r"\{.*\}", out, re.DOTALL)
    if m:
        try:
            return _force_schema(json.loads(m.group(0)))
        except json.JSONDecodeError:
            pass

    # 3) Si nada funcionó, loggear y devolver None
    print("Advertencia:  Salida no es JSON válido desde Ollama:\n", out)
    return None


def extract_vehicle_info_local(text: str):
    """Heurística local para extraer parte, precios y detalles sin depender de LLM."""
    t = text.lower()

    def _find_number(patterns):
        for pattern in patterns:
            match = re.search(pattern, t, re.IGNORECASE)
            if match:
                number = match.group(1).replace('.', '').replace(',', '')
                return number
        return None

    # Buscar valor principal (último número encontrado)
    all_numbers = re.findall(r"([0-9]+(?:[.,][0-9]{3})*)", t)
    val = all_numbers[-1].replace('.', '').replace(',', '') if all_numbers else None

    # Buscar precio mínimo basado en palabras clave
    min_val = _find_number([
        r"(?:ultimo|último|final|rebajado|oferta|minimo|mínimo)[^0-9]*([0-9]+(?:[.,][0-9]{3})*)",
        r"(?:precio\s+minimo|precio\s+mínimo)[^0-9]*([0-9]+(?:[.,][0-9]{3})*)",
    ])

    # Detectar nombre de la pieza
    parte = None
    patrones_parte = [
        r"(?:pieza|parte|repuesto)\s+de\s+([a-z0-9 ]{2,40})",
        r"(parachoque|parachoques|guardafango|cap[oó]|puerta|rueda|llanta|faro|radiador|motor|compresor|parabrisas|espejo|asiento)[a-z0-9 ]{0,40}"
    ]
    for pattern in patrones_parte:
        m = re.search(pattern, t, re.IGNORECASE)
        if m:
            parte = m.group(1 if pattern.startswith('(?:pieza') else 0).strip()
            break

    if not parte:
        m_generic = re.search(r"de\s+([a-z0-9 ]{2,40})", t)
        if m_generic:
            parte = m_generic.group(1).split('.')[0].strip()

    # Buscar detalles / estado
    detalles = None
    
    # Diccionario de traducciones para partes comunes
    translations = {
        'front right door': 'puerta delantera derecha',
        'front left door': 'puerta delantera izquierda',
        'rear right door': 'puerta trasera derecha',
        'rear left door': 'puerta trasera izquierda',
        'hood': 'capó',
        'trunk': 'maletero',
        'bumper': 'parachoques',
        'headlight': 'faro delantero',
        'taillight': 'faro trasero',
        'mirror': 'espejo retrovisor',
        'window': 'ventana',
        'engine': 'motor',
        'transmission': 'transmisión',
        'front': 'delantero',
        'rear': 'trasero',
        'right': 'derecho',
        'left': 'izquierdo'
    }
    
    # Primero traducir cualquier término en inglés
    for eng, esp in translations.items():
        t = re.sub(rf'\b{eng}\b', esp, t, flags=re.IGNORECASE)
    
    # Capturar descripción literal del usuario (buscar frases sobre estado/condición)
    estado_patterns = [
        r"(?:estado|condición|condicion)[:\s]+([^,.!?]+)",
        r"(todo\s+(?:impecable|perfecto|bien|mal|excelente)[^,.!?]*)",
        r"((?:impecable|perfecto|excelente|nuevo|usado)[^,.!?]*)",
        r"([^,.!?]*(?:rayon|rayado|oxid|abollad|golpead|dañad|romp|desgastad)[^,.!?]*)",
    ]
    
    for pattern in estado_patterns:
        m = re.search(pattern, t, re.IGNORECASE)
        if m:
            # Capturar el texto literal, solo limpiando espacios extras
            detalles = m.group(1).strip()
            break
    
    # Si no encontró nada específico pero hay palabras clave de estado, capturar contexto amplio
    if not detalles:
        keywords = ['perfecto', 'impecable', 'excelente', 'nuevo', 'usado', 'rayado', 'oxidado', 'dañado', 'roto']
        for kw in keywords:
            if kw in t:
                # Intentar capturar la frase completa donde aparece la palabra
                m = re.search(rf'([^,.!?]*{kw}[^,.!?]*)', t, re.IGNORECASE)
                if m:
                    detalles = m.group(1).strip()
                    break

    return _force_schema({
        "parte": parte,
        "valor": val,
        "min_value": min_val,
        "detalles": detalles
    })

def save_vehicle_result(entry: dict, source: str):
    """
    Agrega el resultado normalizado a results.json junto con el origen (e.g., ruta del WAV).
    Devuelve el registro escrito o None si 'entry' está vacío.
    """
    if not entry:
        return None

    record = {"source": source, "data": _force_schema(entry)}

    # Leer archivo si existe
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if not isinstance(data, list):
                    data = []
        except Exception:
            data = []
    else:
        data = []

    data.append(record)

    # Guardar
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    return record
# ---- end helpers ----


# -------------------------------
# VOICE TEXT PROCESSING (Speech API → Text → OpenAI)
# -------------------------------
@csrf_exempt
@login_required
def process_voice_text(request):
    """
    Procesa TEXTO transcrito por Speech API del navegador.
    Usa OpenAI GPT para extraer datos estructurados.
    NO procesa audio, solo texto.
    """
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método no permitido'}, status=405)
    
    try:
        description_text = request.POST.get('description_text', '').strip()
        
        if not description_text:
            return JsonResponse({'success': False, 'error': 'No se recibió texto'}, status=400)
        
        print(f"Texto recibido ({len(description_text)} chars): {description_text}")
        
        # Usar OpenAI GPT para extraer datos del texto
        import openai
        openai.api_key = settings.OPENAI_API_KEY
        
        system_prompt = """Eres un asistente que extrae información estructurada de descripciones de piezas de auto.
Extrae: nombre de pieza, cantidad, ubicación, y detalles adicionales.

Responde SIEMPRE en formato JSON válido:
{
  "name": "nombre de la pieza",
  "quantity": número,
  "location": "ubicación física",
  "details": "detalles adicionales"
}

Si falta información, usa null. Si no se menciona cantidad, usa 1."""

        user_prompt = f"Extrae los datos de esta descripción: {description_text}"
        
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.3,
            max_tokens=500
        )
        
        result_text = response['choices'][0]['message']['content'].strip()
        print(f"Respuesta de OpenAI: {result_text}")
        
        # Parsear JSON
        extracted_data = json.loads(result_text)
        
        return JsonResponse({
            'success': True,
            'data': extracted_data,
            'original_text': description_text
        })
        
    except json.JSONDecodeError as e:
        print(f"Error parseando JSON de OpenAI: {e}")
        return JsonResponse({'success': False, 'error': 'Error procesando respuesta de AI'}, status=500)
    
    except Exception as e:
        print(f"Error procesando texto: {e}")
        return JsonResponse({'success': False, 'error': str(e)}, status=500)


# -------------------------------
# API EXPLORER
# -------------------------------
@login_required
def api_explorer(request):
    """Vista para explorar y probar la API REST desde el navegador."""
    return render(request, 'parts/api_explorer.html')
