// Per-book translation worker — spawned by server.js. Translates the CN
// chapters of <dir>/chapters/*.json into Vietnamese, writing <dir>/vi/<n>.json
// incrementally (readers can start reading as soon as a chapter lands).
// N parallel chapter lanes (default 3) share one OpenCode Go key.
// Usage: node translate.js --dir=<book dir> [--key=<card name>] [--workers=3]
// Writes: <dir>/vi/<n>.json, vi/_index.json, translate.json (job), translate.log
const fs = require("fs");
const path = require("path");
const oc = require("./opencode");
const ol = require("./ollama");
// provider dispatch — key cards carry .provider ("opencode" default, "ollama")
const apiOf = (card) => (card && card.provider === "ollama" ? ol : oc);

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});
const BOOK_DIR = ARGS.dir;
if (!BOOK_DIR) { console.error("need --dir"); process.exit(2); }
const SRC_DIR = path.join(BOOK_DIR, "chapters");
const VI_DIR = path.join(BOOK_DIR, "vi");
const TJOB_FILE = path.join(BOOK_DIR, "translate.json");
const LOG_FILE = path.join(BOOK_DIR, "translate.log");
const VI_INDEX = path.join(VI_DIR, "_index.json");
fs.mkdirSync(VI_DIR, { recursive: true });
// OpenCode Go tolerates heavy parallelism — benched 64 concurrent calls on
// one key with zero 429s and flat latency; chapter-level failures above ~32
// are model-output flakes the retry loop already handles. Default 24 lanes
// leaves headroom for single-chapter retranslates on the same key.
// resolved in main() once the key card's provider is known — opencode keys
// bench fine at 24 lanes; ollama cloud free plan is rate-capped so fewer.
let WORKERS = Math.max(0, Math.min(64, +ARGS.workers || 0));

const SYS = [
  "Bạn là dịch giả chuyên dịch tiểu thuyết mạng Trung Quốc sang tiếng Việt.",
  "Dịch tự nhiên, trôi chảy, giữ đúng văn phong truyện; KHÔNG bỏ sót hay thêm đoạn.",
  "Giữ nguyên số lượng và thứ tự đoạn văn (paragraphs_zh -> paragraphs).",
  "Tên riêng dịch theo Hán-Việt thông dụng (严望 -> Nghiêm Vọng…).",
  "Bắt buộc dùng ĐÚNG cách dịch trong known_names (zh=vi) cho tên đã có.",
  "Điền names[] với mọi tên riêng (nhân vật/địa danh/tổ chức/vật phẩm…) trong đoạn,",
  "kể cả tên đã có trong known_names — để hệ thống theo dõi danh pháp.",
  "Nếu có title_zh, dịch sang tiếng Việt giữ số chương: \"第N章 …\" -> \"Chương N: …\".",
].join("\n");

// --only=N = single-chapter retranslate (from the reader settings button):
// doesn't own the book's translate.json job state — it may run alongside the
// main worker, so keep its footprint to vi/<n>.json + glossary merges only
const ONLY = ARGS.only ? +ARGS.only : 0;
const job = { status: "running", done: 0, total: 0, fail: 0, updated: Date.now() };
const saveJob = () => {
  if (ONLY) return; // single-shot run — don't clobber the real job state
  job.updated = Date.now();
  try { fs.writeFileSync(TJOB_FILE, JSON.stringify(job)); } catch {}
};
// heartbeat even while a lane sits in retry/backoff — the server's stale
// watchdog uses job.updated to tell a live worker from a dead one
setInterval(saveJob, 30000).unref();
const log = (s) => {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 19) + " " + s + "\n");
  } catch {}
};

const indexMap = {};
try { Object.assign(indexMap, JSON.parse(fs.readFileSync(VI_INDEX, "utf8"))); } catch {}
const saveIndex = () => {
  try { fs.writeFileSync(VI_INDEX, JSON.stringify(indexMap)); } catch {}
};

// per-book glossary — zh term -> established vi rendering; grows as the model
// reports names via the submit_translation tool, and is injected back into
// later chapters so names stay consistent across the whole book.
// Two files, one writer each — no locking needed:
//   _glossary.json       AI-discovered terms (worker writes)
//   _glossary.edits.json user corrections/tombstones (server writes, worker reads)
const GLOSS_FILE = path.join(VI_DIR, "_glossary.json");
const EDITS_FILE = path.join(VI_DIR, "_glossary.edits.json");
const gloss = {}; // zh -> {vi, kind, n, ch}
let edits = {};   // zh -> {vi,kind} | null(tombstone)
const loadEdits = () => {
  try { edits = JSON.parse(fs.readFileSync(EDITS_FILE, "utf8")); }
  catch { edits = {}; }
};
// user overlay always wins; tombstones remove the term entirely
const applyEdits = () => {
  for (const zh in edits) {
    const e = edits[zh];
    if (e === null) { delete gloss[zh]; continue; }
    const prev = gloss[zh] || {};
    gloss[zh] = {
      vi: e.vi, kind: e.kind || prev.kind || "other",
      n: Math.max(prev.n || 0, 1), ch: prev.ch || 0, manual: true,
    };
  }
};
try { Object.assign(gloss, JSON.parse(fs.readFileSync(GLOSS_FILE, "utf8"))); } catch {}
loadEdits(); applyEdits();
const saveGloss = () => {
  try {
    loadEdits(); // pick up mid-run user corrections
    // a single-shot --only worker may have merged new names since our last
    // save — union them back in instead of clobbering (vi of existing keys
    // stays ours; equal keys just bump the count)
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(GLOSS_FILE, "utf8")); } catch {}
    for (const zh in disk) {
      const d = disk[zh], m = gloss[zh];
      if (!m) gloss[zh] = d;
      else m.n = Math.max(m.n || 0, d.n || 0);
    }
    fs.writeFileSync(GLOSS_FILE + ".tmp", JSON.stringify(gloss));
    fs.renameSync(GLOSS_FILE + ".tmp", GLOSS_FILE); // atomic for readers
    applyEdits(); // keep tombstones/edits out of the in-memory view
  } catch {}
};
// only inject names that actually appear in this chunk (prompt stays small)
function glossFor(text) {
  const out = [];
  for (const zh in gloss)
    if (text.includes(zh)) out.push(zh + "=" + gloss[zh].vi);
  out.sort((a, b) => b.length - a.length); // longer/more specific first
  return out.slice(0, 150);
}
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
process.on("unhandledRejection", (e) => { log("UNHANDLED " + (e && e.message || e)); });

const CHUNK_CHARS = 2400; // ZH chars per API call — VN output ~1.4x this
const CHUNK_PARAS = 50;
// ollama cloud silently drops tool calls whose arguments exceed ~1700
// completion tokens — gemma4 benched OK at 35 paras; cap lower for margin
const CHUNK_CHARS_OL = 1000;
const CHUNK_PARAS_OL = 30;
function chunkParas(paras) {
  const out = []; let cur = [], len = 0;
  const maxChars = api === ol ? CHUNK_CHARS_OL : CHUNK_CHARS;
  const maxParas = api === ol ? CHUNK_PARAS_OL : CHUNK_PARAS;
  for (const p of paras) {
    if (cur.length && (len + p.length > maxChars || cur.length >= maxParas)) {
      out.push(cur); cur = []; len = 0;
    }
    cur.push(p); len += p.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

let api = oc; // set in main() from the card's provider

async function translateChapter(num, key, model) {
  const src = JSON.parse(fs.readFileSync(path.join(SRC_DIR, num + ".json"), "utf8"));
  const paras = (src.paras || []).filter((p) => p && p.trim());
  const chunks = chunkParas(paras);
  const session = path.basename(BOOK_DIR) + "-ch" + num;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  let title = "";
  // translate one chunk; on persistent non-429 failure split it in half —
  // ollama cloud caps tool-call args around ~1700 output tokens, so a few
  // long paragraphs can overflow even a nominally small chunk
  async function runChunk(ps, withTitle) {
    let r, lastErr;
    for (let att = 0; att < 3 && !r; att++) {
      if (stopped) return null;
      try {
        r = await api.callTranslate(
          key, model, SYS, withTitle ? src.title : "", ps, session,
          glossFor(ps.join("")));
      } catch (e) {
        lastErr = e;
        if (e.status === 429) throw e;         // rate-limit: lane requeues
        if (att < 2) await sleep(2500 * (att + 1));
      }
    }
    if (r) return r;
    if (ps.length < 2) throw lastErr;
    log(`split chunk ${ps.length}p (${lastErr && lastErr.message})`);
    const a = await runChunk(ps.slice(0, Math.ceil(ps.length / 2)), withTitle);
    if (a === null) return null;
    const b = await runChunk(ps.slice(Math.ceil(ps.length / 2)), false);
    if (b === null) return null;
    return { title: a.title,
      paragraphs: [...(a.paragraphs || []), ...(b.paragraphs || [])],
      names: [...(a.names || []), ...(b.names || [])] };
  }
  for (let i = 0; i < chunks.length; i++) {
    if (stopped) return null;
    const r = await runChunk(chunks[i], i === 0);
    if (r === null) return null; // stopped mid-chapter
    if (i === 0 && r.title) title = r.title.trim();
    out.push(...(r.paragraphs || []));
    // merge reported names into the book glossary (first rendering wins —
    // later chapters must reuse it for consistency)
    for (const nm of r.names || []) {
      if (!nm || !nm.zh || !nm.vi) continue;
      if (edits[nm.zh] !== undefined) continue; // user's word is final
      const g = gloss[nm.zh];
      if (g) g.n = (g.n || 1) + 1;
      else gloss[nm.zh] = { vi: String(nm.vi).trim(), kind: nm.kind || "other", n: 1, ch: num };
    }
  }
  const viTitle = (title || src.title || "")
    .replace(/^第\s*(\d+)\s*章\s*/, "Chương $1: ");
  fs.writeFileSync(path.join(VI_DIR, num + ".json"),
    JSON.stringify({ num, title: viTitle, paras: out, zh: src.title }));
  indexMap[num] = viTitle;
  saveIndex();
  saveGloss();
  return out.length;
}

(async () => {
  const conf = oc.loadConf();
  const card = ARGS.key
    ? conf.keys.find((k) => k.name === ARGS.key)
    : conf.keys.find((k) => k.name === conf.active) || conf.keys[0];
  // --model=<id> overrides the card's saved model (per-chapter retranslate)
  const model = card && (ARGS.model || card.model);
  if (!card || !card.key || !model) {
    job.status = "error"; job.error = "chưa cấu hình API key/model"; saveJob();
    return;
  }
  api = apiOf(card);
  if (!WORKERS) WORKERS = card.provider === "ollama" ? 4 : 24;
  job.model = model; job.keyName = card.name; job.provider = card.provider || "opencode";
  saveJob();
  log(`start key=${card.name} provider=${job.provider} model=${model} workers=${WORKERS}` +
    (ONLY ? ` only=${ONLY}` : ""));

  // chapter list = zh _index order; skip vi files already on disk
  // (--only skips that check: retranslate even if vi/<n>.json exists)
  const nums = Object.keys(
    JSON.parse(fs.readFileSync(path.join(SRC_DIR, "_index.json"), "utf8")))
    .map(Number).sort((a, b) => a - b);
  const todo = ONLY ? nums.filter((n) => n === ONLY) : nums.filter((n) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(VI_DIR, n + ".json"), "utf8"));
      return !(d.paras && d.paras.length);
    } catch { return true; }
  });
  job.total = todo.length; saveJob();
  log(`todo=${todo.length} of ${nums.length}`);

  // translate the book title once -> meta.titleVi (library/reader display).
  // best-effort: a failure here never blocks chapter work
  if (!ONLY) {
    try {
      const metaFile = path.join(BOOK_DIR, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      if (meta.title && !meta.titleVi) {
        const tr = await api.callTranslate(card.key, model, SYS, "",
          [meta.title], path.basename(BOOK_DIR) + "-title", null);
        const t = (tr.paragraphs || [])[0];
        if (t && t.trim()) {
          meta.titleVi = t.trim();
          fs.writeFileSync(metaFile + ".tmp", JSON.stringify(meta, null, 2));
          fs.renameSync(metaFile + ".tmp", metaFile);
          log("titleVi: " + meta.titleVi);
        }
      }
    } catch (e) { log("titleVi fail: " + (e && e.message || e)); }
  }
  if (!todo.length) { job.status = "done"; saveJob(); return; }

  let cursor = 0, fails = 0;
  async function lane(id) {
    while (!stopped) {
      const n = todo[cursor++]; // single-threaded event loop -> atomic
      if (n === undefined) return;
      try {
        const got = await translateChapter(n, card.key, model);
        if (got === null) return; // stopped mid-chapter
        job.done++; fails = 0; saveJob();
        if (job.done % 5 === 0) log(`+${job.done}/${todo.length}`);
      } catch (e) {
        fails++; job.fail = (job.fail || 0) + 1; saveJob();
        log(`ch${n} fail: ${(e && e.message || e).slice(0, 120)}`);
        // rate-limit -> push back to queue tail and back off this lane
        if (e && e.status === 429) { todo.push(n); await sleep(15000); }
        else if (fails > 25) {
          job.status = "error"; job.error = "quá nhiều lỗi: " + e.message; saveJob();
          stopped = true; return;
        }
      }
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => lane(i)));

  if (job.status === "running") job.status = stopped ? "cancelled" : "done";
  saveJob();
  log(`${job.status}: ${job.done}/${todo.length} fail=${job.fail}`);
})().catch((e) => {
  job.status = "error"; job.error = String(e && e.message || e).slice(0, 200);
  saveJob(); log("FATAL " + job.error);
});
