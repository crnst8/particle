/* particle — narration player.

   Owns the two audio decks and everything that happens to them. Every action
   the reader takes (start, switch voice, seek, pause, close, navigate) begins a
   new operation; every await checks it still owns the player before touching
   state, the DOM or a deck. A late network reply, a play() promise from three
   taps ago, or a media event from a source that has since been replaced is
   ignored rather than obeyed — which is what stops two voices reading at once,
   a closed player reopening itself, and a pause being undone by a download
   that finished after it.

   What the reader wants (`intent`) is kept apart from what the audio is doing
   (`state`); only a `playing` event from the current deck says sound is coming
   out. A passage that fails stays where it is with Retry beside it. Nothing
   here skips text on its own.

   The DOM, the network and storage arrive as adapters, so the whole controller
   runs under node:test with fake media elements. */
import {
  timeline, positionOf, locate, makeBookmark, demandWindow, bufferSeconds, nextSlowness, SKIP_SECONDS,
} from './narration-model.js';

const STALL_MS = 12_000;
const RETRY_DELAY_MS = 1500;
const LOCAL_CHECKPOINT_MS = 2000;
const DEMAND_HEARTBEAT_MS = 10_000;

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};

export function createNarrationPlayer(env) {
  const { api, source, bookmarks } = env;
  const ui = env.ui || {};
  const clock = { ...defaultClock, ...(env.clock || {}) };
  const rate = env.rate || (() => 1);
  const saveData = env.saveData || (() => false);
  const visible = env.visible || (() => true);

  const s = {
    gen: 0,
    op: null,
    article: null,
    manifest: null,
    place: null,          // the bookmark this session is at, in content terms
    seq: 0,
    offset: 0,
    intent: 'paused',     // what the reader asked for
    state: 'idle',        // what the audio is doing
    error: null,
    stage: null,          // what the server says it is doing, while we wait
    notice: null,         // a one-line explanation that is not an error
    changed: false,       // the saved place could not be mapped onto new text
    voiceVersion: 0,
    session: env.sessionId || randomId(),
    lastLocal: 0,
    slowness: 0,
    stallTimer: null,
    stallRetried: false,
    demandTimer: null,
    pendingVoice: undefined,
    voiceBusy: false,
    preload: null,        // { seq, rev, abort } — the spare deck's download
  };

  let tokens = 0;
  let front = 0;
  const decks = env.decks.map((el, index) => ({
    el, index, token: 0, seq: -1, rev: null, url: null, release: null, meta: null, expectPause: false,
  }));
  for (const deck of decks) bindDeck(deck);

  // ── operations ─────────────────────────────────────────────────────────────
  function begin(kind) {
    if (s.op) s.op.abort.abort();
    s.gen += 1;
    s.op = { gen: s.gen, kind, abort: new AbortController() };
    clearStall();
    return s.op;
  }
  const owns = op => Boolean(op) && op === s.op && !op.abort.signal.aborted;

  // ── decks ──────────────────────────────────────────────────────────────────
  const current = () => decks[front];
  const spare = () => decks[1 - front];

  function assign(deck, { rev, seq, url, release }) {
    dropMeta(deck);
    const previous = deck.release;
    deck.token = ++tokens;
    deck.rev = rev;
    deck.seq = seq;
    deck.url = url;
    deck.release = release || null;
    deck.el.playbackRate = rate();
    deck.el.src = url;
    // the old object URL can go only once nothing plays from it
    if (previous) previous();
    return deck.token;
  }

  function empty(deck) {
    dropMeta(deck);
    deck.token = ++tokens;
    quiet(deck);
    const had = deck.url;
    const release = deck.release;
    deck.seq = -1;
    deck.rev = null;
    deck.url = null;
    deck.release = null;
    if (had) {
      deck.el.removeAttribute('src');
      try { deck.el.load(); } catch { /* an element with no source has nothing to unload */ }
    }
    if (release) release();
  }

  function dropMeta(deck) {
    if (!deck.meta) return;
    deck.el.removeEventListener('loadedmetadata', deck.meta.onLoad);
    deck.el.removeEventListener('error', deck.meta.onError);
    deck.meta.settle(false);
    deck.meta = null;
  }

  /** True once the deck knows its duration; false if it lost the source first. */
  function metadata(deck, token) {
    if (deck.el.readyState >= 1) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const settle = (ok) => { if (!done) { done = true; resolve(ok); } };
      const detach = () => {
        deck.el.removeEventListener('loadedmetadata', onLoad);
        deck.el.removeEventListener('error', onError);
        if (deck.meta?.settle === settle) deck.meta = null;
      };
      const onLoad = () => { detach(); settle(deck.token === token); };
      const onError = () => { detach(); settle(false); };
      dropMeta(deck);
      deck.meta = { onLoad, onError, settle };
      deck.el.addEventListener('loadedmetadata', onLoad);
      deck.el.addEventListener('error', onError);
    });
  }

  /* Pausing an element we started is ours to do; the `pause` event it fires a
     moment later must not be read as the system taking the audio away. */
  function quiet(deck) {
    try {
      if (!deck.el.paused) {
        deck.expectPause = true;
        deck.el.pause();
      }
    } catch { /* a detached element */ }
  }

  function stopAll() {
    for (const deck of decks) quiet(deck);
  }

  function bindDeck(deck) {
    const el = deck.el;
    const mine = () => deck === current() && Boolean(deck.url) && Boolean(s.manifest)
      && deck.rev === s.manifest.rev && deck.seq === s.seq;

    el.addEventListener('playing', () => {
      if (!mine()) { quiet(deck); return; }
      if (s.intent !== 'playing') { quiet(deck); return; }
      clearStall();
      s.stallRetried = false;
      s.stage = null;
      s.notice = null;
      quiet(spare());
      setState('playing');
    });

    el.addEventListener('pause', () => {
      if (deck.expectPause) { deck.expectPause = false; return; }
      // a pause nobody here asked for: a call, another app, the OS handling a
      // headset button. Say so, rather than claim to be playing.
      if (!mine() || el.ended || el.seeking || s.intent !== 'playing' || s.state !== 'playing') return;
      s.intent = 'paused';
      checkpoint({ flush: true });
      setState('paused');
    });

    el.addEventListener('waiting', () => {
      if (!mine() || s.intent !== 'playing') return;
      setState('buffering');
      armStall();
    });
    el.addEventListener('stalled', () => {
      if (!mine() || s.intent !== 'playing' || s.state === 'playing') return;
      armStall();
    });

    el.addEventListener('timeupdate', () => {
      if (!mine()) return;
      s.offset = el.currentTime || 0;
      if (s.state === 'playing' && clock.now() - s.lastLocal >= LOCAL_CHECKPOINT_MS) checkpoint();
      render();
    });

    el.addEventListener('loadedmetadata', () => {
      const segment = s.manifest?.segments?.[deck.seq];
      if (!segment || deck.rev !== s.manifest.rev) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        // the display clock tightens; the place, which is a segment id, does not move
        segment.duration = el.duration;
        segment.estimated = false;
        render();
      }
    });

    el.addEventListener('ended', () => {
      if (!mine() || s.intent !== 'playing') return;
      advance();
    });

    el.addEventListener('error', () => {
      const code = el.error?.code;
      if (code === 1 || !deck.url) return;   // aborted, or a source we already let go of
      if (deck !== current()) {
        // a prefetch that failed is asked for again when the player gets there
        empty(deck);
        return;
      }
      if (!mine()) return;
      fail({
        code: code === 3 ? 'audio_invalid' : code === 2 ? 'network' : 'media',
        retryable: code !== 3,
        message: code === 3 ? 'this passage would not decode' : 'this passage could not be loaded',
      });
    });
  }

  /* Played inside the gesture that starts listening, on any deck not already
     holding a passage, so iOS and Chrome count the elements as started by the
     reader before the first passage has downloaded. */
  function unlock() {
    if (!env.silence) return;
    for (const deck of decks) {
      if (deck.url) continue;
      const token = ++tokens;
      deck.token = token;
      try {
        deck.el.src = env.silence;
        const started = deck.el.play();
        started?.then?.(() => { if (deck.token === token && !deck.url) quiet(deck); }, () => {});
      } catch { /* nothing to unlock */ }
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  /** A reader opened an article. Nothing plays until the reader asks. */
  function attach(article, { bookmark = null, version = 0 } = {}) {
    detach();
    s.article = article;
    s.voiceVersion = Number(article?.narration_voice_version) || 0;
    try {
      s.place = bookmarks.seed(article.id, { bookmark, version }).bookmark;
    } catch {
      s.place = null;
    }
    setState('idle');
  }

  /** Leaving the article: stop, save where it was, let the decks go. */
  function detach() {
    if (s.article && s.manifest && s.state !== 'idle') checkpoint({ flush: true, completed: s.state === 'ended' });
    stopDemand();
    begin('detach');
    cancelPreload();
    stopAll();
    for (const deck of decks) empty(deck);
    s.intent = 'paused';
    s.manifest = null;
    s.place = null;
    s.error = null;
    s.stage = null;
    s.notice = null;
    s.changed = false;
    s.seq = 0;
    s.offset = 0;
    s.pendingVoice = undefined;
    s.slowness = 0;
    ui.highlight?.(null);
    s.article = null;
    setState('idle');
  }

  /** The close button: stop, save, keep the place. Reopening does not autoplay. */
  function close() {
    begin('close');
    cancelPreload();
    s.intent = 'paused';
    stopAll();
    if (s.manifest) checkpoint({ flush: true, completed: s.state === 'ended' });
    stopDemand();
    s.stage = null;
    ui.highlight?.(null);
    setState(s.state === 'ended' ? 'ended' : s.manifest ? 'paused' : 'idle');
  }

  // ── transport ──────────────────────────────────────────────────────────────
  /**
   * Start listening. `from` is 'resume' (the saved place), 'beginning', or
   * `{ block_id, content_revision }` for a paragraph the reader chose. The
   * server resolves where that is in the script it prepared; this side only
   * holds the reader's intent while it does.
   */
  async function listen({ from = 'resume' } = {}) {
    if (!s.article) return;
    const articleId = s.article.id;
    const op = begin('listen');
    cancelPreload();
    stopAll();
    s.intent = 'playing';
    s.error = null;
    s.changed = false;
    s.notice = null;
    setState('preparing');

    const start = from === 'beginning' ? { mode: 'beginning' }
      : from && typeof from === 'object' && from.block_id
        ? { mode: 'block', block_id: from.block_id, content_revision: from.content_revision }
        : { mode: 'resume', ...(s.place ? { bookmark: s.place } : {}) };
    let manifest;
    try {
      manifest = await api.prepare(articleId, requestBody({ start }), { signal: op.abort.signal });
    } catch (error) {
      if (!owns(op)) return;
      if (error?.status === 409 && error.data?.code === 'content_changed') {
        s.intent = 'paused';
        s.notice = 'this article changed — choose the paragraph again';
        ui.contentChanged?.(error.data);
        return setState(s.manifest ? 'paused' : 'idle');
      }
      return fail(classify(error));
    }
    if (!owns(op)) return;
    adopt(manifest);
    return begin_at(op, manifest.start);
  }

  function begin_at(op, start) {
    if (!start || start.mode === 'changed' || start.mode === 'nothing') {
      s.intent = 'paused';
      s.changed = start?.mode === 'changed';
      s.notice = start?.mode === 'nothing' ? 'nothing after that paragraph is read aloud'
        : 'this article changed since you last listened';
      return setState('paused');
    }
    return load(op, start.seq, start.offset || 0);
  }

  function resume() {
    if (!s.article) return;
    if (s.state === 'ended') return listen({ from: 'beginning' });
    if (s.state === 'error') return retry();
    if (!s.manifest || s.changed) return listen({ from: 'resume' });
    const op = begin('resume');
    s.intent = 'playing';
    s.notice = null;
    return load(op, s.seq, s.offset);
  }

  function pause() {
    begin('pause');
    cancelPreload();
    s.intent = 'paused';
    stopAll();
    s.stage = null;
    if (s.manifest) checkpoint({ flush: true });
    pushDemand();
    if (s.state === 'error' || s.state === 'idle' || s.state === 'ended') return render();
    setState(s.manifest ? 'paused' : 'idle');
  }

  function toggle() {
    return s.intent === 'playing' ? pause() : resume();
  }

  /** A seek keeps whatever the reader wanted: paused stays paused. */
  function seekTo(seconds) {
    if (!s.manifest) return;
    const op = begin('seek');
    const { seq, offset } = locate(s.manifest.segments, seconds);
    if (s.state === 'ended') s.intent = 'paused';
    return load(op, seq, offset);
  }

  const skip = delta => seekTo(positionOf(s.manifest?.segments || [], s.seq, s.offset) + delta);

  function seekSegment(seq, { play = false } = {}) {
    if (!s.manifest || seq < 0 || seq >= s.manifest.segments.length) return;
    const op = begin('seek');
    if (play) s.intent = 'playing';
    return load(op, seq, 0);
  }

  function retry() {
    if (!s.manifest) return listen({ from: 'resume' });
    const op = begin('retry');
    s.intent = 'playing';
    s.error = null;
    s.stallRetried = false;
    if (current().seq === s.seq) empty(current());
    return load(op, s.seq, s.offset);
  }

  /** The reader's call, never the player's: move past a passage that will not load. */
  function skipPassage() {
    if (!s.manifest) return;
    const next = s.seq + 1;
    if (next >= s.manifest.segments.length) return complete();
    const op = begin('skip');
    s.error = null;
    s.intent = 'playing';
    return load(op, next, 0);
  }

  function setRate(value) {
    for (const deck of decks) deck.el.playbackRate = value;
    pushDemand();
    render();
  }

  /* Back in front of someone after the screen was off. If the audio session
     survived there is nothing to do; if the phone finished a passage in the
     dark and could not start the next, carry on; if the browser will not let
     it play without a tap, say so instead of claiming to play. */
  function wake() {
    if (!s.manifest || s.intent !== 'playing') return;
    const deck = current();
    if (!deck.el.paused && !deck.el.ended) return;
    if (deck.el.ended && deck.seq === s.seq) return advance();
    const op = begin('wake');
    return load(op, s.seq, s.offset);
  }

  // ── voices ─────────────────────────────────────────────────────────────────
  /**
   * Choose the voice for this article; null returns it to the library default.
   * The old voice stops at once. The new one starts at the beginning of the
   * same short passage, playing only if the reader was playing. Rapid choices
   * are sent one after another, each on the version the last one returned, and
   * only the final one is loaded.
   */
  async function setVoice(voice) {
    if (!s.article) return;
    const articleId = s.article.id;
    const wasPlaying = s.intent === 'playing' || (s.voiceBusy && s.state === 'preparing' && s.intent === 'playing');
    begin('voice');
    cancelPreload();
    stopAll();
    s.error = null;
    s.notice = null;
    if (s.manifest) checkpoint();
    s.intent = wasPlaying ? 'playing' : 'paused';
    s.pendingVoice = { voice };
    setState('preparing');
    if (s.voiceBusy) return;

    s.voiceBusy = true;
    let manifest = null;
    let failure = null;
    try {
      while (s.pendingVoice !== undefined && s.article?.id === articleId) {
        const wanted = s.pendingVoice.voice;
        s.pendingVoice = undefined;
        try {
          manifest = await api.prepare(articleId, requestBody({
            voice_override: wanted,
            expected_voice_version: s.voiceVersion,
            start: { mode: 'resume', ...(s.place ? { bookmark: s.place } : {}) },
          }), {});
          s.voiceVersion = Number(manifest.voice_version) || s.voiceVersion;
          failure = null;
        } catch (error) {
          manifest = null;
          failure = error;
          if (error?.status === 409 && error.data?.code === 'voice_conflict') {
            // another device changed it: take theirs rather than retrying ours
            s.voiceVersion = Number(error.data.voice_version) || s.voiceVersion;
            s.pendingVoice = undefined;
          }
        }
      }
    } finally {
      s.voiceBusy = false;
    }

    // a pause, seek, close or another article since then owns the player now
    const op = s.op;
    if (!op || op.kind !== 'voice' || op.abort.signal.aborted || s.article?.id !== articleId) {
      if (s.manifest && manifest && s.manifest.rev !== manifest.rev) s.manifest = null;
      return;
    }
    if (failure) {
      if (failure?.status === 409 && failure.data?.code === 'voice_conflict') {
        s.notice = 'the voice was changed on another device';
        if (s.intent === 'playing') return listen({ from: 'resume' });
        s.manifest = null;
        return setState('paused');
      }
      return fail(classify(failure));
    }
    adopt(manifest);
    return begin_at(op, manifest.start);
  }

  // ── content changed under us ───────────────────────────────────────────────
  /** An edit to the article: keep the reader's paragraph and intent, rebuild the rest. */
  function reload() {
    if (!s.article) return;
    const wasPlaying = s.intent === 'playing';
    begin('reload');
    cancelPreload();
    stopAll();
    if (s.manifest) checkpoint();
    for (const deck of decks) empty(deck);
    s.manifest = null;
    if (wasPlaying) return listen({ from: 'resume' });
    return setState(s.place ? 'paused' : 'idle');
  }

  function resolveConflict(choice) {
    if (!s.article) return;
    const view = bookmarks.resolve(s.article.id, choice);
    if (choice === 'theirs' && view.bookmark) {
      s.place = view.bookmark;
      if (s.manifest) {
        const op = begin('conflict');
        s.manifest = null;
        if (s.intent === 'playing') return listen({ from: 'resume' });
        void op;
        return setState('paused');
      }
    }
    render();
  }

  /** A bookmark that arrived after the article opened (an old one just converted). */
  function seed({ bookmark = null, version = 0 } = {}) {
    if (!s.article || s.state !== 'idle' || s.manifest) return;
    try {
      s.place = bookmarks.seed(s.article.id, { bookmark, version }).bookmark;
    } catch { /* storage is a convenience */ }
    render();
  }

  /** Save the place now: the page is being hidden and may not come back. */
  function flush() {
    if (s.article && s.manifest && s.state !== 'idle') checkpoint({ flush: true, completed: s.state === 'ended' });
  }

  /** What to send with keepalive when the page is going away. */
  function unload() {
    if (!s.article) return null;
    if (s.manifest && s.state !== 'idle') checkpoint({ completed: s.state === 'ended' });
    const body = bookmarks.unload(s.article.id);
    return body ? { articleId: s.article.id, body } : null;
  }

  /** A status event from the server, already parsed. Only ours, only while waiting. */
  function stage(event) {
    if (!event || !s.article || event.article_id !== s.article.id || event.background) return;
    if (s.manifest && event.rev && event.rev !== s.manifest.rev) return;
    if (Number.isInteger(event.seq) && s.manifest && event.seq !== s.seq) return;
    if (s.state !== 'preparing' && s.state !== 'buffering') return;
    if (event.stage === 'ready') { s.stage = null; return render(); }
    s.stage = { detail: event.detail, at: clock.now(), seq: event.seq, total: event.total, code: event.code };
    render();
  }

  // ── loading a passage ──────────────────────────────────────────────────────
  async function load(op, seq, offset = 0, { retried = false } = {}) {
    const manifest = s.manifest;
    if (!manifest || !owns(op)) return;
    const segments = manifest.segments;
    if (seq >= segments.length) return complete();

    if (s.seq !== seq) s.stallRetried = false;
    s.seq = seq;
    s.offset = offset;
    s.error = null;
    s.changed = false;
    ui.highlight?.(segments[seq], { follow: true });
    checkpoint({ flush: s.intent !== 'playing' || op.kind === 'seek' });
    if (s.preload && s.preload.seq !== seq + 1 && s.preload.seq !== seq) cancelPreload();
    pushDemand();

    let deck = null;
    if (spare().rev === manifest.rev && spare().seq === seq && spare().url) {
      front = 1 - front;
      deck = current();
    } else if (current().rev === manifest.rev && current().seq === seq && current().url) {
      deck = current();
    }
    quiet(spare());

    if (!deck) {
      quiet(current());
      setState(s.intent === 'playing' ? 'buffering' : 'paused');
      let loaded;
      const started = clock.now();
      try {
        loaded = await source.load(manifest, seq, { signal: op.abort.signal, priority: 'foreground' });
      } catch (error) {
        if (!owns(op)) return;
        const failure = classify(error);
        if (failure.code === 'cancelled') return;
        if (failure.retryable && !retried && failure.code !== 'offline') {
          await wait(clock, RETRY_DELAY_MS, op.abort.signal);
          if (!owns(op)) return;
          return load(op, seq, offset, { retried: true });
        }
        if (failure.code === 'offline') waitForOnline(op);
        return fail(failure);
      }
      if (!owns(op)) { loaded?.release?.(); return; }
      if (op.kind === 'advance') measure(clock.now() - started, 0);
      deck = current();
      assign(deck, { rev: manifest.rev, seq, url: loaded.url, release: loaded.release });
    }

    const token = deck.token;
    if (offset > 0.05) {
      const ok = await metadata(deck, token);
      if (!owns(op) || deck.token !== token) return;
      if (!ok) return fail({ code: 'media', retryable: true, message: 'this passage could not be loaded' });
      const end = Number.isFinite(deck.el.duration) ? Math.max(0, deck.el.duration - 0.25) : offset;
      try { deck.el.currentTime = Math.min(offset, end); } catch { /* not seekable yet */ }
    } else if (deck.el.currentTime > 0.05) {
      try { deck.el.currentTime = 0; } catch { /* not seekable yet */ }
    }
    deck.el.playbackRate = rate();

    if (s.intent === 'playing') {
      if (s.state !== 'playing' || deck.el.paused) setState('buffering');
      try {
        await deck.el.play();
      } catch (error) {
        // a promise from a source or an operation that has since been replaced
        // says nothing about the deck as it is now — leave the deck alone
        if (!owns(op) || deck.token !== token) return;
        if (error?.name === 'AbortError') return;
        if (error?.name === 'NotAllowedError') {
          s.intent = 'paused';
          s.notice = 'tap play to continue';
          checkpoint({ flush: true });
          return setState('blocked');
        }
        return fail({ code: error?.name === 'NotSupportedError' ? 'audio_invalid' : 'media', retryable: true, message: 'this passage could not be played' });
      }
      if (!owns(op) || deck.token !== token) return;
    } else {
      setState('paused');
    }
    preloadNext();
  }

  /* The next passage goes on the spare deck once this one is under way — never
     before, and never waited on. Its download has its own lifetime: crossing
     into the next passage does not cancel it, a seek elsewhere does. */
  async function preloadNext() {
    const manifest = s.manifest;
    const next = s.seq + 1;
    if (!manifest || next >= manifest.segments.length) return;
    const deck = spare();
    if (deck.rev === manifest.rev && deck.seq === next && deck.url) return;
    if (s.preload && s.preload.rev === manifest.rev && s.preload.seq === next) return;
    cancelPreload();
    const job = { seq: next, rev: manifest.rev, abort: new AbortController() };
    s.preload = job;
    const started = clock.now();
    const remaining = Math.max(0, (Number(manifest.segments[s.seq]?.duration) || 0) - s.offset) / (rate() || 1);
    let loaded;
    try {
      loaded = await source.load(manifest, next, { signal: job.abort.signal, priority: 'next' });
    } catch {
      if (s.preload === job) s.preload = null;
      return;   // asked for again, in the foreground, when playback reaches it
    }
    if (s.preload === job) s.preload = null;
    measure(clock.now() - started, remaining);
    const still = s.manifest && s.manifest.rev === job.rev && s.seq + 1 === next && spare().seq !== next;
    if (!still || job.abort.signal.aborted) { loaded?.release?.(); return; }
    assign(spare(), { rev: job.rev, seq: next, url: loaded.url, release: loaded.release });
  }

  function cancelPreload() {
    if (s.preload) s.preload.abort.abort();
    s.preload = null;
  }

  function advance() {
    if (!s.manifest) return;
    const next = s.seq + 1;
    if (next >= s.manifest.segments.length) return complete();
    const op = begin('advance');
    return load(op, next, 0);
  }

  function complete() {
    begin('complete');
    cancelPreload();
    s.intent = 'paused';
    stopAll();
    s.offset = 0;
    checkpoint({ flush: true, completed: true });
    ui.highlight?.(null);
    stopDemand();
    setState('ended');
  }

  function fail(failure) {
    clearStall();
    s.error = { code: failure.code, message: failure.message, retryable: Boolean(failure.retryable), seq: s.seq };
    if (failure.code !== 'offline') s.intent = 'paused';
    s.stage = null;
    stopAll();
    if (s.manifest) checkpoint({ flush: true });
    setState('error');
  }

  function armStall() {
    if (s.stallTimer) return;
    const op = s.op;
    s.stallTimer = clock.setTimeout(() => {
      s.stallTimer = null;
      if (!owns(op) || s.intent !== 'playing' || s.state === 'playing') return;
      if (!s.stallRetried) {
        // one more try at the same place; the server already retried the provider
        s.stallRetried = true;
        const again = begin('stall');
        if (current().seq === s.seq) empty(current());
        load(again, s.seq, s.offset);
        return;
      }
      fail({ code: 'network', retryable: true, message: 'the connection stalled' });
    }, STALL_MS);
  }

  function clearStall() {
    if (s.stallTimer) clock.clearTimeout(s.stallTimer);
    s.stallTimer = null;
  }

  /* Offline is a wait, not a failure: the reader's intent stands, and coming
     back online carries on only if they still want it. */
  function waitForOnline(op) {
    env.onOnline?.(() => {
      if (s.op !== op || s.intent !== 'playing' || s.state !== 'error') return;
      retry();
    });
  }

  // ── delivery and demand ────────────────────────────────────────────────────
  function measure(ms, bufferedSeconds) {
    s.slowness = nextSlowness(s.slowness, { readyMs: ms, bufferedSeconds });
  }

  /* Tells the server which passages this session needs, so synthesis runs a
     little ahead of the ear and stops for passages nobody is heading towards.
     Renewed while playing; a page that goes quiet lets its lease lapse. */
  function pushDemand() {
    if (!api.demand || !s.article || !s.manifest) return;
    const seconds = bufferSeconds({ slowness: s.slowness });
    const body = {
      session_id: s.session,
      generation: s.gen,
      rev: s.manifest.rev,
      seq: s.seq,
      rate: rate(),
      target_seconds: seconds,
      save_data: saveData(),
      paused: s.intent !== 'playing',
    };
    const articleId = s.article.id;
    Promise.resolve().then(() => api.demand(articleId, body)).catch(() => {});
    if (s.demandTimer) clock.clearTimeout(s.demandTimer);
    s.demandTimer = null;
    if (s.intent === 'playing') {
      s.demandTimer = clock.setTimeout(() => {
        s.demandTimer = null;
        if (visible() && s.intent === 'playing') pushDemand();
      }, DEMAND_HEARTBEAT_MS);
    }
  }

  function stopDemand() {
    if (s.demandTimer) clock.clearTimeout(s.demandTimer);
    s.demandTimer = null;
    if (!api.demand || !s.article || !s.manifest) return;
    const articleId = s.article.id;
    const body = { session_id: s.session, generation: s.gen + 1, rev: s.manifest.rev, seq: s.seq, release: true };
    Promise.resolve().then(() => api.demand(articleId, body)).catch(() => {});
  }

  // ── state ──────────────────────────────────────────────────────────────────
  function adopt(manifest) {
    if (s.manifest && s.manifest.rev !== manifest.rev) {
      for (const deck of decks) if (deck.rev !== manifest.rev) empty(deck);
    }
    s.manifest = { ...manifest, segments: manifest.segments.map(segment => ({ ...segment })) };
    if (Number.isFinite(Number(manifest.voice_version))) s.voiceVersion = Number(manifest.voice_version);
    ui.manifest?.(s.manifest);
  }

  function checkpoint({ flush = false, completed = false } = {}) {
    if (!s.article || !s.manifest) return;
    const bookmark = makeBookmark(s.manifest, s.seq, completed ? 0 : s.offset, { completed });
    if (!bookmark) return;
    s.place = bookmark;
    s.lastLocal = clock.now();
    try { bookmarks.checkpoint(s.article.id, bookmark, { flush }); } catch { /* storage must never stop audio */ }
  }

  function requestBody(extra) {
    return { request_id: randomId(), session_id: s.session, generation: s.gen, ...extra };
  }

  function setState(next) {
    s.state = next;
    render();
  }

  function render() {
    ui.update?.(view());
  }

  function view() {
    const segments = s.manifest?.segments || [];
    const { total } = timeline(segments);
    let conflict = null;
    try { conflict = s.article ? bookmarks.view(s.article.id).conflict : null; } catch { /* no storage */ }
    const place = s.place;
    return {
      articleId: s.article?.id ?? null,
      state: s.state,
      intent: s.intent,
      error: s.error,
      stage: s.stage,
      notice: s.notice,
      changed: s.changed,
      conflict,
      ready: Boolean(s.manifest),
      voice: s.manifest?.voice || null,
      seq: s.seq,
      count: segments.length,
      segment: segments[s.seq] || null,
      position: positionOf(segments, s.seq, s.offset),
      total,
      estimated: segments.some(segment => segment.estimated),
      slow: s.slowness >= 1,
      action: s.intent === 'playing' ? 'pause'
        : s.state === 'ended' || (!s.manifest && place?.completed) ? 'listen again'
          : (place && !place.completed) || (s.manifest && s.state !== 'idle') ? 'resume' : 'listen',
      gen: s.gen,
    };
  }

  return {
    attach, detach, close, listen, resume, pause, toggle, seekTo, skip, seekSegment,
    retry, skipPassage, setRate, wake, setVoice, reload, resolveConflict, unload, stage, unlock, seed, flush,
    view,
    get state() { return s.state; },
    get intent() { return s.intent; },
    get manifest() { return s.manifest; },
    get article() { return s.article; },
    get place() { return s.place; },
    SKIP_SECONDS,
    _decks: decks,
  };
}

/** Errors as the player understands them: a code, whether retrying can help, and words. */
export function classify(error) {
  if (error?.name === 'AbortError') return { code: 'cancelled', retryable: true, message: 'cancelled' };
  if (typeof error?.code === 'string' && typeof error.retryable === 'boolean') {
    return { code: error.code, retryable: error.retryable, message: error.message || error.code, status: error.status };
  }
  const data = error?.data || {};
  if (typeof data.code === 'string') {
    return { code: data.code, retryable: Boolean(data.retryable), message: data.error || data.code, status: error.status };
  }
  if (error?.status === 422) return { code: 'nothing_to_read', retryable: false, message: error.message, status: 422 };
  if (error?.status === 404) return { code: 'not_found', retryable: false, message: error.message, status: 404 };
  if (error?.status) {
    return { code: 'server', retryable: error.status >= 500 || error.status === 429, message: error.message, status: error.status };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { code: 'offline', retryable: true, message: 'you are offline' };
  }
  return { code: 'network', retryable: true, message: error?.message || 'the network request failed' };
}

/** A real 50ms silent WAV (8kHz, 8-bit, mono) — a zero-sample file is refused by some decoders. */
export function silentWavUrl() {
  const samples = 400;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function wait(clock, ms, signal) {
  return new Promise((resolve) => {
    const id = clock.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clock.clearTimeout(id); resolve(); }, { once: true });
  });
}

function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* insecure context */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
