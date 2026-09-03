import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { assertSafeUrl, safeFetch } from './net.js';
import {
  ArchiveChallengeError, fetchAnyMirror, findArchiveSnapshot,
  parseArchiveUrl, stripArchiveChrome,
} from './archive-today.js';
import { isPdfBytes, looksLikePdfUrl, readPdf } from './pdf.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36';

// A PDF is downloaded whole before it can be parsed, so it needs a ceiling.
const PDF_MAX_BYTES = positiveInt(process.env.PDF_MAX_BYTES, 25 * 1024 * 1024);
// A PDF is a document, not a page: these three fetch it, the rest only serve markup.
const HTML_ONLY_STRATEGIES = new Set(['amp', 'archive.today']);

const PAYWALL_MARKERS = [
  'subscribe to continue', 'subscribe to read', 'subscription required', 'to continue reading',
  'already a subscriber', 'sign in to continue', 'create a free account to', 'this article is for subscribers',
  'unlock this article', 'become a member to', 'you have reached your', "you've reached your",
  'register to continue', 'continue reading with', 'get unlimited access',
];

class FetchError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function fetchDocument(url, { ua, referer, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await safeFetch(url, {
      signal: ctrl.signal,
      headers: {
        // ua === false → send no User-Agent (web.archive.org 498s spoofed browser UAs)
        ...(ua === false ? {} : { 'User-Agent': ua || BROWSER_UA }),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { 'Referer': referer } : {}),
      },
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, res.status);
    const ct = res.headers.get('content-type') || '';
    const finalUrl = res.url || url;
    if (ct && /html|xml|text/i.test(ct) && !/pdf/i.test(ct)) {
      return { html: await res.text(), finalUrl };
    }
    // Anything else may still be a PDF announced badly — application/octet-stream,
    // or no type at all — so the bytes decide. A type that could not be one is
    // still rejected on the header, without downloading the body.
    if (ct && !/pdf|octet-stream|binary|download/i.test(ct) && !looksLikePdfUrl(finalUrl)) {
      throw new FetchError(`Not HTML (${ct})`);
    }
    const bytes = await readCapped(res, PDF_MAX_BYTES);
    if (isPdfBytes(bytes)) return { pdf: bytes, finalUrl };
    if (ct) throw new FetchError(`Not HTML (${ct})`);
    return { html: new TextDecoder().decode(bytes), finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, limit) {
  const advertised = Number(res.headers.get('content-length'));
  const tooBig = () => new FetchError(`document is larger than ${Math.round(limit / 1048576)}MB`);
  if (Number.isFinite(advertised) && advertised > limit) throw tooBig();
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw tooBig();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDom(html, url) {
  const vc = new VirtualConsole(); // swallow CSS/JS parse noise from real-world pages
  return new JSDOM(html, { url, virtualConsole: vc });
}

function readabilityParse(dom) {
  const reader = new Readability(dom.window.document, { keepClasses: false });
  return reader.parse();
}

// Readability strips <aside>-style pullquotes on some sites; give obvious pullquote
// elements a blockquote form before parsing so they survive.
function promotePullquotes(dom) {
  const doc = dom.window.document;
  const sel = '[class*="pullquote" i], [class*="pull-quote" i], [class*="blockquote" i], aside[class*="quote" i]';
  for (const el of doc.querySelectorAll(sel)) {
    if (el.closest('blockquote') || el.querySelector('blockquote')) continue;
    const text = (el.textContent || '').trim();
    if (!text || text.length > 600) continue;
    const bq = doc.createElement('blockquote');
    bq.className = 'pullquote';
    bq.innerHTML = el.innerHTML;
    el.replaceWith(bq);
  }
}

function extractMeta(dom) {
  const doc = dom.window.document;
  const get = (sel, attr = 'content') => doc.querySelector(sel)?.getAttribute(attr) || null;
  let publishedAt = get('meta[property="article:published_time"]')
    || get('meta[name="article:published_time"]')
    || get('meta[itemprop="datePublished"]')
    || get('time[datetime]', 'datetime');
  if (!publishedAt) {
    // ld+json fallback
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const n of nodes) {
          if (n && n.datePublished) { publishedAt = n.datePublished; break; }
        }
        if (publishedAt) break;
      } catch { /* ignore malformed ld+json */ }
    }
  }
  return {
    leadImage: get('meta[property="og:image"]') || get('meta[name="twitter:image"]'),
    canonical: get('link[rel="canonical"]', 'href'),
    ampUrl: get('link[rel="amphtml"]', 'href'),
    ogUrl: get('meta[property="og:url"]') || get('meta[name="twitter:url"]'),
    publishedAt,
  };
}

function makeSanitizer() {
  const window = new JSDOM('').window;
  const DOMPurify = createDOMPurify(window);
  return (html) => DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figure', 'figcaption',
      'img', 'a', 'em', 'i', 'strong', 'b', 'u', 's', 'ul', 'ol', 'li', 'pre', 'code', 'hr', 'br',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'sup', 'sub', 'mark', 'cite', 'q',
      'span', 'div', 'section', 'audio', 'video', 'source', 'time', 'abbr', 'dl', 'dt', 'dd'],
    ALLOWED_ATTR: ['href', 'src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'datetime',
      'colspan', 'rowspan', 'class', 'lang', 'dir', 'controls', 'type', 'loading'],
    ALLOW_DATA_ATTR: false,
  });
}
const sanitize = makeSanitizer();

// Route images through our proxy (referer-stripped) and lazy-load them.
function rewriteContent(html, baseUrl) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = dom.window.document;

  for (const img of [...doc.querySelectorAll('img')]) {
    let src = img.getAttribute('src') || '';
    const srcset = img.getAttribute('srcset');
    if ((!src || src.startsWith('data:')) && srcset) {
      // take the largest srcset candidate
      const candidates = srcset.split(',').map(s => s.trim().split(/\s+/));
      candidates.sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0));
      src = candidates[0]?.[0] || src;
    }
    if (!src || src.startsWith('data:')) { img.remove(); continue; }
    try { src = new URL(src, baseUrl).href; } catch { img.remove(); continue; }
    img.setAttribute('src', '/api/image?url=' + encodeURIComponent(src));
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.setAttribute('loading', 'lazy');
  }

  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      a.setAttribute('href', new URL(a.getAttribute('href'), baseUrl).href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    } catch { a.removeAttribute('href'); }
  }

  // drop empty paragraphs/divs left behind by ad slots
  for (const el of [...doc.querySelectorAll('p, div, section, span')]) {
    if (!el.textContent.trim() && !el.querySelector('img, video, audio, iframe, hr')) el.remove();
  }

  return doc.body.innerHTML;
}

function looksPaywalled(text, wordCount) {
  const head = (text || '').slice(0, 4000).toLowerCase();
  const marker = PAYWALL_MARKERS.find(m => head.includes(m));
  if (marker && wordCount < 800) return marker;
  if (wordCount < 120) return 'too short';
  return null;
}

function parseAttempt(html, url, method, { preclean } = {}) {
  const dom = parseDom(html, url);
  preclean?.(dom);
  const meta = extractMeta(dom);
  promotePullquotes(dom);
  const article = readabilityParse(dom);
  if (!article || !article.content) return { ok: false, reason: 'readability found no article', meta };

  const text = (article.textContent || '').trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  const paywallReason = looksPaywalled(text, wordCount);

  const content = rewriteContent(sanitize(article.content), url);
  return {
    ok: !paywallReason,
    reason: paywallReason,
    meta,
    result: {
      title: article.title || dom.window.document.title || url,
      byline: article.byline || null,
      site_name: article.siteName || new URL(url).hostname.replace(/^www\./, ''),
      excerpt: (article.excerpt || text.slice(0, 300)).trim(),
      content_html: content,
      text_content: text,
      word_count: wordCount,
      lead_image: meta.leadImage,
      published_at: meta.publishedAt,
      canonical_url: meta.canonical || url,
      fetch_method: method,
    },
  };
}

/* The PDF twin of parseAttempt: a different reader in the middle, the same
   sanitising, the same rewriting, the same quality verdict on the way out. */
async function parsePdfAttempt(bytes, url, method) {
  let doc;
  try {
    doc = await readPdf(bytes);
  } catch (error) {
    return { ok: false, reason: error.message, meta: {} };
  }

  const text = (doc.text || '').trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  // Glyphs are the only thing a PDF is obliged to carry. A scan carries none,
  // and no amount of retrying elsewhere will produce them.
  if (!wordCount) {
    return { ok: false, meta: {}, reason: `no text layer in ${doc.pageCount} page(s) — a scan, so it needs OCR` };
  }

  const paywallReason = looksPaywalled(text, wordCount);
  const notes = [];
  if (doc.truncated) notes.push(`only part of this ${doc.pageCount}-page PDF was read`);

  return {
    ok: !paywallReason,
    reason: paywallReason,
    meta: {},
    result: {
      title: doc.title || titleFromPath(url),
      byline: doc.byline,
      site_name: new URL(url).hostname.replace(/^www\./, ''),
      excerpt: text.slice(0, 300).trim(),
      content_html: rewriteContent(sanitize(doc.html), url),
      text_content: text,
      word_count: wordCount,
      lead_image: null,
      published_at: doc.publishedAt,
      canonical_url: url,
      fetch_method: `${method} (pdf)`,
      ...(notes.length ? { quality_note: notes.join('; ') } : {}),
    },
  };
}

// A PDF that names itself nothing is at least named by the link that reached it.
function titleFromPath(url) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* keep url */ }
  name = name.replace(/\.pdf$/i, '').replace(/[_+-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name || url;
}

async function waybackLookup(url) {
  const api = 'https://archive.org/wayback/available?url=' + encodeURIComponent(url);
  const res = await safeFetch(api, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = await res.json();
  const snap = data?.archived_snapshots?.closest;
  if (!snap?.available || !snap?.url) return null;
  // id_ suffix returns the original page without the wayback toolbar
  return snap.url.replace(/(\/web\/\d+)\//, '$1id_/');
}

export async function extractArticle(inputUrl, { html, sourceUrl } = {}) {
  const url = normalizeUrl(inputUrl);
  await assertSafeUrl(url);

  // A snapshot handed over by the browser (the captcha rescue path) skips the network.
  if (html) return extractFromHtml(url, html, sourceUrl);

  const pasted = parseArchiveUrl(inputUrl);
  const attempts = [];
  let best = null;      // best failed attempt, kept as fallback content
  let challenge = null; // archive.today captcha a human could clear for us
  let ampUrl = null;

  const archiveAttempt = async (snapshotUrl) => {
    const snapshot = await fetchAnyMirror(snapshotUrl, { userAgent: BROWSER_UA });
    return { ...snapshot, preclean: stripArchiveChrome };
  };

  // A short-code snapshot (/kSJh2) names no origin site, so the mirrors are the
  // only place to ask — hitting example.com's strategies would just be archive.is again.
  const archiveOnly = Boolean(pasted && !pasted.originalUrl);
  const strategies = archiveOnly ? [
    { name: 'archive.today', run: () => archiveAttempt(pasted.snapshotUrl) },
  ] : [
    // A pasted archive.is link is an explicit request: honour it before anything else.
    ...(pasted ? [{ name: 'archive.today', run: () => archiveAttempt(pasted.snapshotUrl) }] : []),
    { name: 'direct', run: () => fetchDocument(url) },
    { name: 'googlebot', run: () => fetchDocument(url, { ua: GOOGLEBOT_UA, referer: 'https://www.google.com/' }) },
    {
      name: 'amp',
      run: async () => {
        if (!ampUrl) throw new FetchError('no AMP version advertised');
        return fetchDocument(ampUrl, { ua: GOOGLEBOT_UA });
      },
    },
    {
      name: 'wayback',
      run: async () => {
        const snapUrl = await waybackLookup(url);
        if (!snapUrl) throw new FetchError('no wayback snapshot');
        try {
          return await fetchDocument(snapUrl, { ua: false, timeout: 30000 });
        } catch {
          // some snapshots refuse the raw id_ variant; the toolbar version still parses
          return fetchDocument(snapUrl.replace('id_/', '/'), { ua: false, timeout: 30000 });
        }
      },
    },
    ...(pasted ? [] : [{
      name: 'archive.today',
      run: async () => {
        const snapshotUrl = await findArchiveSnapshot(url);
        if (!snapshotUrl) throw new FetchError('no archive.today snapshot');
        return archiveAttempt(snapshotUrl);
      },
    }]),
  ];

  let isPdf = looksLikePdfUrl(url);

  for (const strat of strategies) {
    if (isPdf && HTML_ONLY_STRATEGIES.has(strat.name)) continue;
    try {
      const { html: body, pdf, finalUrl, preclean } = await strat.run();
      const base = strat.name === 'wayback' ? url : finalUrl;
      if (pdf) isPdf = true;
      const attempt = pdf
        ? await parsePdfAttempt(pdf, base, strat.name)
        : parseAttempt(body, base, strat.name, { preclean });
      if (attempt.meta?.ampUrl && !ampUrl) {
        try { ampUrl = new URL(attempt.meta.ampUrl, finalUrl).href; } catch { /* bad amp href */ }
      }
      if (attempt.ok) {
        attempt.result.url = url;
        if (archiveOnly) applyCapturedOrigin(attempt.result, attempt.meta, finalUrl);
        return attempt.result;
      }
      attempts.push(`${strat.name}: ${attempt.reason}`);
      if (attempt.result && (!best || attempt.result.word_count > best.word_count)) best = attempt.result;
    } catch (err) {
      if (err instanceof ArchiveChallengeError) challenge = archiveChallenge(err, url);
      attempts.push(`${strat.name}: ${err.message}`);
    }
  }

  if (best) {
    // everything looked truncated/paywalled — keep the longest attempt, flagged partial
    best.url = url;
    best.quality = 'partial';
    best.quality_note = attempts.join('; ');
    if (challenge) best.challenge = challenge;
    return best;
  }
  const err = new Error('Could not extract article. ' + attempts.join('; '));
  err.attempts = attempts;
  if (challenge) {
    err.challenge = challenge;
    err.statusCode = 428; // Precondition Required — a human has to clear the captcha
  }
  throw err;
}

/* A capture reached by short code is still an article on some other site. Move
   it back under that URL so the library dedupes it and "view original" works. */
function applyCapturedOrigin(result, meta, snapshotUrl) {
  const original = parseArchiveUrl(snapshotUrl)?.originalUrl
    || (meta?.ogUrl && !parseArchiveUrl(meta.ogUrl) ? absolute(meta.ogUrl) : null)
    || (meta?.canonical && !parseArchiveUrl(meta.canonical) ? absolute(meta.canonical) : null);
  if (!original) return result;
  result.url = original;
  result.canonical_url = original;
  result.site_name = result.site_name && !/^archive\./.test(result.site_name)
    ? result.site_name
    : new URL(original).hostname.replace(/^www\./, '');
  return result;
}

function absolute(value) {
  try { return new URL(value).href; } catch { return null; }
}

function archiveChallenge(error, url) {
  return {
    provider: 'archive.today',
    snapshot_url: error.challengeUrl,
    original_url: url,
    status: error.status || null,
  };
}

/* Parse HTML the caller already holds — a snapshot the browser fetched, or page
   source a reader pasted in after clearing a captcha by hand. */
export function extractFromHtml(url, source, sourceUrl) {
  const archive = sourceUrl ? parseArchiveUrl(sourceUrl) : null;
  const base = sourceUrl || url;
  const method = archive ? 'archive.today (browser)' : 'browser';
  const html = looksLikeHtml(source) ? String(source) : plainTextToHtml(source);
  const attempt = parseAttempt(html, base, method, { preclean: archive ? stripArchiveChrome : undefined });
  if (!attempt.result) throw new Error(`Could not read that page source: ${attempt.reason}`);

  const result = attempt.result;
  result.url = url;
  result.canonical_url = url;
  // A capture reached by short code belongs to the site it captured, not to archive.today.
  if (parseArchiveUrl(url)) applyCapturedOrigin(result, attempt.meta, sourceUrl || url);
  if (!attempt.ok) {
    result.quality = 'partial';
    result.quality_note = `${method}: ${attempt.reason}`;
  }
  return result;
}

function looksLikeHtml(source) {
  return /<\/?[a-z][\s\S]*>/i.test(String(source || '').slice(0, 4000));
}

/* Copying the rendered page (select all, copy) is the only route left on a
   phone, where there is no view-source. Rebuild paragraphs from the text. */
function plainTextToHtml(source) {
  const lines = String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const [heading, ...body] = lines;
  const escape = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<html><head><title>${escape(heading)}</title></head><body><article>`
    + `<h1>${escape(heading)}</h1>`
    + body.map(line => `<p>${escape(line)}</p>`).join('')
    + '</article></body></html>';
}

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  // An archive.today link identifies the article it captured, so the library
  // dedupes a pasted snapshot against the original story.
  u = parseArchiveUrl(u)?.originalUrl || u;
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs supported');
  // strip common tracking params
  for (const p of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_|cmpid)/i.test(p)) url.searchParams.delete(p);
  }
  url.hash = '';
  return url.href;
}

export { BROWSER_UA };

/* An article body the reader edited by hand comes back through the same filter
   the extractor uses, so a trimmed article is no more trusted than a fetched one.
   Images already point at our proxy and are left alone. */
export function sanitizeArticleHtml(html) {
  return sanitize(String(html || ''));
}

/** Plain text and a word count for an edited body — what search and the reading
    estimate are built from. A block boundary is a word boundary, which is the
    one thing textContent on its own gets wrong. */
export function textFromHtml(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const doc = dom.window.document;
  for (const node of doc.body.querySelectorAll(TEXT_BREAKS)) node.after(doc.createTextNode(' '));
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  return { text, wordCount: text ? text.split(/\s+/).length : 0 };
}

const TEXT_BREAKS = 'p, h1, h2, h3, h4, h5, h6, blockquote, figure, figcaption, li, pre, hr, br,'
  + ' tr, td, th, caption, div, section, dt, dd';
