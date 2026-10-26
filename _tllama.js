// test llamacpp :8399 — json_schema response_format translation
const paras = [
  "李云飞睁开眼睛，发现自己躺在大学宿舍的床上。",
  "\"我重生了？\"他喃喃自语，拿起床头的诺基亚手机——2008年9月15日。",
  "窗外秋日的阳光洒在书桌上，室友王胖子还在呼呼大睡。",
];
const schema = {
  type: "object",
  properties: {
    paragraphs: { type: "array", items: { type: "string" } },
    names: { type: "array", items: { type: "object",
      properties: { zh: { type: "string" }, vi: { type: "string" }, kind: { type: "string" } },
      required: ["zh", "vi"] } },
  },
  required: ["paragraphs"],
};
const t0 = Date.now();
fetch("http://localhost:8399/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "C:/Users/ADMIN/models/Gemma4-12B-Uncensored-1M-Q4.gguf",
    messages: [
      { role: "system", content: "Bạn là dịch giả tiểu thuyết Trung→Việt. Dịch tự nhiên, tên riêng theo Hán-Việt (vd 李云飞 → Lý Vân Phi). Trả về JSON theo schema." },
      { role: "user", content: "Dịch sang tiếng Việt:\n" + JSON.stringify({ paragraphs_zh: paras }) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "translation", schema } },
    temperature: 0.3,
    max_tokens: 4000,
  }),
}).then(async (r) => {
  const j = await r.json();
  console.log("status", r.status, "|", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  if (r.status !== 200) { console.log("ERR", JSON.stringify(j).slice(0, 500)); return; }
  const c = ((j.choices || [])[0] || {}).message || {};
  console.log("usage:", JSON.stringify(j.usage));
  try {
    const a = JSON.parse(c.content);
    (a.paragraphs || []).forEach((p, i) => console.log(" " + (i + 1) + ".", p));
    console.log("names:", JSON.stringify(a.names || []));
  } catch (e) { console.log("raw content:", (c.content || "").slice(0, 600)); }
}).catch((e) => console.log("ERR", e.message));
