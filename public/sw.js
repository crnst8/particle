/* particle service worker — app shell offline + read-offline for visited articles */
const SHELL = 'particle-shell-v3';
const RUNTIME = 'particle-runtime-v3';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const at = path => `${BASE}${path}` || '/';
// Keep this list to assets that always exist — cache.addAll() rejects as a whole
// if any single entry 404s, which would leave the app with no service worker.
const SHELL_ASSETS = [
  at('/'), at('/style.css'), at('/app.js'), at('/store-local.js'), at('/manifest.webmanifest'),
  at('/logo.png'), at('/logo-dark.png'), at('/icons/icon-192.png'), at('/icons/icon-512.png'),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // navigations resolve to the cached shell when offline
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(at('/'))));
    return;
  }

  // API + images: network first, fall back to last good copy (offline reading)
  if (url.pathname.startsWith(at('/api/'))) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then(c => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then(hit => hit || Response.error()))
    );
    return;
  }

  // static assets: cache first
  e.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(request, copy));
      }
      return res;
    }))
  );
});
