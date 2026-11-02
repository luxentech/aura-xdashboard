const CACHE_NAME = 'aura-x-cache-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './cloud-auth.js',
  './firebase-config.js',
  './assets/aura-x-logo.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Do not intercept or cache cloud database API calls or Firebase calls - keep them live
  if (url.origin !== self.origin || url.pathname.includes('/api/') || url.hostname.includes('kvdb.io') || url.hostname.includes('firebase') || url.hostname.includes('googleapis')) {
    return;
  }

  // Stale-while-revalidate for local assets to ensure maximum speed and freshness
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
