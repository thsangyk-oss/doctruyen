// Try to fetch the LAST 4 missing chapters directly, one lane each.
// Figures out which slugs are missing from the API list, then tries
// direct + proven proxies for them.
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SITE = "https://webtruyendich.com";
const BOOK_SLUG = "mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu";
const OUT = "data/books/mang-theo-dien-thoai/chapters";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickTS(page) {
  for (const fr of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(fr.url())) continue;
      const el = await fr.$("input[type=checkbox],.cb-lb,body");
      const bb = el && (await el.boundingBox());
      if (bb) await page.mouse.click(bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2, { delay: 130 });
    } catch {}
  }
}
async function tryLane(browser, px, slug, num) {
  let ctx = null;
  try {
    ctx = px ? await browser.createBrowserContext({ proxyServer: px })
             : browser.defaultBrowserContext();
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);
    await p.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });
    await p.goto(`${SITE}/truyen/${BOOK_SLUG}/fanqie/${slug}`,
      { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const t = await p.title().catch(() => "");
      if (!/Chờ một chút|Just a moment/i.test(t)) break;
      await clickTS(p); await sleep(2500);
    }
    await p.waitForFunction("typeof executeTurnstile === 'function'", { timeout: 20000 }).catch(() => {});
    const res = await Promise.race([p.evaluate(async (o) => {
      let tok = "";
      for (let i = 0; i < 5; i++) {
        try { tok = await executeTurnstile(); if (tok) break; }
        catch (e) { if (!/Superseded/i.test(String(e))) throw e; }
      }
      if (!tok) return { s: "noTok" };
      const r = await fetch("/api/getChapter", { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "cf-turnstile-response": tok },
        body: JSON.stringify(o) });
      const t = await r.text();
      if (r.status !== 200) return { s: r.status };
      const j = JSON.parse(t);
      const paras = String(j.content || "").replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "").split("\n").map((s) => s.trim()).filter(Boolean);
      return { s: 200, title: j.title, paras };
    }, { novel_id: "4886", source_id: "3", chapter_url: slug,
      translator: "gemini-3.5-flash-lite", is_free: true, use_memory: true,
      target_lang: "Vietnamese", is_prefetch: false }),
      sleep(70000).then(() => ({ s: "timeout" }))]);
    console.log(`${px || "direct"} ch${num}: s=${res.s} paras=${(res.paras || []).length}`);
    if (res.s === 200 && res.paras && res.paras.length) {
      const title = String(res.title || "").replace(/^\s*Chương\s*\d+\s*[:.\-–—]?\s*/i, "");
      fs.writeFileSync(path.join(OUT, num + ".json"),
        JSON.stringify({ num, title, paras: res.paras, empty: false }));
      const ix = JSON.parse(fs.readFileSync(OUT + "/_index.json", "utf8"));
      ix[num] = title; fs.writeFileSync(OUT + "/_index.json", JSON.stringify(ix));
      if (px) await ctx.close().catch(() => {});
      return true;
    }
  } catch (e) { console.log(`${px || "direct"} ch${num}: err ${String(e.message || e).slice(0, 60)}`); }
  if (ctx && px) await ctx.close().catch(() => {});
  return false;
}

(async () => {
  // figure out missing slugs from the full API list vs files on disk
  const list = [];
  for (let pg = 1; pg <= 30; pg++) {
    let j = null;
    for (let a = 0; a < 5 && !j; a++) {
      try {
        const r = await fetch(`${SITE}/api/novels/4886/chapters?source=fanqie&page=${pg}&limit=50`);
        const d = await r.json();
        if (Array.isArray(d.data)) j = d;
      } catch {}
      if (!j) await sleep(4000 * (a + 1));
    }
    if (!j) { console.log("list page", pg, "failed"); break; }
    for (const it of j.data) {
      const num = +((String(it.chapter_url).match(/chuong-(\d+)/) || [])[1] || 0);
      if (num >= 815) list.push({ num, slug: it.chapter_url });
    }
    if (!j.pagination.has_next) break;
  }
  const missing = list.filter((c) => {
    try {
      const d = JSON.parse(fs.readFileSync(`${OUT}/${c.num}.json`, "utf8"));
      return !d.paras || !d.paras.length;
    } catch { return true; }
  });
  console.log("missing:", missing.map((m) => m.num).join(","));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    userDataDir: path.join(__dirname, ".chrome-profile-last"),
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--lang=vi-VN"] });
  const proxies = fs.readFileSync("proxy_alive_wt.txt", "utf8")
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const c of missing) {
    let done = await tryLane(browser, null, c.slug, c.num);
    for (const px of proxies) {
      if (done) break;
      done = await tryLane(browser, px, c.slug, c.num);
    }
  }
  await browser.close();
  console.log("final check:", missing.length, "attempted");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
