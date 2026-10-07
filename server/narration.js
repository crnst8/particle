// Turns a saved article into a narration script: which blocks are read, in what
// order, cut into short passages, with what pacing. Pure: nothing here touches
// the database, the network or a model. What is spoken is decided from the
// article's own structure every time, so the same saved text always produces
// the same script — and a cached passage is only reused when that holds.
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { contentRevision, scriptId, hashText } from './narration-identity.js';

// Bump when what is spoken, or how it is cut, changes shape; audio is rebuilt.
export const SCRIPT_VERSION = 3;

/* Every element that can own spoken text. Indices into this list are how the
   reader finds the passage being spoken; the manifest carries the selector so
   the browser runs the same query rather than keeping its own copy. */
export const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, pre, dt, dd, div, section, table';

/* Passages are short: a voice switch repeats at most one of them, and the first
   one arrives quickly. Sentences are kept whole up to `max`; a single sentence
   longer than that is cut at clauses, then words. TTS_SEGMENT_CHARS caps it. */
export const SEGMENT_POLICY = segmentPolicy(process.env.TTS_SEGMENT_CHARS);

export function segmentPolicy(raw) {
  const cap = positiveInt(raw, 0);
  const max = cap ? Math.max(60, Math.min(cap, 2000)) : 450;
  return { target: Math.min(300, max), max };
}

/* `pause` is milliseconds of silence appended to the passage's own audio, so the
   gap between passages survives a locked screen — a suspended phone stops
   running timers long before it stops playing a file. */
const KIND_STYLE = {
  heading: { speed: 0.95, temperature: null, volume: 0, pause: 800 },
  text:    { speed: 1.00, temperature: null, volume: 0, pause: 460 },
  item:    { speed: 1.00, temperature: null, volume: 0, pause: 320 },
  quote:   { speed: 0.96, temperature: 0.06, volume: 0, pause: 640 },  // temperature is a delta
};
// Between two passages of one paragraph that was too long for a single request.
const SPLIT_PAUSE = 200;

// ── what is spoken ───────────────────────────────────────────────────────────

/* Never read aloud, wherever they appear. */
const DROP = 'script, style, noscript, template, img, picture, svg, video, audio, iframe, object, embed, '
  + 'source, math, canvas, button, input, select, textarea';
export const SPEECH_CLASSES = { caption: 'speech-caption', credit: 'speech-credit', info: 'speech-info' };

/* Reasons a block is left out that come from the article's structure or from
   the reader's own mark. These are certain, and "read aloud" cannot undo them. */
const CERTAIN = new Set(['manual', 'table', 'code', 'caption', 'credit', 'metadata']);

/**
 * Every block that owns text, in reading order, with whether it is spoken and,
 * if not, why. Nothing is removed from the stored article: this is a reading
 * of it, and the reader still sees every word.
 *
 * Each text node belongs to exactly one block — its nearest enclosing block
 * element — so a quote's paragraphs, a nested list and bare prose sitting in a
 * div around other paragraphs are each spoken once, in order. Bare text that a
 * child paragraph interrupts becomes one block per run (`run`), so the words
 * after the paragraph are not read before it.
 */
export function classifyNarrationBlocks(article, { document } = {}) {
  const doc = document || new JSDOM(`<body>${String(article?.content_html || '')}</body>`).window.document;
  const nodes = [...doc.body.querySelectorAll(BLOCK_SELECTOR)];
  const indexOf = new Map(nodes.map((el, index) => [el, index]));
  const units = collectUnits(doc, indexOf);

  const blocks = units.map((unit) => {
    const block = { el: unit.el, dom_index: unit.dom_index, run: unit.run, kind: kindOf(unit.el), raw: tidy(unit.text) };
    const certain = certainReason(unit.el);
    if (certain) block.skip_reason = certain;
    block.include = !certain && includedByReader(unit.el);
    block.text = certain ? '' : speakable(block.raw);
    if (!certain && !hasSpeech(block.text)) block.skip_reason = 'empty';
    return block;
  });

  inferExclusions(blocks, article);
  assignIds(blocks);
  return blocks.map(({ el, raw, include, ...block }) => (block.skip_reason ? { ...block, text: '' } : block));
}

/* Walk the body once, in document order, filing each run of text under the
   block element that owns it. */
function collectUnits(doc, indexOf) {
  const units = [];
  const open = new Map();     // owner → its unit being filled
  const emit = (owner, text) => {
    if (!owner || !text) return;
    let unit = open.get(owner);
    if (!unit) {
      unit = { el: owner, dom_index: indexOf.get(owner), text: '' };
      units.push(unit);
      open.set(owner, unit);
    }
    unit.text += text;
  };
  const visit = (node, owner) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { emit(owner, child.data); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (child.matches(DROP)) continue;
      if (tag === 'br' || tag === 'hr') { emit(owner, ' '); continue; }
      if (tag === 'sup' && isFootnoteMarker(child)) continue;
      if (indexOf.has(child)) {
        // a block inside a block: it owns its own words, and the outer block's
        // words after it are a new run, read after it
        if (owner) open.delete(owner);
        visit(child, child);
        open.delete(child);
        continue;
      }
      if (tag === 'a') {
        const label = (child.textContent || '').trim();
        if (/^https?:\/\/\S+$/i.test(label)) { emit(owner, ` ${sayDomain(label)} `); continue; }
      }
      // an inline credit or a reader's mark inside a paragraph drops just those words
      if (inlineExcluded(child)) { emit(owner, ' '); continue; }
      visit(child, owner);
    }
  };
  visit(doc.body, null);

  // runs are counted only once they carry words, so whitespace between child
  // blocks does not shift the numbering
  const kept = units.filter(unit => /[\p{L}\p{N}]/u.test(unit.text)
    || (/\S/.test(unit.text) && certainReason(unit.el)));
  const runs = new Map();
  for (const unit of kept) {
    unit.run = runs.get(unit.el) || 0;
    runs.set(unit.el, unit.run + 1);
  }
  return kept;
}

function kindOf(el) {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (el.closest('blockquote')) return 'quote';
  if (tag === 'li' || tag === 'dt' || tag === 'dd') return 'item';
  return 'text';
}

/* Structure and the reader's own mark, walking out from the block. A reader's
   "skip" anywhere above wins; otherwise the nearest structural reason does. */
function certainReason(el) {
  for (let node = el; node && node.tagName !== 'BODY'; node = node.parentElement) {
    if (node.getAttribute('data-particle-speech') === 'exclude') return 'manual';
  }
  for (let node = el; node && node.tagName !== 'BODY'; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption'].includes(tag)) return 'table';
    if (tag === 'pre') return 'code';
    if (tag === 'figcaption' || node.classList.contains(SPEECH_CLASSES.caption)) return 'caption';
    if (node.classList.contains(SPEECH_CLASSES.credit)) return 'credit';
    if (node.classList.contains(SPEECH_CLASSES.info)) return 'metadata';
  }
  if (codeOnly(el)) return 'code';
  return null;
}

function includedByReader(el) {
  const marked = el.closest('[data-particle-speech]');
  return marked?.getAttribute('data-particle-speech') === 'include';
}

/* An author's name linked inside a sentence is part of the sentence; a credit
   tacked onto the end of one is not. */
function inlineExcluded(el) {
  if (el.getAttribute('data-particle-speech') === 'exclude') return true;
  return el.classList.contains(SPEECH_CLASSES.caption) || el.classList.contains(SPEECH_CLASSES.credit);
}

/* A block that is nothing but code is a listing, even without a <pre>. Inline
   code inside a sentence stays: dropping it would leave the sentence broken. */
function codeOnly(el) {
  if (!el.querySelector('code')) return false;
  const clone = el.cloneNode(true);
  for (const code of clone.querySelectorAll('code')) code.remove();
  for (const inner of clone.querySelectorAll(BLOCK_SELECTOR)) inner.remove();
  return !/[\p{L}\p{N}]/u.test(clone.textContent || '');
}

function isFootnoteMarker(sup) {
  return /^[\s\d,\-–[\]a-z*†‡]{1,8}$/i.test(sup.textContent || '');
}

// ── inferred exclusions ──────────────────────────────────────────────────────
/* Unlabelled structure has to be recognised from the text, which is never
   certain. These rules only ever match a whole short block — a paragraph that
   merely mentions a photo, a date or a byline is prose and is read. Each is
   marked `inferred`, which is what "read aloud" on that block can undo. */

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_CORE = `(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})`;
const TIME = '(?:[,\\s]+(?:at\\s+)?\\d{1,2}[:.]\\d{2}(?:\\s*[ap]\\.?m\\.?)?(?:\\s+[a-z]{2,5})?)?';
const DATE_LINE = new RegExp(`^(?:(?:first\\s+|last\\s+)?(?:published|updated|posted|modified)(?:\\s+on)?:?\\s+)?${DATE_CORE}${TIME}\\.?$`, 'i');
const READING_TIME = /^(?:about\s+)?\d{1,3}\s*(?:-|to)?\s*(?:\d{1,3}\s*)?(?:min|mins|minutes?)(?:\s+(?:read|listen))?\.?$/i;
// names are capitalised; "written by hand, the caption…" is a sentence, not a byline
const NAME = "(?:\\p{Lu}[\\p{L}.'’-]*|de|da|del|van|von|der|den|la|le|al|bin|ibn)";
const BYLINE = new RegExp(`^(?:[Bb]y|[Ww]ords by|[Ww]ritten by|[Ss]tory by|[Rr]eporting by)\\s+${NAME}(?:(?:\\s+|,\\s*|\\s+and\\s+|\\s*&\\s*)${NAME}){0,6}\\.?$`, 'u');
const CREDIT = /^\(?\s*(?:(?:photo(?:graph)?s?|images?|illustrations?|pictures?|graphics?|video|map|chart|artwork)(?:\s+credits?)?\s*(?::|by\b|courtesy\b|via\b|[–—-]\s)|credits?\s*:|source\s*:|©|\(c\)\s|copyright\s|(?:getty images|ap photo|reuters|afp|epa|shutterstock|alamy|ap)\s*(?:\/|$|:|\)))/i;
const BOILERPLATE = /^(?:share(?:\s+this)?(?:\s+(?:article|story|post|page))?|share on [\w ]{1,20}|subscribe(?:\s+(?:now|today|here))?|sign up(?: for| to)?(?: (?:our|the))?(?: free)?(?: daily| weekly)? newsletters?|advertisement|sponsored(?: content)?|related(?: articles| stories| content| reading| coverage)?|read more|read next|continue reading|more from [\w ]{1,40}|follow us(?: on [\w ]{1,20})?|listen to (?:this )?(?:article|story)|skip advert(?:isement)?|print(?: this)?(?: article)?|email(?: this)?(?: article)?|comments?)\s*[.:!]?$/i;

function inferExclusions(blocks, article) {
  const title = canonical(article?.title);
  const site = canonical(article?.site_name);
  const byline = canonical(article?.byline);
  const bylineBare = canonical(String(article?.byline || '').replace(/^\s*by\s+/i, ''));

  // The opening: everything before the first paragraph of real prose. Bylines
  // and datelines repeated by the extraction live here and nowhere else; the
  // title, only before anything has been spoken at all.
  let leading = true;
  let spokenSoFar = 0;
  for (const block of blocks) {
    if (block.skip_reason) continue;
    const text = block.raw;
    if (!block.include) {
      const flat = canonical(text);
      if (!spokenSoFar && title && flat === title) { infer(block, 'title'); continue; }
      if (leading && isMetadataLine(text, { site, byline, bylineBare })) { infer(block, 'metadata'); continue; }
      if (text.length <= 160 && CREDIT.test(text.trim()) && nearImage(block.el)) { infer(block, 'credit'); continue; }
      if (text.length <= 60 && BOILERPLATE.test(text.trim())) { infer(block, 'boilerplate'); continue; }
    }
    if (block.kind === 'text' && wordCount(text) >= 12) leading = false;
    spokenSoFar += 1;
  }

  // A pullquote is the body again in a bigger font. Reading it twice is the
  // single most jarring thing a naive reader-aloud does.
  const body = blocks.filter(b => !b.skip_reason && b.kind !== 'quote').map(b => flatten(b.text)).join(' ');
  if (body) {
    for (const block of blocks) {
      if (block.skip_reason || block.kind !== 'quote' || block.include) continue;
      const needle = flatten(block.text);
      if (needle.length >= 40 && body.includes(needle)) infer(block, 'duplicate');
    }
  }
}

function infer(block, reason) {
  block.skip_reason = reason;
  block.inferred = true;
}

function isMetadataLine(text, { site, byline, bylineBare }) {
  const line = text.trim();
  if (!line || line.length > 160) return false;
  const pieces = line.split(/\s*[·•|]\s*|\s+[–—]\s+/).filter(Boolean);
  return pieces.every((piece) => {
    const flat = canonical(piece);
    if (!flat) return true;
    if (site && flat === site) return true;
    if (byline && (flat === byline || flat === bylineBare || flat === canonical(`by ${bylineBare}`))) return true;
    if (piece.length <= 80 && BYLINE.test(piece)) return true;
    if (piece.length <= 70 && DATE_LINE.test(piece)) return true;
    return READING_TIME.test(piece);
  });
}

/* A credit line is only taken for one when it sits with a picture: inside the
   figure, or straight after (or before) an image. */
function nearImage(el) {
  if (el.closest('figure')) return true;
  const isImage = node => Boolean(node) && (node.matches('img, picture, figure')
    || (Boolean(node.querySelector('img, picture')) && !/[\p{L}\p{N}]/u.test(node.textContent || '')));
  return isImage(el.previousElementSibling) || isImage(el.nextElementSibling);
}

// ── identity ─────────────────────────────────────────────────────────────────
/* A block is named by its own words and which occurrence of them it is, so a
   bookmark on a paragraph survives edits elsewhere in the article. Positions in
   the DOM change with every edit and are only used to find the element. */
function assignIds(blocks) {
  const seen = new Map();
  for (const block of blocks) {
    const key = hashText(canonical(block.raw) || `${block.kind}:${block.dom_index}`);
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    block.id = `b${key}-${occurrence}`;
  }
}

// ── the script ───────────────────────────────────────────────────────────────

/**
 * The spoken script: one or more short passages per spoken block, never one
 * passage across two blocks, with the offsets of each passage in the block's
 * spoken text. Excluded blocks stay in `blocks` with their reason, so the
 * reader can be told why a paragraph is silent.
 */
export function buildScript(article, { policy = SEGMENT_POLICY } = {}) {
  const blocks = classifyNarrationBlocks(article);
  const segments = [];
  for (const block of blocks) {
    if (block.skip_reason) continue;
    const parts = splitForSynthesis(block.text, policy);
    parts.forEach((piece, part) => {
      const style = KIND_STYLE[block.kind] || KIND_STYLE.text;
      segments.push({
        id: `${block.id}.${part}`,
        seq: segments.length,
        block_id: block.id,
        dom_index: block.dom_index,
        run: block.run,
        part,
        kind: block.kind,
        text: piece.text,
        start: piece.start,
        end: piece.end,
        pause: part === parts.length - 1 ? style.pause : SPLIT_PAUSE,
        chars: piece.text.length,
      });
    });
  }
  return {
    version: SCRIPT_VERSION,
    policy: normalisePolicy(policy),
    selector: BLOCK_SELECTOR,
    segments,
    blocks: blocks.map(({ text, ...block }) => block),
  };
}

/** The identities a script is filed under, without building audio. */
export function scriptIdentity(article, { policy = SEGMENT_POLICY } = {}) {
  const content_revision = contentRevision(article);
  return { content_revision, script_id: scriptId(content_revision, SCRIPT_VERSION, normalisePolicy(policy)) };
}

/* How the passages are delivered. Fixed, apart from easing off on a long read:
   it depends only on the saved text, so the same article always sounds the
   same, and changing it is a change of revision rather than a surprise. */
export function pacing(article) {
  return { speed: (article?.word_count || 0) > 2500 ? 0.97 : 1, temperature: 0.7, top_p: 0.7 };
}

/** Per-passage delivery: a heading slows down, a quote loosens. */
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

/* Text is cut into passages near `target` characters, on sentence boundaries,
   so the pause lands where the writer put a full stop. A sentence up to `max`
   stays whole; a longer one is cut at clauses, then between words, and only a
   single unbroken token longer than `max` is ever cut mid-word. Each passage
   keeps its offsets into the block's spoken text, and joining the passages
   with single spaces gives that text back exactly. */
export function splitForSynthesis(text, policy = SEGMENT_POLICY) {
  const { target, max } = normalisePolicy(policy);
  const source = String(text || '');
  if (!source) return [];
  if (source.length <= target) return [{ text: source, start: 0, end: source.length }];

  const pieces = [];
  let current = null;
  const flush = () => { if (current) pieces.push(current); current = null; };
  for (const sentence of spans(source, 0, source.length, /(?<=[.!?…]["'”’)\]]?)\s+/g)) {
    if (sentence.end - sentence.start > max) {
      flush();
      pieces.push(...cutLong(source, sentence, target, max));
      continue;
    }
    if (current && sentence.end - current.start > target) flush();
    current = current ? { start: current.start, end: sentence.end } : sentence;
  }
  flush();
  return pieces.map(({ start, end }) => ({ text: source.slice(start, end), start, end }));
}

/* The separator-delimited stretches of text[from, to), as offsets. */
function spans(text, from, to, separator) {
  const out = [];
  const slice = text.slice(from, to);
  let at = 0;
  for (const match of slice.matchAll(separator)) {
    if (match.index > at) out.push({ start: from + at, end: from + match.index });
    at = match.index + match[0].length;
  }
  if (at < slice.length) out.push({ start: from + at, end: to });
  return out;
}

function cutLong(text, range, target, max) {
  const pieces = [];
  let current = null;
  const flush = () => { if (current) pieces.push(current); current = null; };
  for (const clause of spans(text, range.start, range.end, /(?<=[,;:])\s+/g)) {
    if (clause.end - clause.start > max) {
      flush();
      pieces.push(...cutWords(text, clause, max));
      continue;
    }
    if (current && clause.end - current.start > target) flush();
    current = current ? { start: current.start, end: clause.end } : clause;
  }
  flush();
  return pieces;
}

function cutWords(text, range, max) {
  const pieces = [];
  let start = range.start;
  while (range.end - start > max) {
    const window = text.slice(start, start + max + 1);
    const space = window.lastIndexOf(' ');
    if (space > 0) {
      pieces.push({ start, end: start + space });
      start += space + 1;
    } else {
      // one token longer than a whole passage: the last resort
      pieces.push({ start, end: start + max });
      start += max;
    }
  }
  if (start < range.end) pieces.push({ start, end: range.end });
  return pieces;
}

function normalisePolicy(policy) {
  if (typeof policy === 'number') return { target: Math.min(300, policy), max: policy };
  const max = positiveInt(policy?.max, 450);
  return { target: Math.min(positiveInt(policy?.target, 300), max), max };
}

// ── automatic voice ────────────────────────────────────────────────────────────────────

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


// ── older narrations ─────────────────────────────────────────────────────────
/* Before script v3 a narration was one cumulative clock with an intro line in
   front and merged paragraphs, and the bookmark was seconds on that clock. The
   seconds only mean something against the exact script they were measured on,
   so they are converted once, through that script, to the paragraph they
   pointed at — or not at all. */
const LEGACY_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, pre, dt, dd';
const LEGACY_RATE = { intro: 9, outro: 9, heading: 12, caption: 14 };
const LEGACY_SPEED = { intro: 0.98, heading: 0.95, text: 1, item: 1, quote: 0.96, caption: 1.02, outro: 0.95 };

/** The hash the v2 script builder filed its narration under. */
export function legacyContentHash(article) {
  return createHash('sha1')
    .update(`2 ${article.title || ''} ${article.byline || ''} ${article.content_html || ''}`)
    .digest('hex');
}

/**
 * Where an old bookmark points in today's script: `{ block_id }`, `{ completed }`,
 * or null when it cannot be known. `durations` maps old segment numbers to the
 * measured length of audio that was synthesised for them.
 */
export function mapLegacyPosition(article, legacy, durations, seconds) {
  if (!legacy?.script?.segments?.length || !(seconds > 0)) return null;
  if (legacy.content_hash !== legacyContentHash(article)) return null;

  const speed = Number(legacy.direction?.speed) || 1;
  let at = 0;
  let found = null;
  for (const segment of legacy.script.segments) {
    // the old player never spoke captions unless asked, and never counted them
    if (segment.kind === 'caption') continue;
    const measured = durations.get(segment.seq);
    const length = Number.isFinite(measured) ? measured
      : (segment.chars || 0) / ((LEGACY_RATE[segment.kind] || 15.5) * speed * (LEGACY_SPEED[segment.kind] || 1))
        + (segment.pause || 0) / 1000;
    if (seconds < at + length) { found = segment; break; }
    at += length;
  }
  if (!found || found.kind === 'outro') return { completed: true };

  const dom = new JSDOM(`<body>${String(article.content_html || '')}</body>`);
  const doc = dom.window.document;
  const blocks = classifyNarrationBlocks(article, { document: doc });
  const spoken = blocks.filter(block => !block.skip_reason);
  if (!spoken.length) return null;
  if (found.kind === 'intro' || !found.blocks?.length) return { block_id: spoken[0].id };

  const target = doc.body.querySelectorAll(LEGACY_SELECTOR)[found.blocks[0]];
  if (!target) return null;
  const nodes = [...doc.body.querySelectorAll(BLOCK_SELECTOR)];
  // the first spoken block at or after the old one, in document order
  for (const block of spoken) {
    const el = nodes[block.dom_index];
    if (!el) continue;
    if (el === target || target.contains(el)
      || (target.compareDocumentPosition(el) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)) {
      return { block_id: block.id };
    }
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const flatten = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const canonical = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
const wordCount = s => (String(s).match(/[\p{L}\p{N}]+/gu) || []).length;

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
