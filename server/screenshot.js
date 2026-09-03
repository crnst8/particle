/* Reading a screenshot for the article it points at.

   The reader is in TikTok, a video mentions a piece worth reading, and the only
   way to keep it is a screenshot. What comes back is mostly not the article:
   a status bar, a search field, like counts, a comment box, the poster's handle
   — and somewhere behind all of it, a headline.

   This module's job is to separate the two and say what the picture refers to,
   in fields. It deliberately does not guess URLs. A guessed URL looks exactly
   like a real one and 404s; `resolve.js` finds real ones from these fields. */

import { isLlmConfigured, readArticleReferences } from './llm.js';
import { ocrEnabled, ocrImage } from './ocr.js';

let canvasLib = null;
const canvas = () => (canvasLib ??= import('@napi-rs/canvas'));

// A phone screenshot is around a megabyte. This is the ceiling on one upload.
const MAX_BYTES = positiveInt(process.env.SCREENSHOT_MAX_BYTES, 12 * 1024 * 1024);
/* What is actually sent to the model. A screenshot is a lossless PNG of a
   photograph — the worst case for PNG — and re-encoding it as JPEG cuts it by
   roughly eight without touching a pixel's position. The caps are set above a
   phone's own screenshot (1206×2622 on this hardware) so the common case is
   only re-encoded, never resampled: the small grey type carrying a domain is
   exactly what a resize destroys, and it is the most valuable line in the
   picture. Anything larger — a tablet, a desktop grab — comes down to fit. */
const SEND_SHORT_EDGE = positiveInt(process.env.SCREENSHOT_SEND_EDGE, 1280);
const SEND_LONG_EDGE = positiveInt(process.env.SCREENSHOT_SEND_LONG_EDGE, 2880);
const SEND_QUALITY = positiveInt(process.env.SCREENSHOT_SEND_QUALITY, 85);
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

export { MAX_BYTES as screenshotMaxBytes };
export const screenshotReadingEnabled = isLlmConfigured || ocrEnabled;

/**
 * Read one screenshot. Prefers a vision model, which can tell a headline from
 * the app's own furniture; falls back to OCR, which cannot, and says so in
 * `source` so the caller can temper how much it trusts the result.
 * Returns { source, poster, candidates: [...] }.
 */
export async function readScreenshot(bytes, mime, onPhase = () => {}) {
  if (!bytes?.length) throw new Error('no image received');
  if (bytes.length > MAX_BYTES) {
    throw new Error(`that image is larger than ${Math.round(MAX_BYTES / 1048576)}MB`);
  }
  const type = imageType(bytes) || (TYPES.has(mime) ? mime : null);
  if (!type) throw new Error('that file is not an image particle can read');

  if (isLlmConfigured) {
    try {
      const packed = await packForModel(bytes, type);
      onPhase('reading', { bytes: packed.image.length, kb: Math.round(packed.image.length / 1024) });
      const started = Date.now();
      const seen = await readArticleReferences({
        image: packed.image.toString('base64'),
        mime: packed.mime,
      });
      const candidates = normalizeCandidates(seen.candidates, { poster: seen.poster });
      log(`read ${Math.round(packed.image.length / 1024)}KB in ${Date.now() - started}ms`
        + ` → ${candidates.length} candidate(s)`);
      if (candidates.length) return { source: 'vision', poster: cleanText(seen.poster), candidates };
      log(`the model reported ${seen.candidates.length} thing(s), none usable as an article;`
        + ' falling back to OCR');
    } catch (error) {
      // A vision model that is unreachable, or is not one, should not lose the
      // screenshot: OCR reads less but reads it locally.
      log(`vision read failed — ${error.message}; falling back to OCR`, 'error');
      if (error.reply) log(`the model said: ${error.reply}`, 'error');
    }
  }

  if (!ocrEnabled) throw new Error('particle cannot read screenshots: set LLM_API_KEY, or leave OCR on');
  onPhase('reading', { ocr: true });
  const started = Date.now();
  const lines = await ocrImage(bytes);
  const candidates = interpretLines(lines);
  log(`ocr read ${lines.length} line(s) in ${Date.now() - started}ms → ${candidates.length} candidate(s)`);
  if (!candidates.length) throw new Error('no article could be read out of that screenshot');
  return { source: 'ocr', poster: null, candidates };
}

/* Cut the upload down before the model ever sees it. Almost all of the wait on
   a screenshot is the picture going over the wire and being taken apart at the
   other end, and a phone's PNG is several megabytes of losslessly encoded
   photograph. This does not resample a phone screenshot at all — it re-encodes
   it — and only resizes what is genuinely bigger than one. */
export async function packForModel(bytes, mime) {
  try {
    const { createCanvas, loadImage } = await canvas();
    const image = await loadImage(bytes);
    const scale = Math.min(
      1,
      SEND_SHORT_EDGE / Math.min(image.width, image.height),
      SEND_LONG_EDGE / Math.max(image.width, image.height),
    );
    const surface = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    surface.getContext('2d').drawImage(image, 0, 0, surface.width, surface.height);
    const packed = surface.encodeSync('jpeg', SEND_QUALITY);
    // A picture that was already small and flat can come back bigger as a JPEG.
    if (packed.length < bytes.length) {
      if (scale < 1) log(`scaled ${image.width}×${image.height} → ${surface.width}×${surface.height}`);
      return { image: packed, mime: 'image/jpeg' };
    }
  } catch (error) {
    log(`could not repack the image (${error.message}); sending it as it came`, 'error');
  }
  return { image: bytes, mime };
}

/* ── the shape of a reference ─────────────────────────────────────────────── */

/* What the model says it saw, reduced to fields the resolvers can use. Anything
   unrecognised is dropped rather than passed on: a hallucinated URL costs a
   wrong article in the library, an absent one costs one more resolver step. */
export function normalizeCandidates(raw, { poster } = {}) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .map(one => normalizeCandidate(one, { poster }))
    .filter(Boolean)
    // Sorted before the duplicates are dropped, so of two readings of the same
    // article it is the surer one that survives rather than the earlier one.
    .sort((one, other) => other.confidence - one.confidence)
    .filter((one) => {
      const key = `${one.title || one.url}|${one.publication || ''}`.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

export function normalizeCandidate(raw, { poster } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title);
  const url = firstUrl(raw.url);
  // A bare title is all the resolvers need; a bare URL needs nothing at all.
  if (!title && !url) return null;

  const kind = ['article', 'newsletter', 'paper'].includes(raw.kind) ? raw.kind : 'unknown';
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.min(1, Math.max(0, Number(raw.confidence)))
    : 0.5;

  return {
    title: title || null,
    subtitle: cleanText(raw.subtitle),
    publication: cleanText(raw.publication),
    byline: cleanText(raw.byline),
    published: parseLooseDate(raw.published),
    url,
    domain: cleanDomain(raw.domain) || (url ? hostOf(url) : null),
    kind,
    excerpt: cleanText(raw.excerpt),
    // The poster is not the author, but on a personal newsletter it usually is,
    // and it is the only name some screenshots carry at all.
    poster: cleanText(poster),
    confidence,
  };
}

/* ── reading what OCR gives back ──────────────────────────────────────────── */

/* Without a vision model there is no one to say which line is the headline, so
   geometry has to. The largest run of type that is not app furniture is the
   title; a legible domain anywhere is worth more than any of it. */
export function interpretLines(lines) {
  const content = (lines || []).filter(line => line.text && !isChromeLine(line.text));
  if (!content.length) return [];

  const url = content.map(line => firstUrl(line.text)).find(Boolean) || null;
  const domain = content.map(line => firstDomain(line.text)).find(Boolean) || null;
  const published = content.map(line => parseLooseDate(line.text)).find(Boolean) || null;

  const title = cleanTitle(headlineOf(content));
  if (!title && !url) return [];

  return [{
    title: title || null,
    subtitle: null,
    publication: null,
    byline: null,
    published,
    url,
    domain: domain || (url ? hostOf(url) : null),
    kind: 'unknown',
    excerpt: null,
    poster: null,
    // OCR read it without understanding it, and it shows: the caller offers
    // rather than saves on this.
    confidence: url ? 0.5 : 0.3,
  }];
}

/* The headline, out of everything on the screen that is set that large.

   Type size alone is not enough. On a social post the caption underneath is
   frequently set as large as the headline above it, and taking every big line
   on the page glues the two into one sentence — which is what a screenshot of a
   post that both shows an article and lists it in the caption used to produce.
   So the big lines are grouped into blocks that actually sit together, and the
   first block wins: a headline is above its caption, always. */
export function headlineOf(content) {
  const tallest = Math.max(...content.map(line => line.height));
  // Lines within a fifth of the tallest are the same type, so a headline that
  // wrapped over two or three lines comes back whole.
  const big = content.filter(line => line.height >= tallest * 0.8)
    .sort((one, other) => one.y - other.y);
  if (!big.length) return null;

  const blocks = [[big[0]]];
  for (const line of big.slice(1)) {
    const previous = blocks.at(-1).at(-1);
    // Consecutive lines of one heading are a line-height apart. Anything more
    // is a different thing on the page that happens to be set the same size.
    const gap = line.y - (previous.y + previous.height);
    if (gap <= previous.height * 1.2) blocks.at(-1).push(line);
    else blocks.push([line]);
  }
  return blocks[0].map(line => line.text).join(' ');
}

/* Furniture, not writing. Matched against the whole line so an article whose
   headline happens to contain "search" survives. */
const CHROME = [
  /^find related content$/i, /^search$/i, /^share$/i, /^subscribe$/i, /^listen$/i,
  /^add comment/i, /^repost to followers$/i, /^more$/i, /^playlist/i, /^effect\b/i,
  /^membership$/i, /^following$/i, /^for you$/i, /^\d+\s*\/\s*\d+$/,
  // engagement counts and the clock, which is the tallest small text on a phone
  /^[\d.,]+[km]?$/i, /^\d{1,2}:\d{2}(\s*[ap]m)?$/i, /^[·•|—–\-\s]*$/,
];

export function isChromeLine(text) {
  const line = String(text || '').trim();
  if (line.length < 2) return true;
  return CHROME.some(pattern => pattern.test(line));
}

/* ── field cleaning ───────────────────────────────────────────────────────── */

export function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /^(null|undefined|unknown|n\/a|none)$/i.test(text)) return null;
  return text.slice(0, 400);
}

/* A headline read off a screen picks up whatever sat at the end of the line —
   a share button, an ellipsis where the app truncated it, stray punctuation. */
export function cleanTitle(value) {
  let text = cleanText(value);
  if (!text) return null;
  text = text
    .replace(/\s*(?:\.{3}|…)\s*(?:more)?\s*$/i, '')
    .replace(/\s+(?:share|subscribe|listen|read more)\s*$/i, '')
    .replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, '')
    .trim();
  return text.length >= 3 ? text.slice(0, 300) : null;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()]+/i;
// A domain has to look like one: at least two labels and a real-looking suffix.
const DOMAIN_PATTERN = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){1,4}(?:com|org|net|io|co|dev|news|blog|xyz|me|uk|au|ca|de|fr|nl|substack\.com))\b/i;

export function firstUrl(value) {
  const match = URL_PATTERN.exec(String(value ?? ''));
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,;:)\]]+$/, ''));
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function firstDomain(value) {
  const match = DOMAIN_PATTERN.exec(String(value ?? ''));
  return match ? cleanDomain(match[1]) : null;
}

export function cleanDomain(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!text || !DOMAIN_PATTERN.test(text)) return null;
  return text.replace(/^www\./, '');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/* Dates on these screens are written every way a designer has ever written one:
   "February 18, 2025", "9 APR 2025 AT 16:31", "2025-6-23". Only the day matters
   downstream — it is a tiebreaker between two articles with the same title. */
export function parseLooseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) return isoDate(iso[1], iso[2], iso[3]);

  const monthName = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{4})\\b`, 'i').exec(text);
  if (monthName) return isoDate(monthName[3], MONTHS.indexOf(monthName[2].toLowerCase().slice(0, 3)) + 1, monthName[1]);

  const nameFirst = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(text);
  if (nameFirst) return isoDate(nameFirst[3], MONTHS.indexOf(nameFirst[1].toLowerCase().slice(0, 3)) + 1, nameFirst[2]);

  return null;
}

function isoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* ── bytes ────────────────────────────────────────────────────────────────── */

/* The bytes decide what the file is, not the header the browser guessed. A
   phone hands over PNG, JPEG or HEIC depending on which app did the sharing. */
export function imageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const at = (offset, ...values) => values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  // HEIC/HEIF: a box-structured file whose brand sits after the size field.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(brand)) return 'image/heic';
  }
  return null;
}

/* Every stage says what it did and how long it took. A screenshot is the one
   save that can take a minute, and without this there is no telling from the
   outside whether that was the model, the lookup, or the article itself —
   `./dev.sh logs screenshot`, or `docker logs particle` on a live one.
   Stamped because a container's log is read hours after the fact; failures are
   never silenced, only the running commentary. */
const LOGGING = process.env.SCREENSHOT_LOG !== '0';

export function log(message, level = 'log') {
  if (!LOGGING && level !== 'error') return;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console[level === 'error' ? 'error' : 'log'](`${at} [screenshot] ${redact(message)}`);
}

/* A provider's error text can carry back the request that caused it, and some
   providers take their key in the query string rather than a header — so a
   failure is one of the few things that can put a key somewhere it is kept.
   The container's log is now a file that survives the request, so it is worth
   the two regexes. */
export function redact(text) {
  return String(text ?? '')
    .replace(/([?&](?:key|api[-_]?key|access[-_]?token|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b(sk-|pk-|Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1[redacted]');
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
