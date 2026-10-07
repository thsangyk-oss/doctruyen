// Watch the SSE stream body + rendered container growth over 90s.
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
  const t0 = Date.now();
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const m = await page.evaluate(() => {
      const box = document.querySelector(".mt-6.space-y-6") || document.querySelector("main");
      const paras = box ? [...box.querySelectorAll(":scope > div, :scope > p")] : [];
      return { boxLen: box ? (box.innerText || "").trim().length : -1,
        nparas: paras.length,
        last: paras.length ? paras[paras.length - 1].textContent.trim().slice(0, 60) : "" };
    });
    console.log(`@${((Date.now() - t0) / 1000).toFixed(0)}s boxLen=${m.boxLen} nparas=${m.nparas} last="${m.last}"`);
    if (m.boxLen > 4000 && m.nparas > 8) break;
  }
  // final: dump container structure once filled
  const done = await page.evaluate(() => {
    const box = document.querySelector(".mt-6.space-y-6");
    if (!box) return { err: "no box" };
    return {
      html: box.innerHTML.slice(0, 800),
      kids: [...box.children].slice(0, 8).map((k) => `${k.tagName}.${String(k.className).slice(0, 30)} [${(k.textContent || "").trim().length}]`),
    };
  });
  console.log(JSON.stringify(done, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
