import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  BUILT_IN_RULES, changesRequest, parseRules, removeRuleElements, ruleFor, ruleUrl,
} from '../server/site-rules.js';
import { extractArticle, extractFromHtml, normalizeUrl, requestHeaders } from '../server/extract.js';
import { claimTicket, createTicket, readTicket, settleTicket } from '../server/handoff.js';

const BODY = Array.from({ length: 40 }, (_, i) => `<p>Sentence ${i} about the reporting in this story.</p>`).join('');

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input instanceof URL ? input.href : input), init || {});
  return () => { globalThis.fetch = original; };
}

const html = (inner, status = 200) => new Response(inner, { status, headers: { 'content-type': 'text/html' } });

test('a rule matches its domains with or without www, and their subdomains', () => {
  const rules = parseRules([{ domains: ['www.nytimes.com'], headers: { referer: 'https://www.google.com/' } }]);
  assert.ok(ruleFor('https://www.nytimes.com/2026/01/01/a.html', rules));
  assert.ok(ruleFor('https://nytimes.com/a', rules));
  assert.ok(ruleFor('https://cooking.nytimes.com/a', rules));
  assert.equal(ruleFor('https://notnytimes.com/a', rules), null);
  assert.equal(ruleFor('not a url', rules), null);
});

test('a rule with paths applies only under them, and the first match wins', () => {
  const rules = parseRules([
    { domain: 'example.com', paths: ['/news'], remove: ['.gate'] },
    { domain: 'example.com', remove: ['.other'] },
  ]);
  assert.deepEqual(ruleFor('https://example.com/news/a', rules).remove, ['.gate']);
  assert.deepEqual(ruleFor('https://example.com/blog/a', rules).remove, ['.other']);
});

test('rules are normalised and a broken rule is reported, not skipped', () => {
  const [rule] = parseRules([{
    domains: ['WWW.Example.COM'],
    headers: { 'User-Agent': 'x', Host: 'evil', 'Content-Security-Policy': "script-src 'self'", 'X-Forwarded-For': 'none', cookie: null },
    query: { amp: 1 },
  }]);
  assert.deepEqual(rule.domains, ['example.com']);
  assert.deepEqual(rule.headers, { 'user-agent': 'x', cookie: '' });
  assert.deepEqual(rule.query, { amp: '1' });

  assert.throws(() => parseRules({}), /JSON array/);
  assert.throws(() => parseRules([{ headers: {} }]), /rule 1 names no domain/);
  assert.throws(() => parseRules([{ domains: 'a.com' }]), /rule 1 domains must be a list/);
  assert.throws(() => parseRules([{ domains: ['a.com'], headers: { cookie: 'a\r\nb' } }]), /line break/);
});

test('the built-in rules all parse', () => {
  const rules = parseRules(BUILT_IN_RULES);
  assert.equal(rules.length, BUILT_IN_RULES.length);
  assert.ok(changesRequest(ruleFor('https://www.nytimes.com/a', rules)));
  // removal-only rules need no fetch of their own
  assert.equal(changesRequest(ruleFor('https://www.wired.com/story/a', rules)), false);
});

test('a rule sets query params and replaces default headers', () => {
  const [rule] = parseRules([{ domains: ['tagesspiegel.de'], query: { amp: '1' }, headers: { 'user-agent': 'rule-ua', cookie: '' } }]);
  assert.equal(ruleUrl('https://www.tagesspiegel.de/a?x=2', rule), 'https://www.tagesspiegel.de/a?x=2&amp=1');

  const headers = requestHeaders({ headers: rule.headers });
  assert.equal(headers['user-agent'], 'rule-ua');
  assert.equal('cookie' in headers, false);
  assert.ok(headers.accept);
  assert.equal('user-agent' in requestHeaders({ headers: { 'user-agent': '' } }), false);
});

test('rule selectors are removed from the page, and a bad selector costs only itself', () => {
  const dom = new JSDOM('<body><div class="gate">subscribe</div><p>story</p><div id="ad-1">ad</div></body>');
  const [rule] = parseRules([{ domains: ['a.com'], remove: ['.gate', ':::nope', 'div[id^="ad-"]'] }]);
  assert.equal(removeRuleElements(dom, rule), 2);
  assert.equal(dom.window.document.body.textContent, 'story');
});

test('the site rule is tried first with its own headers and URL', async () => {
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  const seen = [];
  const restore = stubFetch(async (url, init) => {
    seen.push({ url, headers: init.headers });
    return html(`<html><head><title>The Headline</title></head><body><article><h1>The Headline</h1>${BODY}</article></body></html>`);
  });
  try {
    const article = await extractArticle('https://www.tagesspiegel.de/politik/story-1');
    assert.equal(article.fetch_method, 'site rules');
    assert.equal(article.url, 'https://www.tagesspiegel.de/politik/story-1');
    assert.equal(seen[0].url, 'https://www.tagesspiegel.de/politik/story-1?amp=1');
    assert.match(seen[0].headers['user-agent'], /Chrome\/119/);
  } finally {
    restore();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
});

test('a paywall banner a rule names is gone from every strategy\'s attempt', async () => {
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  const restore = stubFetch(async () => html(`<html><head><title>T</title></head><body><article><h1>T</h1>
    <div class="paywall-bar">Subscribe to continue reading. Already a subscriber? Sign in.</div>${BODY}</article></body></html>`));
  try {
    const article = await extractArticle('https://www.wired.com/story/a');
    assert.equal(article.fetch_method, 'direct');
    assert.doesNotMatch(article.content_html, /already a subscriber/i);
  } finally {
    restore();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
});

test('archive.today links are read as the article they captured', () => {
  const cases = [
    ['https://archive.is/https://www.example.com/a/b-123/?utm_source=x', 'https://www.example.com/a/b-123/'],
    ['https://archive.ph/20260822021044/https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['https://archive.md/newest/https://example.com/a', 'https://example.com/a'],
    ['https://archive.ph/o/Ab3d/https://example.com/a', 'https://example.com/a'],
  ];
  for (const [input, original] of cases) assert.equal(normalizeUrl(input), original, input);
  assert.throws(() => normalizeUrl('https://archive.is/abcde'), /does not name the article/);
});

test('page source sent from the browser is read against the tab it came from', () => {
  const page = `<html><head><title>T</title></head><body><article><h1>The Real Headline</h1>${BODY}
    <img src="/hero.jpg"><div class="paywall-bar">Subscribe</div></article></body></html>`;
  const article = extractFromHtml('https://www.wired.com/story/a', page, 'https://www.wired.com/story/a?signed-in');
  assert.equal(article.url, 'https://www.wired.com/story/a');
  assert.equal(article.fetch_method, 'browser');
  assert.match(article.content_html, /api\/image\?url=https%3A%2F%2Fwww\.wired\.com%2Fhero\.jpg/);
  assert.doesNotMatch(article.content_html, /Subscribe/);
  // a source address that is not a web page is ignored as a base
  assert.equal(extractFromHtml('https://example.com/s', page, 'javascript:alert(1)').url, 'https://example.com/s');
});

test('copied article text is rebuilt into paragraphs when there is no markup', () => {
  const text = ['The Headline Of The Piece', ...Array.from({ length: 30 },
    (_, i) => `Line ${i} of text copied straight off the rendered page, long enough to read as prose.`)].join('\n');

  const article = extractFromHtml('https://example.com/story', text, 'https://example.com/story');
  assert.equal(article.title, 'The Headline Of The Piece');
  assert.ok(article.word_count > 120);
  assert.match(article.content_html, /<p>Line 0 of text copied/);
});

test('a handoff ticket admits exactly one delivery', () => {
  const { token } = createTicket('https://example.com/story');
  assert.equal(readTicket(token).status, 'pending');

  const ticket = claimTicket(token);
  assert.equal(ticket.url, 'https://example.com/story');
  assert.equal(claimTicket(token), null, 'a replayed token is refused');

  settleTicket(token, { article: { id: 4, title: 'Delivered' } });
  assert.equal(readTicket(token).status, 'ready');
  assert.equal(readTicket(token).article.title, 'Delivered');
  assert.equal(readTicket('not-a-token').status, 'expired');
});

test('a delivery that fails to parse leaves the ticket usable again', () => {
  const { token } = createTicket('https://example.com/story');
  claimTicket(token);
  settleTicket(token, { error: 'Could not read that page source' });

  const state = readTicket(token);
  assert.equal(state.status, 'pending');
  assert.equal(state.error, 'Could not read that page source');
  assert.ok(claimTicket(token), 'the reader can send the page again');
});
