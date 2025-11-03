Car Inventory (local dev)

This is a small Django app that manages car parts, autos and workshops.

Quick start (PowerShell):

1) Create and activate virtualenv

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
```

2) Run migrations and create superuser

```powershell
python manage.py migrate
python manage.py createsuperuser
```

3) Run development server

```powershell
python manage.py runserver
```

Notes about audio/transcription features:
- The upload/transcription flow calls ffmpeg, a local whisper-cli binary and Ollama by default.
- For quick Windows testing, open `car_inventory/settings.py` and set `WINDOWS_MODE = True`, then edit the paths in `WINDOWS_PATHS` to point to the Windows executables and model file.
- If those binaries are not available, the server will still run but the `/upload/` flow may return errors or simply not extract structured JSON.

Security/nits:
- `upload_audio` view is `csrf_exempt` for convenience in testing; do not use this in production as-is.
- The WINDOWS_MODE flag is a temporary testing convenience.
