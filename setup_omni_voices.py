# Download Vietnamese clone voices (Vbee voices) into OmniVoice voice_store.
# Run with the VieNeu venv:
#   C:/VieNeu-TTS/.venv/Scripts/python.exe setup_omni_voices.py
import io
import sys
from pathlib import Path

import requests
import soundfile as sf

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://huggingface.co/datasets/STBack23/omnivoice-vi/resolve/main/voices"
VOICE_STORE = Path(r"C:\VieNeu-TTS\voice_store\omnivoice")

SLUGS = [
    "ban_mai", "lan_trinh", "ngan_ha", "ngoc_huyen",
    "thao_trinh", "tuong_vy", "injoyreel",
]


def fetch(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.content


def main():
    for slug in SLUGS:
        try:
            profile = requests.get(
                f"{BASE}/{slug}/profile.json", timeout=30
            ).json()
        except Exception as e:
            print(f"{slug}: profile fetch failed: {e}")
            continue

        name = profile.get("name") or slug
        ref_audio = profile.get("ref_audio") or "ref.wav"
        d = VOICE_STORE / name
        ref_wav, ref_txt = d / "ref.wav", d / "ref.txt"

        if ref_wav.exists() and ref_txt.exists():
            print(f"{name}: already installed, skip")
            continue

        d.mkdir(parents=True, exist_ok=True)

        txt = fetch(f"{BASE}/{slug}/ref_text.txt").decode("utf-8").strip()
        ref_txt.write_text(txt, encoding="utf-8")

        audio_bytes = fetch(f"{BASE}/{slug}/{ref_audio}")
        if ref_audio.lower().endswith(".mp3"):
            data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
            sf.write(str(ref_wav), data, sr, format="WAV", subtype="PCM_16")
        else:
            ref_wav.write_bytes(audio_bytes)

        print(f"{name}: installed ({ref_audio} -> ref.wav)")


if __name__ == "__main__":
    main()
