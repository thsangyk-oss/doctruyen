// Validate free proxies quickly — CONNECT through each to ipify via curl.
// Candidate list: fresh pull from several public proxy indexes at once —
// GeoNode JSON, ProxyScrape API, and a handful of GitHub-maintained txt
// lists. Falls back to the local proxy_http.txt / proxy_socks.txt snapshot.
const { execFile } = require("child_process");
const fs = require("fs");

// [url, proto|null] — proto prefixes bare ip:port lines; null = lines are
// already protocol-prefixed (proto://ip:port)
const SOURCES = [
  ["https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text", "http"],
  ["https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&proxy_format=ipport&format=text", "socks4"],
  ["https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text", "socks5"],
  ["https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", "http"],
  ["https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", "socks4"],
  ["https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", "socks5"],
  ["https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", "http"],
  ["https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", "socks5"],
  ["https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt", "http"],
  ["https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", "socks5"],
  ["https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", "http"],
  ["https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", "http"],
  ["https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", "socks5"],
  ["https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", null],
];

async function fetchText(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return await r.text();
  } finally { clearTimeout(t); }
}

function parseList(text, proto, out) {
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    let m = s.match(/^(https?|socks4|socks5):\/\/(\d+\.\d+\.\d+\.\d+:\d+)$/);
    if (m) { out.add(m[1] + "://" + m[2]); continue; }
    m = s.match(/^(\d+\.\d+\.\d+\.\d+:\d+)$/);
    if (m && proto) out.add(proto + "://" + m[1]);
  }
}

async function fetchCandidates() {
  const out = new Set();
  // GeoNode JSON (live index, recency-sorted)
  try {
    for (let p = 1; p <= 8; p++) {
      const r = await fetch(
        `https://proxylist.geonode.com/api/proxy-list?limit=500&page=${p}&sort_by=lastChecked&sort_type=desc`,
        { signal: AbortSignal.timeout(12000) });
      const d = await r.json();
      for (const x of d.data || []) {
        const proto = (x.protocols || [])[0] || "http";
        out.add(`${/socks/.test(proto) ? proto : "http"}://${x.ip}:${x.port}`);
      }
      if (!d.data || !d.data.length || out.length >= (d.total || 0)) break;
    }
  } catch (e) { console.log("geonode failed:", String(e.message || e).slice(0, 60)); }

  // all text sources in parallel — a dead source costs nothing
  await Promise.allSettled(SOURCES.map(async ([url, proto]) => {
    try { parseList(await fetchText(url), proto, out); }
    catch (e) { console.log(`source failed ${url.slice(0, 60)}:`, String(e.message || e).slice(0, 40)); }
  }));

  // local snapshot fallback if every remote source died
  if (out.size < 200) {
    for (const [f, proto] of [["proxy_http.txt", "http"], ["proxy_socks.txt", "socks5"]]) {
      try {
        for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
          const p = line.trim();
          if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(p)) out.add(proto + "://" + p);
        }
      } catch {}
    }
  }
  // shuffle so validation spreads across sources instead of draining one
  return [...out].sort(() => Math.random() - 0.5);
}

const TIMEOUT = 7000, CONC = 60;
const alive = [];
let done = 0, tested = 0;
const SKIP = parseInt(process.argv[3] || "0", 10);
const MAX_TEST = parseInt(process.argv[2] || "400", 10) + SKIP;

function check(px) {
  return new Promise((res) => {
    const t0 = Date.now();
    execFile("curl", ["-x", px, "--max-time", "8", "-s", "--connect-timeout", "6",
      "https://api.ipify.org?format=json"], { timeout: TIMEOUT + 2000 }, (e, out) => {
      const ms = Date.now() - t0;
      if (!e && /"ip"/.test(out)) return res({ px, ms });
      res(null);
    });
  });
}

(async () => {
  const lists = await fetchCandidates();
  console.log("total candidates:", lists.length);
  const queue = lists.slice(SKIP, MAX_TEST);
  const running = new Set();
  for (const px of queue) {
    const p = check(px).then((r) => {
      running.delete(p); tested++;
      if (r) { alive.push(r); console.log(`ALIVE ${r.px} ${r.ms}ms  (tested=${tested} alive=${alive.length})`); }
    });
    running.add(p);
    if (running.size >= CONC) await Promise.race(running);
    if (alive.length >= 300) break; // enough
  }
  await Promise.allSettled([...running]);
  const OUT = process.env.PROXY_OUT || "proxy_alive.txt";
  fs.writeFileSync(OUT, alive.map((a) => a.px).join("\n") + "\n");
  console.log(`\nDONE: ${alive.length}/${tested} alive -> ${OUT}`);
})();
