// Optional text-to-speech via Fish Audio. Turns a saved article into narration
// audio; particle stores the returned mp3 bytes and nothing else. The feature is
// off until a key is set.
const API = process.env.TTS_API_URL || 'https://api.fish.audio/v1/tts';
const MODEL_API = process.env.TTS_MODEL_API_URL || 'https://api.fish.audio/model';
const KEY = process.env.TTS_API_KEY || process.env.FISH_AUDIO_API || process.env.FISH_API_KEY || '';
const MODEL = process.env.TTS_MODEL || 's2.1-pro-free';
const BITRATE = clampChoice(Number(process.env.TTS_BITRATE), [64, 128, 192], 64);
const LATENCY = ['normal', 'balanced', 'low'].includes(process.env.TTS_LATENCY) ? process.env.TTS_LATENCY : 'normal';
const PINNED_VOICE = (process.env.TTS_VOICE_ID || '').trim();
// 1 = always use TTS_VOICE_ID; per-article voice selection is skipped.
export const VOICE_LOCKED = process.env.TTS_VOICE_LOCK === '1' && Boolean(PINNED_VOICE);

export const isTtsConfigured = Boolean(KEY);
export const audioFormat = 'mp3';
export const audioMime = 'audio/mpeg';
export const pinnedVoiceId = PINNED_VOICE || null;

const VOICE_TTL_MS = 60 * 60 * 1000;
const voiceCache = new Map();   // language → { at, voices }
const voiceById = new Map();    // id → voice (whatever we have already seen)

/**
 * One synthesis call. Returns the mp3 bytes plus the duration implied by the
 * constant bitrate, which is what the player needs before the audio loads.
 */
export async function synthesize({ text, voiceId, speed = 1, volume = 0, temperature = 0.7, topP = 0.7, pauseMs = 0 }) {
  if (!KEY) throw new Error('TTS_API_KEY not set');
  const body = {
    text,
    format: audioFormat,
    mp3_bitrate: BITRATE,
    latency: LATENCY,
    normalize: true,
    chunk_length: 300,
    temperature: clamp(temperature, 0, 1),
    top_p: clamp(topP, 0, 1),
    prosody: { speed: clamp(speed, 0.5, 2), volume: clamp(volume, -20, 20) },
  };
  if (voiceId) body.reference_id = voiceId;

  const res = await withRetry(() => fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'model': MODEL,
    },
    body: JSON.stringify(body),
  }));

  const spoken = Buffer.from(await res.arrayBuffer());
  if (!spoken.length) throw new Error('TTS returned no audio');
  // The pause that follows this passage is silence inside the file, not a timer
  // in the player: a phone with a locked screen suspends timers, not playback.
  const audio = pauseMs > 0 ? appendSilence(spoken, pauseMs) : spoken;
  return { audio, duration: mp3Duration(audio, BITRATE) };
}

// MPEG-1 Layer III, in the order the four header bits index them.
const FRAME_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const FRAME_RATES = [44100, 48000, 32000];

/* Read the first audio frame's header. Every frame in a constant-bitrate stream
   shares it, so it is also the template for a frame of silence. */
function firstFrame(buffer) {
  let at = 0;
  if (buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    at = 10 + (((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14)
      | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f));
  }
  for (let i = at; i < buffer.length - 4; i++) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buffer[i + 1] >> 3) & 3;   // 3 = MPEG-1
    const layer = (buffer[i + 1] >> 1) & 3;     // 1 = Layer III
    const bitrate = FRAME_BITRATES[(buffer[i + 2] >> 4) & 0xf];
    const sampleRate = FRAME_RATES[(buffer[i + 2] >> 2) & 3];
    if (version !== 3 || layer !== 1 || !bitrate || !sampleRate) continue;
    const padding = (buffer[i + 2] >> 1) & 1;
    return {
      header: buffer.subarray(i, i + 4),
      length: Math.floor((144 * bitrate * 1000) / sampleRate) + padding,
      seconds: 1152 / sampleRate,
    };
  }
  return null;
}

/* Frames carrying this stream's own header and an empty payload decode to
   digital silence, so the pause costs nothing to synthesise and joins the
   passage as one continuous file. */
export function appendSilence(audio, ms) {
  const frame = firstFrame(audio);
  if (!frame) return audio;
  const count = Math.round((ms / 1000) / frame.seconds);
  if (count < 1) return audio;
  const pad = Buffer.alloc(frame.length * count);
  for (let i = 0; i < count; i++) frame.header.copy(pad, i * frame.length);
  return Buffer.concat([audio, pad]);
}

/**
 * Public voices from the provider's catalogue, filtered to ones that suit
 * reading prose. Cached for an hour; a failed lookup leaves the provider's own
 * default voice in play rather than breaking narration.
 */
export async function listVoices(language = 'en') {
  const cached = voiceCache.get(language);
  if (cached && Date.now() - cached.at < VOICE_TTL_MS) return cached.voices;
  if (!KEY) return [];

  try {
    const pages = await Promise.all([
      fetchVoices({ language, tag: 'narration' }),
      fetchVoices({ language }),
    ]);
    const seen = new Map();
    for (const voice of pages.flat()) if (!seen.has(voice.id)) seen.set(voice.id, voice);
    const voices = [...seen.values()].filter(usableForProse);
    for (const voice of voices) voiceById.set(voice.id, voice);
    voiceCache.set(language, { at: Date.now(), voices });
    return voices;
  } catch (error) {
    console.error('tts: voice catalogue unavailable:', error.message);
    voiceCache.set(language, { at: Date.now(), voices: cached?.voices || [] });
    return cached?.voices || [];
  }
}

export function knownVoice(id) {
  return id ? voiceById.get(id) || null : null;
}

async function fetchVoices({ language, tag }) {
  const url = new URL(MODEL_API);
  url.searchParams.set('page_size', '60');
  url.searchParams.set('page_number', '1');
  url.searchParams.set('self', 'false');
  url.searchParams.set('sort_by', 'task_count');
  if (language) url.searchParams.set('language', language);
  if (tag) url.searchParams.set('tag', tag);

  const res = await withRetry(() => fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'Authorization': `Bearer ${KEY}` },
  }));
  const data = await res.json();
  return (data.items || []).map(item => ({
    id: item._id,
    title: String(item.title || '').trim(),
    description: String(item.description || '').trim(),
    tags: (item.tags || []).map(t => String(t).toLowerCase()),
    languages: item.languages || [],
    popularity: Number(item.task_count) || 0,
    sample: item.samples?.[0]?.audio || null,
    state: item.state,
    visibility: item.visibility,
    takenDown: Boolean(item.dmca_taken_down),
  }));
}

// Character voices, announcers and shouting are wrong for a 20-minute read.
const UNSUITABLE = new Set([
  'character-voice', 'character', 'anime', 'gaming', 'game', 'egirl', 'robotic', 'mechanical',
  'metallic', 'angry', 'aggressive', 'villainous', 'announcer', 'sports commentary',
  'video game announcer', 'producer tags', 'dj style', 'hip-hop', 'fighting game', 'asmr',
  'vocaloid', 'virtual idol', 'sexy', 'intense', 'monotone', 'digital', 'sci-fi',
]);

function usableForProse(voice) {
  if (voice.state !== 'trained' || voice.visibility !== 'public' || voice.takenDown) return false;
  if (!voice.title) return false;
  return !voice.tags.some(tag => UNSUITABLE.has(tag));
}

export function voiceTags(voice) {
  return voice?.tags || [];
}

async function withRetry(run, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await run();
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      lastError = new Error(`TTS HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      if (!retryable || attempt === attempts - 1) throw lastError;
    } catch (error) {
      lastError = error;
      if (error?.name === 'TimeoutError') lastError = new Error('TTS request timed out');
      if (attempt === attempts - 1) throw lastError;
    }
    await sleep(700 * 2 ** attempt);
  }
  throw lastError;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Constant-bitrate mp3: the duration follows from the payload size once the
   ID3 header is discounted. Good to a few hundredths of a second, and available
   before the browser has downloaded a byte. */
export function mp3Duration(buffer, bitrateKbps = BITRATE) {
  let start = 0;
  if (buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    start = 10 + size;
  }
  const bytes = Math.max(0, buffer.length - start);
  return Number((bytes * 8 / (bitrateKbps * 1000)).toFixed(3));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
