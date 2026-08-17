const CACHE_NAME = "bugpaw-shell-v14";
const BUILD_ASSETS = __BUGPAW_PRECACHE__;
const CORE_ASSETS = [
  "/",
  "/knowledge-base",
  "/settings/capabilities/tts",
  "/settings/capabilities/knowledge-retrieval",
  "/settings/capabilities/browser",
  "/aigc",
  "/settings/capabilities/aigc-channels",
  "/manifest.webmanifest",
  "/brand/bugpaw/bugpaw-paw-favicon.png",
  "/brand/bugpaw/bugpaw-paw-icon-192.png",
  "/brand/bugpaw/bugpaw-paw-icon-512.png",
];
CORE_ASSETS.push(...BUILD_ASSETS);
const STATIC_DESTINATIONS = new Set(["document", "font", "image", "manifest", "script", "style", "worker"]);
const NETWORK_FIRST_DESTINATIONS = new Set(["script", "style"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || request.headers.get("accept")?.includes("text/event-stream"))) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.method !== "GET" || url.origin !== self.location.origin || !STATIC_DESTINATIONS.has(request.destination)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/").then((response) => response ?? Response.error())));
    return;
  }

  /** 部署后的模块资源必须优先使用网络版本，避免旧入口引用已替换的分包。 */
  const cacheResponse = (response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  if (NETWORK_FIRST_DESTINATIONS.has(request.destination)) {
    event.respondWith(
      fetch(request).then(cacheResponse).catch(() => caches.match(request).then((response) => response ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request).then(cacheResponse);
      return cached ?? refresh;
    }),
  );
});
