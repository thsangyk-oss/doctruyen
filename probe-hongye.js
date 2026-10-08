// probe hongyebookzhai.com book page structure
const fs = require("fs");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function get(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "follow",
    });
    const buf = Buffer.from(await r.arrayBuffer());
    // detect charset from meta tag, fallback chain utf8 -> gbk
    const head = new TextDecoder("ascii").decode(buf.slice(0, 4096));
    const cs = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
    const dec = /gbk|gb2312|gb18030/i.test(cs) ? new TextDecoder("gbk") : new TextDecoder("utf-8");
    return { status: r.status, url: r.url, charset: cs, text: dec.decode(buf) };
  } catch (e) {
    return { status: "err", err: String(e && e.message || e) };
  }
}

(async () => {
  const r = await get("https://www.hongyebookzhai.com/shuzhai/157662/");
  console.log("status:", r.status, "| url:", r.url, "| charset:", r.charset, "| len:", r.text ? r.text.length : 0);
  if (!r.text) { console.log("err:", r.err); return; }
  fs.writeFileSync("hy_book.html", r.text);
  const t = r.text.match(/<title>([^<]+)<\/title>/i);
  console.log("title:", t && t[1].trim());
  const h1 = r.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  console.log("h1:", h1 && h1[1].replace(/<[^>]+>/g, "").trim());
  // chapter links — print a sample of href patterns
  const links = [...new Set([...r.text.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]))];
  const chapLike = links.filter(u => /\d{5,}/.test(u) && !/\.(css|js|png|jpg|ico)/.test(u));
  console.log("total links:", links.length, "| chap-like:", chapLike.length);
  chapLike.slice(0, 8).forEach(u => console.log("  ", u));
  // check for the missing chapter numbers 1066 / 1169-1172 anywhere
  for (const n of ["1066", "1169", "1170", "1171", "1172", "1144", "1444"]) {
    const m = r.text.match(new RegExp("[^>]*第" + n + "章[^<]*"));
    if (m) console.log("found 第" + n + "章:", m[0].trim().slice(0, 60));
  }
})();
