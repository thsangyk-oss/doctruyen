import sys, json, io, urllib.request, wave, time, random
import numpy as np
sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from vieneu import Vieneu
tts = Vieneu(backend="onnx")

def emb_of_wav_bytes(buf):
    import tempfile, os
    fd, p = tempfile.mkstemp(suffix=".wav")
    os.write(fd, buf); os.close(fd)
    try:
        e, _ = tts.engine.prepare_reference(p, denoise=False, use_ref_codes=False)
        e = np.asarray(e, dtype=np.float32).reshape(-1)
        return e / (np.linalg.norm(e) + 1e-9)
    finally:
        os.remove(p)

def fetch(off, tries=5):
    u = f"https://datasets-server.huggingface.co/rows?dataset=Kontact%2Fvieneu_sidon_noise_removal&config=default&split=train&offset={off}&length=1"
    for t in range(tries):
        try:
            d = json.load(urllib.request.urlopen(u, timeout=45))
            row = d["rows"][0]["row"]
            return row["id"], urllib.request.urlopen(row["audio"][0]["src"], timeout=45).read(), row["text"]
        except Exception as e:
            if t == tries-1: raise
            time.sleep(3*(t+1))

random.seed(7)
offs = sorted(random.sample(range(0, 73700), 24))
embs, ids, texts = [], [], []
for o in offs:
    try:
        rid, buf, txt = fetch(o)
        embs.append((o, emb_of_wav_bytes(buf)))
        ids.append(rid); texts.append(txt)
        print("got", o, flush=True)
    except Exception as e:
        print("skip", o, e, flush=True)

np.save("sidon_probe_embs.npy", np.array([e for _, e in embs]))
json.dump({"offs": [o for o, _ in embs], "ids": ids, "texts": texts},
          open("sidon_probe_meta.json", "w", encoding="utf-8"), ensure_ascii=False)

print("\npairwise cosine > 0.80 (same speaker likely):")
n = len(embs)
for i in range(n):
    for j in range(i+1, n):
        c = float(np.dot(embs[i][1], embs[j][1]))
        if c > 0.80:
            print(f"  {embs[i][0]}~{embs[j][0]}: {c:.3f}")

print("\nclosest built-in preset per sample:")
pres = {n2: np.asarray(v["speaker_emb"], dtype=np.float32).reshape(-1)
        for n2, v in tts._preset_voices.items() if v.get("speaker_emb") is not None}
pres = {n2: e/(np.linalg.norm(e)+1e-9) for n2, e in pres.items()}
for o, e in embs:
    best = max(pres.items(), key=lambda kv: float(np.dot(e, kv[1])))
    print(f"  {o}: {best[0]} ({float(np.dot(e,best[1])):.3f})")
