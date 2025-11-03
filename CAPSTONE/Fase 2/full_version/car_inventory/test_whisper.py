import os
import subprocess
from pathlib import Path

# Paths from settings
WHISPER_BIN = r"C:\Tools\whisper_cpp\Release\whisper-cli.exe"
MODEL_PATH = r"C:\Tools\whisper_cpp\models\ggml-medium.bin"

def test_transcribe():
    """Test whisper.cpp installation with a simple audio file."""
    print(f"Testing whisper.cpp installation...")
    print(f"Whisper binary: {WHISPER_BIN}")
    print(f"Model path: {MODEL_PATH}")
    
    # Check files exist
    if not os.path.exists(WHISPER_BIN):
        print("❌ whisper-cli.exe not found!")
        return False
    if not os.path.exists(MODEL_PATH):
        print("❌ ggml-medium.bin not found!")
        return False
    
    print("✅ Found whisper-cli.exe and model file")
    
    # Test basic command (version/help)
    try:
        result = subprocess.run([WHISPER_BIN, "--version"], 
                              capture_output=True, text=True)
        if result.returncode == 0:
            print(f"✅ whisper-cli.exe responds: {result.stdout.strip()}")
        else:
            print("❌ whisper-cli.exe failed to run")
            return False
    except Exception as e:
        print(f"❌ Error running whisper-cli: {e}")
        return False

    print("\nSetup appears correct! To test with an audio file:")
    print("""
    # Example usage:
    whisper = rf"{WHISPER_BIN}"
    model = rf"{MODEL_PATH}"
    wav_file = "path/to/your/audio.wav"
    
    cmd = [
        whisper,
        "-m", model,
        "-f", wav_file,
        "-l", "es"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print("Transcription:", result.stdout)
    """)
    return True

if __name__ == "__main__":
    test_transcribe()