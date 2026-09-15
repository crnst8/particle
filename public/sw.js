/* particle service worker — app shell offline + read-offline for visited articles */
const SHELL = 'particle-shell-v10';
const RUNTIME = 'particle-runtime-v10';
// Where a shared screenshot waits between the share target and the page.
const SHARED = 'particle-shared-v1';
const SHARED_KEY = 'shared-screenshot';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const at = path => `${BASE}${path}` || '/';
// Keep this list to assets that always exist — cache.addAll() rejects as a whole
// if any single entry 404s, which would leave the app with no service worker.
const SHELL_ASSETS = [
  at('/'), at('/style.css'), at('/app.js'), at('/store-local.js'), at('/manifest.webmanifest'),
  at('/icons/icon-192.png'), at('/icons/icon-512.png'),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== SHELL && k !== RUNTIME && k !== SHARED)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* A share from another app arrives as a POST to the app's own address — there is
   no other way in, because the OS hands the file to the service worker and never
   to the page. Park it where the page can pick it up, then answer with an
   ordinary redirect so the app opens the way it always does. */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const shared = form.get('url') || form.get('add') || form.get('text');
    if (typeof shared === 'string' && /^https?:\/\//i.test(shared.trim())) {
      return Response.redirect(`${at('/')}?add=${encodeURIComponent(shared.trim())}`, 303);
    }
    const file = [...form.values()].find(one => one && typeof one === 'object' && /^image\//.test(one.type || ''));
    if (file) {
      const cache = await caches.open(SHARED);
      await cache.put(at(`/${SHARED_KEY}`), new Response(file, { headers: { 'Content-Type': file.type } }));
      return Response.redirect(`${at('/')}?shared=screenshot`, 303);
    }
  } catch { /* a share that cannot be read just opens the app */ }
  return Response.redirect(at('/'), 303);
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (request.method === 'POST' && url.pathname === at('/')) {
    e.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  // navigations resolve to the cached shell when offline
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(at('/'))));
    return;
  }

  // Narration audio is large and already cached in SQLite on the server; keep it
  // out of the offline store and let the HTTP cache handle repeats.
  if (/\/narration\/\d+$/.test(url.pathname)) return;

  // An event stream has no end, so the API branch below would clone a body that
  // never completes and hold it open in the cache. Hand it straight to the network.
  if (request.headers.get('accept') === 'text/event-stream') return;

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
