// Turns a saved article into a narration script: what gets read, in what order,
// with what pacing — and which voice suits this particular piece. Nothing here
// touches the database or the network except the voice catalogue and the
// optional LLM that suggests a direction.
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { listVoices, knownVoice, pinnedVoiceId, VOICE_LOCKED } from './tts.js';
import { isLlmConfigured, directNarration } from './llm.js';

// Bump when the script builder changes shape; cached audio is rebuilt.
export const SCRIPT_VERSION = 2;

const MAX_SEGMENT_CHARS = positiveInt(process.env.TTS_SEGMENT_CHARS, 1100);
const MERGE_UNDER_CHARS = 260;
const MERGE_CEILING_CHARS = 700;

// Every block that can carry prose. Indices into this list are how the reader
// finds the paragraph being spoken, so the client runs the same query.
export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, pre, dt, dd';

/* `pause` is milliseconds of silence appended to the segment's own audio, so the
   gap between passages survives a locked screen — a suspended phone stops
   running timers long before it stops playing a file. */
const KIND_STYLE = {
  intro:   { speed: 0.98, temperature: 0.60, volume: 0,  pause: 900 },
  heading: { speed: 0.95, temperature: null, volume: 0,  pause: 800 },
  text:    { speed: 1.00, temperature: null, volume: 0,  pause: 460 },
  item:    { speed: 1.00, temperature: null, volume: 0,  pause: 320 },
  quote:   { speed: 0.96, temperature: 0.06, volume: 0,  pause: 640 },  // temperature is a delta
  caption: { speed: 1.02, temperature: null, volume: -2, pause: 460 },
  outro:   { speed: 0.95, temperature: 0.55, volume: -1, pause: 0 },
};
// Between two halves of one paragraph that was too long for a single request.
const SPLIT_PAUSE = 200;

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
      pause: last ? style.pause : SPLIT_PAUSE,
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

const TITLES = {
  Dr: 'Doctor', Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Prof: 'Professor', Rev: 'Reverend',
  Sen: 'Senator', Rep: 'Representative', Gov: 'Governor', Gen: 'General', Sgt: 'Sergeant',
  Capt: 'Captain', Lt: 'Lieutenant', Col: 'Colonel', Msgr: 'Monsignor', Fr: 'Father',
  Jr: 'Junior', Sr: 'Senior',
};
// "St." is deliberately absent: Saint and Street are not distinguishable here.

const CENTURIES = { 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty' };
const DECADES = {
  '00': 'hundreds', 10: 'tens', 20: 'twenties', 30: 'thirties', 40: 'forties',
  50: 'fifties', 60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties',
};

function sayDecade(century, decade) {
  if (decade === '00') return century === '20' ? 'two thousands' : `${CENTURIES[century]} hundreds`;
  return `${CENTURIES[century]} ${DECADES[decade]}`;
}

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
  // a title's full stop is not the end of a sentence; say the word instead
  [/\b(Dr|Mr|Mrs|Ms|Prof|Rev|Sen|Rep|Gov|Gen|Sgt|Capt|Lt|Col|Msgr|Fr)\.(?=\s+[A-Z])/g,
    (_match, title) => TITLES[title]],
  [/\b(Jr|Sr)\./g, (_match, suffix) => TITLES[suffix]],
  // money, percentages, spans of years
  [/(?:US)?([$£€¥₹₩])\s?(\d[\d,]*(?:\.\d+)?)\s?(bn|tn|[kmbt])?\b/gi, (_match, symbol, number, magnitude) => {
    const scale = magnitude ? ` ${MAGNITUDE[magnitude.toLowerCase()]}` : '';
    return `${number}${scale} ${CURRENCY[symbol] || 'units'}`;
  }],
  [/(\d)\s?%/g, '$1 percent'],
  // decades: "the 2010s" is spoken, not spelled
  [/\b(17|18|19|20)([0-9]0)'?s\b/g, (_match, century, decade) => sayDecade(century, decade)],
  [/['\u2018\u2019]([0-9]0)s\b/g, (_match, decade) => DECADES[decade] || `${decade}s`],
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
   different narrators, and the tags the library already stores say which.
   `clash` is the register that would be wrong for this kind of writing — an
   advertising read on a war report — and costs a voice more than a missing
   `want` tag saves it. */
const TONE_PROFILES = [
  {
    id: 'reportage',
    test: /\b(news|politic|policy|election|business|econom|finance|market|war|court|law|crime|investigat)/i,
    want: ['clear', 'professional', 'authoritative', 'crisp', 'measured', 'confident', 'serious', 'neutral-tone'],
    clash: ['warm', 'gentle', 'intimate', 'soft', 'breathy', 'dramatic', 'mysterious'],
    speed: 1.03, temperature: 0.6,
  },
  {
    id: 'essay',
    test: /\b(essay|opinion|culture|book|literat|history|philosoph|art|film|movie|music|memoir|review|poet)/i,
    want: ['warm', 'measured', 'storytelling', 'calm', 'expressive', 'smooth', 'narrative', 'gentle'],
    clash: ['crisp', 'authoritative', 'fast', 'confident'],
    speed: 0.97, temperature: 0.78,
  },
  {
    id: 'technical',
    test: /\b(tech|ai|software|programming|engineer|science|research|data|security|physics|biolog|math)/i,
    want: ['clear', 'professional', 'educational', 'neutral-tone', 'calm', 'measured', 'teacher', 'articulate'],
    clash: ['dramatic', 'expressive', 'breathy', 'raspy', 'cinematic', 'mysterious'],
    speed: 1.0, temperature: 0.58,
  },
  {
    id: 'feature',
    test: /\b(profile|interview|travel|food|sport|health|life|design|fashion|game|feature)/i,
    want: ['conversational', 'friendly', 'warm', 'expressive', 'bright', 'host', 'smooth', 'sincere'],
    clash: ['serious', 'authoritative', 'deep', 'low', 'slow'],
    speed: 1.0, temperature: 0.74,
  },
];
const DEFAULT_PROFILE = {
  id: 'general',
  want: ['clear', 'calm', 'measured', 'storytelling', 'professional', 'smooth'],
  clash: ['dramatic', 'breathy', 'raspy'],
  speed: 1.0, temperature: 0.7,
};

export function toneProfile(article) {
  const haystack = [article.title, article.site_name, (article.tags || []).join(' '), article.excerpt]
    .filter(Boolean).join(' ');
  const profile = TONE_PROFILES.find(candidate => candidate.test.test(haystack)) || DEFAULT_PROFILE;
  // a long read is a marathon; ease off the pace so it stays listenable
  return (article.word_count || 0) > 2500 ? { ...profile, speed: profile.speed - 0.03 } : profile;
}

/* Whether a voice reads prose at all, kept apart from which prose suits it —
   every profile wants a reader, and none of them wants a brand ambassador. */
const READS_PROSE = new Set([
  'narration', 'storytelling', 'narrative', 'audiobook', 'documentary', 'educational', 'teacher', 'host',
]);
const OFF_REGISTER = new Set([
  'social-media', 'advertisement', 'entertainment', 'influencer', 'motivational', 'fitness',
  'energetic', 'enthusiastic', 'playful', 'animated', 'cheerful', 'fast', 'dynamic', 'high',
]);

/**
 * Rank the catalogue for this article.
 *
 * The old scoring counted matching tags, which quietly meant "whoever wrote the
 * longest tag list wins" — one voice tagged fourteen ways matched every profile
 * and read every article in the library. Fit is now the harmonic mean of how
 * much of the wanted register the voice covers and how much of the voice that
 * register actually is, so breadth stops being an advantage. Popularity is
 * capped low enough to only break ties, and the per-article jitter is wide
 * enough to genuinely reshuffle candidates that fit equally well.
 *
 * `avoid` is the handful of voices the library has heard most recently: still
 * castable, just no longer the obvious answer.
 */
export function shortlistVoices(article, voices, profile = toneProfile(article), { avoid = [] } = {}) {
  const seed = hashNumber(`${article.id}:${article.url || ''}`);
  const wanted = new Set(profile.want);
  const clashing = new Set(profile.clash || []);
  const recent = new Set(avoid);

  const scored = voices.map(voice => ({ voice, score: scoreVoice(voice, { wanted, clashing, recent, seed }) }));

  /* The catalogue carries the same voice several times over under one name,
     re-uploaded by different people. Ranking them separately fills the whole
     shortlist — and the picker — with one narrator wearing six hats. */
  const best = new Map();
  for (const entry of scored) {
    const key = voiceKey(entry.voice);
    if (!best.has(key) || best.get(key).score < entry.score) best.set(key, entry);
  }

  return [...best.values()].sort((a, b) => b.score - a.score).map(entry => entry.voice);
}

function scoreVoice(voice, { wanted, clashing, recent, seed }) {
  const tags = voice.tags || [];
  const matched = tags.filter(tag => wanted.has(tag)).length;
  const coverage = wanted.size ? matched / wanted.size : 0;
  const focus = tags.length ? matched / tags.length : 0;
  // F1: covering the brief and being nothing else both have to be true
  const fit = coverage && focus ? (2 * coverage * focus) / (coverage + focus) : 0;

  const prose = Math.min(2, tags.filter(tag => READS_PROSE.has(tag)).length) * 0.35;
  const off = Math.min(3, tags.filter(tag => OFF_REGISTER.has(tag)).length) * -0.3;
  const clash = Math.min(3, tags.filter(tag => clashing.has(tag)).length) * -0.2;
  // enough to settle a tie, never enough to win one
  const popularity = Math.min(0.15, Math.log10(1 + (voice.popularity || 0)) / 50);
  // stable per article and per voice, so the catalogue growing does not reshuffle
  const jitter = (hashNumber(`${seed}:${voice.id}`) % 1000) / 1667;
  const familiar = recent.has(voice.id) ? -1.1 : 0;

  return fit * 3 + prose + off + clash + popularity + jitter + familiar;
}

const voiceKey = voice => String(voice.title || voice.id).toLowerCase().replace(/[^a-z0-9]+/g, '');

/* What the panel says about the casting when no model wrote a reason. The
   voice's own labels are the honest answer: they are what it was picked on. */
export function castingReason(voice, profile) {
  if (!voice) return `${profile.id} tone, chosen from the article's subject and length`;
  const wanted = new Set(profile.want);
  const qualities = (voice.tags || []).filter(tag => wanted.has(tag) || READS_PROSE.has(tag)).slice(0, 3);
  if (!qualities.length) return `${profile.id} tone, chosen from the article's subject and length`;
  return `${qualities.join(', ')} — cast for a ${profile.id} piece`;
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
 *
 * `reuse` is the direction of a narration of this same text. When the reader
 * picks a voice there is nothing left to decide — the pacing and the awkward
 * words belong to the article, not to whoever reads it — so the direction is
 * carried over and no model is asked again. That is what makes a swap quick.
 */
export async function planNarration(article, { voiceId, reuse, avoid = [], onStage = () => {} } = {}) {
  const language = detectLanguage(article.text_content || '');
  const profile = toneProfile(article);

  if (voiceId && reuse && !VOICE_LOCKED) {
    onStage('casting', { detail: 'keeping the direction, swapping the voice' });
    // The pacing and the awkward words belong to the article and carry over.
    // The reason does not: it described the voice that was just replaced.
    const chosen = knownVoice(voiceId);
    const direction = {
      ...reuse,
      voice_id: voiceId,
      voice_name: await voiceTitle(voiceId, language),
      source: 'manual',
      reason: chosen ? `${castingReason(chosen, profile)}, chosen by hand` : 'chosen by hand',
    };
    onStage('script', { detail: 'rebuilding the script' });
    return { direction, script: buildScript(article, direction), language, contentHash: contentHash(article) };
  }

  onStage('catalogue', { detail: 'looking over the voice catalogue' });
  const voices = VOICE_LOCKED ? [] : await listVoices(language);
  const ranked = shortlistVoices(article, voices, profile, { avoid });
  onStage('casting', {
    detail: `${ranked.length} voice${ranked.length === 1 ? '' : 's'} ranked for a ${profile.id} piece`,
  });

  const direction = {
    voice_id: pinnedVoiceId || ranked[0]?.id || null,
    voice_name: pinnedVoiceId ? knownVoice(pinnedVoiceId)?.title || 'pinned voice' : ranked[0]?.title || 'default voice',
    tone: profile.id,
    speed: profile.speed,
    temperature: profile.temperature,
    top_p: 0.7,
    pronunciations: [],
    reason: castingReason(ranked[0], profile),
    source: 'heuristic',
  };

  if (isLlmConfigured && !VOICE_LOCKED) {
    onStage('directing', { detail: 'reading the article to cast it' });
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
      onStage('directing', { detail: 'the model did not answer — casting on the article\'s own tags' });
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

  onStage('script', { detail: 'writing the script' });
  return { direction, script: buildScript(article, direction), language, contentHash: contentHash(article) };
}

async function voiceTitle(voiceId, language) {
  const known = knownVoice(voiceId);
  if (known?.title) return known.title;
  try {
    return (await listVoices(language)).find(voice => voice.id === voiceId)?.title || 'chosen voice';
  } catch {
    return 'chosen voice';
  }
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
