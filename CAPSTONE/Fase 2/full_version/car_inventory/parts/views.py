import os
import re
import json
import tempfile
import subprocess
from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from .models import Part, Auto, Workshop
from .forms import PartForm, AutoForm, WorkshopForm


# -------------------------------
# PART CRUD
# -------------------------------
def part_list(request):
    # Obtener todos los autos únicos (brand_model + year) ordenados
    autos = Auto.objects.values('brand_model', 'year').distinct().order_by('brand_model', '-year')
    # Listas separadas para filtros individuales
    brand_models = Auto.objects.values_list('brand_model', flat=True).distinct().order_by('brand_model')
    years = Auto.objects.values_list('year', flat=True).distinct().order_by('-year')
    
    # Filtrar por modelo y año si se proporciona
    selected_brand_model = request.GET.get('brand_model', '')
    selected_year = request.GET.get('year', '')
    
    if selected_brand_model and selected_year:
        parts = Part.objects.filter(
            auto__brand_model=selected_brand_model,
            auto__year=selected_year
        ).select_related('auto', 'workshop').order_by('-date_added')
    else:
        parts = Part.objects.all().select_related('auto', 'workshop').order_by('-date_added')
    
    # Workshops para filtro por ubicación en el listado
    workshops = Workshop.objects.all().order_by('name')

    context = {
        'parts': parts,
        'autos': autos,
        'brand_models': brand_models,
        'years': years,
        'selected_brand_model': selected_brand_model,
        'selected_year': selected_year,
        'workshops': workshops,
    }
    return render(request, 'parts/part_list.html', context)

def part_create(request):
    # Initialize form with POST data or None
    initial_data = {}
    
    # Check if we have vehicle info in the session from audio processing
    if 'vehicle_info' in request.session:
        vehicle_info = request.session['vehicle_info']
        if isinstance(vehicle_info, dict):
            # Ensure we're getting the detalles field
            detalles = vehicle_info.get('detalles')
            valor = vehicle_info.get('valor')
            
            # Pre-populate form fields from vehicle info
            initial_data = {
                'name': vehicle_info.get('parte'),
                'details': detalles,  # Explicitly map 'detalles' to 'details'
                'max_value': valor,
                'min_value': valor,
            }
            
            # Debug print to check values
            print("Vehicle Info:", vehicle_info)
            print("Details value:", detalles)
            print("Initial Data:", initial_data)
            
            # Clean session after using the data
            del request.session['vehicle_info']
    
    # If we have POST data, prioritize it over initial data
    if request.POST:
        form = PartForm(request.POST, request.FILES or None)
    else:
        form = PartForm(initial=initial_data)
    
    # Provide autos (newest first) to the template so the selector can show them
    autos = Auto.objects.all().order_by('-date_added')
    
    if form.is_valid():
        part = form.save()
        # Store the auto used as the last used vehicle so "Add New" remembers it
        try:
            if getattr(part, 'auto', None):
                request.session['last_used_auto_id'] = str(part.auto.id)
                request.session['last_used_auto_label'] = f"{part.auto.brand_model} ({part.auto.year})"
                request.session.modified = True
        except Exception:
            pass
        
        # Si es una petición AJAX, devolver JSON
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({
                'success': True,
                'part_id': part.id,
                'part_name': part.name,
                'message': f'Pieza "{part.name}" guardada exitosamente'
            })
        
        return redirect('part_list')

    # Provide last used auto from session to help pre-selection in the client
    last_used_auto_id = request.session.get('last_used_auto_id', '')
    last_used_auto_label = request.session.get('last_used_auto_label', '')

    return render(request, 'parts/part_form.html', {
        'form': form,
        'autos': autos,
        'workshops': Workshop.objects.all().order_by('name'),
        'last_used_auto_id': last_used_auto_id,
        'last_used_auto_label': last_used_auto_label,
    })

def part_edit(request, pk):
    part = get_object_or_404(Part, pk=pk)
    form = PartForm(request.POST or None, request.FILES or None, instance=part)
    if form.is_valid():
        form.save()
        # Do NOT update last_used_auto here: only creation should affect last-used vehicle
        return redirect('part_list')

    # For editing, we only need to render the form (no last-used auto context)
    return render(request, 'parts/part_form.html', {'form': form})

def part_delete(request, pk):
    part = get_object_or_404(Part, pk=pk)
    if request.method == 'POST':
        part.delete()
        return redirect('part_list')
    return render(request, 'parts/confirm_delete.html', {'part': part})


# -------------------------------
# AJAX ENDPOINTS
# -------------------------------
@csrf_exempt
def toggle_part_sold(request, pk):
    """Toggle sold status of a part via AJAX"""
    if request.method == 'POST':
        part = get_object_or_404(Part, pk=pk)
        part.sold = not part.sold
        part.save()
        return JsonResponse({
            'success': True,
            'sold': part.sold
        })
    return JsonResponse({'success': False, 'error': 'Invalid method'}, status=400)


@csrf_exempt
def update_part_field(request, pk):
    """Update a single field of a part via AJAX"""
    if request.method == 'POST':
        try:
            part = get_object_or_404(Part, pk=pk)
            data = json.loads(request.body)
            field = data.get('field')
            value = data.get('value')
            
            # Validate field exists and is editable
            allowed_fields = ['name', 'details', 'max_value', 'min_value']
            if field not in allowed_fields:
                return JsonResponse({'success': False, 'error': 'Invalid field'}, status=400)
            
            # Convert value type for integer fields
            if field in ['max_value', 'min_value']:
                value = int(value) if value else 0
            
            # Update the field
            setattr(part, field, value)
            part.save()
            
            return JsonResponse({
                'success': True,
                'field': field,
                'value': value
            })
        except Exception as e:
            return JsonResponse({'success': False, 'error': str(e)}, status=500)
    return JsonResponse({'success': False, 'error': 'Invalid method'}, status=400)


# -------------------------------
# AUTO CRUD
# -------------------------------
def auto_list(request):
    autos = Auto.objects.all().order_by('-date_added')
    return render(request, 'parts/auto_list.html', {'autos': autos})

def auto_create(request):
    form = AutoForm(request.POST or None)
    if form.is_valid():
        form.save()
        return redirect('auto_list')
    return render(request, 'parts/auto_form.html', {'form': form})

def auto_edit(request, pk):
    auto = get_object_or_404(Auto, pk=pk)
    form = AutoForm(request.POST or None, instance=auto)
    if form.is_valid():
        form.save()
        return redirect('auto_list')
    return render(request, 'parts/auto_form.html', {'form': form})

def auto_delete(request, pk):
    auto = get_object_or_404(Auto, pk=pk)
    if request.method == 'POST':
        auto.delete()
        return redirect('auto_list')
    return render(request, 'parts/confirm_delete.html', {'object': auto, 'type': 'Auto'})


# -------------------------------
# WORKSHOP CRUD
# -------------------------------
def workshop_list(request):
    workshops = Workshop.objects.all()
    return render(request, 'parts/workshop_list.html', {'workshops': workshops})

def workshop_create(request):
    form = WorkshopForm(request.POST or None)
    if form.is_valid():
        form.save()
        return redirect('workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': form})

def workshop_edit(request, pk):
    ws = get_object_or_404(Workshop, pk=pk)
    form = WorkshopForm(request.POST or None, instance=ws)
    if form.is_valid():
        form.save()
        return redirect('workshop_list')
    return render(request, 'parts/workshop_form.html', {'form': form})

def workshop_delete(request, pk):
    ws = get_object_or_404(Workshop, pk=pk)
    if request.method == 'POST':
        ws.delete()
        return redirect('workshop_list')
    return render(request, 'parts/confirm_delete.html', {'object': ws, 'type': 'Workshop'})

@csrf_exempt
def upload_audio(request):
    if request.method != 'POST' or 'audio' not in request.FILES:
        return JsonResponse({"error": "No audio uploaded"}, status=400)

    audio_file = request.FILES['audio']

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
        conv = subprocess.run(ffmpeg_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if conv.returncode != 0 or not os.path.exists(wav_path):
            return JsonResponse({"error": "ffmpeg conversion failed. Ensure ffmpeg is installed and in PATH."}, status=500)
    except FileNotFoundError:
        return JsonResponse({"error": "ffmpeg not found. Please install ffmpeg and make it available in PATH."}, status=500)

    # 3) Transcription: try multiple strategies (python whisper, then binary)
    def transcribe_with_python_whisper(wav_file):
        try:
            import whisper
        except Exception:
            return None
        try:
            model_name = getattr(settings, 'WHISPER_PY_MODEL', 'tiny')
            model = whisper.load_model(model_name)
            res = model.transcribe(wav_file, language='es')
            return res.get('text') if isinstance(res, dict) else None
        except Exception:
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
    result_text = transcribe_with_python_whisper(wav_path)
    if not result_text:
        result_text = transcribe_with_binary(wav_path)

    # Optional: remove temp files
    try:
        os.remove(in_path)
        os.remove(wav_path)
    except OSError:
        pass

    out = (result_text or "").strip()
    if not out:
        return JsonResponse({"error": "Transcription failed: no transcription backend available or transcription returned empty."}, status=500)

    # Try extracting vehicle info using Ollama; fallback to local heuristic
    vehicle = extract_vehicle_info(out)
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



# ---- Vehicle extraction helpers (inline) ----
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "results.json")
SCHEMA_KEYS = ("modelo", "parte", "color", "valor", "detalles")

def _force_schema(obj):
    """Garantiza que existan las claves esperadas y normaliza vacíos."""
    clean = {k: (obj.get(k) if isinstance(obj, dict) else None) for k in SCHEMA_KEYS}
    for k, v in clean.items():
        # Normalize empty values
        if v in ("", "null", "None", None):
            clean[k] = None
        # Remove quotes from string values if they exist
        elif isinstance(v, str):
            clean[k] = v.strip("'\"")
    
    # Debug print
    print("Schema after cleaning:", clean)
    return clean

def extract_vehicle_info(text: str):
    """
    Llama a Ollama (mistral:instruct) para extraer modelo/parte/color desde un texto.
    Devuelve un dict con las 3 claves o None si no se pudo parsear JSON.
    """
    prompt = f"""
Analiza el siguiente texto y extrae la información del vehículo y la pieza mencionada.
Devuelve **solo** un JSON exactamente con este formato (sin texto extra, sin comentarios):

{{
  "modelo": "<nombre del modelo y año del automóvil, o null si no se menciona>",
  "parte": "<nombre de la pieza o componente principal, o null>",
  "color": "<color principal del vehículo, o null>",
  "valor": "<valor aproximado en CLP, o null si no se menciona>",
  "detalles": "<COPIA LITERAL de todo lo que el usuario diga sobre el estado, condición y descripción de la pieza. NO inventes, NO interpretes, NO agregues nada. Si dice 'todo impecable', escribe 'todo impecable'. Si dice 'perfecto', escribe 'perfecto'. Si dice 'rayones leves', escribe 'rayones leves'. Mantén exactamente las palabras del usuario. Usar null SOLO si no menciona absolutamente nada sobre el estado>"
}}

Texto:
{text}

IMPORTANTE: 
- Responde únicamente con JSON válido. Sin explicaciones ni frases adicionales.
- Para el campo 'detalles': COPIA LITERAL lo que el usuario diga. NO lo formalices, NO lo cambies, NO agregues palabras como "Presenta" o "Se encuentra". Usa las MISMAS palabras del usuario.
- TODOS los valores de texto deben estar EN ESPAÑOL, excepto nombres propios de marcas o modelos que tradicionalmente se escriben en inglés.
- Si el texto de entrada está en español, la respuesta también debe estar completamente en español.
- Corrige SOLO errores ortográficos obvios en los detalles, pero mantén las mismas palabras y estructura que dijo el usuario.
"""
    # For Ollama, allow using a Windows executable when WINDOWS_MODE enabled
    ollama_exec = "ollama"
    if getattr(settings, 'WINDOWS_MODE', False):
        win_paths = getattr(settings, 'WINDOWS_PATHS', {})
        ollama_exec = win_paths.get('ollama_bin', ollama_exec)

    cmd = [ollama_exec, "run", "mistral:instruct", prompt]
    try:
        print("🔍 Ejecutando comando Ollama:", " ".join(cmd))
        res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        print("📝 Código de salida:", res.returncode)
        print("📄 Stdout:", res.stdout)
        print("❌ Stderr:", res.stderr)
    except FileNotFoundError:
        # Ollama not available: return None and allow transcription-only flow
        print("⚠️  Ollama executable not found at:", ollama_exec)
        return None
    except Exception as e:
        print("💥 Error ejecutando Ollama:", str(e))
        return None
    out = (res.stdout or "").strip()

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
    print("⚠️  Salida no es JSON válido desde Ollama:\n", out)
    return None


def extract_vehicle_info_local(text: str):
    """Heurística local para extraer modelo, parte, color y valor desde texto.
    No es tan buena como un LLM, pero permite pruebas locales sin Ollama.
    """
    # Normalizar
    t = text.lower()

    # Buscar valor (números, opcional con $)
    val = None
    m = re.search(r"\$?\s*([0-9]+(?:[.,][0-9]{3})*)", t)
    if m:
        val = m.group(1).replace('.', '').replace(',', '')

    # Buscar color por lista básica
    colors = ["blanco","negro","rojo","azul","gris","verde","amarillo","dorado","plateado","marron","beige"]
    color = None
    for c in colors:
        if c in t:
            color = c
            break

    # Buscar palabra 'parte' o 'repuesto' seguido de un nombre
    parte = None
    m2 = re.search(r"(?:pieza|parte|repuesto|parabrisas|puerta|motor|far[oó]s?)\s+de\s+([a-z0-9 ]{2,40})", t)
    if m2:
        parte = m2.group(1).strip()
    else:
        # fallback: first noun-like token after 'de'
        m3 = re.search(r"de\s+([a-z0-9 ]{2,40})", t)
        if m3:
            parte = m3.group(1).split('.')[0].strip()

    # Model: buscar patrón con año o palabra 'modelo'
    modelo = None
    m4 = re.search(r"modelo[:]?\s*([a-z0-9\- ]{2,40})", t)
    if m4:
        modelo = m4.group(1).strip()
    else:
        m5 = re.search(r"(toyota|honda|chevrolet|ford|nissan|bmw|mercedes|hyundai|kia)[ a-z0-9-]{0,40}", t)
        if m5:
            modelo = m5.group(0).strip()

    # Buscar detalles del estado - CAPTURAR TEXTO LITERAL
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
        "modelo": modelo,
        "parte": parte,
        "color": color,
        "valor": val,
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