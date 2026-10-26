# Re-enroll the 10 official sample voices WITHOUT wiping existing user voices.
# Fix: call load_user_voices() first so _write() snapshots everyone.
# Run:  C:/VieNeu-TTS/.venv/Scripts/python.exe fix_user_voices.py
import sys
from pathlib import Path

sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CACHE = Path(r"C:\Users\ADMIN\Documents\Doctruyen\vieneu_voice_samples")

SAMPLES = [
    "Bình (nam miền Bắc)", "Vĩnh (nam miền Nam)", "Nguyên (nam miền Nam)",
    "Sơn (nam miền Nam)", "Tuyên (nam miền Bắc)", "Đoan (nữ miền Nam)",
    "Dung (nữ miền Nam)", "Hương (nữ miền Bắc)", "Ly (nữ miền Bắc)",
    "Ngọc (nữ miền Bắc)",
]


def main():
    from vieneu import Vieneu
    from apps.user_voices import save_user_voice, load_user_voices, user_voices_path, USER_MARK

    vieneu = Vieneu(backend="onnx")

    # pull existing user voices into _preset_voices so _write() keeps them
    loaded = load_user_voices(vieneu)
    print("existing user voices loaded:", loaded)

    for name in SAMPLES:
        wav = CACHE / f"{name}.wav"
        if not wav.exists():
            print(f"{name}: missing wav, skip")
            continue
        existing = vieneu._preset_voices.get(name)
        if existing is not None and not existing.get(USER_MARK):
            print(f"{name}: collides with built-in, skip")
            continue
        try:
            save_user_voice(vieneu, name, str(wav), denoise=True,
                            description=f"giọng mẫu VieNeu · {name.split('(')[-1].rstrip(')')}")
            print(f"{name}: enrolled")
        except Exception as e:
            print(f"{name}: FAILED {e}")

    print("user voices file:", user_voices_path(vieneu))
    print("final count:", len([n for n, v in vieneu._preset_voices.items() if v.get(USER_MARK)]))


if __name__ == "__main__":
    main()
