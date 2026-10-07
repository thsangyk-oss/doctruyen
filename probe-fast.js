// Can a proxy context land on a TINY same-origin page (robots.txt / API JSON)
// instead of a 70KB chapter page — and still fetch the API?
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile-rot");
const SITE = "https://truyendich.space";
const SLUG = "pham-nhan-tien-duyen";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proxies = fs.readFileSync("proxy_alive.txt", "utf8").split(/\r?\n/).filter(Boolean).slice(6, 9);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });
  for (const px of proxies) {
    for (const land of ["/robots.txt", "/api/novels/" + SLUG]) {
      const ctx = await browser.createBrowserContext({ proxyServer: px }).catch(() => null);
      if (!ctx) { console.log(px, "ctx fail"); break; }
      try {
        const page = await ctx.newPage();
        const t0 = Date.now();
        await page.goto(SITE + land, { waitUntil: "domcontentloaded", timeout: 25000 });
        const ms = Date.now() - t0;
        const r = await page.evaluate(async (u) => {
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 12000);
            const res = await fetch(u, { credentials: "include", signal: ac.signal });
            clearTimeout(t);
            const txt = await res.text();
            let p = -1;
            try { p = (JSON.parse(txt).content || "").split("\n").filter(Boolean).length; } catch {}
            return { s: res.status, len: txt.length, p };
          } catch (e) { return { s: -1, err: String(e).slice(0, 50) }; }
        }, `${SITE}/api/novels/${SLUG}/chapters/241`);
        console.log(`${px} land=${land} ${ms}ms url=${page.url().slice(-40)} -> api:`, JSON.stringify(r));
      } catch (e) {
        console.log(`${px} land=${land} FAIL ${String(e.message || e).slice(0, 70)}`);
      }
      await ctx.close().catch(() => {});
    }
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
