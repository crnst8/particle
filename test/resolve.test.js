import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  daysApart, handleGuesses, hostsToTry, isCertain, looksAcademic, matchDetail,
  publicationHosts, safeHost, scoreMatch, searchTerms, similarity, siteHostsFor,
  substackHostsFor,
} from '../server/resolve.js';

test('a name is spelled the way an address would spell it', () => {
  assert.deepEqual(handleGuesses('Yana Yuhai'), ['yanayuhai']);
  assert.deepEqual(handleGuesses('ELEVATED IT GIRL'), ['elevateditgirl']);
  // "The Culturist" answers to both, and only one of them is the right one —
  // which is why the archive still has to agree afterwards
  assert.deepEqual(handleGuesses('THE CULTURIST'), ['theculturist', 'culturist']);
  assert.deepEqual(handleGuesses('Zoë Béringer'), ['zoeberinger'], 'accents are not part of an address');
  assert.deepEqual(handleGuesses('a'), [], 'too short to be anyone');
});

test('a masthead is guessed as a newsletter first and a website second', () => {
  assert.deepEqual(substackHostsFor('mindbox'), ['mindbox.substack.com']);
  assert.deepEqual(siteHostsFor('Vogue Business'), ['voguebusiness.com', 'www.voguebusiness.com']);
});

test('a domain read off the screen is asked before any guess', () => {
  const hosts = hostsToTry({
    title: 'Discipline Comes from Having No Choice',
    domain: 'conquer1.substack.com',
    publication: null,
    byline: null,
    poster: 'Isabel Radford',
  });
  assert.equal(hosts[0], 'conquer1.substack.com');
});

test('the poster is asked about too — on a personal newsletter they are the author', () => {
  const hosts = hostsToTry({ title: 'x', publication: 'MY MUSINGS', byline: null, poster: 'Sadell' });
  assert.ok(hosts.includes('sadell.substack.com'));
  assert.ok(hosts.includes('mymusings.substack.com'));
});

test('a profile names every address its publications are served from', () => {
  assert.deepEqual(publicationHosts({
    primaryPublication: { name: 'mindbox', subdomain: 'contemplationstation', custom_domain: null },
    publicationUsers: [
      { publication: { name: 'mindbox', subdomain: 'contemplationstation' } },
      { publication: { name: 'The Culturist', subdomain: 'culturist', custom_domain: 'www.theculturist.io' } },
    ],
  }), ['contemplationstation.substack.com', 'www.theculturist.io']);

  assert.deepEqual(publicationHosts(null), []);
  assert.deepEqual(publicationHosts({ primaryPublication: {} }), []);
});

test('a title long enough to stand alone is searched on alone', () => {
  assert.equal(searchTerms({ title: 'The slow media movement: detoxing the digital overstimulation', subtitle: 'reframing how we consume content' }),
    'The slow media movement: detoxing the digital overstimulation');
  // three words matches half the archive, so the deck is added to it
  assert.equal(searchTerms({ title: 'Slow media', subtitle: 'a detox' }), 'Slow media a detox');
});

test('similarity is over words, because punctuation is what a screen loses', () => {
  assert.equal(similarity('How to Remember Everything You Read', 'how to remember everything you read'), 1);
  assert.ok(similarity('The slow media movement: detoxing the digital overstimulation',
    'The slow media movement: detoxing the digital overstimulation ') > 0.99);
  assert.ok(similarity('Discipline Comes from Having No Choice', 'Everything You Do Now Requires Discipline') < 0.45);
  assert.equal(similarity('', 'anything'), 0);
});

test('a date within a day agrees; a month apart is a different piece wearing the name', () => {
  const seen = {
    title: 'why time felt slower when we were kids (and how to get it back)',
    published: '2025-03-12',
    byline: 'YANA YUHAI',
  };
  const right = {
    title: 'why time felt slower when we were kids (and how to get it back)',
    published: '2025-03-12',
    byline: 'yana yuhai',
  };
  const reposted = { ...right, published: '2025-05-25' };

  assert.ok(scoreMatch(seen, right) > 0.95);
  assert.ok(scoreMatch(seen, reposted) < 0.72, 'the same title months later is not the same article');
  // no date on either side is not evidence against a match
  assert.ok(scoreMatch({ ...seen, published: null }, { ...right, published: null }) > 0.9);
});

test('a title that only half matches does not become a match on its date', () => {
  const seen = { title: 'How to Remember Everything You Read', published: '2025-04-09' };
  const other = { title: 'Top 6 Ways to Undermine Your Female Hero', published: '2025-04-09' };
  assert.ok(scoreMatch(seen, other) < 0.45);
});

test('days apart needs two dates to mean anything', () => {
  assert.equal(daysApart('2025-03-12', '2025-03-13'), 1);
  assert.equal(daysApart('2025-03-12', null), null);
  assert.equal(daysApart('whenever', '2025-03-12'), null);
});

test('a paper announces itself, and a newsletter is never one', () => {
  assert.equal(looksAcademic({ kind: 'paper' }), true);
  assert.equal(looksAcademic({
    kind: 'unknown',
    byline: 'Robert E. Weems, Jr.',
    excerpt: 'University of Missouri–Columbia. Ohio University.',
  }), true);
  assert.equal(looksAcademic({ kind: 'unknown', publication: 'Journal of Black Studies' }), true);
  assert.equal(looksAcademic({ kind: 'newsletter', publication: 'Journal of Black Studies' }), false);
  assert.equal(looksAcademic({ kind: 'article', publication: 'Vogue Business' }), false);
});

test('a match says which of the picture’s claims it confirmed', () => {
  const seen = {
    title: 'The slow media movement: detoxing the digital overstimulation',
    published: '2025-03-11',
    byline: 'ROBIN COLLINS',
  };
  const detail = matchDetail(seen, {
    title: 'The slow media movement: detoxing the digital overstimulation ',
    published: '2025-03-11',
    byline: 'Robin Collins',
  });
  assert.deepEqual(detail.confirmedBy, ['title', 'date', 'byline']);
  assert.ok(detail.score > 0.95);
});

test('a title alone is a coincidence; a title and one other thing is the article', () => {
  const title = { title: 'How to Remember Everything You Read' };
  // nothing but the title agreed — offered, not filed
  assert.equal(isCertain({ url: 'https://x.test/a', score: 1, confirmedBy: ['title'] }), false);
  assert.equal(isCertain({ url: 'https://x.test/a', score: 1, confirmedBy: ['title', 'date'] }), true);
  // a domain read off the screen did not have to be guessed, so it stands alone
  assert.equal(isCertain({ url: 'https://x.test/a', score: 1, confirmedBy: ['title'], fromReadDomain: true }), true);
  // a URL legible in the picture needs no corroboration at all
  assert.equal(isCertain({ url: 'https://x.test/a', via: 'in the picture' }), true);
  assert.equal(isCertain({ url: null, score: 1, confirmedBy: ['title', 'date'] }), false);
  // a good-enough match is still not a certain one
  assert.equal(isCertain({ url: 'https://x.test/a', score: 0.8, confirmedBy: ['title', 'date'] }), false);
  assert.equal(matchDetail(title, { title: 'Something else entirely' }).confirmedBy.length, 0);
});

test('a host that is not purely a hostname never reaches a URL', () => {
  assert.equal(safeHost('conquer1.substack.com'), 'conquer1.substack.com');
  assert.equal(safeHost('www.theculturist.io'), 'www.theculturist.io');
  // `https://a@169.254.169.254/api/…` is not a request to `a`
  assert.equal(safeHost('a@169.254.169.254'), null);
  assert.equal(safeHost('evil.test/../../admin'), null);
  assert.equal(safeHost('evil.test:8080'), null);
  assert.equal(safeHost('evil.test?x=1'), null);
  assert.equal(safeHost('localhost'), null, 'a single label is not a publication');
  assert.equal(safeHost('has space.com'), null);
  assert.equal(safeHost(''), null);
  assert.equal(safeHost(null), null);
});

test('a publication address in somebody else’s JSON is checked like any input', () => {
  assert.deepEqual(publicationHosts({
    publicationUsers: [
      { publication: { custom_domain: 'https://www.theculturist.io/p/x' } },
      { publication: { custom_domain: 'a@169.254.169.254' } },
      { publication: { subdomain: 'contemplationstation' } },
    ],
  }), ['www.theculturist.io', 'contemplationstation.substack.com']);
});
