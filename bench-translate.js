// One-off model benchmark: translate the same chapter with each candidate
// model, report wall time + paragraph count + sample. Usage:
//   node bench-translate.js --dir=data/books/cn-hy-157662 --ch=3 [--models=a,b,c]
const fs = require("fs");
const path = require("path");
const oc = require("./opencode");

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});

const SYS = [
  "Bạn là dịch giả chuyên dịch tiểu thuyết mạng Trung Quốc sang tiếng Việt.",
  "Dịch tự nhiên, trôi chảy, giữ đúng văn phong truyện; KHÔNG bỏ sót hay thêm đoạn.",
  "Giữ nguyên số lượng và thứ tự đoạn văn (paragraphs_zh -> paragraphs).",
  "Tên riêng dịch theo Hán-Việt thông dụng (严望 -> Nghiêm Vọng…).",
  "Nếu có title_zh, dịch sang tiếng Việt giữ số chương: \"第N章 …\" -> \"Chương N: …\".",
].join("\n");

const MODELS = (ARGS.models || [
  "muse-spark-1.3-contributor", "muse-spark-1.2-contributor",
  "glm-5.3-flash", "deepseek-v4-flash", "deepseek-v4.1-flash",
  "mimo-v2.6-flash", "qwen3.8-flash", "longcat-2.5-preview-free",
].join(",")).split(",");

(async () => {
  const conf = oc.loadConf();
  const card = conf.keys[0];
  const ch = +ARGS.ch || 3;
  const src = JSON.parse(
    fs.readFileSync(path.join(ARGS.dir, "chapters", ch + ".json"), "utf8"));
  const paras = src.paras.filter((p) => p && p.trim());
  const chars = paras.join("").length;
  console.log(`chapter ${ch}: ${paras.length} paras, ${chars} zh chars`);
  console.log(`${"model".padEnd(30)} ${"family".padEnd(9)} ${"time".padStart(7)} ${"paras".padStart(6)}  sample`);
  for (const m of MODELS) {
    const t0 = Date.now();
    try {
      const r = await oc.callTranslate(card.key, m, SYS, src.title, paras, "bench-" + m);
      const dt = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      const got = (r.paragraphs || []).length;
      const sample = (r.paragraphs && r.paragraphs[0] || "").slice(0, 60);
      console.log(`${m.padEnd(30)} ${oc.familyOf(m).padEnd(9)} ${dt.padStart(7)} ${String(got).padStart(6)}  ${sample}`);
      console.log(`    title: ${r.title || "(none)"}`);
      fs.writeFileSync("bench-" + m + ".json", JSON.stringify(r, null, 2), "utf8");
    } catch (e) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      console.log(`${m.padEnd(30)} ${oc.familyOf(m).padEnd(9)} ${dt.padStart(7)}      -  FAIL ${e.message.slice(0, 80)}`);
    }
  }
})();
