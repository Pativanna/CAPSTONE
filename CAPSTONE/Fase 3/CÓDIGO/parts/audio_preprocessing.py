"""
Audio preprocessing utilities to make transcription robust in noisy environments.
- File-level pipeline: uses ffmpeg with a conservative filter-chain
- Stream-level helpers: reserved for future VAD/AGC if needed

Design goals:
- Single-pass, fast, and portable
- Safe defaults; no hard failures if ffmpeg is missing
"""
from __future__ import annotations

import os
import tempfile
import subprocess
from pathlib import Path
from shutil import which
from typing import Optional

from django.conf import settings


def _ffmpeg_bin() -> Optional[str]:
    return which('ffmpeg') or getattr(settings, 'FFMPEG_PATH', None)


def preprocess_audio_file(input_path: str, *, target_sr: int = 16000) -> str:
    """Apply robust normalization/denoise to an audio file using ffmpeg filters.

    Steps:
    - High-pass at 100Hz to remove rumble
    - Low-pass at 7kHz to suppress hiss/music highs
    - Spectral denoise (afftdn) with moderate reduction
    - Dynamic audio normalization (dynaudnorm) for level consistency
    - Resample to target_sr and mono S16LE

    Returns path to a cleaned temp WAV; on failure returns original path.
    """
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg or not os.path.exists(input_path):
        return input_path

    # Output temp WAV
    out_fd, out_path = tempfile.mkstemp(suffix='.wav')
    os.close(out_fd)

    # Build filter chain (safe defaults)
    filters = [
        'highpass=f=100',      # remove rumble
        'lowpass=f=7000',      # keep speech band
        'afftdn=nr=12',        # spectral denoise
        'dynaudnorm',          # dynamic normalization
    ]

    # Convert to mono s16le at target_sr
    cmd = [
        ffmpeg, '-y',
        '-i', input_path,
        '-af', ','.join(filters),
        '-ar', str(target_sr),
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        out_path,
    ]

    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=45)
        # If output file exists and is non-trivial, return it
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
            return out_path
    except Exception:
        pass

    # Fallback to original path if preprocessing fails
    try:
        if os.path.exists(out_path):
            os.remove(out_path)
    except Exception:
        pass
    return input_path


def transcode_webm_bytes_to_clean_wav(webm_path: str, *, target_sr: int = 16000) -> str:
    """Transcode a WEBM/OPUS file to cleaned WAV with the same filter chain.

    Returns path to cleaned WAV (temp file). On failure, returns a basic WAV without filters.
    """
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg or not os.path.exists(webm_path):
        return webm_path

    # First convert to wav
    base_fd, base_wav = tempfile.mkstemp(suffix='.wav')
    os.close(base_fd)
    try:
        cmd1 = [ffmpeg, '-y', '-i', webm_path, '-ar', str(target_sr), '-ac', '1', '-c:a', 'pcm_s16le', base_wav]
        subprocess.run(cmd1, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=45)
    except Exception:
        # If even basic conversion fails, return original path to let caller decide
        try:
            os.remove(base_wav)
        except Exception:
            pass
        return webm_path

    # Then apply preprocessing on the WAV
    cleaned = preprocess_audio_file(base_wav, target_sr=target_sr)

    # Clean intermediate
    try:
        if base_wav != cleaned and os.path.exists(base_wav):
            os.remove(base_wav)
    except Exception:
        pass

    return cleaned
