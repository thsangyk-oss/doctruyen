# Enroll the 10 official sample voices (from pnnbao-ump's HF Space) into
# VieNeu v3 Turbo as named voices, persisted to ~/.vieneu/user_voices_v3_turbo.json
# Run with the VieNeu venv from the VieNeu-TTS dir:
#   C:/VieNeu-TTS/.venv/Scripts/python.exe setup_vieneu_voices.py
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = ("https://huggingface.co/spaces/pnnbao-ump/VieNeu-TTS-v3-Turbo/resolve/"
        "79d57985251f81b07baac09ae8069cbe19a3145b/sample/")
CACHE = Path(r"C:\Users\ADMIN\Documents\Doctruyen\vieneu_voice_samples")

SAMPLES = [
    "Bình (nam miền Bắc)", "Vĩnh (nam miền Nam)", "Nguyên (nam miền Nam)",
    "Sơn (nam miền Nam)", "Tuyên (nam miền Bắc)", "Đoan (nữ miền Nam)",
    "Dung (nữ miền Nam)", "Hương (nữ miền Bắc)", "Ly (nữ miền Bắc)",
    "Ngọc (nữ miền Bắc)",
]


def main():
    CACHE.mkdir(exist_ok=True)
    wavs = {}
    for name in SAMPLES:
        wav = CACHE / f"{name}.wav"
        if not wav.exists():
            url = BASE + urllib.parse.quote(f"{name}.wav")
            print(f"downloading {name}.wav ...")
            urllib.request.urlretrieve(url, wav)
        wavs[name] = wav

    from vieneu import Vieneu
    from apps.user_voices import save_user_voice, user_voices_path, USER_MARK

    vieneu = Vieneu(backend="onnx")

    existing = set(vieneu._preset_voices)
    for name in SAMPLES:
        if name in existing and not vienneu._preset_voices[name].get(USER_MARK):
            print(f"{name}: collides with built-in, skip")
            continue
        try:
            save_user_voice(vieneu, name, str(wavs[name]), denoise=True,
                            description=f"giọng mẫu VieNeu · {name.split('(')[-1].rstrip(')')}")
            print(f"{name}: enrolled")
        except Exception as e:
            print(f"{name}: FAILED {e}")

    print("user voices file:", user_voices_path(vieneu))


if __name__ == "__main__":
    main()
