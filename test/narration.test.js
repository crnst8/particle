import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScript, speakable, splitForSynthesis, detectLanguage, toneProfile,
  shortlistVoices, segmentStyle, contentHash, planNarration, castingReason,
} from '../server/narration.js';
import { narrationRev } from '../server/narrator.js';

const article = (extra = {}) => ({
  id: 1,
  url: 'https://example.com/story',
  title: 'A Story',
  byline: 'By Jane Doe',
  site_name: 'Example',
  word_count: 460,
  text_content: 'A Story about things.',
  ...extra,
});

// ── speech normalisation ─────────────────────────────────────────────────────

test('reads abbreviations, money and percentages as words', () => {
  assert.equal(speakable('Revenue rose 12% to $1.2bn.'), 'Revenue rose 12 percent to 1.2 billion dollars.');
  assert.equal(speakable('Use a hammer, e.g. a claw hammer'), 'Use a hammer, for example, a claw hammer.');
  assert.equal(speakable('Cats vs. dogs, etc.'), 'Cats versus dogs, et cetera.');
});

test('drops footnote markers and spells links as domains', () => {
  assert.equal(speakable('He denied it[12] twice.'), 'He denied it twice.');
  assert.equal(speakable('See https://www.example.com/a/b for more'), 'See example dot com for more.');
});

test('says a decade rather than spelling it', () => {
  assert.equal(speakable('The 2010s beat the 1990s.'), 'The twenty tens beat the nineteen nineties.');
  assert.equal(speakable('Back in the 2000s'), 'Back in the two thousands.');
  assert.equal(speakable('Built in the 1900s'), 'Built in the nineteen hundreds.');
  assert.equal(speakable('That \u201880s sound'), 'That eighties sound.');
  assert.equal(speakable('It was 2010 exactly'), 'It was 2010 exactly.');
});

test('a title is a word, not the end of a sentence', () => {
  assert.equal(speakable('Dr. Pausch told Mr. Atwood'), 'Doctor Pausch told Mister Atwood.');
  assert.equal(speakable('Prof. Diaz and Ms. Lee'), 'Professor Diaz and Miz Lee.');
  assert.equal(speakable('John Smith Jr. left'), 'John Smith Junior left.');
  // an address is not a doctor
  assert.equal(speakable('It is on Elm Dr. nearby'), 'It is on Elm Dr. nearby.');
});

test('turns an em dash into a pause and a year span into a range', () => {
  assert.equal(speakable('The plan—if it was one—failed'), 'The plan, if it was one, failed.');
  assert.equal(speakable('Between 2019-2024 it doubled'), 'Between 2019 to 2024 it doubled.');
});

test('closes a phrase that has no terminal punctuation', () => {
  assert.equal(speakable('A heading with no stop'), 'A heading with no stop.');
  assert.equal(speakable('Already done.'), 'Already done.');
});

test('applies per-article pronunciations last, and only whole words', () => {
  const said = speakable('The GPT-4o result', [{ find: 'GPT-4o', say: 'G P T four oh' }]);
  assert.equal(said, 'The G P T four oh result.');
  assert.equal(speakable('scattered', [{ find: 'cat', say: 'feline' }]), 'scattered.');
});

test('empty and punctuation-only input yields nothing to say', () => {
  assert.equal(speakable(''), '');
  assert.equal(speakable('   '), '');
});

// ── splitting ────────────────────────────────────────────────────────────────

test('splits long text on sentence boundaries under the cap', () => {
  const sentence = 'This is a sentence of a reasonable length that runs on a while. ';
  const parts = splitForSynthesis(sentence.repeat(30), 400);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 400, `part too long: ${part.length}`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), sentence.repeat(30).trim());
});

test('a single runaway sentence is split at clause boundaries', () => {
  const parts = splitForSynthesis(`${'clause after clause, '.repeat(40)}end.`, 300);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 300);
});

test('short text is left in one piece', () => {
  assert.deepEqual(splitForSynthesis('Short enough.', 400), ['Short enough.']);
});

// ── script ───────────────────────────────────────────────────────────────────

test('builds an opening line, the body in order, and a close', () => {
  const script = buildScript(article({
    content_html: '<p>First paragraph of the piece.</p><h2>A section</h2><p>Second paragraph here.</p>',
  }));
  const kinds = script.segments.map(segment => segment.kind);
  assert.deepEqual(kinds, ['intro', 'text', 'heading', 'text', 'outro']);
  assert.match(script.segments[0].text, /Example\. A Story\. By Jane Doe\. 2 minutes\./);
  assert.equal(script.segments.at(-1).text, 'End of article, from Example.');
});

test('a heading is given more silence after it than a paragraph', () => {
  const script = buildScript(article({ content_html: '<h2>Section</h2><p>Body text goes here.</p>' }));
  const heading = script.segments.find(segment => segment.kind === 'heading');
  const text = script.segments.find(segment => segment.kind === 'text');
  assert.ok(heading.pause > text.pause);
  assert.ok(text.pause > 0);
});

test('a paragraph split in two pauses less in the middle than at the end', () => {
  const long = `${'A sentence that keeps going and going for a while. '.repeat(40)}`;
  const script = buildScript(article({ content_html: `<p>${long}</p>` }));
  const parts = script.segments.filter(segment => segment.kind === 'text');
  assert.ok(parts.length > 1);
  assert.ok(parts[0].pause < parts.at(-1).pause);
});

test('a pullquote repeating the body is not read twice', () => {
  const line = 'The whole point of the exercise was to see whether anyone would notice at all.';
  const script = buildScript(article({
    content_html: `<p>${line} And then some more text after it.</p><blockquote class="pullquote">${line}</blockquote>`,
  }));
  assert.equal(script.segments.filter(segment => segment.kind === 'quote').length, 0);
  assert.ok(script.blocks.some(block => block.skip === 'duplicate'));
});

test('a genuine quotation survives', () => {
  const script = buildScript(article({
    content_html: '<p>She was unambiguous about the whole affair.</p><blockquote>I never agreed to any of it.</blockquote>',
  }));
  assert.equal(script.segments.filter(segment => segment.kind === 'quote').length, 1);
});

test('code blocks are marked skipped rather than read out', () => {
  const script = buildScript(article({ content_html: '<p>Then run this.</p><pre>rm -rf /tmp/x</pre>' }));
  assert.ok(!script.segments.some(segment => segment.text.includes('rm -rf')));
  assert.ok(script.blocks.some(block => block.skip === 'code'));
});

test('nested blocks are read once, by their outermost owner', () => {
  const script = buildScript(article({
    content_html: '<blockquote><p>Only once, please, and at some length.</p></blockquote>',
  }));
  const spoken = script.segments.filter(segment => segment.kind === 'quote');
  assert.equal(spoken.length, 1);
  assert.equal(spoken.filter(segment => segment.text.includes('Only once')).length, 1);
});

test('block indices address the same node list the reader queries', () => {
  const script = buildScript(article({
    content_html: '<p>One paragraph here.</p><ul><li>An item worth saying.</li></ul><p>Another paragraph.</p>',
  }));
  // p, li, p — the <ul> itself is not in the selector
  assert.deepEqual(script.blocks.map(block => block.kind), ['text', 'item', 'text']);
  const item = script.segments.find(segment => segment.kind === 'item');
  assert.deepEqual(item.blocks, [1]);
});

test('consecutive short paragraphs are merged into one breath', () => {
  const script = buildScript(article({ content_html: '<p>Short one.</p><p>Short two.</p><p>Short three.</p>' }));
  const merged = script.segments.find(segment => segment.kind === 'text');
  assert.deepEqual(merged.blocks, [0, 1, 2]);
  assert.equal(merged.text, 'Short one. Short two. Short three.');
});

test('an article with no body still gets no stray closing line', () => {
  const script = buildScript(article({ content_html: '' }));
  assert.deepEqual(script.segments.map(segment => segment.kind), ['intro']);
});

test('the direction can replace the spoken opening', () => {
  const script = buildScript(article({ content_html: '<p>Body copy here.</p>' }), { intro: 'Custom opening line' });
  assert.equal(script.segments[0].text, 'Custom opening line.');
});

// ── casting ──────────────────────────────────────────────────────────────────

test('tone follows the article, and long reads ease off the pace', () => {
  assert.equal(toneProfile(article({ tags: ['politics'] })).id, 'reportage');
  assert.equal(toneProfile(article({ tags: ['philosophy'] })).id, 'essay');
  assert.equal(toneProfile(article({ tags: ['software'] })).id, 'technical');
  assert.equal(toneProfile(article({ tags: [] })).id, 'general');

  const short = toneProfile(article({ tags: ['politics'], word_count: 400 }));
  const long = toneProfile(article({ tags: ['politics'], word_count: 6000 }));
  assert.ok(long.speed < short.speed);
});

test('voices are ranked by fit with the article, not by popularity alone', () => {
  const voices = [
    { id: 'loud', title: 'Loud', tags: ['energetic', 'bright'], popularity: 9_000_000, description: '' },
    { id: 'calm', title: 'Calm', tags: ['narration', 'calm', 'measured', 'storytelling'], popularity: 10, description: '' },
  ];
  const ranked = shortlistVoices(article({ tags: ['literature'] }), voices);
  assert.equal(ranked[0].id, 'calm');
});

test('a voice tagged every way loses to one that is actually the brief', () => {
  const voices = [
    // the shape that used to win everything: enough tags to match any profile
    {
      id: 'everything', title: 'Everything', popularity: 2_000_000, description: '',
      tags: ['clear', 'crisp', 'smooth', 'calm', 'measured', 'professional', 'neutral-tone',
        'confident', 'social-media', 'narration', 'educational', 'energetic', 'advertisement'],
    },
    {
      id: 'reader', title: 'Reader', popularity: 900, description: '',
      tags: ['narration', 'warm', 'measured', 'storytelling', 'calm', 'smooth'],
    },
  ];
  const ranked = shortlistVoices(article({ tags: ['memoir'] }), voices);
  assert.equal(ranked[0].id, 'reader');
});

test('the same voice re-uploaded under one name appears once', () => {
  const voices = Array.from({ length: 5 }, (_, i) => ({
    id: `clone${i}`, title: 'Slax', popularity: 1000 * i, description: '',
    tags: ['narration', 'calm', 'measured', 'clear'],
  })).concat({
    id: 'other', title: 'Someone Else', popularity: 10, description: '',
    tags: ['narration', 'calm'],
  });
  const ranked = shortlistVoices(article(), voices);
  assert.equal(ranked.filter(voice => voice.title === 'Slax').length, 1);
  assert.equal(ranked.length, 2);
});

test('a voice the library just heard gives way to an equal one it has not', () => {
  const voices = [
    { id: 'heard', title: 'Heard', popularity: 5000, description: '', tags: ['narration', 'calm', 'measured', 'clear'] },
    { id: 'fresh', title: 'Fresh', popularity: 5000, description: '', tags: ['narration', 'calm', 'measured', 'clear'] },
  ];
  const piece = article();
  const withoutAvoid = shortlistVoices(piece, voices);
  assert.equal(shortlistVoices(piece, voices, undefined, { avoid: [withoutAvoid[0].id] })[0].id,
    withoutAvoid[1].id);
});

test('selling tags cost a voice the reading', () => {
  const voices = [
    { id: 'seller', title: 'Seller', popularity: 10, description: '', tags: ['clear', 'calm', 'advertisement', 'social-media', 'energetic'] },
    { id: 'plain', title: 'Plain', popularity: 10, description: '', tags: ['clear', 'calm'] },
  ];
  assert.equal(shortlistVoices(article({ tags: ['software'] }), voices)[0].id, 'plain');
});

test('the casting reason names what the voice was picked on', () => {
  const reason = castingReason(
    { id: 'v', title: 'V', tags: ['narration', 'calm', 'measured', 'deep'] },
    toneProfile(article({ tags: ['philosophy'] })),
  );
  assert.match(reason, /measured/);
  assert.match(reason, /essay/);
  assert.doesNotMatch(reason, /deep/);
});

test('ranking is stable for one article and differs across articles', () => {
  const voices = Array.from({ length: 8 }, (_, i) => ({
    id: `v${i}`, title: `V${i}`, tags: ['narration', 'clear'], popularity: 1000, description: '',
  }));
  const first = shortlistVoices(article({ id: 1 }), voices).map(v => v.id);
  assert.deepEqual(shortlistVoices(article({ id: 1 }), voices).map(v => v.id), first);
  const other = shortlistVoices(article({ id: 42, url: 'https://example.com/other' }), voices).map(v => v.id);
  assert.notDeepEqual(other, first);
});

test('delivery is shaped per block kind and stays inside the model limits', () => {
  const direction = { speed: 1, temperature: 0.7, top_p: 0.7 };
  assert.ok(segmentStyle('heading', direction).speed < segmentStyle('text', direction).speed);
  assert.ok(segmentStyle('quote', direction).temperature > segmentStyle('text', direction).temperature);
  assert.ok(segmentStyle('caption', direction).volume < 0);

  const extreme = segmentStyle('quote', { speed: 99, temperature: 99, top_p: 99 });
  assert.ok(extreme.speed <= 2 && extreme.temperature <= 1 && extreme.topP <= 1);
});

test('language is detected from the article text', () => {
  assert.equal(detectLanguage('An ordinary English sentence.'), 'en');
  assert.equal(detectLanguage('Это обычное русское предложение здесь.'), 'ru');
  assert.equal(detectLanguage('これは日本語の文章です。'), 'ja');
});

test('the content hash changes when the article does', () => {
  const a = article({ content_html: '<p>One.</p>' });
  assert.equal(contentHash(a), contentHash({ ...a }));
  assert.notEqual(contentHash(a), contentHash({ ...a, content_html: '<p>Two.</p>' }));
});

test('picking a voice swaps the voice and keeps the direction already written', async () => {
  const reuse = {
    voice_id: 'old-voice', voice_name: 'Old Voice', tone: 'essay', speed: 0.94,
    temperature: 0.81, top_p: 0.7, pronunciations: [{ find: 'Nguyen', say: 'win' }],
    reason: 'essay tone, warm', source: 'llm',
  };
  const { direction, script } = await planNarration(
    article({ content_html: '<p>One sentence, read aloud.</p>' }),
    { voiceId: 'new-voice', reuse },
  );

  assert.equal(direction.voice_id, 'new-voice');
  assert.equal(direction.source, 'manual');
  assert.equal(direction.speed, 0.94);
  assert.deepEqual(direction.pronunciations, reuse.pronunciations);
  // the pacing belongs to the article, the reason belonged to the voice it replaced
  assert.match(direction.reason, /chosen by hand/);
  assert.ok(script.segments.length > 0);
});

test('a casting revision moves with the voice, the script and the rebuild', () => {
  const base = { content_hash: 'abc', voice_id: 'one', created_at: '2026-08-27T00:00:00.000Z' };
  assert.equal(narrationRev(base), narrationRev({ ...base }));
  assert.notEqual(narrationRev(base), narrationRev({ ...base, voice_id: 'two' }));
  assert.notEqual(narrationRev(base), narrationRev({ ...base, content_hash: 'def' }));
  assert.notEqual(narrationRev(base), narrationRev({ ...base, created_at: '2026-08-27T00:00:01.000Z' }));
});
