{% load static %}
const CACHE_NAME = 'ts-app-shell-v2';
const PRECACHE_URLS = [
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
      .then((cache) => {
        // Intentar cachear todos los recursos, pero no fallar si alguno falla
        return Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[sw] precache skip', url, err);
              return null;
            })
          )
        ).then((results) => {
          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length > 0) {
            console.warn(`[sw] ${failed.length} recursos no se pudieron cachear`);
          }
        });
      })
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

  const isNavigation = event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html');
  const isTurboFrame = event.request.headers.get('turbo-frame');
  const isStaticAsset = url.pathname.startsWith('/static/') || url.pathname.startsWith('/media/');

  // Network-first para HTML y navegación Turbo (evita problemas de estilos)
  if (isNavigation || isTurboFrame) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first solo para assets estáticos (CSS, JS, imágenes)
  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (!response || response.status !== 200 || response.type === 'opaque') {
              return response;
            }
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          });
        })
    );
    return;
  }

  // Network-only para todo lo demás (API calls, etc)
});
