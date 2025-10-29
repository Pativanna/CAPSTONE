import os
import re
import json
import tempfile
import subprocess
from django.http import JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from .models import Part, Auto, Workshop
from .forms import PartForm, AutoForm, WorkshopForm


# -------------------------------
# PART CRUD
# -------------------------------
def part_list(request):
    parts = Part.objects.all().order_by('-date_added')
    return render(request, 'parts/part_list.html', {'parts': parts})

def part_create(request):
    form = PartForm(request.POST or None, request.FILES or None)
    if form.is_valid():
        form.save()
        return redirect('part_list')
    return render(request, 'parts/part_form.html', {'form': form})

def part_edit(request, pk):
    part = get_object_or_404(Part, pk=pk)
    form = PartForm(request.POST or None, request.FILES or None, instance=part)
    if form.is_valid():
        form.save()
        return redirect('part_list')
    return render(request, 'parts/part_form.html', {'form': form})

def part_delete(request, pk):
    part = get_object_or_404(Part, pk=pk)
    if request.method == 'POST':
        part.delete()
        return redirect('part_list')
    return render(request, 'parts/confirm_delete.html', {'part': part})


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
    #    (silence ffmpeg output to keep response clean)
    wav_path = in_path + ".wav"
    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", in_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_path
    ]
    conv = subprocess.run(ffmpeg_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if conv.returncode != 0 or not os.path.exists(wav_path):
        return JsonResponse({"error": "ffmpeg conversion failed"}, status=500)

    # 3) Call whisper.cpp (correct binary + model)
    whisper_bin = "/home/purplesheep/Code/transcription/whisper.cpp/build/bin/whisper-cli"
    model_path  = "/home/purplesheep/Code/transcription/whisper.cpp/models/ggml-small.bin"

    # Keep output clean; set language to Spanish ("es")
    cmd = [
        whisper_bin,
        "-m", model_path,
        "-f", wav_path,
        "-ac", "768",
        "-t", "8",
        "-l", "es",
        "--print-progress", "false",
        "--print-special", "false",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

    # Optional: remove temp files
    try:
        os.remove(in_path)
        os.remove(wav_path)
    except OSError:
        pass

    # Return whatever Whisper printed as transcript
    # ... your existing code above ...
    out = result.stdout.strip()
    err = result.stderr.strip()
    if result.returncode != 0:
        return JsonResponse({"error": "whisper failed", "stderr": err}, status=500)

    # Clean optional special tokens if any lingering:

    # Use the inline helpers:
    vehicle = extract_vehicle_info(out)  # may return None if not parseable
    if vehicle:
        save_vehicle_result(vehicle, source=wav_path)

    return JsonResponse({
        "transcription": out or err,
        "vehicle_info": vehicle  # can be None if model didn’t return valid JSON
    })



# ---- Vehicle extraction helpers (inline) ----
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "results.json")
SCHEMA_KEYS = ("modelo", "parte", "color", "valor")

def _force_schema(obj):
    """Garantiza que existan las 3 claves esperadas y normaliza vacíos."""
    clean = {k: (obj.get(k) if isinstance(obj, dict) else None) for k in SCHEMA_KEYS}
    for k, v in clean.items():
        if v in ("", "null", "None"):
            clean[k] = None
    return clean

def extract_vehicle_info(text: str):
    """
    Llama a Ollama (mistral:instruct) para extraer modelo/parte/color desde un texto.
    Devuelve un dict con las 3 claves o None si no se pudo parsear JSON.
    """
    prompt = f"""
Analiza el siguiente texto y extrae la información del vehículo mencionado.
Corrige errores ortográficos y devuelve **solo** un JSON exactamente con este formato (sin texto extra, sin comentarios):

{{
  "modelo": "<nombre del modelo y año del automóvil, o null si no se menciona>",
  "parte": "<nombre de la pieza o componente principal, o null>",
  "color": "<color principal del vehículo, o null>"
  "valor": "<valor aproximado en CLP, o null si no se menciona>"
}}

Texto:
{text}

IMPORTANTE: Responde únicamente con JSON válido. Sin explicaciones ni frases adicionales.
"""
    cmd = ["ollama", "run", "mistral:instruct", prompt]
    res = subprocess.run(cmd, capture_output=True, text=True)
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