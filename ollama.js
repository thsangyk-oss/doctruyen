// Ollama Cloud API client — https://ollama.com
// Auth: Bearer <api key> (ollama.com account settings). Free plan serves a
// subset of models (402 for the rest); structured-output params (format /
// response_format json_schema) are silently ignored by cloud models, so
// output is forced through a submit_translation tool call like opencode.js.
const BASE = "https://ollama.com";
const UA = "doctruyen-translator/1.0";

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

// GET /api/tags lists the models available on the account's plan
async function fetchModels(key) {
  const r = await fetch(BASE + "/api/tags", {
    headers: { "Authorization": "Bearer " + key, "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return (j.models || []).map((m) => ({
    id: m.name || m.model,
    name: m.name || m.model,
    family: "ollama",
  }));
}

const MOCK = !!process.env.MOCK_TRANSLATE;

function checkOut(ps, nIn) {
  if (!Array.isArray(ps) || !ps.length) throw new Error("empty paragraphs");
  if (ps.length > nIn * 2) throw new Error("junk output: " + ps.length + "/" + nIn);
  if (ps.length < Math.ceil(nIn / 2)) throw new Error("truncated: " + ps.length + "/" + nIn);
  return ps;
}

// Same contract as opencode.callTranslate:
// {title?, paragraphs: string[], names: [{zh,vi,kind}]} or throws.
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
      known_names: gloss || undefined,
      paragraphs_zh: paras,
    });
  const r = await post(BASE + "/v1/chat/completions",
    { "Authorization": "Bearer " + key }, {
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
      tool_choice: "required",
      temperature: 0.3,
      max_tokens: 8192,
    });
  if (r.status !== 200) throw httpErr(r);
  const tc = (((r.json || {}).choices || [])[0] || {}).message || {};
  const call = (tc.tool_calls || [])[0];
  let args;
  if (call) args = JSON.parse(call.function.arguments);
  else {
    // some cloud models answer with JSON text instead of a tool call —
    // rescue it (strip markdown fences) before declaring failure
    const m = (tc.content || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no tool_call in response");
    try { args = JSON.parse(m[0]); }
    catch { throw new Error("no tool_call in response"); }
  }
  return { title: args.title_vi, paragraphs: checkOut(args.paragraphs, paras.length), names: args.names || [] };
}

function httpErr(r) {
  const msg = (r.json && (r.json.error && (r.json.error.message || r.json.error) ||
    r.json.message)) || r.text.slice(0, 160);
  const e = new Error("HTTP " + r.status + ": " + msg);
  e.status = r.status;
  return e;
}

module.exports = { BASE, fetchModels, callTranslate };
