// Offline cache for the PWA build (not used inside the Android app).
const CACHE = 'chatforge-v1';
const ASSETS = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/db.js', 'js/ui.js', 'js/engine.js', 'js/cards.js', 'js/native.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
