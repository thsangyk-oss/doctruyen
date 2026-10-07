// Inspect chapter DOM: where does the chapter text actually live?
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
  // clearance likely persisted from probe-wt2 — navigate straight in
  await page.goto(`${SITE}/truyen/${SLUG}/fanqie/chuong-816-ve-si`,
    { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    for (const frame of page.frames()) {
      try {
        if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
        const el = await frame.$("body");
        const bb = el && (await el.boundingBox());
        if (bb) await page.mouse.click(bb.x + 30, bb.y + bb.height / 2, { delay: 120 });
      } catch {}
    }
    await sleep(2500);
    if (await page.evaluate(() => document.title.includes("Chương"))) break;
  }
  const info = await page.evaluate(() => {
    // find the deepest container holding the bulk of visible text
    const main = document.querySelector("main") || document.body;
    const kids = [...main.querySelectorAll("div,section,article")];
    const best = kids.map((el) => ({
      sel: el.id ? "#" + el.id : el.className && "." + String(el.className).split(" ")[0],
      len: el.textContent.trim().length,
      p: el.querySelectorAll("p").length,
      cls: String(el.className).slice(0, 60),
      id: el.id,
    })).filter((x) => x.len > 2000).sort((a, b) => b.len - a.len).slice(0, 6);
    // sample: how are text blocks structured inside best candidate?
    const winner = best[0];
    let sample = "";
    if (winner) {
      const el = winner.id ? document.getElementById(winner.id)
        : document.querySelector(winner.sel);
      if (el) {
        const childTags = [...el.children].slice(0, 8).map((c) =>
          c.tagName.toLowerCase() + "." + String(c.className).split(" ")[0] + "[" + c.textContent.trim().length + "]");
        sample = childTags.join(" | ");
      }
    }
    return { best, sample, title: document.title.slice(0, 50) };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
