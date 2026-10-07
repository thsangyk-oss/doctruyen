# CRAWL.MD — Hệ thống crawler truyện (truyendich.space)

Tài liệu kỹ thuật đầy đủ về crawler: cách worker được tạo, cách lấy truyện,
cách kiếm/nạp proxy miễn phí, và mô hình đa-luồng-lane. Đọc file này trước
khi chỉnh sửa `scrape-book.js`, `proxy-check.js`, hoặc phần job trong
`server.js`.

---

## 1. Kiến trúc tổng quan

```
Browser UI ──POST /api/book/<id>/job──> server.js ──spawn──> scrape-book.js (worker)
                                              │                 │
                                              │                 ├─ chapters/<n>.json  (nội dung)
                                              │                 ├─ chapters/_index.json (map num→title)
                                              │                 ├─ meta.json     (title/slug/base/cover/total)
                                              │                 ├─ job.json      (progress heartbeat)
                                              │                 ├─ scrape.log    (nhật ký rotation)
                                              │                 ├─ worker.out    (stdout/stderr của worker)
                                              │                 └─ job.json.log  (uncaught/unhandled)
                                              │
                                              └─ proxy_alive*.txt  (pool IP đã validate)
                                                 proxy-check.js    (tải list + validate)
```

- `server.js` giữ `jobQueue` + `jobRunning` (Map id→ChildProcess). **Một worker
  chạy tại một thời điểm** (`if (jobRunning.size) return`) — vì limiter của site
  tính theo IP nguồn, 2 worker song song chỉ đốt pool nhanh gấp đôi chứ không
  nhanh hơn.
- Resume an toàn: worker bỏ qua chương đã có trên đĩa → enqueue lại = tiếp tục.
- Watchdog trong `server.js`: job `running` mà `job.json` không cập nhật >10 phút
  → kill worker + re-queue (phân biệt "đang chờ cooldown" với "treo" qua heartbeat
  — worker ghi `job.updated` mỗi 15s cả khi ngủ).
- `enqueueJob` → `maybeRefreshProxies()`: nếu mọi file `proxy_alive*.txt` cũ
  hơn **6h** → chạy `proxy-check.js 15000` nền để làm tươi pool cho lần sau.

## 2. Worker (`scrape-book.js`)

Spawn: `node scrape-book.js --dir=<book dir> --base=<.../doc-truyen/<slug>/chuong->`
(kèm `--slug` hoặc tự suy ra từ `--base`; `--cover-only` chỉ tải cover).

### Browser & fingerprint

- `puppeteer-core` + Chrome thật (`C:\Program Files\Google\Chrome\Application\chrome.exe`),
  `headless: false`, profile cố định `.chrome-profile/` — giữ cookie
  `cf_clearance` Cloudflare. **Node fetch thuần bị CF chặn** (TLS fingerprint)
  → mọi request đi qua `page.evaluate(fetch)` trong browser.
- Hai loại page: default context (IP thật — "direct lane") và
  `browser.createBrowserContext({ proxyServer })` (Puppeteer ≥ 25 hỗ trợ proxy
  per-context → mỗi context = IP riêng + cookie jar riêng).
- Fetch bắt buộc chạy từ page có origin `truyendich.space` — `about:blank` có
  origin `null` → `credentials:"include"` sẽ `Failed to fetch`. `ensureContext()`
  re-nav về site trước khi fetch; sau khi giải challenge (`clearVerify`) phải
  quay lại trang thật.

### Endpoint lấy dữ liệu (đã trinh sát)

```
GET /api/novels/<slug>              → meta JSON {title,image_url,latest_chapter_number}
GET /api/novels/<slug>/chapters/<n> → {title, content, available_editions,...} (~8KB)
GET /doc-truyen/<slug>/chuong-<n>   → HTML ~70KB, content trong #original-content-tab
                                                       (fallback: #translated-content-tab)
```

- `content` của API bọc trong thẻ literal `<content>...</content>` — strip trước
  khi split đoạn.
- **API và HTML nằm ở 2 rate-bucket RIÊNG** trên cùng IP (đo thực tế: API 403
  `SOFT_FORBIDDEN` trong khi HTML vẫn 200). Worker khai thác: API hết budget →
  lane chuyển `mode="html"` dùng tiếp bucket HTML cho tới khi nó cũng limit.
- **Quan trọng — chương "rỗng"**: nhiều dải chương API trả `content:""` nhưng
  HTML có đủ nội dung (edition mặc định thiếu). `empty-site` → luôn thử HTML
  trước khi ghi stub. Stub hợp lệ (`paras:[]`, `empty:true`) vẫn được retry ở các
  lần update sau (`have()` chỉ tính chương có paras) — cố ý: site có thể bổ sung
  nội dung sau.
- 404 → stub `missing` (ghi file rỗng để không retry vô hạn… nhưng `have()` vẫn
  re-verify stub; cân nhắc nếu muốn skip hoàn toàn).

### Rate limit thực tế (đo được)

- Đếm **số request theo IP nguồn trong cửa sổ ~5 phút** — spacing gần như không
  ảnh hưởng (15 req @25s cũng dính như 8 req @1.2s).
- Ngưỡng thay đổi theo thời điểm: IP sạch 8-16 req; IP "nóng"/proxy dùng chung
  có thể chỉ 2-4 req.
- Phản hồi: `429`, `403 {"detail":{"code":"SOFT_FORBIDDEN","retry_after":N}}`,
  hoặc redirect `/verify-human` / `{"detail":"VERIFY_HUMAN"}`.
- `retry_after`/`seconds=` → dùng làm thời gian cool lane (tối thiểu 300s).
- Hình phạt leo thang nếu IP tái phạm liên tục (đã thấy 120→1800s); chạy sạch
  lâu thì budget nới lại.

## 3. Lane pool — mô hình đa-luồng proxy

Mỗi "lane" = một danh tính mạng (IP + cookie jar). Mảng `lanes` gồm:

- `{ px: null }` — **direct lane**: IP nhà, dùng default context + profile cookie
  sẵn có.
- `{ px: "http://ip:port" | "socks4://..." | "socks5://..." }` — proxy lane, mỗi
  cái một `BrowserContext` riêng.

Trạng thái lane: `coolUntil` (đang cool), `inUse` (worker nào đó giữ), `fails`
(2 lần fail liên tiếp → `dead`). Direct lane không bao giờ `dead`.

Vòng đời 1 lượt sử dụng lane:

```
pickLane() → activate(): tạo context → land /api/novels/<slug> (nav rẻ ~2KB,
đủ để có origin + cookie) → giải Turnstile nếu bị verify (≤3 lần) → page sẵn sàng
→ fetch chương liên tục (INTRA_DELAY 150ms) cho tới LIMITED → releaseLane:
coolUntil = now + max(reported, 300s), đóng context, trả về pool
```

**Parallel + warm-spare pipeline:**

- `PARALLEL = 10` worker async trong cùng process, mỗi worker giữ 1 lane hiện tại
  + **2 spare lane đã được warm** (activate sẵn trong nền). Lý do: lane chỉ
  yield ~4-12 req (~2s làm việc) nhưng setup mất 2-5s → cần 2 spare để rotation
  không deadtime. Khi lane LIMITED → `nextLane()` lấy spare đã sẵn sàng → đổi
  gần như tức thì.
- Hàng đợi chương chia sẻ: `claimNext()` bốc số chương (bỏ qua file đã có);
  chương lỗi/limited đẩy vào `pushback[]` để retry — không mất chương.
- `job.proxy` hiển thị `inUse/alive lanes` cho UI.

**Bảo vệ mất mạng (`netAlive`)**: khi INTERNET CỦA MÌNH rớt (cúp điện/modem),
mọi lane fail đồng loạt. Trước khi phạt lane, worker test `fetch(api.ipify,
no-cors)` trên direct page — chết cả direct → mất mạng → `waitPulse(60s)`, giữ
nguyên pool. Nếu không có check này, một lần rớt mạng sẽ đánh cooling/dead nhầm
toàn bộ pool.

**Giới hạn thiết kế (đo được, trần thực tế):**
- ~1 req bị đốt cho mỗi lần setup lane (nav) — với budget ~2-4 req/IP thì ~25-33%
  budget vào setup. Đã là minimum, không giảm được nữa.
- Trần sustained ≈ `số lane sống × yield trung bình / 300s`. Pool 350 × ~4 ≈
  ~280 req/5ph ≈ ~55-90 ch/ph thực đo. Muốn cao hơn: pool to hơn hoặc proxy trả
  phí (IP sạch không dùng chung → yield 12-16 req).

## 4. Kiếm proxy miễn phí (`proxy-check.js`)

### Nguồn (fetch song song trong `fetchCandidates()`)

| Nguồn | Endpoint | Ghi chú |
|---|---|---|
| GeoNode | `proxylist.geonode.com/api/proxy-list?limit=500&page=N&sort_by=lastChecked` | JSON live index, ~3.6k entry, có field protocols[] |
| ProxyScrape | `api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http|socks4|socks5&proxy_format=ipport&format=text` | text ip:port |
| TheSpeedX/PROXY-List | `raw.githubusercontent.com/TheSpeedX/PROXY-List/master/{http,socks4,socks5}.txt` | lớn (~9k) |
| monosans/proxy-list | `.../monosans/proxy-list/main/proxies/{http,socks5}.txt` | cập nhật thường xuyên |
| jetkai/proxy-list | `.../online-proxies/txt/proxies-{http,socks5}.txt` | |
| clarketm/proxy-list | `.../proxy-list-raw.txt` | |
| mmpx12/proxy-list | `.../{http,socks5}.txt` | |
| proxifly/free-proxy-list | `.../proxies/all/data.txt` | format `proto://ip:port` sẵn, ~49k entry (nhiều entry cũ) |

Tổng candidate ~59k sau dedupe. Nguồn chết chỉ log `source failed` — không chặn
các nguồn khác. Mọi remote chết → fallback snapshot `proxy_http.txt` /
`proxy_socks.txt` local.

### Validate

- Mỗi candidate: `curl -x <proxy> --max-time 8 https://api.ipify.org?format=json` —
  sống khi trả JSON có `"ip"`. Concurrency 60, timeout 7s.
- **Shuffle trước khi test** — trộn đều nguồn, tránh dồn test vào một list.
- Chạy tới khi đủ `alive >= 300` hoặc hết `MAX_TEST` (arg2; `server.js` truyền
  15000). arg3 = offset nếu muốn test tiếp phần sau của list.
- Ghi `PROXY_OUT` (env, mặc định `proxy_alive.txt`).

**Thêm nguồn mới**: thêm dòng `[url, proto]` vào `SOURCES` — `proto=null` nếu
dòng đã có sẵn `scheme://`, còn `ip:port` trần thì truyền `"http"|"socks5"|...`.
Parser nhận cả hai dạng.

**Nạp vào worker**: `scrape-book.js` đọc **mọi file `proxy_alive*.txt`** ở root
project khi khởi động, dedupe bằng Set → file mới chỉ cần đặt đúng tên là tự
vào pool ở lần chạy sau.

## 5. Thực tế về proxy miễn phí (đừng kỳ vọng)

- ~2-11% candidate sống tại một thời điểm; tuổi thọ vài giờ.
- Nhiều IP "nóng sẵn" do người khác dùng → lane cho `0 reqs` — bình thường,
  worker tự bỏ qua.
- Một số proxy cùng /24 hoặc exit chung → budget chia sẻ, không tránh được.
- **Bảo mật**: proxy free nhìn thấy toàn bộ request qua nó. Chỉ dùng cho
  traffic crawl tới site truyện công khai — tuyệt đối không gửi cookie
  `sang_auth`, mật khẩu, hay traffic cá nhân qua pool. Cookie `cf_clearance`
  trong `.chrome-profile` là nhạy cảm — không commit, không gửi qua proxy lane
  (mỗi proxy context có jar riêng, không mang theo clearance).
- Danh sách nguồn nằm ở `SOURCES` trong `proxy-check.js`; cập nhật định kỳ vì
  các list GitHub hay đổi path/chết repo.

## 6. File dữ liệu

```
data/books/<id>/
  meta.json          {title, slug, base, cover, total, subtitle?}
  chapters/<n>.json  {num, title, paras[], empty?}
  chapters/_index.json  { "n": "title" }  — map nhẹ cho danh sách chương,
                      server đọc file này thay vì parse cả nghìn file
                      (KHÔNG match regex ^\d+\.json$ nên không tính là chương)
  state.json         {chapter, para, updated} — vị trí đọc đồng bộ
  job.json           {status: queued|running|done|paused|error, done, total,
                      fail, updated, note?, proxy?}
  scrape.log         nhật ký theo dòng giờ (rotate/limit/err)
  worker.out         stdout/stderr của worker (spawn fd)
  job.json.log       uncaughtException/unhandledRejection
```

`job.done` = số chương **unique trên đĩa** (Set `savedSet`) — không phải số
lượt xử lý (bản cũ đếm lượt nên vượt total khi re-verify stub).

## 7. Khắc phục sự cố nhanh

| Triệu chứng | Nguyên nhân hay gặp | Xử lý |
|---|---|---|
| Worker biến mất không log | xem `worker.out` + `job.json.log` | spawn qua server mới có log |
| Mọi fetch `Failed to fetch` | page ở `about:blank` (origin null) | `ensureContext` trước fetch |
| Toàn `0 reqs` lanes | IP proxy nóng sẵn (dùng chung) | bình thường — pool xoay tiếp |
| Cả pool cooling cùng lúc | vừa mất mạng → bị phạt nhầm | netAlive đã fix; restart worker nếu cần |
| `The browser is already running` | 2 worker cùng dùng `.chrome-profile` | kill worker cũ, chỉ 1 worker/profile |
| API `SOFT_FORBIDDEN` mà HTML 200 | 2 bucket riêng — worker tự chuyển mode | không cần làm gì |
| `/api/books` chậm | `_index.json` cũ/thiếu | đọc 1 lần sẽ tự build cache |
| Chương vẫn rỗng sau re-verify | site thật sự chưa có nội dung (hoặc verify-human chặn cả HTML) | đợi, update sau sẽ thử lại |

## 8. Tham số chỉnh nhanh (`scrape-book.js`)

| Hằng | Mặc định | Ý nghĩa |
|---|---|---|
| `PARALLEL` | 10 | số worker async = số lane hiện tại đồng thời (mỗi worker còn giữ 2 spare) |
| `INTRA_DELAY` | 150ms | nghỉ giữa các request trong cùng lane |
| `LANE_REQ_CAP` | 40 | rotate chủ động sau N req dù chưa limited (cho lane nghỉ) |
| warm depth | 2 | số spare lane activate trước — tăng nếu setup lane >> thời gian burn |
| `PROF` | `.chrome-profile` | profile giữ cf_clearance; đừng đổi nếu không muốn giải lại CF |
| proxy staleness | 6h (`server.js`) | pool cũ hơn mức này → auto chạy lại checker lúc enqueue |

## Nguồn phụ: `webtruyendich.com` (`scrape-webtruyendich.js`)

Worker riêng để bơm chương vào sách CÓ SẴN khi nguồn chính hết chương. Cùng mô hình lane pool + warm spare + job.json, khác phần fetch:

**Chapter list** — GET public, không gated:
```
/api/novels/<novel_id>/chapters?source=<edition>&page=<n>&limit=50
→ {data:[{chapter_url:"chuong-815-...",title,timestamp}],pagination:{total_pages,has_next}}
```
novel_id lấy từ `window.novel_id` trên trang truyện (không phải slug). Num parse từ `chuong-(\d+)` trong slug.

**Chapter body** — POST + Turnstile token single-use:
```
POST /api/getChapter   header: cf-turnstile-response:<token>
body: {novel_id, source_id, chapter_url, translator:"gemini-3.5-flash-lite",
       is_free:true, use_memory:true, target_lang:"Vietnamese", is_prefetch:false}
→ {title, content:"para<br><br>para"} — full content, KHÔNG stream
```
- Token mint bằng `await executeTurnstile()` — hàm CÓ SẴN của site trên trang chương (managed widget tự refill). KHÔNG đọc input `[name=cf-turnstile-response]` trực tiếp — hay bị loader của trang chiếm mất.
- `source_id` "3" = edition `fanqie` (bắt từ POST thật). Edition khác → sniff lại POST body.
- `/api/getChapterStream` là phiên bản SSE (typewriter, chống cào) — cùng auth, bỏ qua, dùng `/api/getChapter`.
- Trang chương HTML ~1.27MB nhưng KHÔNG chứa nội dung — content chỉ tồn tại qua API. Đừng parse DOM.

**Gating** — chapter page nav bị CF managed challenge ("Chờ một chút"): 1 click Turnstile → clear cho cả context. Direct lane được ~21 req/lượt trước LIMITED; POST latency tăng dần theo IP (pacing server-side) → rotate sớm (`LANE_REQ_CAP=25`). Chapter LIST không gated — fetch thẳng bằng Node, không cần browser.

**Chạy**: `node scrape-webtruyendich.js --dir=data/books/<id> --novel=<id> --source=fanqie --book-slug=<slug> --start=<n>` — profile riêng `.chrome-profile-wt`, chỉ ghi chương ≥ `--start`, title strip prefix `Chương N:` cho khớp format cũ.
