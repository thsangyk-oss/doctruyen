// Measure how chapter content actually renders: headers on real POST,
// which container fills, and how long the stream takes.
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
  page.on("request", (r) => {
    if (r.url().includes("getChapterStream"))
      console.log("STREAM-REQ headers:", JSON.stringify(r.headers()), "\n body:", r.postData());
  });
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-816-ve-si",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  // watch content container growth for up to 60s
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const m = await page.evaluate(() => {
      const cands = [...document.querySelectorAll("main div, main article, main section")]
        .map((el) => ({ sel: el.id ? "#" + el.id : "." + String(el.className || "").split(" ")[0],
          len: (el.innerText || "").trim().length }))
        .filter((c) => c.len > 1500).sort((a, b) => b.len - a.len);
      return { top: cands.slice(0, 4), body: document.body.innerText.length };
    });
    console.log(`@${(i + 1) * 5}s body=${m.body}`, JSON.stringify(m.top));
    if (m.body > 9000) break;
  }
  // identify deepest meaningful container for extraction
  const extract = await page.evaluate(() => {
    // find elements whose text is the chapter paragraphs
    const els = [...document.querySelectorAll("div,article,section")];
    const best = els.filter((el) => {
      const kids = [...el.children];
      const longKids = kids.filter((k) => (k.textContent || "").trim().length > 80).length;
      return longKids >= 5;
    }).map((el) => ({
      id: el.id, cls: String(el.className || "").slice(0, 60),
      kids: el.children.length,
      len: (el.innerText || "").trim().length,
    })).sort((a, b) => a.kids - b.kids).slice(0, 6);
    return best;
  });
  console.log("containers:", JSON.stringify(extract, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
