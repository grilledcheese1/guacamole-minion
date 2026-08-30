/* Minimal app-shell service worker.
 *
 * Purpose: make the app installable and keep the shell usable offline. There is
 * NO offline data support — /api/* and /__auth always go to the network.
 * Bump CACHE when the shell changes so old caches are dropped on activate.
 */
const CACHE = "crf-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  "/vite.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // Resilient: one missing asset must not brick the install.
        Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__auth")) {
    return; // always network for API + the password gate
  }

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          caches.match("/index.html").then((res) => res || caches.match("/")),
      ),
    );
    return;
  }

  // Other same-origin GETs (JS/CSS/fonts/icons): stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fromNetwork = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fromNetwork;
    }),
  );
});
