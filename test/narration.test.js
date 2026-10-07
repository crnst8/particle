import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScript, classifyNarrationBlocks, speakable, splitForSynthesis, detectLanguage, toneProfile,
  shortlistVoices, segmentStyle, segmentPolicy, scriptIdentity, mapLegacyPosition, legacyContentHash,
} from '../server/narration.js';
import { contentRevision, narrationRev, scriptId } from '../server/narration-identity.js';
import { extractFromHtml, sanitizeArticleHtml } from '../server/extract.js';

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

const rejoin = parts => parts.map(part => part.text).join(' ');

test('splits long text on sentence boundaries near the target, never past the cap', () => {
  const sentence = 'This is a sentence of a reasonable length that runs on a while.';
  const text = Array(30).fill(sentence).join(' ');
  const parts = splitForSynthesis(text, { target: 300, max: 450 });
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.text.length <= 450, `part too long: ${part.text.length}`);
    assert.equal(text.slice(part.start, part.end), part.text);
    assert.match(part.text, /\.$/, 'a passage ends where a sentence does');
  }
  assert.equal(rejoin(parts), text);
});

test('a sentence up to the cap stays whole even past the target', () => {
  const long = `${'word '.repeat(80).trim()}.`;   // ~400 characters, one sentence
  const parts = splitForSynthesis(`Short one. ${long}`, { target: 300, max: 450 });
  assert.equal(parts.length, 2);
  assert.equal(parts[1].text, long);
});

test('a runaway sentence is cut at clauses, then between words, never inside a word', () => {
  const text = `${'clause after clause, '.repeat(40)}end.`;
  const parts = splitForSynthesis(text, { target: 300, max: 450 });
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.text.length <= 450);
  assert.equal(rejoin(parts), text);

  const words = Array(200).fill('unbroken').join(' ');
  const cut = splitForSynthesis(words, { target: 300, max: 450 });
  for (const part of cut) assert.match(part.text, /^(unbroken ?)+$/);
  assert.equal(rejoin(cut), words);
});

test('only a single token longer than a passage is cut mid-word', () => {
  const token = 'x'.repeat(1000);
  const parts = splitForSynthesis(token, { target: 300, max: 450 });
  assert.ok(parts.every(part => part.text.length <= 450));
  assert.equal(parts.map(part => part.text).join(''), token);
});

test('short text is left in one piece', () => {
  assert.deepEqual(splitForSynthesis('Short enough.'), [{ text: 'Short enough.', start: 0, end: 13 }]);
});

test('TTS_SEGMENT_CHARS caps the passage length and the default is 300/450', () => {
  assert.deepEqual(segmentPolicy(undefined), { target: 300, max: 450 });
  assert.deepEqual(segmentPolicy('200'), { target: 200, max: 200 });
  assert.deepEqual(segmentPolicy('1100'), { target: 300, max: 1100 });
});

// ── what is spoken ───────────────────────────────────────────────────────────

const script = (content_html, extra = {}) => buildScript(article({ content_html, ...extra }));
const spoken = s => s.segments.map(segment => segment.text);
const reasons = s => s.blocks.filter(block => block.skip_reason).map(block => block.skip_reason);

test('no intro, no outro: only the article body is spoken', () => {
  const s = script('<p>First paragraph of the piece.</p><h2>A section</h2><p>Second paragraph here.</p>');
  assert.deepEqual(spoken(s), ['First paragraph of the piece.', 'A section.', 'Second paragraph here.']);
  assert.deepEqual(s.segments.map(segment => segment.kind), ['text', 'heading', 'text']);
  assert.ok(!spoken(s).some(text => /Jane Doe|Example|End of article|minute/.test(text)));
});

test('an empty article has nothing to read', () => {
  assert.deepEqual(script('').segments, []);
  assert.deepEqual(script('<figure><img src="a.jpg"><figcaption>Only a caption.</figcaption></figure>').segments, []);
});

test('a nested figcaption is never spoken, and stays in the map with its reason', () => {
  const s = script('<p>Body text that is read.</p><figure><img src="a.jpg" alt="Alt text never read"><figcaption>A caption under the photo.</figcaption></figure><p>More body.</p>');
  assert.deepEqual(spoken(s), ['Body text that is read.', 'More body.']);
  assert.deepEqual(reasons(s), ['caption']);
  const caption = s.blocks.find(block => block.skip_reason === 'caption');
  assert.equal(caption.dom_index, 1);   // p, then figcaption: a figure is not itself a block
});

test('a credit paragraph beside a picture is left out; prose mentioning photos is not', () => {
  const s = script('<p>Before the image.</p><p><img src="a.jpg"></p><p>Photo: Jane Smith/AP</p>'
    + '<p>The photo he took in 1998 is now in a museum.</p>');
  assert.deepEqual(spoken(s), ['Before the image.', 'The photo he took in 1998 is now in a museum.']);
  const credit = s.blocks.find(block => block.skip_reason === 'credit');
  assert.equal(credit.inferred, true);
});

test('a credit line with no picture beside it is kept: the evidence is not there', () => {
  const s = script('<p>Some text first that is long enough.</p><p>Photo: Jane Smith/AP</p>');
  assert.equal(s.segments.length, 2);
});

test('byline, dateline and reading time at the top are not read', () => {
  const s = script('<p>By Jane Doe</p><p>March 3, 2024</p><p>5 min read</p>'
    + '<p>The first real paragraph of the article, long enough to count as prose for sure, with more words in it.</p>');
  assert.deepEqual(spoken(s), ['The first real paragraph of the article, long enough to count as prose for sure, with more words in it.']);
  assert.deepEqual(reasons(s), ['metadata', 'metadata', 'metadata']);
});

test('a combined metadata line is recognised piece by piece', () => {
  const s = script('<p>By Jane Doe · Updated 4 March 2024 10:30 GMT · 6 min read</p><p>Body.</p>');
  assert.deepEqual(spoken(s), ['Body.']);
});

test('prose that mentions a date or a byline is still read', () => {
  const s = script('<p>On March 3, 2024 the council voted, by a narrow margin, to keep the library open.</p>'
    + '<p>Written by hand, the caption on the photo was illegible.</p>');
  assert.equal(s.segments.length, 2);
});

test('metadata later in the article is prose until proven otherwise', () => {
  const body = 'A long opening paragraph with plenty of words in it, enough that the opening is clearly over now.';
  const s = script(`<p>${body}</p><p>March 3, 2024</p>`);
  assert.equal(s.segments.length, 2);
});

test('an opening heading identical to the title is skipped; section headings are read', () => {
  const s = script('<h1>A Story</h1><p>Body text of the story.</p><h2>A Story</h2><p>More.</p>');
  assert.deepEqual(spoken(s), ['Body text of the story.', 'A Story.', 'More.']);
  assert.deepEqual(reasons(s), ['title']);
});

test('table contents are never spoken, even inside paragraphs', () => {
  const s = script('<p>Before the table.</p><table><tr><td><p>Cell paragraph.</p></td><td>Bare cell</td></tr></table><p>After.</p>');
  assert.deepEqual(spoken(s), ['Before the table.', 'After.']);
  assert.ok(reasons(s).every(reason => reason === 'table'));
});

test('code inside a quote is dropped without taking the quote with it', () => {
  const s = script('<blockquote><p>He wrote this down for us.</p><pre>rm -rf /tmp/x</pre></blockquote>');
  assert.deepEqual(spoken(s), ['He wrote this down for us.']);
  assert.equal(s.segments[0].kind, 'quote');
  assert.ok(reasons(s).includes('code'));
});

test('a paragraph that is only code is a listing', () => {
  const s = script('<p>Run the following command now.</p><p><code>npm install --save particle</code></p>'
    + '<p>Then call <code>listen()</code> to start.</p>');
  assert.deepEqual(spoken(s), ['Run the following command now.', 'Then call listen() to start.']);
});

test('a genuine quotation is read as a quote', () => {
  const s = script('<p>She was unambiguous about the whole affair.</p><blockquote>I never agreed to any of it.</blockquote>');
  assert.deepEqual(s.segments.map(segment => segment.kind), ['text', 'quote']);
});

test('a pullquote repeating the body is not read twice', () => {
  const line = 'The whole point of the exercise was to see whether anyone would notice at all.';
  const s = script(`<p>${line} And then some more text after it.</p><blockquote><p>${line}</p></blockquote>`);
  assert.equal(s.segments.filter(segment => segment.kind === 'quote').length, 0);
  const dup = s.blocks.find(block => block.skip_reason === 'duplicate');
  assert.equal(dup.inferred, true);
});

test('a nested list is read once per item, outer before inner, in order', () => {
  const s = script('<ul><li>Outer one<ul><li>Inner a</li><li>Inner b</li></ul>still outer</li><li>Outer two</li></ul>');
  assert.deepEqual(spoken(s), ['Outer one.', 'Inner a.', 'Inner b.', 'still outer.', 'Outer two.']);
  const words = spoken(s).join(' ').match(/\w+/g);
  assert.equal(words.filter(word => word === 'Inner').length, 2, 'every word exactly once');
});

test('repeated identical paragraphs get distinct, stable ids', () => {
  const s = script('<p>Again.</p><p>Different.</p><p>Again.</p>');
  const ids = s.segments.map(segment => segment.block_id);
  assert.equal(new Set(ids).size, 3);
  assert.match(ids[0], /-0$/);
  assert.match(ids[2], /-1$/);
  assert.equal(ids[0].replace(/-\d+$/, ''), ids[2].replace(/-\d+$/, ''));
});

test('a block keeps its id when the paragraphs around it change', () => {
  const before = script('<p>One.</p><p>The paragraph a bookmark points at.</p>');
  const after = script('<p>A new opening.</p><p>One, rewritten.</p><p>The paragraph a bookmark points at.</p>');
  assert.equal(before.segments[1].block_id, after.segments[2].block_id);
});

test('bare prose in a div is spoken in order around its child paragraphs', () => {
  const s = script('<div>Bare text before. <p>A child paragraph.</p> Bare text after.</div>');
  assert.deepEqual(spoken(s), ['Bare text before.', 'A child paragraph.', 'Bare text after.']);
  const runs = s.segments.map(segment => [segment.dom_index, segment.run]);
  assert.deepEqual(runs, [[0, 0], [1, 0], [0, 1]]);
});

test('PDF and OCR paragraphs read as ordinary prose', () => {
  const s = script('<h1>A Story</h1><p>Recovered paragraph one from a scanned page.</p><h2>Methods</h2><p>Recovered paragraph two.</p>');
  assert.deepEqual(spoken(s), ['Recovered paragraph one from a scanned page.', 'Methods.', 'Recovered paragraph two.']);
});

test('one segment never spans two blocks, and offsets point into the block text', () => {
  const long = Array(20).fill('A sentence that keeps going and going for a while.').join(' ');
  const s = script(`<p>Short one.</p><p>Short two.</p><p>${long}</p>`);
  assert.equal(s.segments[0].text, 'Short one.');
  assert.equal(s.segments[1].text, 'Short two.');
  const parts = s.segments.filter(segment => segment.dom_index === 2);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.map(part => part.part), parts.map((_, i) => i));
  assert.ok(parts[0].pause < parts.at(-1).pause, 'mid-paragraph pauses are shorter');
  assert.equal(parts.map(part => part.text).join(' '), speakable(long));
  for (const part of parts) assert.equal(speakable(long).slice(part.start, part.end), part.text);
  assert.ok(s.segments.every(segment => segment.id === `${segment.block_id}.${segment.part}`));
});

test('a heading is given more silence after it than a paragraph', () => {
  const s = script('<h2>Section</h2><p>Body text goes here.</p>');
  assert.ok(s.segments[0].pause > s.segments[1].pause);
  assert.ok(s.segments[1].pause > 0);
});

test('a reader\'s skip mark always wins; read-aloud undoes only a guess', () => {
  const html = '<p>By Jane Doe</p><p data-particle-speech="exclude">A paragraph the reader skipped.</p>'
    + '<p>Kept prose that is read aloud.</p><figure><figcaption data-particle-speech="include">Caption.</figcaption></figure>';
  const s = script(html);
  assert.deepEqual(spoken(s), ['Kept prose that is read aloud.']);
  assert.deepEqual(reasons(s), ['metadata', 'manual', 'caption']);

  const included = script(html.replace('<p>By Jane Doe</p>', '<p data-particle-speech="include">By Jane Doe</p>'));
  assert.deepEqual(spoken(included), ['By Jane Doe.', 'Kept prose that is read aloud.']);
});

test('the client gets the selector, so it never keeps a second classifier', () => {
  const s = script('<p>Text.</p>');
  assert.equal(typeof s.selector, 'string');
  assert.deepEqual(s.policy, { target: 300, max: 450 });
});

// ── through extraction ───────────────────────────────────────────────────────

test('a real page keeps its caption and credit semantics through Readability and the sanitiser', () => {
  const paragraph = n => `<p>Paragraph ${n} of the story has enough words in it to be counted as real prose by the extractor, and it goes on a little longer.</p>`;
  const page = `<!doctype html><html><head><title>A Story</title></head><body><article>
    <h1>A Story</h1>
    <div class="article-meta"><span class="byline">By Jane Doe</span> <time datetime="2024-03-03">March 3, 2024</time></div>
    ${paragraph(1)}${paragraph(2)}
    <div class="wp-caption"><img src="https://example.com/a.jpg" alt="alt"><p class="wp-caption-text">The harbour at dawn.</p></div>
    <p class="photo-credit">Photo: Jane Smith/AP</p>
    ${paragraph(3)}${paragraph(4)}${paragraph(5)}
  </article></body></html>`;
  const extracted = extractFromHtml('https://example.com/story', page);
  assert.match(extracted.content_html, /speech-caption/);
  assert.match(extracted.content_html, /speech-credit/);
  const s = buildScript({ ...extracted, id: 1 });
  const text = spoken(s).join(' ');
  assert.doesNotMatch(text, /harbour at dawn/);
  assert.doesNotMatch(text, /Jane Smith/);
  assert.match(text, /Paragraph 1/);
  assert.match(text, /Paragraph 5/);
  // the reader still sees every word
  assert.match(extracted.content_html, /The harbour at dawn/);
});

test('a page cannot label its own text for the narrator', () => {
  const page = `<html><body><article>${'<p>Plain article paragraph with enough words to be read as prose by the extractor today.</p>'.repeat(5)}
    <p class="speech-credit" data-particle-speech="exclude">Visible text the page tried to hide from narration.</p></article></body></html>`;
  const extracted = extractFromHtml('https://example.com/story', page);
  assert.doesNotMatch(extracted.content_html, /speech-credit|data-particle-speech/);
});

test('the sanitiser keeps only the two speech marks', () => {
  assert.match(sanitizeArticleHtml('<p data-particle-speech="exclude">x</p>'), /data-particle-speech="exclude"/);
  assert.match(sanitizeArticleHtml('<p data-particle-speech="include">x</p>'), /data-particle-speech="include"/);
  assert.doesNotMatch(sanitizeArticleHtml('<p data-particle-speech="evil">x</p>'), /data-particle-speech/);
  assert.doesNotMatch(sanitizeArticleHtml('<p data-other="1">x</p>'), /data-other/);
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

  const extreme = segmentStyle('quote', { speed: 99, temperature: 99, top_p: 99 });
  assert.ok(extreme.speed <= 2 && extreme.temperature <= 1 && extreme.topP <= 1);
});

test('language is detected from the article text', () => {
  assert.equal(detectLanguage('An ordinary English sentence.'), 'en');
  assert.equal(detectLanguage('Это обычное русское предложение здесь.'), 'ru');
  assert.equal(detectLanguage('これは日本語の文章です。'), 'ja');
});

// ── identity ─────────────────────────────────────────────────────────────────

test('content revision follows the text and the reader\'s marks', () => {
  const a = article({ content_html: '<p>One.</p>' });
  assert.equal(contentRevision(a), contentRevision({ ...a }));
  assert.notEqual(contentRevision(a), contentRevision({ ...a, content_html: '<p>Two.</p>' }));
  assert.notEqual(contentRevision(a), contentRevision({ ...a, content_html: '<p data-particle-speech="exclude">One.</p>' }));
  assert.notEqual(contentRevision(a), contentRevision({ ...a, title: 'Another' }));
});

test('script id moves with the segment policy; rev moves with every synthesis input but not playback rate', () => {
  const a = article({ content_html: '<p>One.</p>' });
  const { content_revision, script_id } = scriptIdentity(a);
  assert.equal(script_id, scriptId(content_revision, 3, { target: 300, max: 450 }));
  assert.notEqual(script_id, scriptIdentity(a, { policy: { target: 200, max: 200 } }).script_id);

  const config = { model: 'm', bitrate: 64, speed: 1, endpoint: 'e' };
  const base = narrationRev({ script_id, voice_id: 'v1', config });
  assert.equal(base, narrationRev({ script_id, voice_id: 'v1', config: { endpoint: 'e', speed: 1, bitrate: 64, model: 'm' } }));
  assert.notEqual(base, narrationRev({ script_id, voice_id: 'v2', config }));
  assert.notEqual(base, narrationRev({ script_id, voice_id: 'v1', config: { ...config, bitrate: 128 } }));
  assert.notEqual(base, narrationRev({ script_id, voice_id: null, config }));
  assert.match(base, /^r[0-9a-f]{31}$/);
});

// ── older narrations ─────────────────────────────────────────────────────────

test('an old seconds bookmark maps through its own script to the paragraph it named', () => {
  const a = article({ content_html: '<p>First paragraph.</p><figure><figcaption>Cap.</figcaption></figure><p>Second paragraph, the one being heard.</p><p>Third.</p>' });
  const legacy = {
    content_hash: legacyContentHash(a),
    direction: { speed: 1 },
    script: { segments: [
      { seq: 0, kind: 'intro', blocks: [], chars: 40, pause: 900 },
      { seq: 1, kind: 'text', blocks: [0], chars: 20, pause: 460 },
      { seq: 2, kind: 'caption', blocks: [1], chars: 4, pause: 460 },
      { seq: 3, kind: 'text', blocks: [2], chars: 40, pause: 460 },
      { seq: 4, kind: 'outro', blocks: [], chars: 20, pause: 0 },
    ] },
  };
  const durations = new Map([[0, 5], [1, 2], [3, 4]]);
  const target = buildScript(a).segments[1].block_id;
  assert.deepEqual(mapLegacyPosition(a, legacy, durations, 8), { block_id: target });
  assert.deepEqual(mapLegacyPosition(a, legacy, durations, 2), { block_id: buildScript(a).segments[0].block_id });
  assert.deepEqual(mapLegacyPosition(a, legacy, durations, 99), { completed: true });
});

test('an old bookmark on text that has since changed maps to nothing', () => {
  const a = article({ content_html: '<p>First.</p>' });
  const legacy = { content_hash: 'something-else', script: { segments: [{ seq: 0, kind: 'text', blocks: [0], chars: 6 }] } };
  assert.equal(mapLegacyPosition(a, legacy, new Map(), 1), null);
});
