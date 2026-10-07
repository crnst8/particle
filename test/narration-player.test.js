import test from 'node:test';
import assert from 'node:assert/strict';
import { createNarrationPlayer } from '../public/narration-player.js';
import { createBookmarkSync } from '../public/narration-model.js';

/* A media element with the parts of HTMLMediaElement the player relies on. Play
   promises stay pending until the test settles them, the way a slow network or
   a browser autoplay policy would leave them. */
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = '';
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 0;
    this.currentTime = 0;
    this.duration = NaN;
    this.playbackRate = 1;
    this.error = null;
    this.preload = '';
    this.plays = [];
    this.abortOnLoad = true;
  }
  get src() { return this._src; }
  set src(value) {
    this._src = value;
    this.reset();
  }
  removeAttribute(name) { if (name === 'src') { this._src = ''; this.reset(); } }
  load() { this.reset(); }
  reset() {
    const wasPlaying = !this.paused;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.currentTime = 0;
    this.duration = NaN;
    if (this.abortOnLoad) {
      for (const play of this.plays.splice(0)) play.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    if (wasPlaying) this.fire('pause');
  }
  play() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const entry = { resolve, reject, src: this._src };
    this.plays.push(entry);
    return promise;
  }
  /** The browser lets the most recent play() through. */
  allow() {
    const entry = this.plays.shift();
    if (!entry) throw new Error('no play pending');
    this.paused = false;
    this.fire('playing');
    entry.resolve();
  }
  refuse(name = 'NotAllowedError') {
    const entry = this.plays.shift();
    entry.reject(Object.assign(new Error(name), { name }));
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
  meta(duration = 10) {
    this.readyState = 1;
    this.duration = duration;
    this.fire('loadedmetadata');
  }
  finish() {
    this.currentTime = this.duration || 0;
    this.ended = true;
    this.paused = true;
    this.fire('pause');
    this.fire('ended');
  }
  fail(code) {
    this.error = { code };
    this.fire('error');
  }
  fire(type) { this.dispatchEvent(new Event(type)); }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

function manifest(rev = 'rA', { voice = 'A', count = 4 } = {}) {
  return {
    article_id: 1,
    rev,
    script_id: 's1',
    content_revision: 'c1',
    voice: { id: voice, name: voice, source: 'default' },
    voice_version: 0,
    segments: Array.from({ length: count }, (_, seq) => ({
      id: `b${seq}.0`, seq, block_id: `b${seq}`, duration: 10, estimated: true,
    })),
    start: { seq: 0, offset: 0, mode: 'beginning' },
  };
}

/* The whole player, with every adapter under the test's control. */
function rig({ autoSource = true } = {}) {
  const decks = [new FakeAudio(), new FakeAudio()];
  const prepares = [];
  const loads = [];
  const views = [];
  const timers = [];
  const api = {
    prepare: (id, body, options) => {
      const d = deferred();
      prepares.push({ id, body, options, ...d });
      return d.promise;
    },
  };
  const source = {
    load: (m, seq, { signal, priority }) => {
      if (autoSource) return Promise.resolve({ url: `blob:${m.rev}/${seq}`, release() {} });
      const d = deferred();
      loads.push({ rev: m.rev, seq, signal, priority, ...d });
      signal?.addEventListener('abort', () => d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      return d.promise;
    },
  };
  const local = new Map();
  const sent = [];
  const bookmarks = createBookmarkSync({
    local: { load: id => local.get(id), save: (id, v) => local.set(id, v), remove: id => local.delete(id) },
    send: (_id, body) => { sent.push(body); return Promise.resolve({ version: sent.length, bookmark: body.bookmark }); },
  });
  const clock = {
    now: () => 0,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  const player = createNarrationPlayer({
    api, source, bookmarks, decks, clock,
    ui: { update: view => views.push(view) },
  });
  player.attach({ id: 1, title: 'A story' });
  const playing = () => decks.filter(deck => !deck.paused);
  const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  return { player, decks, prepares, loads, views, sent, playing, runTimers, local };
}

test('listen plays only after the browser confirms with a playing event', async () => {
  const { player, decks, prepares } = rig();
  player.listen();
  assert.equal(player.state, 'preparing');
  prepares[0].resolve(manifest());
  await tick();
  assert.equal(player.state, 'buffering');
  const deck = decks.find(one => one.plays.length);
  assert.equal(deck.src, 'blob:rA/0');
  deck.allow();
  await tick();
  assert.equal(player.state, 'playing');
});

test('blocked play shows blocked, never playing, and keeps the place', async () => {
  const { player, decks, prepares, views } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  decks.find(one => one.plays.length).refuse('NotAllowedError');
  await tick();
  assert.equal(player.state, 'blocked');
  assert.equal(player.intent, 'paused');
  assert.ok(!views.some(view => view.state === 'playing'));
  assert.equal(player.view().notice, 'tap play to continue');
  assert.equal(player.place.segment_id, 'b0.0');
});

test('closing before the plan arrives stays closed', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  player.close();
  prepares[0].resolve(manifest());
  await tick();
  assert.equal(player.manifest, null);
  assert.ok(decks.every(deck => !deck.src && !deck.plays.length));
  assert.notEqual(player.state, 'playing');
  assert.equal(player.intent, 'paused');
});

test('pause before play resolves stays paused when the promise settles', async () => {
  const { player, prepares, decks, playing } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  const deck = decks.find(one => one.plays.length);
  player.pause();
  assert.equal(player.state, 'paused');
  deck.allow();   // the old play() lands after the pause
  await tick();
  assert.equal(playing().length, 0, 'the late play was silenced');
  assert.equal(player.state, 'paused');
});

test('pausing while a passage downloads cancels intent; the download finishing does not resume it', async () => {
  const { player, prepares, loads, decks } = rig({ autoSource: false });
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  assert.equal(player.state, 'buffering');
  player.pause();
  loads[0].resolve({ url: 'blob:late', release() {} });
  await tick();
  assert.equal(player.state, 'paused');
  assert.ok(decks.every(deck => !deck.plays.length));
});

test('a late seek target never lands on a source loaded after it', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();
  player.pause();

  player.seekTo(13);   // segment 1, three seconds in: waits for metadata
  await tick();
  const first = decks.find(one => one.src === 'blob:rA/1');
  assert.ok(first);
  player.seekTo(20);   // segment 2 from the top, before segment 1 knew its length
  await tick();
  const second = decks.find(one => one.src === 'blob:rA/2');
  assert.ok(second);
  first.meta(10);
  second.meta(10);
  await tick();
  assert.equal(second.currentTime, 0, 'the earlier seek offset did not leak onto the newer source');
  assert.equal(player.view().seq, 2);
  assert.equal(player.state, 'paused', 'a seek keeps paused intent');
});

test('resuming partway into a passage waits for its metadata, then seeks and plays', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  const m = manifest();
  m.start = { seq: 2, offset: 4.5, mode: 'exact' };
  prepares[0].resolve(m);
  await tick();
  const deck = decks.find(one => one.src === 'blob:rA/2');
  assert.equal(deck.plays.length, 0, 'not played before it can seek');
  deck.meta(10);
  await tick();
  assert.equal(deck.currentTime, 4.5);
  deck.allow();
  await tick();
  assert.equal(player.state, 'playing');
});

test('an obsolete play() rejection does not touch a deck reused by a newer operation', async () => {
  const { player, prepares, decks } = rig();
  for (const deck of decks) deck.abortOnLoad = false;   // the old promise outlives the src change
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  const deck = decks.find(one => one.plays.length);
  player.seekSegment(0, { play: true });   // the same passage, a new operation, the same deck
  await tick();
  assert.equal(deck.plays.length, 2);
  deck.refuse('NotAllowedError');          // the first promise, rejected late
  await tick();
  assert.notEqual(player.state, 'blocked');
  deck.allow();
  await tick();
  assert.equal(player.state, 'playing');
});

test('a failed passage stays selected; it is never skipped', async () => {
  const { player, prepares, loads, runTimers } = rig({ autoSource: false });
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  loads[0].reject(Object.assign(new Error('provider timed out'), { code: 'provider_timeout', retryable: true }));
  await tick();
  runTimers();   // the single automatic retry after a short delay
  await tick();
  assert.equal(loads.length, 2);
  loads[1].reject(Object.assign(new Error('provider timed out'), { code: 'provider_timeout', retryable: true }));
  await tick();
  assert.equal(player.state, 'error');
  assert.equal(player.view().seq, 0);
  assert.equal(player.view().error.code, 'provider_timeout');
  assert.equal(loads.length, 2, 'no further attempts and no move to the next passage');

  player.skipPassage();
  await tick();
  assert.equal(player.view().seq, 1, 'skipping is an explicit action');
});

test('a permanent failure is not retried automatically', async () => {
  const { player, prepares, loads } = rig({ autoSource: false });
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  loads[0].reject(Object.assign(new Error('voice gone'), { code: 'voice_unavailable', retryable: false }));
  await tick();
  assert.equal(player.state, 'error');
  assert.equal(loads.length, 1);
});

test('a media error on the playing deck stops with Retry rather than skipping', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  const deck = decks.find(one => one.plays.length);
  deck.allow();
  await tick();
  deck.fail(2);
  await tick();
  assert.equal(player.state, 'error');
  assert.equal(player.view().seq, 0);
  player.retry();
  await tick();
  assert.equal(player.view().seq, 0);
});

test('the end of a passage moves to the next; the end of the last stores completion', async () => {
  const { player, prepares, decks } = rig();
  const m = manifest('rA', { count: 2 });
  player.listen();
  prepares[0].resolve(m);
  await tick();
  let deck = decks.find(one => one.plays.length);
  deck.allow();
  await tick();
  deck.finish();
  await tick();
  assert.equal(player.view().seq, 1);
  deck = decks.find(one => one.plays.length);
  deck.allow();
  await tick();
  deck.finish();
  await tick();
  assert.equal(player.state, 'ended');
  assert.equal(player.place.completed, true);
  assert.equal(player.view().action, 'listen again');
});

test('a pause the system makes is reported, not papered over', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  const deck = decks.find(one => one.plays.length);
  deck.allow();
  await tick();
  deck.pause();   // a phone call, another app
  assert.equal(player.state, 'paused');
  assert.equal(player.intent, 'paused');
});

test('switching voice stops the old one at once and resumes at the same passage', async () => {
  const { player, prepares, decks, playing } = rig();
  player.listen();
  prepares[0].resolve(manifest('rA'));
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();
  player.seekSegment(2);
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();

  player.setVoice({ id: 'B', name: 'B' });
  assert.equal(playing().length, 0, 'A stopped inside the click');
  assert.equal(prepares[1].body.voice_override.id, 'B');
  assert.equal(prepares[1].body.start.bookmark.segment_id, 'b2.0');
  const next = manifest('rB', { voice: 'B' });
  next.voice_version = 1;
  next.start = { seq: 2, offset: 0, mode: 'segment' };
  prepares[1].resolve(next);
  await tick();
  const deck = decks.find(one => one.src === 'blob:rB/2');
  assert.ok(deck, 'B loaded at the same passage');
  deck.allow();
  await tick();
  assert.equal(player.state, 'playing');
  assert.equal(playing().length, 1);
});

test('switching voice while paused stays paused', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest('rA'));
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();
  player.pause();
  player.setVoice({ id: 'B', name: 'B' });
  const next = manifest('rB', { voice: 'B' });
  prepares[1].resolve(next);
  await tick();
  assert.equal(player.state, 'paused');
  assert.ok(decks.every(deck => !deck.plays.length));
});

test('rapid A→B→C sends B then C on the version B returned, and only C plays', async () => {
  const { player, prepares, decks, playing } = rig();
  player.listen();
  prepares[0].resolve(manifest('rA'));
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();

  player.setVoice({ id: 'B', name: 'B' });
  player.setVoice({ id: 'C', name: 'C' });
  assert.equal(prepares.length, 2, 'C waits for B rather than racing it');
  const b = manifest('rB', { voice: 'B' });
  b.voice_version = 1;
  prepares[1].resolve(b);
  await tick();
  assert.equal(prepares.length, 3);
  assert.equal(prepares[2].body.voice_override.id, 'C');
  assert.equal(prepares[2].body.expected_voice_version, 1);
  assert.ok(!decks.some(deck => deck.src.startsWith('blob:rB')), 'B never loaded');
  const c = manifest('rC', { voice: 'C' });
  c.voice_version = 2;
  prepares[2].resolve(c);
  await tick();
  const deck = decks.find(one => one.src === 'blob:rC/0');
  deck.allow();
  await tick();
  assert.equal(player.view().voice.id, 'C');
  assert.equal(playing().length, 1);
});

test('a failed voice switch leaves Retry, not the old voice', async () => {
  const { player, prepares, decks, playing } = rig();
  player.listen();
  prepares[0].resolve(manifest('rA'));
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();
  player.setVoice({ id: 'B', name: 'B' });
  prepares[1].reject(Object.assign(new Error('voice gone'), { status: 422, data: { code: 'voice_unavailable', retryable: false, error: 'voice gone' } }));
  await tick();
  assert.equal(player.state, 'error');
  assert.equal(player.view().error.code, 'voice_unavailable');
  assert.equal(playing().length, 0);
});

test('a voice conflict from another device reloads theirs instead of retrying ours', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest('rA'));
  await tick();
  decks.find(one => one.plays.length).allow();
  await tick();
  player.setVoice({ id: 'B', name: 'B' });
  prepares[1].reject(Object.assign(new Error('conflict'), { status: 409, data: { code: 'voice_conflict', voice_version: 7 } }));
  await tick();
  assert.equal(prepares.length, 3);
  assert.equal(prepares[2].body.voice_override, undefined, 'the stale change is not resent');
});

test('navigating away mid-plan leaves nothing behind for the late reply', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  player.attach({ id: 2, title: 'Another' });
  prepares[0].resolve(manifest());
  await tick();
  assert.equal(player.article.id, 2);
  assert.equal(player.manifest, null);
  assert.ok(decks.every(deck => !deck.plays.length));
});

test('a wake after the screen was off says blocked instead of claiming to play', async () => {
  const { player, prepares, decks } = rig();
  player.listen();
  prepares[0].resolve(manifest());
  await tick();
  const deck = decks.find(one => one.plays.length);
  deck.allow();
  await tick();
  // the OS suspended the page; the element is paused without our asking, and no event reached us
  deck.paused = true;
  player.wake();
  await tick();
  deck.refuse('NotAllowedError');
  await tick();
  assert.equal(player.state, 'blocked');
});
