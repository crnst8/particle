/* Turning what a screenshot said into a URL.

   A screenshot names a title, a masthead and sometimes an author. None of that
   is a link, and there is no free general-purpose search left to hand it to.
   What there is, is a handful of publishing platforms that will answer an
   honest question about their own archive for nothing — so this asks them, in
   the order most likely to answer, and stops at the first hit that survives
   verification.

   Verification is the load-bearing half. Guessing "The Culturist" lives at
   theculturist.substack.com finds a real publication of that exact name with
   none of these articles in it; guessing "My Musings" at mymusings.substack.com
   finds a newsletter abandoned in 2020. Both would file the wrong thing
   silently. Nothing is accepted here without the title, and where they exist
   the date and the byline, agreeing with what the picture said. */

import { safeFetch } from './net.js';
import { normalizeUrl } from './extract.js';
import { log } from './screenshot.js';

const TIMEOUT = positiveInt(process.env.RESOLVE_TIMEOUT_MS, 12_000);
// Each host asked costs a round trip; a screenshot is not worth twenty of them.
// The first number bounds the guesses made from a name, the second everything.
const MAX_HOSTS = positiveInt(process.env.RESOLVE_MAX_HOSTS, 6);
const MAX_ASKS = MAX_HOSTS * 2;
// How many of one picture's articles are worth looking up at all.
const MAX_CANDIDATES = positiveInt(process.env.RESOLVE_MAX_CANDIDATES, 4);
// Below this a title match is a coincidence, not a find.
const ACCEPT = 0.72;
// Profile lookups are a second round trip each, before any archive is asked.
const PROFILE_LOOKUPS = positiveInt(process.env.RESOLVE_PROFILE_LOOKUPS, 3);

/**
 * Find where one candidate lives. Returns the candidate with `url`, `matched`
 * (what the archive actually said) and `via` (which resolver answered), or with
 * `url: null` when nothing survived — which is a real answer, not a failure.
 */
export async function resolveCandidate(candidate) {
  if (candidate.url) {
    return { ...candidate, url: normalizeUrl(candidate.url), via: 'in the picture', score: 1, confirmedBy: ['url'] };
  }
  if (!candidate.title) return { ...candidate, url: null, via: null, score: 0, confirmedBy: [] };

  const attempts = [];
  const asked = new Set();
  const good = () => attempts.some(one => one.score >= ACCEPT);
  const ask = async (hosts) => {
    for (const host of hosts) {
      if (asked.size >= MAX_ASKS || good()) return;
      if (!safeHost(host) || asked.has(host)) continue;
      asked.add(host);
      const found = await bestFromArchive(host, candidate).catch(() => null);
      if (found) attempts.push({ ...found, via: `${host} archive` });
    }
  };

  await ask(hostsToTry(candidate));
  // The address a newsletter is served from is often unrelated to its name, so
  // when spelling it out has not worked, ask the person instead.
  if (!good()) await ask(await hostsFromProfiles(candidate));

  if (!good() && looksAcademic(candidate)) {
    const found = await bestFromCrossref(candidate).catch(() => null);
    if (found) attempts.push({ ...found, via: 'crossref' });
  }

  const best = attempts.sort((one, other) => other.score - one.score)[0];
  if (!best || best.score < ACCEPT) {
    return { ...candidate, url: null, via: null, score: best?.score || 0, confirmedBy: [] };
  }
  return {
    ...candidate,
    url: best.url,
    matched: best.matched,
    via: best.via,
    score: best.score,
    confirmedBy: best.confirmedBy,
    // The address was legible on the screen rather than guessed from a name.
    fromReadDomain: Boolean(candidate.domain && best.via?.startsWith(candidate.domain)),
  };
}

/* Resolve a whole reading of a screenshot, strongest first.

   Looked up at once, and only the surest few: a candidate nobody can place
   costs the full round of guesses before it says so, and a caption naming six
   articles would otherwise spend a minute saying no to most of them. */
export async function resolveCandidates(candidates, onResolved = () => {}) {
  const worth = [...candidates]
    .sort((one, other) => other.confidence - one.confidence)
    .slice(0, MAX_CANDIDATES);
  const resolved = await Promise.all(worth.map(async (candidate) => {
    const started = Date.now();
    const one = await resolveCandidate(candidate)
      .catch(() => ({ ...candidate, url: null, via: null, score: 0, confirmedBy: [] }));
    log(`“${(candidate.title || candidate.url || '?').slice(0, 60)}” → ${one.url || 'not found'}`
      + ` (${Date.now() - started}ms${one.via ? `, ${one.via}` : ''}${one.url ? `, ${one.confirmedBy.join('+') || 'title'}` : ''})`);
    onResolved(one);
    return one;
  }));

  return resolved.sort((one, other) =>
    (other.url ? 1 : 0) - (one.url ? 1 : 0)
    || (other.score * other.confidence) - (one.score * one.confidence));
}

/* ── where to ask ─────────────────────────────────────────────────────────── */

/* The hosts worth asking, most likely first. A domain read straight off the
   screen beats every guess; after that the surest route is the person, because
   a newsletter's name and the address it is served from are frequently
   unrelated — "mindbox" is published at contemplationstation.substack.com. */
export function hostsToTry(candidate) {
  const hosts = [];
  const add = (host) => {
    if (host && !hosts.includes(host) && hosts.length < MAX_HOSTS) hosts.push(host);
  };

  add(candidate.domain);
  for (const name of [candidate.publication, candidate.byline, candidate.poster]) {
    for (const host of substackHostsFor(name)) add(host);
  }
  for (const host of siteHostsFor(candidate.publication)) add(host);
  return hosts;
}

/* Substack will say where a person publishes, which is the one route that
   survives a newsletter whose title and address share no letters. The handle is
   a guess at the name as typed, and a wrong guess is a 404, not a wrong answer —
   the archive still has to agree about the article afterwards. */
export async function hostsFromProfiles(candidate) {
  const handles = [candidate.byline, candidate.poster, candidate.publication]
    .flatMap(handleGuesses)
    .filter((handle, index, all) => all.indexOf(handle) === index)
    .slice(0, PROFILE_LOOKUPS);

  const hosts = [];
  for (const handle of handles) {
    const profile = await askJson(`https://substack.com/api/v1/user/${handle}/public_profile`)
      .catch(() => null);
    for (const host of publicationHosts(profile)) {
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/** Every address the publications on a Substack profile are served from. */
export function publicationHosts(profile) {
  const publications = [
    profile?.primaryPublication,
    ...(Array.isArray(profile?.publicationUsers) ? profile.publicationUsers.map(one => one?.publication) : []),
  ];
  return publications
    .map(publication => publication?.custom_domain
      || (publication?.subdomain ? `${publication.subdomain}.substack.com` : null))
    .filter(Boolean)
    .map(host => String(host).replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').toLowerCase())
    // These arrived in somebody else's JSON, so they are checked like any input.
    .map(safeHost)
    .filter(Boolean)
    .filter((host, index, all) => all.indexOf(host) === index);
}

/* A name, as a Substack address might spell it. "Elevated It Girl" is served at
   elevateditgirl.substack.com; "The Culturist" answers to both theculturist and
   culturist, and only one of them is the right publication. */
export function substackHostsFor(name) {
  return handleGuesses(name).map(handle => `${handle}.substack.com`);
}

export function handleGuesses(name) {
  const slug = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  if (slug.length < 3 || slug.length > 40) return [];
  const guesses = [slug];
  const dropped = slug.replace(/^the/, '');
  if (dropped.length >= 3 && dropped !== slug) guesses.push(dropped);
  return guesses;
}

/* A masthead spelled as an ordinary domain — "Vogue Business" at
   voguebusiness.com. Wrong often enough that nothing is accepted on it alone. */
export function siteHostsFor(name) {
  return handleGuesses(name).flatMap(slug => [`${slug}.com`, `www.${slug}.com`]);
}

/* ── asking ───────────────────────────────────────────────────────────────── */

/* Substack's own archive search, which every publication answers for free —
   including the ones on their own domain, which is how theculturist.io is
   reached at all. WordPress answers the same question at a different address,
   and between them they cover most of what people screenshot. */
async function bestFromArchive(host, candidate) {
  const query = encodeURIComponent(searchTerms(candidate));
  const posts = await askJson(`https://${host}/api/v1/archive?sort=new&limit=6&search=${query}`)
    .catch(() => null);

  if (Array.isArray(posts) && posts.length) {
    return pickBest(candidate, posts.map(post => ({
      url: post.canonical_url,
      title: post.title,
      subtitle: post.subtitle,
      published: (post.post_date || '').slice(0, 10),
      byline: (post.publishedBylines || []).map(one => one?.name).filter(Boolean).join(', ') || null,
    })));
  }

  const found = await askJson(`https://${host}/wp-json/wp/v2/search?search=${query}&per_page=6`)
    .catch(() => null);
  if (!Array.isArray(found) || !found.length) return null;
  return pickBest(candidate, found.map(hit => ({
    url: hit.url,
    title: typeof hit.title === 'string' ? hit.title : hit.title?.rendered,
    subtitle: null,
    published: null,
    byline: null,
  })));
}

/* A paper is the one thing here with a proper public index behind it. Crossref
   matches on the bibliography as written, so the authors and the institutions
   read off the title page earn their place in the query. */
async function bestFromCrossref(candidate) {
  const query = encodeURIComponent([candidate.title, candidate.byline, candidate.subtitle]
    .filter(Boolean).join(' '));
  const data = await askJson(
    `https://api.crossref.org/works?query.bibliographic=${query}&rows=4`
    + '&select=title,DOI,URL,container-title,author,issued',
  );
  const items = data?.message?.items;
  if (!Array.isArray(items)) return null;
  return pickBest(candidate, items.map(item => ({
    url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
    title: item.title?.[0],
    subtitle: item['container-title']?.[0] || null,
    published: null,
    byline: (item.author || []).map(one => [one.given, one.family].filter(Boolean).join(' ')).join(', ') || null,
  })));
}

/* A hostname, and nothing else, before it is put into a URL.

   Two of these come from outside: a domain a model read off someone's
   screenshot, and a `custom_domain` field in a reply from Substack. Both are
   interpolated into an address, and `https://${host}/api/...` means something
   very different when the host carries a `@`, a `?` or a slash — the part that
   looks like the host stops being the host. `assertSafeUrl` still blocks the
   private ranges either way; this is the lock in front of it. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function safeHost(host) {
  return typeof host === 'string' && HOSTNAME.test(host) ? host : null;
}

/* Every one of these hosts came out of a picture a stranger could have made, so
   each goes through the same guard the extractor's fetches do. */
async function askJson(url) {
  const res = await safeFetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { Accept: 'application/json', 'User-Agent': 'particle/1.x (+read-later)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/json/i.test(res.headers.get('content-type') || '')) throw new Error('not JSON');
  return res.json();
}

/* The words worth searching on. A subtitle is often what tells two similarly
   titled posts apart, but it also dilutes an exact title match, so it is only
   added when the title is too short to stand on its own. */
export function searchTerms(candidate) {
  const title = String(candidate.title || '');
  if (title.split(/\s+/).length >= 4) return title;
  return [title, candidate.subtitle].filter(Boolean).join(' ');
}

/* ── verification ─────────────────────────────────────────────────────────── */

function pickBest(candidate, found) {
  const scored = found
    .filter(one => one.url && one.title)
    .map(one => ({ url: safeUrl(one.url), matched: one, ...matchDetail(candidate, one) }))
    .filter(one => one.url)
    .sort((one, other) => other.score - one.score);
  return scored[0] || null;
}

/**
 * How much a thing the archive returned looks like the thing in the picture.
 * The title carries it; the date and the byline are there to break the ties the
 * title cannot — a reposted essay, a series where every part shares a name.
 */
export function scoreMatch(candidate, found) {
  return matchDetail(candidate, found).score;
}

/* The same reckoning, with its working shown: which of the things the picture
   said were found again on the other side. One agreement is a title, which a
   coincidence can manage; two independent ones is the article, and that is the
   difference between offering it and simply saving it. */
export function matchDetail(candidate, found) {
  const title = similarity(candidate.title, found.title);
  if (title < 0.45) return { score: title, confirmedBy: [] };

  const confirmedBy = [];
  let score = title;
  if (title > 0.92) confirmedBy.push('title');

  const dates = daysApart(candidate.published, found.published);
  // Screens print a date in the reader's own timezone, so a day either way is
  // the same day. Anything past a month is a different piece wearing the name.
  if (dates !== null) {
    score += dates <= 1 ? 0.12 : dates <= 30 ? 0 : -0.45;
    if (dates <= 1) confirmedBy.push('date');
  }
  if (candidate.byline && found.byline && similarity(candidate.byline, found.byline) > 0.6) {
    score += 0.08;
    confirmedBy.push('byline');
  }
  if (candidate.subtitle && found.subtitle && similarity(candidate.subtitle, found.subtitle) > 0.6) {
    score += 0.05;
    confirmedBy.push('deck');
  }
  return { score: Math.min(1, Math.max(0, score)), confirmedBy };
}

/* Sure enough to file without asking: the title matched outright, and something
   the picture said that is not the title matched too. A domain read straight off
   the screen counts as one of those on its own — it did not have to be guessed. */
export function isCertain(resolved) {
  if (!resolved?.url) return false;
  if (resolved.via === 'in the picture') return true;
  const signals = new Set(resolved.confirmedBy || []);
  if (!signals.has('title') || resolved.score < 0.95) return false;
  return signals.size >= 2 || Boolean(resolved.fromReadDomain);
}

/* Dice over words, not characters: a headline read off a screen loses and gains
   punctuation freely, but rarely loses a whole word. */
export function similarity(one, other) {
  const a = words(one);
  const b = words(other);
  if (!a.length || !b.length) return 0;
  const pool = new Map();
  for (const word of a) pool.set(word, (pool.get(word) || 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = pool.get(word) || 0;
    if (left > 0) { pool.set(word, left - 1); shared += 1; }
  }
  return (2 * shared) / (a.length + b.length);
}

function words(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1);
}

export function daysApart(one, other) {
  if (!one || !other) return null;
  const left = Date.parse(`${one}T00:00:00Z`);
  const right = Date.parse(`${other}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right) / 86_400_000;
}

/* A paper announces itself: institutions under the authors, a journal rather
   than a masthead, and no newsletter furniture anywhere near it. */
export function looksAcademic(candidate) {
  if (candidate.kind === 'paper') return true;
  if (candidate.kind === 'newsletter') return false;
  const text = [candidate.publication, candidate.subtitle, candidate.excerpt].filter(Boolean).join(' ');
  return /\b(university|journal of|proceedings|vol\.?\s*\d|doi|et al\.?|department of)\b/i.test(text);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? normalizeUrl(url.href) : null;
  } catch {
    return null;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
