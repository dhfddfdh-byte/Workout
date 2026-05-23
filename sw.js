const CACHE = 'forge-v10';
const ASSETS = ['./','./index.html','./app.js','./manifest.json',
  './icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = e.request.url;
  // never cache the Gemini API, food database, or scanner library — always network
  if (url.includes('generativelanguage.googleapis.com')) return;
  if (url.includes('openfoodfacts.org')) return;
  if (url.includes('cdn.jsdelivr.net')) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (e.request.method === 'GET' && res.ok && url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
