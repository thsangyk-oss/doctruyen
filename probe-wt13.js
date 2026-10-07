// Test /api/getChapter WITHOUT token + find valid non-AI translator ids.
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
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  const out = await page.evaluate(async () => {
    const mk = (translator) => ({
      novel_id: "4886", source_id: "3",
      chapter_url: "chuong-815-hieu-truong-dien-bao",
      translator, is_free: false, use_memory: true,
      target_lang: "Vietnamese", is_prefetch: false });
    const res = { translators: window.DROPDOWN_DATA?.translators || window.TRANSLATORS || null,
      ddKeys: Object.keys(window.DROPDOWN_DATA || {}) };
    res.tests = [];
    for (const tr of [undefined, "", "google", "dichmay", "default"]) {
      try {
        const r = await fetch("/api/getChapter", { method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(mk(tr)) });
        const t = await r.text();
        let hasC = false; try { hasC = !!JSON.parse(t).content; } catch {}
        res.tests.push({ tr: String(tr), s: r.status, len: t.length, hasContent: hasC, head: t.slice(0, 120) });
      } catch (e) { res.tests.push({ tr: String(tr), err: String(e).slice(0, 80) }); }
      await new Promise((x) => setTimeout(x, 500));
    }
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
