// Concurrency sweep: how many parallel translate calls can OpenCode Go take?
// For each level, fire N parallel callTranslate on distinct ~1200-char chunks,
// count ok / 429 / other errors + latency. Pauses briefly between levels.
const fs = require("fs");
const path = require("path");
const oc = require("./opencode");

const conf = oc.loadConf();
const card = conf.keys.find((k) => k.name === conf.active) || conf.keys[0];
const KEY = card.key, MODEL = process.env.MODEL || "deepseek-v4-flash";
const SYS = "Bạn là dịch giả. Dịch đoạn truyện Trung sang tiếng Việt tự nhiên, " +
  "giữ nguyên số đoạn. Tên riêng dịch Hán-Việt.";
const CHUNK_CHARS = 1200;

// build a pool of distinct chunks from several chapters
function pool() {
  const out = [];
  const dir = path.join("data", "books", "cn-hy-157662", "chapters");
  for (let n = 131; n <= 230 && out.length < 130; n++) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n + ".json"), "utf8")); }
    catch { continue; }
    const paras = (d.paras || []).filter((p) => p && p.trim());
    let cur = [], len = 0;
    for (const p of paras) {
      cur.push(p); len += p.length;
      if (len >= CHUNK_CHARS) { out.push(cur); cur = []; len = 0; }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

async function one(chunk, tag) {
  const t0 = Date.now();
  try {
    const r = await oc.callTranslate(KEY, MODEL, SYS, "", chunk, "conc-" + tag);
    return { ok: true, ms: Date.now() - t0, n: (r.paragraphs || []).length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.status === 429 ? "429" :
      String(e && e.message || e).slice(0, 50) };
  }
}

(async () => {
  const chunks = pool();
  console.log(`pool: ${chunks.length} chunks ~${CHUNK_CHARS} chars each, model=${MODEL}`);
  let cursor = 0;
  for (const L of [48, 64]) {
    if (cursor + L > chunks.length) break;
    const batch = chunks.slice(cursor, cursor + L);
    cursor += L;
    const t0 = Date.now();
    const rs = await Promise.all(batch.map((c, i) => one(c, `${L}-${i}`)));
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = rs.filter((r) => r.ok);
    const errs = rs.filter((r) => !r.ok);
    const e429 = errs.filter((r) => r.err === "429").length;
    const lats = ok.map((r) => r.ms).sort((a, b) => a - b);
    const med = lats.length ? (lats[lats.length >> 1] / 1000).toFixed(1) : "-";
    const max = lats.length ? (lats[lats.length - 1] / 1000).toFixed(1) : "-";
    const thr = (ok.length / (+wall) * 60).toFixed(1);
    console.log(`L=${String(L).padStart(2)}  ok=${ok.length}/${L}  429=${e429}` +
      `  other=${errs.length - e429}  wall=${wall}s  med=${med}s  max=${max}s` +
      `  ~${thr} chunks/min`);
    errs.slice(0, 3).forEach((r) => console.log(`    err: ${r.err}`));
    await new Promise((r) => setTimeout(r, 3000)); // let the bucket refill
  }
})();
