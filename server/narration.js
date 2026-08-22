// Turns a saved article into a narration script: what gets read, in what order,
// with what pacing — and which voice suits this particular piece. Nothing here
// touches the database or the network except the voice catalogue and the
// optional LLM that suggests a direction.
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { listVoices, knownVoice, pinnedVoiceId, VOICE_LOCKED } from './tts.js';
import { isLlmConfigured, directNarration } from './llm.js';

// Bump when the script builder changes shape; cached audio is rebuilt.
export const SCRIPT_VERSION = 1;

const MAX_SEGMENT_CHARS = positiveInt(process.env.TTS_SEGMENT_CHARS, 1100);
const MERGE_UNDER_CHARS = 260;
const MERGE_CEILING_CHARS = 700;

// Every block that can carry prose. Indices into this list are how the reader
// finds the paragraph being spoken, so the client runs the same query.
export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, pre, dt, dd';

const KIND_STYLE = {
  intro:   { speed: 0.98, temperature: 0.60, volume: 0,  gap: 700 },
  heading: { speed: 0.95, temperature: null, volume: 0,  gap: 620 },
  text:    { speed: 1.00, temperature: null, volume: 0,  gap: 300 },
  item:    { speed: 1.00, temperature: null, volume: 0,  gap: 240 },
  quote:   { speed: 0.96, temperature: 0.06, volume: 0,  gap: 500 },  // temperature is a delta
  caption: { speed: 1.02, temperature: null, volume: -2, gap: 380 },
  outro:   { speed: 0.95, temperature: 0.55, volume: -1, gap: 0 },
};

// ── the script ───────────────────────────────────────────────────────────────

/**
 * Walk the extracted article and decide what a person would actually want read
 * aloud: prose in order, headings with room to breathe, quotes set apart,
 * pullquotes that only repeat the body dropped, code and tables left out.
 */
export function buildScript(article, direction = {}) {
  const html = String(article.content_html || '');
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const nodes = [...doc.querySelectorAll(BLOCK_SELECTOR)];

  const blocks = [];
  for (const [index, el] of nodes.entries()) {
    // The outermost matching block owns the text; an inner <p> of a blockquote
    // or a list item would otherwise be read twice.
    if (el.parentElement?.closest(BLOCK_SELECTOR)) continue;
    const kind = blockKind(el);
    if (kind === 'code') {
      blocks.push({ index, kind, text: '', skip: 'code' });
      continue;
    }
    const text = speakable(blockText(el, dom.window), direction.pronunciations);
    if (!hasSpeech(text)) {
      blocks.push({ index, kind, text: '', skip: 'empty' });
      continue;
    }
    blocks.push({ index, kind, text });
  }

  dropDuplicatePullquotes(blocks);

  const segments = [];
  const push = (kind, text, blockIndices, { last = true } = {}) => {
    const style = KIND_STYLE[kind] || KIND_STYLE.text;
    segments.push({
      seq: segments.length,
      kind,
      text,
      blocks: blockIndices,
      gap: last ? style.gap : 140,
      chars: text.length,
    });
  };

  const intro = String(direction.intro ?? defaultIntro(article)).trim();
  if (intro) push('intro', speakable(intro, direction.pronunciations), []);

  const readable = blocks.filter(block => !block.skip);
  for (let i = 0; i < readable.length; i++) {
    const block = readable[i];
    const merged = [block.index];
    let text = block.text;

    // Two short paragraphs in a row are one breath, not two requests.
    while (
      text.length < MERGE_UNDER_CHARS &&
      (block.kind === 'text' || block.kind === 'item') &&
      readable[i + 1]?.kind === block.kind &&
      text.length + readable[i + 1].text.length <= MERGE_CEILING_CHARS
    ) {
      i += 1;
      text = `${text} ${readable[i].text}`;
      merged.push(readable[i].index);
    }

    const parts = splitForSynthesis(text);
    parts.forEach((part, partIndex) => {
      push(block.kind, part, merged, { last: partIndex === parts.length - 1 });
    });
  }

  const outro = String(direction.outro ?? defaultOutro(article)).trim();
  if (outro && readable.length) push('outro', speakable(outro, direction.pronunciations), []);

  return {
    version: SCRIPT_VERSION,
    segments,
    blocks: blocks.map(({ index, kind, skip }) => ({ index, kind, ...(skip ? { skip } : {}) })),
  };
}

function blockKind(el) {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'figcaption') return 'caption';
  if (tag === 'pre') return 'code';
  if (tag === 'li' || tag === 'dt' || tag === 'dd') return 'item';
  return 'text';
}

/* Text as a listener would want it: footnote markers gone, a bare link read as
   its domain rather than spelled out character by character. */
function blockText(el, window) {
  const clone = el.cloneNode(true);
  for (const sup of clone.querySelectorAll('sup')) {
    if (/^[\s\d,\-–[\]a-z*†‡]{1,8}$/i.test(sup.textContent || '')) sup.remove();
  }
  for (const anchor of clone.querySelectorAll('a')) {
    const label = (anchor.textContent || '').trim();
    if (/^https?:\/\/\S+$/i.test(label)) {
      anchor.replaceWith(window.document.createTextNode(sayDomain(label)));
    }
  }
  return clone.textContent || '';
}

// A pullquote is the body text again in a bigger font. Reading it twice is the
// single most jarring thing a naive reader-aloud does.
function dropDuplicatePullquotes(blocks) {
  const body = blocks.filter(b => !b.skip && b.kind === 'text').map(b => flatten(b.text)).join(' ');
  if (!body) return;
  for (const block of blocks) {
    if (block.skip || block.kind !== 'quote') continue;
    const needle = flatten(block.text);
    if (needle.length >= 40 && body.includes(needle)) {
      block.skip = 'duplicate';
      block.text = '';
    }
  }
}

const flatten = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── speech normalisation ─────────────────────────────────────────────────────

const CURRENCY = {
  $: 'dollars', '£': 'pounds', '€': 'euros',
  '¥': 'yen', '₹': 'rupees', '₩': 'won',
};
const MAGNITUDE = { k: 'thousand', m: 'million', bn: 'billion', b: 'billion', tn: 'trillion', t: 'trillion' };

const REWRITES = [
  // invisible characters and layout whitespace
  [/[\u200B-\u200F\u2060\uFEFF]/g, ''],
  [/\u00A0/g, ' '],
  // footnote references, then any remaining short editorial bracket
  [/\[\s*\d{1,3}\s*\]/g, ''],
  [/\[\s*(?:[a-z]|[ivxlc]+)\s*\]/gi, ''],
  [/\[([^\]]{1,40})\]/g, '$1'],
  // links and domains read as words
  [/\bhttps?:\/\/\S+/gi, match => sayDomain(match)],
  [/\b([a-z0-9][a-z0-9-]{1,30})\.(com|org|net|io|co|gov|edu|ai|dev|app|news)\b/gi, '$1 dot $2'],
  // abbreviations a narrator would say in full
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\betc\./gi, 'et cetera'],
  [/\ba\.k\.a\.?/gi, 'also known as'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bcf\.(?=\s)/gi, 'compare'],
  [/\bapprox\./gi, 'approximately'],
  [/\bincl\./gi, 'including'],
  [/\bw\/o\b/gi, 'without'],
  [/\bw\/(?=\s)/gi, 'with'],
  [/\bpp?\.(?=\s*\d)/gi, 'page'],
  [/\bca\.(?=\s*\d)/gi, 'circa'],
  [/\bNo\.(?=\s*\d)/g, 'number'],
  [/\bFig\.(?=\s*\d)/gi, 'figure'],
  [/\band\/or\b/gi, 'and or'],
  [/\s&\s/g, ' and '],
  // money, percentages, spans of years
  [/(?:US)?([$£€¥₹₩])\s?(\d[\d,]*(?:\.\d+)?)\s?(bn|tn|[kmbt])?\b/gi, (_match, symbol, number, magnitude) => {
    const scale = magnitude ? ` ${MAGNITUDE[magnitude.toLowerCase()]}` : '';
    return `${number}${scale} ${CURRENCY[symbol] || 'units'}`;
  }],
  [/(\d)\s?%/g, '$1 percent'],
  [/\b(\d{4})\s?[–—-]\s?(\d{2,4})\b/g, '$1 to $2'],
  [/(\d)\s?–\s?(\d)/g, '$1 to $2'],
  [/(\d)\s?(a\.m\.|p\.m\.|am|pm)\b/gi, (_match, digit, meridiem) => `${digit} ${meridiem.replace(/\./g, '').toUpperCase()}`],
  // an em dash is a pause, not a word
  [/\s*[—―]\s*/g, ', '],
  [/\s*–\s*/g, ', '],
  // tidy up
  [/,\s*,+/g, ','],
  [/\s*,\s*([.!?;:])/g, '$1'],
  [/([!?])\1+/g, '$1'],
  [/\.{4,}/g, '…'],
  [/^\s*[•·▪◦*]\s*/g, ''],
  [/\s+/g, ' '],
];

/** Article text as it should be spoken. Safe to call on any string. */
export function speakable(input, pronunciations) {
  let text = String(input ?? '').trim();
  if (!text) return '';
  for (const [pattern, replacement] of REWRITES) text = text.replace(pattern, replacement);
  text = applyPronunciations(text, pronunciations).trim();
  // a phrase with no closing punctuation is read on a rising note, as if cut off
  if (text && !/[.!?…:;)"'”’]$/.test(text)) text += '.';
  return text;
}

function applyPronunciations(text, pronunciations) {
  if (!Array.isArray(pronunciations)) return text;
  for (const entry of pronunciations.slice(0, 12)) {
    const find = String(entry?.find || '').trim();
    const say = String(entry?.say || '').trim();
    if (!find || !say || find.length > 40) continue;
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^\w/.test(find) ? '\\b' : '';
    const right = /\w$/.test(find) ? '\\b' : '';
    text = text.replace(new RegExp(`${left}${escaped}${right}`, 'gi'), say);
  }
  return text;
}

function sayDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.').join(' dot ');
  } catch {
    return 'a link';
  }
}

const hasSpeech = text => /[\p{L}\p{N}]/u.test(text);

/* Long paragraphs are split on sentence boundaries so no single request runs
   away, and so the pause lands where the writer put a full stop. */
export function splitForSynthesis(text, max = MAX_SEGMENT_CHARS) {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?…]["'”’)\]]?)\s+/);
  const parts = [];
  let current = '';
  const flush = () => { if (current.trim()) parts.push(current.trim()); current = ''; };

  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      for (const piece of hardSplit(sentence, max)) parts.push(piece);
      continue;
    }
    if (current && current.length + sentence.length + 1 > max) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return parts.length ? parts : [text.slice(0, max)];
}

function hardSplit(sentence, max) {
  const parts = [];
  let current = '';
  for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
    if (current && current.length + clause.length + 1 > max) { parts.push(current.trim()); current = ''; }
    if (clause.length > max) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      for (let at = 0; at < clause.length; at += max) parts.push(clause.slice(at, at + max).trim());
      continue;
    }
    current = current ? `${current} ${clause}` : clause;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

// ── framing ──────────────────────────────────────────────────────────────────

function defaultIntro(article) {
  const parts = [];
  if (article.site_name) parts.push(cleanSpoken(article.site_name));
  if (article.title) parts.push(cleanSpoken(article.title));
  const byline = cleanByline(article.byline);
  if (byline) parts.push(`By ${byline}`);
  const minutes = readingMinutes(article);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join('. ');
}

function defaultOutro(article) {
  return article.site_name ? `End of article, from ${cleanSpoken(article.site_name)}.` : 'End of article.';
}

function cleanByline(byline) {
  const value = cleanSpoken(byline).replace(/^by\s+/i, '').split(/\s*[|·•]\s*/)[0].trim();
  return value.length > 1 && value.length <= 80 ? value : '';
}

const cleanSpoken = value => String(value || '').replace(/\s+/g, ' ').trim();
export const readingMinutes = article => Math.max(1, Math.round((article.word_count || 0) / 230));

// ── voice ────────────────────────────────────────────────────────────────────

/* What a piece asks for out loud. A market report and a personal essay want
   different narrators, and the tags the library already stores say which. */
const TONE_PROFILES = [
  {
    id: 'reportage',
    test: /\b(news|politic|policy|election|business|econom|finance|market|war|court|law|crime|investigat)/i,
    want: ['clear', 'professional', 'authoritative', 'crisp', 'measured', 'confident', 'serious', 'narration'],
    speed: 1.03, temperature: 0.6,
  },
  {
    id: 'essay',
    test: /\b(essay|opinion|culture|book|literat|history|philosoph|art|film|movie|music|memoir|review|poet)/i,
    want: ['warm', 'measured', 'storytelling', 'narration', 'calm', 'expressive', 'smooth', 'narrative'],
    speed: 0.97, temperature: 0.78,
  },
  {
    id: 'technical',
    test: /\b(tech|ai|software|programming|engineer|science|research|data|security|physics|biolog|math)/i,
    want: ['clear', 'professional', 'educational', 'neutral-tone', 'crisp', 'calm', 'articulate'],
    speed: 1.0, temperature: 0.58,
  },
  {
    id: 'feature',
    test: /\b(profile|interview|travel|food|sport|health|life|design|fashion|game|feature)/i,
    want: ['conversational', 'friendly', 'warm', 'expressive', 'narration', 'bright', 'host'],
    speed: 1.0, temperature: 0.74,
  },
];
const DEFAULT_PROFILE = {
  id: 'general',
  want: ['narration', 'clear', 'calm', 'measured', 'storytelling', 'professional'],
  speed: 1.0, temperature: 0.7,
};

export function toneProfile(article) {
  const haystack = [article.title, article.site_name, (article.tags || []).join(' '), article.excerpt]
    .filter(Boolean).join(' ');
  const profile = TONE_PROFILES.find(candidate => candidate.test.test(haystack)) || DEFAULT_PROFILE;
  // a long read is a marathon; ease off the pace so it stays listenable
  return (article.word_count || 0) > 2500 ? { ...profile, speed: profile.speed - 0.03 } : profile;
}

/** Rank the catalogue for this article: tag fit first, then a nod to popularity. */
export function shortlistVoices(article, voices, profile = toneProfile(article)) {
  const seed = hashNumber(`${article.id}:${article.url || ''}`);
  const wanted = new Set(profile.want);
  return voices
    .map((voice, index) => {
      const hits = voice.tags.filter(tag => wanted.has(tag)).length;
      const narration = voice.tags.includes('narration') || voice.tags.includes('storytelling') ? 1.5 : 0;
      const popularity = Math.log10(1 + voice.popularity) / 8;
      // a stable per-article jitter so two articles do not always draw the same voice
      const jitter = (((seed + index * 2654435761) >>> 0) % 1000) / 4000;
      return { voice, score: hits * 1.4 + narration + popularity + jitter };
    })
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.voice);
}

export function detectLanguage(text = '') {
  const sample = String(text).slice(0, 4000);
  const count = pattern => (sample.match(pattern) || []).length;
  const letters = count(/\p{L}/gu) || 1;
  if (count(/[぀-ヿ]/g) / letters > 0.05) return 'ja';
  if (count(/[가-힯]/g) / letters > 0.05) return 'ko';
  if (count(/[一-鿿]/g) / letters > 0.1) return 'zh';
  if (count(/[Ѐ-ӿ]/g) / letters > 0.2) return 'ru';
  if (count(/[؀-ۿ]/g) / letters > 0.2) return 'ar';
  return 'en';
}

// ── direction ────────────────────────────────────────────────────────────────

/**
 * Decide how this one article should sound, then write the script for it.
 * With an LLM configured the choice of voice, pace and awkward-word
 * pronunciations comes from reading the piece; without one the tags and the
 * catalogue's own labels do the work.
 */
export async function planNarration(article, { voiceId } = {}) {
  const language = detectLanguage(article.text_content || '');
  const profile = toneProfile(article);
  const voices = VOICE_LOCKED ? [] : await listVoices(language);
  const ranked = shortlistVoices(article, voices, profile);

  const direction = {
    voice_id: pinnedVoiceId || ranked[0]?.id || null,
    voice_name: pinnedVoiceId ? knownVoice(pinnedVoiceId)?.title || 'pinned voice' : ranked[0]?.title || 'default voice',
    tone: profile.id,
    speed: profile.speed,
    temperature: profile.temperature,
    top_p: 0.7,
    pronunciations: [],
    reason: `${profile.id} tone, chosen from the article's subject and length`,
    source: 'heuristic',
  };

  if (isLlmConfigured && !VOICE_LOCKED) {
    try {
      applySuggestion(direction, await directNarration({
        article,
        language,
        profile: profile.id,
        minutes: readingMinutes(article),
        candidates: ranked.slice(0, 16).map(voice => ({
          id: voice.id,
          title: voice.title,
          tags: voice.tags.slice(0, 8).join(', '),
          description: voice.description.slice(0, 140),
        })),
      }), ranked);
    } catch (error) {
      console.error(`narration direction for #${article.id} failed:`, error.message);
    }
  }

  if (voiceId) {
    direction.voice_id = voiceId;
    direction.voice_name = voices.find(voice => voice.id === voiceId)?.title
      || knownVoice(voiceId)?.title || 'chosen voice';
    direction.source = 'manual';
  }
  if (VOICE_LOCKED) {
    direction.voice_id = pinnedVoiceId;
    direction.voice_name = knownVoice(pinnedVoiceId)?.title || 'pinned voice';
    direction.source = 'pinned';
  }

  return { direction, script: buildScript(article, direction), language, contentHash: contentHash(article) };
}

function applySuggestion(direction, suggested, ranked) {
  if (!suggested) return;
  const picked = ranked.find(voice => voice.id === suggested.voice_id);
  if (picked) {
    direction.voice_id = picked.id;
    direction.voice_name = picked.title;
  }
  if (Number.isFinite(suggested.speed)) direction.speed = clamp(suggested.speed, 0.7, 1.25);
  if (Number.isFinite(suggested.temperature)) direction.temperature = clamp(suggested.temperature, 0.3, 0.95);
  if (typeof suggested.tone === 'string' && suggested.tone.trim()) direction.tone = suggested.tone.trim().slice(0, 40);
  if (typeof suggested.intro === 'string' && suggested.intro.trim()) direction.intro = suggested.intro.trim().slice(0, 240);
  if (typeof suggested.reason === 'string' && suggested.reason.trim()) direction.reason = suggested.reason.trim().slice(0, 200);
  if (Array.isArray(suggested.pronunciations)) {
    direction.pronunciations = suggested.pronunciations
      .filter(entry => entry && typeof entry.find === 'string' && typeof entry.say === 'string')
      .slice(0, 12)
      .map(entry => ({ find: entry.find.trim().slice(0, 40), say: entry.say.trim().slice(0, 60) }))
      .filter(entry => entry.find && entry.say);
  }
  direction.source = 'llm';
}

/** Cached audio belongs to one rendering of one article; this is that identity. */
export function contentHash(article) {
  return createHash('sha1')
    .update(`${SCRIPT_VERSION} ${article.title || ''} ${article.byline || ''} ${article.content_html || ''}`)
    .digest('hex');
}

/** Per-segment delivery: a heading slows down, a quote loosens, a caption drops back. */
export function segmentStyle(kind, direction) {
  const style = KIND_STYLE[kind] || KIND_STYLE.text;
  const baseSpeed = Number(direction?.speed) || 1;
  const baseTemperature = Number(direction?.temperature);
  const base = Number.isFinite(baseTemperature) ? baseTemperature : 0.7;
  const temperature = kind === 'quote' ? base + style.temperature : (style.temperature ?? base);
  return {
    speed: clamp(baseSpeed * style.speed, 0.5, 2),
    temperature: clamp(temperature, 0.1, 1),
    topP: clamp(Number(direction?.top_p) || 0.7, 0.1, 1),
    volume: style.volume,
  };
}

function hashNumber(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
