import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findArchiveSnapshot, looksLikeChallenge, mirrorUrls, parseArchiveUrl, pickNewestMemento,
  unwrapArchiveAsset,
} from '../server/archive-today.js';
import { extractArticle, extractFromHtml, normalizeUrl } from '../server/extract.js';
import { claimTicket, createTicket, readTicket, settleTicket } from '../server/handoff.js';

const CHALLENGE = '<html><head><title>archive.md</title></head><body>captcha</body></html>';

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input instanceof URL ? input.href : input));
  return () => { globalThis.fetch = original; };
}

test('archive.today links resolve to the article they captured', () => {
  const cases = [
    ['https://archive.is/https://www.example.com/a/b-123/', 'https://www.example.com/a/b-123/'],
    ['https://archive.ph/20260822021044/https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['https://archive.md/newest/https://example.com/a', 'https://example.com/a'],
    ['https://archive.ph/o/Ab3d/https://example.com/a', 'https://example.com/a'],
  ];
  for (const [input, original] of cases) assert.equal(parseArchiveUrl(input).originalUrl, original, input);

  assert.equal(parseArchiveUrl('https://archive.is/abcde').originalUrl, null);
  assert.equal(parseArchiveUrl('https://example.com/a'), null);
});

test('a pasted snapshot is stored under the original article URL', () => {
  assert.equal(
    normalizeUrl('https://archive.is/https://www.example.com/story-1?utm_source=x'),
    'https://www.example.com/story-1',
  );
  // short-code snapshots name no original, so they stay as pasted
  assert.equal(normalizeUrl('https://archive.is/abcde'), 'https://archive.is/abcde');
});

test('rate-limit and captcha pages are told apart from snapshots', () => {
  assert.equal(looksLikeChallenge(429, ''), true);
  assert.equal(looksLikeChallenge(200, CHALLENGE), true);
  assert.equal(looksLikeChallenge(200, '<title>Reggie Watts Is a Prominent Advocate</title>'), false);
});

test('the newest memento wins the timemap', () => {
  assert.equal(pickNewestMemento([
    { url: 'https://archive.md/1/x', rel: 'memento', at: 10 },
    { url: 'https://archive.md/2/x', rel: 'memento', at: 30 },
    { url: 'https://archive.md/3/x', rel: 'first memento', at: 5 },
  ]), 'https://archive.md/2/x');
  assert.equal(pickNewestMemento([]), null);
});

test('snapshot lookup reads the timemap and skips throttled mirrors', async () => {
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  const restore = stubFetch(async (url) => {
    if (url.startsWith('https://archive.today/')) return new Response(CHALLENGE, { status: 429 });
    if (url.startsWith('https://archive.ph/timemap/')) {
      return new Response([
        '<https://example.com/a>; rel="original",',
        '<http://archive.md/20260101000000/https://example.com/a>; rel="first memento"; datetime="Wed, 01 Jan 2026 00:00:00 GMT",',
        '<http://archive.md/20260820183055/https://example.com/a>; rel="last memento"; datetime="Thu, 20 Aug 2026 18:30:55 GMT"',
      ].join('\n'), { status: 200 });
    }
    return new Response('', { status: 404 });
  });
  try {
    assert.equal(
      await findArchiveSnapshot('https://example.com/a', { hosts: ['archive.today', 'archive.ph'] }),
      'https://archive.md/20260820183055/https://example.com/a',
    );
  } finally {
    restore();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
});

test('a captcha that blocks every strategy is reported as a rescuable challenge', async () => {
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  const restore = stubFetch(async (url) => {
    if (/archive\.(is|ph|today|md|li|vn|fo)/.test(url)) return new Response(CHALLENGE, { status: 429 });
    if (url.startsWith('https://archive.org/wayback/available')) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 });
    }
    return new Response('paywall', { status: 403 });
  });
  try {
    await assert.rejects(
      extractArticle('https://archive.is/https://example.com/story'),
      (error) => {
        assert.equal(error.statusCode, 428);
        assert.equal(error.challenge.provider, 'archive.today');
        assert.equal(error.challenge.original_url, 'https://example.com/story');
        assert.match(error.challenge.snapshot_url, /^https:\/\/archive\.is\//);
        return true;
      },
    );
  } finally {
    restore();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  }
});

test('page source handed over by the browser is read as an archive snapshot', () => {
  const body = Array.from({ length: 40 }, (_, i) => `<p>Sentence ${i} about the reporting in this story.</p>`).join('');
  const html = `<html><head><title>Archived</title></head><body>
    <div id="HEADER">archive.today toolbar · webpage capture · save to my archive</div>
    <div id="CONTENT"><article><h1>The Real Headline</h1>${body}
      <img src="https://archive.ph/Ab3d/https://img.example.com/hero.jpg">
    </article></div></body></html>`;

  const article = extractFromHtml(
    'https://example.com/story',
    html,
    'https://archive.ph/20260822021044/https://example.com/story',
  );

  assert.equal(article.url, 'https://example.com/story');
  assert.equal(article.fetch_method, 'archive.today (browser)');
  assert.ok(article.word_count > 120);
  assert.doesNotMatch(article.content_html, /webpage capture/);
  assert.match(article.content_html, /api\/image\?url=https%3A%2F%2Fimg\.example\.com%2Fhero\.jpg/);
});

test('a short-code capture is filed under the story it captured', () => {
  const body = Array.from({ length: 40 }, (_, i) => `<p>Sentence ${i} of the captured report.</p>`).join('');
  const html = `<html><head><title>The Headline</title>
    <meta property="og:url" content="https://www.example.com/news/the-headline-123/"></head>
    <body><div id="CONTENT"><article><h1>The Headline</h1>${body}</article></div></body></html>`;

  const article = extractFromHtml('https://archive.is/kSJh2', html, 'https://archive.is/kSJh2');
  assert.equal(article.url, 'https://www.example.com/news/the-headline-123/');
  assert.equal(article.canonical_url, 'https://www.example.com/news/the-headline-123/');
  assert.equal(article.site_name, 'example.com');
});

test('copied article text is rebuilt into paragraphs when there is no markup', () => {
  const text = ['The Headline Of The Piece', ...Array.from({ length: 30 },
    (_, i) => `Line ${i} of text copied straight off the rendered page, long enough to read as prose.`)].join('\n');

  const article = extractFromHtml('https://example.com/story', text, 'https://archive.md/2026/https://example.com/story');
  assert.equal(article.title, 'The Headline Of The Piece');
  assert.ok(article.word_count > 120);
  assert.match(article.content_html, /<p>Line 0 of text copied/);
});

test('every mirror of a capture is tried before a human is asked', () => {
  const urls = mirrorUrls('https://archive.md/kSJh2', ['archive.md', 'archive.ph', 'archive.is']);
  assert.deepEqual(urls, ['https://archive.md/kSJh2', 'https://archive.ph/kSJh2', 'https://archive.is/kSJh2']);
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

test('archive asset paths point back at the original host', () => {
  assert.equal(
    unwrapArchiveAsset('https://archive.ph/Ab3d/https://img.example.com/p.jpg?x=1'),
    'https://img.example.com/p.jpg?x=1',
  );
  assert.equal(unwrapArchiveAsset('https://archive.ph/Ab3d/e9f1c2.png'), null);
  assert.equal(unwrapArchiveAsset('https://img.example.com/p.jpg'), null);
});
