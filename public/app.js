/* Novel reader + library — ?book=<id> opens a book, bare / shows the library */
(function () {
  "use strict";

  /* ---------- book routing ---------- */
  // ?book=<id> -> reader for that book; no ?book -> library grid.
  // Legacy #chuong-N links (no ?book) open the most recently read book.
  var qs = new URLSearchParams(location.search);
  var BOOK = qs.get("book") || "";
  var books = [];      // /api/books listing
  var bookMeta = null; // current book's library entry
  function apiB(p) { return "/api/book/" + encodeURIComponent(BOOK) + p; }

  var SET_KEY = "mtdt_settings_v1"; // shared reader settings across books
  function posKey() { return "mtdt_pos_" + BOOK; } // per-book local position

  var saved = load(SET_KEY) || {};
  var legacy = load("mtdt_reader_v1") || {}; // pre-library single-book state
  var state = {
    chapter: +localStorage.getItem(posKey()) || legacy.chapter || 1,
    theme: saved.theme || legacy.theme || "sepia",
    fontSize: saved.fontSize || legacy.fontSize || 20,
    lineHeight: saved.lineHeight || legacy.lineHeight || 1.85,
    font: saved.font || legacy.font || "serif",
    width: saved.width || legacy.width || "normal",
    layout: saved.layout || "scroll",
    flip: saved.flip || "on",
  };
  var index = [];        // [{num,title}]
  var cache = {};        // num -> chapter data
  var filtered = null;   // filtered index for search, null = all

  var $ = function (id) { return document.getElementById(id); };
  var reader = $("reader");

  function load(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }
  function save() {
    localStorage.setItem(SET_KEY, JSON.stringify({
      theme: state.theme, fontSize: state.fontSize,
      lineHeight: state.lineHeight, font: state.font, width: state.width,
      layout: state.layout, flip: state.flip,
    }));
    if (BOOK) localStorage.setItem(posKey(), String(state.chapter));
  }

  /* ---------- theme / settings ---------- */
  function applySettings() {
    document.body.dataset.theme = state.theme;
    document.body.dataset.font = state.font;
    document.body.dataset.width = state.width;
    var body = $("chap-body");
    body.style.fontSize = state.fontSize + "px";
    body.style.lineHeight = state.lineHeight;
    $("fs-val").textContent = state.fontSize;
    $("lh-val").textContent = state.lineHeight.toFixed(2);
    markSeg("theme-seg", "theme-val", state.theme);
    markSeg("font-seg", "font", state.font);
    markSeg("width-seg", "width", state.width);
    markSeg("layout-seg", "layout", state.layout);
    markSeg("flip-seg", "flip", state.flip);
    document.body.dataset.layout = state.layout;
    paginateBook(true); // recompute columns, keep the paragraph in view
    save();
  }
  function markSeg(id, attr, val) {
    var kids = $(id).children;
    for (var i = 0; i < kids.length; i++)
      kids[i].classList.toggle("on", kids[i].dataset[attr] === val);
  }
  var THEMES = ["light", "sepia", "dark"];
  function cycleTheme() {
    state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    applySettings();
  }

  /* ---------- data ---------- */
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function hasNum(n) {
    for (var i = 0; i < index.length; i++) if (index[i].num === n) return true;
    return false;
  }
  function nearestNum(n, dir) {
    // nearest available chapter at/after (dir>0) or at/before (dir<0) n
    var best = null;
    for (var i = 0; i < index.length; i++) {
      var c = index[i].num;
      if (dir > 0 && c >= n && (best === null || c < best)) best = c;
      if (dir < 0 && c <= n && (best === null || c > best)) best = c;
    }
    return best;
  }

  function prefetch(n) {
    if (n >= 1 && hasNum(n) && !cache[n]) {
      cache[n] = fetchJSON(apiB("/chapter/" + n)).catch(function () {
        delete cache[n];
      });
    }
  }

  function getChapter(n) {
    if (!cache[n])
      cache[n] = fetchJSON(apiB("/chapter/" + n));
    return Promise.resolve(cache[n]);
  }

  /* ---------- rendering ---------- */
  function renderList() {
    var list = $("chapter-list");
    var items = filtered || index;
    var html = "";
    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      html += '<div class="chap-item' + (c.num === state.chapter ? " active" : "") +
        (c.num === serverChapter ? " progress" : "") +
        '" data-num="' + c.num + '"><span class="num">' + c.num +
        '</span><span class="t">' + esc(c.title || ("Chương " + c.num)) + "</span></div>";
    }
    list.innerHTML = html || '<div style="padding:16px;color:var(--text-2);font-size:13px">Không tải được danh sách chương.</div>';
    var act = list.querySelector(".active");
    if (act) act.scrollIntoView({ block: "center" });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderChapter(n) {
    getChapter(n).then(function (d) {
      state.chapter = n;
      save();
      var tp = renderParaTarget;
      renderParaTarget = null;
      pushState(n, tp || 0);
      $("chap-meta").textContent = "Chương " + n;
      $("chap-title").textContent = d.title || "";
      var html = "";
      for (var i = 0; i < d.paras.length; i++) html += "<p>" + esc(d.paras[i]) + "</p>";
      $("chap-body").innerHTML = html;
      $("prev-b").disabled = nearestNum(n - 1, -1) === null;
      $("next-b").disabled = nearestNum(n + 1, 1) === null;
      document.title = "Chương " + n + (d.title ? " — " + d.title : "") +
        " | " + (bookMeta ? bookMeta.title : "Đọc truyện");
      history.replaceState(null, "",
        "?book=" + encodeURIComponent(BOOK) + "#chuong-" + n);
      reader.scrollTop = 0;
      if (state.layout === "book") {
        $("content-wrap").scrollLeft = 0;
        paginateBook();
      }
      if (tp !== null) {
        // restore paragraph position (sync/boot/resume) after content settles
        setTimeout(function () { scrollToPara(tp); }, 30);
      }
      updateProgress();
      renderList();
      updateResume();
      prefetch(n + 1);
      prefetch(n - 1);
      if (tts.on) {
        ttsClearBuf();
        // queued prefetches of the old chapter are dead — keep only the
        // next-chapter preloads (tagged -2) that may be adopted below
        ttsPending = ttsPending.filter(function (j) { return j.i < 0; });
        tts.chap = n;
        if (tts.nextChap === n && tts.nextSegs) {
          // adopt the already-synthesized audio for a gap-free transition
          tts.segs = tts.nextSegs;
          tts.buf = tts.nextBuf;
          tts.nextSegs = null; tts.nextBuf = {}; tts.nextChap = 0;
        } else {
          tts.segs = ttsBuild(d.paras);
          ttsClearNext();
        }
        var ai = ttsAnchorIdx();
        tts.idx = ai;
        if (tts.pendingStart) {
          tts.pendingStart = false;
          ttsPlay(ai);
        } else {
          ttsStop();
          ttsStatus("Chương mới — " + tts.segs.length + " đoạn. Bấm ▶ để đọc.");
        }
      }
    }).catch(function () {
      $("chap-body").innerHTML =
        '<p style="text-align:center;color:var(--text-2)">Chương ' + n + ' chưa được tải về.</p>';
    });
  }

  // serverChapter/serverPara = furthest read position (server, ratchets up only)
  // followEnabled = this device still being pulled by sync
  var serverChapter = 0, serverPara = 0, followEnabled = true;
  var renderParaTarget = null; // paragraph index to scroll to after render

  function go(n, opts) {
    n = n | 0;
    // manual navigation detaches this device from auto-sync —
    // it becomes the driver instead. resume pill re-attaches.
    if (!opts || !opts.keepFollow) followEnabled = false;
    renderParaTarget = (opts && typeof opts.para === "number") ? opts.para : null;
    if (!hasNum(n)) {
      // jump to nearest available chapter
      var down = nearestNum(n, -1), up = nearestNum(n, 1);
      if (down === null && up === null) return;
      n = (down !== null && (up === null || n - down <= up - n)) ? down : up;
      toast("Chương này chưa tải về — nhảy tới chương " + n);
    }
    renderChapter(n);
    closeSidebar();
  }

  function updateResume() {
    var show = serverChapter > state.chapter;
    $("resume-wrap").classList.toggle("show", show);
    if (show) $("resume-num").textContent = serverChapter;
  }
  $("resume-pill").addEventListener("click", function () {
    followEnabled = true;
    go(serverChapter, { keepFollow: true, para: serverPara });
  });
  // "Ở lại": deliberately make the currently-viewed position the new
  // furthest progress (re-reading on purpose). Force = accept lower position.
  $("stay-btn").addEventListener("click", function () {
    var p = currentParaIndex();
    fetch(apiB("/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: state.chapter, para: p, force: true }),
    }).then(function (r) { return r.json(); })
      .then(function (s) {
        serverChapter = s.chapter;
        serverPara = s.para || 0;
        lastWrite = Math.max(lastWrite, s.updated || 0);
        lastPushedPara = p;
        followEnabled = true; // back on the sync path at the chosen spot
        updateResume();
        renderList();
        toast("Đã đặt tiến độ: chương " + s.chapter + ", đoạn " + (p + 1));
      }).catch(function () {});
  });

  /* ---------- book (paged) layout ---------- */
  // #content-wrap is the book: fixed paper block, text flows into column
  // "pages"; wrap itself scrolls horizontally (overflow hidden), we snap
  // scrollLeft by whole spreads — no mid-column sliding.
  var bookCols = 1, bookColW = 320, bookGap = 56, bookPadX = 44;
  function bookStep() { return bookCols * (bookColW + bookGap); }
  function bookTotalCols() {
    var w = $("content-wrap");
    return Math.max(1, Math.round(
      (w.scrollWidth - bookPadX * 2 + bookGap) / (bookColW + bookGap)));
  }
  function bookPageIdx() { // index of first visible column
    return Math.max(0, Math.round(
      $("content-wrap").scrollLeft / (bookColW + bookGap)));
  }
  function paginateBook(keepPara) {
    var w = $("content-wrap");
    if (state.layout !== "book") {
      w.style.width = ""; w.style.columnWidth = ""; w.style.columnGap = "";
      w.classList.remove("twocol", "flip-next", "flip-prev", "bare");
      var lf = w.querySelector(".flip-leaf");
      if (lf) lf.remove();
      w.scrollLeft = 0;
      $("page-ind").textContent = "";
      return;
    }
    var para = keepPara && $("chap-body").children.length
      ? currentParaIndex() : null;
    var fullW = reader.clientWidth;
    bookCols = fullW >= 768 ? 2 : 1;
    // 2-col keeps a framed "book" (44px paper padding); 1-col goes bare
    // (16px gutter only) — narrow screens can't afford the frame
    bookPadX = bookCols === 2 ? 44 : 16;
    bookColW = bookCols === 2
      ? Math.min(560, Math.floor((fullW - 48 - bookGap - bookPadX * 2) / bookCols))
      : fullW - bookPadX * 2;
    var contentW = bookCols * bookColW + bookGap * (bookCols - 1);
    // column-width is a minimum hint: Chrome creates
    // floor(contentW/(colWidth+gap)) columns then stretches each to fit.
    // Set it below colW so exactly bookCols columns fill a spread.
    w.style.width = (contentW + bookPadX * 2) + "px";
    w.style.columnWidth = (bookColW - bookGap) + "px";
    w.style.columnGap = bookGap + "px";
    w.classList.toggle("twocol", bookCols === 2);
    w.classList.toggle("bare", bookCols === 1);
    if (para !== null) setTimeout(function () { scrollToPara(para); }, 30);
    updatePageInd();
  }
  function updatePageInd() {
    var el = $("page-ind");
    if (state.layout !== "book") { el.textContent = ""; return; }
    var spreads = Math.ceil(bookTotalCols() / bookCols);
    var cur = Math.min(spreads, Math.floor(bookPageIdx() / bookCols) + 1);
    el.textContent = "Trang " + cur + "/" + spreads;
  }
  // page-turn effect: clone the book into a "leaf" clipped over the
  // departing page, rotate it around the spine; the new spread is
  // already snapped underneath (same trick CSS3D flipbooks use)
  function spawnFlipLeaf(dir) {
    var w = $("content-wrap");
    var old = w.querySelector(".flip-leaf");
    if (old) old.remove();
    var BW = w.clientWidth;
    var leafW = bookCols === 2 ? Math.round(BW / 2) : BW;
    var leafL = dir > 0 && bookCols === 2 ? leafW : 0;
    var leaf = document.createElement("div");
    leaf.className = "flip-leaf " + (dir > 0 ? "fl-next" : "fl-prev");
    leaf.style.left = leafL + "px";
    leaf.style.width = leafW + "px";
    var ghost = w.cloneNode(true); // keeps id -> same CSS; inline col styles cloned too
    ghost.style.position = "absolute";
    ghost.style.top = "0";
    ghost.style.left = "-" + leafL + "px";
    ghost.style.margin = "0";
    ghost.style.border = "none";
    ghost.style.boxShadow = "none";
    ghost.style.borderRadius = "0";
    ghost.style.height = w.clientHeight + "px";
    leaf.appendChild(ghost);
    w.appendChild(leaf);
    ghost.scrollLeft = w.scrollLeft; // show the same spread inside the leaf
    setTimeout(function () { leaf.remove(); }, 420);
  }
  function flipPage(dir) {
    var w = $("content-wrap");
    var maxScroll = w.scrollWidth - w.clientWidth;
    // "at the end" = scrollLeft already maxed — the last spread may be a
    // partial one whose target exceeds maxScroll, so index math alone
    // gets stuck re-targeting the same clamped position
    if (dir > 0 && w.scrollLeft >= maxScroll - 2) {
      var n = nearestNum(state.chapter + 1, 1);
      if (n !== null) { if (state.flip !== "off") spawnFlipLeaf(dir); go(n); }
      return;
    }
    if (dir < 0 && w.scrollLeft <= 1) {
      var p = nearestNum(state.chapter - 1, -1);
      if (p !== null) { if (state.flip !== "off") spawnFlipLeaf(dir); go(p); }
      return;
    }
    var spread = Math.floor(bookPageIdx() / bookCols) + dir;
    var maxSpread = Math.ceil(bookTotalCols() / bookCols) - 1;
    spread = Math.max(0, Math.min(maxSpread, spread));
    if (state.flip !== "off") spawnFlipLeaf(dir); // captures old spread first
    w.scrollLeft = spread * bookStep(); // snap — never mid-column
    updatePageInd();
  }

  // paragraph index of the paragraph nearest the top of the reader viewport
  // (same indexing as TTS: counts only non-empty <p>s)
  function currentParaIndex() {
    var ps = $("chap-body").children, seen = -1, cur = 0;
    if (state.layout === "book") {
      // first paragraph visible inside the book's scrollport
      var left = $("content-wrap").getBoundingClientRect().left + 20;
      for (var i = 0; i < ps.length; i++) {
        if (!ps[i].textContent.trim()) continue;
        seen++;
        if (ps[i].getBoundingClientRect().right > left) return seen;
      }
      return Math.max(0, seen);
    }
    var top = reader.getBoundingClientRect().top;
    for (var i = 0; i < ps.length; i++) {
      if (!ps[i].textContent.trim()) continue;
      seen++;
      if (ps[i].getBoundingClientRect().top <= top + 80) cur = seen;
      else break;
    }
    return cur;
  }
  function scrollToPara(pi) {
    var ps = $("chap-body").children, seen = -1;
    for (var i = 0; i < ps.length; i++) {
      if (!ps[i].textContent.trim()) continue;
      seen++;
      if (seen !== pi) continue;
      if (state.layout === "book") {
        // land on the spread containing this paragraph's column
        var w = $("content-wrap");
        var paraX = ps[i].getBoundingClientRect().left -
                    w.getBoundingClientRect().left + w.scrollLeft;
        var col = Math.max(0, Math.floor((paraX - bookPadX) / (bookColW + bookGap)));
        w.scrollLeft = Math.floor(col / bookCols) * bookStep();
        updatePageInd();
        return;
      }
      ps[i].scrollIntoView({ block: "start" });
      return;
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2500);
  }

  /* ---------- sidebar / search ---------- */
  function closeSidebar() {
    $("sidebar").classList.remove("open");
  }
  function toggleSidebar() {
    var sb = $("sidebar");
    if (window.matchMedia("(max-width: 860px)").matches) {
      sb.classList.toggle("open");
      if (sb.classList.contains("open")) {
        var act = document.querySelector(".chap-item.active");
        if (act) act.scrollIntoView({ block: "center" });
      }
    } else {
      // desktop: collapse the sidebar column, reader takes the space
      sb.classList.toggle("closed");
    }
  }

  $("search").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    if (!q) { filtered = null; renderList(); return; }
    var asNum = parseInt(q, 10);
    filtered = index.filter(function (c) {
      if (!isNaN(asNum) && c.num === asNum) return true;
      return (c.title || "").toLowerCase().indexOf(q) !== -1;
    });
    renderList();
  });

  $("chapter-list").addEventListener("click", function (e) {
    var it = e.target.closest(".chap-item");
    if (it) go(+it.dataset.num);
  });
  $("btn-jump").addEventListener("click", function () {
    var v = parseInt($("jump").value, 10);
    if (v) go(v);
  });
  $("jump").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("btn-jump").click();
  });

  /* ---------- nav ---------- */
  $("prev-b").addEventListener("click", function () {
    var p = nearestNum(state.chapter - 1, -1);
    if (p !== null) go(p);
  });
  $("next-b").addEventListener("click", function () {
    var p = nearestNum(state.chapter + 1, 1);
    if (p !== null) go(p);
  });
  $("toc-b").addEventListener("click", toggleSidebar);
  $("btn-menu").addEventListener("click", toggleSidebar);
  $("sidebar-overlay").addEventListener("click", closeSidebar);

  $("btn-theme").addEventListener("click", cycleTheme);
  $("btn-settings").addEventListener("click", function () {
    $("settings-panel").classList.toggle("open");
  });
  document.addEventListener("click", function (e) {
    var p = $("settings-panel");
    if (p.classList.contains("open") &&
        !p.contains(e.target) && e.target !== $("btn-settings"))
      p.classList.remove("open");
  });

  document.addEventListener("keydown", function (e) {
    if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") {
      if (state.layout === "book") flipPage(-1); else $("prev-b").click();
    }
    else if (e.key === "ArrowRight") {
      if (state.layout === "book") flipPage(1); else $("next-b").click();
    }
    else if (e.key === "Escape") { closeSidebar(); $("settings-panel").classList.remove("open"); }
  });

  /* book mode: click left/right zone or wheel to flip a spread */
  reader.addEventListener("click", function (e) {
    if (state.layout !== "book" || tts.on) return;
    if (e.target.closest("button, a, input, .settings-panel")) return;
    var r = reader.getBoundingClientRect();
    flipPage(e.clientX < r.left + r.width * 0.4 ? -1 : 1);
  });
  var wheelTimer = 0;
  reader.addEventListener("wheel", function (e) {
    if (state.layout !== "book") return;
    e.preventDefault();
    var now = Date.now();
    if (now - wheelTimer < 350) return;
    wheelTimer = now;
    flipPage(e.deltaY < 0 ? -1 : 1);
  }, { passive: false });
  var resizeTimer = null;
  function onReaderResize() {
    if (state.layout !== "book") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { paginateBook(true); }, 200);
  }
  window.addEventListener("resize", onReaderResize);
  // sidebar collapse also resizes the reader (flex, no window event)
  if (window.ResizeObserver)
    new ResizeObserver(onReaderResize).observe(reader);

  /* settings controls */
  document.querySelectorAll("[data-fs]").forEach(function (b) {
    b.addEventListener("click", function () {
      state.fontSize = Math.max(14, Math.min(34, state.fontSize + 2 * (+b.dataset.fs)));
      applySettings();
    });
  });
  document.querySelectorAll("[data-lh]").forEach(function (b) {
    b.addEventListener("click", function () {
      state.lineHeight = Math.max(1.3, Math.min(2.5, +(state.lineHeight + 0.15 * (+b.dataset.lh)).toFixed(2)));
      applySettings();
    });
  });
  document.querySelectorAll("[data-font]").forEach(function (b) {
    b.addEventListener("click", function () { state.font = b.dataset.font; applySettings(); });
  });
  document.querySelectorAll("[data-theme-val]").forEach(function (b) {
    b.addEventListener("click", function () { state.theme = b.dataset.themeVal; applySettings(); });
  });
  document.querySelectorAll("[data-width]").forEach(function (b) {
    b.addEventListener("click", function () { state.width = b.dataset.width; applySettings(); });
  });
  document.querySelectorAll("[data-layout]").forEach(function (b) {
    b.addEventListener("click", function () { state.layout = b.dataset.layout; applySettings(); });
  });
  document.querySelectorAll("[data-flip]").forEach(function (b) {
    b.addEventListener("click", function () { state.flip = b.dataset.flip; applySettings(); });
  });

  /* scroll progress */
  function updateProgress() {
    var max, at;
    if (state.layout === "book") {
      var w = $("content-wrap");
      max = w.scrollWidth - w.clientWidth;
      at = w.scrollLeft;
      updatePageInd();
    } else {
      max = reader.scrollHeight - reader.clientHeight;
      at = reader.scrollTop;
    }
    var pct = max > 0 ? (at / max) * 100 : 0;
    $("progress-bar").style.width = pct + "%";
  }
  var paraPushTimer = null, lastPushedPara = -1;
  function onScroll() {
    updateProgress();
    // track paragraph being read -> debounce-push to server
    clearTimeout(paraPushTimer);
    paraPushTimer = setTimeout(function () {
      var p = currentParaIndex();
      if (p !== lastPushedPara) {
        lastPushedPara = p;
        pushState(state.chapter, p);
      }
    }, 800);
  }
  reader.addEventListener("scroll", onScroll, { passive: true });
  $("content-wrap").addEventListener("scroll", onScroll, { passive: true });

  /* ---------- server-side progress sync ---------- */
  var lastWrite = 0; // timestamp of our own last state write

  function pushState(n, p) {
    fetch(apiB("/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: n, para: p || 0 }),
    }).then(function (r) { return r.json(); })
      .then(function (s) {
        lastWrite = Math.max(lastWrite, s.updated || Date.now());
        if (s.chapter !== serverChapter) {
          serverChapter = s.chapter;
          serverPara = s.para || 0;
          renderList();
          updateResume();
        }
      })
      .catch(function () {});
  }

  function pollState() {
    fetchJSON(apiB("/state")).then(function (s) {
      if (!s || !s.chapter) return;
      var changed = s.chapter !== serverChapter;
      serverChapter = s.chapter;
      serverPara = s.para || 0;
      // follow another device only while this one hasn't diverged manually;
      // paragraph pulls only apply when jumping to a NEW chapter —
      // never yank mid-chapter while the user is reading
      if (followEnabled && s.updated > lastWrite && s.chapter > state.chapter && hasNum(s.chapter)) {
        toast("Đồng bộ: chuyển tới chương " + s.chapter);
        go(s.chapter, { keepFollow: true, para: serverPara });
      }
      lastWrite = Math.max(lastWrite, s.updated || 0);
      if (changed) { renderList(); updateResume(); }
    }).catch(function () {});
  }

  /* ---------- library ---------- */
  function jobHtml(b) {
    var j = b.job;
    if (!j) {
      // no active job — offer an update check (worker skips owned chapters,
      // so a re-run is effectively "fetch any new chapters")
      return b.hasSource
        ? '<div class="bk-job"><button class="bk-update" data-id="' +
            esc(b.id) + '">↻ Cập nhật chương mới</button></div>'
        : "";
    }
    var btn = ' <button class="bk-cancel" data-id="' + esc(b.id) + '">Hủy</button>';
    var retry = ' <button class="bk-retry" data-id="' + esc(b.id) + '">Tiếp tục</button>';
    if (j.status === "running")
      return '<div class="bk-job"><span>⏳ ' +
        (j.note === "cooldown" || (j.note && j.note.indexOf("cooldown") === 0)
          ? "Đang chờ hết hạn chế (" + esc(j.note) + ") — "
          : j.note ? esc(j.note) + " — " : "") +
        "chương " + j.done + (j.total ? "/" + j.total : "") +
        "</span>" + btn + "</div>";
    if (j.status === "queued")
      return '<div class="bk-job"><span>⏳ Chờ tải…</span>' + btn + "</div>";
    if (j.status === "error")
      return '<div class="bk-job err"><span>Lỗi tải: ' + esc(j.error || "?") +
        '</span><button class="bk-retry" data-id="' + esc(b.id) + '">Thử lại</button></div>';
    if (j.status === "cancelled")
      return b.total
        ? '<div class="bk-job"><button class="bk-update" data-id="' +
            esc(b.id) + '">↻ Cập nhật chương mới</button></div>'
        : '<div class="bk-job"><span>Đã dừng (' + (j.done || 0) +
            " chương)</span>" + retry + "</div>";
    return "";
  }
  function jobPct(b) {
    if (b.job && b.job.status === "running" && b.job.total)
      return Math.min(100, Math.round(b.job.done / b.job.total * 100));
    if (b.job && !b.total) return 0;
    return b.total ? Math.min(100, Math.round(b.chapter / b.total * 100)) : 0;
  }

  function showLibrary() {
    document.body.classList.add("lib-mode");
    $("novel-title").textContent = "Thư viện";
    document.title = "Thư viện truyện";
    var html = '<div class="book-card add-card"><div class="add-plus">＋</div>' +
      '<div class="add-text">Thêm truyện</div></div>';
    html += books.map(function (b) {
      var pos = b.job && (b.job.status === "running" || b.job.status === "queued")
        ? "Đang tải về…"
        : b.chapter
          ? "Đọc tiếp chương " + b.chapter + " · đoạn " + ((b.para || 0) + 1)
          : "Chưa đọc";
      return '<div class="book-card" data-id="' + esc(b.id) + '">' +
        (b.cover
          ? '<img class="bk-cover" src="/api/book/' + encodeURIComponent(b.id) + '/cover" loading="lazy">'
          : '<div class="bk-cover bk-nocover">📖</div>') +
        '<div class="bk-info">' +
        '<div class="bk-title">' + esc(b.title) + "</div>" +
        (b.subtitle ? '<div class="bk-sub">' + esc(b.subtitle) + "</div>" : "") +
        '<div class="bk-meta">' + b.total + " chương</div>" +
        '<div class="bk-prog"><div class="bk-prog-bar" style="width:' + jobPct(b) + '%"></div></div>' +
        '<div class="bk-pos' + (b.chapter ? "" : " fresh") + '">' + pos + "</div>" +
        jobHtml(b) + "</div></div>";
    }).join("");
    $("lib-grid").innerHTML = html;
  }
  function fetchBooks() {
    return fetchJSON("/api/books").then(function (bs) {
      books = bs || [];
      return books;
    });
  }
  $("lib-grid").addEventListener("click", function (e) {
    // add-book card -> inline paste form (but not clicks inside the form itself)
    if (e.target.closest(".add-card") && !e.target.closest(".add-form")) {
      e.target.closest(".add-card").innerHTML =
        '<div class="add-form">' +
        '<input id="add-url" placeholder="Dán link truyện truyendich.space…" autocomplete="off">' +
        '<button id="add-go">Tải về</button></div>';
      $("add-url").focus();
      return;
    }
    if (e.target.id === "add-go") {
      var url = $("add-url").value.trim();
      if (!url) return;
      e.target.disabled = true;
      e.target.textContent = "Đang thêm…";
      fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) {
          throw new Error(d.error || "Lỗi " + r.status);
        });
        return r.json();
      }).then(function (d) {
        toast(d.exists ? "Truyện đã có trong thư viện" : "Đã thêm — bắt đầu tải");
        fetchBooks().then(showLibrary);
      }).catch(function (err) {
        toast(err.message || "Link không hợp lệ");
        fetchBooks().then(showLibrary);
      });
      return;
    }
    if (e.target.classList.contains("bk-cancel")) {
      e.stopPropagation();
      fetch(apiBookJob(e.target.dataset.id), { method: "DELETE" })
        .then(function () { fetchBooks().then(showLibrary); });
      return;
    }
    if (e.target.classList.contains("bk-retry")) {
      e.stopPropagation();
      fetch(apiBookJob(e.target.dataset.id), { method: "POST" })
        .then(function () { fetchBooks().then(showLibrary); });
      return;
    }
    if (e.target.classList.contains("bk-update")) {
      e.stopPropagation();
      e.target.disabled = true;
      fetch(apiBookJob(e.target.dataset.id), { method: "POST" })
        .then(function (r) {
          toast(r.ok ? "Đang kiểm tra chương mới…" : "Truyện này không có nguồn tải");
          fetchBooks().then(showLibrary);
        });
      return;
    }
    var c = e.target.closest(".book-card");
    if (c) location.href = "?book=" + encodeURIComponent(c.dataset.id);
  });
  $("lib-grid").addEventListener("keydown", function (e) {
    if (e.target.id === "add-url" && e.key === "Enter") $("add-go").click();
  });
  function apiBookJob(id) {
    return "/api/book/" + encodeURIComponent(id) + "/job";
  }
  $("btn-lib").addEventListener("click", function () { location.href = "/"; });

  /* ---------- boot ---------- */
  function refreshIndex(silent) {
    return fetchJSON(apiB("/index")).then(function (ix) {
      var grew = ix.length !== index.length;
      index = ix;
      if (grew || !silent) renderList();
      return ix;
    });
  }

  function bootReader() {
    $("novel-title").textContent = bookMeta ? bookMeta.title : BOOK;
    document.title = bookMeta ? bookMeta.title : "Đọc truyện";
    Promise.all([refreshIndex(), fetchJSON(apiB("/state")).catch(function () { return null; })])
      .then(function (rs) {
        var server = rs[1];
        var m = location.hash.match(/chuong-(\d+)/);
        // priority: URL hash > server progress > local
        var start = m ? +m[1]
          : (server && server.chapter ? server.chapter : state.chapter);
        if (server && server.updated) lastWrite = server.updated;
        if (server && server.chapter) {
          serverChapter = server.chapter;
          serverPara = server.para || 0;
        }
        // deliberately opening an older chapter = diverged from sync;
        // the resume pill will offer a way back to the latest position
        if (server && server.chapter && start < server.chapter) followEnabled = false;
        // if landing on the synced chapter, restore exact paragraph too
        var sp = (start === serverChapter) ? serverPara : null;
        go(start, { keepFollow: true, para: sp });
        updateResume();
      })
      .catch(function () {
        $("chap-body").innerHTML =
          '<p style="text-align:center;color:var(--text-2)">Chưa có dữ liệu — scraper đang chạy, tải lại trang sau.</p>';
      });
  }

  applySettings();
  fetchBooks().then(function (bs) {
    if (!BOOK) {
      // legacy "#chuong-N" link (no ?book) -> most recently read book
      if (/chuong-\d+/.test(location.hash) && books.length) {
        BOOK = books[0].id;
        bookMeta = books[0];
        history.replaceState(null, "",
          "?book=" + encodeURIComponent(BOOK) + location.hash);
        bootReader();
      } else {
        showLibrary();
      }
      return;
    }
    bookMeta = null;
    for (var i = 0; i < books.length; i++)
      if (books[i].id === BOOK) { bookMeta = books[i]; break; }
    if (!bookMeta) {
      toast("Không tìm thấy truyện này");
      showLibrary();
      return;
    }
    bootReader();
  }).catch(function () {
    if (!BOOK) showLibrary();
    else $("chap-body").innerHTML =
      '<p style="text-align:center;color:var(--text-2)">Không kết nối được server.</p>';
  });

  /* ---------- TTS (VieNeu via /api/tts proxy) ---------- */
  var tts = {
    on: false, playing: false,
    segs: [], idx: 0, chap: 0,
    audio: new Audio(),
    voice: localStorage.getItem("tts_voice") || "Thiện Minh",
    speed: 1,
    buf: {},   // idx -> Promise<objectURL>
    gen: 0,    // generation counter to cancel stale callbacks
    nextChap: 0, nextSegs: null, nextBuf: {}, // prefetched next chapter
  };
  var SPEEDS = [1, 1.25, 1.5, 2];

  /* ---------- keep screen awake (Screen Wake Lock) ---------- */
  var wakeLock = null, wakeOn = false;
  function setWake(on) {
    wakeOn = on;
    var b = $("btn-wake");
    b.classList.toggle("on", on);
    b.textContent = on ? "☀" : "☾";
    // PC display: only when browsing from the PC itself (localhost).
    // On phone (https://<ip>:1346) the PC screen stays untouched —
    // navigator.wakeLock below handles the phone screen instead.
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    fetch("/api/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: on && isLocal }),
    }).catch(function () {});
    if (on) {
      acquireWake();
    } else {
      if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
      }
    }
  }
  function acquireWake() {
    if (!("wakeLock" in navigator)) {
      toast("Trình duyệt không hỗ trợ giữ màn — cần mở bằng https://");
      return;
    }
    navigator.wakeLock.request("screen").then(function (wl) {
      wakeLock = wl;
    }).catch(function (e) {
      // iOS requires a user gesture — retry on next touch if this failed
      if (e && e.name === "NotAllowedError") wakeNeedGesture = true;
    });
  }
  // wake lock auto-releases when tab is hidden — re-acquire on return;
  // on iOS a re-acquire needs a fresh gesture, so also retry on touch/click
  var wakeNeedGesture = false;
  document.addEventListener("visibilitychange", function () {
    if (wakeOn && document.visibilityState === "visible" && !wakeLock) acquireWake();
  });
  document.addEventListener("touchstart", retryWake, { passive: true });
  document.addEventListener("click", retryWake);
  function retryWake() {
    if (wakeOn && (!wakeLock || wakeNeedGesture)) {
      wakeNeedGesture = false;
      acquireWake();
    }
  }
  $("btn-wake").addEventListener("click", function () { setWake(!wakeOn); });

  // split chapter paragraphs into ~<=260-char sentence chunks
  function ttsBuild(paras) {
    var segs = [];
    paras.forEach(function (t, pi) {
      t = (t || "").trim();
      if (!t) return;
      var parts = t.match(/[^.!?…]+[.!?…]*["'»”)\]]*\s*/g) || [t];
      var buf = "";
      parts.forEach(function (s) {
        if ((buf + s).length > 260 && buf.trim()) {
          segs.push({ para: pi, text: buf.trim() });
          buf = s;
        } else {
          buf += s;
        }
      });
      if (buf.trim()) segs.push({ para: pi, text: buf.trim() });
    });
    return segs;
  }

  function ttsStatus(msg) { $("tts-status").textContent = msg; }

  // bounded synth queue: the TTS server processes requests serially —
  // firing 5+ prefetches at once makes the *current* segment wait behind
  // a pile of stale work (esp. after skipping around). Cap at 2 in flight;
  // the actively-playing segment jumps the queue.
  var ttsFlight = 0, ttsPending = [];
  function ttsPumpSched() {
    while (ttsFlight < 2 && ttsPending.length) {
      var j = ttsPending.shift();
      ttsFlight++;
      Promise.resolve(j.fn()).then(function (v) {
        ttsFlight--; j.res(v); ttsPumpSched();
      }, function (e) {
        ttsFlight--; j.rej(e); ttsPumpSched();
      });
    }
  }
  // tag: real segment index for current-chapter jobs; -2 for next-chapter
  // preloads (kept across skips since they belong to a different list)
  function ttsSched(fn, front, tag) {
    return new Promise(function (res, rej) {
      var job = { fn: fn, res: res, rej: rej, i: tag === undefined ? -1 : tag };
      front ? ttsPending.unshift(job) : ttsPending.push(job);
      ttsPumpSched();
    });
  }

  function ttsFetchSeg(segs, buf, i, front) {
    if (i >= segs.length) return Promise.resolve(null);
    if (!buf[i]) {
      var api = tts.voice.indexOf("omni:") === 0 ? "/api/omni" : "/api/tts";
      var vid = tts.voice.replace(/^omni:/, "");
      var url = api + "/stream?text=" + encodeURIComponent(segs[i].text) +
                "&voice_id=" + encodeURIComponent(vid);
      buf[i] = ttsSched(function () {
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error("tts " + r.status);
          return r.arrayBuffer();
        }).then(function (ab) {
          // stream WAV has a bogus header (data size 0) — patch it so <audio> accepts it
          var dv = new DataView(ab);
          if (ab.byteLength > 44 && dv.getUint32(0) === 0x46464952) {
            dv.setUint32(4, ab.byteLength - 8, true);
            dv.setUint32(40, ab.byteLength - 44, true);
          }
          return URL.createObjectURL(new Blob([ab], { type: "audio/wav" }));
        });
      }, front, buf === tts.buf ? i : -2);
      buf[i].catch(function () { delete buf[i]; });
    }
    return buf[i];
  }
  function ttsFetch(i, front) { return ttsFetchSeg(tts.segs, tts.buf, i, front); }
  function ttsNextFetch(i) { return ttsFetchSeg(tts.nextSegs, tts.nextBuf, i); }

  function ttsClearBuf() {
    for (var k in tts.buf) {
      tts.buf[k].then(function (u) { if (u) URL.revokeObjectURL(u); }).catch(function () {});
    }
    tts.buf = {};
  }
  function ttsClearNext() {
    for (var k in tts.nextBuf) {
      tts.nextBuf[k].then(function (u) { if (u) URL.revokeObjectURL(u); }).catch(function () {});
    }
    tts.nextBuf = {};
    tts.nextSegs = null;
    tts.nextChap = 0;
  }

  // start synthesizing next chapter's first segments so playback is seamless
  function ttsPreloadNext() {
    var nx = nearestNum(state.chapter + 1, 1);
    if (nx === null || tts.nextChap === nx) return;
    tts.nextChap = nx;
    getChapter(nx).then(function (d) {
      if (!tts.on || tts.nextChap !== nx) return;
      tts.nextSegs = ttsBuild(d.paras);
      ttsNextFetch(0);
      ttsNextFetch(1);
      ttsNextFetch(2);
    }).catch(function () { tts.nextChap = 0; });
  }

  function ttsHighlight(pi) {
    var ps = $("chap-body").children;
    for (var i = 0; i < ps.length; i++) ps[i].classList.remove("reading");
    // paragraphs are rendered in order; pi indexes non-empty ones
    var seen = -1;
    for (i = 0; i < ps.length; i++) {
      if (ps[i].textContent.trim()) seen++;
      if (seen === pi) {
        ps[i].classList.add("reading");
        if (state.layout === "book") scrollToPara(pi);
        else ps[i].scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }
  }

  function ttsPlay(i) {
    if (!tts.on) return;
    if (i >= tts.segs.length) {
      // chapter finished -> advance to next chapter and keep reading
      var nx = nearestNum(state.chapter + 1, 1);
      if (nx !== null) {
        ttsStatus("Hết chương — sang chương " + nx);
        tts.pendingStart = true;
        go(nx);
      } else {
        ttsStop();
        ttsStatus("Đã đọc hết truyện");
      }
      return;
    }
    var g = ++tts.gen;
    tts.idx = i;
    tts.playing = true;
    // drop queued prefetches that now sit behind this segment (skips)
    ttsPending = ttsPending.filter(function (j) { return j.i > i || j.i < 0; });
    $("tts-play").textContent = "⏸";
    ttsStatus("Đang tổng hợp… đoạn " + (i + 1) + "/" + tts.segs.length);
    ttsHighlight(tts.segs[i].para);
    ttsFetch(i, true).then(function (u) {
      if (!tts.on || g !== tts.gen) return;
      tts.audio.src = u;
      tts.audio.playbackRate = tts.speed;
      // iOS 17+: "playback" session keeps audio audible with silent switch on
      // and marks it as real media playback (survives screen lock better)
      if (navigator.audioSession) {
        try { navigator.audioSession.type = "playback"; } catch (e) {}
      }
      tts.audio.play().catch(function () {});
      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: "Chương " + state.chapter + " — đoạn " + (i + 1) + "/" + tts.segs.length,
            artist: $("chap-title").textContent || "Đọc truyện",
            album: bookMeta ? bookMeta.title : "Đọc truyện",
          });
          navigator.mediaSession.playbackState = "playing";
        } catch (e) {}
      }
      ttsStatus("Đoạn " + (i + 1) + "/" + tts.segs.length + " — " +
                tts.segs[i].text.slice(0, 40) + "…");
      // prefetch ahead — synth is slower than playback, keep a deep pipeline
      ttsFetch(i + 1); ttsFetch(i + 2); ttsFetch(i + 3);
      ttsFetch(i + 4); ttsFetch(i + 5);
      if (i >= tts.segs.length - 3) ttsPreloadNext(); // seamless chapter hand-off
    }).catch(function () {
      if (!tts.on || g !== tts.gen) return;
      ttsStatus("Lỗi tổng hợp — thử lại đoạn " + (i + 1));
      setTimeout(function () { if (tts.on && g === tts.gen) ttsPlay(i); }, 3000);
    });
  }

  tts.audio.addEventListener("ended", function () {
    if (tts.on && tts.playing) ttsPlay(tts.idx + 1);
  });
  tts.audio.addEventListener("error", function () {
    if (tts.on && tts.playing) {
      ttsStatus("Lỗi phát audio — bỏ qua đoạn");
      setTimeout(function () { if (tts.on && tts.playing) ttsPlay(tts.idx + 1); }, 800);
    }
  });

  // lock-screen / notification media controls (Media Session API)
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("play", function () { if (tts.on) ttsPlay(tts.idx); });
      navigator.mediaSession.setActionHandler("pause", function () { if (tts.on) ttsPause(); });
      navigator.mediaSession.setActionHandler("previoustrack", function () { if (tts.on) ttsPlay(Math.max(0, tts.idx - 1)); });
      navigator.mediaSession.setActionHandler("nexttrack", function () { if (tts.on) ttsPlay(Math.min(tts.segs.length, tts.idx + 1)); });
      navigator.mediaSession.setActionHandler("stop", function () { if (tts.on) ttsPause(); });
    } catch (e) {}
  }

  function ttsPause() {
    tts.playing = false;
    tts.gen++;
    tts.audio.pause();
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
    }
    $("tts-play").textContent = "▶";
    ttsStatus("Tạm dừng — đoạn " + (tts.idx + 1) + "/" + tts.segs.length);
  }

  function ttsStop() {
    tts.playing = false;
    tts.gen++;
    tts.audio.pause();
    tts.audio.removeAttribute("src");
    ttsPending = []; // drop queued prefetches so a reopen starts clean
    ttsClearBuf();
    ttsClearNext();
    $("tts-play").textContent = "▶";
  }

  // resume anchor: if the current chapter is the saved progress point,
  // start from the first segment of the anchored paragraph instead of 0
  function ttsAnchorIdx() {
    var anchor = (state.chapter === serverChapter) ? serverPara : 0;
    for (var k = 0; k < tts.segs.length; k++) {
      if (tts.segs[k].para >= anchor) return k;
    }
    return 0;
  }

  function ttsOpen() {
    tts.on = true;
    setWake(true);
    document.body.classList.add("tts-on");
    $("tts-bar").classList.add("open");
    getChapter(state.chapter).then(function (d) {
      tts.chap = state.chapter;
      tts.segs = ttsBuild(d.paras);
      tts.idx = ttsAnchorIdx();
      ttsStatus("Sẵn sàng — đoạn " + (tts.idx + 1) + "/" +
        tts.segs.length + ". Bấm ▶ hoặc click vào đoạn văn.");
    });
    if (!$("tts-voice").options.length) {
      var sel = $("tts-voice");
      var addGroup = function (label, voices, prefix) {
        if (!voices || !voices.length) return;
        var g = document.createElement("optgroup");
        g.label = label;
        voices.forEach(function (v) {
          var o = document.createElement("option");
          o.value = prefix + v.id; o.textContent = v.name || v.id;
          g.appendChild(o);
        });
        sel.appendChild(g);
      };
      Promise.all([
        fetchJSON("/api/tts/voices").catch(function () { return []; }),
        fetchJSON("/api/omni/voices").catch(function () { return []; }),
      ]).then(function (rs) {
        sel.innerHTML = "";
        addGroup("VieNeu (CPU — nhanh)", rs[0], "");
        addGroup("OmniVoice (GPU — chất lượng cao)", rs[1], "omni:");
        sel.value = tts.voice;
        if (sel.selectedIndex < 0) sel.selectedIndex = 0;
        if (!rs[0].length && !rs[1].length) {
          ttsStatus("Không lấy được danh sách giọng (server TTS tắt?)");
        }
      });
    }
  }

  function ttsClose() {
    ttsStop();
    tts.on = false;
    setWake(false);
    document.body.classList.remove("tts-on");
    $("tts-bar").classList.remove("open");
    var ps = $("chap-body").children;
    for (var i = 0; i < ps.length; i++) ps[i].classList.remove("reading");
  }

  $("btn-tts").addEventListener("click", function () {
    if (tts.on) ttsClose(); else ttsOpen();
  });
  $("tts-close").addEventListener("click", ttsClose);
  $("tts-play").addEventListener("click", function () {
    if (!tts.on) return;
    if (tts.playing) ttsPause(); else ttsPlay(tts.idx);
  });
  $("tts-prev").addEventListener("click", function () {
    if (tts.on) ttsPlay(Math.max(0, tts.idx - 1));
  });
  $("tts-next").addEventListener("click", function () {
    if (tts.on) ttsPlay(Math.min(tts.segs.length, tts.idx + 1));
  });
  $("tts-voice").addEventListener("change", function () {
    tts.voice = this.value;
    localStorage.setItem("tts_voice", tts.voice);
    var i = tts.idx;
    ttsStop();
    ttsStatus("Đổi giọng — bấm ▶ để đọc tiếp");
    tts.idx = i;
  });
  $("tts-speed").addEventListener("click", function () {
    tts.speed = SPEEDS[(SPEEDS.indexOf(tts.speed) + 1) % SPEEDS.length];
    this.textContent = tts.speed + "x";
    tts.audio.playbackRate = tts.speed;
  });

  // click a paragraph to start reading from it (while TTS bar is open)
  $("chap-body").addEventListener("click", function (e) {
    if (!tts.on || e.target.tagName !== "P") return;
    var ps = $("chap-body").children, seen = -1, target = -1;
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].textContent.trim()) seen++;
      if (ps[i] === e.target) { target = seen; break; }
    }
    if (target < 0) return;
    for (i = 0; i < tts.segs.length; i++) {
      if (tts.segs[i].para === target) { ttsPlay(i); return; }
    }
  });

  // refresh chapter index + sync progress periodically (reader only)
  setInterval(function () {
    if (!BOOK || document.body.classList.contains("lib-mode")) return;
    refreshIndex(true).catch(function () {});
    pollState();
  }, 15000);

  // live download progress on the library grid
  setInterval(function () {
    if (!document.body.classList.contains("lib-mode")) return;
    if ($("add-url")) return; // don't wipe the form while typing
    fetchBooks().then(showLibrary).catch(function () {});
  }, 4000);
})();
