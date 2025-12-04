{% load static %}
const CACHE_NAME = 'ts-app-shell-v1';
const PRECACHE_URLS = [
  '/',
  "{% static 'parts/vendor/bootstrap.min.css' %}",
  "{% static 'parts/css/app-shell.css' %}",
  "{% static 'parts/css/design-system.css' %}",
  "{% static 'parts/css/bluetooth-indicator.css' %}",
  "{% static 'parts/vendor/bootstrap.bundle.min.js' %}",
  "{% static 'parts/vendor/turbo.es2017-umd.js' %}",
  "{% static 'parts/js/layout-init.js' %}",
  "{% static 'parts/js/app-shell.js' %}",
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((key) => {
        if (key !== CACHE_NAME) {
          return caches.delete(key);
        }
        return null;
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => cached))
  );
});
