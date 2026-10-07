# -*- coding: utf-8 -*-
"""Scrape all chapters of the novel from truyendich.space into data/chapters/{n}.json
Uses curl.exe (Schannel TLS fingerprint passes Cloudflare) - sequential, throttled."""
import json
import os
import re
import subprocess
import sys
import time
from html import unescape

BASE = "https://truyendich.space/doc-truyen/mang-theo-dien-thoai-trung-sinh-muc-tieu-khoa-hoc-ky-thuat-giao-phu/chuong-{}"
TOTAL = 814
DELAY = 1.8          # seconds between requests
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "chapters")
os.makedirs(OUT_DIR, exist_ok=True)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

RE_TITLE = re.compile(r'<h1[^>]*itemProp="name"[^>]*>(.*?)</h1>', re.S)
RE_CONTENT = re.compile(r'<div id="original-content-tab"[^>]*>(.*?)</div></section>', re.S)
RE_P = re.compile(r"<p[^>]*>(.*?)</p>", re.S)
RE_TAG = re.compile(r"<[^>]+>")


JAR = os.path.normpath(os.path.join(OUT_DIR, "..", "cookies.txt"))


def curl_get(url: str):
    """Returns (status, body) using curl.exe with persistent cookie jar"""
    p = subprocess.run(
        ["curl.exe", "-s", "-o", "-", "-w", "\n%{http_code}", "-A", UA,
         "-b", JAR, "-c", JAR,
         "--connect-timeout", "15", "--max-time", "40", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = p.stdout or ""
    body, _, code = out.rpartition("\n")
    return code.strip(), body


def warmup():
    """Visit homepage to obtain session cookies (cf_clearance etc.)"""
    os.makedirs(os.path.dirname(JAR), exist_ok=True)
    code, body = curl_get("https://truyendich.space/")
    return code == "200"


def is_blocked(body: str) -> bool:
    # CF nhung script challenge vao moi response -> chi dua vao viec THIEU noi dung
    return "original-content-tab" not in body


def parse(html: str):
    m = RE_TITLE.search(html)
    title = unescape(RE_TAG.sub("", m.group(1))).strip() if m else ""
    m = RE_CONTENT.search(html)
    paras = []
    if m:
        for p in RE_P.findall(m.group(1)):
            text = unescape(RE_TAG.sub("", p)).strip()
            if text:
                paras.append(text)
    return title, paras


def fetch(n: int):
    path = os.path.join(OUT_DIR, f"{n}.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                if json.load(f).get("paras"):
                    return n, "cached", None
        except Exception:
            pass
    code, body = curl_get(BASE.format(n))
    if code == "200" and not is_blocked(body):
        title, paras = parse(body)
        if paras:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"num": n, "title": title, "paras": paras}, f, ensure_ascii=False)
            return n, "ok", None
        return n, "empty", None
    if code == "307" or is_blocked(body):
        return n, "blocked", None
    return n, f"http{code}", None


def main():
    nums = list(range(1, TOTAL + 1))
    if len(sys.argv) > 1:
        nums = [int(x) for x in sys.argv[1:]]
    done = fail = 0
    consec_block = 0
    t0 = time.time()
    for n in nums:
        n, st, _ = fetch(n)
        if st in ("ok", "cached"):
            done += 1
            consec_block = 0
            if done % 25 == 0:
                rate = done / (time.time() - t0)
                eta = (len(nums) - done - fail) / rate if rate else 0
                print(f"progress: {done} done, {fail} fail | {rate:.2f}/s | ETA {eta/60:.0f}m", flush=True)
        elif st == "blocked":
            consec_block += 1
            wait = min(120, 15 * consec_block)
            print(f"chuong {n}: BLOCKED, doi {wait}s (lan {consec_block})", flush=True)
            time.sleep(wait)
            # retry once after wait
            n2, st2, _ = fetch(n)
            if st2 in ("ok", "cached"):
                done += 1
                consec_block = 0
            else:
                fail += 1
                print(f"[FAIL] chuong {n}: {st2}", flush=True)
                if consec_block > 8:
                    print("Bi chan lien tuc - dung lai, chay lai sau.", flush=True)
                    break
        else:
            fail += 1
            print(f"[FAIL] chuong {n}: {st}", flush=True)
        time.sleep(DELAY)

    # rebuild index
    index = []
    for i in range(1, TOTAL + 1):
        p = os.path.join(OUT_DIR, f"{i}.json")
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    index.append({"num": i, "title": json.load(f).get("title", "")})
            except Exception:
                pass
    with open(os.path.join(os.path.dirname(OUT_DIR), "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    print(f"DONE: {done} ok, {fail} failed | index: {len(index)} ch", flush=True)


if __name__ == "__main__":
    main()
