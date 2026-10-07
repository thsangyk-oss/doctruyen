// dump truyendich.space cookies from the scrape profile to clearance.json
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    userDataDir: path.join(__dirname, ".chrome-profile"),
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await browser.newPage();
  await page.goto("https://truyendich.space/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const cookies = await page.cookies("https://truyendich.space");
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  fs.writeFileSync(
    path.join(__dirname, "clearance.json"),
    JSON.stringify({ cookies, ua: UA, ts: Date.now() }, null, 2)
  );
  console.log("saved", cookies.length, "cookies:", cookies.map((c) => c.name).join(", "));
  await browser.close();
})();
