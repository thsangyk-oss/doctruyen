import sys, json, io, urllib.request, wave, time, random, os
import numpy as np
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path = __import__("pathlib").Path
CLIPDIR = OUT(r"C:\Users\ADMIN\Documents\Doctruyen\public\voicepicker\clips")
CLIPDIR.mkdir(parents=True, exist_ok=True)

def fetch(off, tries=6):
    u = f"https://datasets-server.huggingface.co/rows?dataset=Kontact%2Fvieneu_sidon_noise_removal&config=default&split=train&offset={off}&length=1"
    for t in range(tries):
        try:
            d = json.load(urllib.request.urlopen(u, timeout=45))
            row = d["rows"][0]["row"]
            buf = urllib.request.urlopen(row["audio"][0]["src"], timeout=45).read()
            return row["id"], buf, row["text"]
        except Exception:
            if t == tries-1: raise
            time.sleep(2*(t+1))

def f0_of(buf):
    w = wave.open(io.BytesIO(buf)); sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)/32768
    w.close(); x = x-x.mean(); f0s = []
    for i in range(0, len(x)-2048, 1024):
        fr = x[i:i+2048]
        if np.sqrt((fr**2).mean()) < 0.01: continue
        ac = np.correlate(fr, fr, 'full')[2047:]; ac /= ac[0]+1e-9
        lo, hi = int(sr/800), int(sr/80)
        lag = np.argmax(ac[lo:hi])+lo
        if ac[lag] > 0.3: f0s.append(sr/lag)
    return (float(np.median(f0s)) if f0s else 0.0), len(x)/sr

random.seed(11)
offs = sorted(random.sample(range(0, 73700), 150))
rows = []
with ThreadPoolExecutor(8) as ex:
    futs = {ex.submit(fetch, o): o for o in offs}
    for f in futs:
        o = futs[f]
        try:
            rid, buf, txt = f.result()
            f0, dur = f0_of(buf)
            wavp = CLIPDIR / f"row{o}.wav"
            wavp.write_bytes(buf)
            rows.append({"off": o, "id": rid, "f0": f0, "dur": dur, "text": txt, "wav": wavp.name})
            print(f"got {o} f0={f0:.0f}", flush=True)
        except Exception as e:
            print(f"skip {o}: {e}", flush=True)

json.dump(rows, open("sidon_scan_meta.json", "w", encoding="utf-8"), ensure_ascii=False)
print("DONE", len(rows))
