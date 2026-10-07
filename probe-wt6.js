// Find the chapter-content selector inside webtruyendich chapter HTML.
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
  const out = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    const t = await res.text();
    const doc = new DOMParser().parseFromString(t, "text/html");
    // candidates: elements containing >3000 chars of text
    const cands = [...doc.querySelectorAll("div,section,article,main")]
      .map((el) => {
        const own = (el.innerText || el.textContent || "").trim();
        return { tag: el.tagName, id: el.id || "", cls: String(el.className || "").slice(0, 60), len: own.length };
      })
      .filter((c) => c.len > 3000)
      .sort((a, b) => b.len - a.len).slice(0, 12);
    // leaf paragraphs: any element ending with >100 chars own text, grouped by parent class
    const paras = [...doc.querySelectorAll("div,section,article,main,p")]
      .filter((el) => ![...el.children].some((c) => /^(DIV|SECTION|ARTICLE|MAIN)$/.test(c.tagName)))
      .map((el) => ({ cls: String(el.parentElement && el.parentElement.className || "").slice(0, 50), len: (el.textContent || "").trim().length }))
      .filter((p) => p.len > 100).slice(0, 6);
    return { cands, paras };
  }, base + "chuong-816-ve-si");
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
