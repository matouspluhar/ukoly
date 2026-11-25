// Service worker: aplikace startuje okamžitě z mezipaměti a funguje bez sítě.
// Nová verze = změnit VERSION (= 'ukoly-' + APP_VERSION z js/app.js). Prohlížeč pak stáhne
// celé nové vydání na pozadí a aplikace nabídne „Načíst“. Data drží IndexedDB, ne tato mezipaměť.
// SHELL = všechny soubory aplikace; úplnost hlídá test/release.test.mjs.
const VERSION = 'ukoly-3.7';
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/format.js', 'js/graph.js', 'js/demo.js', 'js/store.js', 'js/sync.js',
  'vendor/msal-browser.min.js',
  'fonts/ibm-plex-sans-latin-400-normal.woff2', 'fonts/ibm-plex-sans-latin-500-normal.woff2', 'fonts/ibm-plex-sans-latin-600-normal.woff2',
  'fonts/ibm-plex-sans-latin-ext-400-normal.woff2', 'fonts/ibm-plex-sans-latin-ext-500-normal.woff2', 'fonts/ibm-plex-sans-latin-ext-600-normal.woff2',
  'icons/ukoly3-192.png', 'icons/ukoly3-512.png', 'icons/ukoly3-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' obejde HTTP mezipaměť GitHub Pages, ať se nemíchají verze.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Návrat z přihlášení (?code=…) i běžné otevření = vždy stejný index.html z mezipaměti.
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && url.pathname.match(/\.(js|css|woff2|png|webmanifest|html)$/)) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  }));
});
