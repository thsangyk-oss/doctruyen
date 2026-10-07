// Dump chapter-loader.js source + test /api/getChapter + find token mint fn.
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
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
  await sleep(3000);
  const js = await page.evaluate(async () => {
    const r = await fetch("/static/js/chapter-loader.js?v=24.1.3", { credentials: "include" });
    return r.text();
  });
  fs.writeFileSync(path.join(__dirname, "chapter-loader.js"), js);
  console.log("saved chapter-loader.js", js.length, "bytes");
  // Try /api/getChapter (non-stream) with token from DOM
  const res = await page.evaluate(async () => {
    const tok = document.querySelector("[name=cf-turnstile-response]")?.value || "";
    const r = await fetch("/api/getChapter", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "cf-turnstile-response": tok },
      body: JSON.stringify({ novel_id: "4886", source_id: "3",
        chapter_url: "chuong-815-hieu-truong-dien-bao",
        translator: "gemini-3.5-flash-lite", is_free: true,
        use_memory: true, target_lang: "Vietnamese", is_prefetch: false }),
    });
    const t = await r.text();
    return { s: r.status, ct: r.headers.get("content-type"), len: t.length, head: t.slice(0, 500) };
  });
  console.log("getChapter:", JSON.stringify(res, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
