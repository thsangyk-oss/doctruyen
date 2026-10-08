// One-shot repair: some chapter JSONs stored paras with raw HTML inside
// (API content came as "<p>...</p>" markup instead of plain text).
// Re-normalize every chapter file: HTML -> plain paragraphs.
// Idempotent — files already clean are untouched.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data", "books");

const ent = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function cleanPara(p, title) {
  // strip a leading <!DOCTYPE ...> header blob baked into the content
  let s = p.replace(/^\s*<!DOCTYPE[^>]*>/i, "");
  // tag boundaries become paragraph breaks
  s = s.replace(/<\/p\s*>/gi, "\n").replace(/<p[^>]*>/gi, "\n")
       .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|li|h\d)\s*>/gi, "\n")
       .replace(/<br\s*\/?\s*$/gim, ""); // truncated "<br /" fragment at para end
  s = s.replace(/<[^>]+>/g, ""); // drop every remaining tag
  s = ent(s);
  return s.split("\n").map((x) => x.trim()).filter((x) => {
    if (!x) return false;
    // drop a bare repeated header line ("Chương 4: Thảm họa?" echo)
    if (title && /^Chương\s*\d+\s*[:.]/i.test(x)) return false;
    return true;
  });
}

let fixed = 0, scanned = 0;
for (const id of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, id, "chapters");
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    scanned++;
    const fp = path.join(dir, f);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
    if (!Array.isArray(d.paras)) continue;
    const needsFix = d.paras.some((p) => /<\/?(p|div|br|span|h\d|content|!DOCTYPE)[\s\/>]/i.test(p));
    if (!needsFix) continue;
    const paras = d.paras.flatMap((p) => cleanPara(p, d.title));
    fs.writeFileSync(fp, JSON.stringify({ ...d, paras, empty: paras.length === 0 }));
    fixed++;
  }
}
console.log(`scanned ${scanned} files, fixed ${fixed}`);
