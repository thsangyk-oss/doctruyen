// Measure token mint cycle: read -> POST -> reset -> read new -> POST again.
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
  const base = `${SITE}/truyen/${SLUG}/fanqie/`;
  await page.goto(base + "chuong-815-hieu-truong-dien-bao",
    { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await clickTurnstile(page); await sleep(2500);
    if (!/Chờ một chút|Just a moment/i.test(await page.title())) break;
  }
  await sleep(2000);
  const cycle = await page.evaluate(async (slugs) => {
    const read = () => document.querySelector("[name=cf-turnstile-response]")?.value || "";
    const waitTok = async (old) => {
      const t0 = Date.now();
      for (;;) {
        const v = read();
        if (v && v !== old) return { v, ms: Date.now() - t0 };
        if (Date.now() - t0 > 20000) return { v: "", ms: -1 };
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    const post = async (tok, slug) => {
      const r = await fetch("/api/getChapter", { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "cf-turnstile-response": tok },
        body: JSON.stringify({ novel_id: "4886", source_id: "3", chapter_url: slug,
          translator: "gemini-3.5-flash-lite", is_free: true, use_memory: true,
          target_lang: "Vietnamese", is_prefetch: false }) });
      const t = await r.text();
      let c = null; try { c = JSON.parse(t).content; } catch {}
      return { s: r.status, clen: c ? c.length : 0 };
    };
    const out = { fns: {
      resetTurnstile: typeof resetTurnstile,
      executeTurnstile: typeof executeTurnstile,
      turnstile: typeof window.turnstile } };
    out.rounds = [];
    for (const slug of slugs) {
      const t0 = Date.now();
      let tok = "", mintErr = null;
      try { tok = await executeTurnstile(); } catch (e) { mintErr = String(e).slice(0, 100); }
      const mintMs = Date.now() - t0;
      if (!tok) { out.rounds.push({ slug: slug.slice(0, 30), mintErr, mintMs }); break; }
      const t1 = Date.now();
      const r = await post(tok, slug);
      out.rounds.push({ slug: slug.slice(0, 30), ...r, ms: Date.now() - t1, mintMs });
    }
    return out;
  }, ["chuong-815-hieu-truong-dien-bao", "chuong-816-ve-si",
      "chuong-817-ta-ho-ve-moi-so-ai-con-se-khong-noi-chuyen-phiem",
      "chuong-818-lg-buu-kien"]);
  console.log(JSON.stringify(cycle, null, 1));
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
