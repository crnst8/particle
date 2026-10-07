/* particle — narration model.

   The rules of listening that do not depend on a browser: where the listener
   is, how a saved place maps onto a script that has since changed, how much
   audio to have ready, and how bookmark writes are ordered. Nothing here
   touches the DOM, storage, timers or the network at module scope; the player
   passes those in. The server imports this same file, so a bookmark means the
   same thing on both sides. */

export const BOOKMARK_VERSION = 1;
export const SKIP_SECONDS = 15;

// ── timeline ─────────────────────────────────────────────────────────────────
/* A display clock over the whole article. Durations start as estimates and are
   replaced by real ones as audio loads, so a position in seconds drifts — which
   is why it is only ever drawn, never saved. Saved places are segment ids. */
export function timeline(segments = []) {
  const marks = [];
  let at = 0;
  for (const segment of segments) {
    marks.push(at);
    at += Math.max(0, Number(segment?.duration) || 0);
  }
  return { marks, total: at };
}

export function positionOf(segments, seq, offset = 0) {
  const { marks } = timeline(segments);
  return (marks[seq] || 0) + Math.max(0, Number(offset) || 0);
}

/** The segment and offset under a point on the display clock. */
export function locate(segments, seconds) {
  if (!segments?.length) return { seq: 0, offset: 0 };
  const { marks, total } = timeline(segments);
  const target = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, total - 0.25)));
  let seq = 0;
  for (let i = 0; i < segments.length; i++) if (marks[i] <= target) seq = i;
  const length = Math.max(0, Number(segments[seq]?.duration) || 0);
  return { seq, offset: Math.max(0, Math.min(target - marks[seq], Math.max(0, length - 0.25))) };
}

// ── bookmarks ────────────────────────────────────────────────────────────────
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function makeBookmark(manifest, seq, offset = 0, { completed = false } = {}) {
  const segment = manifest?.segments?.[seq];
  if (!segment) return null;
  return {
    v: BOOKMARK_VERSION,
    content_revision: manifest.content_revision,
    script_id: manifest.script_id,
    rev: manifest.rev,
    block_id: segment.block_id,
    segment_id: segment.id,
    offset_seconds: Math.round(Math.max(0, Number(offset) || 0) * 100) / 100,
    completed: Boolean(completed),
  };
}

/** A bookmark as stored, or null if any part of it is not what one looks like. */
export function validBookmark(value) {
  if (!value || typeof value !== 'object' || value.v !== BOOKMARK_VERSION) return null;
  for (const key of ['content_revision', 'script_id', 'rev', 'block_id', 'segment_id']) {
    if (typeof value[key] !== 'string' || !ID.test(value[key])) return null;
  }
  const offset = value.offset_seconds;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset > 86_400) return null;
  if (typeof value.completed !== 'boolean') return null;
  return {
    v: BOOKMARK_VERSION,
    content_revision: value.content_revision,
    script_id: value.script_id,
    rev: value.rev,
    block_id: value.block_id,
    segment_id: value.segment_id,
    offset_seconds: offset,
    completed: value.completed,
  };
}

export const sameBookmark = (a, b) => Boolean(a && b)
  && a.rev === b.rev && a.segment_id === b.segment_id && a.completed === b.completed
  && Math.abs(a.offset_seconds - b.offset_seconds) < 0.01;

/**
 * Where to start, given a manifest and a saved place.
 *
 * The same audio resumes to the second. Another voice reading the same script
 * restarts the current short segment, which may repeat a sentence but never
 * skips one. Changed text resumes at the same paragraph if it survived, else at
 * the next paragraph that did, in the old order. With no way to map it, the
 * answer is `changed` and the caller asks the reader — old seconds are never
 * reinterpreted against new text.
 */
export function resolveStart(manifest, bookmark, { oldBlocks = null } = {}) {
  const segments = manifest?.segments || [];
  const saved = validBookmark(bookmark);
  if (!saved) return { seq: 0, offset: 0, mode: 'beginning' };
  if (saved.completed) return { seq: 0, offset: 0, mode: 'completed' };

  const bySegment = segments.findIndex(segment => segment.id === saved.segment_id);
  if (saved.rev === manifest.rev && bySegment >= 0) {
    return { seq: bySegment, offset: saved.offset_seconds, mode: 'exact' };
  }
  if (saved.script_id === manifest.script_id && bySegment >= 0) {
    return { seq: bySegment, offset: 0, mode: 'segment' };
  }
  const byBlock = segments.findIndex(segment => segment.block_id === saved.block_id);
  if (byBlock >= 0) return { seq: byBlock, offset: 0, mode: 'block' };

  if (Array.isArray(oldBlocks)) {
    const from = oldBlocks.indexOf(saved.block_id);
    if (from >= 0) {
      for (const id of oldBlocks.slice(from + 1)) {
        const seq = segments.findIndex(segment => segment.block_id === id);
        if (seq >= 0) return { seq, offset: 0, mode: 'next-block' };
      }
    }
  }
  return { seq: 0, offset: 0, mode: 'changed' };
}

/** The first spoken segment at or after a block in document order. */
export function segmentForBlock(manifest, blockId, blocks = manifest?.blocks || []) {
  const segments = manifest?.segments || [];
  const direct = segments.findIndex(segment => segment.block_id === blockId);
  if (direct >= 0) return { seq: direct, exact: true };
  const at = blocks.findIndex(block => block.id === blockId);
  if (at < 0) return null;
  for (const block of blocks.slice(at + 1)) {
    const seq = segments.findIndex(segment => segment.block_id === block.id);
    if (seq >= 0) return { seq, exact: false };
  }
  return null;
}

// ── buffering ────────────────────────────────────────────────────────────────
export const BUFFER = { base: 30, slow: 60, slowest: 90, maxSegments: 6 };

/* How far ahead to hold audio, in seconds of listening at the current rate.
   Slow delivery earns a longer runway; Save-Data asks for the next passage only. */
export function bufferSeconds({ slowness = 0 } = {}) {
  if (slowness >= 2) return BUFFER.slowest;
  if (slowness >= 1) return BUFFER.slow;
  return BUFFER.base;
}

/**
 * The segments worth having, from the one being heard onwards: enough to cover
 * `seconds` of listening at `rate`, never more than `maxSegments` past the
 * current one. Seconds, not a count — two headings and a long paragraph are
 * very different amounts of listening.
 */
export function demandWindow(segments, fromSeq, { seconds = BUFFER.base, rate = 1, maxSegments = BUFFER.maxSegments, saveData = false } = {}) {
  const list = segments || [];
  if (fromSeq < 0 || fromSeq >= list.length) return [];
  const window = [fromSeq];
  const ahead = saveData ? 1 : Math.max(0, maxSegments);
  const speed = Math.max(0.25, Number(rate) || 1);
  let covered = 0;
  for (let seq = fromSeq + 1; seq < list.length && window.length - 1 < ahead; seq++) {
    if (!saveData && covered >= seconds) break;
    window.push(seq);
    covered += Math.max(0, Number(list[seq].duration) || 0) / speed;
  }
  return window;
}

/* Delivery measured against consumption. A segment that took longer to arrive
   than the audio already queued ahead of it lasts is a stall in waiting;
   two in a row raise the runway, a run of quick ones lowers it again. */
export function nextSlowness(slowness, { readyMs, bufferedSeconds }) {
  const late = readyMs / 1000 > Math.max(1, bufferedSeconds * 0.8);
  if (late) return Math.min(2, slowness + 1);
  if (readyMs < 1500 && slowness > 0) return slowness - 0.25 < 0 ? 0 : slowness - 0.25;
  return slowness;
}

// ── bookmark writes ──────────────────────────────────────────────────────────
/**
 * Orders bookmark writes for one article at a time.
 *
 * Every checkpoint lands in local storage at once — that is what survives the
 * browser being killed. Server writes go one at a time, at most every
 * `interval` ms during ordinary playback, and only the newest waiting position
 * is ever sent, so an older place can never overwrite a newer one. Each write
 * names the version it was based on; a 409 means another device moved the
 * bookmark, and the choice between the two is the reader's, not this queue's.
 */
export function createBookmarkSync({ send, local, now = () => Date.now(), interval = 5000, onState = () => {} }) {
  const articles = new Map();   // id → { version, pending, inflight, conflict, lastSent, server }

  function entry(id) {
    if (!articles.has(id)) {
      const stored = safe(() => local.load(id)) || null;
      articles.set(id, {
        version: stored?.version ?? 0,
        pending: stored?.pending ? validBookmark(stored.bookmark) : null,
        local: validBookmark(stored?.bookmark) || null,
        inflight: false,
        conflict: null,
        lastSent: 0,
        server: null,
      });
    }
    return articles.get(id);
  }

  function persist(id, state) {
    safe(() => local.save(id, {
      bookmark: state.pending || state.local,
      version: state.version,
      pending: Boolean(state.pending),
    }));
  }

  /** Adopt what the server holds, unless this device has a newer unsent place. */
  function seed(id, { bookmark, version }) {
    const state = entry(id);
    const server = validBookmark(bookmark);
    state.server = server;
    if (state.pending) {
      // our own keepalive write may already have landed
      if (server && sameBookmark(server, state.pending)) {
        state.pending = null;
        state.version = version;
        state.local = server;
      } else if (version > state.version) {
        state.conflict = { bookmark: server, version };
      }
    } else {
      state.version = version;
      state.local = server;
    }
    persist(id, state);
    onState(id, view(id));
    return view(id);
  }

  function view(id) {
    const state = entry(id);
    return {
      bookmark: state.pending || state.local,
      version: state.version,
      pending: Boolean(state.pending),
      conflict: state.conflict,
    };
  }

  /** A new place. `flush` sends now (pause, seek, close); otherwise writes coalesce. */
  function checkpoint(id, bookmark, { flush = false } = {}) {
    const clean = validBookmark(bookmark);
    if (!clean) return;
    const state = entry(id);
    state.pending = clean;
    state.local = clean;
    persist(id, state);
    if (flush || now() - state.lastSent >= interval) pump(id);
  }

  function pump(id) {
    const state = entry(id);
    if (state.inflight || state.conflict || !state.pending) return;
    const bookmark = state.pending;
    state.inflight = true;
    state.lastSent = now();
    Promise.resolve()
      .then(() => send(id, { bookmark, expected_version: state.version }))
      .then((reply) => {
        state.inflight = false;
        state.version = reply.version;
        state.server = validBookmark(reply.bookmark);
        if (state.pending && sameBookmark(state.pending, bookmark)) state.pending = null;
        persist(id, state);
        onState(id, view(id));
        if (state.pending && now() - state.lastSent >= interval) pump(id);
      }, (error) => {
        state.inflight = false;
        if (error?.status === 409 && error.data) {
          state.conflict = { bookmark: validBookmark(error.data.bookmark), version: error.data.version };
          state.server = state.conflict.bookmark;
          onState(id, view(id));
        }
        // anything else (offline, server down) keeps the pending place for later
      });
  }

  /** The reader chose: keep this device's place, or take the saved one. */
  function resolve(id, choice) {
    const state = entry(id);
    const conflict = state.conflict;
    if (!conflict) return view(id);
    state.conflict = null;
    state.version = conflict.version;
    if (choice === 'theirs') {
      state.pending = null;
      state.local = conflict.bookmark;
      persist(id, state);
    } else {
      persist(id, state);
      pump(id);
    }
    onState(id, view(id));
    return view(id);
  }

  /** The bookmark this keepalive request should carry when the page goes away. */
  function unload(id) {
    const state = articles.get(id);
    if (!state?.pending || state.conflict) return null;
    return { bookmark: state.pending, expected_version: state.version };
  }

  function forget(id) {
    articles.delete(id);
    safe(() => local.remove(id));
  }

  return { seed, checkpoint, flush: pump, resolve, view, unload, forget };
}

function safe(run) {
  try { return run(); } catch { return undefined; }
}
