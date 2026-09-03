import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanDomain, cleanTitle, firstDomain, firstUrl, imageType, interpretLines,
  isChromeLine, normalizeCandidate, normalizeCandidates, parseLooseDate,
} from '../server/screenshot.js';

/* The lines below are what these screens actually say. Every one of them is
   transcribed from a real screenshot in _working/screenshots. */

test('a headline read off a screen loses the app furniture stuck to its end', () => {
  assert.equal(cleanTitle('  Discipline Comes from   Having No Choice  '), 'Discipline Comes from Having No Choice');
  assert.equal(cleanTitle('New substack essay out: everything that’s dystopian in the west is a ca… more'),
    'New substack essay out: everything that’s dystopian in the west is a ca');
  assert.equal(cleanTitle('The slow media movement SHARE'), 'The slow media movement');
  assert.equal(cleanTitle('“How to Remember Everything You Read”'), 'How to Remember Everything You Read');
  assert.equal(cleanTitle('ok'), null, 'two characters is not a headline');
});

test('the app’s own words are furniture, but a headline containing one is not', () => {
  for (const line of ['Find related content', 'Search', 'SHARE', 'SUBSCRIBE', 'Add comment...',
    'Repost to followers', '3 / 4', '423.8K', '5:40', 'more', '·']) {
    assert.equal(isChromeLine(line), true, line);
  }
  assert.equal(isChromeLine('Why are so many creative directors still white men?'), false);
  assert.equal(isChromeLine('The Most Violent Path to Self-Education'), false);
  // a title that happens to contain a furniture word survives, because the
  // patterns are anchored to the whole line
  assert.equal(isChromeLine('In search of a slower internet'), false);
});

test('a date is read however the page happened to set it', () => {
  assert.equal(parseLooseDate('9 APR 2025 AT 16:31'), '2025-04-09');
  assert.equal(parseLooseDate('12 MAR 2025 AT 23:45'), '2025-03-12');
  assert.equal(parseLooseDate('February 18, 2025'), '2025-02-18');
  assert.equal(parseLooseDate('11 JUN 2026 AT 12:09'), '2026-06-11');
  assert.equal(parseLooseDate('2025-6-23'), '2025-06-23');
  assert.equal(parseLooseDate('sometime last spring'), null);
  assert.equal(parseLooseDate('2025-13-40'), null, 'a date that could not exist is not one');
});

test('a URL or a bare domain is picked out of a line of screen text', () => {
  assert.equal(firstDomain('CONQUER1.SUBSTACK.COM'), 'conquer1.substack.com');
  assert.equal(firstDomain('read it at www.theculturist.io today'), 'theculturist.io');
  assert.equal(firstUrl('go to https://example.com/story/one.'), 'https://example.com/story/one');
  assert.equal(firstUrl('no link here'), null);
  assert.equal(firstDomain('ELEVATED IT GIRL'), null, 'a masthead is not a domain');
  assert.equal(cleanDomain('https://www.Conquer1.Substack.com/p/x'), 'conquer1.substack.com');
  assert.equal(cleanDomain('mindbox'), null);
});

test('a candidate keeps only fields it can stand behind', () => {
  const candidate = normalizeCandidate({
    title: 'why time felt slower when we were kids (and how to get it back)',
    subtitle: 'the neuroscience of time perception',
    publication: 'mindbox',
    byline: 'YANA YUHAI',
    published: '12 MAR 2025 AT 23:45',
    url: 'unknown',
    domain: 'not a domain',
    kind: 'newsletter',
    confidence: 1.4,
  }, { poster: 'Xenia' });

  assert.equal(candidate.published, '2025-03-12');
  assert.equal(candidate.url, null, 'a model saying "unknown" has not given a URL');
  assert.equal(candidate.domain, null);
  assert.equal(candidate.poster, 'Xenia');
  assert.equal(candidate.confidence, 1, 'confidence is clamped, not trusted');
});

test('a candidate with neither a title nor a URL is nothing at all', () => {
  assert.equal(normalizeCandidate({ publication: 'Vogue Business', confidence: 0.9 }), null);
  assert.equal(normalizeCandidate(null), null);
  // a bare URL needs no title: it is already the answer
  assert.ok(normalizeCandidate({ url: 'https://example.com/a' }));
});

test('the same article named twice in one picture is one candidate', () => {
  const candidates = normalizeCandidates([
    { title: 'How to Remember Everything You Read', publication: 'THE CULTURIST', confidence: 0.6 },
    { title: 'how to remember everything you read', publication: 'the culturist', confidence: 0.9 },
    { title: 'The slow media movement', publication: 'ELEVATED IT GIRL', confidence: 0.8 },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].confidence, 0.9, 'the surest reading of the two survives, strongest first');
});

test('without a vision model, the largest type that is not furniture is the headline', () => {
  // sc7, as OCR gives it back: a link card over a video, with the app around it
  const candidates = interpretLines([
    { text: '5:38', x: 100, y: 60, width: 90, height: 34 },
    { text: 'Find related content', x: 190, y: 240, width: 420, height: 30 },
    { text: 'CONQUER1.SUBSTACK.COM', x: 210, y: 1494, width: 400, height: 22 },
    { text: 'Discipline Comes from', x: 210, y: 1552, width: 720, height: 66 },
    { text: 'Having No Choice', x: 210, y: 1630, width: 560, height: 66 },
    { text: '137.2K', x: 1090, y: 1490, width: 110, height: 32 },
    { text: 'Add comment...', x: 90, y: 2450, width: 300, height: 34 },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'Discipline Comes from Having No Choice');
  assert.equal(candidates[0].domain, 'conquer1.substack.com');
  assert.ok(candidates[0].confidence < 0.6, 'OCR read it without understanding it');
});

test('a picture with nothing but furniture in it yields nothing', () => {
  assert.deepEqual(interpretLines([
    { text: '5:40', x: 100, y: 60, width: 90, height: 34 },
    { text: 'Search', x: 900, y: 240, width: 160, height: 30 },
  ]), []);
  assert.deepEqual(interpretLines([]), []);
});

test('the bytes say what an image is, not the header the browser guessed', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1')]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);

  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(jpeg), 'image/jpeg');
  assert.equal(imageType(heic), 'image/heic');
  assert.equal(imageType(webp), 'image/webp');
  assert.equal(imageType(Buffer.from('%PDF-1.7 not an image')), null);
  assert.equal(imageType(Buffer.alloc(4)), null);
});

test('a link that could not be read is still an article row', async () => {
  const { linkStub } = await import('../server/extract.js');
  const stub = linkStub('https://www.voguebusiness.com/story/x', {
    title: 'Why are so many creative directors still white men?',
    byline: 'Maliha Shoaib',
    site_name: 'Vogue Business',
    excerpt: 'The latest wave of creative director hires shows diversity remains on the back-burner.',
    note: 'paywalled',
  });

  assert.equal(stub.quality, 'link');
  assert.equal(stub.word_count, 0);
  assert.equal(stub.canonical_url, stub.url);
  assert.match(stub.content_html, /open the original/);
  assert.match(stub.content_html, /voguebusiness\.com/);
  // search has to be able to find it, which means its own text, not just a URL
  assert.match(stub.text_content, /creative directors/);
  assert.match(stub.text_content, /Maliha Shoaib/);
});

test('a link with nothing known about it falls back to its host', () => {
  return import('../server/extract.js').then(({ linkStub }) => {
    const stub = linkStub('https://doi.org/10.1177/002193470103200104');
    assert.equal(stub.site_name, 'doi.org');
    assert.equal(stub.title, 'doi.org');
  });
});

test('a key never reaches the log, whichever shape it arrives in', async () => {
  const { redact } = await import('../server/screenshot.js');
  assert.equal(
    redact('LLM HTTP 400: https://host.test/v1beta/openai/chat?key=AIzaSyC0ff33Bea9sSecretV4lue&alt=json'),
    'LLM HTTP 400: https://host.test/v1beta/openai/chat?key=[redacted]&alt=json');
  assert.equal(redact('bad header Bearer sk-proj-0123456789abcdefghij'), 'bad header Bearer [redacted]');
  assert.equal(redact('rejected sk-live-0123456789abcdefghij'), 'rejected sk-[redacted]');
  assert.equal(redact('read 348KB in 29ms → 3 candidate(s)'), 'read 348KB in 29ms → 3 candidate(s)');
});

test('a caption set as large as the headline is not part of the headline', async () => {
  const { headlineOf } = await import('../server/screenshot.js');
  // sc4: the article's headline, and below it the post's caption listing the
  // same piece again — both set at the same size, a headline-height apart
  const headline = headlineOf([
    { text: 'why time felt slower when', x: 200, y: 1060, width: 700, height: 52 },
    { text: 'we were kids (and how to', x: 200, y: 1122, width: 690, height: 52 },
    { text: 'get it back)', x: 200, y: 1184, width: 320, height: 52 },
    // a long way below: a different thing on the page, set the same size
    { text: 'Post 3 | 1. “Why time felt slower when', x: 60, y: 2040, width: 800, height: 50 },
    { text: 'we were kids (and how to get it back)” by', x: 60, y: 2100, width: 820, height: 50 },
  ]);
  assert.equal(headline, 'why time felt slower when we were kids (and how to get it back)');
});

test('a headline wrapped over three lines still comes back whole', async () => {
  const { headlineOf } = await import('../server/screenshot.js');
  assert.equal(headlineOf([
    { text: 'Everything Dystopian in', x: 20, y: 300, width: 700, height: 60 },
    { text: 'the West Is a Casual', x: 20, y: 372, width: 640, height: 60 },
    { text: 'Tuesday in Africa', x: 20, y: 444, width: 560, height: 60 },
  ]), 'Everything Dystopian in the West Is a Casual Tuesday in Africa');
});
