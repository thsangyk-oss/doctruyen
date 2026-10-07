// CF managed challenge: can NAVIGATING to a chapter page pass the JS check?
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROF = path.join(__dirname, ".chrome-profile-rot");
const SITE = "https://webtruyendich.com";
const SLUG = "mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });
  const page = await (await browser.defaultBrowserContext().newPage());
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });

  const url = `${SITE}/truyen/${SLUG}/fanqie/chuong-815-hieu-truong-dien-bao`;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
  } catch (e) { console.log("nav err", e.message.slice(0, 50)); }
  // wait for CF challenge; try clicking the Turnstile checkbox if present
  for (let i = 0; i < 12; i++) {
    for (const frame of page.frames()) {
      try {
        if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
        for (const sel of ["input[type=checkbox]", ".cb-lb", "#challenge-stage", "body"]) {
          const el = await frame.$(sel);
          const bb = el && (await el.boundingBox());
          if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { delay: 120 }); break; }
        }
      } catch {}
    }
    await sleep(2500);
    const st = await page.evaluate(() => ({
      title: document.title.slice(0, 40),
      paras: document.querySelectorAll("p").length,
      url: location.href.slice(-50),
    }));
    console.log(`  +${(Date.now() - t0) / 1000 | 0}s title="${st.title}" paras=${st.paras} url=${st.url}`);
    if (st.paras > 5) break;
  }
  // inspect the real DOM: find the content container
  const info = await page.evaluate(() => {
    const cands = ["#chapter-content", "#content", ".chapter-content", "#novel-content",
      ".chapter-body", "article", ".prose", "main"];
    const out = {};
    for (const s of cands) {
      const el = document.querySelector(s);
      if (el) out[s] = "p=" + el.querySelectorAll("p").length + " len=" + el.textContent.trim().length;
    }
    return { out, h1: (document.querySelector("h1") || {}).textContent,
      allP: document.querySelectorAll("p").length };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
