// Service worker: aplikace se otevře i bez sítě. Data (Graph) neukládá – ta drží IndexedDB.
const VERSION = 'ukoly-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/format.js', 'js/graph.js', 'js/demo.js', 'js/store.js', 'js/sync.js',
  'vendor/msal-browser.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Nejdřív síť (aby se nová verze projevila hned), bez sítě z mezipaměti.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req.mode === 'navigate' ? './' : req, res.clone());
      return res;
    } catch {
      return (await cache.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true }))
        || (await cache.match('index.html')) || Response.error();
    }
  })());
});
