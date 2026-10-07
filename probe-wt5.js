// Full worker-cycle test on webtruyendich: nav chapter -> solve challenge ->
// then page.evaluate(fetch) subsequent chapters. Does fetch pass?
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

async function parseChap(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    const t = await res.text();
    const doc = new DOMParser().parseFromString(t, "text/html");
    return { s: res.status, len: t.length, title: doc.title.slice(0, 40),
      cf: /Just a moment|xác minh/i.test(doc.title + t.slice(0, 2000)) };
  }, url);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: PROF,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run",
      "--no-default-browser-check", "--window-size=1100,800", "--lang=vi-VN"],
  });
  const page = await (await browser.defaultBrowserContext().newPage());
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9" });

  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  // nav to a real chapter to trigger + solve challenge
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page);
    await sleep(2500);
    const t = await page.title();
    if (!/Chờ một chút|Just a moment/i.test(t)) { console.log(`cleared @${i * 2.5 + 2.5}s: ${t.slice(0, 50)}`); break; }
    if (i === 14) console.log("STILL CHALLENGED");
  }
  // now fetch subsequent chapters in-page
  const urls = ["chuong-816-ve-si",
    "chuong-817-ta-ho-ve-moi-so-ai-con-se-khong-noi-chuyen-phiem",
    "chuong-818-x", "chuong-819-x"];
  // get real urls past 817 from api first
  const list = await page.evaluate(async () => {
    const r = await fetch("/api/novels/4886/chapters?source=fanqie&page=17&limit=50", { credentials: "include" });
    const d = await r.json();
    return d.data.map((x) => x.chapter_url).filter((u) => /^chuong-8(1[5-9]|2[0-9])/.test(u));
  });
  console.log("urls:", list.slice(0, 6));
  for (let i = 0; i < Math.min(8, list.length); i++) {
    const t1 = Date.now();
    const r = await parseChap(page, base + list[i]);
    console.log(`fetch ${list[i].slice(0, 40)}: ${r.s} ${r.len}B cf=${r.cf} "${r.title}" ${Date.now() - t1}ms`);
    await sleep(700);
  }
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
