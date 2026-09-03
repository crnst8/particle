import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonLoose } from '../server/llm.js';

test('a reply is read whether or not the model kept to JSON', () => {
  const want = { candidates: [{ title: 'A' }] };
  assert.deepEqual(parseJsonLoose('{"candidates":[{"title":"A"}]}'), want);
  assert.deepEqual(parseJsonLoose('```json\n{"candidates":[{"title":"A"}]}\n```'), want);
  assert.deepEqual(parseJsonLoose('Here is what I saw:\n{"candidates":[{"title":"A"}]}\nHope that helps.'), want);
  // a brace inside a string must not end the object early
  assert.deepEqual(parseJsonLoose('{"candidates":[{"title":"A {not the end}"}]}'),
    { candidates: [{ title: 'A {not the end}' }] });
});

test('a reply cut off at the token limit keeps the articles that finished', () => {
  // what a caption listing several articles produces when the budget runs out
  const cut = '{"poster":"Xenia","candidates":[{"title":"one","confidence":0.9},'
    + '{"title":"two","confidence":0.8},{"title":"thr';
  const parsed = parseJsonLoose(cut);
  assert.equal(parsed.poster, 'Xenia');
  assert.deepEqual(parsed.candidates.map(one => one.title), ['one', 'two']);
});

test('a reply with no JSON in it at all is an error, not a guess', () => {
  assert.throws(() => parseJsonLoose('I cannot see any article in this image.'), /no JSON/);
  assert.throws(() => parseJsonLoose(''), /no JSON/);
});
