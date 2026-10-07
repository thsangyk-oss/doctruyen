// Per-book scrape worker for truyendich.space — spawned by server.js.
// Usage: node scrape-book.js --dir=<book dir> --base=<.../doc-truyen/<slug>/chuong->
//        [--slug=<slug>] [--delay=11000] [--cover-only]
// Writes: <dir>/chapters/<n>.json, <dir>/job.json (progress), <dir>/meta.json,
//         <dir>/scrape.log
//
// Fast path: the site's own JSON API —
//   GET /api/novels/<slug>              -> meta {title,image_url,latest_chapter_number}
//   GET /api/novels/<slug>/chapters/<n> -> {title, content}  (~8KB vs ~70KB HTML)
// Rate limit is per source IP (~8-16 reqs per ~5min window), so we rotate
// through free HTTP/SOCKS proxies (proxy_alive.txt) — each gets its own
// browser context + cookie jar. Only crawler traffic uses them.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});
const BOOK_DIR = ARGS.dir;
const BASE = ARGS.base; // ends with /chuong-
if (!BOOK_DIR || !BASE) {
  console.error("need --dir and --base");
  process.exit(2);
}
const SLUG = ARGS.slug || (BASE.match(/doc-truyen\/([^/]+)/) || [])[1];
const OUT_DIR = path.join(BOOK_DIR, "chapters");
const JOB_FILE = path.join(BOOK_DIR, "job.json");
const META_FILE = path.join(BOOK_DIR, "meta.json");
fs.mkdirSync(OUT_DIR, { recursive: true });
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile"); // holds CF clearance cookies
const SITE = "https://truyendich.space";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// never die silently — anything we didn't plan for gets logged first
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

const job = { status: "running", done: 0, total: 0, fail: 0, updated: Date.now() };
function saveJob() {
  job.updated = Date.now();
  try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), "utf8"); } catch {}
}
function have(n) {
  // a chapter "counts" if it has real content; empty stubs get retried
  try {
    const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, n + ".json"), "utf8"));
    return d.paras && d.paras.length;
  } catch { return false; }
}
function saveMeta(patch) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch {}
  Object.assign(m, patch);
  try { fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2), "utf8"); } catch {}
}
// chapters/_index.json — num->title map so the server never has to open
// thousands of chapter files just to build the chapter list
const INDEX_FILE = path.join(OUT_DIR, "_index.json");
const indexMap = {};
try { Object.assign(indexMap, JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"))); } catch {}
let indexDirty = false;
setInterval(() => {
  if (!indexDirty) return;
  indexDirty = false;
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(indexMap)); } catch {}
}, 2000).unref();

function saveChap(n, title, paras, empty) {
  fs.writeFileSync(
    path.join(OUT_DIR, n + ".json"),
    JSON.stringify({ num: n, title, paras, empty: !!empty }));
  indexMap[n] = title || "";
  indexDirty = true;
}
function logLine(s) {
  try {
    fs.appendFileSync(
      path.join(BOOK_DIR, "scrape.log"),
      new Date().toISOString().slice(11, 19) + " " + s + "\n");
  } catch {}
}

// turnstile: usually auto-passes with a valid cf_clearance; click if it doesn't
async function solveTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
      const box = await frame.$("input[type=checkbox], .cb-lb, #challenge-stage");
      const bb = box && (await box.boundingBox());
      if (bb) {
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { delay: 150 });
        return true;
      }
      const el = await frame.$("body");
      const fbb = el && (await el.boundingBox());
      if (fbb) {
        await page.mouse.click(fbb.x + 30, fbb.y + fbb.height / 2, { delay: 150 });
        return true;
      }
    } catch {}
  }
  return false;
}

// fetch any URL inside the browser (keeps CF cookies + TLS fingerprint).
// returns {status, url, text} or {status:"err"}
async function bfetch(page, url) {
  return page.evaluate(async (u) => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 18000);
      const r = await fetch(u, { credentials: "include", signal: ac.signal });
      clearTimeout(t);
      const text = await r.text();
      return { status: r.status, url: r.url, text };
    } catch (e) {
      return { status: "err", url: u, text: "", err: String(e && e.name === "AbortError" ? "fetch-timeout" : e).slice(0, 80) };
    }
  }, url);
}

// chapter via JSON API -> {status:'ok'|'empty'|'limited'|'missing'|'err', ...}
async function scrapeViaApi(page, n) {
  const r = await bfetch(page, `${SITE}/api/novels/${SLUG}/chapters/${n}`);
  if (r.status === "err") return { status: "err", err: r.err };
  if (r.status === 429 || r.status === 403 || /verify-human|cooldown|forbidden/i.test(r.url || ""))
    return { status: "limited", secs: (r.text.match(/seconds=(\d+)/) || [])[1] | 0 || 300 };
  if (r.status === 404) return { status: "missing" };
  if (r.status !== 200) return { status: "err", err: "http" + r.status };
  try {
    const j = JSON.parse(r.text);
    // content arrives wrapped in literal <content>...</content> tags
    const content = (j.content || "")
      .replace(/^\s*<content>/i, "").replace(/<\/content>\s*$/i, "");
    const paras = content.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!paras.length) {
      saveChap(n, j.title || "", [], true);
      return { status: "empty-site", paras: 0 };
    }
    saveChap(n, j.title || "", paras);
    return { status: "ok", paras: paras.length };
  } catch {
    return { status: "err", err: "badjson" };
  }
}

// fallback: full page fetch + DOM parse (in case the API shape changes)
async function scrapeViaHtml(page, n) {
  const r = await bfetch(page, BASE + n);
  if (r.status === "err") return { status: "err", err: r.err };
  if (r.status === 429 || r.status === 403 || /cooldown|forbidden|verify-human/.test(r.url || ""))
    return { status: "limited", secs: (r.url.match(/seconds=(\d+)/) || [])[1] | 0 || 300 };
  const data = await page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const h1 = doc.querySelector('h1[itemProp="name"]') || doc.querySelector("h1");
    const root = doc.querySelector("#original-content-tab")
      || doc.querySelector("#translated-content-tab")
      || doc;
    const paras = [];
    if (root) root.querySelectorAll("p").forEach((p) => {
      const t = p.textContent.trim(); if (t) paras.push(t);
    });
    return { title: h1 ? h1.textContent.trim() : "", paras };
  }, r.text);
  if (!data.paras.length) return { status: "err", err: "empty-html" };
  saveChap(n, data.title, data.paras);
  return { status: "ok", paras: data.paras.length };
}

// novel meta via API -> {title,total,coverUrl}
async function discover(page) {
  const r = await bfetch(page, `${SITE}/api/novels/${SLUG}`);
  if (r.status !== 200) throw new Error("meta http " + r.status);
  const j = JSON.parse(r.text);
  let cover = j.image_url || "";
  if (cover && cover.startsWith("/")) cover = SITE + cover;
  return { title: j.title || "", total: j.latest_chapter_number || 0, cover };
}

async function fetchCover(page, coverUrl) {
  if (!coverUrl) return;
  const r = await bfetch(page, coverUrl).catch(() => null);
  if (!r || r.status !== 200) return;
  const b64 = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: "include" });
      const b = await res.blob();
      return await new Promise((res2) => {
        const fr = new FileReader();
        fr.onload = () => res2(fr.result);
        fr.readAsDataURL(b);
      });
    } catch { return null; }
  }, coverUrl).catch(() => null);
  if (!b64 || !b64.startsWith("data:image")) return;
  const m = b64.match(/^data:image\/(\w+);base64,(.*)$/);
  if (!m) return;
  const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z]/g, "") || "jpg";
  const file = "cover." + ext;
  try {
    fs.writeFileSync(path.join(BOOK_DIR, file), Buffer.from(m[2], "base64"));
    saveMeta({ cover: file });
    console.log("cover saved:", file);
  } catch {}
}

// fetches must run on a real site page — about:blank has origin "null"
// and credentials:"include" requests fail outright ("Failed to fetch")
async function ensureContext(page) {
  if (page.url().startsWith(SITE)) return;
  await page.goto(SITE + "/doc-truyen/" + SLUG,
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(1500);
}

// if we got bounced to verify-human, navigate there once — the challenge
// auto-passes with our cookies — then come back
async function clearVerify(page) {
  try {
    await page.goto(SITE + "/doc-truyen/" + SLUG + "/chuong-1",
      { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 8 && /verify-human|challenge/.test(page.url()); i++) {
      await solveTurnstile(page);
      await sleep(4000);
    }
    const cleared = !/verify-human/.test(page.url());
    await ensureContext(page); // fetch needs a real origin
    return cleared;
  } catch { await ensureContext(page); return false; }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: PROF,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "--lang=vi-VN",
    ],
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" });
  await page.setViewport({ width: 1280, height: 900 });

  // land once for cookies / any pending challenge
  try {
    await page.goto(SITE + "/doc-truyen/" + SLUG, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2000);
    if (/verify-human/.test(page.url())) await clearVerify(page);
  } catch (e) { console.log("land failed:", e.message); }

  try {
    const d = await discover(page);
    if (d.title) saveMeta({ title: d.title, slug: SLUG, base: BASE });
    if (d.cover) await fetchCover(page, d.cover);
    if (!ARGS["cover-only"]) { job.total = d.total || 0; saveJob(); }
    logLine(`meta: total=${d.total}`);
  } catch (e) {
    console.log("discover failed:", e.message);
    logLine("discover failed: " + e.message);
  }
  if (ARGS["cover-only"]) { await browser.close(); return; }

  // sleep in 15s slices, touching job.json so the UI + stale watchdog
  // can tell the worker is alive (just waiting), not hung
  async function waitPulse(ms, note) {
    job.note = note; saveJob();
    for (let left = ms; left > 0; left -= 15000) {
      await sleep(Math.min(15000, left));
      job.updated = Date.now();
      try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), "utf8"); } catch {}
    }
    delete job.note; saveJob();
  }

  // ---- proxy lane pool --------------------------------------------------
  // Each free proxy = a separate source IP = a separate rate-limit bucket.
  // Rotation is crawler-only: dedicated browser contexts with their own
  // proxy + cookie jar; reader/TTS/other traffic never touches these.
  // Lane states: ready -> cooling (rate-limited) -> ready; a lane that
  // fails to connect twice is dead. {px:null} = our own IP (direct lane).
  const lanes = [{ px: null, coolUntil: 0, fails: 0, dead: false }];
  try {
    const seen = new Set();
    let n = 0;
    for (const f of fs.readdirSync(__dirname).filter((f) => /^proxy_alive.*\.txt$/.test(f))) {
      for (const s of fs.readFileSync(path.join(__dirname, f), "utf8").split(/\r?\n/)) {
        const px = s.trim();
        if (px && !seen.has(px)) { seen.add(px); n++; lanes.push({ px, coolUntil: 0, fails: 0, dead: false }); }
      }
    }
    logLine(`proxy pool: ${n} lanes loaded`);
  } catch { logLine("no proxy_alive.txt — direct IP only"); }

  async function activate(lane) {
    if (!lane.px) {
      // direct lane = default context; may still sit on a verify page
      await ensureContext(page);
      if (/verify-human|challenge/.test(page.url())) await clearVerify(page);
      if (/verify-human|challenge/.test(page.url())) {
        lane.coolUntil = Date.now() + 300000;
        return null;
      }
      return { ctx: null, page };
    }
    let ctx;
    try {
      ctx = await browser.createBrowserContext({ proxyServer: lane.px });
      const pg = await ctx.newPage();
      pg.setDefaultTimeout(25000);
      await pg.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" });
      // land on a tiny same-origin URL (the meta JSON endpoint) — it's enough
      // to establish origin + cookies, ~3-4x cheaper than a 70KB chapter page
      await pg.goto(SITE + "/api/novels/" + SLUG,
        { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1500);
      for (let i = 0; i < 3 && /verify-human|challenge/.test(pg.url()); i++) {
        await solveTurnstile(pg);
        await sleep(3500);
      }
      if (/verify-human|challenge/.test(pg.url())) {
        lane.coolUntil = Date.now() + 600000; // gated — retry in 10min
        await ctx.close().catch(() => {});
        return null;
      }
      return { ctx, page: pg };
    } catch (e) {
      lane.fails++;
      lane.dead = lane.fails >= 2;
      if (ctx) await ctx.close().catch(() => {});
      return null;
    }
  }

  const laneTag = (l) => (l.px ? l.px.replace(/^[a-z]+:\/\//, "") : "direct");

  // pick a free lane (skips lanes held by other workers); waits with
  // heartbeat while everything is cooling or occupied
  async function pickLane() {
    for (;;) {
      const now = Date.now();
      const lane = lanes
        .filter((l) => !l.dead && !l.inUse && l.coolUntil <= now)
        .sort((a, b) => a.coolUntil - b.coolUntil)[0]; // least-recently-used
      if (lane) {
        lane.inUse = true; // claim before awaiting — other workers see it taken
        const r = await activate(lane);
        if (r) return { lane, ...r };
        lane.inUse = false;
        continue;
      }
      const alive = lanes.filter((l) => !l.dead);
      const next = Math.min(...alive.map((l) => l.coolUntil));
      if (!alive.length || !isFinite(next)) {
        // whole pool dead — revive proxies once and give it another pass
        lanes.forEach((l) => { if (l.px) { l.dead = false; l.fails = 0; } });
        await waitPulse(300000, "pool cạn — revive proxies");
        continue;
      }
      await waitPulse(Math.max(5000, next - now), "tất cả IP đang cooldown");
    }
  }

  function releaseLane(cur, coolMs) {
    if (coolMs) cur.lane.coolUntil = Date.now() + coolMs;
    cur.lane.inUse = false;
    if (cur.ctx) cur.ctx.close().catch(() => {});
  }

  // when OUR internet drops, every proxy fetch fails at once — don't burn
  // the pool on false failures; check raw reachability on the direct page
  async function netAlive() {
    try {
      return await page.evaluate(() =>
        Promise.race([
          fetch("https://api.ipify.org", { mode: "no-cors", cache: "no-store" })
            .then(() => true),
          new Promise((res) => setTimeout(() => res(false), 8000)),
        ]).catch(() => false));
    } catch { return true; } // page itself broken — don't blame the net
  }
  // -----------------------------------------------------------------------

  // Limiter model (measured): the site counts requests per-IP in a ~5min
  // rolling window — ~8-16 allowed, then a 300s cooldown. With a pool of
  // proxy lanes each carrying its own bucket, we burn one lane until it
  // limits, rotate to the next, and circle back once lanes cool off. The
  // direct-IP lane behaves the same way (it keeps its old budget too).
  const INTRA_DELAY = 150;       // light pacing inside a lane
  const LANE_REQ_CAP = 40;       // don't ride one lane forever
  const PARALLEL = 10;           // concurrent proxy lanes — each is its own IP
  let done = 0, fail = 0;
  const t0 = Date.now();
  // done = unique chapter files on disk — a Set, because stub re-verification
  // would otherwise count the same chapter twice and inflate past total
  const savedSet = new Set();
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) savedSet.add(+m[1]);
    }
  } catch {}
  done = savedSet.size;
  job.done = done; saveJob();
  logLine(`worker start, done=${done} (${PARALLEL} parallel lanes, pool ${lanes.length})`);

  // discover may fail when our own IP is gated — fall back to the last
  // known total in meta.json instead of running away to 99999
  let metaTotal = 0;
  try { metaTotal = JSON.parse(fs.readFileSync(META_FILE, "utf8")).total || 0; } catch {}
  const END = job.total || metaTotal || 99999;
  // shared chapter queue — workers pull numbers; failed numbers go back
  let nextN = 1;
  const pushback = [];
  function claimNext() {
    if (pushback.length) return pushback.shift();
    while (nextN <= END && have(nextN)) nextN++;
    return nextN > END ? null : nextN++;
  }

  async function workerLoop(wid) {
    let cur = null, laneReqs = 0, errStreak = 0;
    // warm-spare pipeline: upcoming lanes are activated in the background
    // while the current one works — a lane only yields ~4-12 reqs (~2s of
    // work) while its setup takes ~2-5s, so two spares in flight are what
    // it takes to keep rotation near-zero-deadtime
    const spares = [];
    const warm = () => {
      while (spares.length < 2)
        spares.push(pickLane().catch(() => null));
    };
    const nextLane = async () => {
      warm();
      while (spares.length) {
        const r = await spares.shift();
        if (r) { cur = r; warm(); return; }
      }
      cur = await pickLane(); // every spare failed — block on a fresh pick
      warm();
    };
    while (fail <= 150) {
      const n = claimNext();
      if (n === null) break;
      if (!cur) await nextLane();
      let res;
      try {
        if (!cur.page.url().startsWith(SITE)) await ensureContext(cur.page);
        res = cur.mode === "html"
          ? await scrapeViaHtml(cur.page, n)
          : await scrapeViaApi(cur.page, n);
        // API transport error or empty-content edition -> try the HTML page;
        // API and page requests sit in SEPARATE rate buckets, so when the
        // API bucket is spent the same lane can keep going on HTML
        if (cur.mode !== "html" &&
            (res.status === "err" || res.status === "empty-site" || res.status === "limited")) {
          const r2 = await scrapeViaHtml(cur.page, n);
          if (res.status === "limited" && r2.status !== "limited") cur.mode = "html";
          if (r2.status !== "err" || res.err === "fetch-timeout") res = r2;
        }
      } catch (e) {
        res = { status: "err", err: String(e.message || e).slice(0, 60) };
      }

      if (res.status === "ok" || res.status === "empty-site") {
        savedSet.add(n); done = savedSet.size;
        errStreak = 0; laneReqs++;
        job.done = done;
        job.proxy = `${lanes.filter((l) => l.inUse).length}/${lanes.filter((l) => !l.dead).length} lanes`;
        saveJob();
        if (done % 20 === 0) {
          const rate = done / ((Date.now() - t0) / 60000);
          logLine(`+${done} | ${rate.toFixed(1)}/ph | w${wid}:${laneTag(cur.lane)} req${laneReqs}`);
        }
        if (laneReqs >= LANE_REQ_CAP) {
          logLine(`w${wid} ${laneTag(cur.lane)}: cap — rotate`);
          releaseLane(cur, 180000); cur = null; laneReqs = 0;
        } else {
          await sleep(INTRA_DELAY);
        }
      } else if (res.status === "missing") {
        // chapter doesn't exist server-side — stub it so updates skip it
        saveChap(n, "", [], true);
        savedSet.add(n); done = savedSet.size;
        laneReqs++; job.done = done; saveJob();
        logLine(`ch${n}: missing (404)`);
        await sleep(INTRA_DELAY);
      } else if (res.status === "limited") {
        // lane's bucket spent — cool it for the reported window, rotate
        logLine(`ch${n}: LIMITED ${res.secs}s on ${laneTag(cur.lane)} after ${laneReqs} reqs — rotate`);
        releaseLane(cur, Math.max(res.secs * 1000, 300000));
        cur = null; laneReqs = 0;
        pushback.push(n);
      } else {
        // transport failure while OUR net is down isn't the lane's fault —
        // pause instead of churning the whole pool into false cooldowns
        if (res.status === "err" && !(await netAlive())) {
          logLine(`ch${n}: net down — pause 60s (lane kept)`);
          releaseLane(cur); cur = null; laneReqs = 0;
          pushback.push(n);
          await waitPulse(60000, "mất kết nối — chờ hồi mạng");
          continue;
        }
        // transport/parse failure — proxy may have died; rotate after 2
        errStreak++; fail++;
        job.fail = fail; saveJob();
        logLine(`ch${n}: ${res.status} ${res.err || ""} on ${laneTag(cur.lane)}`.trim());
        if (res.status === "err" && cur.lane.px &&
            /fetch|abort|context|Target/i.test(res.err || "")) {
          cur.lane.fails++; cur.lane.dead = cur.lane.fails >= 2;
          releaseLane(cur); cur = null; laneReqs = 0;
        }
        if (errStreak <= 4) pushback.push(n);
        else errStreak = 0;
        await sleep(Math.min(15000, 2000 * errStreak + 500));
      }
    }
    if (cur) releaseLane(cur);
    for (const p of spares) p.then((r) => { if (r) releaseLane(r); }).catch(() => {});
  }

  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => workerLoop(i)));

  if (job.status === "running") {
    job.status = "done";
    job.total = fs.readdirSync(OUT_DIR).filter((f) => /^\d+\.json$/.test(f)).length;
  }
  saveJob();
  saveMeta({ total: job.total });
  console.log(`XONG: ${job.done} ch, fail ${fail}, status ${job.status}`);
  await browser.close();
})().catch(async (e) => {
  job.status = "error";
  job.error = String(e.message || e).slice(0, 200);
  saveJob();
  console.error("FATAL:", e.message);
  process.exit(1);
});
