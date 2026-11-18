const CACHE_PREFIX = 'mysalary-';
const CACHE = CACHE_PREFIX + '__BUILD_CACHE_ID__';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/brand.js', '/config.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/brand-mark.png', '/lib/date.js', '/lib/calculations.js', '/lib/database.js', '/lib/storage.js', '/lib/export.js', '/lib/pdf-report.js', '/lib/pdf-core.js', '/lib/brand-art.js', '/lib/report-image.js', '/lib/xlsx-export.js', '/lib/firebase-rest.js', '/lib/logout-guard.js', '/lib/sync-vault.js', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = event.request.mode === 'navigate'
        ? await fetch(event.request.url, { cache: 'no-store', credentials: 'same-origin' })
        : await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const fallback = await caches.match('/index.html');
        if (fallback) return fallback;
      }
      throw new Error('This resource is not available offline.');
    }
  })());
});
