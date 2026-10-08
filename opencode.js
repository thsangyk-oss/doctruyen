// OpenCode Go API client — https://opencode.ai/zen/go/v1
// Auth: Bearer <api key> from OpenCode Console (Go / Go Plus subscription).
// Three endpoint families depending on model (per opencode.ai/docs/go):
//   chat/completions — OpenAI-compatible (GLM, Kimi, DeepSeek, MiMo, LongCat…)
//   messages         — Anthropic-compatible (MiniMax, Qwen3.x)
//   responses        — OpenAI Responses API (Grok, GPT Luna, Muse Spark)
// Translation output is forced through a `submit_translation` tool call so the
// model returns structured paragraphs instead of free text.
const fs = require("fs");
const path = require("path");

const BASE = "https://opencode.ai/zen/go/v1";
const UA = "doctruyen-translator/1.0"; // docs: identify with own user agent

// model -> endpoint family; unknown ids fall back to "chat"
const FAMILY = {
  "grok-4.7": "responses", "grok-4.6": "responses",
  "gpt-6-luna": "responses", "gpt-5.6-luna": "responses",
  "muse-spark-1.3-contributor": "responses",
  "muse-spark-1.2-contributor": "responses",
  "minimax-m3": "messages", "minimax-m2.7": "messages",
  "qwen3.8-max": "messages", "qwen3.8-flash": "messages",
  "qwen3.7-plus": "messages", "qwen3.7-max": "messages",
};
const familyOf = (m) => FAMILY[m] || "chat";

const TOOL_DESC = {
  paragraphs: { type: "array", items: { type: "string" },
    description: "Translated paragraphs, same order and same count as input." },
};

// ---- config store: data/translate.json ---------------------------------
const DATA_DIR = path.join(__dirname, "data");
const CONF_FILE = path.join(DATA_DIR, "translate.json");
function loadConf() {
  try { return JSON.parse(fs.readFileSync(CONF_FILE, "utf8")); }
  catch { return { keys: [], active: null }; }
}
function saveConf(c) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONF_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONF_FILE);
}
const maskKey = (k) => k.length > 10 ? k.slice(0, 6) + "…" + k.slice(-4) : "****";

// ---- HTTP ---------------------------------------------------------------
async function post(url, headers, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 300000);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", "User-Agent": UA, ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

async function fetchModels(key) {
  const r = await fetch(BASE + "/models", {
    headers: { "Authorization": "Bearer " + key, "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  const list = (j && j.data) || [];
  return list.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    family: familyOf(m.id),
  }));
}

// Mock for offline tests: MOCK_TRANSLATE=1 echoes pseudo-translations.
const MOCK = !!process.env.MOCK_TRANSLATE;

// One call that translates a chunk of paragraphs via a forced tool call.
// Returns { paragraphs: string[], title?: string } or throws.
// Output sanity: empty / wildly-oversized / heavily-truncated paragraph lists
// are rejected (mimo once answered with 4431 junk items for a 36-para input).
function checkOut(ps, nIn) {
  if (!Array.isArray(ps) || !ps.length) throw new Error("empty paragraphs");
  if (ps.length > nIn * 2) throw new Error("junk output: " + ps.length + "/" + nIn);
  if (ps.length < Math.ceil(nIn / 2)) throw new Error("truncated: " + ps.length + "/" + nIn);
  return ps;
}
async function callTranslate(key, model, sysPrompt, zhTitle, paras, session, gloss) {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 30));
    return {
      title: zhTitle ? "[VI] " + zhTitle : undefined,
      paragraphs: paras.map((p) => "[dịch] " + p),
      names: [{ zh: "严望", vi: "Nghiêm Vọng", kind: "person" }],
    };
  }
  const schemaProps = {
    paragraphs: { type: "array", items: { type: "string" },
      description: "Translated paragraphs, same order and same count as input." },
    // per-book glossary feed: model reports proper nouns it just used so the
    // worker can inject the established translations into later chapters
    names: { type: "array", items: { type: "object",
      properties: {
        zh: { type: "string", description: "Original Chinese term, e.g. 严望" },
        vi: { type: "string", description: "Vietnamese rendering used, e.g. Nghiêm Vọng" },
        kind: { type: "string",
          description: "person | place | org | item | other" },
      },
      required: ["zh", "vi"] },
      description: "Proper nouns (people, places, orgs, items…) appearing in this chunk. Include names already in known_names too." },
  };
  const required = ["paragraphs"];
  if (zhTitle) {
    schemaProps.title_vi = { type: "string",
      description: "Vietnamese chapter title: 第N章 … -> \"Chương N: …\"." };
    required.push("title_vi");
  }
  const userText = "Dịch sang tiếng Việt và gọi tool submit_translation:\n" +
    JSON.stringify({
      title_zh: zhTitle || undefined,
      known_names: gloss || undefined, // established zh->vi glossary to reuse
      paragraphs_zh: paras,
    });
  const fam = familyOf(model);
  if (fam === "chat") {
    const body = {
      model,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userText },
      ],
      tools: [{
        type: "function",
        function: {
          name: "submit_translation",
          description: "Submit the Vietnamese translation.",
          parameters: { type: "object", properties: schemaProps, required },
        },
      }],
      // "required" is the safest force-call value — some models (kimi) reject
      // named tool_choice, and there's only one tool anyway
      tool_choice: "required",
      temperature: 0.3,
      max_tokens: 8192,
    };
    // DeepSeek thinking mode doesn't allow tool calls — force it off
    if (/^deepseek/.test(model)) body.thinking = { type: "disabled" };
    const r = await post(BASE + "/chat/completions",
      { "Authorization": "Bearer " + key, "x-opencode-session": session }, body);
    if (r.status !== 200) throw httpErr(r);
    const tc = (((r.json || {}).choices || [])[0] || {}).message || {};
    const call = (tc.tool_calls || [])[0];
    if (!call) throw new Error("no tool_call in response");
    const args = JSON.parse(call.function.arguments);
    return { title: args.title_vi, paragraphs: checkOut(args.paragraphs, paras.length), names: args.names || [] };
  }
  if (fam === "messages") {
    const r = await post(BASE + "/messages",
      { "x-api-key": key, "Authorization": "Bearer " + key,
        "anthropic-version": "2023-06-01", "x-opencode-session": session }, {
        model,
        max_tokens: 8192,
        system: sysPrompt,
        // gateway rejects plain-string content — send typed text blocks
        messages: [{ role: "user",
          content: [{ type: "text", text: userText }] }],
        tools: [{
          name: "submit_translation",
          description: "Submit the Vietnamese translation.",
          input_schema: { type: "object", properties: schemaProps, required },
        }],
        // gateway 400s on forced {type:"tool"} — "auto" still calls it
        tool_choice: { type: "auto" },
      });
    if (r.status !== 200) throw httpErr(r);
    const blk = ((r.json || {}).content || []).find((b) => b.type === "tool_use");
    if (!blk) throw new Error("no tool_use block in response");
    return { title: blk.input.title_vi,
      paragraphs: checkOut(blk.input.paragraphs, paras.length),
      names: blk.input.names || [] };
  }
  // OpenAI Responses API (grok / gpt-*-luna / muse-spark)
  const r = await post(BASE + "/responses",
    { "Authorization": "Bearer " + key, "x-opencode-session": session }, {
      model,
      input: [
        { role: "developer", content: [{ type: "input_text", text: sysPrompt }] },
        { role: "user", content: [{ type: "input_text", text: userText }] },
      ],
      tools: [{
        type: "function",
        name: "submit_translation",
        description: "Submit the Vietnamese translation.",
        parameters: { type: "object", properties: schemaProps, required },
      }],
      // this gateway only accepts "auto" for Responses models — the prompt +
      // tool description still drive the model to call submit_translation
      tool_choice: "auto",
    });
  if (r.status !== 200) throw httpErr(r);
  const it = ((r.json || {}).output || [])
    .find((o) => o.type === "function_call" && o.name === "submit_translation");
  if (!it) throw new Error("no function_call in response");
  const args = JSON.parse(it.arguments);
  return { title: args.title_vi, paragraphs: checkOut(args.paragraphs, paras.length), names: args.names || [] };
}

function httpErr(r) {
  const msg = (r.json && (r.json.error && (r.json.error.message || r.json.error) ||
    r.json.message)) || r.text.slice(0, 160);
  const e = new Error("HTTP " + r.status + ": " + msg);
  e.status = r.status;
  return e;
}

module.exports = { BASE, familyOf, fetchModels, callTranslate, loadConf, saveConf, maskKey };
