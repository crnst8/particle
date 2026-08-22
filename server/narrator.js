// Keeps narration audio: plans a script when one is missing or stale, hands out
// segments, synthesising them the first time they are asked for and caching the
// bytes next to the article. Playback drives synthesis, so an article opened and
// abandoned after a paragraph costs one paragraph.
import { synthesize, isTtsConfigured, audioFormat, audioMime } from './tts.js';
import { planNarration, contentHash, segmentStyle } from './narration.js';

const CONCURRENCY = positiveInt(process.env.TTS_CONCURRENCY, 2);
const MAX_CACHE_BYTES = positiveInt(process.env.TTS_MAX_CACHE_MB, 512) * 1024 * 1024;
const WARM_AHEAD = positiveInt(process.env.TTS_WARM_AHEAD, 2);

export function createNarrator(store) {
  const inFlight = new Map();   // "articleId:seq" → Promise<{audio, duration}>
  const planning = new Map();   // "articleId:voiceId" → Promise<narration>
  let running = 0;
  const queue = [];

  /** Plan or reuse a narration. Rebuilds when the article, or the chosen voice, changed. */
  async function ensure(article, { force = false, voiceId = null } = {}) {
    const existing = store.getNarration(article.id);
    const fresh = existing
      && existing.content_hash === contentHash(article)
      && (!voiceId || existing.voice_id === voiceId);
    if (fresh && !force) return existing;

    // Two requests for the same casting share one plan; a different voice does not.
    const planKey = `${article.id}:${voiceId || ''}`;
    if (planning.has(planKey)) return planning.get(planKey);
    const job = (async () => {
      const { direction, script, language, contentHash: hash } = await planNarration(article, { voiceId });
      // A new script means the old audio no longer lines up with it.
      store.deleteNarration(article.id);
      return store.saveNarration(article.id, {
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
    })().finally(() => planning.delete(planKey));

    planning.set(planKey, job);
    return job;
  }

  /** The audio for one segment, from cache or from the provider. */
  async function segment(article, narration, seq) {
    const cached = store.getNarrationSegment(article.id, seq);
    if (cached) return { audio: Buffer.from(cached.audio), duration: cached.duration, cached: true };

    const key = `${article.id}:${seq}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const spec = narration.script.segments?.[seq];
    if (!spec) throw Object.assign(new Error('no such narration segment'), { statusCode: 404 });

    const job = withSlot(async () => {
      const style = segmentStyle(spec.kind, narration.direction);
      const { audio, duration } = await synthesize({
        text: spec.text,
        voiceId: narration.voice_id,
        speed: style.speed,
        volume: style.volume,
        temperature: style.temperature,
        topP: style.topP,
      });
      store.saveNarrationSegment(article.id, seq, audio, duration);
      store.pruneNarrationAudio(MAX_CACHE_BYTES, article.id);
      return { audio, duration, cached: false };
    }).finally(() => inFlight.delete(key));

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
      segment(article, narration, seq).catch(() => {});
    }
  }

  function manifest(article, narration) {
    const ready = new Map(store.narrationSegmentIndex(article.id).map(row => [row.seq, row]));
    const segments = (narration.script.segments || []).map(spec => ({
      seq: spec.seq,
      kind: spec.kind,
      text: spec.text,
      blocks: spec.blocks,
      gap: spec.gap,
      chars: spec.chars,
      duration: ready.get(spec.seq)?.duration ?? estimateDuration(spec, narration.direction),
      ready: ready.has(spec.seq),
    }));
    return {
      article_id: article.id,
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
      duration: Number(segments.reduce((sum, s) => sum + s.duration + s.gap / 1000, 0).toFixed(2)),
      ready_count: segments.filter(s => s.ready).length,
      audio_pos: article.audio_pos || 0,
    };
  }

  function withSlot(run) {
    if (running < CONCURRENCY) {
      running += 1;
      return run().finally(release);
    }
    return new Promise((resolve, reject) => {
      queue.push(() => run().then(resolve, reject).finally(release));
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

  return { ensure, segment, warm, manifest, drop: id => store.deleteNarration(id), enabled: isTtsConfigured };
}

/* Before a segment is synthesised its length is a guess, and the player needs
   one to draw a scrub bar. Measured against real output, prose lands near 15.5
   characters a second at normal pace; the clipped, full-stopped opening and
   closing lines run slower. The real duration replaces this as audio arrives. */
const CHARS_PER_SECOND = { intro: 9, outro: 9, heading: 12, caption: 14 };

function estimateDuration(spec, direction) {
  const speed = segmentStyle(spec.kind, direction).speed || 1;
  const rate = (CHARS_PER_SECOND[spec.kind] || 15.5) * speed;
  return Number((spec.chars / rate).toFixed(2));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
