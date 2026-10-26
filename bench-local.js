// Local-model translation bench — same pipeline as translate.js but talks to a
// local OpenAI-compatible endpoint (llama.cpp :8399 or ollama :11434) and writes
// to <dir>/vi_e2b/ so production vi/ output is untouched.
//   node bench-local.js --dir=data/books/cn-95040348 --from=1 --to=10 [--endpoint=http://localhost:8399]
const fs = require("fs");
const path = require("path");

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});
const BOOK_DIR = ARGS.dir;
const SRC_DIR = path.join(BOOK_DIR, "chapters");
const OUT_DIR = path.join(BOOK_DIR, ARGS.out || "vi_e2b");
const ENDPOINT = (ARGS.endpoint || "http://localhost:8399").replace(/\/$/, "");
const THINK = ARGS.think !== "0" && ARGS.think !== "false";
const FROM = +ARGS.from || 1, TO = +ARGS.to || 10;
fs.mkdirSync(OUT_DIR, { recursive: true });

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

const CHUNK_CHARS = 1000, CHUNK_PARAS = 30; // ollama-safe sizes from translate.js
function chunkParas(paras) {
  const out = []; let cur = [], len = 0;
  for (const p of paras) {
    if (cur.length && (len + p.length > CHUNK_CHARS || cur.length >= CHUNK_PARAS)) {
      out.push(cur); cur = []; len = 0;
    }
    cur.push(p); len += p.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// seed bench glossary from the book's production glossary + user edits
const VI_DIR = path.join(BOOK_DIR, "vi");
const gloss = {};
try { Object.assign(gloss, JSON.parse(fs.readFileSync(path.join(VI_DIR, "_glossary.json"), "utf8"))); } catch {}
try {
  const edits = JSON.parse(fs.readFileSync(path.join(VI_DIR, "_glossary.edits.json"), "utf8"));
  for (const zh in edits) {
    if (edits[zh] === null) delete gloss[zh];
    else gloss[zh] = { vi: edits[zh].vi, kind: edits[zh].kind || "other", n: 1 };
  }
} catch {}
console.log("glossary seeded:", Object.keys(gloss).length, "terms");
function glossFor(text) {
  const out = [];
  for (const zh in gloss) if (text.includes(zh)) out.push(zh + "=" + gloss[zh].vi);
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 150);
}
const saveGloss = () =>
  fs.writeFileSync(path.join(OUT_DIR, "_glossary.json"), JSON.stringify(gloss));

function checkOut(ps, nIn) {
  if (!Array.isArray(ps) || !ps.length) throw new Error("empty paragraphs");
  if (ps.length > nIn * 2) throw new Error("junk output: " + ps.length + "/" + nIn);
  if (ps.length < Math.ceil(nIn / 2)) throw new Error("truncated: " + ps.length + "/" + nIn);
  return ps;
}

const stats = { prompt: 0, completion: 0, calls: 0, rescues: 0, splits: 0 };
async function callTranslate(zhTitle, paras, glossArr) {
  const schemaProps = {
    paragraphs: { type: "array", items: { type: "string" },
      description: "Translated paragraphs, same order and same count as input." },
    names: { type: "array", items: { type: "object",
      properties: {
        zh: { type: "string", description: "Original Chinese term, e.g. 严望" },
        vi: { type: "string", description: "Vietnamese rendering used, e.g. Nghiêm Vọng" },
        kind: { type: "string", description: "person | place | org | item | other" },
      }, required: ["zh", "vi"] },
      description: "Proper nouns appearing in this chunk." },
  };
  const required = ["paragraphs"];
  if (zhTitle) {
    schemaProps.title_vi = { type: "string",
      description: "Vietnamese chapter title: 第N章 … -> \"Chương N: …\"." };
    required.push("title_vi");
  }
  const userText = "Dịch sang tiếng Việt và gọi tool submit_translation:\n" +
    JSON.stringify({ title_zh: zhTitle || undefined,
      known_names: glossArr && glossArr.length ? glossArr : undefined,
      paragraphs_zh: paras });
  const body = {
    model: "gemma4-e2b",
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: userText },
    ],
    tools: [{ type: "function", function: {
      name: "submit_translation",
      description: "Submit the Vietnamese translation.",
      parameters: { type: "object", properties: schemaProps, required },
    } }],
    tool_choice: "required",
    temperature: 0.3,
    max_tokens: 8192,
  };
  if (!THINK) body.chat_template_kwargs = { enable_thinking: false };
  const r = await fetch(ENDPOINT + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status + ": " + (await r.text()).slice(0, 150)); e.status = r.status; throw e; }
  const j = await r.json();
  if (j.usage) { stats.prompt += j.usage.prompt_tokens || 0;
    stats.completion += j.usage.completion_tokens || 0; stats.calls++; }
  const msg = ((j.choices || [])[0] || {}).message || {};
  const call = (msg.tool_calls || [])[0];
  let args;
  if (call) args = JSON.parse(call.function.arguments);
  else {
    const m = (msg.content || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no tool_call in response");
    stats.rescues++;
    args = JSON.parse(m[0]);
  }
  return { title: args.title_vi,
    paragraphs: checkOut(args.paragraphs, paras.length), names: args.names || [] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateChapter(num) {
  const src = JSON.parse(fs.readFileSync(path.join(SRC_DIR, num + ".json"), "utf8"));
  const paras = (src.paras || []).filter((p) => p && p.trim());
  const chunks = chunkParas(paras);
  const out = []; let title = "";
  async function runChunk(ps, withTitle) {
    let r, lastErr;
    for (let att = 0; att < 3 && !r; att++) {
      try {
        r = await callTranslate(withTitle ? src.title : "", ps, glossFor(ps.join("")));
      } catch (e) { lastErr = e; if (att < 2) await sleep(1500 * (att + 1)); }
    }
    if (r) return r;
    if (ps.length < 2) throw lastErr;
    stats.splits++;
    const a = await runChunk(ps.slice(0, Math.ceil(ps.length / 2)), withTitle);
    const b = await runChunk(ps.slice(Math.ceil(ps.length / 2)), false);
    return { title: a.title,
      paragraphs: [...(a.paragraphs || []), ...(b.paragraphs || [])],
      names: [...(a.names || []), ...(b.names || [])] };
  }
  for (let i = 0; i < chunks.length; i++) {
    const r = await runChunk(chunks[i], i === 0);
    if (i === 0 && r.title) title = r.title.trim();
    out.push(...(r.paragraphs || []));
    for (const nm of r.names || []) {
      if (!nm || !nm.zh || !nm.vi) continue;
      const g = gloss[nm.zh];
      if (g) g.n = (g.n || 1) + 1;
      else gloss[nm.zh] = { vi: String(nm.vi).trim(), kind: nm.kind || "other", n: 1, ch: num };
    }
  }
  const viTitle = (title || src.title || "")
    .replace(/^第\s*(\d+)\s*章\s*/, "Chương $1: ");
  fs.writeFileSync(path.join(OUT_DIR, num + ".json"),
    JSON.stringify({ num, title: viTitle, paras: out, zh: src.title }));
  return { paras: out.length, zhParas: paras.length, chunks: chunks.length,
    zhChars: paras.join("").length };
}

(async () => {
  console.log(`endpoint=${ENDPOINT} think=${THINK} chapters=${FROM}-${TO}`);
  const rows = [];
  for (let n = FROM; n <= TO; n++) {
    const t0 = Date.now();
    try {
      const r = await translateChapter(n);
      const dt = (Date.now() - t0) / 1000;
      rows.push({ ch: n, ...r, secs: +dt.toFixed(1) });
      console.log(`ch${n}: ${r.zhParas}p/${r.zhChars}chars -> ${r.paras}p in ${r.chunks} chunks, ${dt.toFixed(1)}s`);
      saveGloss();
    } catch (e) {
      rows.push({ ch: n, error: e.message });
      console.log(`ch${n}: FAIL ${e.message}`);
    }
  }
  const ok = rows.filter((r) => !r.error);
  const total = ok.reduce((s, r) => s + r.secs, 0);
  console.log("\n=== SUMMARY ===");
  console.log(`chapters ok: ${ok.length}/${rows.length}, splits=${stats.splits}, json-rescues=${stats.rescues}`);
  console.log(`total wall: ${total.toFixed(0)}s, avg ${ok.length ? (total / ok.length).toFixed(1) : "-"}s/ch`);
  console.log(`tokens: prompt=${stats.prompt} completion=${stats.completion} calls=${stats.calls}`);
  fs.writeFileSync(path.join(OUT_DIR, "_bench.json"), JSON.stringify({ rows, stats, think: THINK }, null, 2));
})();
