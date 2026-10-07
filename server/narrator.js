// Keeps narration: prepares a variant (script + voice) when one is asked for,
// hands out its passages — synthesising each the first time anyone needs it,
// caching the bytes beside the article — and stops working on passages nobody
// is heading towards any more. Playback drives synthesis, so an article opened
// and abandoned after a paragraph costs a paragraph.
//
// Preparing never waits on the network. A chosen voice is an id; the script is
// local work; an automatic choice uses whatever catalogue is already at hand
// and otherwise the provider's default. The only slow thing is synthesis, and
// that happens per passage, cancellable, behind a status stream.
import {
  buildScript, scriptIdentity, pacing, segmentStyle, shortlistVoices, toneProfile, detectLanguage,
  mapLegacyPosition,
} from './narration.js';
import { contentRevision, narrationRev } from './narration-identity.js';
import { createScheduler, CancelledError } from './narration-queue.js';
import { resolveStart, segmentForBlock, validBookmark, demandWindow } from '../public/narration-model.js';

const LEASE_MS = 30_000;
const STATUS_TTL_MS = 30_000;
const SCRIPT_CACHE = 24;

export function createNarrator(store, deps) {
  const {
    synthesize, synthesisConfig, catalogue,
    audioFormat = 'mp3', audioMime = 'audio/mpeg',
    lockedVoiceId = null, envVoiceId = null,
    concurrency = 4, maxCacheBytes = 512 * 1024 * 1024, warmAhead = 6,
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    log = () => {},
  } = deps;

  const metrics = createMetrics();
  const epochs = new Map();         // articleId → number, moved on by every invalidation
  const sessions = new Map();       // session id → demand window
  const scripts = new Map();        // script id → { content_revision, script_id, script, language }
  let consumers = 0;

  // ── status ─────────────────────────────────────────────────────────────────
  /* Synthesis takes real seconds, and a spinner that says nothing looks the
     same as one that is stuck. Each step is reported, with enough identity —
     revision, passage, request — for a player to ignore what is not its own. */
  const watchers = new Map();       // articleId → Set<send>
  const latest = new Map();         // articleId → last event, for a watcher arriving mid-flight

  function emit(articleId, stage, fields = {}) {
    const event = { article_id: articleId, stage, at: now(), ...fields };
    latest.set(articleId, event);
    for (const send of watchers.get(articleId) || []) {
      try { send(event); } catch { /* a closed stream is not this job's problem */ }
    }
    return event;
  }

  function watch(articleId, send) {
    if (!watchers.has(articleId)) watchers.set(articleId, new Set());
    watchers.get(articleId).add(send);
    const last = latest.get(articleId);
    if (last && now() - last.at < STATUS_TTL_MS) send(last);
    return () => {
      const set = watchers.get(articleId);
      if (!set) return;
      set.delete(send);
      if (!set.size) watchers.delete(articleId);
    };
  }

  const scheduler = createScheduler({
    concurrency,
    now,
    onEvent: (type, job, error) => {
      const { articleId, rev, seq, total } = job.meta;
      const base = { rev, seq, total, job_id: job.key, background: job.priority !== 'foreground' };
      if (type === 'queued') emit(articleId, 'queued', { ...base, detail: 'waiting for a synthesis slot' });
      if (type === 'promoted') emit(articleId, job.state === 'running' ? 'synthesising' : 'queued', { ...base, detail: job.state === 'running' ? `reading ${describe(job.meta.kind)}` : 'waiting for a synthesis slot' });
      if (type === 'started') emit(articleId, 'synthesising', { ...base, detail: `reading ${describe(job.meta.kind)}`, elapsed_ms: now() - job.enqueuedAt });
      if (type === 'done') emit(articleId, 'ready', { ...base, detail: `${describe(job.meta.kind)} ready`, elapsed_ms: now() - job.enqueuedAt });
      if (type === 'cancelled') {
        metrics.count('cancelled');
        emit(articleId, 'cancelled', { ...base, detail: 'no longer needed' });
      }
      if (type === 'failed') {
        metrics.count(`failed:${error?.code || 'unknown'}`);
        log(`narration #${articleId} ${rev} ${seq}: ${error?.code || 'failed'}`);
        emit(articleId, 'error', { ...base, detail: error?.message || 'synthesis failed', code: error?.code || 'failed', retryable: Boolean(error?.retryable) });
      }
    },
  });

  // ── scripts and voices ─────────────────────────────────────────────────────
  function scriptFor(article) {
    const { content_revision, script_id } = scriptIdentity(article);
    const hit = scripts.get(script_id);
    if (hit) {
      scripts.delete(script_id);
      scripts.set(script_id, hit);
      return hit;
    }
    const entry = { content_revision, script_id, script: buildScript(article), language: detectLanguage(article.text_content || '') };
    scripts.set(script_id, entry);
    while (scripts.size > SCRIPT_CACHE) scripts.delete(scripts.keys().next().value);
    return entry;
  }

  /**
   * Who reads this article, and why. In order: an operator's lock, the
   * reader's choice for this article, the library default, the automatic
   * choice already made for this script, TTS_VOICE_ID, a fresh automatic
   * choice from whatever catalogue is at hand, the provider's own default. A
   * fresh automatic choice is written down so the article keeps its voice.
   */
  function resolveVoice(article, entry, { persist = true } = {}) {
    if (lockedVoiceId) {
      return { id: lockedVoiceId, name: catalogue?.known(lockedVoiceId)?.title || 'locked voice', source: 'locked' };
    }
    if (article.narration_voice_id) {
      return { id: article.narration_voice_id, name: article.narration_voice_name || 'chosen voice', source: 'article' };
    }
    const settings = store.getNarrationSettings();
    if (settings.default_voice_id) {
      return { id: settings.default_voice_id, name: settings.default_voice_name || 'chosen voice', source: 'default' };
    }
    const auto = store.getAutoChoice(article.id, entry.script_id);
    if (auto) return automatic(auto);
    if (envVoiceId) {
      return { id: envVoiceId, name: catalogue?.known(envVoiceId)?.title || 'configured voice', source: 'configured' };
    }
    if (!persist) return null;
    const voices = catalogue?.peek(entry.language) || [];
    const ranked = voices.length
      ? shortlistVoices(article, voices, toneProfile(article), { avoid: recentVoices() })
      : [];
    const choice = ranked[0] ? { voice_id: ranked[0].id, voice_name: ranked[0].title } : { voice_id: null, voice_name: null };
    return automatic(store.saveAutoChoice(article.id, entry.script_id, choice));
  }

  const automatic = choice => ({
    id: choice.voice_id || null,
    name: choice.voice_name || (choice.voice_id ? 'automatic voice' : "the provider's default voice"),
    source: 'automatic',
  });

  function recentVoices() {
    try { return store.recentNarrationVoices(8); } catch { return []; }
  }

  function variantFor(article, entry, voice) {
    const config = synthesisConfig(pacing(article));
    const rev = narrationRev({ script_id: entry.script_id, voice_id: voice.id, config });
    const existing = store.getVariant(article.id, rev);
    if (existing) {
      store.touchVariant(article.id, rev);
      return existing;
    }
    return store.saveVariant(article.id, {
      rev,
      script_id: entry.script_id,
      content_revision: entry.content_revision,
      voice_id: voice.id,
      voice_name: voice.name,
      language: entry.language,
      config,
      script: entry.script,
    }, { contentRevisionOf: contentRevision });
  }

  // ── older narrations ───────────────────────────────────────────────────────
  /* The first time an article from before v4 is opened, its old seconds
     bookmark is mapped through the old script to a paragraph, saved as a new
     bookmark, and the old narration and its audio are deleted in the same step.
     No provider is asked anything. */
  function convertLegacy(article) {
    if (!store.hasLegacyNarration(article.id)) return false;
    let bookmark = null;
    const legacy = store.getLegacyNarration(article.id);
    if (legacy && article.audio_pos > 0) {
      const mapped = mapLegacyPosition(article, legacy, store.legacyDurations(article.id), article.audio_pos);
      const entry = scriptFor(article);
      const first = entry.script.segments[0];
      const target = mapped?.block_id ? entry.script.segments.find(segment => segment.block_id === mapped.block_id) : null;
      const at = mapped?.completed ? first : target;
      if (at) {
        bookmark = {
          v: 1,
          content_revision: entry.content_revision,
          script_id: entry.script_id,
          rev: 'legacy',
          block_id: at.block_id,
          segment_id: at.id,
          offset_seconds: 0,
          completed: Boolean(mapped?.completed),
        };
      }
    }
    store.finishLegacyConversion(article.id, bookmark);
    return true;
  }

  // ── preparing ──────────────────────────────────────────────────────────────
  /**
   * The manifest for listening to this article now: resolves the voice (after
   * applying any change the request makes to this article's choice), files the
   * variant, and works out where to start. Starts synthesis at that point, not
   * at the top of the article.
   */
  function prepare(articleId, body = {}) {
    const started = now();
    let article = store.getArticle(articleId);
    if (!article) throw httpError(404, 'not_found', 'not found');

    if (body.voice_override !== undefined) {
      const wanted = body.voice_override;
      if (lockedVoiceId && wanted && wanted.id !== lockedVoiceId) {
        throw httpError(409, 'voice_locked', 'this install reads every article in one voice');
      }
      const result = store.setVoiceOverride(articleId, wanted, body.expected_voice_version);
      if (!result.ok) {
        throw httpError(409, 'voice_conflict', 'the voice for this article was changed elsewhere',
          { voice_version: result.version, voice: result.voice });
      }
      article = store.getArticle(articleId);
    }
    if (convertLegacy(article)) article = store.getArticle(articleId);

    const entry = scriptFor(article);
    if (!entry.script.segments.length) throw httpError(422, 'nothing_to_read', 'nothing in this article is read aloud');
    const voice = resolveVoice(article, entry);
    const variant = variantFor(article, entry, voice);
    const stored = store.getBookmark(articleId);
    const start = resolveRequestedStart(article, entry, variant, body.start || {}, stored);
    store.pruneVariants(articleId, { keep: 3, protect: [variant.rev, ...activeRevs(articleId)] });
    metrics.timing('prepare_ms', now() - started);

    const manifest = buildManifest(article, variant, voice, { start, bookmark: stored });
    emit(articleId, 'cast', {
      request_id: body.request_id, rev: variant.rev, detail: `${voice.name} will read it`, total: manifest.segments.length,
    });
    if (body.session_id && start.seq !== undefined && start.mode !== 'changed' && start.mode !== 'nothing') {
      try {
        demand(articleId, {
          session_id: body.session_id, generation: Number(body.generation) || 0, rev: variant.rev,
          seq: start.seq, rate: 1, target_seconds: 30, paused: false,
        });
      } catch { /* warming is a nicety; the player asks for what it needs */ }
    }
    return manifest;
  }

  function resolveRequestedStart(article, entry, variant, start, stored) {
    const shape = { rev: variant.rev, script_id: variant.script_id, segments: variant.script.segments, blocks: variant.script.blocks };
    if (start.mode === 'beginning') return { seq: 0, offset: 0, mode: 'beginning' };
    if (start.mode === 'block') {
      // a reader's tap on a paragraph is only meaningful against the text they saw
      if (start.content_revision && start.content_revision !== entry.content_revision) {
        throw httpError(409, 'content_changed', 'the article changed since that paragraph was chosen', { blocks: blocksView(entry) });
      }
      if (!shape.blocks.some(block => block.id === start.block_id)) {
        throw httpError(409, 'content_changed', 'that paragraph is not in the article any more', { blocks: blocksView(entry) });
      }
      const found = segmentForBlock(shape, start.block_id);
      return found ? { seq: found.seq, offset: 0, mode: found.exact ? 'block' : 'next-block' } : { mode: 'nothing' };
    }
    const bookmark = validBookmark(start.bookmark) || validBookmark(stored?.bookmark);
    if (!bookmark) return { seq: 0, offset: 0, mode: 'beginning' };
    let oldBlocks = null;
    if (bookmark.script_id !== variant.script_id) {
      const old = store.getVariant(article.id, bookmark.rev) || store.getVariantByScript(article.id, bookmark.script_id);
      oldBlocks = old?.script?.blocks?.map(block => block.id) || null;
    }
    const resolved = resolveStart(shape, bookmark, { oldBlocks });
    return resolved.mode === 'changed' ? { mode: 'changed' } : resolved;
  }

  /** The cheap map the reader fetches on open: no catalogue, no model, no synthesis. */
  function blocks(articleId) {
    let article = store.getArticle(articleId);
    if (!article) throw httpError(404, 'not_found', 'not found');
    if (convertLegacy(article)) article = store.getArticle(articleId);
    return { ...blocksView(scriptFor(article)), bookmark: store.getBookmark(articleId) };
  }

  function blocksView(entry) {
    return {
      content_revision: entry.content_revision,
      script_id: entry.script_id,
      selector: entry.script.selector,
      blocks: entry.script.blocks,
      segment_count: entry.script.segments.length,
    };
  }

  /** An already-prepared manifest, exactly as named; never synthesises or chooses. */
  function current(articleId, rev) {
    const article = store.getArticle(articleId);
    if (!article) throw httpError(404, 'not_found', 'not found');
    const revision = contentRevision(article);
    let variant;
    let voice;
    if (rev) {
      variant = store.getVariant(articleId, rev);
      if (!variant) throw httpError(404, 'revision_missing', 'that narration is not kept any more');
      if (variant.content_revision !== revision) throw httpError(409, 'content_changed', 'the article changed since this narration was made');
      voice = { id: variant.voice_id, name: variant.voice_name, source: 'earlier' };
      const effective = resolveVoice(article, scriptFor(article), { persist: false });
      if (effective && effective.id === variant.voice_id) voice = effective;
    } else {
      const entry = scriptFor(article);
      voice = resolveVoice(article, entry, { persist: false });
      if (!voice) throw httpError(404, 'not_prepared', 'not narrated yet');
      const config = synthesisConfig(pacing(article));
      variant = store.getVariant(articleId, narrationRev({ script_id: entry.script_id, voice_id: voice.id, config }));
      if (!variant) throw httpError(404, 'not_prepared', 'not narrated yet');
    }
    const stored = store.getBookmark(articleId);
    const start = resolveRequestedStart(article, scriptFor(article), variant, {}, stored);
    return buildManifest(article, variant, voice, { start, bookmark: stored });
  }

  function buildManifest(article, variant, voice, { start, bookmark }) {
    const ready = new Map(store.audioIndex(article.id, variant.rev).map(row => [row.seq, row]));
    const direction = variant.config?.pacing || {};
    const segments = variant.script.segments.map(spec => ({
      id: spec.id,
      seq: spec.seq,
      block_id: spec.block_id,
      dom_index: spec.dom_index,
      run: spec.run,
      part: spec.part,
      kind: spec.kind,
      chars: spec.chars,
      duration: ready.get(spec.seq)?.duration ?? estimateDuration(spec, direction),
      estimated: !ready.has(spec.seq),
      ready: ready.has(spec.seq),
    }));
    return {
      article_id: article.id,
      content_revision: variant.content_revision,
      script_id: variant.script_id,
      rev: variant.rev,
      language: variant.language,
      format: audioFormat,
      mime: audioMime,
      voice: { id: voice.id, name: voice.name, source: voice.source, locked: Boolean(lockedVoiceId) },
      voice_version: article.narration_voice_version || 0,
      selector: variant.script.selector,
      blocks: variant.script.blocks,
      segments,
      duration: Number(segments.reduce((sum, segment) => sum + segment.duration, 0).toFixed(2)),
      ready_count: ready.size,
      start,
      bookmark: bookmark || { bookmark: null, version: 0 },
      warm_ahead: warmAhead,
    };
  }

  // ── passages ───────────────────────────────────────────────────────────────
  /**
   * One passage of one exact variant: from the cache, or synthesised now as
   * foreground work. A request that goes away releases its claim; the passage
   * keeps synthesising only if someone else (another tab, the warm window)
   * still wants it.
   */
  async function segment(articleId, rev, seq, { signal, priority = 'foreground' } = {}) {
    const started = now();
    const article = store.getArticle(articleId);
    if (!article) throw httpError(404, 'not_found', 'not found');
    const variant = store.getVariant(articleId, rev);
    if (!variant) throw httpError(404, 'revision_missing', 'that narration is not kept any more');
    if (variant.content_revision !== contentRevision(article)) {
      throw httpError(409, 'content_changed', 'the article changed since this narration was made');
    }
    const spec = variant.script.segments[seq];
    if (!spec) throw httpError(404, 'not_found', 'no such passage');

    const cached = store.getAudio(articleId, rev, seq);
    if (cached) {
      metrics.count('cache_hit');
      return { audio: Buffer.from(cached.audio), duration: cached.duration, cached: true };
    }
    metrics.count('cache_miss');

    const key = jobKey(articleId, rev, seq);
    const consumer = `request:${++consumers}`;
    const work = scheduler.request(key, {
      consumer,
      priority: priority === 'background' ? 'speculative' : 'foreground',
      meta: { articleId, rev, seq, kind: spec.kind, total: variant.script.segments.length },
      run: jobSignal => synthesizeSegment(articleId, variant, seq, jobSignal),
    });
    const onAbort = () => scheduler.release(key, consumer);
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await work;
      metrics.timing('segment_wait_ms', now() - started);
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function synthesizeSegment(articleId, variant, seq, signal) {
    const epoch = epochs.get(articleId) || 0;
    const spec = variant.script.segments[seq];
    const style = segmentStyle(spec.kind, variant.config?.pacing);
    const started = now();
    const { audio, duration } = await synthesize({
      text: spec.text,
      voiceId: variant.voice_id,
      speed: style.speed,
      volume: style.volume,
      temperature: style.temperature,
      topP: style.topP,
      pauseMs: spec.pause || 0,
      signal,
    });
    metrics.timing('upstream_ms', now() - started);
    metrics.count('synthesised');
    if (signal.aborted) throw new CancelledError();
    // an edit, a delete or a discard while this was in the air: do not write it back
    const live = store.getArticle(articleId);
    if ((epochs.get(articleId) || 0) !== epoch || !live || contentRevision(live) !== variant.content_revision) {
      throw httpError(409, 'content_changed', 'the article changed while this passage was being read');
    }
    const saved = store.saveAudio(articleId, variant.rev, seq, audio, duration, { maxBytes: maxCacheBytes, protect: protectedKeys() });
    if (!saved.stored) metrics.count(`not_stored:${saved.reason}`);
    return { audio, duration, cached: false };
  }

  // ── what each listener needs next ──────────────────────────────────────────
  /**
   * A listening session says where it is; that replaces whatever it said
   * before. Passages in its window are warmed as speculative work; passages
   * that fell out of it are released, and abandoned if nobody else wants them.
   * The window lapses after LEASE_MS without a renewal.
   */
  function demand(articleId, body) {
    const id = String(body.session_id || '');
    if (!id) throw httpError(400, 'bad_request', 'session_id is required');
    const generation = Number(body.generation) || 0;
    const session = sessions.get(id);
    if (session && session.articleId === articleId && generation < session.generation) return { ignored: true };
    if (body.release) {
      dropSession(id);
      return { seqs: [] };
    }

    const article = store.getArticle(articleId);
    if (!article) throw httpError(404, 'not_found', 'not found');
    const variant = store.getVariant(articleId, String(body.rev || ''));
    if (!variant) throw httpError(404, 'revision_missing', 'that narration is not kept any more');
    if (variant.content_revision !== contentRevision(article)) {
      throw httpError(409, 'content_changed', 'the article changed since this narration was made');
    }

    const total = variant.script.segments.length;
    const seq = Math.max(0, Math.min(total - 1, Math.floor(Number(body.seq) || 0)));
    const ready = new Map(store.audioIndex(articleId, variant.rev).map(row => [row.seq, row.duration]));
    const direction = variant.config?.pacing || {};
    const timed = variant.script.segments.map(spec => ({ duration: ready.get(spec.seq) ?? estimateDuration(spec, direction) }));
    const seqs = body.paused ? [seq] : demandWindow(timed, seq, {
      seconds: clampNumber(body.target_seconds, 30, 0, 90),
      rate: clampNumber(body.rate, 1, 0.5, 3),
      maxSegments: warmAhead,
      saveData: Boolean(body.save_data),
    });

    const window = new Set(seqs.map(one => jobKey(articleId, variant.rev, one)));
    const wanted = new Set(seqs.filter(one => !ready.has(one)).map(one => jobKey(articleId, variant.rev, one)));
    const consumer = `demand:${id}`;
    if (session && session.articleId !== articleId) dropSession(id);
    const previous = sessions.get(id);
    for (const key of previous?.keys || []) if (!wanted.has(key)) scheduler.release(key, consumer);
    for (const key of wanted) {
      if (previous?.keys.has(key) && scheduler.has(key)) continue;
      const one = Number(key.split(':').pop());
      scheduler.request(key, {
        consumer,
        priority: 'speculative',
        meta: { articleId, rev: variant.rev, seq: one, kind: variant.script.segments[one].kind, total },
        run: jobSignal => synthesizeSegment(articleId, variant, one, jobSignal),
      }).catch(() => { /* asked for again, in the foreground, when it is reached */ });
    }
    if (previous?.timer) clearTimer(previous.timer);
    const timer = setTimer(() => dropSession(id), LEASE_MS);
    timer?.unref?.();
    sessions.set(id, { articleId, generation, rev: variant.rev, keys: wanted, window, timer });
    return { seqs, lease_ms: LEASE_MS };
  }

  function dropSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    if (session.timer) clearTimer(session.timer);
    for (const key of session.keys) scheduler.release(key, `demand:${id}`);
  }

  function protectedKeys() {
    const keys = new Set();
    for (const session of sessions.values()) for (const key of session.window) keys.add(key);
    return keys;
  }

  function activeRevs(articleId) {
    const revs = new Set();
    for (const session of sessions.values()) if (session.articleId === articleId) revs.add(session.rev);
    for (const job of scheduler.snapshot().jobs) {
      const [id, rev] = job.key.split(':');
      if (Number(id) === articleId) revs.add(rev);
    }
    return [...revs];
  }

  // ── when the article changes or goes ───────────────────────────────────────
  /** Everything in flight for this article stops; nothing it produces is kept. */
  function invalidate(articleId) {
    epochs.set(articleId, (epochs.get(articleId) || 0) + 1);
    const cancelled = scheduler.cancelWhere(job => job.meta.articleId === articleId,
      Object.assign(new CancelledError('the article changed'), { code: 'content_changed' }));
    for (const [id, session] of [...sessions]) if (session.articleId === articleId) dropSession(id);
    latest.delete(articleId);
    if (cancelled) emit(articleId, 'cancelled', { detail: 'the article changed', code: 'content_changed' });
    return cancelled;
  }

  /** Discard: work stops, every variant and its audio go, and the bookmark with them. */
  function drop(articleId) {
    invalidate(articleId);
    store.deleteNarrationData(articleId);
    latest.delete(articleId);
  }

  /** The library was reset. */
  function invalidateAll() {
    scheduler.cancelWhere(() => true);
    for (const id of [...sessions.keys()]) dropSession(id);
    for (const id of [...epochs.keys()]) epochs.set(id, epochs.get(id) + 1);
    latest.clear();
  }

  /** A deleted article's watchers have nothing more to hear. */
  function forget(articleId) {
    invalidate(articleId);
    watchers.delete(articleId);
    latest.delete(articleId);
  }

  return {
    prepare, blocks, current, segment, demand, watch, invalidate, invalidateAll, drop, forget,
    resolveVoice: (article) => resolveVoice(article, scriptFor(article), { persist: false }),
    diagnostics: () => ({
      ...metrics.snapshot(),
      queue: scheduler.snapshot(),
      scheduler: scheduler.stats(),
      sessions: sessions.size,
      cache_bytes: store.narrationCacheBytes(),
      cache_limit_bytes: maxCacheBytes,
    }),
  };
}

const jobKey = (articleId, rev, seq) => `${articleId}:${rev}:${seq}`;

export function httpError(statusCode, code, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

/* Before a passage is synthesised its length is a guess, and the player needs
   one to draw a scrub bar. Measured against real output, prose lands near 15.5
   characters a second at normal pace and headings slower. The trailing pause
   is part of the file, so it is part of the guess. The real duration replaces
   this once the audio exists. */
const CHARS_PER_SECOND = { heading: 12 };

export function estimateDuration(spec, direction) {
  const speed = segmentStyle(spec.kind, direction).speed || 1;
  const rate = (CHARS_PER_SECOND[spec.kind] || 15.5) * speed;
  return Number((spec.chars / rate + (spec.pause || 0) / 1000).toFixed(2));
}

/* What a passage is, in the words the reader would use for it. */
function describe(kind) {
  return { heading: 'a section heading', quote: 'a quotation', item: 'a list item' }[kind] || 'a passage';
}

/* Bounded counters and timings, for the diagnostics route and the log. IDs and
   numbers only — never the words being spoken. */
function createMetrics() {
  const counts = new Map();
  const timings = new Map();
  return {
    count(name) {
      if (!counts.has(name) && counts.size > 64) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    },
    timing(name, ms) {
      const entry = timings.get(name) || { count: 0, total: 0, max: 0, recent: [] };
      entry.count += 1;
      entry.total += ms;
      entry.max = Math.max(entry.max, ms);
      entry.recent.push(ms);
      if (entry.recent.length > 50) entry.recent.shift();
      timings.set(name, entry);
    },
    snapshot() {
      const out = { counts: Object.fromEntries(counts), timings: {} };
      for (const [name, entry] of timings) {
        const sorted = [...entry.recent].sort((a, b) => a - b);
        out.timings[name] = {
          count: entry.count,
          mean: Math.round(entry.total / entry.count),
          max: entry.max,
          p50: sorted[Math.floor(sorted.length / 2)] ?? null,
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
        };
      }
      return out;
    },
  };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
