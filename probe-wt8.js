// Capture getChapterStream request URL + read it directly via fetch.
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
  const reqs = [];
  page.on("request", (r) => { if (/getChapterStream|chapter-loader|api\//.test(r.url())) reqs.push(`${r.method()} ${r.url()} BODY=${r.postData() || "-"}`); });
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  await sleep(6000);
  console.log("REQS:\n" + reqs.join("\n"));
  const streamReq = reqs.find((u) => u.includes("getChapterStream"));
  if (streamReq) {
    const m = streamReq.match(/^POST (\S+) BODY=(.*)$/s);
    const body = await page.evaluate(async (u, b) => {
      const r = await fetch(u, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: b });
      const t = await r.text();
      return { s: r.status, ct: r.headers.get("content-type"), len: t.length, head: t.slice(0, 800), tail: t.slice(-400) };
    }, m[1], m[2]);
    console.log("REPLAY body:", m[2]);
    console.log(JSON.stringify(body, null, 1));
  }
  // check rendered content too
  const dom = await page.evaluate(() => ({
    bodyLen: document.body.innerText.length,
    sample: document.body.innerText.slice(0, 400),
  }));
  console.log(JSON.stringify(dom, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
