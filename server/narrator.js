// Keeps narration audio: plans a script when one is missing or stale, hands out
// segments, synthesising them the first time they are asked for and caching the
// bytes next to the article. Playback drives synthesis, so an article opened and
// abandoned after a paragraph costs one paragraph.
import { createHash } from 'node:crypto';
import { synthesize, isTtsConfigured, audioFormat, audioMime } from './tts.js';
import { planNarration, contentHash, segmentStyle } from './narration.js';

/* Two slots meant the segment in front of the reader shared the provider with
   one paragraph of prefetch and waited behind the rest. Four keeps the warm
   queue moving without a provider ever seeing a burst it will rate-limit. */
const CONCURRENCY = positiveInt(process.env.TTS_CONCURRENCY, 4);
const MAX_CACHE_BYTES = positiveInt(process.env.TTS_MAX_CACHE_MB, 512) * 1024 * 1024;
const WARM_AHEAD = positiveInt(process.env.TTS_WARM_AHEAD, 3);

export function createNarrator(store) {
  const inFlight = new Map();   // "articleId:seq" → Promise<{audio, duration}>
  const planning = new Map();   // "articleId:voiceId" → Promise<narration>
  let running = 0;
  const queue = [];

  // ── what the reader is waiting for ─────────────────────────────────────────
  /* Casting and synthesis both take real seconds, and a spinner that says
     nothing is indistinguishable from one that is stuck. Every step reports
     what it is actually doing, to whoever is watching this article. */
  const watchers = new Map();   // articleId → Set<send>
  const latest = new Map();     // articleId → last event, for a watcher arriving mid-flight
  /* Warm-ahead work runs quietly until the player catches up with it, which it
     does by asking for a segment already in flight. From that moment it is what
     the reader is waiting on, so it starts saying so. */
  const wanted = new Set();     // in-flight keys some foreground request has joined
  const progress = new Map();   // in-flight key → its last report, to replay on promotion

  function emit(articleId, stage, fields = {}) {
    const event = { stage, at: Date.now(), ...fields };
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
    if (last) send(last);
    return () => {
      const set = watchers.get(articleId);
      if (!set) return;
      set.delete(send);
      if (!set.size) watchers.delete(articleId);
    };
  }

  /** Plan or reuse a narration. Rebuilds when the article, or the chosen voice, changed. */
  async function ensure(article, { force = false, voiceId = null } = {}) {
    const existing = store.getNarration(article.id);
    const sameText = existing && existing.content_hash === contentHash(article);
    const fresh = sameText && (!voiceId || existing.voice_id === voiceId);
    if (fresh && !force) return existing;

    // Swapping the voice on a script that already reads well keeps the direction
    // that was written for this article; a recast throws it out and starts over.
    const reuse = !force && voiceId && sameText ? existing.direction : null;

    // Two requests for the same casting share one plan; a different voice does not.
    const planKey = `${article.id}:${voiceId || ''}:${force ? 'force' : ''}`;
    if (planning.has(planKey)) return planning.get(planKey);
    const job = (async () => {
      emit(article.id, 'planning', { detail: voiceId ? 'switching voice' : 'planning the narration' });
      const { direction, script, language, contentHash: hash } = await planNarration(article, {
        voiceId,
        reuse,
        // the voice that reads every article is the one that read the last few
        avoid: voiceId ? [] : recentVoices(article.id),
        onStage: (stage, fields) => emit(article.id, stage, fields),
      });
      // A new script means the old audio no longer lines up with it.
      store.deleteNarration(article.id);
      const saved = store.saveNarration(article.id, {
        content_hash: hash,
        language,
        voice_id: direction.voice_id,
        voice_name: direction.voice_name,
        tone: direction.tone,
        reason: direction.reason,
        source: direction.source,
        direction,
        script,
        format: audioFormat,
      });
      emit(article.id, 'cast', {
        detail: `${direction.voice_name} will read it`,
        voice: direction.voice_name,
        reason: direction.reason,
        source: direction.source,
        total: script.segments?.length || 0,
      });
      return saved;
    })().catch((error) => {
      emit(article.id, 'error', { detail: error.message });
      throw error;
    }).finally(() => planning.delete(planKey));

    planning.set(planKey, job);
    return job;
  }

  /* The narrations played most recently, minus this one — recasting an article
     should not treat the voice it is replacing as fresh. */
  function recentVoices(articleId) {
    if (typeof store.recentNarrationVoices !== 'function') return [];
    try {
      return store.recentNarrationVoices(8).filter(id => id && id !== store.getNarration(articleId)?.voice_id);
    } catch {
      return [];
    }
  }

  /**
   * The audio for one segment, from cache or from the provider.
   *
   * `background` marks warm-ahead work. It goes to the back of the queue and
   * reports quietly, so a segment the player is actually waiting on is never
   * stuck behind three paragraphs nobody has reached yet.
   */
  async function segment(article, narration, seq, { background = false } = {}) {
    const cached = store.getNarrationSegment(article.id, seq);
    if (cached) return { audio: Buffer.from(cached.audio), duration: cached.duration, cached: true };

    // The revision is in the key: a request made after a recast must not be
    // answered by synthesis still running for the voice it replaced.
    const rev = narrationRev(narration);
    const key = `${article.id}:${rev}:${seq}`;
    if (!background) wanted.add(key);

    const running = inFlight.get(key);
    if (running) {
      // Joining work already under way: say where it has got to, or the reader
      // watches four silent seconds with nothing on screen to explain them.
      const last = !background && progress.get(key);
      if (last) emit(article.id, last.stage, { ...last.fields, background: false });
      return running;
    }

    const spec = narration.script.segments?.[seq];
    if (!spec) throw Object.assign(new Error('no such narration segment'), { statusCode: 404 });

    const total = narration.script.segments.length;
    // read at emit time, not now: a background job the player has since caught
    // up with is foreground work by the time it reports
    const quiet = () => background && !wanted.has(key);
    const report = (stage, fields) => {
      progress.set(key, { stage, fields: { seq, total, ...fields } });
      if (quiet() && stage !== 'ready') return;
      emit(article.id, stage, { seq, total, background: quiet(), ...fields });
    };
    report('queued', { detail: 'waiting for a synthesis slot' });

    const job = withSlot(async () => {
      report('synthesising', { detail: `reading ${describe(spec)}` });
      const style = segmentStyle(spec.kind, narration.direction);
      const started = Date.now();
      const { audio, duration } = await synthesize({
        text: spec.text,
        voiceId: narration.voice_id,
        speed: style.speed,
        volume: style.volume,
        temperature: style.temperature,
        topP: style.topP,
        pauseMs: spec.pause || 0,
      });
      // A recast while this was in the air leaves it orphaned: the segment
      // numbers are the same, so keeping it would file the old voice under the
      // new casting.
      const live = store.getNarration(article.id);
      if (!live || narrationRev(live) !== rev) {
        throw Object.assign(new Error('the narration was recast'), { statusCode: 409 });
      }
      store.saveNarrationSegment(article.id, seq, audio, duration);
      store.pruneNarrationAudio(MAX_CACHE_BYTES, article.id);
      report('ready', {
        detail: `${describe(spec)} ready`,
        ms: Date.now() - started,
        ready: store.narrationSegmentIndex(article.id).length,
      });
      return { audio, duration, cached: false };
    }, { background }).catch((error) => {
      report('error', { detail: error.message });
      throw error;
    }).finally(() => { inFlight.delete(key); wanted.delete(key); progress.delete(key); });

    inFlight.set(key, job);
    return job;
  }

  /* Synthesis runs a little ahead of playback so the next paragraph is waiting.
     Failures here are silent: the segment is simply requested again when the
     player reaches it. */
  function warm(article, narration, fromSeq, count = WARM_AHEAD) {
    const total = narration.script.segments?.length || 0;
    for (let seq = fromSeq; seq < Math.min(total, fromSeq + count); seq++) {
      if (store.hasNarrationSegment(article.id, seq)) continue;
      segment(article, narration, seq, { background: true }).catch(() => {});
    }
  }

  function manifest(article, narration) {
    const ready = new Map(store.narrationSegmentIndex(article.id).map(row => [row.seq, row]));
    const segments = (narration.script.segments || []).map(spec => ({
      seq: spec.seq,
      kind: spec.kind,
      text: spec.text,
      blocks: spec.blocks,
      pause: spec.pause,
      chars: spec.chars,
      duration: ready.get(spec.seq)?.duration ?? estimateDuration(spec, narration.direction),
      ready: ready.has(spec.seq),
    }));
    return {
      article_id: article.id,
      rev: narrationRev(narration),
      language: narration.language,
      format: narration.format || audioFormat,
      mime: audioMime,
      voice: {
        id: narration.voice_id,
        name: narration.voice_name,
        tone: narration.tone,
        reason: narration.reason,
        source: narration.source,
      },
      pronunciations: narration.direction?.pronunciations || [],
      blocks: narration.script.blocks || [],
      segments,
      duration: Number(segments.reduce((sum, s) => sum + s.duration, 0).toFixed(2)),
      ready_count: segments.filter(s => s.ready).length,
      audio_pos: article.audio_pos || 0,
    };
  }

  /* Warm-ahead work queues behind anything the player is waiting on. Without
     this a voice switch waits out three paragraphs of the *previous* request's
     prefetch before the paragraph in front of the reader is even started. */
  function withSlot(run, { background = false } = {}) {
    if (running < CONCURRENCY) {
      running += 1;
      return run().finally(release);
    }
    return new Promise((resolve, reject) => {
      const job = () => run().then(resolve, reject).finally(release);
      if (background) queue.push(job);
      else queue.unshift(job);
    });
  }

  function release() {
    running -= 1;
    const next = queue.shift();
    if (next) {
      running += 1;
      next();
    }
  }

  return {
    ensure, segment, warm, manifest, watch,
    status: id => latest.get(id) || null,
    rev: narrationRev,
    drop: (id) => { store.deleteNarration(id); latest.delete(id); },
    enabled: isTtsConfigured,
  };
}

/* A casting's fingerprint: it moves whenever the script or the voice does. The
   segment URLs carry it, which is what lets the audio be cached hard and still
   never hand back a paragraph in a voice the reader has just replaced. */
export function narrationRev(narration) {
  return createHash('sha1')
    .update(`${narration?.content_hash || ''}|${narration?.voice_id || ''}|${narration?.created_at || ''}`)
    .digest('hex')
    .slice(0, 10);
}

/* Before a segment is synthesised its length is a guess, and the player needs
   one to draw a scrub bar. Measured against real output, prose lands near 15.5
   characters a second at normal pace; the clipped, full-stopped opening and
   closing lines run slower. The trailing pause is part of the file, so it is
   part of the guess. The real duration replaces this as the audio arrives. */
const CHARS_PER_SECOND = { intro: 9, outro: 9, heading: 12, caption: 14 };

function estimateDuration(spec, direction) {
  const speed = segmentStyle(spec.kind, direction).speed || 1;
  const rate = (CHARS_PER_SECOND[spec.kind] || 15.5) * speed;
  return Number((spec.chars / rate + (spec.pause || 0) / 1000).toFixed(2));
}

/* What a segment is, in the words the reader would use for it. The status line
   says "reading the opening line", not "segment 0"; where it sits in the article
   is the client's to add, so it is not said twice. */
function describe(spec) {
  const named = {
    intro: 'the opening line',
    outro: 'the closing line',
    heading: 'a section heading',
    quote: 'a quotation',
    caption: 'a caption',
    item: 'a list item',
  }[spec.kind];
  return named || 'a passage';
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
