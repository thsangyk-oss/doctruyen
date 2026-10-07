const puppeteer = require("puppeteer-core");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: false, userDataDir: path.join(__dirname, ".chrome-profile-rot"),
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--lang=vi-VN"] });
  const p = await (await b.defaultBrowserContext().newPage());
  await p.goto("https://webtruyendich.com/truyen/mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu/fanqie/chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("nav", e.message));
  for (let i = 0; i < 12; i++) {
    const t = await p.title().catch(() => "(dead)");
    if (!/Chờ một chút|Just a moment/i.test(t)) { console.log("cleared@" + i * 3 + "s title=" + t.slice(0, 50)); break; }
    for (const fr of p.frames()) {
      try {
        if (!/challenges\.cloudflare|turnstile/i.test(fr.url())) continue;
        const el = await fr.$("input[type=checkbox],.cb-lb,body");
        const bb = el && (await el.boundingBox());
        if (bb) await p.mouse.click(bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2, { delay: 130 });
      } catch {}
    }
    await sleep(3000);
    if (i === 11) console.log("STILL CHALLENGED, title=" + t.slice(0, 60));
  }
  const mint = await p.evaluate(() => Promise.race([
    executeTurnstile().then((t) => "ok " + t.length + "ch").catch((e) => "err " + String(e).slice(0, 60)),
    new Promise((r) => setTimeout(() => r("timeout"), 20000)),
  ])).catch((e) => "eval " + e.message);
  console.log("mint:", mint);
  await b.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
