// Đọc Truyện service worker — just enough for PWA installability.
// Cache-first for own static assets; network for everything else
// (API/chapter data must always be live for progress sync).
const CACHE = "doctruyen-v2";
const STATIC = [
  "/",
  "/index.html",
  "/app.js?v=4",
  "/style.css?v=3",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  // APIs, TTS audio, covers -> always network
  if (u.pathname.startsWith("/api/")) return;
  // static assets -> cache-first, then network (and cache the fresh copy)
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((r) => {
          if (r.ok && /(\.js|\.css|\.png|\.otf|\.webmanifest|\/$|index\.html)/.test(u.pathname + u.search)) {
            const cp = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, cp));
          }
          return r;
        })
    )
  );
});
