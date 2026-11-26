/* Per-site fetch rules: the request headers, URL changes and page elements that
   get one publication's article out in full where the generic strategies do not.

   The idea and the starting set come from Periscope
   (github.com/reynaldichernando/periscope), which applies Ladder's ruleset
   (github.com/everywall/ladder-rules, MIT, © 2023 everywall) through a fetch
   proxy. particle is its own proxy, so the headers go straight on the server's
   request. Ladder's rules inject a script that removes elements once the page
   loads; particle never runs page scripts, so the selectors those scripts
   removed are listed under `remove` and taken out before Readability reads the
   page. Rules that only rewrite a page's script or CSS have no counterpart here.

   A rule:
     domains  hostnames; "www." is ignored and subdomains match
     paths    optional; the rule applies only under these path prefixes
     headers  request headers, sent instead of the defaults. "" sends none.
     query    search params set on the article URL before it is fetched
     remove   CSS selectors taken out of the page before it is read

   SITE_RULES names a JSON file holding an array of rules in the same shape.
   They are checked before the built-in ones, and the first match wins. */
import { readFileSync } from 'node:fs';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const GOOGLEBOT_NEWS = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; Googlebot-News; +http://www.google.com/bot.html) Chrome/121.0.6140.0 Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

export const BUILT_IN_RULES = [
  {
    domains: ['thestar.com', 'niagarafallsreview.ca', 'stcatharinesstandard.ca', 'thepeterboroughexaminer.com',
      'therecord.com', 'thespec.com', 'wellandtribune.ca'],
    remove: ['div.subscriber-offers', 'div.subscription-required', 'div.redacted-overlay', 'div.subscriber-hide',
      'div.tnt-ads-container', 'div[class*="adLabelWrapper"]', 'div[id^="tncms-region-article"]'],
  },
  {
    domains: ['nytimes.com', 'time.com'],
    headers: {
      'user-agent': GOOGLEBOT,
      cookie: 'nyt-a=; nyt-gdpr=0; nyt-geo=DE; nyt-privacy=1',
      referer: 'https://www.google.com/',
    },
    remove: ['div[data-testid="inline-message"]', 'div[id^="ad-"]', 'div[id^="leaderboard-"]', 'div.expanded-dock',
      'div.pz-ad-box', 'div#top-wrapper', 'div#bottom-wrapper'],
  },
  {
    domains: ['architecturaldigest.com', 'bonappetit.com', 'cntraveler.com', 'epicurious.com', 'gq.com',
      'newyorker.com', 'vanityfair.com', 'vogue.com', 'wired.com'],
    remove: ['.paywall-bar', 'div[class^="MessageBannerWrapper-"]'],
  },
  {
    domains: ['washingtonpost.com'],
    remove: ['div[data-qa$="-ad"]', 'div#leaderboard-wrapper', 'div[data-qa="subscribe-promo"]'],
  },
  {
    domains: ['usatoday.com'],
    remove: ['div.roadblock-container', '.gnt_nb', '[aria-label="advertisement"]', 'div#main-frame-error'],
  },
  {
    domains: ['medium.com'],
    headers: { referer: 'https://t.co/x?amp=1', 'user-agent': CHROME, cookie: '' },
  },
  {
    // the AMP edition carries the whole article
    domains: ['tagesspiegel.de'],
    headers: { 'user-agent': CHROME },
    query: { amp: '1' },
  },
  {
    domains: ['nzz.ch'],
    paths: ['/international', '/sport', '/wirtschaft', '/technologie', '/feuilleton', '/zuerich', '/wissenschaft',
      '/gesellschaft', '/panorama', '/mobilitaet', '/reisen', '/meinung', '/finanze'],
    remove: ['.dynamic-regwall'],
  },
  {
    domains: ['myprivacy.dpgmedia.be', 'myprivacy.dpgmedia.nl'],
    headers: { cookie: 'isBot=true; authId=1', referer: 'https://news.google.com' },
  },
  {
    domains: ['demorgen.be'],
    headers: { cookie: 'isBot=true; authId=1', 'user-agent': GOOGLEBOT_NEWS, referer: 'https://news.google.com' },
    remove: ['div[data-temptation-position="ARTICLE_BOTTOM"]', 'div[data-advert-placeholder-collapses]'],
  },
  {
    domains: ['ft.com'],
    headers: { referer: 'https://t.co/x?amp=1' },
    remove: ['.o-cookie-message', '.js-article-ribbon', '.o-ads', '.o-banner', '.o-message',
      '.article__content-sign-up'],
  },
];

// Headers the fetch itself owns, and ones Ladder sets on the response it serves
// rather than on the request it makes.
const DROPPED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'content-security-policy']);

const RULES = [...loadRuleFile(process.env.SITE_RULES), ...parseRules(BUILT_IN_RULES)];

/* The rule for an article URL, or null. The first rule that matches wins, so a
   rule from SITE_RULES replaces a built-in one for the same site. */
export function ruleFor(input, rules = RULES) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input)); } catch { return null; }
  const host = bareHost(url.hostname);
  for (const rule of rules) {
    if (!rule.domains.some(domain => host === domain || host.endsWith(`.${domain}`))) continue;
    if (rule.paths.length && !rule.paths.some(path => url.pathname.startsWith(path))) continue;
    return rule;
  }
  return null;
}

/* Whether the rule changes the request at all. A rule that only removes
   elements improves every other strategy's attempt and needs no fetch of its own. */
export function changesRequest(rule) {
  return Boolean(rule && (Object.keys(rule.headers).length || Object.keys(rule.query).length));
}

export function ruleUrl(input, rule) {
  const url = new URL(String(input));
  for (const [key, value] of Object.entries(rule?.query || {})) url.searchParams.set(key, value);
  return url.href;
}

export function removeRuleElements(dom, rule) {
  if (!rule?.remove.length) return 0;
  const doc = dom.window.document;
  let removed = 0;
  for (const selector of rule.remove) {
    let found;
    // a selector from SITE_RULES that does not parse should cost that selector, not the save
    try { found = doc.querySelectorAll(selector); } catch { continue; }
    for (const el of found) { el.remove(); removed += 1; }
  }
  return removed;
}

/* Rules as written → rules as used: hosts bare and lowercase, header names
   lowercase, every field present. Throws on a rule that cannot be used, naming
   it, so a mistake in SITE_RULES is reported rather than silently ignored. */
export function parseRules(input) {
  if (!Array.isArray(input)) throw new Error('site rules must be a JSON array');
  return input.map((raw, index) => {
    const where = `rule ${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`${where} is not an object`);
    const domains = list(raw.domains ?? (raw.domain ? [raw.domain] : []), `${where} domains`)
      .map(domain => bareHost(domain)).filter(Boolean);
    if (!domains.length) throw new Error(`${where} names no domain`);

    const headers = {};
    for (const [name, value] of Object.entries(object(raw.headers, `${where} headers`))) {
      const key = name.toLowerCase().trim();
      if (!key || DROPPED_HEADERS.has(key)) continue;
      const text = value === null || value === undefined ? '' : String(value);
      // Ladder writes "none" for a header it wants left off
      if (key === 'x-forwarded-for' && text.toLowerCase() === 'none') continue;
      if (/[\r\n]/.test(text)) throw new Error(`${where} header ${key} contains a line break`);
      headers[key] = text;
    }

    const query = {};
    for (const [key, value] of Object.entries(object(raw.query, `${where} query`))) query[key] = String(value ?? '');

    return {
      domains,
      paths: list(raw.paths ?? [], `${where} paths`).map(String),
      headers,
      query,
      remove: list(raw.remove ?? [], `${where} remove`).map(String).filter(Boolean),
    };
  });
}

function loadRuleFile(path) {
  if (!path) return [];
  try {
    return parseRules(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    console.error(`site rules: ignoring ${path}: ${error.message}`);
    return [];
  }
}

function bareHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function list(value, where) {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value;
}

function object(value, where) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value;
}
