// Per-book scrape worker for CN-original sources — spawned by server.js.
// Currently: m.akshu88.com + www.hongyebookzhai.com (both JieQi-style CMS).
// Plain HTTP fetch is enough: no Cloudflare, no rate limit seen (~100ms/req).
// Pages are GBK-encoded — TextDecoder('gbk') handles it.
// Usage: node scrape-akshu.js --dir=<book dir> [--book=<id>] [--max=<n>]
//        [--delay=250] [--cover-only]
// Writes: <dir>/chapters/<n>.json, chapters/_index.json, chapters/_cidmap.json
//         (num -> source chapter id), job.json, meta.json, scrape.log
//
// Site layouts:
//   akshu88  index /book/<bid>.html (+ catalog paged /book/<bid>/<p>/, 45/pg)
//            chapter /book/<bid>/<cid>.html, sub-pages /<cid>_<k>.html
//   hongye   index /shuzhai/<bid>/  (whole catalog on ONE page, after dt "》正文")
//            chapter /shuzhai/<bid>/<cid>.html (+ optional _<k> pages)
//
// Anti-scrape quirk: some chapters repeat their tail paragraphs several
// times inside #content, separated by a "请关闭浏览器…" warning line, and a
// fake "_2" page may echo the tail again (zero new content). Dedup rule:
// split #content on warning lines into blocks; a block whose paragraphs are
// mostly (>=60%) already collected for this chapter is poison — skip it.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});
const BOOK_DIR = ARGS.dir;
if (!BOOK_DIR) { console.error("need --dir"); process.exit(2); }
const META_FILE = path.join(BOOK_DIR, "meta.json");
const OUT_DIR = path.join(BOOK_DIR, "chapters");
const JOB_FILE = path.join(BOOK_DIR, "job.json");
const CIDMAP_FILE = path.join(OUT_DIR, "_cidmap.json"); // num -> source cid
const DUPCIDS_FILE = path.join(OUT_DIR, "_dupcids.json"); // cid -> kept num
fs.mkdirSync(OUT_DIR, { recursive: true });
const MAX_CHAPS = +ARGS.max || 0;   // test hook: stop after N chapters
const DELAY = +ARGS.delay || 250;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// per-source URL shapes — both are JieQi-derived so they differ only slightly
const SITES = {
  akshu88: {
    origin: "https://m.akshu88.com",
    indexUrl: (bid) => `/book/${bid}.html`,
    catalogUrl: (bid, p) => `/book/${bid}/${p}/`,
    chapUrl: (bid, cid, pg) => pg === 1
      ? `/book/${bid}/${cid}.html` : `/book/${bid}/${cid}_${pg}.html`,
    // catalog = links appearing after this marker on an index page
    catalogAnchor: 'id="first"',
    catalogRe: (bid) => new RegExp(
      "href=[\"']https?://m\\.akshu88\\.com/book/" + bid + "/(\\d+)\\.html[\"'][^>]*>([^<]+)", "g"),
    pagedCatalog: true,
  },
  hongye: {
    origin: "https://www.hongyebookzhai.com",
    indexUrl: (bid) => `/shuzhai/${bid}/`,
    catalogUrl: null, // single-page catalog
    chapUrl: (bid, cid, pg) => pg === 1
      ? `/shuzhai/${bid}/${cid}.html` : `/shuzhai/${bid}/${cid}_${pg}.html`,
    catalogAnchor: "》正文</dt>", // <dt>《TITLE》正文</dt> precedes the full list
    catalogRe: (bid) => new RegExp(
      "href=[\"']\\/?shuzhai\\/" + bid + "\\/(\\d+)\\.html[\"'][^>]*>([^<]+)", "g"),
    pagedCatalog: false,
  },
};
let SITE = SITES.akshu88.origin; // resolved per-book in main()
let SITECFG = SITES.akshu88;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("unhandledRejection", (e) => {
  try {
    fs.appendFileSync(JOB_FILE + ".log",
      new Date().toISOString() + " UNHANDLED " + String(e && e.stack || e).slice(0, 500) + "\n");
  } catch {}
});
process.on("uncaughtException", (e) => {
  try {
    fs.appendFileSync(JOB_FILE + ".log",
      new Date().toISOString() + " UNCAUGHT " + String(e && e.stack || e).slice(0, 500) + "\n");
  } catch {}
  process.exit(1);
});

// sequential crawler (no proxy lanes on this source) — still report stats
// so the library UI shows worker count consistently
const job = { status: "running", done: 0, total: 0, fail: 0, updated: Date.now(), stats: { w: 1 } };
function saveJob() {
  job.updated = Date.now();
  try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), "utf8"); } catch {}
}
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; }
}
function saveMeta(patch) {
  const m = readMeta();
  Object.assign(m, patch);
  try { fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2), "utf8"); } catch {}
}
function have(n) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, n + ".json"), "utf8"));
    return d.paras && d.paras.length;
  } catch { return false; }
}
function logLine(s) {
  try {
    fs.appendFileSync(path.join(BOOK_DIR, "scrape.log"),
      new Date().toISOString().slice(11, 19) + " " + s + "\n");
  } catch {}
}

const INDEX_FILE = path.join(OUT_DIR, "_index.json");
const indexMap = {};
try { Object.assign(indexMap, JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"))); } catch {}
let indexDirty = false;
setInterval(() => {
  if (!indexDirty) return;
  indexDirty = false;
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(indexMap)); } catch {}
  try { fs.writeFileSync(CIDMAP_FILE, JSON.stringify(cidMap)); } catch {}
}, 2000).unref();

const cidMap = {}; // num -> cid
try { Object.assign(cidMap, JSON.parse(fs.readFileSync(CIDMAP_FILE, "utf8"))); } catch {}

// Same chapter listed twice under different cids happens (hongye 157662 has
// 第1173章 ×2, byte-identical). Keep the FIRST catalog occurrence; the loser
// cid goes to _dupcids.json so update runs skip it without re-downloading.
const dupcids = {};
try { Object.assign(dupcids, JSON.parse(fs.readFileSync(DUPCIDS_FILE, "utf8"))); } catch {}
const hashByNum = new Map();
const chHash = (t, ps) =>
  crypto.createHash("sha1").update(t + "\u0000" + ps.join("\u0000")).digest("hex");
const EMPTY_HASH = chHash("", []);
function fileHash(n) { // lazy: read the file only if this run didn't write it
  if (!hashByNum.has(n)) {
    let h = null;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, n + ".json"), "utf8"));
      if (d.paras && d.paras.length) h = chHash(d.title || "", d.paras);
    } catch {}
    hashByNum.set(n, h);
  }
  return hashByNum.get(n);
}
function dupOf(n, nums) { // earlier catalog num whose file is identical to n's
  const h = fileHash(n);
  if (!h || h === EMPTY_HASH) return 0;
  for (const m of nums) {
    if (m >= n) break;
    if (fileHash(m) === h) return m;
  }
  return 0;
}
function dropDup(n, cid, keptNum) {
  try { fs.unlinkSync(path.join(OUT_DIR, n + ".json")); } catch {}
  hashByNum.delete(n);
  delete indexMap[n]; delete cidMap[n];
  dupcids[cid] = keptNum; indexDirty = true;
  try { fs.writeFileSync(DUPCIDS_FILE, JSON.stringify(dupcids)); } catch {}
}

function saveChap(n, title, paras, cid, empty) {
  fs.writeFileSync(path.join(OUT_DIR, n + ".json"),
    JSON.stringify({ num: n, title, paras, empty: !!empty }));
  indexMap[n] = title || "";
  if (cid) cidMap[n] = cid;
  hashByNum.set(n, chHash(title || "", paras || []));
  indexDirty = true;
}

// ---- fetch: GBK decode, small retry ------------------------------------
async function get(url, tries) {
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 25000);
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      });
      if (r.status === 404) { clearTimeout(t); return { status: 404, text: "" }; }
      if (r.status !== 200) { clearTimeout(t); await sleep(800 * (i + 1)); continue; }
      const buf = Buffer.from(await r.arrayBuffer()); // still under the timeout
      clearTimeout(t);
      return { status: 200, text: new TextDecoder("gbk").decode(buf) };
    } catch (e) {
      if (i === (tries || 3) - 1) return { status: "err", err: String(e && e.message || e).slice(0, 80) };
      await sleep(800 * (i + 1));
    }
  }
  return { status: "err", err: "retry-exhausted" };
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "");

// ---- index / catalog ----------------------------------------------------
const og = (text, prop) => {
  const re = new RegExp(
    '<meta[^>]*?(?:property=["\']og:' + prop + '["\'][^>]*?content=["\']([^"\']*)' +
    '|content=["\']([^"\']*)["\'][^>]*?property=["\']og:' + prop + ')', "i");
  const m = text.match(re);
  return m && (m[1] || m[2]);
};
function parseBookPage(text, bid) {
  const info = {};
  // og:novel:* tags (hongye) first — cleaner than layout scraping
  info.title = og(text, "novel:book_name") || og(text, "title") || "";
  info.author = og(text, "novel:author") || "";
  info.cover = og(text, "image") || "";
  if (!info.title) {
    const h1 = text.match(/<div class="info">[\s\S]*?<h1>([\s\S]*?)<\/h1>/);
    if (h1) info.title = stripTags(h1[1]).trim();
  }
  if (!info.author) {
    const au = text.match(/作&nbsp;&nbsp;者[：:]\s*([^<]+)</);
    if (au) info.author = au[1].trim();
  }
  if (!info.cover) {
    const cv = text.match(/<div class="imgbox">\s*<img[^>]+src="([^"]+)"/);
    if (cv) info.cover = cv[1];
  }
  const pg = text.match(/共(\d+)页/);
  if (pg) info.pages = +pg[1];
  const lt = text.match(/最新章节：<a href="[^"]*\/(\d+)\.html"[^>]*>([^<]+)/);
  if (lt) info.latest = stripTags(lt[2]).trim();
  return info;
}

// catalog = chapter links appearing AFTER the full-list marker on the page.
// Both sites also show a latest-9 block before it — slicing past the marker
// avoids picking up those duplicates.
function parseCatalogPage(text, bid) {
  const cut = text.indexOf(SITECFG.catalogAnchor);
  const seg = cut >= 0 ? text.slice(cut) : text;
  const out = [];
  const re = SITECFG.catalogRe(bid);
  let m;
  while ((m = re.exec(seg))) {
    const title = stripTags(m[2]).trim();
    // volume headers ("第一卷：默认") are grouping pages, not chapters
    if (/^第[^章]{1,6}卷[：:]/.test(title)) continue;
    out.push({ cid: m[1], title });
  }
  return out;
}

// ---- chapter content ----------------------------------------------------
const WARN = "请关闭浏览器";
// nav/bookmark anchors live INSIDE #content — drop exact-match nav items and
// any para containing promo boilerplate. Short nav labels only count as junk
// when they're the whole paragraph (a sentence mentioning 下一页 is content).
const JUNK_ANY = /请关闭浏览器|加入书签|本章未完|点击下一页|我们域名|小[説说]网|最新域名|akshu88|hongye|红叶书斋|紅葉書齋|投推荐票/;
const JUNK_EXACT = /^(上一章|下一页|章节列表|『?加入书签[，,]?方便阅读』?)$/;

function extractBlocks(html) {
  const m = html.match(/<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return null;
  const paras = m[1]
    .split(/<br\s*\/?\s*>/i)
    .map((s) => stripTags(s).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // split into blocks on warning lines
  const blocks = [];
  let cur = [];
  for (const p of paras) {
    if (p.indexOf(WARN) === 0 || p === WARN) {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// a block is poison when most of its substantive paragraphs were already
// collected (the site replays the chapter tail several times). Short paras
// like "……" are too ambiguous to count.
function isPoison(block, seen) {
  const sig = block.filter((p) => p.length >= 8);
  if (!sig.length) return block.length > 3; // all-tiny blocks past page 1 = junk-ish
  let hit = 0;
  for (const p of sig) if (seen.has(p)) hit++;
  return hit / sig.length >= 0.6;
}

async function scrapeChapter(bid, cid) {
  const seen = new Set();
  const out = [];
  let title = "";
  let totalPages = 1;
  for (let pg = 1; pg <= 12; pg++) {
    const url = SITE + SITECFG.chapUrl(bid, cid, pg);
    const r = await get(url);
    if (r.status === 404) {
      return pg === 1 ? { status: "missing" } : { status: "ok", title, paras: out };
    }
    if (r.status !== 200) {
      // a late page dying shouldn't burn content already collected
      if (pg > 1 && out.length) return { status: "ok", title, paras: out };
      return { status: "err", err: "http" + r.status };
    }
    if (!title) {
      // akshu88: <h1 class="title">; hongye: first <h1> is the chapter title
      const h = r.text.match(/<h1 class="title">([\s\S]*?)<\/h1>/)
        || r.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
      if (h) title = stripTags(h[1])
        .replace(/\s*[（(]第\d+页\/共\d+页[)）]\s*$/, "")
        .replace(/^正文\s+/, "") // "正文" is the site's section label, not the chapter's
        .trim();
    }
    const pgm = r.text.match(/第(\d+)页\/共(\d+)页/);
    if (pgm) totalPages = Math.max(totalPages, +pgm[2]);
    const blocks = extractBlocks(r.text);
    if (!blocks) return { status: "err", err: "no-content" };
    for (const b of blocks) {
      const clean = b.filter((p) => !JUNK_ANY.test(p) && !JUNK_EXACT.test(p));
      if (!clean.length || isPoison(clean, seen)) continue;
      for (const p of clean) { seen.add(p); out.push(p); }
    }
    if (pg >= totalPages) break; // site says no more pages
    await sleep(60);
  }
  return out.length
    ? { status: "ok", title, paras: out }
    : { status: "empty" };
}

async function fetchCover(coverUrl) {
  try {
    const r = await fetch(coverUrl, { headers: { "User-Agent": UA } });
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (coverUrl.match(/\.(\w{3,4})(?:\?|$)/) || [])[1] || "jpg";
    const file = "cover." + (ext === "jpeg" ? "jpg" : ext);
    fs.writeFileSync(path.join(BOOK_DIR, file), buf);
    saveMeta({ cover: file });
    logLine("cover saved: " + file);
  } catch {}
}

(async () => {
  const meta = readMeta();
  const bid = ARGS.book || meta.bookId;
  SITECFG = SITES[meta.site] || SITES.akshu88;
  SITE = SITECFG.origin;
  if (!bid) { console.error("no book id (meta.bookId or --book)"); process.exit(2); }
  logLine(`source=${meta.site || "akshu88"} bid=${bid}`);

  // ---- 1. book page -> meta + page count --------------------------------
  job.note = "lấy thông tin truyện"; saveJob();
  const bp = await get(SITE + SITECFG.indexUrl(bid));
  if (r200(bp)) {
    const info = parseBookPage(bp.text, bid);
    saveMeta({
      title: info.title || meta.title,
      subtitle: info.author ? "Tác giả: " + info.author : meta.subtitle,
      bookId: String(bid),
      source: SITE + SITECFG.indexUrl(bid),
      base: SITE + SITECFG.indexUrl(bid),
      latest: info.latest || "",
      pages: info.pages || 1,
    });
    if (info.cover && !meta.cover) await fetchCover(info.cover);
    logLine(`meta: "${info.title}" pages=${info.pages} latest=${info.latest}`);
  } else {
    logLine("book page fetch failed: " + bp.status);
  }
  if (ARGS["cover-only"]) { job.status = "done"; saveJob(); return; }

  // ---- 2. catalog pages -> ordered cid list ------------------------------
  // cidMap[num]=cid is stable across runs: known cids keep their number even
  // if the site deletes a middle chapter; new cids take the first free num.
  const pages = SITECFG.pagedCatalog ? (readMeta().pages || 1) : 1;
  const knownCids = new Set(Object.values(cidMap));
  let nextFree = 1;
  for (let p = 1; p <= pages; p++) {
    const url = p === 1
      ? SITE + SITECFG.indexUrl(bid)
      : SITE + SITECFG.catalogUrl(bid, p);
    const r = await get(url);
    if (r.status !== 200) { logLine(`idx p${p}: ${r.status} ${r.err || ""}`); continue; }
    for (const e of parseCatalogPage(r.text, bid)) {
      if (knownCids.has(e.cid) || dupcids[e.cid]) continue;
      while (cidMap[nextFree]) nextFree++;
      cidMap[nextFree] = e.cid;
      knownCids.add(e.cid);
      indexDirty = true; // reuse the 2s flush timer for _cidmap.json
    }
    job.note = `lấy mục lục ${p}/${pages}`; saveJob();
    await sleep(80);
  }
  try { fs.writeFileSync(CIDMAP_FILE, JSON.stringify(cidMap)); } catch {}

  const total = Math.max(0, ...Object.keys(cidMap).map(Number));
  job.total = total; delete job.note; saveJob();
  logLine(`catalog: ${total} chapters mapped`);

  // ---- 3. chapters --------------------------------------------------------
  const savedSet = new Set();
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m || !have(+m[1])) continue;
      const n = +m[1];
      savedSet.add(n);
      // heal _index.json: a file saved by a run that died before the flush
      // timer wrote the index would stay invisible in the chapter list forever
      if (!(n in indexMap)) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
          indexMap[n] = (d.title || "").replace(/^正文\s+/, "");
          indexDirty = true;
        } catch {}
      }
    }
  } catch {}
  job.done = savedSet.size; saveJob();

  let fail = 0;
  const nums = Object.keys(cidMap).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    if (MAX_CHAPS && savedSet.size >= MAX_CHAPS) break;
    if (savedSet.has(n)) continue;
    const cid = cidMap[n];
    const r = await scrapeChapter(bid, cid);
    if (r.status === "ok") {
      saveChap(n, r.title, r.paras, cid);
      const kept = dupOf(n, nums);
      if (kept) {
        dropDup(n, cid, kept);
        logLine(`ch${n}: dup of ch${kept} (cid ${cid})`);
      }
      savedSet.add(n); fail = 0;
      job.done = savedSet.size; saveJob();
      if (job.done % 20 === 0) logLine(`+${job.done}/${total}`);
    } else if (r.status === "missing") {
      saveChap(n, "", [], cid, true);
      savedSet.add(n); job.done = savedSet.size; saveJob();
      logLine(`ch${n}: missing (404)`);
    } else if (r.status === "empty") {
      saveChap(n, "", [], cid, true); // stub — retried on later update runs
      logLine(`ch${n}: empty`);
    } else {
      fail++; job.fail = fail; saveJob();
      logLine(`ch${n}: ${r.status} ${r.err || ""}`);
      await sleep(Math.min(10000, 1000 * fail));
      if (fail > 60) { job.status = "error"; job.error = "too many failures"; saveJob(); return; }
    }
    await sleep(DELAY);
  }

  if (job.status === "running") {
    job.status = "done";
    job.total = Math.max(total, savedSet.size);
  }
  saveJob();
  saveMeta({ total: job.total });
  // final flush — the 2s timer may not tick again before exit
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(indexMap)); } catch {}
  try { fs.writeFileSync(CIDMAP_FILE, JSON.stringify(cidMap)); } catch {}
  console.log(`XONG: ${job.done} ch, fail ${fail}, status ${job.status}`);
})().catch((e) => {
  job.status = "error";
  job.error = String(e.message || e).slice(0, 200);
  saveJob();
  console.error("FATAL:", e.message);
  process.exit(1);
});

function r200(r) { return r && r.status === 200; }
