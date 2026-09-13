const CACHE = 'web-iptv-wall-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/store.js',
  '/js/catalog.js',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 共用資料 API 一律走網路，不能快取，否則不同裝置會看到舊資料。
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(resp => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached || new Response('Offline', { status: 503 }))
    )
  );
});
