// Sniff all XHR/fetch responses during a real chapter nav on webtruyendich.
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
  const hits = [];
  page.on("response", async (r) => {
    try {
      const url = r.url();
      if (!url.includes("webtruyendich")) return;
      const len = parseInt(r.headers()["content-length"] || "0");
      const ct = (r.headers()["content-type"] || "").split(";")[0];
      if (/api|json|chapter|content/i.test(url) || len > 10000)
        hits.push(`${r.status()} ${ct} ${len}B ${url.slice(24, 130)}`);
    } catch {}
  });
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  await sleep(4000); // let lazy content XHRs fire
  // also check rendered DOM now — is content present?
  const dom = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      mainLen: (main ? main.innerText : "").length,
      bodyLen: document.body.innerText.length,
      // biggest text-bearing leaf nodes
      bigLeaves: [...document.querySelectorAll("main *")]
        .filter((e) => !e.children.length && (e.textContent || "").trim().length > 200)
        .slice(0, 6)
        .map((e) => `${e.tagName}.${String(e.className).slice(0, 40)} [${e.textContent.trim().length}]`),
    };
  });
  console.log("XHRs:", hits.join("\n") || "(none)");
  console.log(JSON.stringify(dom, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
