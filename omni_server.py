# OmniVoice TTS sidecar — port 8002
# Run with the VieNeu venv (has torch 2.8+cu128):
#   C:/VieNeu-TTS/.venv/Scripts/python.exe omni_server.py
import io
import os
import sys
import threading
import warnings
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="OmniVoice TTS")
model = None
lock = threading.Lock()  # GPU is 4 GB — serialize generation

VOICE_STORE = Path(r"C:\VieNeu-TTS\voice_store\omnivoice")

# speed knobs — the decode loop is num_step x full LLM forward
NUM_STEP = int(os.environ.get("OMNI_NUM_STEP", "8"))
GUIDANCE = float(os.environ.get("OMNI_GUIDANCE", "2.0"))

# preset voice_id -> instruct (OmniVoice fixed vocabulary; 'vi' covers language)
INSTRUCTS = {
    "nu": "female",
    "nam": "male",
    "nu-tram": "female, low pitch",
    "nam-tram": "male, low pitch",
    "nu-cao": "female, high pitch",
    "nam-cao": "male, high pitch",
    "thi-tham": "whisper, female",
}
NAMES = {
    "nu": "Nữ", "nam": "Nam", "nu-tram": "Nữ trầm", "nam-tram": "Nam trầm",
    "nu-cao": "Nữ cao", "nam-cao": "Nam cao", "thi-tham": "Thì thầm",
}

# clone voices: name -> VoiceClonePrompt (built once at startup)
CLONES = {}


@app.on_event("startup")
def load():
    global model
    from omnivoice import OmniVoice

    torch.set_float32_matmul_precision("high")
    dev = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = OmniVoice.from_pretrained(
        "k2-fsa/OmniVoice",
        device_map=dev,
        dtype=torch.float16 if dev == "cuda:0" else torch.float32,
    )
    # build reusable clone prompts for every voice dir in voice_store
    if VOICE_STORE.is_dir():
        for d in sorted(VOICE_STORE.iterdir()):
            ref_wav, ref_txt = d / "ref.wav", d / "ref.txt"
            if not (d.is_dir() and ref_wav.exists() and ref_txt.exists()):
                continue
            try:
                CLONES[d.name] = model.create_voice_clone_prompt(
                    str(ref_wav), ref_txt.read_text(encoding="utf-8").strip()
                )
                print(f"clone voice ready: {d.name}")
            except Exception as e:
                print(f"clone voice failed {d.name}: {e}")
    print(f"OmniVoice ready on {dev} | {len(CLONES)} clone voices")
    # warmup: JIT/cudnn autotune once so the first request isn't cold
    if CLONES:
        first = next(iter(CLONES.values()))
        model.generate(
            text="Xin chào.", language="vi", voice_clone_prompt=first,
            num_step=NUM_STEP, guidance_scale=GUIDANCE,
        )
        print("warmup done")


@app.get("/stream")
def stream(text: str = Query(...), voice_id: str = Query("nu"),
           num_step: int = Query(0), guidance: float = Query(-1.0)):
    ns = num_step if num_step > 0 else NUM_STEP
    gs = guidance if guidance >= 0 else GUIDANCE
    with lock:
        if voice_id.startswith("clone:"):
            name = voice_id[6:]
            if name not in CLONES:
                return JSONResponse({"error": "unknown clone voice"}, status_code=404)
            audio = model.generate(
                text=text, language="vi", voice_clone_prompt=CLONES[name],
                num_step=ns, guidance_scale=gs,
            )[0]
        else:
            ins = INSTRUCTS.get(voice_id, voice_id)
            audio = model.generate(
                text=text, language="vi", instruct=ins,
                num_step=ns, guidance_scale=gs,
            )[0]
    pcm = np.clip(audio, -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, pcm, 24000, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.get("/voices")
def voices():
    out = [{"id": k, "name": f"Omni · {NAMES[k]}"} for k in INSTRUCTS]
    out += [{"id": f"clone:{k}", "name": f"Omni · {k} (clone)"} for k in CLONES]
    return out


@app.get("/health")
def health():
    return JSONResponse({"ok": model is not None})


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002, log_level="warning")
