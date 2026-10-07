import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../server/narration-queue.js';
import {
  withProviderRetry, errorForStatus, parseRetryAfter, ProviderError,
} from '../server/narration-retry.js';
import { parseRange } from '../server/http-range.js';
import { createVoiceCatalogue } from '../server/voice-catalogue.js';
import { appendSilence, validateMp3, mp3Duration } from '../server/tts.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/* Work that waits for the test to finish it, and notices being aborted. */
function work(log, name) {
  const d = deferred();
  const run = (signal) => {
    log.push(`start ${name}`);
    signal.addEventListener('abort', () => { log.push(`abort ${name}`); d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    return d.promise;
  };
  return { run, ...d };
}

// ── scheduler ────────────────────────────────────────────────────────────────

test('a second request for the same passage joins the first', async () => {
  const s = createScheduler({ concurrency: 2 });
  const log = [];
  const a = work(log, 'a');
  const first = s.request('k', { consumer: 1, run: a.run, priority: 'foreground' });
  const second = s.request('k', { consumer: 2, run: work(log, 'dup').run, priority: 'foreground' });
  a.resolve('bytes');
  assert.equal(await first, 'bytes');
  assert.equal(await second, 'bytes');
  assert.deepEqual(log, ['start a']);
  assert.equal(s.stats().joined, 1);
});

test('one slot is always left for a reader who is waiting', async () => {
  const s = createScheduler({ concurrency: 4 });
  const log = [];
  const specs = ['s1', 's2', 's3', 's4', 's5'].map(name => work(log, name));
  specs.forEach((job, i) => s.request(`spec${i}`, { consumer: 'demand', run: job.run }).catch(() => {}));
  await tick();
  assert.equal(s.snapshot().running, 3, 'prefetch caps at concurrency − 1');
  const fg = work(log, 'fg');
  s.request('fg', { consumer: 'req', run: fg.run, priority: 'foreground' });
  await tick();
  assert.ok(log.includes('start fg'), 'the waiting reader starts at once');
  assert.equal(s.snapshot().running, 4);
});

test('joining queued prefetch moves that actual job ahead', async () => {
  const s = createScheduler({ concurrency: 2 });
  const log = [];
  const jobs = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [name, work(log, name)]));
  s.request('a', { consumer: 'x', run: jobs.a.run, priority: 'foreground' });
  s.request('b', { consumer: 'x', run: jobs.b.run, priority: 'foreground' });
  s.request('c', { consumer: 'demand', run: jobs.c.run }).catch(() => {});
  s.request('d', { consumer: 'demand', run: jobs.d.run }).catch(() => {});
  await tick();
  assert.deepEqual(log, ['start a', 'start b']);
  // the player reaches passage d: the same job is promoted, not a copy started
  s.request('d', { consumer: 'req', run: work(log, 'copy').run, priority: 'foreground' });
  jobs.a.resolve(1);
  await tick();
  assert.deepEqual(log, ['start a', 'start b', 'start d']);
  assert.equal(s.stats().promoted, 1);
});

test('equal priorities run first come, first served', async () => {
  const s = createScheduler({ concurrency: 1 });
  const log = [];
  const jobs = ['one', 'two', 'three'].map(name => work(log, name));
  jobs.forEach((job, i) => s.request(`k${i}`, { consumer: 'x', run: job.run, priority: 'foreground' }));
  for (const job of jobs) { await tick(); job.resolve(); }
  await tick();
  assert.deepEqual(log, ['start one', 'start two', 'start three']);
});

test('a queued job nobody wants is removed; a running one is aborted', async () => {
  const s = createScheduler({ concurrency: 2 });
  const log = [];
  const a = work(log, 'a');
  const b = work(log, 'b');
  const c = work(log, 'c');
  const pa = s.request('a', { consumer: 'x', run: a.run, priority: 'foreground' });
  s.request('b', { consumer: 'x', run: b.run, priority: 'foreground' });
  const pc = s.request('c', { consumer: 'x', run: c.run, priority: 'foreground' });
  await tick();
  s.release('c', 'x');
  await assert.rejects(pc, { code: 'cancelled' });
  s.release('a', 'x');
  await assert.rejects(pa, { code: 'cancelled' });
  await tick();
  assert.ok(log.includes('abort a'));
  assert.ok(!log.includes('start c'), 'the queued job never started');
  assert.equal(s.snapshot().running, 1, 'the aborted job gave its slot back');
});

test('another consumer keeps a shared job alive', async () => {
  const s = createScheduler({ concurrency: 1 });
  const log = [];
  const a = work(log, 'a');
  const p = s.request('a', { consumer: 'tab1', run: a.run, priority: 'foreground' });
  s.request('a', { consumer: 'tab2', run: a.run, priority: 'foreground' });
  await tick();
  s.release('a', 'tab1');
  await tick();
  assert.ok(!log.includes('abort a'));
  a.resolve('ok');
  assert.equal(await p, 'ok');
});

test('with a single slot, a waiting reader preempts prefetch, which runs again later', async () => {
  const s = createScheduler({ concurrency: 1 });
  const log = [];
  let attempts = 0;
  const spec = deferred();
  const specRun = (signal) => {
    attempts += 1;
    log.push(`start spec#${attempts}`);
    signal.addEventListener('abort', () => spec.reject(new Error('preempted')));
    return attempts === 1 ? spec.promise : Promise.resolve('spec done');
  };
  const pspec = s.request('spec', { consumer: 'demand', run: specRun });
  await tick();
  const fg = work(log, 'fg');
  s.request('fg', { consumer: 'req', run: fg.run, priority: 'foreground' });
  await tick();
  assert.deepEqual(log, ['start spec#1', 'start fg']);
  assert.equal(s.snapshot().running, 1, 'exactly one slot in use');
  fg.resolve();
  await tick();
  assert.equal(await pspec, 'spec done');
  assert.equal(s.stats().preempted, 1);
  assert.equal(s.snapshot().running, 0);
});

test('every way a job ends returns its slot exactly once', async () => {
  const s = createScheduler({ concurrency: 2 });
  const log = [];
  const ok = work(log, 'ok');
  const bad = work(log, 'bad');
  const gone = work(log, 'gone');
  s.request('ok', { consumer: 'x', run: ok.run, priority: 'foreground' });
  s.request('bad', { consumer: 'x', run: bad.run, priority: 'foreground' }).catch(() => {});
  s.request('gone', { consumer: 'x', run: gone.run, priority: 'foreground' }).catch(() => {});
  await tick();
  ok.resolve();
  bad.reject(new Error('nope'));
  await tick();
  s.cancelWhere(job => job.key === 'gone');
  await tick();
  assert.equal(s.snapshot().running, 0);
  assert.equal(s.snapshot().queued, 0);
  assert.equal(s.snapshot().jobs.length, 0);
});

// ── provider retry ───────────────────────────────────────────────────────────

const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    timer: () => () => {},
    advance: (ms) => { t += ms; },
  };
};

test('permanent failures get exactly one attempt', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const clock = fakeClock();
    await assert.rejects(withProviderRetry(async () => { calls += 1; throw errorForStatus(status, { voiceId: 'v' }); }, clock));
    assert.equal(calls, 1, `HTTP ${status} retried`);
  }
});

test('auth and missing-voice failures are named, not retried, and say nothing from the body', () => {
  assert.equal(errorForStatus(401).code, 'provider_auth');
  assert.equal(errorForStatus(404, { voiceId: 'v' }).code, 'voice_unavailable');
  assert.equal(errorForStatus(400, { voiceId: 'v', hint: 'reference_id not found' }).code, 'voice_unavailable');
  const rejected = errorForStatus(400, { voiceId: 'v', hint: 'text too long sk-secret-token' });
  assert.equal(rejected.code, 'provider_rejected');
  assert.doesNotMatch(rejected.message, /secret/);
  assert.equal(errorForStatus(503).retryable, true);
  assert.equal(errorForStatus(429).code, 'rate_limited');
});

test('transient failures retry within the attempt limit', async () => {
  let calls = 0;
  const clock = fakeClock();
  const result = await withProviderRetry(async () => {
    calls += 1;
    if (calls < 3) throw errorForStatus(503);
    return 'audio';
  }, { ...clock, random: () => 0.5 });
  assert.equal(result, 'audio');
  assert.equal(calls, 3);
});

test('Retry-After is honoured, as seconds or as a date', async () => {
  assert.equal(parseRetryAfter('7', 0), 7000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(parseRetryAfter('soon', 0), null);

  const waits = [];
  let calls = 0;
  const clock = fakeClock();
  await withProviderRetry(async () => {
    calls += 1;
    if (calls === 1) throw errorForStatus(429, { retryAfter: '3' });
    return 'ok';
  }, { ...clock, sleep: async (ms) => { waits.push(ms); clock.advance(ms); } });
  assert.deepEqual(waits, [3000]);
});

test('a Retry-After past the deadline comes back as a retryable failure with the wait', async () => {
  let calls = 0;
  const clock = fakeClock();
  const error = await withProviderRetry(async () => {
    calls += 1;
    throw errorForStatus(429, { retryAfter: '600' });
  }, { ...clock, totalTimeoutMs: 90_000 }).catch(e => e);
  assert.equal(calls, 1);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 600_000);
});

test('a body that dies halfway is retried like any other failure', async () => {
  let calls = 0;
  const clock = fakeClock();
  const result = await withProviderRetry(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('terminated');   // what undici throws when a body read is cut off
    return 'complete';
  }, { ...clock, random: () => 0 });
  assert.equal(result, 'complete');
});

test('cancellation is never retried and stops a wait', async () => {
  const controller = new AbortController();
  let calls = 0;
  const error = await withProviderRetry(async () => {
    calls += 1;
    controller.abort();
    throw errorForStatus(503);
  }, { signal: controller.signal, ...fakeClock() }).catch(e => e);
  assert.equal(calls, 1);
  assert.equal(error.code, 'cancelled');
});

test('the per-attempt timeout aborts the attempt and counts as provider_timeout', async () => {
  let fire;
  let calls = 0;
  const error = await withProviderRetry((signal) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      queueMicrotask(() => fire());
    });
  }, {
    attempts: 1,
    now: () => 0,
    sleep: async () => {},
    timer: (_ms, callback) => { fire = callback; return () => {}; },
  }).catch(e => e);
  assert.equal(calls, 1);
  assert.equal(error.code, 'provider_timeout');
  assert.ok(error instanceof ProviderError);
});

test('nothing outlives the overall deadline', async () => {
  let calls = 0;
  const clock = fakeClock();
  const error = await withProviderRetry(async () => {
    calls += 1;
    clock.advance(50_000);
    throw errorForStatus(503);
  }, { ...clock, totalTimeoutMs: 90_000, attempts: 5, random: () => 0 }).catch(e => e);
  assert.ok(calls <= 2, `attempted ${calls} times`);
  assert.equal(error.retryable, true);
});

// ── ranges ───────────────────────────────────────────────────────────────────

test('single byte ranges are read as the spec reads them', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { type: 'range', start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { type: 'range', start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { type: 'range', start: 900, end: 999 }, 'the last 100 bytes');
  assert.deepEqual(parseRange('bytes=-5000', 1000), { type: 'range', start: 0, end: 999 }, 'an oversized suffix is the whole thing');
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { type: 'range', start: 900, end: 999 }, 'the last byte is clamped');
  assert.deepEqual(parseRange('bytes=0-0', 1000), { type: 'range', start: 0, end: 0 });
});

test('unsatisfiable, empty and malformed ranges', () => {
  assert.deepEqual(parseRange('bytes=1000-', 1000), { type: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', 1000), { type: 'unsatisfiable' });
  assert.deepEqual(parseRange('', 1000), { type: 'none' });
  assert.deepEqual(parseRange(undefined, 1000), { type: 'none' });
  assert.deepEqual(parseRange('bytes=-', 1000), { type: 'none' });
  assert.deepEqual(parseRange('bytes=9-3', 1000), { type: 'none' });
  assert.deepEqual(parseRange('items=0-5', 1000), { type: 'none' });
  assert.deepEqual(parseRange('bytes=abc', 1000), { type: 'none' });
  assert.deepEqual(parseRange('bytes=0-5,10-20', 1000), { type: 'none' }, 'several ranges get the whole body');
});

// ── catalogue ────────────────────────────────────────────────────────────────

const voice = id => ({ id, title: id, tags: ['narration'] });

test('a cold catalogue is fetched once; a fresh one is not fetched again', async () => {
  let fetched = 0;
  const catalogue = createVoiceCatalogue({
    fetchPages: () => { fetched += 1; return [Promise.resolve([voice('a')]), Promise.resolve([voice('b')])]; },
    now: () => 1000,
  });
  const first = await catalogue.get('en');
  assert.deepEqual(first.voices.map(v => v.id), ['a', 'b']);
  assert.equal(first.stale, false);
  await catalogue.get('en');
  assert.equal(fetched, 1);
});

test('one failing page keeps the voices it had last time', async () => {
  let round = 0;
  let t = 0;
  const saved = [];
  const catalogue = createVoiceCatalogue({
    fetchPages: () => {
      round += 1;
      return round === 1
        ? [Promise.resolve([voice('a')]), Promise.resolve([voice('b')])]
        : [Promise.resolve([voice('a'), voice('c')]), Promise.reject(Object.assign(new Error('down'), { code: 'network' }))];
    },
    save: (_lang, voices) => saved.push(voices.map(v => v.id)),
    now: () => t,
  });
  await catalogue.get('en');
  t += 2 * 60 * 60 * 1000;
  await catalogue.refresh('en');
  const view = await catalogue.get('en', { wait: 0 });
  assert.deepEqual(view.voices.map(v => v.id).sort(), ['a', 'b', 'c']);
  assert.equal(view.error_code, 'partial');
  assert.equal(saved.length, 2);
});

test('a refresh where every page fails is an error, not an empty catalogue', async () => {
  const catalogue = createVoiceCatalogue({
    fetchPages: () => [Promise.reject(Object.assign(new Error('401'), { code: 'provider_auth' }))],
    load: () => ({ fetched_at: new Date(0).toISOString(), voices: [voice('kept')] }),
    now: () => 10 * 60 * 60 * 1000,
  });
  const view = await catalogue.get('en');   // stale: answered at once from the saved copy
  assert.deepEqual(view.voices.map(v => v.id), ['kept']);
  assert.equal(view.stale, true);
  await catalogue.refresh('en');
  const after = await catalogue.get('en', { wait: 0 });
  assert.deepEqual(after.voices.map(v => v.id), ['kept']);
  assert.equal(after.error_code, 'provider_auth');
});

test('the picker waits at most its budget for a cold catalogue', async () => {
  const never = new Promise(() => {});
  const catalogue = createVoiceCatalogue({ fetchPages: () => [never], waitMs: 30 });
  const started = Date.now();
  const view = await catalogue.get('en');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(view.voices, []);
  assert.equal(view.refreshing, true);
});

test('after a failure the catalogue waits a minute before asking again', async () => {
  let fetched = 0;
  let t = 0;
  const catalogue = createVoiceCatalogue({
    fetchPages: () => { fetched += 1; return [Promise.reject(new Error('down'))]; },
    now: () => t,
  });
  await catalogue.get('en');
  await catalogue.get('en');
  assert.equal(fetched, 1);
  t += 61_000;
  await catalogue.get('en');
  assert.equal(fetched, 2);
});

// ── mp3 ──────────────────────────────────────────────────────────────────────

/* A hand-built MPEG-1 Layer III stream: an Info frame, then audio frames. */
function mp3Fixture(frames = 20) {
  const header = Buffer.from([0xff, 0xfb, 0x50, 0xc4]);   // 64 kbps, 44.1 kHz, mono, no CRC
  const length = Math.floor((144 * 64000) / 44100);
  const info = Buffer.alloc(length);
  header.copy(info, 0);
  info.write('Info', 4 + 17, 'latin1');
  info.writeUInt32BE(0x3, 4 + 17 + 4);                     // frames and bytes present
  info.writeUInt32BE(frames + 1, 4 + 17 + 8);
  info.writeUInt32BE(length * (frames + 1), 4 + 17 + 12);
  const body = Buffer.alloc(length * frames, 0x55);
  for (let i = 0; i < frames; i++) header.copy(body, i * length);
  return { buffer: Buffer.concat([info, body]), length };
}

test('silence after a passage is whole frames, and the Info frame counts them', () => {
  const { buffer, length } = mp3Fixture();
  assert.equal(validateMp3(buffer), true);
  const padded = appendSilence(buffer, 520);
  const added = (padded.length - buffer.length) / length;
  assert.equal(added, Math.round(0.52 / (1152 / 44100)));
  assert.equal(padded.readUInt32BE(4 + 17 + 8), 21 + added);
  assert.equal(padded.readUInt32BE(4 + 17 + 12), length * 21 + added * length);
  assert.ok(mp3Duration(padded, 64) > mp3Duration(buffer, 64));
  // each added frame is a header with nothing after it
  const last = padded.subarray(padded.length - length);
  assert.deepEqual([...last.subarray(0, 4)], [0xff, 0xfb, 0x50, 0xc4]);
  assert.ok(last.subarray(4).every(byte => byte === 0));
});

test('bytes that are not an mp3 are refused', () => {
  assert.equal(validateMp3(Buffer.from('<html>login</html>'.repeat(10))), false);
  assert.equal(validateMp3(Buffer.alloc(0)), false);
  assert.equal(validateMp3(Buffer.from(JSON.stringify({ error: 'x' }).repeat(10))), false);
});
