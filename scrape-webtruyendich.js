// Supplement importer for webtruyendich.com — fills chapters into an
// EXISTING book dir (same file format as scrape-book.js). One-off style:
//   node scrape-webtruyendich.js --dir=data/books/mang-theo-dien-thoai \
//     --novel=4886 --source=fanqie --book-slug=<slug> --start=815
//
// Site mechanics (reverse-engineered from chapter-loader.js, see CRAWL.MD):
//   chapter list:  GET /api/novels/<id>/chapters?source=<ed>&page=N&limit=50
//                  -> {data:[{chapter_url:"chuong-815-...",title,timestamp}],pagination}
//                  (public, no challenge — plain fetch works)
//   chapter body:  POST /api/getChapter  (JSON {novel_id,source_id,chapter_url,
//                  translator:"gemini-3.5-flash-lite",is_free:true,use_memory:true,
//                  target_lang:"Vietnamese",is_prefetch:false})
//                  + header cf-turnstile-response:<fresh single-use token>
//                  -> {chapter_id,slug,title,content:"...<br><br>..."}
//   tokens:        minted on demand by await executeTurnstile() — the site's
//                  own function on chapter pages; managed widget auto-refills
//   gating:        chapter pages land behind CF managed challenge ("Chờ một
//                  chút") — one real nav + optional Turnstile click clears it
//                  per context; afterwards in-page POSTs pass until the IP's
//                  bucket spends (~tens of reqs, pacing grows) -> rotate lane.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const ARGS = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--(\w[\w-]*)(?:=(.*))?$/);
  if (m) ARGS[m[1]] = m[2] === undefined ? true : m[2];
});
const BOOK_DIR = ARGS.dir;
const NOVEL_ID = String(ARGS.novel || "");
const EDITION = ARGS.source || "fanqie";
const BOOK_SLUG = ARGS["book-slug"] || "";
const START = +(ARGS.start || 1);
if (!BOOK_DIR || !NOVEL_ID || !BOOK_SLUG) {
  console.error("need --dir --novel --book-slug");
  process.exit(2);
}
const SITE = "https://webtruyendich.com";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile-wt");
const OUT_DIR = path.join(BOOK_DIR, "chapters");
const JOB_FILE = path.join(BOOK_DIR, "job.json");
const META_FILE = path.join(BOOK_DIR, "meta.json");
const INDEX_FILE = path.join(OUT_DIR, "_index.json");
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Node-side timeout for CDP calls — a dead proxy context leaves
// evaluate()/goto() pending FOREVER (in-page timeouts can't help a
// frozen target). Every page call goes through this.
const pTimeout = (p, ms, tag) => Promise.race([
  p, new Promise((_, rj) => setTimeout(() => rj(new Error("pt:" + tag)), ms)),
]);

process.on("unhandledRejection", (e) => {
  try { fs.appendFileSync(JOB_FILE + ".log",
    new Date().toISOString() + " UNHANDLED " + String(e && e.stack || e).slice(0, 500) + "\n"); } catch {}
});
process.on("uncaughtException", (e) => {
  try { fs.appendFileSync(JOB_FILE + ".log",
    new Date().toISOString() + " UNCAUGHT " + String(e && e.stack || e).slice(0, 500) + "\n"); } catch {}
  process.exit(1);
});

let lastBeat = Date.now(); // updated by EVERY heartbeat write, not just saves —
const job = { status: "running", done: 0, total: 0, fail: 0, updated: Date.now() };
function saveJob() {
  job.updated = Date.now();
  lastBeat = job.updated; // a waiting worker still ticks; a hung one doesn't
  try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), "utf8"); } catch {}
}
const indexMap = {};
try { Object.assign(indexMap, JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"))); } catch {}
let indexDirty = false;
setInterval(() => {
  if (!indexDirty) return;
  indexDirty = false;
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(indexMap)); } catch {}
}, 2000).unref();

function saveChap(n, title, paras, empty) {
  fs.writeFileSync(path.join(OUT_DIR, n + ".json"),
    JSON.stringify({ num: n, title, paras, empty: !!empty }));
  indexMap[n] = title || "";
  indexDirty = true;
}
function logLine(s) {
  try { fs.appendFileSync(path.join(BOOK_DIR, "scrape.log"),
    new Date().toISOString().slice(11, 19) + " wt> " + s + "\n"); } catch {}
}
async function waitPulse(ms, note) {
  job.note = note; saveJob();
  for (let left = ms; left > 0; left -= 15000) {
    await sleep(Math.min(15000, left));
    job.updated = Date.now();
    try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), "utf8"); } catch {}
  }
  delete job.note; saveJob();
}
function have(n) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, n + ".json"), "utf8"));
    return d.paras && d.paras.length;
  } catch { return false; }
}

async function solveTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
      const box = await frame.$("input[type=checkbox], .cb-lb, body");
      const bb = box && (await box.boundingBox());
      if (bb) {
        await page.mouse.click(bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2, { delay: 130 });
        return true;
      }
    } catch {}
  }
  return false;
}

// One chapter: mint token + POST getChapter inside the landed page.
// Superseded tokens (page's own prefetch races ours) just retry the mint.
// -> {status:'ok'|'empty-site'|'limited'|'missing'|'err', title, paras}
async function scrapeChapter(page, slug) {
  return page.evaluate(async (o) => {
    try {
      let tok = "";
      for (let i = 0; i < 4; i++) {
        try {
          tok = await Promise.race([
            executeTurnstile(),
            new Promise((_, rj) => setTimeout(() => rj(new Error("tok-timeout")), 15000)),
          ]);
          if (tok) break;
        } catch (e) {
          const msg = String(e && e.message || e);
          if (/Superseded/i.test(msg)) continue; // widget busy — mint again
          if (/Failed to load Turnstile/i.test(msg))
            return { status: "err", err: "tok-dead-lane" };
          if (i === 3) return { status: "err", err: "tok:" + msg.slice(0, 40) };
        }
      }
      if (!tok) return { status: "err", err: "tok-empty" };
      const post = async (tk) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 60000);
        try {
          const r = await fetch("/api/getChapter", {
            method: "POST", credentials: "include", signal: ac.signal,
            headers: { "Content-Type": "application/json", "cf-turnstile-response": tk },
            body: JSON.stringify(o),
          });
          return { status: r.status, text: await r.text() };
        } finally { clearTimeout(t); }
      };
      let r = await post(tok);
      // 403 "CAPTCHA required" = token consumed by a race, not an IP ban —
      // re-mint and retry once before blaming the lane
      for (let i = 0; i < 2 && r.status === 403 && /CAPTCHA/i.test(r.text.slice(0, 300)); i++) {
        try { tok = await Promise.race([executeTurnstile(),
          new Promise((_, rj) => setTimeout(() => rj(new Error("tok-timeout")), 12000))]); }
        catch { break; }
        if (tok) r = await post(tok);
      }
      if (r.status === 429) return { status: "limited", secs: 300 };
      const text = r.text;
      if (r.status === 403 || /CAPTCHA|Just a moment/i.test(text.slice(0, 3000)))
        return { status: "limited", secs: 300 };
      if (r.status === 404) return { status: "missing" };
      if (r.status !== 200) return { status: "err", err: "http" + r.status };
      const j = JSON.parse(text);
      const paras = String(j.content || "")
        .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
        .split("\n").map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.startsWith("#") ? s.substring(1).trim() : s));
      const title = String(j.title || "")
        .replace(/^\s*Chương\s*\d+\s*[:.\-–—]?\s*/i, "");
      if (!paras.length) return { status: "empty-site", title };
      return { status: "ok", title, paras };
    } catch (e) {
      return { status: "err", err: String(e && e.name === "AbortError" ? "fetch-timeout" : e && e.message || e).slice(0, 60) };
    }
  }, {
    novel_id: NOVEL_ID, source_id: SOURCE_ID, chapter_url: slug,
    translator: "gemini-3.5-flash-lite", is_free: true,
    use_memory: true, target_lang: "Vietnamese", is_prefetch: false,
  });
}

const SOURCE_ID = "3"; // fanqie edition id on webtruyendich (captured from live POST)

(async () => {
  // ---------- chapter list (plain GET — not gated) ----------
  const list = [];
  for (let pg = 1; pg <= 60; pg++) {
    let j = null;
    for (let a = 0; a < 4 && !j; a++) {
      try {
        const r = await fetch(
          `${SITE}/api/novels/${NOVEL_ID}/chapters?source=${EDITION}&page=${pg}&limit=50`);
        if (r.status === 200) j = await r.json();
      } catch {}
      if (!j) await sleep(3000 * (a + 1));
    }
    if (!j) { console.log("list page", pg, "failed — using what we have"); break; }
    for (const it of j.data || []) {
      const num = +((String(it.chapter_url).match(/chuong-(\d+)/) || [])[1] || 0);
      if (num >= START)
        list.push({ num, slug: it.chapter_url,
          title: String(it.title || "").replace(/^\s*Chương\s*\d+\s*[:.\-–—]?\s*/i, "") });
    }
    if (!j.pagination || !j.pagination.has_next) break;
  }
  list.sort((a, b) => a.num - b.num);
  console.log(`chapter list: ${list.length} entries >= ch${START}, top ${list.slice(-1)[0]?.num}`);
  if (!list.length) { console.error("empty chapter list — abort"); process.exit(1); }
  job.total = list.length; saveJob();

  const queue = list.filter((c) => !have(c.num));
  const pushback = [];
  console.log(`to fetch: ${queue.length}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });

  // ---------- lane pool (site-specific, persisted) ----------
  // This site needs a working Turnstile widget per lane — a much stricter bar
  // than truyendich.space. A proxy that fails token-mint HERE may still serve
  // the main site fine, so verdicts live in their own files and never touch
  // the shared proxy_alive*.txt pool:
  //   proxy_alive_wt.txt — proxies PROVEN to mint a token (tried first)
  //   proxy_bad_wt.txt   — proxies proven unable to mint (skipped forever)
  const WT_GOOD = path.join(__dirname, "proxy_alive_wt.txt");
  const WT_BAD = path.join(__dirname, "proxy_bad_wt.txt");
  const wtGood = new Set(), wtBad = new Set();
  try { for (const s of fs.readFileSync(WT_GOOD, "utf8").split(/\r?\n/)) { const x = s.trim(); if (x) wtGood.add(x); } } catch {}
  try { for (const s of fs.readFileSync(WT_BAD, "utf8").split(/\r?\n/)) { const x = s.trim(); if (x) wtBad.add(x); } } catch {}
  const lanes = [{ px: null, coolUntil: 0, fails: 0, dead: false, proven: true }];
  {
    const seen = new Set();
    const add = (px, proven) => {
      if (!px || seen.has(px)) return;
      seen.add(px);
      lanes.push({ px, coolUntil: 0, fails: 0, dead: false, proven });
    };
    for (const px of wtGood) add(px, true); // proven lanes first
    for (const f of fs.readdirSync(__dirname).filter((f) => /^proxy_alive(?!_wt|_bad)[\w-]*\.txt$/.test(f)))
      for (const s of fs.readFileSync(path.join(__dirname, f), "utf8").split(/\r?\n/)) {
        const px = s.trim();
        if (px && !wtBad.has(px)) add(px, false);
      }
    logLine(`proxy pool: ${wtGood.size} proven + ${lanes.length - 1 - wtGood.size} candidates (${wtBad.size} known-bad skipped)`);
  }
  const markGood = (px) => {
    if (!px || wtGood.has(px)) return;
    wtGood.add(px);
    try { fs.appendFileSync(WT_GOOD, px + "\n"); } catch {}
  };
  const markBad = (px) => {
    if (!px || wtBad.has(px) || wtGood.has(px)) return;
    wtBad.add(px);
    try { fs.appendFileSync(WT_BAD, px + "\n"); } catch {}
  };

  const chapPageUrl = (slug) =>
    `${SITE}/truyen/${BOOK_SLUG}/${EDITION}/${slug}`;

  // land a lane's page on a real chapter URL — that's where executeTurnstile
  // exists; CF managed challenge may need one click first. A lane only counts
  // if it can actually MINT a token — proxies too slow/dead for the Turnstile
  // SDK are useless for this site, so prove it with a real mint at activate.
  async function proveToken(pg) {
    return pg.evaluate(() => Promise.race([
      executeTurnstile().then((t) => !!t),
      new Promise((r) => setTimeout(() => r(false), 18000)),
    ])).catch(() => false);
  }
  async function activate(lane, anySlug) {
    const url = chapPageUrl(anySlug);
    if (!lane.px) {
      const page = await browser.defaultBrowserContext().newPage();
      page.setDefaultTimeout(25000);
      await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch {}
      for (let i = 0; i < 12; i++) {
        const t = await page.title().catch(() => "");
        if (!/Chờ một chút|Just a moment/i.test(t)) break;
        await solveTurnstile(page); await sleep(2500);
      }
      const ok = await proveToken(page);
      if (!ok) { lane.coolUntil = Date.now() + 120000; await page.close().catch(() => {}); return null; }
      await sleep(2500); // let the page's own loader+prefetch settle
      return { ctx: null, page };
    }
    let ctx;
    try {
      ctx = await browser.createBrowserContext({ proxyServer: lane.px });
      const pg = await ctx.newPage();
      pg.setDefaultTimeout(25000);
      await pg.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });
      try { await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }); } catch {}
      for (let i = 0; i < 8; i++) {
        const t = await pg.title().catch(() => "");
        if (!/Chờ một chút|Just a moment/i.test(t)) break;
        await solveTurnstile(pg); await sleep(2500);
      }
      const ok = await proveToken(pg);
      if (!ok) {
        lane.dead = true; // no token machinery through this proxy — never retry
        markBad(lane.px);
        await ctx.close().catch(() => {});
        return null;
      }
      markGood(lane.px);
      await sleep(2500);
      return { ctx, page: pg };
    } catch (e) {
      lane.fails++;
      lane.dead = lane.fails >= 2;
      if (ctx) await ctx.close().catch(() => {});
      return null;
    }
  }

  const laneTag = (l) => (l.px ? l.px.replace(/^[a-z]+:\/\//, "") : "direct");

  async function pickLane(anySlug) {
    for (;;) {
      const now = Date.now();
      const lane = lanes
        .filter((l) => !l.dead && !l.inUse && l.coolUntil <= now)
        .sort((a, b) => (b.proven - a.proven) || (a.coolUntil - b.coolUntil))[0];
      if (lane) {
        lane.inUse = true;
        let r = null;
        try { r = await pTimeout(activate(lane, anySlug), 90000, "activate"); }
        catch (e) {
          lane.fails++;
          lane.dead = !!lane.px && lane.fails >= 2;
          if (lane.px) markBad(lane.px); // 90s dead-nav — don't retry
        }
        if (r) return { lane, ...r };
        lane.inUse = false;
        continue;
      }
      const alive = lanes.filter((l) => !l.dead);
      const next = Math.min(...alive.map((l) => l.coolUntil));
      if (!alive.length || !isFinite(next)) {
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
    else cur.page.close().catch(() => {});
  }

  async function netAlive() {
    try {
      return await Promise.race([
        fetch("https://api.ipify.org").then((r) => r.ok),
        new Promise((res) => setTimeout(() => res(false), 8000)),
      ]).catch(() => false);
    } catch { return true; }
  }

  // ---------- workers ----------
  const PARALLEL = 6;
  const INTRA_DELAY = 400;
  const LANE_REQ_CAP = 25; // this site's pacing grows fast — rotate earlier
  let done = 0, fail = 0;
  const savedSet = new Set();
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m && +m[1] >= START) savedSet.add(+m[1]);
    }
  } catch {}
  done = savedSet.size;
  job.done = done; saveJob();
  const t0 = Date.now();
  // stall watchdog: a hung CDP call stops heartbeat writes — if lastBeat
  // goes stale >150s the process is truly wedged (waiting workers tick every
  // 15s via waitPulse), so exit for a relaunch. Resumable via have().
  const watchdog = setInterval(() => {
    if (Date.now() - lastBeat > 150 * 1000) {
      logLine("heartbeat stale — wedged, exit for resume");
      try { fs.writeFileSync(JOB_FILE, JSON.stringify({ ...job, note: "wedged — rerun to resume" })); } catch {}
      process.exit(3);
    }
  }, 30000);
  watchdog.unref();
  logLine(`wt worker start: ${queue.length} to fetch, ${lanes.length} lanes, ${PARALLEL} parallel`);

  function claimNext() {
    if (pushback.length) return pushback.shift();
    return queue.length ? queue.shift() : null;
  }

  async function workerLoop(wid) {
    let cur = null, laneReqs = 0, errStreak = 0;
    const spares = [];
    const warm = () => {
      while (spares.length < 1)
        spares.push(pickLane((queue[0] || pushback[0] || list[0]).slug).catch(() => null));
    };
    const nextLane = async (slug) => {
      warm();
      while (spares.length) {
        const r = await spares.shift();
        if (r) { cur = r; warm(); return; }
      }
      cur = await pickLane(slug);
      warm();
    };
    while (fail <= 120) {
      const c = claimNext();
      if (!c) break;
      if (!cur) await nextLane(c.slug);
      let res;
      try {
        res = await pTimeout(scrapeChapter(cur.page, c.slug), 120000, "scrape");
      } catch (e) {
        res = { status: "err", err: String(e.message || e).slice(0, 60) };
      }

      if (res.status === "ok" || res.status === "empty-site") {
        saveChap(c.num, res.title || c.title, res.paras || [], res.status !== "ok");
        savedSet.add(c.num); done = savedSet.size;
        errStreak = 0; laneReqs++;
        job.done = done;
        job.proxy = `${lanes.filter((l) => l.inUse).length}/${lanes.filter((l) => !l.dead).length} lanes`;
        saveJob();
        if (done % 10 === 0) {
          const rate = done / ((Date.now() - t0) / 60000);
          logLine(`+${done} | ${rate.toFixed(1)}/ph | w${wid}:${laneTag(cur.lane)} req${laneReqs}`);
        }
        if (laneReqs >= LANE_REQ_CAP) {
          logLine(`w${wid} ${laneTag(cur.lane)}: cap — rotate`);
          releaseLane(cur, 120000); cur = null; laneReqs = 0;
        } else await sleep(INTRA_DELAY);
      } else if (res.status === "missing") {
        saveChap(c.num, "", [], true);
        savedSet.add(c.num); done = savedSet.size; laneReqs++;
        job.done = done; saveJob();
        logLine(`ch${c.num}: missing`);
        await sleep(INTRA_DELAY);
      } else if (res.status === "limited") {
        logLine(`ch${c.num}: LIMITED on ${laneTag(cur.lane)} after ${laneReqs} — rotate`);
        releaseLane(cur, Math.max((res.secs || 300) * 1000, 180000));
        cur = null; laneReqs = 0;
        pushback.push(c);
      } else {
        if (!(await netAlive())) {
          logLine(`ch${c.num}: net down — pause 60s`);
          releaseLane(cur); cur = null; laneReqs = 0;
          pushback.push(c);
          await waitPulse(60000, "mất kết nối — chờ hồi mạng");
          continue;
        }
        errStreak++; fail++;
        job.fail = fail; saveJob();
        logLine(`ch${c.num}: ${res.status} ${res.err || ""} on ${laneTag(cur.lane)}`.trim());
        if (/tok|fetch|abort|context|Target|http50/i.test(res.err || "") && cur.lane.px) {
          if (/tok-dead-lane/i.test(res.err || "")) { markBad(cur.lane.px); cur.lane.dead = true; }
          else { cur.lane.fails++; cur.lane.dead = cur.lane.fails >= 2; }
          releaseLane(cur); cur = null; laneReqs = 0;
        }
        if (errStreak <= 4) pushback.push(c);
        else errStreak = 0;
        await sleep(Math.min(15000, 2000 * errStreak + 500));
      }
    }
    if (cur) releaseLane(cur);
    for (const p of spares) p.then((r) => { if (r) releaseLane(r); }).catch(() => {});
  }

  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => workerLoop(i)));

  // ---------- finish: job + meta total = highest chapter on disk ----------
  let maxN = 0;
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) maxN = Math.max(maxN, +m[1]);
    }
  } catch {}
  job.status = queue.length || pushback.length ? "paused" : "done";
  job.done = savedSet.size;
  job.total = list.length;
  saveJob();
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    meta.total = Math.max(meta.total || 0, maxN);
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
  } catch {}
  console.log(`XONG: ${job.done} ch (>=${START}), fail ${fail}, max ch${maxN}, status ${job.status}`);
  await browser.close();
})().catch(async (e) => {
  job.status = "error";
  job.error = String(e.message || e).slice(0, 200);
  saveJob();
  console.error("FATAL:", e.message);
  process.exit(1);
});
