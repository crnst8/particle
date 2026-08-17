import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/store-local.js', import.meta.url), 'utf8');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function factory(storage) {
  const window = {};
  vm.runInNewContext(source, { window, localStorage: storage, Date, JSON, Number, String, Array, Boolean, Error });
  return window.createParticleLocalStore;
}

function article(url, title) {
  return {
    url,
    canonical_url: url,
    title,
    site_name: 'example',
    excerpt: title,
    content_html: `<p>${title}</p>`,
    text_content: title,
    word_count: 10,
  };
}

test('demo library persists in localStorage across store instances', async () => {
  const storage = memoryStorage();
  const fetchJson = async (url, options) => {
    if (url === '/api/demo-seed') return [article('https://example.com/seed', 'Seed')];
    if (url === '/api/extract') return article(options.body.url, 'Saved');
    throw new Error(`unexpected URL ${url}`);
  };

  const first = factory(storage)({ fetchJson, maxArticles: 3 });
  assert.equal((await first.list('', 'all')).length, 1);
  const saved = await first.save('https://example.com/saved');
  await first.patch(saved.id, { favorite: true, progress: 0.5 });

  const reloaded = factory(storage)({ fetchJson, maxArticles: 3 });
  const restored = await reloaded.get(saved.id);
  assert.equal(restored.favorite, true);
  assert.equal(restored.progress, 0.5);
  assert.equal((await reloaded.list('saved', 'favorites')).length, 1);
});

test('demo cap evicts the oldest non-favourite article', async () => {
  const storage = memoryStorage();
  const fetchJson = async (url, options) => url === '/api/demo-seed'
    ? [article('https://example.com/seed', 'Seed')]
    : article(options.body.url, options.body.url.split('/').at(-1));
  const store = factory(storage)({ fetchJson, maxArticles: 2 });

  const [seed] = await store.list('', 'all');
  await store.patch(seed.id, { favorite: true });
  await store.save('https://example.com/second');
  const third = await store.save('https://example.com/third');

  assert.equal(third.evicted_title, 'second');
  assert.deepEqual((await store.list('', 'all')).map(item => item.title).sort(), ['Seed', 'third']);
});
