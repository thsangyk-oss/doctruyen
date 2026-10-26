// Ollama-compatible translation client — three deployments share this file:
//   cloud  = Ollama Cloud https://ollama.com (Bearer key)
//   local  = llama.cpp server on this machine (:8399, eGPU Gemma, no key)
// Cloud ignores structured-output params, so it uses a forced tool call;
// llama.cpp natively enforces response_format json_schema via grammars —
// guaranteed-JSON content, no tool round-trip needed.
const UA = "doctruyen-translator/1.0";

function makeClient(BASE, llama) {
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

  // model discovery: /v1/models on llama.cpp, /api/tags on Ollama
  async function fetchModels(key) {
    if (llama) {
      const r = await fetch(BASE + "/v1/models", {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      const j = await r.json();
      return (j.data || []).map((m) => ({
        id: m.id,
        name: String(m.id).split(/[\\/]/).pop(),
        family: "llamacpp",
      }));
    }
    const r = await fetch(BASE + "/api/tags", {
      headers: { ...(key ? { "Authorization": "Bearer " + key } : {}), "User-Agent": UA },
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
    if (llama) required.push("names"); // keep the glossary populated
    if (zhTitle) {
      schemaProps.title_vi = { type: "string",
        description: "Vietnamese chapter title: 第N章 … -> \"Chương N: …\"." };
      required.push("title_vi");
    }
    if (llama) {
      // grammar-constrained JSON — content is the payload itself
      const r = await post(BASE + "/v1/chat/completions", {}, {
        model,
        messages: [
          { role: "system", content: sysPrompt + "\nTrả về JSON đúng schema." },
          { role: "user", content: "Dịch sang tiếng Việt:\n" +
            JSON.stringify({
              title_zh: zhTitle || undefined,
              known_names: gloss || undefined,
              paragraphs_zh: paras,
            }) },
        ],
        response_format: { type: "json_schema", json_schema: {
          name: "translation",
          schema: { type: "object", properties: schemaProps, required } } },
        chat_template_kwargs: { enable_thinking: false }, // gemma4 thinking burns 5x tokens
        temperature: 0.3,
        max_tokens: 8192,
      }, 600000);
      if (r.status !== 200) throw httpErr(r);
      const c = (((r.json || {}).choices || [])[0] || {}).message || {};
      let args;
      try { args = JSON.parse(c.content || "{}"); }
      catch { throw new Error("bad json in response"); }
      return { title: args.title_vi,
        paragraphs: checkOut(args.paragraphs, paras.length),
        names: args.names || [] };
    }
    const userText = "Dịch sang tiếng Việt và gọi tool submit_translation:\n" +
      JSON.stringify({
        title_zh: zhTitle || undefined,
        known_names: gloss || undefined,
        paragraphs_zh: paras,
      });
    const r = await post(BASE + "/v1/chat/completions",
      key ? { "Authorization": "Bearer " + key } : {}, {
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
      // some models answer with JSON text instead of a tool call —
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

  return { BASE, fetchModels, callTranslate };
}

const cloud = makeClient("https://ollama.com");
// llama.cpp server on this machine — Gemma4-12B on the eGPU (Vulkan).
// No key; model stays resident in VRAM while the daemon runs.
const local = makeClient("http://localhost:8399", true);

module.exports = { BASE: cloud.BASE, fetchModels: cloud.fetchModels, callTranslate: cloud.callTranslate, local };
