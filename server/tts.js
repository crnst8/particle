// Optional text-to-speech via Fish Audio. Turns a passage of narration script
// into mp3 bytes; particle stores the bytes and nothing else. The feature is
// off until a key is set.
import { endpointIdentity } from './narration-identity.js';
import { ProviderError, errorForStatus, withProviderRetry } from './narration-retry.js';

const API = process.env.TTS_API_URL || 'https://api.fish.audio/v1/tts';
const MODEL_API = process.env.TTS_MODEL_API_URL || 'https://api.fish.audio/model';
const KEY = process.env.TTS_API_KEY || process.env.FISH_AUDIO_API || process.env.FISH_API_KEY || '';
const MODEL = process.env.TTS_MODEL || 's2.1-pro-free';
const BITRATE = clampChoice(Number(process.env.TTS_BITRATE), [64, 128, 192], 64);
const LATENCY = ['normal', 'balanced', 'low'].includes(process.env.TTS_LATENCY) ? process.env.TTS_LATENCY : 'normal';
const PINNED_VOICE = (process.env.TTS_VOICE_ID || '').trim();
/* One provider call, and all the attempts at it. A request that has not
   answered in REQUEST is abandoned and tried again; nothing outlives TOTAL. */
const REQUEST_TIMEOUT_MS = clampInt(process.env.TTS_REQUEST_TIMEOUT_MS, 45_000, 5_000, 300_000);
const TOTAL_TIMEOUT_MS = Math.max(REQUEST_TIMEOUT_MS, clampInt(process.env.TTS_TOTAL_TIMEOUT_MS, 90_000, 10_000, 600_000));
const ATTEMPTS = 3;
/* Voices to keep out of the catalogue by title substring. The provider's public
   catalogue includes clones of real people; whether that is acceptable is the
   operator's call, not particle's, so it is a list rather than a rule. */
const DENIED = (process.env.TTS_VOICE_DENY || '')
  .split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
// 1 = always use TTS_VOICE_ID; the reader cannot choose another.
export const VOICE_LOCKED = process.env.TTS_VOICE_LOCK === '1' && Boolean(PINNED_VOICE);

export const isTtsConfigured = Boolean(KEY);
export const audioFormat = 'mp3';
export const audioMime = 'audio/mpeg';
export const pinnedVoiceId = PINNED_VOICE || null;

// Bump when the silence written after a passage changes how it sounds.
const PAUSE_ALGORITHM = 2;

/* The catalogue's own ordering is by task count, which puts meme and game
   voices first and buries the ones that read prose. Asking for each register
   separately is what puts real narrators in the pool at all. */
const CATALOGUE_TAGS = ['narration', 'storytelling', 'audiobook', 'documentary', 'educational'];

/**
 * Everything the provider is told besides the text and the voice, minus the
 * key. It is part of every variant's revision, so changing the model or the
 * bitrate never serves audio made under the old settings.
 */
export function synthesisConfig(pacing = {}) {
  return {
    endpoint: endpointIdentity(API),
    model: MODEL,
    format: audioFormat,
    bitrate: BITRATE,
    latency: LATENCY,
    normalize: true,
    chunk_length: 300,
    pacing: { speed: Number(pacing.speed) || 1, temperature: Number(pacing.temperature) || 0.7, top_p: Number(pacing.top_p) || 0.7 },
    pause: PAUSE_ALGORITHM,
  };
}

/**
 * One passage. Returns the mp3 bytes plus the duration implied by the constant
 * bitrate, which is what the player needs before the audio loads. `signal`
 * cancels every attempt, including one halfway through reading its body.
 */
export async function synthesize({ text, voiceId, speed = 1, volume = 0, temperature = 0.7, topP = 0.7, pauseMs = 0, signal }) {
  if (!KEY) throw new ProviderError('provider_auth', 'TTS_API_KEY is not set');
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

  const spoken = await withProviderRetry(async (attemptSignal) => {
    const res = await fetch(API, {
      method: 'POST',
      signal: attemptSignal,
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json', 'model': MODEL },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await statusError(res, voiceId);
    // the body is part of the attempt: a connection that drops halfway is retried like any other
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!validateMp3(bytes)) throw new ProviderError('audio_invalid', 'the narration provider sent audio that does not decode', { retryable: true });
    return bytes;
  }, { signal, attempts: ATTEMPTS, requestTimeoutMs: REQUEST_TIMEOUT_MS, totalTimeoutMs: TOTAL_TIMEOUT_MS });

  // The pause that follows this passage is silence inside the file, not a timer
  // in the player: a phone with a locked screen suspends timers, not playback.
  const audio = pauseMs > 0 ? appendSilence(spoken, pauseMs) : spoken;
  return { audio, duration: mp3Duration(audio, BITRATE) };
}

/* What the provider said, as one of our codes. Only a short lower-cased excerpt
   of its body is looked at, to tell a missing voice from another refusal; none
   of it is passed on. */
async function statusError(res, voiceId) {
  let hint = '';
  try { hint = (await res.text()).slice(0, 2000).toLowerCase(); } catch { /* no body */ }
  return errorForStatus(res.status, { voiceId, hint, retryAfter: res.headers.get('retry-after') });
}

// ── mp3 ──────────────────────────────────────────────────────────────────────

// MPEG-1 Layer III, in the order the four header bits index them.
const FRAME_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const FRAME_RATES = [44100, 48000, 32000];

function id3Length(buffer) {
  if (buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    return 10 + (((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f));
  }
  return 0;
}

function frameAt(buffer, i) {
  if (i + 4 > buffer.length || buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buffer[i + 1] >> 3) & 3;   // 3 = MPEG-1
  const layer = (buffer[i + 1] >> 1) & 3;     // 1 = Layer III
  const bitrate = FRAME_BITRATES[(buffer[i + 2] >> 4) & 0xf];
  const sampleRate = FRAME_RATES[(buffer[i + 2] >> 2) & 3];
  if (version !== 3 || layer !== 1 || !bitrate || !sampleRate) return null;
  const padding = (buffer[i + 2] >> 1) & 1;
  const mono = ((buffer[i + 3] >> 6) & 3) === 3;
  const crc = (buffer[i + 1] & 1) === 0;
  return {
    at: i,
    header: buffer.subarray(i, i + 4),
    length: Math.floor((144 * bitrate * 1000) / sampleRate) + padding,
    seconds: 1152 / sampleRate,
    sideInfo: mono ? 17 : 32,
    crc,
  };
}

/* The first audio frame. Every frame in a constant-bitrate stream shares its
   header, so it is also the template for a frame of silence. */
function firstFrame(buffer) {
  for (let i = id3Length(buffer); i < buffer.length - 4; i++) {
    const frame = frameAt(buffer, i);
    if (frame) return frame;
  }
  return null;
}

/** Bytes that start like an mp3 stream: a frame, and another where the first says it ends. */
export function validateMp3(buffer) {
  if (!buffer?.length || buffer.length < 64) return false;
  const start = id3Length(buffer);
  for (let i = start; i < Math.min(buffer.length - 4, start + 4096); i++) {
    const frame = frameAt(buffer, i);
    if (!frame) continue;
    if (i + frame.length >= buffer.length) return i + frame.length <= buffer.length + 1;
    return Boolean(frameAt(buffer, i + frame.length));
  }
  return false;
}

/**
 * Append `ms` of digital silence. Each frame copies the stream's own header
 * (unpadded, no CRC) and carries all-zero side information, which tells the
 * decoder there is no audio data in the frame — a well-formed silent frame,
 * not a guess. If the stream opens with a Xing/Info frame, its frame and byte
 * counts are updated: some browsers take the duration from those counts and
 * would otherwise stop before the pause, or report the wrong length.
 */
export function appendSilence(audio, ms) {
  const frame = firstFrame(audio);
  if (!frame) return audio;
  const count = Math.round((ms / 1000) / frame.seconds);
  if (count < 1) return audio;

  const header = Buffer.from(frame.header);
  header[1] |= 0x01;   // protection bit set: no CRC follows
  header[2] &= ~0x02;  // no padding byte
  const length = frameAt(header, 0).length;
  const pad = Buffer.alloc(length * count);
  for (let i = 0; i < count; i++) header.copy(pad, i * length);

  const out = Buffer.concat([audio, pad]);
  updateXing(out, frame, count, pad.length);
  return out;
}

function updateXing(buffer, frame, addedFrames, addedBytes) {
  const at = frame.at + 4 + (frame.crc ? 2 : 0) + frame.sideInfo;
  const tag = buffer.toString('latin1', at, at + 4);
  if (tag !== 'Xing' && tag !== 'Info') return;
  const flags = buffer.readUInt32BE(at + 4);
  let field = at + 8;
  if (flags & 1) {
    buffer.writeUInt32BE(buffer.readUInt32BE(field) + addedFrames, field);
    field += 4;
  }
  if (flags & 2) buffer.writeUInt32BE(buffer.readUInt32BE(field) + addedBytes, field);
}

/* Constant-bitrate mp3: the duration follows from the payload size once the
   ID3 header is discounted. Good to a few hundredths of a second, and available
   before the browser has downloaded a byte. */
export function mp3Duration(buffer, bitrateKbps = BITRATE) {
  const bytes = Math.max(0, buffer.length - id3Length(buffer));
  return Number((bytes * 8 / (bitrateKbps * 1000)).toFixed(3));
}

// ── the voice catalogue ──────────────────────────────────────────────────────

/** One request per register, plus the general list, for the catalogue to merge. */
export function fetchVoicePages(language = 'en') {
  if (!KEY) return [];
  return [...CATALOGUE_TAGS.map(tag => fetchVoices({ language, tag })), fetchVoices({ language })];
}

async function fetchVoices({ language, tag }) {
  const url = new URL(MODEL_API);
  url.searchParams.set('page_size', '60');
  url.searchParams.set('page_number', '1');
  url.searchParams.set('self', 'false');
  url.searchParams.set('sort_by', 'task_count');
  if (language) url.searchParams.set('language', language);
  if (tag) url.searchParams.set('tag', tag);

  const data = await withProviderRetry(async (signal) => {
    const res = await fetch(url, { signal, headers: { 'Authorization': `Bearer ${KEY}` } });
    if (!res.ok) throw await statusError(res, null);
    return res.json();
  }, { attempts: 2, requestTimeoutMs: 8_000, totalTimeoutMs: 15_000 });

  return (data.items || []).map(item => ({
    id: String(item._id || ''),
    title: String(item.title || '').trim(),
    description: String(item.description || '').trim().slice(0, 400),
    tags: (item.tags || []).map(t => String(t).toLowerCase()),
    languages: item.languages || [],
    popularity: Number(item.task_count) || 0,
    sample: safeSample(item.samples?.[0]?.audio),
    state: item.state,
    visibility: item.visibility,
    takenDown: Boolean(item.dmca_taken_down),
  })).filter(usableForProse);
}

/* Samples play in the reader's browser straight from the provider; only an
   https URL is passed on, never anything that could run or send credentials. */
function safeSample(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Character voices, announcers and shouting are wrong for a 20-minute read.
const UNSUITABLE = new Set([
  'character-voice', 'character', 'anime', 'gaming', 'game', 'egirl', 'robotic', 'mechanical',
  'metallic', 'angry', 'aggressive', 'villainous', 'announcer', 'sports commentary',
  'video game announcer', 'producer tags', 'dj style', 'hip-hop', 'fighting game', 'asmr',
  'vocaloid', 'virtual idol', 'sexy', 'intense', 'monotone', 'digital', 'sci-fi',
]);

// Uploaders sometimes label the problem in the title. Believe them.
const UNSUITABLE_TITLE = /\b(don'?t use|do not use|copyright(ed)?|test(ing)?( ?voice)?|placeholder|sfx|sound ?effect)\b/i;

function usableForProse(voice) {
  if (!voice.id || voice.state !== 'trained' || voice.visibility !== 'public' || voice.takenDown) return false;
  if (!voice.title || UNSUITABLE_TITLE.test(voice.title)) return false;
  if (DENIED.length && DENIED.some(term => voice.title.toLowerCase().includes(term))) return false;
  // A voice with no tags at all cannot be ranked on fit, only on luck.
  if (!voice.tags.length) return false;
  return !voice.tags.some(tag => UNSUITABLE.has(tag));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
