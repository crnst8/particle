/* archive.today (archive.is / .ph / .md / …) snapshot lookup and fetching.
   The mirrors share one index but rate-limit per IP, answering 429 with a
   reCAPTCHA page. Those are surfaced as ArchiveChallengeError so the caller
   can hand the snapshot URL to a human instead of failing the extraction. */
import { safeFetch } from './net.js';

const DEFAULT_HOSTS = ['archive.today', 'archive.ph', 'archive.is', 'archive.md', 'archive.li', 'archive.vn', 'archive.fo'];

export const ARCHIVE_HOSTS = parseHosts(process.env.ARCHIVE_TODAY_HOSTS) || DEFAULT_HOSTS;

// Snapshot paths embed the original URL after a prefix: /20260822021044/https://…,
// /newest/https://…, /o/<code>/https://…. Match the first embedded absolute URL.
const EMBEDDED_URL = /(?:^|\/)(https?:(?:\/\/|%2f%2f).+)$/i;
// A challenged page is titled after the mirror itself; a real snapshot carries
// the archived page's own title.
const CHALLENGE_TITLE = /<title>\s*archive\.[a-z]{2,6}\s*<\/title>/i;
const ARCHIVE_CHROME = '#HEADER, #TOOLBAR, #SHARE, #DONATE, #social, #globalhead, #footer, #banner, #CONTROLS';

export class ArchiveChallengeError extends Error {
  constructor(snapshotUrl, status) {
    super('archive.today asked for a captcha');
    this.name = 'ArchiveChallengeError';
    this.code = 'ERR_ARCHIVE_CHALLENGE';
    this.challengeUrl = snapshotUrl;
    this.status = status;
  }
}

function parseHosts(raw) {
  const hosts = String(raw || '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : null;
}

export function isArchiveHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return ARCHIVE_HOSTS.includes(host);
}

/* Recognise a pasted archive URL and, where the mirror embeds it, recover the
   original article URL. Returns null for anything that is not an archive link. */
export function parseArchiveUrl(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input).trim());
  } catch {
    return null;
  }
  if (!isArchiveHost(url.hostname)) return null;

  const embedded = `${url.pathname}${url.search}${url.hash}`.match(EMBEDDED_URL);
  let originalUrl = null;
  if (embedded) {
    try { originalUrl = new URL(decodeURIComponent(embedded[1])).href; } catch { /* not a URL after all */ }
  }
  // A short-code snapshot (/abcde) is still usable — we just cannot name the original.
  return { snapshotUrl: url.href, originalUrl, host: url.hostname };
}

export function looksLikeChallenge(status, html) {
  if (status === 429 || status === 403 || status === 503) return true;
  return CHALLENGE_TITLE.test(String(html || '').slice(0, 4000));
}

function parseTimemap(text) {
  const entries = [];
  for (const [, link, rel, datetime] of String(text).matchAll(
    /<([^>]+)>\s*;\s*rel="([^"]*)"(?:\s*;\s*datetime="([^"]*)")?/g)) {
    if (!/memento/.test(rel)) continue;
    entries.push({ url: link.replace(/^http:/i, 'https:'), rel, at: Date.parse(datetime || '') || 0 });
  }
  return entries;
}

export function pickNewestMemento(entries) {
  if (!entries.length) return null;
  const last = entries.find(entry => /\blast\b/.test(entry.rel));
  if (last) return last.url;
  return [...entries].sort((a, b) => b.at - a.at)[0].url;
}

async function timemapLookup(host, url, signal) {
  const res = await safeFetch(`https://${host}/timemap/${url}`, {
    signal,
    headers: { Accept: 'application/link-format,text/plain,*/*' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (looksLikeChallenge(res.status, text)) return null;
  return pickNewestMemento(parseTimemap(text));
}

async function newestRedirectLookup(host, url, signal) {
  const res = await safeFetch(`https://${host}/newest/${url}`, {
    signal,
    headers: { Accept: 'text/html,*/*' },
  });
  // safeFetch resolves redirects, so the snapshot URL is the final response URL.
  const resolved = res.url || '';
  res.body?.cancel?.().catch(() => {});
  return /\/\d{4,14}[a-z]*\//.test(resolved) ? resolved : null;
}

/* Find the newest snapshot for an article. Never throws for a missing snapshot
   — a null return simply means archive.today has nothing (or would not say). */
export async function findArchiveSnapshot(url, { timeout = 15000, hosts = ARCHIVE_HOSTS } = {}) {
  for (const host of hosts) {
    for (const lookup of [timemapLookup, newestRedirectLookup]) {
      try {
        const found = await lookup(host, url, AbortSignal.timeout(timeout));
        if (found) return found;
      } catch { /* mirror down or throttled — try the next one */ }
    }
  }
  return null;
}

/* Every mirror redirects into the same backend, so a throttled capture stays
   throttled — but which backend you land on varies, and so does the block. */
export function mirrorUrls(snapshotUrl, hosts = ARCHIVE_HOSTS) {
  let url;
  try { url = new URL(snapshotUrl); } catch { return [snapshotUrl]; }
  const rest = `${url.pathname}${url.search}`;
  const ordered = [url.hostname.toLowerCase(), ...hosts.filter(host => host !== url.hostname.toLowerCase())];
  return ordered.map(host => `https://${host}${rest}`);
}

export async function fetchAnyMirror(snapshotUrl, options = {}) {
  let challenge = null;
  for (const candidate of mirrorUrls(snapshotUrl, options.hosts)) {
    try {
      return await fetchArchiveSnapshot(candidate, options);
    } catch (error) {
      if (error instanceof ArchiveChallengeError) challenge ||= error;
      else if (!challenge) challenge = error;
    }
  }
  throw challenge || new Error('no archive.today mirror answered');
}

export async function fetchArchiveSnapshot(snapshotUrl, { timeout = 30000, userAgent, cookie } = {}) {
  const res = await safeFetch(snapshotUrl, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookie || process.env.ARCHIVE_TODAY_COOKIE
        ? { Cookie: cookie || process.env.ARCHIVE_TODAY_COOKIE } : {}),
    },
  });
  const html = await res.text();
  if (looksLikeChallenge(res.status, html)) throw new ArchiveChallengeError(res.url || snapshotUrl, res.status);
  if (!res.ok) throw new Error(`archive.today HTTP ${res.status}`);
  return { html, finalUrl: res.url || snapshotUrl };
}

/* Strip the wrapper archive.today wraps around every capture and point assets
   back at their original hosts where the mirror kept the URL in the path. */
export function stripArchiveChrome(dom) {
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll(ARCHIVE_CHROME)) el.remove();
  for (const el of doc.querySelectorAll('[src], [href]')) {
    for (const attr of ['src', 'href']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const original = unwrapArchiveAsset(value, dom.window.location?.href);
      if (original) el.setAttribute(attr, original);
    }
  }
}

export function unwrapArchiveAsset(value, base) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (!isArchiveHost(url.hostname)) return null;
  const embedded = `${url.pathname}${url.search}`.match(EMBEDDED_URL);
  if (!embedded) return null;
  try { return new URL(decodeURIComponent(embedded[1])).href; } catch { return null; }
}
