// Dump the chapter DOM structure properly — wait for real text to appear.
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
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
  await page.goto(`${SITE}/truyen/${SLUG}/fanqie/chuong-816-ve-si`,
    { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const info = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const iframes = [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 60));
    // every element whose own (non-child) text is a long paragraph
    const blocks = [...document.querySelectorAll("body *")]
      .filter((el) => el.children.length === 0 && el.textContent.trim().length > 150)
      .slice(0, 8)
      .map((el) => el.tagName + "." + String(el.className).split(" ")[0] +
        " [" + el.textContent.trim().length + "] " + el.textContent.trim().slice(0, 40));
    return { bodyTextLen: text.length, textHead: text.slice(0, 300), iframes, blocks };
  });
  console.log(JSON.stringify(info, null, 1));
  fs.writeFileSync("/tmp/ch816-dom.html", await page.content());
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
