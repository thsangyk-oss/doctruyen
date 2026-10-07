// Capture SSE body + inspect turnstile token machinery in-page.
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile-rot2");
const SITE = "https://webtruyendich.com";
const SLUG = "mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
      const el = await frame.$("input[type=checkbox], .cb-lb, body");
      const bb = el && (await el.boundingBox());
      if (bb) { await page.mouse.click(bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2, { delay: 130 }); return true; }
    } catch {}
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });
  const page = await (await browser.defaultBrowserContext().newPage());
  const sse = [];
  page.on("response", async (r) => {
    if (!r.url().includes("getChapterStream")) return;
    try {
      const t = await r.text();
      sse.push({ s: r.status(), len: t.length, head: t.slice(0, 500), tail: t.slice(-200) });
    } catch (e) { sse.push({ err: String(e) }); }
  });
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  await sleep(15000); // let stream complete
  console.log("SSE:", JSON.stringify(sse, null, 1).slice(0, 3000));
  // turnstile machinery + loader source (same-origin fetch works now)
  const info = await page.evaluate(async () => {
    const out = {};
    out.turnstile = typeof window.turnstile;
    out.tsIframes = [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 80)).filter((s) => /turnstile|challenges/.test(s));
    out.tsInputs = [...document.querySelectorAll("[name=cf-turnstile-response], .cf-turnstile")].map((e) => e.outerHTML.slice(0, 120));
    const r = await fetch("/static/js/chapter-loader.js?v=24.1.3", { credentials: "include" });
    const js = await r.text();
    out.loaderLen = js.length;
    // extract the interesting bits
    const grab = (re) => [...js.matchAll(re)].map((m) => m[0].slice(0, 200));
    out.api = grab(/\/api\/[a-zA-Z_-]+/g).slice(0, 10);
    out.ts = grab(/.{80}cf-turnstile-response.{80}/g).slice(0, 4);
    out.tokens = grab(/.{60}getResponse|.{60}turnstile\.render/g).slice(0, 6);
    out.sel = grab(/.{40}getElementById|querySelector\([^)]*\).{40}/g).slice(0, 15);
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
