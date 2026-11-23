// Service worker : garde l'app disponible sans réseau.
// Incrémente VERSION à chaque mise en ligne pour forcer la mise à jour.
const VERSION = "captaine-0.4.0";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/config.js", "js/util.js", "js/icons.js", "js/geo.js", "js/game.js", "js/themes.js", "js/store-demo.js", "js/store-supabase.js", "js/minigames.js", "js/vendor/qrcode.mjs", "js/vendor/supabase.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Réseau d'abord (pour avoir la dernière version), cache si hors ligne.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});
