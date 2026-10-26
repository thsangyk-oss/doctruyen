import sys, json
import numpy as np
from pathlib import Path
sys.path.insert(0, r"C:\VieNeu-TTS")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from vieneu import Vieneu
tts = Vieneu(backend="onnx")

meta = json.load(open("sidon_scan_meta.json", encoding="utf-8"))
CLIPDIR = Path(r"C:\Users\ADMIN\Documents\Doctruyen\public\voicepicker\clips")

def emb_of(path):
    e, _ = tts.engine.prepare_reference(str(path), denoise=False, use_ref_codes=False)
    e = np.asarray(e, dtype=np.float32).reshape(-1)
    return e / (np.linalg.norm(e) + 1e-9)

embs = []
for r in meta:
    p = CLIPDIR / r["wav"]
    if p.is_file():
        try:
            embs.append(emb_of(p))
        except Exception as ex:
            embs.append(None); print("emb fail", r["off"], ex)
    else:
        embs.append(None)

# greedy cluster: same speaker if cos > 0.78 (probe: same-speaker 0.82-0.86)
TH = 0.78
clusters = []          # list of {"rep_idx": int, "members": [i]}
for i, e in enumerate(embs):
    if e is None: continue
    placed = False
    for c in clusters:
        if float(np.dot(e, embs[c["rep"]])) > TH:
            c["members"].append(i); placed = True; break
    if not placed:
        clusters.append({"rep": i, "members": [i]})

# pick rep = longest clip in cluster
for c in clusters:
    c["rep"] = max(c["members"], key=lambda i: meta[i]["dur"])
    c["members"].sort(key=lambda i: -meta[i]["dur"])

print(f"{sum(1 for e in embs if e is not None)} samples -> {len(clusters)} clusters")
sizes = sorted(len(c["members"]) for c in clusters)
print("cluster sizes:", sizes)

out = []
for n, c in enumerate(clusters):
    r = meta[c["rep"]]
    gender = "nữ" if r["f0"] >= 160 else "nam"
    out.append({
        "idx": n, "wav": r["wav"], "row": r["off"], "id": r["id"],
        "f0": round(r["f0"]), "dur": round(r["dur"], 1), "gender": gender,
        "members": len(c["members"]),
        "dups": [meta[m]["wav"] for m in c["members"][1:]],
        "text": r["text"][:160],
    })
json.dump(out, open("sidon_clusters.json", "w", encoding="utf-8"), ensure_ascii=False)
print("wrote sidon_clusters.json")
