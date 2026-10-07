import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeline, locate, positionOf, makeBookmark, validBookmark, resolveStart, segmentForBlock,
  demandWindow, bufferSeconds, nextSlowness, createBookmarkSync,
} from '../public/narration-model.js';

const manifest = (rev = 'r1', script = 's1', content = 'c1') => ({
  rev, script_id: script, content_revision: content,
  segments: [
    { id: 'b1.0', seq: 0, block_id: 'b1', duration: 10 },
    { id: 'b2.0', seq: 1, block_id: 'b2', duration: 5 },
    { id: 'b2.1', seq: 2, block_id: 'b2', duration: 5 },
    { id: 'b4.0', seq: 3, block_id: 'b4', duration: 8 },
  ],
  blocks: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
});

// ── timeline ─────────────────────────────────────────────────────────────────

test('the display clock is cumulative durations', () => {
  const { marks, total } = timeline(manifest().segments);
  assert.deepEqual(marks, [0, 10, 15, 20]);
  assert.equal(total, 28);
  assert.equal(positionOf(manifest().segments, 2, 1.5), 16.5);
});

test('a point on the clock locates a segment and offset, clamped to the end', () => {
  assert.deepEqual(locate(manifest().segments, 12), { seq: 1, offset: 2 });
  assert.deepEqual(locate(manifest().segments, -4), { seq: 0, offset: 0 });
  const end = locate(manifest().segments, 999);
  assert.equal(end.seq, 3);
  assert.ok(end.offset < 8);
});

// ── bookmarks ────────────────────────────────────────────────────────────────

test('a bookmark names the segment, never the cumulative seconds', () => {
  const mark = makeBookmark(manifest(), 2, 3.456);
  assert.equal(mark.segment_id, 'b2.1');
  assert.equal(mark.block_id, 'b2');
  assert.equal(mark.offset_seconds, 3.46);
  assert.equal(mark.completed, false);
  assert.deepEqual(validBookmark(mark), mark);
});

test('malformed bookmarks are refused', () => {
  const good = makeBookmark(manifest(), 0, 1);
  assert.equal(validBookmark({ ...good, v: 2 }), null);
  assert.equal(validBookmark({ ...good, offset_seconds: -1 }), null);
  assert.equal(validBookmark({ ...good, offset_seconds: Infinity }), null);
  assert.equal(validBookmark({ ...good, completed: 'no' }), null);
  assert.equal(validBookmark({ ...good, segment_id: '../../x y' }), null);
  assert.equal(validBookmark(null), null);
});

test('the same audio resumes to the second', () => {
  const start = resolveStart(manifest(), makeBookmark(manifest(), 2, 3.2));
  assert.deepEqual(start, { seq: 2, offset: 3.2, mode: 'exact' });
});

test('another voice on the same script restarts the current segment', () => {
  const start = resolveStart(manifest('r2'), makeBookmark(manifest('r1'), 2, 3.2));
  assert.deepEqual(start, { seq: 2, offset: 0, mode: 'segment' });
});

test('changed text resumes at the same paragraph if it survived', () => {
  const old = makeBookmark(manifest('r1', 's1'), 2, 3.2);
  const edited = manifest('r9', 's9', 'c9');
  edited.segments = [{ id: 'b0.0', block_id: 'b0', duration: 3 }, { id: 'b2.0', block_id: 'b2', duration: 9 }];
  assert.deepEqual(resolveStart(edited, old), { seq: 1, offset: 0, mode: 'block' });
});

test('a removed paragraph resumes at the next one that survived, in the old order', () => {
  const old = makeBookmark(manifest('r1', 's1'), 1, 2);
  const edited = manifest('r9', 's9', 'c9');
  edited.segments = [{ id: 'b1.0', block_id: 'b1', duration: 3 }, { id: 'b4.0', block_id: 'b4', duration: 9 }];
  const start = resolveStart(edited, old, { oldBlocks: ['b1', 'b2', 'b3', 'b4'] });
  assert.deepEqual(start, { seq: 1, offset: 0, mode: 'next-block' });
});

test('with no mapping the answer is changed, not a guess', () => {
  const old = makeBookmark(manifest('r1', 's1'), 1, 2);
  const edited = manifest('r9', 's9', 'c9');
  edited.segments = [{ id: 'x.0', block_id: 'x', duration: 3 }];
  assert.equal(resolveStart(edited, old).mode, 'changed');
});

test('completion is stored, and resolves to the beginning rather than the last seconds', () => {
  const done = makeBookmark(manifest(), 3, 7.9, { completed: true });
  assert.equal(done.completed, true);
  assert.deepEqual(resolveStart(manifest(), done), { seq: 0, offset: 0, mode: 'completed' });
});

test('final seconds of the last segment are kept, not reset', () => {
  const near = makeBookmark(manifest(), 3, 7.8);
  assert.deepEqual(resolveStart(manifest(), near), { seq: 3, offset: 7.8, mode: 'exact' });
});

test('an excluded paragraph starts at the next spoken one', () => {
  assert.deepEqual(segmentForBlock(manifest(), 'b2'), { seq: 1, exact: true });
  assert.deepEqual(segmentForBlock(manifest(), 'b3'), { seq: 3, exact: false });
  assert.equal(segmentForBlock(manifest(), 'nope'), null);
});

// ── buffering ────────────────────────────────────────────────────────────────

test('demand covers seconds of listening at the playback rate', () => {
  const segments = Array.from({ length: 20 }, (_, seq) => ({ seq, duration: 10 }));
  assert.deepEqual(demandWindow(segments, 4, { seconds: 30, rate: 1 }), [4, 5, 6, 7]);
  // twice the speed eats twice the buffer
  assert.deepEqual(demandWindow(segments, 4, { seconds: 30, rate: 2 }), [4, 5, 6, 7, 8, 9, 10]);
  // never more than the segment ceiling past the current one
  assert.equal(demandWindow(segments, 0, { seconds: 90, rate: 2, maxSegments: 6 }).length, 7);
  assert.deepEqual(demandWindow(segments, 4, { saveData: true }), [4, 5]);
  assert.deepEqual(demandWindow(segments, 19, { seconds: 30 }), [19]);
});

test('slow delivery grows the runway, quick delivery shrinks it back', () => {
  assert.equal(bufferSeconds({ slowness: 0 }), 30);
  assert.equal(bufferSeconds({ slowness: 1 }), 60);
  assert.equal(bufferSeconds({ slowness: 2 }), 90);
  let slowness = 0;
  slowness = nextSlowness(slowness, { readyMs: 9000, bufferedSeconds: 5 });
  slowness = nextSlowness(slowness, { readyMs: 9000, bufferedSeconds: 5 });
  slowness = nextSlowness(slowness, { readyMs: 9000, bufferedSeconds: 5 });
  assert.equal(slowness, 2);
  for (let i = 0; i < 8; i++) slowness = nextSlowness(slowness, { readyMs: 400, bufferedSeconds: 20 });
  assert.equal(slowness, 0);
});

// ── bookmark writes ──────────────────────────────────────────────────────────

function memoryLocal() {
  const data = new Map();
  return {
    data,
    load: id => data.get(id) || null,
    save: (id, value) => data.set(id, structuredClone(value)),
    remove: id => data.delete(id),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('writes are serialized and only the newest waiting place is sent', async () => {
  const sent = [];
  const replies = [];
  let clock = 0;
  const sync = createBookmarkSync({
    local: memoryLocal(),
    now: () => clock,
    send: (id, body) => { sent.push(body); const d = deferred(); replies.push(d); return d.promise; },
  });
  sync.seed(1, { bookmark: null, version: 3 });
  const at = offset => makeBookmark(manifest(), 0, offset);

  sync.checkpoint(1, at(1), { flush: true });
  sync.checkpoint(1, at(2), { flush: true });
  sync.checkpoint(1, at(3), { flush: true });
  await tick();
  assert.equal(sent.length, 1, 'one write in flight at a time');
  assert.equal(sent[0].expected_version, 3);

  replies[0].resolve({ version: 4, bookmark: at(1) });
  await tick();
  sync.flush(1);
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].bookmark.offset_seconds, 3, 'the middle place was never sent');
  assert.equal(sent[1].expected_version, 4);
  replies[1].resolve({ version: 5, bookmark: at(3) });
  await tick();
  assert.equal(sync.view(1).pending, false);
  assert.equal(sync.view(1).version, 5);
});

test('ordinary playback writes coalesce to the interval', async () => {
  const sent = [];
  let clock = 0;
  const sync = createBookmarkSync({
    local: memoryLocal(),
    now: () => clock,
    interval: 5000,
    send: (_id, body) => { sent.push(body); return Promise.resolve({ version: sent.length, bookmark: body.bookmark }); },
  });
  sync.seed(1, { bookmark: null, version: 0 });
  clock = 6000;
  sync.checkpoint(1, makeBookmark(manifest(), 0, 1));
  await tick();
  clock = 8000;
  sync.checkpoint(1, makeBookmark(manifest(), 0, 3));
  await tick();
  assert.equal(sent.length, 1);
  clock = 11_500;
  sync.checkpoint(1, makeBookmark(manifest(), 0, 6));
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].bookmark.offset_seconds, 6);
});

test('a 409 keeps the local place and hands the choice to the reader', async () => {
  const local = memoryLocal();
  const theirs = makeBookmark(manifest(), 3, 1);
  let fail = true;
  const sent = [];
  const sync = createBookmarkSync({
    local,
    now: () => 0,
    send: (_id, body) => {
      sent.push(body);
      if (fail) {
        fail = false;
        return Promise.reject(Object.assign(new Error('conflict'), { status: 409, data: { bookmark: theirs, version: 9 } }));
      }
      return Promise.resolve({ version: 10, bookmark: body.bookmark });
    },
  });
  sync.seed(1, { bookmark: null, version: 2 });
  const mine = makeBookmark(manifest(), 1, 4);
  sync.checkpoint(1, mine, { flush: true });
  await tick();
  const view = sync.view(1);
  assert.equal(view.pending, true);
  assert.equal(view.conflict.version, 9);
  assert.equal(local.data.get(1).pending, true, 'still held on this device');

  // no automatic retry while the conflict stands
  sync.checkpoint(1, makeBookmark(manifest(), 1, 5), { flush: true });
  await tick();
  assert.equal(sent.length, 1);

  sync.resolve(1, 'mine');
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].expected_version, 9, 'a fresh update against the current version');
  assert.equal(sync.view(1).conflict, null);
});

test('taking the saved place drops this device\'s pending one', async () => {
  const theirs = makeBookmark(manifest(), 3, 1);
  const sync = createBookmarkSync({
    local: memoryLocal(),
    now: () => 0,
    send: () => Promise.reject(Object.assign(new Error('conflict'), { status: 409, data: { bookmark: theirs, version: 9 } })),
  });
  sync.seed(1, { bookmark: null, version: 2 });
  sync.checkpoint(1, makeBookmark(manifest(), 1, 4), { flush: true });
  await tick();
  sync.resolve(1, 'theirs');
  assert.equal(sync.view(1).pending, false);
  assert.equal(sync.view(1).bookmark.segment_id, 'b4.0');
});

test('reopening prefers a local unsent place, and recognises its own landed keepalive', () => {
  const local = memoryLocal();
  const mine = makeBookmark(manifest(), 2, 4);
  local.save(1, { bookmark: mine, version: 5, pending: true });

  const offline = createBookmarkSync({ local, send: () => Promise.reject(new Error('offline')) });
  assert.equal(offline.seed(1, { bookmark: makeBookmark(manifest(), 0, 1), version: 5 }).bookmark.segment_id, 'b2.1');

  const landed = createBookmarkSync({ local, send: () => Promise.reject(new Error('offline')) });
  const view = landed.seed(1, { bookmark: mine, version: 6 });
  assert.equal(view.pending, false);
  assert.equal(view.conflict, null);
  assert.equal(view.version, 6);
});

test('another device moving the bookmark while this one was away is a conflict', () => {
  const local = memoryLocal();
  local.save(1, { bookmark: makeBookmark(manifest(), 2, 4), version: 5, pending: true });
  const sync = createBookmarkSync({ local, send: () => Promise.reject(new Error('offline')) });
  const view = sync.seed(1, { bookmark: makeBookmark(manifest(), 3, 1), version: 7 });
  assert.equal(view.pending, true);
  assert.equal(view.conflict.version, 7);
});

test('storage that throws never breaks a checkpoint', () => {
  const sync = createBookmarkSync({
    local: { load: () => { throw new Error('denied'); }, save: () => { throw new Error('full'); }, remove() {} },
    send: () => Promise.resolve({ version: 1 }),
  });
  assert.doesNotThrow(() => sync.checkpoint(1, makeBookmark(manifest(), 0, 1), { flush: true }));
});
