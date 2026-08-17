import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { assertSafeUrl, safeFetch } from './net.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36';

const PAYWALL_MARKERS = [
  'subscribe to continue', 'subscribe to read', 'subscription required', 'to continue reading',
  'already a subscriber', 'sign in to continue', 'create a free account to', 'this article is for subscribers',
  'unlock this article', 'become a member to', 'you have reached your', "you've reached your",
  'register to continue', 'continue reading with', 'get unlimited access',
];

class FetchError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function fetchHtml(url, { ua, referer, timeout = 20000 } = {}) {
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
    if (ct && !/html|xml|text/i.test(ct)) throw new FetchError(`Not HTML (${ct})`);
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
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

function parseAttempt(html, url, method) {
  const dom = parseDom(html, url);
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

export async function extractArticle(inputUrl) {
  const url = normalizeUrl(inputUrl);
  await assertSafeUrl(url);
  const attempts = [];
  let best = null; // best failed attempt, kept as fallback content
  let ampUrl = null;

  const strategies = [
    { name: 'direct', run: () => fetchHtml(url) },
    { name: 'googlebot', run: () => fetchHtml(url, { ua: GOOGLEBOT_UA, referer: 'https://www.google.com/' }) },
    {
      name: 'amp',
      run: async () => {
        if (!ampUrl) throw new FetchError('no AMP version advertised');
        return fetchHtml(ampUrl, { ua: GOOGLEBOT_UA });
      },
    },
    {
      name: 'wayback',
      run: async () => {
        const snapUrl = await waybackLookup(url);
        if (!snapUrl) throw new FetchError('no wayback snapshot');
        try {
          return await fetchHtml(snapUrl, { ua: false, timeout: 30000 });
        } catch {
          // some snapshots refuse the raw id_ variant; the toolbar version still parses
          return fetchHtml(snapUrl.replace('id_/', '/'), { ua: false, timeout: 30000 });
        }
      },
    },
  ];

  for (const strat of strategies) {
    try {
      const { html, finalUrl } = await strat.run();
      const attempt = parseAttempt(html, strat.name === 'wayback' ? url : finalUrl, strat.name);
      if (attempt.meta?.ampUrl && !ampUrl) {
        try { ampUrl = new URL(attempt.meta.ampUrl, finalUrl).href; } catch { /* bad amp href */ }
      }
      if (attempt.ok) {
        attempt.result.url = url;
        return attempt.result;
      }
      attempts.push(`${strat.name}: ${attempt.reason}`);
      if (attempt.result && (!best || attempt.result.word_count > best.word_count)) best = attempt.result;
    } catch (err) {
      attempts.push(`${strat.name}: ${err.message}`);
    }
  }

  if (best) {
    // everything looked truncated/paywalled — keep the longest attempt, flagged partial
    best.url = url;
    best.quality = 'partial';
    best.quality_note = attempts.join('; ');
    return best;
  }
  const err = new Error('Could not extract article. ' + attempts.join('; '));
  err.attempts = attempts;
  throw err;
}

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
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
