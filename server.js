// Static file server for the novel reader — port 1345
// + password gate (S@ng1234, remember per machine via cookie)
// + server-side reading progress sync (/api/state)
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = 1345;
const PASSWORD = "S@ng1234";
const COOKIE_NAME = "sang_auth";
const AUTH_TOKEN = crypto.createHash("sha256").update(PASSWORD + "|doctruyen").digest("hex");
const BOOKS_DIR = path.join(ROOT, "data", "books");

// powershell child that holds ES_DISPLAY_REQUIRED while "keep awake" is on
let keepAwakeProc = null;
process.on("exit", () => { try { keepAwakeProc && keepAwakeProc.kill(); } catch {} });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// each book = data/books/<id>/{meta.json, chapters/<n>.json, state.json}
const BOOK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function bookDir(id) {
  if (!BOOK_ID.test(id)) return null;
  const d = path.join(BOOKS_DIR, id);
  return fs.existsSync(path.join(d, "chapters")) ? d : null;
}
function stateFile(id) { return path.join(BOOKS_DIR, id, "state.json"); }
function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
  } catch {
    return { chapter: 1, para: 0, updated: 0 };
  }
}
function writeState(id, s) {
  try {
    fs.writeFileSync(stateFile(id), JSON.stringify(s), "utf8");
  } catch {}
}

function chapterIndex(dir) {
  const cdir = path.join(dir, "chapters");
  // fast path: title map maintained by the scrape worker / built once below —
  // one small file instead of parsing thousands of chapter JSONs
  try {
    const ix = JSON.parse(fs.readFileSync(path.join(cdir, "_index.json"), "utf8"));
    return Object.keys(ix).map((k) => ({ num: +k, title: ix[k] }))
      .sort((a, b) => a.num - b.num);
  } catch {}
  const ix = [];
  const map = {};
  try {
    for (const fn of fs.readdirSync(cdir)) {
      const m = fn.match(/^(\d+)\.json$/);
      if (!m) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(cdir, fn), "utf8"));
        ix.push({ num: +m[1], title: d.title || "" });
        map[m[1]] = d.title || "";
      } catch {}
    }
    try { fs.writeFileSync(path.join(cdir, "_index.json"), JSON.stringify(map)); } catch {}
  } catch {}
  ix.sort((a, b) => a.num - b.num);
  return ix;
}

// scrape job: <book>/job.json written by scrape-book.js worker;
// this server only spawns/queues workers, one at a time
const jobRunning = new Map(); // id -> ChildProcess
const jobQueue = [];          // [{id, base}]

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, id, "job.json"), "utf8"));
  } catch { return null; }
}
function writeJob(id, j) {
  try {
    fs.writeFileSync(path.join(BOOKS_DIR, id, "job.json"), JSON.stringify(j), "utf8");
  } catch {}
}
function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, id, "meta.json"), "utf8"));
  } catch { return {}; }
}
function runQueue() {
  if (jobRunning.size) return; // serial: the source site rate-limits per IP
  const j = jobQueue.shift();
  if (!j) return;
  // capture worker stdout/stderr — a silently-dying worker is undebuggable
  let outFd;
  try { outFd = fs.openSync(path.join(BOOKS_DIR, j.id, "worker.out"), "a"); } catch {}
  const proc = spawn(process.execPath, [
    path.join(ROOT, "scrape-book.js"),
    "--dir=" + path.join(BOOKS_DIR, j.id),
    "--base=" + j.base,
  ], outFd ? { stdio: ["ignore", outFd, outFd] } : { stdio: "ignore" });
  proc.on("exit", () => { try { outFd && fs.closeSync(outFd); } catch {} });
  jobRunning.set(j.id, proc);
  proc.on("exit", () => { jobRunning.delete(j.id); runQueue(); });
}
let proxyRefreshRunning = false;
function maybeRefreshProxies() {
  // free proxies churn hourly — if the validated pool is stale (>6h),
  // re-run the checker in the background so the next worker gets fresh IPs
  if (proxyRefreshRunning) return;
  try {
    const files = fs.readdirSync(ROOT).filter((f) => /^proxy_alive.*\.txt$/.test(f));
    const newest = files.reduce((m, f) =>
      Math.max(m, fs.statSync(path.join(ROOT, f)).mtimeMs), 0);
    if (Date.now() - newest < 6 * 3600 * 1000) return;
  } catch { /* no pool yet — refresh anyway */ }
  proxyRefreshRunning = true;
  const proc = spawn(process.execPath, [path.join(ROOT, "proxy-check.js"), "15000"],
    { stdio: "ignore" });
  proc.on("exit", () => { proxyRefreshRunning = false; });
}
function enqueueJob(id, base) {
  maybeRefreshProxies();
  jobQueue.push({ id, base });
  runQueue();
}

// stale watchdog: a running worker should heartbeat job.json at least
// every ~15s even while waiting out a cooldown; >10min stale = hung.
setInterval(() => {
  for (const [id, proc] of jobRunning) {
    const j = readJob(id);
    if (j && j.status === "running" && Date.now() - (j.updated || 0) > 10 * 60 * 1000) {
      try { proc.kill(); } catch {}
      jobRunning.delete(id);
      writeJob(id, Object.assign({}, j, { status: "queued", note: "worker hung - restarted" }));
      const meta = readMeta(id);
      if (meta.base) jobQueue.unshift({ id, base: meta.base });
      runQueue();
    }
  }
}, 60000).unref();

// library listing: every book folder + its meta + reading progress + job
function listBooks() {
  const out = [];
  try {
    for (const id of fs.readdirSync(BOOKS_DIR)) {
      const dir = bookDir(id);
      if (!dir) continue;
      const meta = readMeta(id);
      const ix = chapterIndex(dir);
      const st = readState(id);
      const job = readJob(id);
      out.push({
        id,
        title: meta.title || id,
        subtitle: meta.subtitle || "",
        total: ix.length,
        chapter: st.chapter || 0,
        para: st.para || 0,
        updated: st.updated || 0,
        hasSource: !!meta.base,
        cover: !!meta.cover || fs.existsSync(path.join(dir, "cover.jpg"))
          || fs.existsSync(path.join(dir, "cover.png"))
          || fs.existsSync(path.join(dir, "cover.webp")),
        job: job && job.status !== "done" ? job : null,
      });
    }
  } catch {}
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

function authed(req) {
  const c = req.headers.cookie || "";
  return c.split(";").some((p) => p.trim() === `${COOKIE_NAME}=${AUTH_TOKEN}`);
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng nhập</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4ecd9;font-family:-apple-system,"Segoe UI",sans-serif}
.card{background:#faf3e0;padding:40px 36px;border-radius:20px;box-shadow:0 8px 40px rgba(80,60,20,.15);width:min(90vw,340px);text-align:center}
h2{margin:0 0 6px;color:#433a28;font-size:20px}
p{color:#96876a;font-size:13px;margin:0 0 24px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #e2d5b8;background:#fff;font-size:15px;outline:none;text-align:center}
input:focus{border-color:#a05c17}
button{margin-top:14px;width:100%;padding:12px;border:none;border-radius:10px;background:#a05c17;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.err{color:#c0392b;font-size:13px;margin-top:12px;display:none}
</style></head><body><form class="card" id="f">
<h2>Thư viện truyện</h2>
<p>Nhập mật khẩu để đọc truyện</p>
<input id="pw" type="password" placeholder="Mật khẩu" autocomplete="current-password" autofocus>
<button type="submit">Vào đọc</button>
<div class="err" id="e">Sai mật khẩu</div>
</form><script>
document.getElementById('f').onsubmit=async(e)=>{
e.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok){location.href='/'+location.search+location.hash;location.reload();}else document.getElementById('e').style.display='block';
};
</script></body></html>`;

const requestHandler = (req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);

    // force HTTPS on the public domain — wakeLock/secure-context APIs
    // don't exist on http://. Cloudflare terminates TLS and tells us the
    // original scheme via X-Forwarded-Proto / cf-visitor.
    const host = (req.headers.host || "").split(":")[0];
    if (/\.misalab\.com$/i.test(host)) {
      const proto = (req.headers["x-forwarded-proto"] || "").toLowerCase();
      const cfv = req.headers["cf-visitor"] || "";
      const isHttps = req.socket.encrypted || proto === "https" || cfv.includes('"scheme":"https"');
      if (!isHttps) {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        res.end();
        return;
      }
    }

    // ---- auth ----
    if (urlPath === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let pw = "";
        try { pw = JSON.parse(body).password; } catch {}
        if (pw === PASSWORD) {
          send(res, 200, "{}", {
            "Content-Type": "application/json",
            "Set-Cookie": `${COOKIE_NAME}=${AUTH_TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          });
        } else {
          send(res, 401, "{}");
        }
      });
      return;
    }
    if (!authed(req)) {
      if (req.method === "GET" && !urlPath.startsWith("/api")) {
        send(res, 200, LOGIN_HTML, { "Content-Type": "text/html; charset=utf-8" });
      } else {
        send(res, 401, "{}");
      }
      return;
    }

    // ---- library + per-book APIs ----
    if (urlPath === "/api/books") {
      if (req.method === "GET") {
        send(res, 200, JSON.stringify(listBooks()), {
          "Content-Type": "application/json; charset=utf-8",
        });
        return;
      }
      if (req.method === "POST") {
        // {url: "https://truyendich.space/doc-truyen/<slug>[/chuong-N]"}
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const d = JSON.parse(body);
            const m = String(d.url || "").match(
              /truyendich\.space\/doc-truyen\/([a-z0-9-]+)/i
            );
            if (!m) { send(res, 400, JSON.stringify({ error: "Link không hợp lệ" }), { "Content-Type": "application/json; charset=utf-8" }); return; }
            const slug = m[1].toLowerCase();
            // already in library? -> return the existing book
            for (const b of listBooks()) {
              if (readMeta(b.id).slug === slug || b.id === slug) {
                send(res, 200, JSON.stringify({ book: b, exists: true }), { "Content-Type": "application/json; charset=utf-8" });
                return;
              }
            }
            const id = slug.slice(0, 60).replace(/^-+|-+$/g, "") || "book";
            const dir = path.join(BOOKS_DIR, id);
            const base = `https://truyendich.space/doc-truyen/${slug}/chuong-`;
            fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
            fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
              title: slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
              slug,
              source: "https://truyendich.space/doc-truyen/" + slug + "/",
              base,
            }, null, 2), "utf8");
            writeJob(id, { status: "queued", done: 0, total: 0, fail: 0, updated: Date.now() });
            enqueueJob(id, base);
            const book = listBooks().find((b) => b.id === id);
            send(res, 201, JSON.stringify({ book }), { "Content-Type": "application/json; charset=utf-8" });
          } catch (e) {
            send(res, 400, "{}");
          }
        });
        return;
      }
    }

    const bm = urlPath.match(/^\/api\/book\/([a-z0-9][a-z0-9_-]{0,63})(?:\/(.*))?$/i);
    if (bm) {
      const id = bm[1], sub = bm[2] || "";
      const dir = bookDir(id);
      if (!dir) { send(res, 404, "{}"); return; }

      if (sub === "index" && req.method === "GET") {
        send(res, 200, JSON.stringify(chapterIndex(dir)), {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        return;
      }

      // (re)start/resume a scrape — worker skips chapters already on disk
      if (sub === "job" && req.method === "POST") {
        const meta = readMeta(id);
        if (!meta.base) { send(res, 400, "{}"); return; }
        const j = readJob(id) || {};
        if (j.status === "running" || j.status === "queued") {
          send(res, 200, JSON.stringify(j), { "Content-Type": "application/json" });
          return;
        }
        j.status = "queued"; j.error = undefined; j.updated = Date.now();
        writeJob(id, j);
        enqueueJob(id, meta.base);
        send(res, 200, JSON.stringify(j), { "Content-Type": "application/json" });
        return;
      }

      // cancel a running/queued scrape (keeps downloaded chapters)
      if (sub === "job" && req.method === "DELETE") {
        const qi = jobQueue.findIndex((j) => j.id === id);
        if (qi >= 0) jobQueue.splice(qi, 1);
        const proc = jobRunning.get(id);
        if (proc) { try { proc.kill(); } catch {} jobRunning.delete(id); runQueue(); }
        const j = readJob(id) || {};
        j.status = "cancelled"; j.updated = Date.now();
        writeJob(id, j);
        send(res, 200, JSON.stringify(j), { "Content-Type": "application/json" });
        return;
      }

      // cover image saved by the scrape worker
      if (sub === "cover" && req.method === "GET") {
        for (const ext of ["jpg", "png", "webp", "jpeg"]) {
          const f = path.join(dir, "cover." + ext);
          if (fs.existsSync(f)) {
            const b = fs.readFileSync(f);
            send(res, 200, b, {
              "Content-Type": "image/" + (ext === "jpg" ? "jpeg" : ext),
              "Cache-Control": "max-age=86400",
            });
            return;
          }
        }
        send(res, 404, "{}");
        return;
      }

      const cm = sub.match(/^chapter\/(\d+)$/);
      if (cm && req.method === "GET") {
        const f = path.join(dir, "chapters", cm[1] + ".json");
        fs.readFile(f, (err, buf) => {
          if (err) { res.writeHead(404).end("Not found"); return; }
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(buf);
        });
        return;
      }

      if (sub === "state") {
        if (req.method === "GET") {
          send(res, 200, JSON.stringify(readState(id)), { "Content-Type": "application/json; charset=utf-8" });
        } else if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const d = JSON.parse(body);
              const s = readState(id);
              if (typeof d.chapter === "number" && d.chapter >= 1) {
                // progress only ratchets forward — opening an old chapter
                // (stale link, re-reading) must not rewind everyone's position.
                // d.force = deliberate "stay here" reset -> accept lower position.
                const n = Math.floor(d.chapter);
                const p = Math.max(0, Math.floor(d.para || 0));
                if (d.force === true ||
                    n > (s.chapter || 0) ||
                    (n === s.chapter && p > (s.para || 0))) {
                  s.chapter = n;
                  s.para = p;
                  s.updated = Date.now();
                  writeState(id, s);
                }
              }
              send(res, 200, JSON.stringify(s), { "Content-Type": "application/json" });
            } catch {
              send(res, 400, "{}");
            }
          });
        } else {
          send(res, 405, "{}");
        }
        return;
      }
    }

    // ---- keep display awake (Windows SetThreadExecutionState) ----
    // Works at OS level: stays on even when the reader tab is hidden/minimized,
    // which the Web Wake Lock API cannot do.
    if (urlPath === "/api/wake" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let on = false;
        try { on = !!JSON.parse(body).on; } catch {}
        if (on && !keepAwakeProc) {
          // ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED = 0x80000003
          keepAwakeProc = spawn("powershell", [
            "-NoProfile", "-Command",
            "Add-Type -Name W -Namespace C -MemberDefinition " +
              "'[DllImport(\"Kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' " +
              "-ErrorAction SilentlyContinue; [C.W]::SetThreadExecutionState(2147483653) | Out-Null; " +
              "while ($true) { Start-Sleep 3600 }",
          ], { stdio: "ignore" });
          keepAwakeProc.on("exit", () => { keepAwakeProc = null; });
        } else if (!on && keepAwakeProc) {
          keepAwakeProc.kill(); // exact child PID only
          keepAwakeProc = null;
        }
        send(res, 200, JSON.stringify({ awake: !!keepAwakeProc }), {
          "Content-Type": "application/json",
        });
      });
      return;
    }

    // ---- TTS proxies (VieNeu @ :8001, OmniVoice @ :8002) ----
    const ttsEngines = {
      "/api/tts": "http://localhost:8001",
      "/api/omni": "http://localhost:8002",
    };
    for (const [prefix, upstream] of Object.entries(ttsEngines)) {
      if (urlPath === prefix + "/voices" && req.method === "GET") {
        const up = http.get(upstream + "/voices", (r) => {
          res.writeHead(r.statusCode, { "Content-Type": "application/json; charset=utf-8" });
          r.pipe(res);
        });
        up.on("error", () => send(res, 502, "{}"));
        up.setTimeout(10000, () => up.destroy());
        return;
      }
      if (urlPath === prefix + "/stream" && req.method === "GET") {
        const q = new URL(req.url, "http://x").searchParams;
        const text = q.get("text") || "";
        const vid = q.get("voice_id") || "";
        if (!text.trim() || text.length > 2000) {
          send(res, 400, "{}");
          return;
        }
        const up = http.get(
          upstream + "/stream?text=" + encodeURIComponent(text) +
            "&voice_id=" + encodeURIComponent(vid),
          (r) => {
            res.writeHead(r.statusCode, { "Content-Type": "audio/wav" });
            r.pipe(res);
          }
        );
        up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
        // abort upstream synth only if the client truly went away —
        // req 'close' fires early under keep-alive, res 'close' before
        // writableEnded means the client socket died mid-stream
        res.on("close", () => { if (!res.writableEnded) up.destroy(); });
        return;
      }
    }

    // ---- static ----
    if (urlPath === "/") urlPath = "/index.html";

    const PUB = path.join(ROOT, "public");
    const filePath = path.normalize(path.join(PUB, urlPath));

    if (filePath !== PUB && !filePath.startsWith(PUB + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(buf);
    });
};

http.createServer(requestHandler)
  .listen(PORT, () => console.log(`Reader: http://localhost:${PORT}`));

// resume downloads interrupted by a server restart — the worker skips
// chapters already on disk, so re-queuing is effectively a resume
try {
  for (const id of fs.readdirSync(BOOKS_DIR)) {
    const j = readJob(id);
    if (j && (j.status === "running" || j.status === "queued")) {
      const meta = readMeta(id);
      if (meta.base) {
        j.status = "queued"; j.updated = Date.now();
        writeJob(id, j);
        jobQueue.push({ id, base: meta.base });
      }
    }
  }
  runQueue();
} catch {}

// HTTPS on 1346 — needed so Screen Wake Lock works on phones
// (wakeLock API requires a secure context; http://<lan-ip> is not one)
try {
  const tlsOpts = {
    key: fs.readFileSync(path.join(ROOT, "certs", "key.pem")),
    cert: fs.readFileSync(path.join(ROOT, "certs", "cert.pem")),
  };
  https.createServer(tlsOpts, requestHandler)
    .listen(1346, () => console.log(`Reader TLS: https://<lan-ip>:1346`));
} catch (e) {
  console.log("HTTPS disabled (no certs/*.pem):", e.message);
}
