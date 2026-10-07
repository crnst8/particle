#!/usr/bin/env node
// Narration integration harness: a real particle server on a scratch SQLite
// file, talking to a fake text-to-speech provider whose failures are scripted.
// It exists for what node:test deliberately does not cover — HTTP, SQLite and
// the provider together — and never touches the real library.
//
//   node tools/narration-harness.mjs check     run the scripted scenarios, print a report
//   node tools/narration-harness.mjs migrate   build v1/v2/v3 libraries and migrate copies of them
//   node tools/narration-harness.mjs serve     leave a scratch server running for a browser
//
// Needs ffmpeg on PATH (the fake provider makes real mp3s with it). Costs
// nothing: no request leaves the machine.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DB = resolve(ROOT, 'data', 'particle.db');

// ── safety ───────────────────────────────────────────────────────────────────
function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'particle-narration-'));
  return dir;
}

/* The harness writes, edits and deletes freely. It only ever does that to a
   database it created itself, inside the system temp directory. */
function assertScratch(path) {
  const full = resolve(path);
  if (full === REAL_DB || full.startsWith(resolve(ROOT, 'data'))) throw new Error(`refusing to use the real library: ${full}`);
  if (!full.startsWith(resolve(tmpdir())) && !full.startsWith('/private' + resolve(tmpdir()))) {
    throw new Error(`refusing a database outside the temp directory: ${full}`);
  }
  return full;
}

// ── the fake provider ────────────────────────────────────────────────────────
export function startFakeProvider({ port = 0 } = {}) {
  const state = {
    mode: 'ok',            // ok | 401 | 403 | 404 | 503xN | 429 | hang | cut | slow
    failuresLeft: 0,
    delayMs: 0,
    retryAfter: null,
    catalogue: 'ok',       // ok | down | slow
    requests: [],          // { voice, text, at }
    inflight: 0,
    maxInflight: 0,
    aborted: 0,
  };
  const audioCache = new Map();

  function mp3For(voice, seconds) {
    const key = `${voice}:${seconds}`;
    if (!audioCache.has(key)) {
      const frequency = 220 + (hash(voice || 'default') % 6) * 110;
      const out = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`,
        '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
      audioCache.set(key, out);
    }
    return audioCache.get(key);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__control') {
      const body = JSON.parse(await read(req) || '{}');
      Object.assign(state, body);
      if (/^\d{3}x\d+$/.test(state.mode)) state.failuresLeft = Number(state.mode.split('x')[1]);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__stats') return json(res, 200, { ...state, requests: state.requests.length, texts: state.requests.map(r => r.text.slice(0, 40)) });
    if (url.pathname === '/__reset') {
      Object.assign(state, { mode: 'ok', failuresLeft: 0, delayMs: 0, retryAfter: null, catalogue: 'ok', requests: [], inflight: 0, maxInflight: 0, aborted: 0 });
      return json(res, 200, { ok: true });
    }

    if (req.headers.authorization !== 'Bearer fake-key') return json(res, 401, { message: 'invalid api key' });

    if (url.pathname === '/model') {
      if (state.catalogue === 'down') return json(res, 503, { message: 'down' });
      if (state.catalogue === 'slow') await sleep(8000);
      const tag = url.searchParams.get('tag') || 'general';
      const items = ['Calm Reader', 'Warm Narrator', 'Clear Teacher'].map((title, i) => ({
        _id: `voice-${tag}-${i}`.replace('voice-general', 'voice-any'),
        title: `${title} ${tag}`,
        description: 'a test voice',
        tags: ['narration', 'calm', 'clear', 'measured'],
        languages: ['en'],
        task_count: 100 * (i + 1),
        samples: [{ audio: 'https://example.com/sample.mp3' }],
        state: 'trained',
        visibility: 'public',
      }));
      return json(res, 200, { items });
    }

    if (url.pathname === '/v1/tts' && req.method === 'POST') {
      const body = JSON.parse(await read(req) || '{}');
      const voice = body.reference_id || 'default';
      state.requests.push({ voice, text: String(body.text || ''), at: Date.now() });
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      let closed = false;
      res.on('close', () => { if (!res.writableFinished) { closed = true; state.aborted += 1; } state.inflight -= 1; });

      if (voice === 'missing-voice') return json(res, 404, { message: 'reference not found' });
      if (state.delayMs) await sleep(state.delayMs);
      if (closed) return;
      const failing = /^\d{3}x\d+$/.test(state.mode) && state.failuresLeft > 0;
      if (failing) {
        state.failuresLeft -= 1;
        return json(res, Number(state.mode.slice(0, 3)), { message: 'scripted failure' });
      }
      if (['401', '403', '404', '429'].includes(state.mode)) {
        const headers = state.retryAfter ? { 'Retry-After': String(state.retryAfter) } : {};
        if (state.mode === '429') state.mode = 'ok';   // one 429, then fine
        return json(res, Number(state.mode === 'ok' ? 429 : state.mode), { message: 'scripted failure' }, headers);
      }
      if (state.mode === 'hang') return;   // never answers
      const seconds = Math.max(0.5, Math.min(6, Math.round(String(body.text || '').length / 15 * 2) / 2));
      const audio = mp3For(voice, seconds);
      if (state.mode === 'cut') {
        state.mode = 'ok';                 // cut once
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) });
        res.write(audio.subarray(0, Math.floor(audio.length / 2)));
        return setTimeout(() => res.destroy(), 20);
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length) });
      return res.end(audio);
    }
    json(res, 404, { message: 'no such route' });
  });

  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      done({
        url: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise(r => server.close(r)),
        control: async body => fetch(`http://127.0.0.1:${address.port}/__control`, { method: 'POST', body: JSON.stringify(body) }),
        reset: async () => fetch(`http://127.0.0.1:${address.port}/__reset`),
      });
    });
  });
}

// ── particle on a scratch library ────────────────────────────────────────────
async function startParticle({ dbPath, provider, port, env = {} }) {
  assertScratch(dbPath);
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: dirname(dbPath),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      PARTICLE_DB: dbPath,
      ALLOW_PRIVATE_HOSTS: '1',
      OCR_ENABLED: '0',
      TTS_API_KEY: 'fake-key',
      TTS_API_URL: `${provider.url}/v1/tts`,
      TTS_MODEL_API_URL: `${provider.url}/model`,
      TTS_REQUEST_TIMEOUT_MS: '5000',
      TTS_TOTAL_TIMEOUT_MS: '10000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}${env.PARTICLE_BASE || ''}/api/health`)).ok) break; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`particle exited:\n${output}`);
    await sleep(100);
  }
  return {
    base,
    child,
    output: () => output,
    stop: () => new Promise((done) => { child.once('exit', done); child.kill(); }),
  };
}

// ── scenarios ────────────────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const PARAGRAPH = n => `<p>Paragraph ${n} of the test article has enough words in it to be read as real prose by the extractor, and it carries on a little longer so that it counts.</p>`;
const ARTICLE = count => `<html><head><title>Harness story</title></head><body><article><h1>Harness story</h1>
  <p class="byline">By Test Writer</p>
  ${Array.from({ length: count }, (_, i) => PARAGRAPH(i + 1)).join('\n')}
  <figure><img src="http://127.0.0.1:1/x.jpg"><figcaption>A caption that must never be read.</figcaption></figure>
  </article></body></html>`;

async function check() {
  const dir = scratchDir();
  const dbPath = join(dir, 'particle.db');
  const provider = await startFakeProvider();
  let particle = await startParticle({ dbPath, provider, port: 4790 });
  const call = (path, options = {}) => request(particle.base, path, options);

  try {
    // seed
    const saved = await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-one', html: ARTICLE(6) } });
    const id = saved.json.id;
    record('article saves through extraction on a scratch library', saved.status === 201 && id > 0);
    const second = await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-two', html: ARTICLE(40) } });
    const longId = second.json.id;

    // blocks: no provider traffic at all
    await provider.reset();
    let t = Date.now();
    const blocks = await call(`/api/articles/${id}/narration/blocks`);
    record('the block map needs no provider, catalogue or model', blocks.status === 200 && provider.state.requests.length === 0,
      `${Date.now() - t}ms, ${blocks.json.blocks?.length} blocks`);
    record('captions are mapped as excluded, with a reason', blocks.json.blocks?.some(b => b.skip_reason === 'caption'));

    // settings
    const settings = await call('/api/narration/settings');
    record('settings start with Automatic', settings.json.default_voice_id === null && settings.json.version === 0);
    const set = await call('/api/narration/settings', { method: 'PATCH', body: { default_voice_id: 'voice-A', default_voice_name: 'Voice A', expected_version: 0 } });
    record('the default voice saves without synthesis', set.status === 200 && provider.state.requests.length === 0);
    const stale = await call('/api/narration/settings', { method: 'PATCH', body: { default_voice_id: 'voice-Z', default_voice_name: 'Z', expected_version: 0 } });
    record('a stale settings write is refused with 409', stale.status === 409 && stale.json.code === 'settings_conflict');

    // preparing with the catalogue down and slow
    await provider.control({ catalogue: 'slow' });
    t = Date.now();
    const prepared = await call(`/api/articles/${id}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } });
    const prepareMs = Date.now() - t;
    record('a chosen voice prepares without waiting on the catalogue', prepared.status === 200 && prepareMs < 1000,
      `${prepareMs}ms (budget 250ms server-side, excluding transport)`);
    record('the manifest names the default voice and its source', prepared.json.voice?.id === 'voice-A' && prepared.json.voice?.source === 'default');
    const revA = prepared.json.rev;
    record('no spoken intro or caption in the script', !prepared.json.segments.some(s => s.kind === 'caption' || s.kind === 'intro'));
    await provider.control({ catalogue: 'ok' });

    // exact revisions
    const none = await call(`/api/articles/${id}/narration/0`, { raw: true });
    record('a passage without a revision is refused', none.status === 409 && none.json?.code === 'revision_required');
    const missing = await call(`/api/articles/${id}/narration/0?v=rnothere`, { raw: true });
    record('an unknown revision is 404, never another voice', missing.status === 404 && missing.json?.code === 'revision_missing');

    await provider.reset();
    const a0 = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true });
    record('passage 0 synthesises once on demand', a0.status === 200 && a0.bytes.length > 1000);
    const a0again = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true });
    record('asking again is served from the cache', a0again.status === 200 && provider.state.requests.filter(r => r.voice === 'voice-A').length <= 2,
      `${provider.state.requests.length} provider requests (passage 0 plus warm-ahead)`);
    record('the audio is cached hard and has a validator', /immutable/.test(a0.headers.get('cache-control') || '') && Boolean(a0.headers.get('etag')));

    // ranges
    const tail = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true, headers: { Range: 'bytes=-100' } });
    record('bytes=-100 is the last 100 bytes', tail.status === 206 && Buffer.compare(tail.bytes, a0.bytes.subarray(a0.bytes.length - 100)) === 0,
      tail.headers.get('content-range'));
    const beyond = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true, headers: { Range: `bytes=${a0.bytes.length + 10}-` } });
    record('a range past the end is 416 with the length', beyond.status === 416 && beyond.headers.get('content-range') === `bytes */${a0.bytes.length}`);

    // A → B → A
    const before = provider.state.requests.length;
    const toB = await call(`/api/articles/${id}/narration`, { method: 'POST', body: { voice_override: { id: 'voice-B', name: 'Voice B' }, expected_voice_version: 0, start: { mode: 'beginning' } } });
    record('choosing B for this article makes a new revision', toB.status === 200 && toB.json.rev !== revA && toB.json.voice.source === 'article');
    const b0 = await call(`/api/articles/${id}/narration/0?v=${toB.json.rev}`, { raw: true });
    const staleA = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true });
    record('the old URL still serves A, never B', staleA.status === 200 && Buffer.compare(staleA.bytes, a0.bytes) === 0 && Buffer.compare(b0.bytes, a0.bytes) !== 0);
    const conflict = await call(`/api/articles/${id}/narration`, { method: 'POST', body: { voice_override: { id: 'voice-C', name: 'C' }, expected_voice_version: 0 } });
    record('an override on a stale version is refused, not applied', conflict.status === 409 && conflict.json.code === 'voice_conflict');
    const backToA = await call(`/api/articles/${id}/narration`, { method: 'POST', body: { voice_override: null, expected_voice_version: toB.json.voice_version, start: { mode: 'beginning' } } });
    await sleep(300);
    const countBefore = provider.state.requests.filter(r => r.voice === 'voice-A').length;
    const a0third = await call(`/api/articles/${id}/narration/0?v=${backToA.json.rev}`, { raw: true });
    record('A → B → A reuses the same revision and its bytes', backToA.json.rev === revA && Buffer.compare(a0third.bytes, a0.bytes) === 0
      && provider.state.requests.filter(r => r.voice === 'voice-A').length === countBefore, `${provider.state.requests.length - before} provider requests across the switch`);

    // bookmarks
    const segs = prepared.json.segments;
    const mark = { v: 1, content_revision: prepared.json.content_revision, script_id: prepared.json.script_id, rev: revA, block_id: segs[2].block_id, segment_id: segs[2].id, offset_seconds: 1.5, completed: false };
    const put = await call(`/api/articles/${id}/narration/position`, { method: 'PUT', body: { bookmark: mark, expected_version: 0 } });
    record('a bookmark saves against its version', put.status === 200 && put.json.version === 1);
    const putStale = await call(`/api/articles/${id}/narration/position`, { method: 'PUT', body: { bookmark: { ...mark, offset_seconds: 0.2 }, expected_version: 0 } });
    record('an older device\'s write is refused and told the latest', putStale.status === 409 && putStale.json.bookmark?.offset_seconds === 1.5);
    const bogus = await call(`/api/articles/${id}/narration/position`, { method: 'PUT', body: { bookmark: { ...mark, segment_id: 'bnope-0.0' }, expected_version: 1 } });
    record('a bookmark naming a passage that does not exist is refused', bogus.status === 422);
    const resumed = await call(`/api/articles/${id}/narration`, { method: 'POST', body: { start: { mode: 'resume' } } });
    record('resume starts at the saved passage and offset', resumed.json.start?.seq === 2 && resumed.json.start?.offset === 1.5 && resumed.json.start?.mode === 'exact');

    // demand window and warm position
    await provider.reset();
    const fresh = await call(`/api/articles/${longId}/narration`, { method: 'POST', body: { start: { mode: 'block', block_id: (await call(`/api/articles/${longId}/narration/blocks`)).json.blocks.filter(b => !b.skip_reason)[20].id }, session_id: 'harness-1', generation: 1 } });
    await sleep(1500);
    const texts = provider.state.requests.map(r => r.text);
    record('a mid-article start warms from there, never from the top', fresh.json.start.seq >= 20 && texts.length > 0 && !texts.some(text => /Paragraph [1-9]\b/.test(text) && !/Paragraph (19|2\d|3\d|40)/.test(text)),
      `start ${fresh.json.start.seq}; warmed: ${texts.map(text => text.match(/Paragraph \d+/)?.[0]).join(', ')}`);
    const diag = await call('/api/narration/diagnostics');
    record('speculative work leaves a slot free', diag.json.queue.speculative <= 3, `running ${diag.json.queue.running}, speculative ${diag.json.queue.speculative}`);
    await call(`/api/articles/${longId}/narration/demand`, { method: 'POST', body: { session_id: 'harness-1', generation: 2, rev: fresh.json.rev, seq: 0, release: true } });

    // failures
    const article3 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-three', html: ARTICLE(4) } })).json.id;
    const prep3 = (await call(`/api/articles/${article3}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    const failCase = async (mode, expect, extra = {}) => {
      await provider.reset();
      await provider.control({ mode, ...extra });
      const seq = failCase.seq++;
      const started = Date.now();
      const answer = await call(`/api/articles/${article3}/narration/${seq}?v=${prep3.rev}`, { raw: true });
      return { answer, ms: Date.now() - started, attempts: provider.state.requests.length, expect };
    };
    failCase.seq = 0;
    let r = await failCase('401');
    record('401: one attempt, provider_auth, no fallback voice', r.answer.status >= 400 && r.answer.json?.code === 'provider_auth' && r.attempts === 1, `${r.attempts} attempt(s), ${r.ms}ms`);
    r = await failCase('503x2');
    record('503 twice then fine: retried within the limit', r.answer.status === 200 && r.attempts === 3, `${r.attempts} attempts, ${r.ms}ms`);
    r = await failCase('429', null, { retryAfter: 1 });
    record('429 with Retry-After: waits, then succeeds', r.answer.status === 200 && r.ms >= 900, `${r.attempts} attempts, ${r.ms}ms`);
    r = await failCase('cut');
    record('a body cut off halfway is discarded and retried', r.answer.status === 200 && r.attempts === 2, `${r.attempts} attempts`);

    // an invalid chosen voice
    await provider.reset();
    const art4 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-four', html: ARTICLE(3) } })).json.id;
    const prep4 = (await call(`/api/articles/${art4}/narration`, { method: 'POST', body: { voice_override: { id: 'missing-voice', name: 'Gone' }, expected_voice_version: 0, start: { mode: 'beginning' } } })).json;
    await sleep(200);
    await provider.reset();
    const gone = await call(`/api/articles/${art4}/narration/0?v=${prep4.rev}`, { raw: true });
    record('a voice the provider does not have: voice_unavailable, one attempt, no substitute',
      gone.json?.code === 'voice_unavailable' && provider.state.requests.length === 1 && provider.state.requests[0].voice === 'missing-voice');

    // hang until the deadline
    await provider.reset();
    await provider.control({ mode: 'hang' });
    const art5 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-five', html: ARTICLE(2) } })).json.id;
    const prep5 = (await call(`/api/articles/${art5}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    t = Date.now();
    const hung = await call(`/api/articles/${art5}/narration/0?v=${prep5.rev}`, { raw: true });
    const hungMs = Date.now() - t;
    record('a provider that never answers ends at the deadline', hung.json?.code === 'provider_timeout' && hungMs < 12_000, `${hungMs}ms, ${provider.state.requests.length} attempts`);

    // cancellation by disconnect
    await provider.reset();
    await provider.control({ mode: 'ok', delayMs: 3000 });
    const art6 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-six', html: ARTICLE(2) } })).json.id;
    const prep6 = (await call(`/api/articles/${art6}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    await call(`/api/articles/${art6}/narration/demand`, { method: 'POST', body: { session_id: 'none', release: true, rev: prep6.rev } }).catch(() => {});
    await sleep(100);
    const controller = new AbortController();
    const pending = fetch(`${particle.base}/api/articles/${art6}/narration/1?v=${prep6.rev}`, { signal: controller.signal }).catch(() => null);
    await sleep(400);
    controller.abort();
    await pending;
    await sleep(3500);
    const afterCancel = await call('/api/narration/diagnostics');
    record('a passage nobody waits for any more is abandoned and its slot returned',
      afterCancel.json.queue.running === 0 && afterCancel.json.queue.jobs.length === 0 && (afterCancel.json.counts.cancelled || 0) >= 1,
      `running ${afterCancel.json.queue.running}, cancelled ${afterCancel.json.counts.cancelled || 0}, provider saw ${provider.state.aborted} aborted`);

    // an edit while a passage is being synthesised
    await provider.reset();
    await provider.control({ delayMs: 1500 });
    const art7 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-seven', html: ARTICLE(3) } })).json.id;
    const prep7 = (await call(`/api/articles/${art7}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    const inFlight = call(`/api/articles/${art7}/narration/2?v=${prep7.rev}`, { raw: true });
    await sleep(300);
    const body7 = (await call(`/api/articles/${art7}`)).json.content_html.replace('Paragraph 1 ', 'Paragraph one, edited, ');
    await call(`/api/articles/${art7}`, { method: 'PATCH', body: { content_html: body7 } });
    const edited = await inFlight;
    const afterEdit = await call(`/api/articles/${art7}/narration/2?v=${prep7.rev}`, { raw: true });
    record('an edit mid-synthesis stops the passage and nothing stale is kept', edited.json?.code === 'content_changed' && afterEdit.json?.code === 'content_changed');
    await provider.control({ delayMs: 0 });

    // a skip mark is not a trim
    const art8 = (await call('/api/articles', { method: 'POST', body: { url: 'http://127.0.0.1:1/story-eight', html: ARTICLE(3) } })).json.id;
    const marked = (await call(`/api/articles/${art8}`)).json.content_html.replace('<p>Paragraph 2', '<p data-particle-speech="exclude">Paragraph 2').trim();
    const patched = await call(`/api/articles/${art8}`, { method: 'PATCH', body: { content_html: marked } });
    const after8 = (await call(`/api/articles/${art8}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    record('"skip when reading aloud" survives the sanitiser, changes the script, and is not a trim',
      /data-particle-speech="exclude"/.test(patched.json.content_html) && after8.blocks.some(b => b.skip_reason === 'manual')
      && patched.json.edited_at === null);

    // discard
    const dropped = await call(`/api/articles/${id}/narration`, { method: 'DELETE' });
    const afterDrop = await call(`/api/articles/${id}`);
    const oldUrl = await call(`/api/articles/${id}/narration/0?v=${revA}`, { raw: true });
    record('discarding narration clears variants and the bookmark, keeps the voice choice',
      dropped.status === 200 && afterDrop.json.audio_bookmark === null && oldUrl.json?.code === 'revision_missing');

    // a long article under a small cache ceiling
    await particle.stop();
    particle = await startParticle({ dbPath, provider, port: 4790, env: { TTS_MAX_CACHE_MB: '1' } });
    await provider.reset();
    const longPrep = (await call(`/api/articles/${longId}/narration`, { method: 'POST', body: { start: { mode: 'beginning' } } })).json;
    for (let seq = 0; seq < Math.min(longPrep.segments.length, 40); seq++) {
      await call(`/api/articles/${longId}/narration/${seq}?v=${longPrep.rev}`, { raw: true });
    }
    const cache = (await call('/api/narration/diagnostics')).json;
    record('the byte ceiling holds for a very long active article', cache.cache_bytes <= 1024 * 1024,
      `${(cache.cache_bytes / 1024).toFixed(0)} KiB of 1024 KiB`);

    // the default survives a restart
    record('the default voice survived a server restart', (await call('/api/narration/settings')).json.default_voice_id === 'voice-A');

    // the operator's lock
    await particle.stop();
    particle = await startParticle({ dbPath, provider, port: 4790, env: { TTS_VOICE_ID: 'voice-locked', TTS_VOICE_LOCK: '1' } });
    const locked = await call('/api/narration/settings');
    const lockPatch = await call('/api/narration/settings', { method: 'PATCH', body: { default_voice_id: 'voice-X', expected_version: locked.json.version } });
    const lockOverride = await call(`/api/articles/${art4}/narration`, { method: 'POST', body: { voice_override: { id: 'voice-X', name: 'X' }, expected_voice_version: prep4.voice_version } });
    const lockPrep = await call(`/api/articles/${art4}/narration`, { method: 'POST', body: {} });
    record('a lock shows, refuses contradictory changes, and wins over article choices',
      locked.json.locked && lockPatch.status === 409 && lockOverride.status === 409 && lockPrep.json.voice?.id === 'voice-locked' && lockPrep.json.voice?.source === 'locked');

    // automatic, frozen per script
    await particle.stop();
    const db = new DatabaseSync(assertScratch(dbPath));
    db.exec("UPDATE narration_settings SET default_voice_id = NULL, default_voice_name = NULL");
    db.close();
    particle = await startParticle({ dbPath, provider, port: 4790 });
    await sleep(500);
    const auto1 = (await call(`/api/articles/${article3}/narration`, { method: 'POST', body: {} })).json;
    const auto2 = (await call(`/api/articles/${article3}/narration`, { method: 'POST', body: {} })).json;
    record('Automatic picks once per script and keeps it', auto1.voice?.source === 'automatic' && auto1.rev === auto2.rev, auto1.voice?.name);
  } finally {
    await particle.stop();
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── migrations ───────────────────────────────────────────────────────────────
/* Libraries at v1, v2 and v3 are built from the schema blocks of the last
   release's db.js, filled, and then opened by this build. */
async function migrate() {
  const dir = scratchDir();
  try {
    const previous = execFileSync('git', ['show', 'HEAD:server/db.js'], { cwd: ROOT, encoding: 'utf8' });
    const blocks = [...previous.matchAll(/if \(version < (\d)\) db\.exec\(`([\s\S]*?)`\);/g)].map(m => ({ to: Number(m[1]), sql: m[2] }));
    if (blocks.length < 3) throw new Error('could not read the old schema');

    for (const target of [1, 2, 3]) {
      const path = assertScratch(join(dir, `v${target}.db`));
      const db = new DatabaseSync(path);
      for (const block of blocks.filter(b => b.to <= target)) db.exec(block.sql);
      db.prepare("INSERT INTO articles (url, title, content_html, text_content, word_count) VALUES (?, ?, ?, ?, ?)")
        .run('http://127.0.0.1:1/old', 'Old story', '<p>First old paragraph.</p><p>Second old paragraph, being heard.</p>', 'First. Second.', 6);
      if (target >= 2) {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha1').update('2 Old story  <p>First old paragraph.</p><p>Second old paragraph, being heard.</p>').digest('hex');
        db.prepare("UPDATE articles SET audio_pos = 6.5 WHERE id = 1").run();
        db.prepare(`INSERT INTO narrations (article_id, content_hash, voice_id, direction, script) VALUES (1, ?, 'old', '{}', ?)`)
          .run(hash, JSON.stringify({ segments: [
            { seq: 0, kind: 'intro', blocks: [], chars: 30, pause: 900 },
            { seq: 1, kind: 'text', blocks: [0], chars: 20, pause: 460 },
            { seq: 2, kind: 'text', blocks: [1], chars: 40, pause: 460 },
          ] }));
        db.prepare('INSERT INTO narration_segments (article_id, seq, audio, bytes, duration) VALUES (1, 0, ?, 3, 4)').run(Buffer.from('abc'));
        db.prepare('INSERT INTO narration_segments (article_id, seq, audio, bytes, duration) VALUES (1, 1, ?, 3, 2)').run(Buffer.from('abc'));
      }
      db.close();

      const probe = `import('${join(ROOT, 'server', 'db.js')}').then(m => {
        const a = m.getArticle(1);
        console.log(JSON.stringify({ version: m.db.prepare('PRAGMA user_version').get().user_version, title: a.title,
          legacy: m.hasLegacyNarration(1), fts: m.listArticles({ q: 'old' }).length }));
      }).catch(e => { console.log(JSON.stringify({ error: e.message })); });`;
      const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { PATH: process.env.PATH, PARTICLE_DB: path }, encoding: 'utf8' }).trim().split('\n').pop());
      record(`v${target} → v4 keeps the article and its search entry`, out.version === 4 && out.title === 'Old story' && out.fts === 1, JSON.stringify(out));
      if (target >= 2) record(`v${target} legacy narration waits for its first open`, out.legacy === true);
    }

    // the old bookmark converts on first open, through a running server
    const provider = await startFakeProvider();
    const particle = await startParticle({ dbPath: join(dir, 'v3.db'), provider, port: 4791 });
    try {
      const blocks = (await request(particle.base, '/api/articles/1/narration/blocks')).json;
      const second = blocks.blocks.find(b => !b.skip_reason && b.dom_index === 1);
      const db = new DatabaseSync(join(dir, 'v3.db'));
      const rows = db.prepare('SELECT COUNT(*) AS n FROM narration_segments').get().n + db.prepare('SELECT COUNT(*) AS n FROM narrations').get().n;
      db.close();
      record('an old seconds bookmark converts to the paragraph it named, and the old rows go',
        blocks.bookmark?.bookmark?.block_id === second?.id && rows === 0 && provider.state.requests.length === 0,
        `bookmark ${blocks.bookmark?.bookmark?.segment_id}, old rows left ${rows}`);
    } finally {
      await particle.stop();
      await provider.close();
    }

    // a newer library is refused, not opened
    const newer = assertScratch(join(dir, 'v9.db'));
    const db = new DatabaseSync(newer);
    db.exec('PRAGMA user_version = 9');
    db.close();
    let refused = '';
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `import('${join(ROOT, 'server', 'db.js')}')`], { env: { PATH: process.env.PATH, PARTICLE_DB: newer }, stdio: 'pipe' });
    } catch (error) {
      refused = String(error.stderr);
    }
    record('a library from a newer build is refused', /newer than this particle build supports/.test(refused));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── serve ────────────────────────────────────────────────────────────────────
async function serve() {
  const dir = scratchDir();
  const dbPath = join(dir, 'particle.db');
  const provider = await startFakeProvider({ port: Number(process.env.FAKE_TTS_PORT) || 0 });
  const port = Number(process.env.PORT) || 4792;
  const particle = await startParticle({ dbPath, provider, port, env: { PARTICLE_BASE: process.env.PARTICLE_BASE || '' } });
  const prefix = process.env.PARTICLE_BASE || '';
  for (const [n, count] of [[1, 8], [2, 30]]) {
    await request(particle.base, `${prefix}/api/articles`, { method: 'POST', body: { url: `http://127.0.0.1:1/story-${n}`, html: ARTICLE(count) } });
  }
  console.log(`particle (scratch) ${particle.base}${prefix}/   fake provider ${provider.url}   library ${dbPath}`);
  console.log(`control the provider: curl -X POST ${provider.url}/__control -d '{"mode":"503x2"}'   (modes: ok 401 404 429 503xN hang cut; delayMs)`);
  const stop = async () => { await particle.stop(); await provider.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function request(base, path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!raw || /json/.test(res.headers.get('content-type') || '')) {
    try { json = JSON.parse(bytes.toString('utf8')); } catch { json = null; }
  }
  return { status: res.status, headers: res.headers, bytes, json };
}

function read(req) {
  return new Promise((done) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => done(data));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const command = process.argv[2] || 'check';
const run = { check, migrate, serve }[command];
if (!run) {
  console.error('usage: node tools/narration-harness.mjs check | migrate | serve');
  process.exit(2);
}
run().then(() => {
  if (command === 'serve') return;
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
