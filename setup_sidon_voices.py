# Enroll voices extracted from the public dataset
#   https://huggingface.co/datasets/Kontact/vieneu_sidon_noise_removal
# (denoised Vietnamese narration audio; ~2 speakers: male ~120Hz, female ~210Hz)
# Run with the VieNeu venv:
#   C:/VieNeu-TTS/.venv/Scripts/python.exe setup_sidon_voices.py
import sys
from pathlib import Path

sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SAMPLES = Path(r"C:\Users\ADMIN\Documents\Doctruyen\sidon_samples")

VOICES = [
    ("Sidon (nam)", "ref_male.wav", "giọng đọc Sidon — nam, tải từ dataset Kontact/vieneu_sidon_noise_removal"),
    ("Sidon (nữ)", "ref_female.wav", "giọng đọc Sidon — nữ, tải từ dataset Kontact/vieneu_sidon_noise_removal"),
]


def main():
    from vieneu import Vieneu
    from apps.user_voices import save_user_voice, load_user_voices, user_voices_path, USER_MARK

    vieneu = Vieneu(backend="onnx")

    # IMPORTANT: merge existing user voices first — save_user_voice() rewrites
    # the whole file from in-memory _user entries and would wipe the rest.
    print("existing user voices:", load_user_voices(vieneu))

    for name, wav, desc in VOICES:
        existing = vieneu._preset_voices.get(name)
        if existing is not None and not existing.get(USER_MARK):
            print(f"{name}: collides with built-in, skip")
            continue
        try:
            save_user_voice(vieneu, name, str(SAMPLES / wav), denoise=True,
                            description=desc)
            print(f"{name}: enrolled")
        except Exception as e:
            print(f"{name}: FAILED {e}")

    print("user voices file:", user_voices_path(vieneu))


if __name__ == "__main__":
    main()
