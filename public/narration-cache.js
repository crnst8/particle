/* particle — narration audio in this browser.

   The page downloads each passage itself — the whole mp3, checked — rather
   than leaving it to an <audio> element, so it can tell a finished download
   from a stalled one, cancel what is no longer needed, and keep the bytes for
   next time. Complete answers go into Cache Storage under a key that names the
   install, the article, the revision and the passage; a small IndexedDB index
   keeps their sizes and last use so the cache stays under its limit.

   Nothing here promises permanence: browsers evict storage when they need
   room. When Cache Storage is missing or full, passages are held in memory
   for as long as they are being played, and the player says offline listening
   is limited. Only the current and next passage are held that way. */

export const AUDIO_CACHE_VERSION = 1;
const DEFAULT_LIMIT = 64 * 1024 * 1024;
const MEMORY_SLOTS = 4;
const BYTES_PER_SECOND_GUESS = 8000;   // 64 kbps, the default bitrate

/**
 * `base` is the install's path (PARTICLE_BASE); `scope` names it uniquely on
 * this origin. `appUrl` builds API URLs through the app's own base helper.
 */
export function createAudioStore({
  scope,
  appUrl,
  fetchImpl = (...args) => fetch(...args),
  cachesImpl = globalThis.caches,
  idbImpl = globalThis.indexedDB,
  storage = globalThis.navigator?.storage,
  limitBytes = DEFAULT_LIMIT,
  createObjectURL = blob => URL.createObjectURL(blob),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  now = () => Date.now(),
} = {}) {
  const cacheName = `particle-audio-v${AUDIO_CACHE_VERSION}:${scope}`;
  const keyBase = new URL(appUrl('/__narration/'), globalThis.location?.href || 'http://localhost/').href;
  const index = createIndex(idbImpl, `particle-audio-index:${scope}`);
  const memory = new Map();               // key → Blob, for when the cache cannot hold it
  const downloads = new Map();            // key → { promise, abort, users, priority }
  let limited = false;                    // the cache refused something this session
  let limit = limitBytes;
  let opened = null;
  const protectedKeys = new Set();        // the passage playing and the next one

  const audioKey = (articleId, rev, seq) => `${keyBase}audio/${articleId}/${rev}/${seq}`;
  const manifestKey = (articleId, rev) => `${keyBase}manifest/${articleId}/${rev}`;
  const latestKey = articleId => `${keyBase}manifest/${articleId}/latest`;

  async function cache() {
    if (!cachesImpl) return null;
    if (!opened) {
      opened = (async () => {
        try {
          const store = await cachesImpl.open(cacheName);
          await reconcile(store);
          await settleLimit();
          return store;
        } catch {
          return null;
        }
      })();
    }
    return opened;
  }

  /* A smaller browser gets a smaller cache: never more than a tenth of what
     this origin is allowed to store. */
  async function settleLimit() {
    try {
      const estimate = await storage?.estimate?.();
      if (estimate?.quota) limit = Math.min(limitBytes, Math.floor(estimate.quota * 0.1));
    } catch { /* no estimate: keep the default */ }
  }

  /* An index entry without its bytes, or bytes without an index entry, is what
     an interrupted write leaves behind. Make the two agree. */
  async function reconcile(store) {
    const entries = await index.all();
    const keys = new Set((await store.keys()).map(request => request.url));
    for (const entry of entries) if (!keys.has(entry.key)) await index.remove(entry.key);
    const known = new Set(entries.map(entry => entry.key));
    for (const key of keys) {
      if (known.has(key)) continue;
      const response = await store.match(key);
      const bytes = Number(response?.headers.get('content-length')) || 0;
      const parsed = parseKey(key);
      await index.put({ key, kind: parsed.kind, article: parsed.article, rev: parsed.rev, seq: parsed.seq, bytes, used: 0, pinned: false });
    }
  }

  function parseKey(key) {
    const rest = key.slice(keyBase.length).split('/');
    return { kind: rest[0], article: Number(rest[1]), rev: rest[2], seq: rest[3] === undefined ? null : Number(rest[3]) };
  }

  // ── passages ──
  /**
   * An object URL for one passage: from this browser's cache, or downloaded
   * now. `priority` is 'foreground' (the player is waiting), 'next' (the spare
   * deck) or 'background' (a download for offline). Two callers asking for the
   * same passage share one download; it is cancelled only when every caller
   * has gone.
   */
  async function load(manifest, seq, { signal, priority = 'foreground' } = {}) {
    const key = audioKey(manifest.article_id, manifest.rev, seq);
    const blob = await local(key) || await download(manifest, seq, key, { signal, priority });
    const url = createObjectURL(blob);
    let released = false;
    return {
      url,
      bytes: blob.size,
      release: () => { if (!released) { released = true; revokeObjectURL(url); } },
    };
  }

  async function local(key) {
    if (memory.has(key)) return memory.get(key);
    const store = await cache();
    if (!store) return null;
    try {
      const hit = await store.match(key);
      if (!hit) return null;
      const blob = await hit.blob();
      if (!blob.size) return null;
      index.touch(key, now()).catch(() => {});
      return blob;
    } catch {
      return null;
    }
  }

  function download(manifest, seq, key, { signal, priority }) {
    let job = downloads.get(key);
    if (!job) {
      const abort = new AbortController();
      job = { abort, users: 0, priority };
      job.promise = fetchPassage(manifest, seq, key, abort.signal, priority)
        .finally(() => { if (downloads.get(key) === job) downloads.delete(key); });
      job.promise.catch(() => {});
      downloads.set(key, job);
    }
    job.users += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return;
        done = true;
        job.users -= 1;
        if (job.users <= 0) job.abort.abort();
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      };
      if (signal?.aborted) return leave();
      signal?.addEventListener('abort', leave, { once: true });
      job.promise.then((blob) => {
        if (done) return;
        done = true;
        job.users -= 1;
        signal?.removeEventListener('abort', leave);
        resolve(blob);
      }, (error) => {
        if (done) return;
        done = true;
        job.users -= 1;
        signal?.removeEventListener('abort', leave);
        reject(error);
      });
    });
  }

  async function fetchPassage(manifest, seq, key, signal, priority) {
    const path = `/api/articles/${manifest.article_id}/narration/${seq}?v=${encodeURIComponent(manifest.rev)}`
      + (priority === 'background' ? '&priority=background' : '');
    let response;
    try {
      response = await fetchImpl(appUrl(path), { signal, credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const offline = globalThis.navigator?.onLine === false;
      throw Object.assign(new Error(offline ? 'you are offline' : 'the passage could not be downloaded'),
        { code: offline ? 'offline' : 'network', retryable: true });
    }
    await assertAudio(response);
    const blob = await response.blob();
    if (!(await looksLikeMp3(blob))) {
      throw Object.assign(new Error('the passage that arrived was not audio'), { code: 'audio_invalid', retryable: true });
    }
    await keep(key, blob, { kind: 'audio', article: manifest.article_id, rev: manifest.rev, seq, pinned: priority === 'background' });
    return blob;
  }

  /* Never cache a failure: an error body, a partial answer, a login page an
     expired session redirected to, or anything that is not the audio type. */
  async function assertAudio(response) {
    if (response.ok && response.status === 200 && !response.redirected
      && /^audio\/mpeg\b/i.test(response.headers.get('content-type') || '')) return;
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    const status = response.status;
    const code = data.code || (response.redirected || status === 401 ? 'signed_out' : status === 206 ? 'partial' : 'server');
    throw Object.assign(new Error(data.error || `the passage could not be loaded (HTTP ${status})`), {
      code,
      status,
      retryable: typeof data.retryable === 'boolean' ? data.retryable : status >= 500 || status === 429,
      data,
    });
  }

  async function keep(key, blob, meta) {
    const store = await cache();
    const bytes = blob.size;
    if (store && await makeRoom(bytes, meta.article)) {
      try {
        await store.put(key, new Response(blob, {
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes) },
        }));
        await index.put({ key, ...meta, bytes, used: now() });
        memory.delete(key);
        return true;
      } catch {
        // full, or refused: evict harder once, then fall back to memory
        if (await makeRoom(bytes * 4, meta.article)) {
          try {
            await store.put(key, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes) } }));
            await index.put({ key, ...meta, bytes, used: now() });
            return true;
          } catch { /* fall through */ }
        }
      }
    }
    limited = true;
    remember(key, blob);
    return false;
  }

  function remember(key, blob) {
    memory.set(key, blob);
    while (memory.size > MEMORY_SLOTS) {
      const oldest = [...memory.keys()].find(one => !protectedKeys.has(one));
      if (!oldest) break;
      memory.delete(oldest);
    }
  }

  /* Least recently used first; passages kept for offline listening only after
     everything else; never the passage playing or the next one. */
  async function makeRoom(bytes, keepArticle = null) {
    if (bytes > limit) return false;
    const entries = await index.all();
    let total = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    if (total + bytes <= limit) return true;
    const store = await cache();
    const victims = entries
      .filter(entry => entry.kind === 'audio' && !protectedKeys.has(entry.key))
      .sort((a, b) => (Number(a.pinned) - Number(b.pinned)) || ((a.article === keepArticle) - (b.article === keepArticle)) || (a.used - b.used));
    for (const entry of victims) {
      if (total + bytes <= limit) break;
      try { await store?.delete(entry.key); } catch { /* already gone */ }
      await index.remove(entry.key);
      total -= entry.bytes || 0;
    }
    return total + bytes <= limit;
  }

  function protect(manifest, seqs) {
    protectedKeys.clear();
    if (!manifest) return;
    for (const seq of seqs) protectedKeys.add(audioKey(manifest.article_id, manifest.rev, seq));
  }

  /** Stop downloads for this article that are not one of `keepSeqs` of `rev`. */
  function cancelOthers(articleId, rev, keepSeqs = []) {
    const keep = new Set(keepSeqs.map(seq => audioKey(articleId, rev, seq)));
    for (const [key, job] of downloads) {
      const parsed = parseKey(key);
      if (parsed.article === articleId && !keep.has(key) && job.priority !== 'background') job.abort.abort();
    }
  }

  // ── manifests ──
  /* A prepared manifest is immutable, so it can be kept and trusted offline. */
  async function saveManifest(manifest) {
    const store = await cache();
    if (!store) return false;
    try {
      const body = JSON.stringify(manifest);
      await store.put(manifestKey(manifest.article_id, manifest.rev), new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }));
      await store.put(latestKey(manifest.article_id), new Response(JSON.stringify({ rev: manifest.rev }), { headers: { 'Content-Type': 'application/json' } }));
      await index.put({ key: manifestKey(manifest.article_id, manifest.rev), kind: 'manifest', article: manifest.article_id, rev: manifest.rev, seq: null, bytes: body.length, used: now(), pinned: false });
      return true;
    } catch {
      return false;
    }
  }

  async function loadManifest(articleId, rev) {
    const store = await cache();
    if (!store) return null;
    try {
      const pointer = rev ? { rev } : await (await store.match(latestKey(articleId)))?.json();
      if (!pointer?.rev) return null;
      return await (await store.match(manifestKey(articleId, pointer.rev)))?.json() || null;
    } catch {
      return null;
    }
  }

  // ── downloading a whole article ──
  /** Bytes the whole article will need, from the manifest's own durations. */
  function estimate(manifest) {
    return Math.round(manifest.segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0) * BYTES_PER_SECOND_GUESS);
  }

  /** Which passages of this variant are here, and whether all of them and the manifest are. */
  async function status(manifest) {
    if (!manifest) return { local: 0, total: 0, ready: false };
    const store = await cache();
    let local = 0;
    for (const segment of manifest.segments) {
      const key = audioKey(manifest.article_id, manifest.rev, segment.seq);
      if (memory.has(key) || (store && await store.match(key))) local += 1;
    }
    const manifestHere = Boolean(store && await store.match(manifestKey(manifest.article_id, manifest.rev)));
    return { local, total: manifest.segments.length, ready: manifestHere && local === manifest.segments.length, limited };
  }

  /**
   * Fetch every missing passage, one at a time, at background priority, so a
   * reader playing something meanwhile is never behind it. Resumable: only the
   * passages not already here are asked for.
   */
  async function downloadAll(manifest, { signal, onProgress = () => {} } = {}) {
    if (!(await cache())) throw Object.assign(new Error('this browser will not keep audio for offline listening'), { code: 'no_cache' });
    await settleLimit();
    const need = estimate(manifest);
    if (need > limit) {
      throw Object.assign(new Error(`this article needs about ${mb(need)}, more than the ${mb(limit)} this browser keeps`), { code: 'too_large' });
    }
    await saveManifest(manifest);
    const store = await cache();
    let done = 0;
    for (const segment of manifest.segments) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const key = audioKey(manifest.article_id, manifest.rev, segment.seq);
      const here = await store.match(key);
      if (here) {
        await index.pin(key);
      } else {
        await download(manifest, segment.seq, key, { signal, priority: 'background' });
      }
      done += 1;
      onProgress({ done, total: manifest.segments.length });
    }
    return status(manifest);
  }

  /** Forget everything this browser holds for one article. */
  async function remove(articleId) {
    for (const [key, job] of downloads) if (parseKey(key).article === articleId) job.abort.abort();
    for (const key of [...memory.keys()]) if (parseKey(key).article === articleId) memory.delete(key);
    const store = await cache();
    for (const entry of await index.all()) {
      if (entry.article !== articleId) continue;
      try { await store?.delete(entry.key); } catch { /* gone */ }
      await index.remove(entry.key);
    }
    try { await store?.delete(latestKey(articleId)); } catch { /* gone */ }
  }

  /** Everything, for a library reset. */
  async function clear() {
    for (const job of downloads.values()) job.abort.abort();
    memory.clear();
    try { await cachesImpl?.delete(cacheName); } catch { /* gone */ }
    opened = null;
    await index.clear();
  }

  return {
    load, protect, cancelOthers, saveManifest, loadManifest, estimate, status, downloadAll, remove, clear,
    has: async (articleId, rev, seq) => Boolean(await local(audioKey(articleId, rev, seq))),
    get limited() { return limited; },
    get limit() { return limit; },
    cacheName,
  };
}

/* The first bytes of an mp3: an ID3 tag or a frame sync. */
async function looksLikeMp3(blob) {
  if (!blob || blob.size < 64) return false;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;
  return head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

const mb = bytes => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

/* A key → entry map in IndexedDB, or in memory where IndexedDB is missing or
   refuses (private windows, some embedded browsers). */
function createIndex(idb, name) {
  const fallback = new Map();
  let opening = null;
  const open = () => {
    if (!idb) return Promise.resolve(null);
    if (!opening) {
      opening = new Promise((resolve) => {
        try {
          const request = idb.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'key' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return opening;
  };
  const run = async (mode, work) => {
    const db = await open();
    if (!db) return work(null);
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('entries', mode);
        const store = tx.objectStore('entries');
        const result = work(store);
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(work(null));
      }
    });
  };
  return {
    all: async () => {
      const db = await open();
      if (!db) return [...fallback.values()];
      return new Promise((resolve) => {
        try {
          const request = db.transaction('entries').objectStore('entries').getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    },
    put: entry => run('readwrite', store => (store ? store.put(entry) : fallback.set(entry.key, entry))),
    remove: key => run('readwrite', store => (store ? store.delete(key) : fallback.delete(key))),
    clear: () => run('readwrite', store => (store ? store.clear() : fallback.clear())),
    touch: async (key, used) => {
      const entries = await (async () => {
        const db = await open();
        if (!db) return fallback.get(key) ? [fallback.get(key)] : [];
        return new Promise((resolve) => {
          try {
            const request = db.transaction('entries').objectStore('entries').get(key);
            request.onsuccess = () => resolve(request.result ? [request.result] : []);
            request.onerror = () => resolve([]);
          } catch { resolve([]); }
        });
      })();
      if (entries[0]) await run('readwrite', store => (store ? store.put({ ...entries[0], used }) : fallback.set(key, { ...entries[0], used })));
    },
    pin: async (key) => {
      const all = await (async () => {
        const db = await open();
        if (!db) return [...fallback.values()];
        return new Promise((resolve) => {
          try {
            const request = db.transaction('entries').objectStore('entries').getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
          } catch { resolve([]); }
        });
      })();
      const entry = all.find(one => one.key === key);
      if (entry) await run('readwrite', store => (store ? store.put({ ...entry, pinned: true }) : fallback.set(key, { ...entry, pinned: true })));
    },
  };
}
