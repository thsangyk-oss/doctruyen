// Scrape chapters via real Chrome. Handles the site's own rate-limit
// (/cooldown?seconds=N page) + Turnstile verify_now chapters.
// Usage: node browser-scrape.js [startN endN] [--profile=dir] [--delay=ms]
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const BASE =
  "https://truyendich.space/doc-truyen/mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu/chuong-";
const TOTAL = 814;
const OUT_DIR = path.join(__dirname, "data", "chapters");
fs.mkdirSync(OUT_DIR, { recursive: true });
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const START = parseInt(args[0] || "1", 10);
const END = parseInt(args[1] || String(TOTAL), 10);
const PROF = (process.argv.join(" ").match(/--profile=([\w.-]+)/) || [])[1] || ".chrome-profile";
let delayMs = parseInt((process.argv.join(" ").match(/--delay=(\d+)/) || [])[1] || "5000", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function have(n) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, n + ".json"), "utf8"));
    return d.paras && d.paras.length;
  } catch {
    return false;
  }
}

async function solveTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
      const box = await frame.$("input[type=checkbox], .cb-lb, #challenge-stage");
      const bb = box && (await box.boundingBox());
      if (bb) {
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { delay: 150 });
        return true;
      }
      const el = await frame.$("body");
      const fbb = el && (await el.boundingBox());
      if (fbb) {
        await page.mouse.click(fbb.x + 30, fbb.y + fbb.height / 2, { delay: 150 });
        return true;
      }
    } catch {}
  }
  return false;
}

// returns 'ok' | 'cooldown' | 'challenge' | 'empty' | 'err'
async function scrapePage(page, n) {
  await page.goto(BASE + n, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(1200);

  // cooldown redirect?
  const url = page.url();
  const cm = url.match(/\/cooldown\?seconds=(\d+)/);
  if (cm || url.includes("/forbidden")) {
    const secs = cm ? parseInt(cm[1], 10) : 300;
    return { status: "cooldown", secs };
  }

  // wait for real content (SSR) — handles post-turnstile reloads too
  try {
    await page.waitForFunction(
      () => {
        const r = document.querySelector("#original-content-tab");
        return r && r.querySelectorAll("p").length > 2;
      },
      { timeout: 25000 }
    );
  } catch {
    // maybe turnstile widget needs a click
    if (await solveTurnstile(page)) {
      try {
        await page.waitForFunction(
          () => {
            const r = document.querySelector("#original-content-tab");
            return r && r.querySelectorAll("p").length > 2;
          },
          { timeout: 25000 }
        );
      } catch {
        return { status: "challenge" };
      }
    } else {
      return { status: "challenge" };
    }
  }

  const data = await page.evaluate(() => {
    const h1 = document.querySelector('h1[itemProp="name"]') || document.querySelector("h1");
    const root = document.querySelector("#original-content-tab");
    const paras = [];
    if (root)
      root.querySelectorAll("p").forEach((p) => {
        const t = p.textContent.trim();
        if (t) paras.push(t);
      });
    return { title: h1 ? h1.textContent.trim() : "", paras };
  });
  if (!data.paras.length) return { status: "empty" };
  fs.writeFileSync(
    path.join(OUT_DIR, n + ".json"),
    JSON.stringify({ num: n, title: data.title, paras: data.paras }, null, 0),
    "utf8"
  );
  return { status: "ok", paras: data.paras.length };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: path.join(__dirname, PROF),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "--lang=vi-VN",
    ],
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" });
  await page.setViewport({ width: 1280, height: 900 });

  let done = 0, fail = 0, challenges = 0, cooldowns = 0;
  const t0 = Date.now();
  const MIN_DELAY = 4000, MAX_DELAY = 20000;

  for (let n = START; n <= END; n++) {
    if (have(n)) { done++; continue; }
    let res;
    try {
      res = await scrapePage(page, n);
    } catch (e) {
      res = { status: "err:" + e.message.slice(0, 60) };
    }

    if (res.status === "ok") {
      done++;
      challenges = 0;
      if (done % 15 === 0) {
        const rate = done / ((Date.now() - t0) / 60000);
        console.log(`+${done} ch (dang ch${n}) | ${rate.toFixed(1)}/ph | delay ${delayMs}ms | cd ${cooldowns} chal ${challenges}`);
      }
      // ease delay back down after streaks of success
      if (done % 40 === 0 && delayMs > MIN_DELAY) delayMs = Math.max(MIN_DELAY, delayMs - 1000);
      await sleep(delayMs);
    } else if (res.status === "cooldown") {
      cooldowns++;
      const wait = (res.secs + 45) * 1000;
      console.log(`ch${n}: COOLDOWN ${res.secs}s - ngu ${Math.round(wait / 1000)}s`);
      // adaptive: site says we're too fast -> slow down permanently
      delayMs = Math.min(MAX_DELAY, Math.round(delayMs * 1.5));
      await sleep(wait);
      n--; // retry this chapter after cooldown
    } else if (res.status === "challenge") {
      challenges++;
      const wait = Math.min(90000, 10000 * challenges);
      console.log(`ch${n}: turnstile - doi ${wait / 1000}s`);
      await sleep(wait);
      n--;
      if (challenges > 20) { console.log("turnstile khong qua duoc, dung"); break; }
    } else {
      fail++;
      console.log(`ch${n}: ${res.status}`);
      await sleep(3000);
      n--; // retry once per loop pass? no - skip but retry next run. Keep n-- for retry:
      // (we retry in place since transient errors dominate)
      if (fail > 30) break;
    }
  }
  console.log(`XONG: +${done} ch, fail ${fail}, cooldowns ${cooldowns}, challenges ${challenges}`);
  await browser.close();
})();
