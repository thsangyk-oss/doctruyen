// Launch headful Chrome, load a page, wait for CF challenge to clear,
// then save cf_clearance cookie + UA to clearance.json for curl reuse.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL_ = "https://truyendich.space/doc-truyen/mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu/chuong-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: path.join(__dirname, ".chrome-profile"),
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "--lang=vi-VN"],
  });
  const page = await browser.newPage();
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  await page.setUserAgent(UA);

  for (let i = 0; i < 10; i++) {
    await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(5000);
    const hasContent = await page.evaluate(() => {
      const r = document.querySelector("#original-content-tab");
      return r && r.querySelectorAll("p").length > 2;
    }).catch(() => false);
    const cookies = await page.cookies("https://truyendich.space");
    const cf = cookies.find((c) => c.name === "cf_clearance");
    console.log(`lan ${i}: content=${hasContent} cf_clearance=${cf ? "co" : "chua"}`);
    if (cf && hasContent) {
      fs.writeFileSync(
        path.join(__dirname, "clearance.json"),
        JSON.stringify({ cf_clearance: cf.value, ua: UA, ts: Date.now() }, null, 2)
      );
      console.log("DA LUU clearance.json — cf_clearance:", cf.value.slice(0, 30) + "...");
      await browser.close();
      return;
    }
    // try clicking turnstile checkbox if present
    for (const frame of page.frames()) {
      try {
        if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
        const el = await frame.$("body");
        const bb = el && (await el.boundingBox());
        if (bb) await page.mouse.click(bb.x + 30, bb.y + bb.height / 2, { delay: 120 });
      } catch {}
    }
    await sleep(3000);
  }
  console.log("Khong lay duoc clearance sau 10 lan.");
  await browser.close();
})();
