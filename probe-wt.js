// Probe webtruyendich.com via proxy lane: CF clearance, chapter DOM, rate limit.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile-rot");
const SITE = "https://webtruyendich.com";
const SLUG = "mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function solveTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
      const el = await frame.$("body");
      const bb = el && (await el.boundingBox());
      if (bb) { await page.mouse.click(bb.x + 30, bb.y + bb.height / 2, { delay: 150 }); return true; }
    } catch {}
  }
  return false;
}

(async () => {
  const proxies = fs.readFileSync("proxy_alive.txt", "utf8").split(/\r?\n/).filter(Boolean).slice(20, 24);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });
  const ctx = browser.defaultBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });

  // land on book page (CF gate?)
  const t0 = Date.now();
  try {
    await page.goto(SITE + "/truyen/" + SLUG, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) { console.log("nav fail:", e.message.slice(0, 60)); }
  await sleep(2500);
  let tries = 0;
  while (!page.url().startsWith(SITE + "/truyen") && tries < 5) {
    await solveTurnstile(page); await sleep(3500); tries++;
  }
  console.log(`landed ${Date.now() - t0}ms: ${page.url().slice(0, 80)}`);

  // fetch real chapter 815 page inside browser
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    const t = await res.text();
    const doc = new DOMParser().parseFromString(t, "text/html");
    // hunt for the content container
    const cands = ["#chapter-content", "#content", ".chapter-content", "#novel-content",
      ".content", "article", ".prose", "#chapter_body"];
    const found = [];
    for (const s of cands) {
      const el = doc.querySelector(s);
      if (el) found.push(s + " p=" + el.querySelectorAll("p").length + " len=" + el.textContent.trim().length);
    }
    return { s: res.status, len: t.length, title: doc.title.slice(0, 60), found,
      h1: (doc.querySelector("h1") || {}).textContent };
  }, `${SITE}/truyen/${SLUG}/fanqie/chuong-815-hieu-truong-dien-bao`);
  console.log("ch815 page:", JSON.stringify(r, null, 1));

  // pull real chapter URLs for 816+ from the list API, then burst-test the limiter
  const urls = await page.evaluate(async (id) => {
    const res = await fetch(`/api/novels/${id}/chapters?source=fanqie&page=17&limit=50`, { credentials: "include" });
    const d = await res.json();
    return d.data.map((x) => x.chapter_url).filter((u) => /^chuong-81[5-9]|^chuong-82/.test(u));
  }, 4886);
  console.log("real urls:", urls.length, urls.slice(0, 3));
  for (let i = 0; i < Math.min(10, urls.length); i++) {
    const t1 = Date.now();
    const rr = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: "include" });
        const t = await res.text();
        return { s: res.status, len: t.length, cf: /Just a moment|challenge/i.test(t.slice(0, 3000)) };
      } catch (e) { return { s: -1, err: String(e).slice(0, 40) }; }
    }, `${SITE}/truyen/${SLUG}/fanqie/${urls[i]}`);
    console.log(`  req${i + 1}: ${rr.s} ${rr.len}B cf=${rr.cf} ${Date.now() - t1}ms`);
    await sleep(700);
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
