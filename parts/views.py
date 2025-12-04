import os
import base64
import contextlib
import re
import json
import time
import zipfile
import tempfile
import subprocess
import unicodedata
from functools import lru_cache
from io import BytesIO
from uuid import uuid4
from django.conf import settings
from decimal import Decimal
import requests
from django.core.mail import EmailMessage
from django.core.files.base import ContentFile
from django.contrib.auth import get_user_model
from django.contrib import messages
from django.utils import timezone
from django.utils.html import json_script
from django.utils.safestring import mark_safe
from django.http import JsonResponse, FileResponse, HttpResponse
from django.urls import reverse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_exempt, csrf_protect
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.contrib.auth.decorators import login_required
from django.db.models import Q, Count, Max, Sum, Avg
from django.core.paginator import Paginator
from django.template.loader import render_to_string
from django.views.decorators.http import require_POST, require_http_methods
from PIL import Image
from .models import (
    Part,
    Auto,
    Workshop,
    ReportSchedule,
    ReportLog,
    PartPhoto,
    EventoSistema,
    SynonymTerm,
    SynonymGroup,
    VoiceSession,
    VoiceIngestResult,
)
from .forms import PartForm, AutoForm, WorkshopForm, ReportScheduleForm, SynonymGroupForm, SynonymTermForm
from .utils.report_generator import generate_report_bytes
from collections import deque, Counter
from datetime import datetime
from pathlib import Path
import logging
from .auditoria import Auditoria
from .utils.part_normalizer import (
    normalize_piece_name,
    normalize_position,
    get_piece_vocabulary,
    get_position_vocabulary,
    refresh_caches,
)
from .utils.privacy import anonymize_ip
from parts.utils.permissions import ensure_voice_ingest_permission
from .services.barcode_detector import detect_barcodes, LocalBarcodeDetectorError

# Logger dedicado para eventos Bluetooth del frontend
bluetooth_logger = logging.getLogger('parts.bluetooth')
activity_logger = logging.getLogger('parts.activity')
boot_logger = logging.getLogger('parts.boot')
scanner_logger = logging.getLogger('parts.scanner')

_SEARCH_STOPWORDS = {
    'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'en', 'al',
    'lo', 'para', 'por', 'con', 'su', 'sus', 'mi', 'tu', 'se'
}

_MAX_FILTER_TERMS = 10
_MAX_RANKED_RESULTS = getattr(settings, 'PARTS_SEARCH_MAX_RANKED_RESULTS', 600)

_COMMAND_WORD_SPLIT_RE = re.compile(r'\W+', flags=re.UNICODE)


def _extract_command_tokens(text):
    """Devuelve un conjunto de tokens normalizados para detección exacta de comandos."""
    if not text:
        return set()
    lowered = text.lower()
    return {tok for tok in _COMMAND_WORD_SPLIT_RE.split(lowered) if tok}


def _contains_command_word(tokens, candidates):
    """Verdadero si alguno de los candidatos aparece como palabra exacta."""
    return any(word in tokens for word in candidates)


class _RankedResultBuffer(list):
    """Lista envoltorio para conservar el total original y mostrar aviso de truncamiento."""

    __slots__ = ('total_count',)

    def __init__(self, iterable, total_count: int):
        super().__init__(iterable)
        self.total_count = total_count


def _strip_accents(value: str) -> str:
    if not value:
        return ''
    return ''.join(
        ch for ch in unicodedata.normalize('NFKD', value)
        if not unicodedata.combining(ch)
    )


def _generate_adaptive_search_terms(raw_query: str, max_terms: int = 25) -> list[str]:
    if not raw_query:
        return []

    def _add(term: str):
        term = (term or '').strip()
        if term and term not in terms and len(terms) < max_terms:
            terms.append(term)

    normalized = _strip_accents(raw_query.lower())
    terms: list[str] = []
    _add(raw_query)
    _add(normalized)

    tokens = [tok for tok in re.split(r'[\s,/+-]+', normalized) if tok]
    for token in tokens:
        if token in _SEARCH_STOPWORDS:
            continue
        _add(token)
        base = token
        for syn in _lookup_synonyms(base):
            _add(syn)

        match = re.match(r'^([a-zñ]+)(\d{2,4})$', base)
        if match:
            letters, digits = match.groups()
            _add(f"{letters} {digits}")
            if len(digits) == 2:
                _add(f"{letters} 20{digits}")
            elif len(digits) == 4 and digits.startswith('20'):
                _add(f"{letters} {digits[-2:]}")

    spaced = re.finditer(r'([a-zñ]{2,})\s+(\d{2,4})', normalized)
    for match in spaced:
        letters, digits = match.groups()
        _add(f"{letters} {digits}")
        if len(digits) == 2:
            _add(f"{letters} 20{digits}")
        elif len(digits) == 4 and digits.startswith('20'):
            _add(f"{letters} {digits[-2:]}")

    compact = normalized.replace(' ', '')
    if compact != normalized:
        _add(compact)

    return terms


def _build_filter_terms(raw_query: str, max_terms: int = _MAX_FILTER_TERMS) -> list[str]:
    """Selecciona un subconjunto acotado de términos (incluyendo sinónimos) para el filtro SQL."""
    if not raw_query:
        return []

    normalized = _strip_accents(raw_query.lower())
    tokens = [tok for tok in re.split(r'[\s,/+-]+', normalized) if tok]
    selected: list[str] = []

    def _push(value: str):
        value = (value or '').strip()
        if (
            value
            and value not in _SEARCH_STOPWORDS
            and value not in selected
            and len(selected) < max_terms
        ):
            selected.append(value)

    for token in tokens:
        _push(token)
        if len(selected) >= max_terms:
            break
        for synonym in _lookup_synonyms(token):
            synonym_clean = _strip_accents((synonym or '').lower())
            _push(synonym_clean)
            if len(selected) >= max_terms:
                break

    if not selected and normalized:
        _push(normalized)

    return selected


def _tokenize_query(query: str) -> list[str]:
    if not query:
        return []
    return re.findall(r'[0-9a-záéíóúüñ]+', query, flags=re.IGNORECASE)


def _best_fragment_match(tokens: list[str], normalizer, max_len: int = 4) -> str:
    if not tokens:
        return ''
    length = len(tokens)
    limit = min(max_len, length)
    for size in range(limit, 0, -1):
        for start in range(0, length - size + 1):
            fragment = ' '.join(tokens[start:start + size])
            result = normalizer(fragment)
            if result.get('matched'):
                return result.get('normalized') or ''
    return ''


def _build_search_context(raw_query: str, search_terms: list[str]) -> dict:
    tokens = _tokenize_query(raw_query)
    normalized_piece = _best_fragment_match(tokens, normalize_piece_name)
    normalized_position = _best_fragment_match(tokens, normalize_position)
    word_terms = {token.lower() for token in tokens if token}
    for term in search_terms or []:
        term = (term or '').strip().lower()
        if term:
            word_terms.add(term)
    return {
        'piece': (normalized_piece or '').lower(),
        'position': (normalized_position or '').lower(),
        'words': [t for t in word_terms if t]
    }


def _score_part_for_query(part, context: dict) -> int:
    if not context:
        return 0
    score = 0
    part_name = (part.name or part.catalog_name or '').strip()
    target_piece = context.get('piece') or ''
    if target_piece:
        normalized_part = normalize_piece_name(part_name)
        part_piece = (normalized_part.get('normalized') or '').lower()
        if part_piece == target_piece:
            score += 300
        elif target_piece in part_name.lower():
            score += 140

    target_position = context.get('position') or ''
    if target_position:
        part_position = (part.position or '').strip()
        normalized_position = normalize_position(part_position)
        part_position_norm = (normalized_position.get('normalized') or '').lower()
        if part_position_norm == target_position:
            score += 140
        elif target_position in part_position.lower():
            score += 80

    combined_text = ' '.join(filter(None, [
        part_name,
        part.details or '',
        part.position or '',
        part.auto.brand_model if getattr(part, 'auto', None) else '',
        str(part.auto.year) if getattr(part, 'auto', None) else '',
        part.workshop.name if getattr(part, 'workshop', None) else '',
    ])).lower()
    for term in context.get('words', []):
        if term and term in combined_text:
            score += 10
    return score


@lru_cache(maxsize=2048)
def _lookup_synonyms(normalized_term: str) -> list[str]:
    normalized = normalized_term.strip()
    if not normalized:
        return []
    group_ids = list(
        SynonymTerm.objects.filter(normalized_term=normalized).values_list('group_id', flat=True)
    )
    if not group_ids:
        return []
    terms = list(
        SynonymTerm.objects.filter(group_id__in=group_ids).values_list('term', flat=True)
    )
    group_names = list(
        SynonymGroup.objects.filter(id__in=group_ids).values_list('name', flat=True)
    )
    return list(dict.fromkeys(terms + group_names))


def _get_placeholder_auto():
    auto, _ = Auto.objects.get_or_create(
        brand_model='Sin vehículo',
        year=1900,
        defaults={
            'color': 'Sin color',
            'license_plate': 'SIN-VEH'
        }
    )
    return auto

def _get_placeholder_workshop():
    workshop, _ = Workshop.objects.get_or_create(
        name='Sin taller',
        defaults={'direction': 'Sin asignar'}
    )
    return workshop
@login_required
@csrf_protect
@require_POST
def bluetooth_log(request):
    """Recibe eventos de log del sistema Bluetooth del frontend y los envía al logger centralizado.
    POST /parts/bluetooth/log/
    Body JSON: {"evento": str, "datos": dict, "ts": int, "url": str, "ua": str}
    """
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
        client_ip = anonymize_ip(request.META.get('REMOTE_ADDR'))
        bluetooth_logger.info('BT_EVENT', extra={
            'evento': evento,
            'datos': datos,
            'ts': ts,
            'page_url': page_url,
            'user_agent': ua,
            'remote_ip': client_ip,
            'user_id': request.user.id if hasattr(request, 'user') and request.user.is_authenticated else None,
        })
    except Exception:
        # Evitar fallar por logging; responder OK igualmente
        pass

    return JsonResponse({'ok': True})


def _get_log_sources():
    logs_root = Path(settings.BASE_DIR) / 'logs'
    return [
        ('voice', logs_root / 'voice.jsonl'),
        ('app', logs_root / 'app.jsonl'),
        ('bluetooth', logs_root / 'bluetooth.jsonl')
    ]


def _collect_log_values(field_names, limit=800):
    if isinstance(field_names, str):
        field_names = [field_names]
    values = set()
    for _, file_path in _get_log_sources():
        if not file_path.exists():
            continue
        dq = deque(maxlen=limit)
        try:
            with open(file_path, 'r', encoding='utf-8') as handler:
                for line in handler:
                    dq.append(line)
        except Exception:
            continue
        for raw in dq:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            for field in field_names:
                val = obj.get(field)
                if isinstance(val, str):
                    stripped = val.strip()
                    if stripped:
                        values.add(stripped)
    return sorted(values)


def _parse_log_timestamp(value):
    if not value:
        return None
    for fmt in ('%Y-%m-%d %H:%M:%S,%f', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(value, fmt)
        except Exception:
            continue
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric > 1e12:
        numeric /= 1000.0
    try:
        return datetime.fromtimestamp(numeric)
    except Exception:
        return None


def _extract_session_identifier(entry):
    meta = entry.get('meta') or {}
    session_id = (
        entry.get('session_id')
        or entry.get('session')
        or meta.get('session_id')
    )
    if not session_id:
        return ''
    return str(session_id).strip()


def _extract_user_display(entry):
    meta = entry.get('meta') or {}
    datos = entry.get('datos') or {}
    candidates = [
        meta.get('user_label'),
        meta.get('user_name'),
        meta.get('username'),
        meta.get('usuario'),
        entry.get('usuario'),
        entry.get('usuario_nombre'),
        entry.get('usuario_label'),
        entry.get('user'),
        entry.get('username'),
        entry.get('operator'),
        datos.get('usuario'),
        datos.get('user_label'),
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    user_id = (
        entry.get('user_id')
        or entry.get('usuario_id')
        or meta.get('user_id')
        or meta.get('usuario_id')
    )
    if user_id:
        return f"Usuario #{user_id}"
    return 'Usuario sin identificar'


def _extract_event_display(entry):
    meta = entry.get('meta') or {}
    datos = entry.get('datos') or {}
    candidates = [
        meta.get('event_label'),
        meta.get('action'),
        meta.get('label'),
        datos.get('label'),
        datos.get('action'),
        entry.get('descripcion'),
        entry.get('description'),
        entry.get('evento'),
        entry.get('event'),
        entry.get('message'),
        entry.get('detail'),
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            text = candidate.strip()
            return re.sub(r'[_-]+', ' ', text).capitalize()
    return 'Evento'


def _friendly_source_label(source):
    source = (source or '').lower()
    if source == 'app':
        return 'Aplicación'
    if source == 'voice':
        return 'Motor de voz'
    if source == 'bluetooth':
        return 'Impresora Bluetooth'
    return 'Sistema'


def _load_recent_logs(limit_per_source=600):
    entries = []
    for source_name, file_path in _get_log_sources():
        if not file_path.exists():
            continue
        dq = deque(maxlen=limit_per_source)
        try:
            with open(file_path, 'r', encoding='utf-8') as handler:
                for line in handler:
                    dq.append(line)
        except Exception:
            continue
        for raw in dq:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            obj['source'] = source_name
            obj['_ts'] = _parse_log_timestamp(
                obj.get('asctime') or obj.get('created') or obj.get('timestamp')
            )
            entries.append(obj)
    entries.sort(key=lambda item: item.get('_ts') or datetime.min, reverse=True)
    return entries


def _collect_session_suggestions(limit=200):
    suggestions = []
    seen = set()
    for log in _load_recent_logs(limit_per_source=600):
        session_id = _extract_session_identifier(log)
        if not session_id or session_id in seen:
            continue
        ts = log.get('_ts')
        ts_label = ts.strftime('%d/%m %H:%M') if ts else 'Reciente'
        parts_labels = [
            ts_label,
            _friendly_source_label(log.get('source')),
            _extract_user_display(log),
            _extract_event_display(log)
        ]
        label = ' · '.join(part for part in parts_labels if part)
        suggestions.append({'value': session_id, 'label': label})
        seen.add(session_id)
        if len(suggestions) >= limit:
            break
    return suggestions


def _humanize_module_label(raw_value: str) -> str:
    if not raw_value:
        return ''
    text = raw_value.replace('.', ' · ')
    text = re.sub(r'[_-]+', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text.title()


def _collect_module_suggestions(limit=200):
    modules = _collect_log_values(['module', 'name'], limit=600)
    suggestions = []
    for module in modules:
        suggestions.append({'value': module, 'label': _humanize_module_label(module)})
        if len(suggestions) >= limit:
            break
    return suggestions

@login_required
@csrf_protect
@require_POST
def frontend_activity_log(request):
    """Recibe eventos del frontend para auditoría de interacción."""
    try:
        payload = json.loads(request.body.decode('utf-8')) if request.body else {}
    except Exception as exc:
        return JsonResponse({'error': 'JSON inválido', 'detalle': str(exc)}, status=400)

    event_name = (payload.get('event') or 'unknown').lower()
    client_ip = anonymize_ip(request.META.get('REMOTE_ADDR'))
    data = {
        'event': event_name,
        'path': payload.get('path'),
        'label': payload.get('label') or '',
        'href': payload.get('href'),
        'tag': payload.get('tag'),
        'meta': payload.get('meta') or {},
        'ts_client': payload.get('ts'),
        'user_id': request.user.id,
        'username': request.user.get_username(),
        'ip': client_ip,
        'user_agent': request.META.get('HTTP_USER_AGENT', '')[:256],
    }
    try:
        activity_logger.info('frontend_event', extra={'event': 'frontend_activity', **data})
    except Exception:
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


def _usuario_puede_editar_partes(user) -> bool:
    """Permite modificaciones de piezas únicamente a roles autorizados."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    perfil = getattr(user, 'profile', None)
    if perfil and hasattr(perfil, 'can_edit_parts'):
        return bool(perfil.can_edit_parts())
    return bool(getattr(user, 'is_staff', False) or getattr(user, 'is_superuser', False))


def _usuario_puede_crear_partes(user) -> bool:
    """Valida si el usuario puede crear nuevas piezas."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    perfil = getattr(user, 'profile', None)
    if perfil and hasattr(perfil, 'can_add_parts'):
        return bool(perfil.can_add_parts())
    return bool(getattr(user, 'is_superuser', False))


def _usuario_puede_eliminar_partes(user) -> bool:
    """Permite eliminar piezas sólo a perfiles autorizados."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    perfil = getattr(user, 'profile', None)
    if perfil and hasattr(perfil, 'can_delete_parts'):
        return bool(perfil.can_delete_parts())
    return bool(getattr(user, 'is_superuser', False))


def _usuario_puede_marcar_venta(user) -> bool:
    """Valida si el usuario puede marcar una pieza como vendida / disponible."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    perfil = getattr(user, 'profile', None)
    if perfil and hasattr(perfil, 'can_sell_parts'):
        return bool(perfil.can_sell_parts())
    return bool(getattr(user, 'is_superuser', False))


try:
    RESAMPLE_LANCZOS = Image.Resampling.LANCZOS
except AttributeError:
    RESAMPLE_LANCZOS = Image.LANCZOS


def _procesar_imagen_cuadrada(archivo, max_px=1280):
    """Recorta al centro y comprime en formato 1:1."""
    try:
        imagen = Image.open(archivo)
        imagen = imagen.convert('RGB')
    except Exception as exc:
        raise ValueError('Imagen inválida') from exc

    ancho, alto = imagen.size
    lado = min(ancho, alto)
    left = (ancho - lado) // 2
    top = (alto - lado) // 2
    imagen = imagen.crop((left, top, left + lado, top + lado))

    if lado > max_px:
        imagen = imagen.resize((max_px, max_px), RESAMPLE_LANCZOS)

    buffer = BytesIO()
    imagen.save(buffer, format='JPEG', quality=85, optimize=True)
    buffer.seek(0)
    return ContentFile(buffer.read(), name=f'part_{uuid4().hex}.jpg')


def _serializar_foto_part(foto: PartPhoto):
    return {
        'id': foto.id,
        'url': foto.image.url if foto.image else '',
        'created_at': timezone.localtime(foto.created_at).isoformat(),
    }


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
    filtro_taller = (request.GET.get('taller') or request.GET.get('workshop') or '').strip()
    busqueda_global = (request.GET.get('q') or '').strip()
    try:
        per_page = int(request.GET.get('per_page') or 20)
    except (TypeError, ValueError):
        per_page = 20
    per_page = max(20, min(per_page, 100))

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
    if filtro_taller:
        if filtro_taller.isdigit():
            try:
                piezas = piezas.filter(workshop_id=int(filtro_taller))
            except (TypeError, ValueError):
                piezas = piezas.none()
        else:
            piezas = piezas.filter(workshop__name__icontains=filtro_taller)

    search_terms: list[str] = []
    filter_terms: list[str] = []
    if busqueda_global:
        search_terms = _generate_adaptive_search_terms(busqueda_global)
        filter_terms = _build_filter_terms(busqueda_global)
        if not filter_terms:
            fallback_term = busqueda_global.strip()
            if fallback_term:
                filter_terms = [fallback_term]
        filtro = Q()
        for term in filter_terms:
            filtro |= (
                Q(name__icontains=term)
                | Q(details__icontains=term)
                | Q(auto__brand_model__icontains=term)
                | Q(auto__year__icontains=term)
                | Q(auto__color__icontains=term)
                | Q(auto__license_plate__icontains=term)
                | Q(workshop__name__icontains=term)
            )
        if filtro:
            piezas = piezas.filter(filtro)
    inventory_stats = {
        'total': Part.objects.count(),
        'sold': Part.objects.filter(sold=True).count(),
        'available': Part.objects.filter(sold=False, state=True).count(),
    }
    incomplete_q = (
        Q(name__isnull=True) | Q(name__exact='')
        | Q(min_value__isnull=True) | Q(min_value__lte=0)
        | Q(workshop__isnull=True)
        | Q(workshop__name__isnull=True) | Q(workshop__name__exact='')
    )
    inventory_stats['incomplete'] = Part.objects.filter(incomplete_q).count()
    total_inventory = inventory_stats.get('total') or 0
    if total_inventory:
        inventory_stats['available_pct'] = round((inventory_stats.get('available') or 0) * 100 / total_inventory)
        inventory_stats['sold_pct'] = round((inventory_stats.get('sold') or 0) * 100 / total_inventory)
    else:
        inventory_stats['available_pct'] = 0
        inventory_stats['sold_pct'] = 0

    latest_updated = piezas.aggregate(last_updated=Max('updated_at'))['last_updated']
    search_results_truncated = False
    search_total_matches = None

    if busqueda_global:
        ranking_context = _build_search_context(busqueda_global, search_terms)
        search_total_matches = piezas.count()
        piezas = list(piezas[:_MAX_RANKED_RESULTS])
        search_results_truncated = search_total_matches > len(piezas)

        def _part_timestamp(part_obj):
            value = getattr(part_obj, 'updated_at', None) or getattr(part_obj, 'date_added', None)
            if not value:
                return 0.0
            if timezone.is_naive(value):
                value = timezone.make_aware(value, timezone.get_current_timezone())
            return value.timestamp()

        piezas.sort(
            key=lambda part_obj: (
                _score_part_for_query(part_obj, ranking_context),
                _part_timestamp(part_obj),
                part_obj.id or 0
            ),
            reverse=True
        )
        piezas = _RankedResultBuffer(piezas, search_total_matches or len(piezas))
    paginator = Paginator(piezas, per_page)
    page_number = request.GET.get('page') or 1
    page_obj = paginator.get_page(page_number)
    piezas_pagina = page_obj.object_list

    base_params = request.GET.copy()
    base_params.pop('page', None)
    base_params.pop('append', None)
    base_query = base_params.urlencode()

    next_page_url = ''
    if page_obj.has_next():
        next_params = base_params.copy()
        next_params['page'] = page_obj.next_page_number()
        next_page_query = next_params.urlencode()
        next_page_url = f"{request.path}?{next_page_query}" if next_page_query else request.path

    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' and request.GET.get('append') == '1':
        rows_html = render_to_string('parts/includes/part_table_rows.html', {
            'piezas': piezas_pagina,
        }, request=request)
        cards_html = render_to_string('parts/includes/part_mobile_cards.html', {
            'piezas': piezas_pagina,
        }, request=request)
        return JsonResponse({
            'success': True,
            'rows_html': rows_html,
            'cards_html': cards_html,
            'has_next': page_obj.has_next(),
            'next_url': next_page_url,
            'displayed_count': page_obj.end_index() or 0,
            'total_count': paginator.count,
        })
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest' and request.GET.get('refresh') == '1':
        rows_html = render_to_string('parts/includes/part_table_rows.html', {
            'piezas': piezas_pagina,
        }, request=request)
        cards_html = render_to_string('parts/includes/part_mobile_cards.html', {
            'piezas': piezas_pagina,
        }, request=request)
        return JsonResponse({
            'success': True,
            'rows_html': rows_html,
            'cards_html': cards_html,
            'last_updated': timezone.localtime(latest_updated).isoformat() if latest_updated else '',
            'displayed_count': page_obj.end_index() or 0,
            'total_count': paginator.count,
        })

    talleres = Workshop.objects.order_by('name')
    filtros_partes_abiertos = any([filtro_modelo, filtro_anio, filtro_taller])
    display_start = page_obj.start_index() if paginator.count else 0
    display_end = page_obj.end_index() or 0

    return render(request, 'parts/part_list.html', {
        'piezas': piezas_pagina,
        'modelos_disponibles': modelos_disponibles,
        'anios_disponibles': anios_disponibles,
        'modelo_filtrado': filtro_modelo,
        'anio_filtrado': filtro_anio,
        'talleres_disponibles': talleres,
        'taller_filtrado': filtro_taller,
        'total_piezas': paginator.count,
        'filtros_partes_abiertos': filtros_partes_abiertos,
        'busqueda_global': busqueda_global,
        'page_obj': page_obj,
        'paginator': paginator,
        'load_more_url': next_page_url,
        'displayed_count': display_end,
        'display_start': display_start,
        'display_end': display_end,
        'per_page': per_page,
        'querystring_base': base_query,
        'last_updated': latest_updated,
        'inventory_stats': inventory_stats,
        'search_results_truncated': search_results_truncated,
        'search_total_matches': search_total_matches,
        'search_rank_limit': _MAX_RANKED_RESULTS,
    })


@login_required
def synonym_manager(request):
    profile = getattr(request.user, 'profile', None)
    if not profile or not getattr(profile, 'is_admin', False):
        return _render_admin_denied(request, 'Solo administradores pueden administrar sinónimos.')

    action = request.POST.get('action')
    group_form = SynonymGroupForm(prefix='group')
    term_form = SynonymTermForm(prefix='term')

    if request.method == 'POST':
        if action == 'create_group':
            group_form = SynonymGroupForm(request.POST, prefix='group')
            if group_form.is_valid():
                group_form.save()
                _lookup_synonyms.cache_clear()
                refresh_caches()
                messages.success(request, 'Grupo de sinónimos creado correctamente.')
                return redirect('parts:synonym_manager')
        elif action == 'create_term':
            term_form = SynonymTermForm(request.POST, prefix='term')
            if term_form.is_valid():
                term_form.save()
                _lookup_synonyms.cache_clear()
                refresh_caches()
                messages.success(request, 'Sinónimo agregado con éxito.')
                return redirect('parts:synonym_manager')
        else:
            messages.error(request, 'Acción no reconocida.')

    groups = (
        SynonymGroup.objects.all()
        .prefetch_related('terms')
        .order_by('name')
    )

    stats = {
        'group_count': groups.count(),
        'term_count': SynonymTerm.objects.count(),
    }

    return render(request, 'parts/synonym_manager.html', {
        'group_form': group_form,
        'term_form': term_form,
        'groups': groups,
        'stats': stats,
    })

@login_required
def part_create(request):
    logger = logging.getLogger('parts.views')

    if not _usuario_puede_crear_partes(request.user):
        return _render_admin_denied(request, 'No tienes privilegios para crear piezas.')

    datos_audio = request.session.pop('vehicle_info', None)
    es_ingreso_por_voz = isinstance(datos_audio, dict)

    datos_iniciales = {}
    if es_ingreso_por_voz:
        descripcion_capturada = datos_audio.get('detalles')
        valor_estimado = datos_audio.get('valor')
        ultimo_valor = datos_audio.get('min_value') or valor_estimado
        datos_iniciales = {
            'name': datos_audio.get('parte'),
            'catalog_name': datos_audio.get('catalog_name') or datos_audio.get('parte'),
            'position': datos_audio.get('position'),
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
    if not _usuario_puede_editar_partes(request.user):
        return _render_admin_denied(request, 'No tienes privilegios para editar piezas.')
    pieza = get_object_or_404(Part, pk=pk)
    formulario = PartForm(request.POST or None, request.FILES or None, instance=pieza)
    if formulario.is_valid():
        changed = list(formulario.changed_data)
        pieza = formulario.save()
        if changed:
            Auditoria.pieza_modificada(
                pieza,
                usuario=request.user,
                request=request,
                campos_modificados=changed
            )
        return redirect('parts:part_list')

    return render(request, 'parts/part_form_clean.html', {'form': formulario})


@login_required
def part_delete(request, pk):
    if not _usuario_puede_eliminar_partes(request.user):
        return _render_admin_denied(request, 'No tienes privilegios para eliminar piezas.')
    pieza = get_object_or_404(Part, pk=pk)
    if request.method == 'POST':
        Auditoria.pieza_eliminada(pieza, usuario=request.user, request=request)
        pieza.delete()
        return redirect('parts:part_list')
    return render(request, 'parts/confirm_delete.html', {
        'object': pieza,
        'type': 'Pieza',
        'cancel_url': reverse('parts:part_list')
    })


# -------------------------------
# AJAX ENDPOINTS
# -------------------------------
@login_required
@csrf_protect
@require_POST
def toggle_part_sold(request, pk):
    """Cambia el estado vendido/disponible de una pieza."""
    if not _usuario_puede_marcar_venta(request.user):
        return JsonResponse({'success': False, 'error': 'No tienes permiso para marcar ventas'}, status=403)
    pieza = get_object_or_404(Part, pk=pk)
    pieza.sold = not pieza.sold
    pieza.save()
    if pieza.sold:
        Auditoria.pieza_vendida(pieza, usuario=request.user, request=request)
    else:
        Auditoria.evento(
            categoria='pieza',
            accion='marcar_disponible',
            descripcion=f'Pieza marcada como disponible: {pieza.name} (ID: {pieza.id})',
            usuario=request.user,
            pieza=pieza,
            request=request
        )
    return JsonResponse({'success': True, 'sold': pieza.sold})


@login_required
@csrf_protect
@require_POST
def update_part_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida."""
    if not _usuario_puede_editar_partes(request.user):
        return JsonResponse({'success': False, 'error': 'No autorizado'}, status=403)
    try:
        pieza = get_object_or_404(Part, pk=pk)
        payload = json.loads(request.body or '{}')
        campo = payload.get('field')
        valor = payload.get('value')

        campos_permitidos = ['name', 'catalog_name', 'position', 'details', 'max_value', 'min_value']
        if campo not in campos_permitidos:
            return JsonResponse({'success': False, 'error': 'Campo no editable'}, status=400)

        if campo in ['max_value', 'min_value']:
            if isinstance(valor, str):
                valor = re.sub(r'[^\d-]', '', valor)
            try:
                valor = int(valor)
            except (TypeError, ValueError):
                valor = 0
        elif campo == 'details':
            valor = Part.clean_details_value(valor)

        setattr(pieza, campo, valor)
        pieza.save()
        Auditoria.pieza_modificada(
            pieza,
            usuario=request.user,
            request=request,
            campos_modificados=[campo]
        )
        return JsonResponse({'success': True, 'field': campo, 'value': valor})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)


@login_required
def part_photos_list(request, pk):
    pieza = get_object_or_404(Part, pk=pk)
    fotos = [_serializar_foto_part(foto) for foto in pieza.photos.all()]
    return JsonResponse({'success': True, 'photos': fotos})


@login_required
def part_photos_upload(request, pk):
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=405)

    pieza = get_object_or_404(Part, pk=pk)
    archivos = request.FILES.getlist('photos')
    if not archivos:
        return JsonResponse({'success': False, 'error': 'No se adjuntaron fotos'}, status=400)

    source = (request.POST.get('source') or 'manual')[:50]
    fotos_creadas = []
    errores = 0
    for archivo in archivos:
        try:
            procesada = _procesar_imagen_cuadrada(archivo)
        except ValueError:
            errores += 1
            continue
        foto = PartPhoto(part=pieza, source=source)
        foto.image.save(procesada.name, procesada, save=False)
        foto.save()
        fotos_creadas.append(_serializar_foto_part(foto))

    if not fotos_creadas:
        return JsonResponse({'success': False, 'error': 'No se pudieron procesar las fotos'}, status=400)

    respuesta = {'success': True, 'photos': fotos_creadas}
    if errores:
        respuesta['skipped'] = errores
    return JsonResponse(respuesta, status=201)


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

    period_30_start = timezone.now() - timezone.timedelta(days=30)
    sales_period = Part.objects.filter(sold=True, sold_at__gte=period_30_start)
    revenue_period = sales_period.aggregate(total=Sum('max_value'))['total'] or Decimal('0')
    sold_period_count = sales_period.count()
    avg_ticket = revenue_period / sold_period_count if sold_period_count else Decimal('0')
    sell_through_ratio = (sold_parts / total_parts * 100) if total_parts else 0

    high_value_parts = (
        Part.objects.filter(state=True, sold=False)
        .select_related('auto', 'workshop')
        .order_by('-max_value')[:5]
    )

    slow_threshold = timezone.now() - timezone.timedelta(days=60)
    slow_moving_parts = (
        Part.objects.filter(sold=False, date_added__lt=slow_threshold)
        .select_related('auto', 'workshop')
        .order_by('date_added')[:5]
    )

    top_workshops_raw = (
        Part.objects.filter(state=True, sold=False)
        .values('workshop__name')
        .annotate(total=Sum('max_value'), count=Count('id'))
        .order_by('-total')[:5]
    )
    top_workshops = [
        {
            'name': entry['workshop__name'] or 'Sin taller',
            'count': entry['count'],
            'total': entry['total'] or Decimal('0'),
        }
        for entry in top_workshops_raw
    ]

    top_models_raw = (
        Part.objects.filter(state=True, sold=False)
        .values('auto__brand_model')
        .annotate(total=Sum('max_value'), count=Count('id'))
        .order_by('-total')[:5]
    )
    top_models = [
        {
            'name': entry['auto__brand_model'] or 'Sin vehículo',
            'count': entry['count'],
            'total': entry['total'] or Decimal('0'),
        }
        for entry in top_models_raw
    ]

    recent_voice_sessions = list(
        VoiceSession.objects.order_by('-started_at')[:5].values(
            'session_id', 'started_at', 'status', 'final_count', 'command_count', 'partial_count'
        )
    )

    context = {
        'now': timezone.now(),
        'since_days': since_days,
        # KPI cards
        'total_parts': total_parts,
        'available_parts': available_parts,
        'sold_parts': sold_parts,
        'total_autos': total_autos,
        'total_workshops': total_workshops,
        'mic_configs_count': mic_configs_count,
        'voice_sessions_last': voice_sessions_last,
        'ingests_last': ingests_last,
        'revenue_period': revenue_period,
        'avg_ticket': avg_ticket,
        'sell_through_ratio': round(sell_through_ratio, 1),
        'period_days': 30,
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
        # Insights
        'high_value_parts': high_value_parts,
        'slow_moving_parts': slow_moving_parts,
        'top_workshops': top_workshops,
        'top_models': top_models,
        'recent_voice_sessions': recent_voice_sessions,
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
    q_source = request.GET.get('source', '').strip().lower()
    try:
        limit = max(10, min(2000, int(request.GET.get('limit', '300'))))
    except Exception:
        limit = 300

    User = get_user_model()
    user_qs = User.objects.order_by('username')[:150]
    user_options = []
    for usr in user_qs:
        label = (usr.get_full_name() or usr.username).strip()
        user_options.append({'id': usr.id, 'label': label})

    module_options = _collect_module_suggestions(limit=200)
    session_options = _collect_session_suggestions(limit=200)

    return render(request, 'parts/logs.html', {
        'session_id': q_session,
        'level': q_level,
        'module': q_module,
        'user_id': q_user,
        'source': q_source,
        'limit': limit,
        'user_filter': q_user,
        'user_options': user_options,
        'module_options': module_options,
        'session_options': session_options,
        'level_options': ['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        'audit_categories': EventoSistema.Categoria.choices,
    })


def _build_auto_label(part) -> str:
    auto = getattr(part, 'auto', None)
    if not auto:
        return ''
    brand_model = getattr(auto, 'brand_model', '') or ''
    year = getattr(auto, 'year', '') or ''
    if brand_model and year:
        return f"{brand_model} {year}"
    return brand_model or str(year) or ''


def _serialize_scan_part(part, request) -> dict:
    photos = []
    for photo in part.photos.all():
        try:
            url = photo.image.url
            photos.append(request.build_absolute_uri(url))
        except Exception:
            continue
    updated_at = part.updated_at
    if updated_at:
        updated_at = timezone.localtime(updated_at)
    return {
        'id': part.id,
        'name': part.name,
        'barcode': part.barcode,
        'auto': getattr(part.auto, 'brand_model', '') or '',
        'auto_year': getattr(part.auto, 'year', '') or '',
        'auto_label': _build_auto_label(part),
        'updated_at': updated_at.isoformat() if updated_at else '',
        'photos': photos,
    }


@login_required
def scan_verify_view(request):
    if not Part.objects.exists():
        return redirect('parts:part_list')
    parts_qs = (
        Part.objects.filter(barcode__isnull=False)
        .exclude(barcode='')
        .select_related('auto')
        .prefetch_related('photos')[:60]
    )
    initial_parts = [_serialize_scan_part(part, request) for part in parts_qs]
    initial_parts_payload = json_script(initial_parts, 'scan-initial-parts')
    nonce = getattr(request, 'csp_nonce', '')
    if nonce:
        initial_parts_payload = initial_parts_payload.replace('<script ', f'<script nonce=\"{nonce}\" ', 1)
    context = {
        'initial_parts': initial_parts,
        'initial_parts_payload': mark_safe(initial_parts_payload),
        'mlkit_enabled': True,
    }
    return render(request, 'parts/scan_verify.html', context)


@login_required
def scan_verify_search(request):
    query = request.GET.get('q', '').strip()
    try:
        limit = int(request.GET.get('limit', '30'))
    except (TypeError, ValueError):
        limit = 30
    limit = max(15, min(limit, 400))
    fetch_window = min(limit * 3, 600)
    parts_qs = (
        Part.objects.filter(barcode__isnull=False)
        .exclude(barcode='')
        .select_related('auto')
        .prefetch_related('photos')
    )
    if query:
        filter_terms = _build_filter_terms(query, max_terms=8) or [query]
        condition = Q()
        for term in filter_terms:
            condition |= (
                Q(name__icontains=term) |
                Q(auto__brand_model__icontains=term) |
                Q(barcode__icontains=term)
            )
        parts_qs = parts_qs.filter(condition)
    parts_qs = parts_qs.order_by('-updated_at')[:fetch_window]
    raw_results = list(parts_qs)

    def _score_part(part: Part, normalized_query: str, tokens: list[str], compact_query: str) -> int:
        score = 0
        name_norm = _strip_accents((part.name or '').lower())
        auto_norm = _strip_accents((getattr(part.auto, 'brand_model', '') or '').lower())
        barcode_norm = (part.barcode or '').replace(' ', '').lower()
        if compact_query and barcode_norm == compact_query:
            score += 40
        elif compact_query and barcode_norm.startswith(compact_query):
            score += 25
        if normalized_query and normalized_query in name_norm:
            score += 12
        if normalized_query and normalized_query in auto_norm:
            score += 6
        for token in tokens:
            if not token:
                continue
            if token in name_norm:
                score += 4
            if token in auto_norm:
                score += 2
        prefetched_photos = getattr(part, '_prefetched_objects_cache', {}).get('photos')
        if prefetched_photos:
            score += 1
        return score

    if query:
        normalized_query = _strip_accents(query.lower())
        compact_query = normalized_query.replace(' ', '')
        tokens = [tok for tok in re.split(r'[\s,/+-]+', normalized_query) if tok]
        now_ts = timezone.now().timestamp()

        def sort_key(part: Part):
            score = _score_part(part, normalized_query, tokens, compact_query)
            updated_ts = part.updated_at.timestamp() if part.updated_at else now_ts
            return (score, updated_ts)

        scored = sorted(raw_results, key=sort_key, reverse=True)
    else:
        scored = raw_results

    trimmed = scored[:limit]
    results = [_serialize_scan_part(part, request) for part in trimmed]
    return JsonResponse({'success': True, 'results': results, 'count': len(results)})


@login_required
@require_http_methods(['POST'])
def scan_verify_log(request):
    try:
        payload = json.loads(request.body.decode('utf-8'))
    except Exception:
        payload = {}
    part_id = payload.get('part_id')
    detected = payload.get('detected_barcode', '')
    if not part_id:
        return JsonResponse({'success': False, 'error': 'part_id requerido'}, status=400)
    part = get_object_or_404(Part, pk=part_id)
    status = (payload.get('status') or 'match').lower()
    source = payload.get('source') or 'camera'
    datos = {
        'barcode': part.barcode,
        'detected_barcode': detected,
        'status': status,
        'source': source,
    }
    if status == 'mismatch':
        accion = 'scan_verify_mismatch'
        descripcion = f'Código distinto detectado durante la verificación de {part.name}'
        exito = False
        nivel = EventoSistema.Nivel.WARNING
    else:
        accion = 'scan_verify_match'
        descripcion = f'Pieza verificada por cámara: {part.name}'
        exito = True
        nivel = EventoSistema.Nivel.INFO

    EventoSistema.registrar(
        categoria=EventoSistema.Categoria.PIEZA,
        accion=accion,
        descripcion=descripcion,
        usuario=request.user,
        pieza=part,
        datos=datos,
        exito=exito,
        nivel=nivel,
    )
    return JsonResponse({'success': True})


@login_required
@require_http_methods(['POST'])
def scan_verify_mlkit(request):
    def _parse_payload():
        upload = request.FILES.get('image')
        payload_body = {}
        image_bytes_local = None
        if upload:
            image_bytes_local = upload.read()
        else:
            if request.body:
                try:
                    payload_body = json.loads(request.body.decode('utf-8'))
                except ValueError:
                    payload_body = {}
            image_value = payload_body.get('image')
            if isinstance(image_value, str) and image_value:
                try:
                    if ',' in image_value:
                        image_value = image_value.split(',', 1)[1]
                    image_bytes_local = base64.b64decode(image_value)
                except (ValueError, TypeError) as exc:
                    scanner_logger.warning('scan-detect:invalid-image user=%s error=%s', request.user.id, exc)
        return upload, payload_body, image_bytes_local

    upload, payload, image_bytes = _parse_payload()
    if not image_bytes:
        return JsonResponse({'success': False, 'error': 'Imagen requerida'}, status=400)

    form_data = request.POST or request.GET
    reason = form_data.get('reason') or (payload.get('reason') if not upload else None) or 'fallback'
    part_id = form_data.get('part_id') or (payload.get('part_id') if not upload else None)
    brightness = form_data.get('brightness') or (payload.get('brightness') if not upload else None)
    video_width = form_data.get('video_width') or (payload.get('video_width') if not upload else None)
    video_height = form_data.get('video_height') or (payload.get('video_height') if not upload else None)

    def normalize_payload(results):
        normalized = []
        for item in results:
            raw_value = item.get('raw_value') or item.get('rawValue') or item.get('display_value') or ''
            if not raw_value:
                continue
            normalized.append({
                'raw_value': raw_value,
                'display_value': item.get('display_value') or raw_value,
                'format': item.get('format') or '',
                'confidence': item.get('confidence'),
                'bounding_box': item.get('bounding_box') or {},
                'corner_points': item.get('corner_points') or [],
            })
        return normalized

    def detect_remote():
        encoded_image = base64.b64encode(image_bytes).decode('ascii')
        upstream_payload = {
            'image_base64': encoded_image,
            'min_confidence': settings.FIREBASE_MLKIT_MIN_CONFIDENCE,
            'metadata': {
                'reason': reason,
                'part_id': part_id,
                'brightness': brightness,
                'video': {
                    'width': video_width,
                    'height': video_height,
                },
                'user_id': request.user.id,
                'username': getattr(request.user, 'username', ''),
            },
        }
        headers = {
            'Authorization': f'Bearer {settings.FIREBASE_MLKIT_API_KEY}',
            'Content-Type': 'application/json',
            'User-Agent': 'car-inventory/mlkit-proxy',
        }
        try:
            resp = requests.post(
                settings.FIREBASE_MLKIT_BARCODE_URL,
                json=upstream_payload,
                timeout=settings.FIREBASE_MLKIT_TIMEOUT,
                headers=headers,
            )
            resp.raise_for_status()
            upstream_data = resp.json()
        except requests.RequestException as exc:
            scanner_logger.warning('scan-mlkit:remote-error user=%s reason=%s err=%s', request.user.id, reason, exc)
            return []
        except ValueError:
            scanner_logger.warning('scan-mlkit:remote-invalid-json user=%s reason=%s', request.user.id, reason)
            return []

        raw_results = upstream_data.get('barcodes') or upstream_data.get('results') or []
        filtered = []
        for item in raw_results:
            confidence = item.get('confidence')
            try:
                confidence = float(confidence) if confidence is not None else None
            except (TypeError, ValueError):
                confidence = None
            if confidence is not None and confidence < settings.FIREBASE_MLKIT_MIN_CONFIDENCE:
                continue
            filtered.append({
                'raw_value': (
                    item.get('rawValue')
                    or item.get('raw_value')
                    or item.get('displayValue')
                    or item.get('display_value')
                    or ''
                ),
                'display_value': item.get('displayValue') or item.get('display_value') or '',
                'format': item.get('format') or item.get('type') or '',
                'confidence': confidence,
                'bounding_box': item.get('boundingBox') or item.get('bounding_box') or {},
                'corner_points': item.get('cornerPoints') or item.get('corner_points') or [],
            })
        if filtered:
            scanner_logger.info(
                'scan-mlkit:remote-success user=%s reason=%s part=%s count=%s',
                request.user.id,
                reason,
                part_id,
                len(filtered),
            )
        else:
            scanner_logger.info(
                'scan-mlkit:remote-empty user=%s reason=%s part=%s brightness=%s video=%sx%s',
                request.user.id,
                reason,
                part_id,
                brightness,
                video_width,
                video_height,
            )
        return filtered

    def _points_to_box(points):
        if not points:
            return None
        xs = [p['x'] for p in points]
        ys = [p['y'] for p in points]
        return {
            'x': min(xs),
            'y': min(ys),
            'width': max(xs) - min(xs),
            'height': max(ys) - min(ys),
        }

    def detect_local():
        try:
            results = detect_barcodes(image_bytes)
        except LocalBarcodeDetectorError as exc:
            scanner_logger.error('scan-mlkit:local-error user=%s detail=%s', request.user.id, exc)
            return []
        normalized_local = []
        for item in results:
            box = _points_to_box(item.points) if item.points else None
            normalized_local.append({
                'raw_value': item.raw_value,
                'display_value': item.raw_value,
                'format': item.format,
                'confidence': item.confidence,
                'bounding_box': box or {},
                'corner_points': item.points or [],
            })
        if normalized_local:
            scanner_logger.info(
                'scan-mlkit:local-success user=%s reason=%s part=%s count=%s',
                request.user.id,
                reason,
                part_id,
                len(normalized_local),
            )
        else:
            scanner_logger.info(
                'scan-mlkit:local-empty user=%s reason=%s part=%s brightness=%s video=%sx%s',
                request.user.id,
                reason,
                part_id,
                brightness,
                video_width,
                video_height,
            )
        return normalized_local

    detections = []
    if settings.FIREBASE_MLKIT_ENABLED:
        detections = normalize_payload(detect_remote())
    if not detections:
        detections = normalize_payload(detect_local())

    return JsonResponse({'success': True, 'results': detections})


@login_required
def parts_catalog_cache(request):
    """Entrega un snapshot ligero del inventario para búsquedas locales."""
    limit_param = request.GET.get('limit')
    try:
        requested_limit = int(limit_param) if limit_param else 6000
    except (TypeError, ValueError):
        requested_limit = 6000
    limit = max(500, min(10000, requested_limit))
    boot_logger.info(
        "parts_catalog_cache:start user=%s limit=%s path=%s",
        getattr(request.user, 'id', None),
        limit,
        request.path
    )

    qs = (
        Part.objects
        .select_related('auto', 'workshop')
        .order_by('-updated_at')[:limit]
    )

    payload = []
    latest_updated = None
    for part in qs:
        updated_at = part.updated_at
        if updated_at and (latest_updated is None or updated_at > latest_updated):
            latest_updated = updated_at
        payload.append({
            'id': part.id,
            'name': part.name,
            'status': part.availability_status,
            'barcode': part.barcode or '',
            'auto': getattr(part.auto, 'brand_model', '') or '',
            'workshop': getattr(part.workshop, 'name', '') or '',
        })

    version = (latest_updated or timezone.now()).isoformat()
    response = JsonResponse({
        'success': True,
        'version': version,
        'server_time': timezone.now().isoformat(),
        'count': len(payload),
        'parts': payload,
    })
    response['Cache-Control'] = 'no-store'
    boot_logger.info(
        "parts_catalog_cache:ready user=%s count=%s version=%s",
        getattr(request.user, 'id', None),
        len(payload),
        version
    )
    return response


@login_required
def logs_api(request):
    if not _usuario_es_admin(request.user):
        return JsonResponse({'success': False, 'error': 'Solo administrador'}, status=403)

    q_session = request.GET.get('session_id', '').strip()
    q_level = request.GET.get('level', '').strip().upper()
    q_module = request.GET.get('module', '').strip()
    q_user = request.GET.get('user_id', '').strip()
    q_source = request.GET.get('source', '').strip().lower()
    try:
        limit = max(10, min(2000, int(request.GET.get('limit', '300'))))
    except Exception:
        limit = 300

    sources = _get_log_sources()

    def matches_user(obj, query: str) -> bool:
        if not query:
            return True
        normalized = query.strip().lower()
        tokens = [normalized]
        for sep in ('|', ',', '-', '/'):
            if sep in normalized:
                tokens.extend(part.strip() for part in normalized.split(sep))
        tokens = [tok for tok in tokens if tok]
        meta = obj.get('meta') or {}
        datos = obj.get('datos') or {}
        id_candidates = {
            str(value).strip().lower()
            for value in (
                obj.get('user_id'),
                obj.get('usuario_id'),
                meta.get('user_id'),
                meta.get('usuario_id'),
                datos.get('user_id'),
                datos.get('usuario_id')
            )
            if value not in (None, '')
        }
        label_candidates = {
            str(value).strip().lower()
            for value in (
                obj.get('usuario'),
                obj.get('usuario_nombre'),
                obj.get('user'),
                obj.get('username'),
                obj.get('operator'),
                meta.get('user'),
                meta.get('user_label'),
                meta.get('usuario'),
                meta.get('operator'),
                datos.get('usuario'),
                datos.get('user_label'),
                datos.get('operator')
            )
            if isinstance(value, str) and value.strip()
        }
        for token in tokens:
            if not token:
                continue
            if token in id_candidates:
                return True
            if token.isdigit() and token in id_candidates:
                return True
            if any(token in label for label in label_candidates):
                return True
        return False

    def matches_session(obj, query: str) -> bool:
        if not query:
            return True
        session_val = str(
            obj.get('session_id') or
            obj.get('session') or
            obj.get('meta', {}).get('session_id') or ''
        ).strip().lower()
        return query.strip().lower() in session_val if session_val else False

    records = []
    for source_name, file_path in sources:
        if not file_path.exists():
            continue
        backlog_size = max(limit * 6, 2000)
        dq = deque(maxlen=backlog_size)
        try:
            with open(file_path, 'r', encoding='utf-8') as handler:
                for line in handler:
                    dq.append(line)
        except Exception as exc:
            return JsonResponse({'success': False, 'error': str(exc)}, status=500)

        for raw in dq:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            obj['source'] = source_name
            obj['_ts'] = _parse_log_timestamp(
                obj.get('asctime') or obj.get('created') or obj.get('timestamp')
            )
            records.append(obj)

    filtered = []
    for obj in records:
        if q_source and obj['source'] != q_source:
            continue
        if q_session and not matches_session(obj, q_session):
            continue
        level = (obj.get('levelname') or obj.get('level') or '').upper()
        if q_level and level != q_level:
            continue
        if q_module:
            hay = ' '.join(
                str(obj.get(key) or '')
                for key in ('name', 'module', 'event', 'accion', 'message')
            ).lower()
            if q_module.strip().lower() not in hay:
                continue
        if q_user and not matches_user(obj, q_user):
            continue
        filtered.append(obj)

    filtered.sort(key=lambda item: item.get('_ts') or datetime.min, reverse=True)
    total_filtered = len(filtered)
    sliced = filtered[:limit]
    source_counts = Counter([item['source'] for item in filtered])
    error_count = sum(
        1 for item in filtered
        if (item.get('levelname') or '').upper() in {'ERROR', 'WARNING', 'CRITICAL'}
    )
    latest_ts = sliced[0].get('_ts') if sliced else None
    latest_label = latest_ts.strftime('%d-%m-%Y %H:%M:%S') if latest_ts else ''

    for item in sliced:
        item.pop('_ts', None)

    meta = {
        'total': total_filtered,
        'returned': len(sliced),
        'error_count': error_count,
        'source_counts': dict(source_counts),
        'latest_label': latest_label
    }

    return JsonResponse({'success': True, 'count': len(sliced), 'logs': sliced, 'meta': meta})


@login_required
def logs_audit_api(request):
    if not _usuario_es_admin(request.user):
        return JsonResponse({'success': False, 'error': 'Solo administrador'}, status=403)

    q_corr = request.GET.get('correlation_id', '').strip()
    q_req = request.GET.get('request_id', '').strip()
    q_user = request.GET.get('user_id', '').strip()
    q_categoria = request.GET.get('categoria', '').strip()
    q_pieza = request.GET.get('pieza_id', '').strip()
    try:
        limit = max(10, min(1000, int(request.GET.get('limit', '200'))))
    except Exception:
        limit = 200

    qs = EventoSistema.objects.select_related('usuario', 'pieza').all()
    if q_corr:
        qs = qs.filter(correlation_id=q_corr)
    if q_req:
        qs = qs.filter(request_id=q_req)
    if q_user:
        qs = qs.filter(usuario__id=q_user)
    if q_categoria:
        qs = qs.filter(categoria=q_categoria)
    if q_pieza:
        qs = qs.filter(pieza__id=q_pieza)

    eventos = list(qs.order_by('-timestamp')[:limit])
    data = []
    for ev in eventos:
        data.append({
            'id': ev.id,
            'timestamp': ev.timestamp.isoformat(),
            'categoria': ev.categoria,
            'accion': ev.accion,
            'descripcion': ev.descripcion,
            'nivel': ev.nivel,
            'usuario_id': ev.usuario_id,
            'usuario': str(ev.usuario) if ev.usuario else None,
            'pieza_id': ev.pieza_id,
            'pieza': str(ev.pieza) if ev.pieza else None,
            'sesion_voz_id': ev.sesion_voz_id,
            'datos': ev.datos,
            'exito': ev.exito,
            'error_mensaje': ev.error_mensaje,
            'duracion_ms': ev.duracion_ms,
            'request_id': ev.request_id,
            'correlation_id': ev.correlation_id,
            'ip_origen': ev.ip_origen,
            'user_agent': ev.user_agent,
            'parent_id': ev.parent_id,
        })

    return JsonResponse({'success': True, 'events': data})


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


def _build_publish_ai_description(part: Part) -> str:
    auto = getattr(part, 'auto', None)
    workshop = getattr(part, 'workshop', None)
    auto_desc = ''
    if auto:
        brand = (auto.brand_model or '').strip()
        year = str(auto.year or '').strip()
        auto_desc = f"{brand} {year}".strip()
    price_line = _format_clp(part.max_value or part.min_value)
    detail = part.details_display or ''
    observations = part.parsed_details.get('observations') if hasattr(part, 'parsed_details') else ''
    intro = detail or observations or 'Repuesto revisado y listo para instalar, probamos antes de entregar.'
    bullets = [
        f"• Compatible con {auto_desc or 'modelos confirmados en taller'}",
        f"• Ubicación: {workshop.name if workshop else 'Taller por confirmar'}",
        f"• Precio referencial: {price_line}",
    ]
    if part.position:
        bullets.append(f"• Posición / lado: {part.position.title()}")
    if part.catalog_name and part.catalog_name.strip().upper() != (part.name or '').strip().upper():
        bullets.append(f"• Catálogo original: {part.catalog_name.title()}")
    status = "Disponible y probado" if (part.state and not part.sold) else "En revisión en taller"
    headline = f"{part.name.title()} · {auto_desc}".strip(' ·')
    body_lines = [
        headline,
        status,
        '',
        intro,
        '',
        'Puntos clave:',
        *bullets,
        '',
        'Coordinamos retiro o despacho rápido por WhatsApp. Pruebas y asesoría al momento de la entrega.'
    ]
    return "\n".join(line for line in body_lines if line is not None).strip()


@login_required
def part_publish_helper(request, pk):
    if not _usuario_es_admin(request.user):
        return _render_admin_denied(request, 'Solo el administrador puede usar el asistente.')

    queryset = Part.objects.select_related('auto', 'workshop').prefetch_related('photos')

    search = (request.GET.get('buscar') or '').strip()
    estado_param = (request.GET.get('estado') or '').strip()
    estado = estado_param or 'disponible'
    estado_automatico = not bool(estado_param)
    taller = (request.GET.get('taller') or '').strip()
    modelo = (request.GET.get('modelo') or '').strip()
    anio = (request.GET.get('anio') or '').strip()

    filtros_dict = {
        'buscar': search,
        'estado': estado,
        'taller': taller,
        'modelo': modelo,
        'anio': anio,
    }
    query_raw = request.META.get('QUERY_STRING', '')
    query_suffix = f'?{query_raw}' if query_raw else ''

    if search:
        for term in search.lower().split():
            queryset = queryset.filter(
                Q(name__icontains=term) |
                Q(details__icontains=term) |
                Q(auto__brand_model__icontains=term) |
                Q(auto__license_plate__icontains=term) |
                Q(workshop__name__icontains=term)
            )
    if estado == 'disponible':
        queryset = queryset.filter(sold=False)
    elif estado == 'vendido':
        queryset = queryset.filter(sold=True)
    if taller:
        queryset = queryset.filter(workshop__name=taller)
    if modelo:
        queryset = queryset.filter(auto__brand_model=modelo)
    if anio:
        queryset = queryset.filter(auto__year=anio)

    queryset = queryset.order_by('-date_added', '-id')
    ids = list(queryset.values_list('id', flat=True))
    filter_options = _get_publish_filter_context()

    def _is_active_filter(item):
        key, value = item
        if not value:
            return False
        if key == 'estado' and value == 'disponible' and not estado_param:
            return False
        return True

    active_filters = sum(1 for item in filtros_dict.items() if _is_active_filter(item))

    if not ids:
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
            'contact_line': getattr(settings, 'PUBLISH_CONTACT_LINE', 'Escríbenos para coordinar entrega en el taller.'),
            'missing_data': ['No hay repuestos que coincidan con los filtros'],
            'photo_urls': [],
            'filters': filtros_dict,
            'filters_active': active_filters > 0,
            'filters_count': active_filters,
            'filtros_contexto': filter_options,
            'current_part_id': pk,
            'clean_url': reverse('parts:part_publish_root'),
            'query_string': query_suffix,
            'estado_automatico': estado_automatico,
        })

    if pk not in ids:
        pk = ids[0]

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

    photo_urls = [photo.image.url for photo in part.photos.all() if photo.image]

    missing = []
    if not photo_urls and not part.image:
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
        'photo_urls': photo_urls,
        'filters': filtros_dict,
        'filters_active': active_filters > 0,
        'filters_count': active_filters,
        'filtros_contexto': filter_options,
        'current_part_id': pk,
        'clean_url': reverse('parts:part_publish', args=[pk]),
        'query_string': query_suffix,
        'estado_automatico': estado_automatico,
    })


@login_required
def part_publish_ai_description(request, pk):
    if request.method != 'POST':
        return JsonResponse({'success': False, 'error': 'Método inválido'}, status=405)
    if not _usuario_es_admin(request.user):
        return JsonResponse({'success': False, 'error': 'Acceso restringido'}, status=403)
    part = get_object_or_404(
        Part.objects.select_related('auto', 'workshop'),
        pk=pk
    )
    suggestion = _build_publish_ai_description(part)
    return JsonResponse({'success': True, 'text': suggestion})


@login_required
def dashboard_stats(request):
    """JSON para dashboard interactivo: semanal, mensual y especiales.

    Nota: "vendidas" se estima con sold=True agrupado por date_added (hasta agregar sold_at).
    """
    from collections import Counter
    tz = timezone.get_current_timezone()

    days = int(request.GET.get('days', '30'))
    weeks = int(request.GET.get('weeks', '12'))
    months = int(request.GET.get('months', '12'))
    years = int(request.GET.get('years', '5'))

    now = timezone.now()
    today = now.date()

    # Ejes diarios últimos N días
    day_axis = [today - timezone.timedelta(days=days - i - 1) for i in range(days)]

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

    added_by_day = Counter()
    sold_by_day = Counter()
    added_by_month = Counter()
    sold_by_month = Counter()
    added_by_year = Counter()
    sold_by_year = Counter()
    for p in parts_all:
        dt = p.date_added.astimezone(tz) if hasattr(p.date_added, 'astimezone') else p.date_added
        d_key = dt.date()
        mk = month_key(dt)
        added_by_day[d_key] += 1
        added_by_month[mk] += 1
        added_by_year[dt.year] += 1
        if p.sold:
            # Preferir sold_at si existe; fallback a date_added
            sdt = getattr(p, 'sold_at', None) or dt
            if hasattr(sdt, 'astimezone'):
                sdt = sdt.astimezone(tz)
            sold_date = sdt.date()
            mk_s = month_key(sdt)
            sold_by_day[sold_date] += 1
            sold_by_month[mk_s] += 1
            sold_by_year[sold_date.year] += 1

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
    recent_sales_by_workshop = C2()
    recent_cutoff = today - timezone.timedelta(days=30)
    sales_by_year = C2()
    for p in available:
        model_name = getattr(getattr(p, 'auto', None), 'brand_model', None) or 'Desconocido'
        parts_by_model[model_name] += 1
        try:
            avg_price = (float(p.max_value or 0) + float(p.min_value or 0)) / 2.0
        except Exception:
            avg_price = 0.0
        value_sum_by_model[model_name] += avg_price
    for p in parts_all:
        if p.sold:
            sdt = getattr(p, 'sold_at', None) or p.date_added
            sold_date = sdt.date() if hasattr(sdt, 'date') else sdt
            ws_name = getattr(getattr(p, 'workshop', None), 'name', None) or 'Desconocido'
            if sold_date >= recent_cutoff:
                recent_sales_by_workshop[ws_name] += 1
            sales_by_year[sold_date.year] += 1

    # Ordenar especiales desc
    ws_sorted = sorted(available_by_workshop.items(), key=lambda x: x[1], reverse=True)
    mdl_sorted_count = sorted(parts_by_model.items(), key=lambda x: x[1], reverse=True)
    mdl_sorted_value = sorted(value_sum_by_model.items(), key=lambda x: x[1], reverse=True)
    recent_sorted = sorted(recent_sales_by_workshop.items(), key=lambda x: x[1], reverse=True)
    sales_year_sorted = sorted(sales_by_year.items(), key=lambda x: x[0])

    day_labels = [d.strftime('%d %b') for d in day_axis]
    daily_data = {
        'axis': day_labels,
        'sold': [int(sold_by_day.get(day, 0)) for day in day_axis],
        'added': [int(added_by_day.get(day, 0)) for day in day_axis],
    }

    year_axis = [today.year - years + 1 + i for i in range(years)]
    yearly_data = {
        'axis': [str(y) for y in year_axis],
        'sold': [int(sold_by_year.get(y, 0)) for y in year_axis],
        'added': [int(added_by_year.get(y, 0)) for y in year_axis],
    }

    data = {
        'daily': daily_data,
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
        'yearly': yearly_data,
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
            },
            'recent_sales_by_workshop': {
                'labels': [k for k, _ in recent_sorted],
                'values': [int(v) for _, v in recent_sorted],
            },
            'sales_all_time': {
                'labels': [str(k) for k, _ in sales_year_sorted],
                'values': [int(v) for _, v in sales_year_sorted],
            },
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

    base_params = request.GET.copy()
    base_params.pop('orden', None)

    def _build_sort_url(value):
        params = base_params.copy()
        if value:
            params['orden'] = value
        else:
            params.pop('orden', None)
        query = params.urlencode()
        return f"{request.path}?{query}" if query else request.path

    sort_urls = {
        'year_desc': _build_sort_url('-year'),
        'year_asc': _build_sort_url('year'),
        'inventory_desc': _build_sort_url('-parts_total'),
        'inventory_asc': _build_sort_url('parts_total'),
        'date_desc': _build_sort_url('-date_added'),
        'date_asc': _build_sort_url('date_added'),
    }

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
        'sort_urls': sort_urls,
    })

@login_required
def auto_create(request):
    formulario = AutoForm(request.POST or None)
    if formulario.is_valid():
        auto = formulario.save()
        Auditoria.evento(
            categoria='auto',
            accion='crear_auto',
            descripcion=f'Auto creado: {auto}',
            usuario=request.user,
            datos={
                'auto_id': auto.id,
                'brand_model': auto.brand_model,
                'year': auto.year,
                'color': auto.color,
                'license_plate': auto.license_plate
            },
            request=request
        )
        messages.success(request, 'Vehículo guardado correctamente.')
        return redirect('parts:auto_list')
    return render(request, 'parts/auto_form.html', {'form': formulario})

@login_required
def auto_edit(request, pk):
    auto = get_object_or_404(Auto, pk=pk)
    formulario = AutoForm(request.POST or None, instance=auto)
    if formulario.is_valid():
        changed = list(formulario.changed_data)
        auto = formulario.save()
        if changed:
            Auditoria.evento(
                categoria='auto',
                accion='modificar_auto',
                descripcion=f'Auto modificado: {auto}',
                usuario=request.user,
                datos={'auto_id': auto.id, 'campos_modificados': changed},
                request=request
            )
        messages.success(request, 'Vehículo actualizado correctamente.')
        return redirect('parts:auto_list')
    return render(request, 'parts/auto_form.html', {'form': formulario})

@login_required
def auto_delete(request, pk):
    auto_obj = get_object_or_404(Auto, pk=pk)
    related_parts = list(auto_obj.parts.select_related('workshop', 'auto'))
    if request.method == 'POST':
        part_action = request.POST.get('part_action', 'reassign')
        if related_parts:
            if part_action == 'delete':
                for part in related_parts:
                    Auditoria.pieza_eliminada(part, usuario=request.user, request=request)
                    part.delete()
            else:
                placeholder_auto = _get_placeholder_auto()
                for part in related_parts:
                    part.auto = placeholder_auto
                    part.save(update_fields=['auto'])
                    Auditoria.evento(
                        categoria='pieza',
                        accion='reasignar_auto',
                        descripcion=f'Pieza {part.id} reasignada a {placeholder_auto}',
                        usuario=request.user,
                        datos={'pieza_id': part.id, 'nuevo_auto_id': placeholder_auto.id},
                        request=request
                    )
        Auditoria.evento(
            categoria='auto',
            accion='eliminar_auto',
            descripcion=f'Auto eliminado: {auto_obj}',
            nivel='warning',
            usuario=request.user,
            datos={'auto_id': auto_obj.id, 'brand_model': auto_obj.brand_model},
            request=request
        )
        auto_obj.delete()
        return redirect('parts:auto_list')
    return render(request, 'parts/confirm_delete.html', {
        'object': auto_obj,
        'type': 'Auto',
        'cancel_url': reverse('parts:auto_list'),
        'related_parts': related_parts,
        'placeholder_label': 'Sin vehículo',
        'placeholder_description': 'Las piezas seguirán activas pero sin un vehículo asociado hasta que se reasignen.',
    })

@login_required
@csrf_protect
@require_POST
def update_auto_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida de autos."""
    if not _usuario_puede_editar_partes(request.user):
        return JsonResponse({'success': False, 'error': 'No autorizado'}, status=403)
    try:
        auto = get_object_or_404(Auto, pk=pk)
        payload = json.loads(request.body or '{}')
        campo = payload.get('field')
        valor = payload.get('value')

        campos_permitidos = ['brand_model', 'year', 'color', 'license_plate', 'notes']
        if campo not in campos_permitidos:
            return JsonResponse({'success': False, 'error': 'Campo no editable'}, status=400)

        if campo == 'year':
            valor = int(valor) if valor else None
        elif campo == 'notes':
            if valor is None:
                valor = None
            else:
                valor = str(valor)
                if not valor.strip():
                    valor = None
                else:
                    max_len = Auto._meta.get_field('notes').max_length
                    valor = valor[:max_len]

        setattr(auto, campo, valor)
        auto.save()
        Auditoria.evento(
            categoria='auto',
            accion='actualizar_campo',
            descripcion=f'Auto {auto.id}: campo {campo} actualizado',
            usuario=request.user,
            datos={'auto_id': auto.id, 'campo': campo, 'valor': valor},
            request=request
        )

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

    base_params = request.GET.copy()
    base_params.pop('orden', None)

    def _build_sort_url(value):
        params = base_params.copy()
        if value:
            params['orden'] = value
        else:
            params.pop('orden', None)
        query = params.urlencode()
        return f"{request.path}?{query}" if query else request.path

    sort_urls = {
        'id_desc': _build_sort_url('-id'),
        'id_asc': _build_sort_url('id'),
        'name_desc': _build_sort_url('-name'),
        'name_asc': _build_sort_url('name'),
        'direction_desc': _build_sort_url('-direction'),
        'direction_asc': _build_sort_url('direction'),
        'inventory_desc': _build_sort_url('-parts_total'),
        'inventory_asc': _build_sort_url('parts_total'),
    }

    return render(request, 'parts/workshop_list.html', {
        'talleres': talleres,
        'orden_activo': orden_param,
        'orden_label': orden_labels.get(orden_param),
        'busqueda_actual': busqueda,
        'inventario_filtrado': inventario_filtro,
        'total_talleres': talleres.count(),
        'filtros_talleres_abiertos': bool(request.GET),
        'sort_urls': sort_urls,
    })

@login_required
def workshop_create(request):
    formulario = WorkshopForm(request.POST or None)
    if formulario.is_valid():
        taller = formulario.save()
        Auditoria.evento(
            categoria='taller',
            accion='crear_taller',
            descripcion=f'Taller creado: {taller.name}',
            usuario=request.user,
            datos={'workshop_id': taller.id, 'direction': taller.direction},
            request=request
        )
        messages.success(request, 'Ubicación registrada correctamente.')
        return redirect('parts:workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': formulario})

@login_required
def workshop_edit(request, pk):
    taller = get_object_or_404(Workshop, pk=pk)
    formulario = WorkshopForm(request.POST or None, instance=taller)
    if formulario.is_valid():
        changed = list(formulario.changed_data)
        taller = formulario.save()
        if changed:
            Auditoria.evento(
                categoria='taller',
                accion='modificar_taller',
                descripcion=f'Taller modificado: {taller.name}',
                usuario=request.user,
                datos={'workshop_id': taller.id, 'campos_modificados': changed},
                request=request
            )
        messages.success(request, 'Ubicación actualizada correctamente.')
        return redirect('parts:workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': formulario})

@login_required
def workshop_delete(request, pk):
    taller = get_object_or_404(Workshop, pk=pk)
    related_parts = list(taller.parts.select_related('auto', 'workshop'))
    if request.method == 'POST':
        part_action = request.POST.get('part_action', 'reassign')
        if related_parts:
            if part_action == 'delete':
                for part in related_parts:
                    Auditoria.pieza_eliminada(part, usuario=request.user, request=request)
                    part.delete()
            else:
                placeholder_ws = _get_placeholder_workshop()
                for part in related_parts:
                    part.workshop = placeholder_ws
                    part.save(update_fields=['workshop'])
                    Auditoria.evento(
                        categoria='pieza',
                        accion='reasignar_taller',
                        descripcion=f'Pieza {part.id} reasignada a {placeholder_ws.name}',
                        usuario=request.user,
                        datos={'pieza_id': part.id, 'nuevo_taller_id': placeholder_ws.id},
                        request=request
                    )
        Auditoria.evento(
            categoria='taller',
            accion='eliminar_taller',
            descripcion=f'Taller eliminado: {taller.name}',
            nivel='warning',
            usuario=request.user,
            datos={'workshop_id': taller.id},
            request=request
        )
        taller.delete()
        return redirect('parts:workshop_list')
    return render(request, 'parts/confirm_delete.html', {
        'object': taller,
        'type': 'Workshop',
        'cancel_url': reverse('parts:workshop_list'),
        'related_parts': related_parts,
        'placeholder_label': 'Sin taller',
        'placeholder_description': 'Las piezas permanecerán en inventario hasta que se asignen a un nuevo taller.',
    })

@login_required
@csrf_protect
@require_POST
def update_workshop_field(request, pk):
    """Permite editar un solo campo editable desde la tabla rápida de talleres."""
    if not _usuario_puede_editar_partes(request.user):
        return JsonResponse({'success': False, 'error': 'No autorizado'}, status=403)
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
        Auditoria.evento(
            categoria='taller',
            accion='actualizar_campo',
            descripcion=f'Taller {workshop.id}: campo {campo} actualizado',
            usuario=request.user,
            datos={'workshop_id': workshop.id, 'campo': campo, 'valor': valor},
            request=request
        )

        return JsonResponse({'success': True, 'field': campo, 'value': valor})
    except Exception as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=500)

@login_required
@csrf_protect
@require_POST
def upload_audio(request):
    ensure_voice_ingest_permission(request.user)
    if 'audio' not in request.FILES:
        return JsonResponse({"error": "No audio uploaded"}, status=400)

    audio_file = request.FILES['audio']
    
    # Check file size (limit to 10MB to prevent memory issues)
    max_size = 10 * 1024 * 1024  # 10MB
    if audio_file.size > max_size:
        return JsonResponse({
            "error": f"Audio demasiado largo. Máximo {max_size // (1024*1024)}MB. Intenta grabar un audio más corto."
        }, status=400)

    # 1) Save uploaded browser audio (usually webm/opus)
    temp_files = []
    with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_in:
        for chunk in audio_file.chunks():
            tmp_in.write(chunk)
        in_path = tmp_in.name
        temp_files.append(in_path)

    # 2) Convert to 16-bit PCM WAV @ 16 kHz mono (what whisper-cli expects)
    wav_path = in_path + ".wav"
    temp_files.append(wav_path)

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
        temp_files.append(clean_wav_path)
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

    try:
        response = JsonResponse({
            "transcription": out,
            "vehicle_info": vehicle
        }, json_dumps_params={'ensure_ascii': False})
        response['Content-Type'] = 'application/json; charset=utf-8'
        return response
    finally:
        for tmp_file in temp_files:
            if tmp_file and os.path.exists(tmp_file):
                with contextlib.suppress(OSError):
                    os.unlink(tmp_file)


@login_required
@csrf_protect
@require_POST
def generate_tts(request):
    """Generate TTS audio for confirmation message"""
    
    ensure_voice_ingest_permission(request.user)
    
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
        audio_data = generate_tts_with_openai(text, usuario_id=str(request.user.id))
        
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
SCHEMA_KEYS = ("parte", "catalog_name", "position", "valor", "min_value", "detalles")

POSITION_CANONICAL_ORDER = [
    "Delantera",
    "Trasera",
    "Izquierda",
    "Derecha",
    "Superior",
    "Inferior",
    "Exterior",
    "Interior",
    "Central",
]

POSITION_PATTERNS = [
    (r"\bdelanter[oa]\b", "Delantera"),
    (r"\bfront(?:al)?\b", "Delantera"),
    (r"\btraser[oa]\b", "Trasera"),
    (r"\bposterior\b", "Trasera"),
    (r"\bizquierd[oa]\b", "Izquierda"),
    (r"\blado\s+izquierd[oa]\b", "Izquierda"),
    (r"\blh\b", "Izquierda"),
    (r"\bderech[oa]\b", "Derecha"),
    (r"\blado\s+derech[oa]\b", "Derecha"),
    (r"\brh\b", "Derecha"),
    (r"\bsuperior\b", "Superior"),
    (r"\binferior\b", "Inferior"),
    (r"\bextern[oa]\b", "Exterior"),
    (r"\bintern[oa]\b", "Interior"),
    (r"\bcentral\b", "Central"),
]


def _normalize_whitespace(value: str) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _order_positions(labels):
    ordered = []
    for label in POSITION_CANONICAL_ORDER:
        if label in labels and label not in ordered:
            ordered.append(label)
    for label in labels:
        if label not in ordered:
            ordered.append(label)
    return ordered


def _guess_catalog_and_positions(raw_text: str):
    base = _normalize_whitespace(raw_text)
    if not base:
        return "", []

    working = base
    detected = []
    for pattern, label in POSITION_PATTERNS:
        if re.search(pattern, working, flags=re.IGNORECASE):
            detected.append(label)
            working = re.sub(pattern, " ", working, flags=re.IGNORECASE)
    working = re.sub(r"\blado\b", " ", working, flags=re.IGNORECASE)
    working = _normalize_whitespace(working)
    ordered = _order_positions(detected)
    return working or base, ordered


def _format_position_value(value: str) -> str:
    normalized = _normalize_whitespace(value)
    if not normalized:
        return ""
    return normalized.title()


def _enrich_ingest_schema(clean: dict) -> dict:
    """Completa catalog_name y position a partir del texto capturado."""
    base_source = clean.get("parte") or clean.get("catalog_name") or ""
    catalog_guess, tokens = _guess_catalog_and_positions(base_source)

    existing_catalog = _normalize_whitespace(clean.get("catalog_name"))
    if catalog_guess and (not existing_catalog or existing_catalog != catalog_guess):
        clean["catalog_name"] = catalog_guess
    else:
        clean["catalog_name"] = existing_catalog

    if clean.get("parte"):
        clean["parte"] = _normalize_whitespace(clean["parte"])
    elif base_source:
        clean["parte"] = _normalize_whitespace(base_source)
    else:
        clean["parte"] = clean["catalog_name"]

    existing_position = _format_position_value(clean.get("position"))
    detected_position = _format_position_value(" / ".join(tokens)) if tokens else ""
    combined_position = " / ".join(p for p in [existing_position, detected_position] if p)
    clean["position"] = combined_position

    # Normalizar nombres y posiciones usando vocabulario interno
    name_source = clean.get("catalog_name") or clean.get("parte")
    name_norm = normalize_piece_name(name_source)
    position_norm = normalize_position(clean.get("position"))

    clean["catalog_name"] = name_norm["normalized"].upper()
    clean["parte"] = (clean.get("parte") or name_norm["normalized"]).upper()
    clean["position"] = position_norm["normalized"].upper()

    clean["normalization"] = {
        "name": name_norm,
        "position": position_norm,
    }

    return clean


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
    return _enrich_ingest_schema(clean)

def extract_vehicle_info(text: str, use_cloud: bool = False):
    """
    Extrae información de pieza de auto usando modelos locales (Ollama) o en la nube (GPT-4o).
    
    Args:
        text: Texto a analizar
        use_cloud: Si True, usa GPT-4o; si False, usa Ollama (local)
    
    Returns:
        dict con claves: parte, catalog_name, position, valor, min_value, detalles
    """
    prompt = f"""
    Contexto: estás extrayendo información de descripciones habladas de repuestos automotrices (español chileno) para inventariar piezas. Responde SOLO con JSON y sigue estas reglas estrictas (usa "" cuando falte información):
Campos:
- "parte": nombre completo de la pieza incluyendo posición/lado (ej. "puerta trasera izquierda"). Nunca reubiques la posición en detalles.
- "catalog_name": nombre base del repuesto SIN la posición (como vendría en el Excel). Si no puedes separarlo, repite el valor de "parte".
- "position": posición/lado detectado (ej. "Izquierda", "Delantera / Derecha"). Si no aplica, devuelve "".
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
  "catalog_name": "",
  "position": "",
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
@csrf_protect
@require_POST
def detect_command(request):
    """Detectar comandos de voz en audio corto"""
    ensure_voice_ingest_permission(request.user)
    
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

        from parts.voice_commands import match_strict_command
        command_detected = None
        command_name = None
        cmd, phrase = match_strict_command(text, allow_partial=True)
        if cmd:
            command_detected = True
            command_name = phrase

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


def generate_tts_with_openai(text: str, usuario_id: str | None = None):
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
                meta={'endpoint': 'audio.speech'}, usuario_id=usuario_id or ''
            )
            return None
        
        print(f"TTS generado: {len(response.content)} bytes ({elapsed:.2f}s)")
        registrar_llamada(
            tipo='tts', modelo='tts-1-hd', inicio_monotonic=inicio, ok=True,
            codigo_http=response.status_code, prompt_texto_para_hash=text,
            origen='views.generate_tts_with_openai', request_id='', meta={'endpoint': 'audio.speech'},
            usuario_id=usuario_id or ''
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
@login_required
@csrf_protect
@require_POST
def process_voice_text(request):
    """
    Procesa TEXTO transcrito por Speech API del navegador.
    Usa OpenAI GPT para extraer datos estructurados.
    NO procesa audio, solo texto.
    """
    ensure_voice_ingest_permission(request.user)
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


def _get_publish_filter_context():
    talleres = list(Workshop.objects.order_by('name').values_list('name', flat=True))
    modelos = list(
        Auto.objects.order_by('brand_model')
        .values_list('brand_model', flat=True)
        .distinct()
    )
    anios = list(
        Auto.objects.order_by('-year')
        .values_list('year', flat=True)
        .distinct()
    )
    return {
        'talleres': talleres,
        'modelos': modelos,
        'anios': anios,
    }


@login_required
def part_publish_download_photos(request, pk):
    if not _usuario_es_admin(request.user):
        return _render_admin_denied(request, 'Solo administradores pueden descargar fotos.')

    pieza = get_object_or_404(
        Part.objects.prefetch_related('photos'),
        pk=pk
    )

    fotos = [p for p in pieza.photos.all() if p.image]
    if not fotos:
        return redirect('parts:part_publish', pk=pk)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as zipf:
        for idx, foto in enumerate(fotos, start=1):
            nombre = f"{pieza.name.replace(' ', '_')}_{idx}.jpg"
            with foto.image.open('rb') as contenido:
                zipf.writestr(nombre, contenido.read())

    buffer.seek(0)
    nombre_zip = f"{pieza.name.replace(' ', '_')}_fotos.zip"
    response = HttpResponse(buffer.read(), content_type='application/zip')
    response['Content-Disposition'] = f'attachment; filename="{nombre_zip}"'
    return response
