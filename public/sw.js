/* particle service worker — app shell offline + read-offline for visited articles */
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const at = path => `${BASE}${path}` || '/';
/* Several installs can share one origin under different base paths. Every
   cache this worker owns carries its base in the name, and it only ever
   deletes its own. */
const SCOPE = BASE || '/';
const SHELL_VERSION = 11;
const SHELL = `particle-shell-v${SHELL_VERSION}:${SCOPE}`;
const RUNTIME = `particle-runtime-v${SHELL_VERSION}:${SCOPE}`;
// Narration audio is the page's to keep (narration-cache.js), versioned on its own.
const AUDIO = `particle-audio-v1:${SCOPE}`;
const AUDIO_INDEX = `particle-audio-index:${SCOPE}`;
// Where a shared screenshot waits between the share target and the page.
const SHARED = 'particle-shared-v1';
const SHARED_KEY = 'shared-screenshot';
// Keep this list to assets that always exist — cache.addAll() rejects as a whole
// if any single entry 404s, which would leave the app with no service worker.
const SHELL_ASSETS = [
  at('/'), at('/style.css'), at('/app.js'), at('/store-local.js'), at('/manifest.webmanifest'),
  at('/narration-model.js'), at('/narration-player.js'), at('/narration-cache.js'),
  at('/icons/icon-192.png'), at('/icons/icon-512.png'),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

/* Old versions of this install's own caches go. Caches from before names
   carried a base were shared by every install on the origin and are only
   kept by versions nobody runs any more. Anything else — another install's
   caches, this install's audio — is left alone. */
function obsolete(name) {
  const own = /^particle-(shell|runtime|audio)-v(\d+):(.*)$/.exec(name);
  if (own) {
    if (own[3] !== SCOPE) return false;
    if (own[1] === 'audio') return name !== AUDIO;
    return name !== SHELL && name !== RUNTIME;
  }
  const unscoped = /^particle-(shell|runtime)-v(\d+)$/.exec(name);
  return Boolean(unscoped) && Number(unscoped[2]) < SHELL_VERSION;
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(obsolete).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Signing out leaves no article audio behind on this device. */
async function forgetAudio() {
  await caches.delete(AUDIO).catch(() => {});
  await new Promise((done) => {
    try {
      const request = indexedDB.deleteDatabase(AUDIO_INDEX);
      request.onsuccess = request.onerror = request.onblocked = () => done();
    } catch {
      done();
    }
  });
}

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

  if (request.mode === 'navigate' && url.pathname === at('/logout')) {
    e.respondWith(forgetAudio().then(() => fetch(request)));
    return;
  }

  // navigations resolve to the cached shell when offline
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(at('/'))));
    return;
  }

  /* Narration is the page's own business: it downloads and keeps audio and
     immutable manifests itself (narration-cache.js), and settings, status,
     positions and the current manifest change too often for a fallback copy
     to be anything but wrong. None of it goes through the generic cache. */
  if (url.pathname.startsWith(at('/api/narration/')) || /\/api\/articles\/\d+\/narration(\/|$)/.test(url.pathname)) return;

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
