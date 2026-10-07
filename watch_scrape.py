# -*- coding: utf-8 -*-
"""Wait for Cloudflare ban to expire, then scrape all chapters politely.
Loops: probe -> scrape missing -> back to probe if re-blocked. Resumable."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import OUT_DIR, BASE, TOTAL, curl_get, is_blocked, parse, warmup  # reuse

PROBE_N = 30
PROBE_WAIT = 180        # between probes while banned
SCRAPE_DELAY = 0.15     # ~20% drop rate, chi can retry nhanh
BLOCK_BACKOFF = 3       # wait after a dropped request
MAX_BLOCK_STREAK = 60   # neu bi chan hang loat thi moi dung
MAX_RETRY = 6           # in-place retries per chapter


def have(n):
    p = os.path.join(OUT_DIR, f"{n}.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return bool(json.load(f).get("paras"))
        except Exception:
            return False
    return False


def probe():
    code, body = curl_get(BASE.format(PROBE_N))
    ok = code == "200" and "original-content-tab" in body
    if not ok:
        print(f"  [probe] http={code} len={len(body)}", flush=True)
    return ok


def scrape_pass():
    """One pass over missing chapters. Returns ('done'|'blocked', count)."""
    got = 0
    streak = 0
    n = 1
    while n <= TOTAL:
        if have(n):
            n += 1
            continue
        ok = False
        for attempt in range(MAX_RETRY):
            code, body = curl_get(BASE.format(n))
            if code == "200" and "original-content-tab" in body:
                title, paras = parse(body)
                if paras:
                    with open(os.path.join(OUT_DIR, f"{n}.json"), "w", encoding="utf-8") as f:
                        json.dump({"num": n, "title": title, "paras": paras}, f, ensure_ascii=False)
                    ok = True
                    break
            # blocked or empty page: back off and retry
            wait = BLOCK_BACKOFF * (attempt + 1)
            print(f"  chuong {n}: chan/empty (http {code}), doi {wait}s thu lai", flush=True)
            streak += 1
            if streak >= MAX_BLOCK_STREAK * MAX_RETRY:
                return "blocked", got
            time.sleep(wait)
        if ok:
            got += 1
            streak = 0
            if got % 10 == 0:
                print(f"  +{got} chuong (dang o chuong {n})", flush=True)
        else:
            print(f"  chuong {n}: bo qua sau {MAX_RETRY} lan thu", flush=True)
        n += 1
        time.sleep(SCRAPE_DELAY)
    return "done", got


def main():
    print("Watcher start. Warm-up lay cookie...", flush=True)
    warmup()
    noprog = 0
    while True:
        missing = [n for n in range(1, TOTAL + 1) if not have(n)]
        if not missing:
            print("TAT CA CHUONG DA XONG!", flush=True)
            break
        if not probe():
            print(f"Con {len(missing)} chuong thieu. Van bi chan - warm-up lai, doi {PROBE_WAIT}s", flush=True)
            warmup()
            time.sleep(PROBE_WAIT)
            continue
        print(f"DA MO! Bat dau scrape {len(missing)} chuong con lai...", flush=True)
        status, got = scrape_pass()
        print(f"Pass xong: +{got} chuong, status={status}", flush=True)
        if status == "blocked":
            print("Bi chan lai - quay ve che do probe", flush=True)
            time.sleep(120)
        if got == 0 and status == "done":
            noprog += 1
            if noprog >= 3:
                print("3 pass lien khong co tien trien - dung (con lai co the la chuong loi)", flush=True)
                break
        else:
            noprog = 0
    # rebuild index.json snapshot (server builds it live anyway)
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
    print(f"index.json: {len(index)} chuong", flush=True)


if __name__ == "__main__":
    main()
