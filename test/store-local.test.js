import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/store-local.js', import.meta.url), 'utf8');
// The demo store reads an edited body back as text the way the browser does.
const { document } = new JSDOM('').window;

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
  vm.runInNewContext(source, {
    window, localStorage: storage, document, Date, JSON, Number, String, Array, Boolean, Error,
  });
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

test('demo lists survive a reload and filter the library', async () => {
  const storage = memoryStorage();
  const fetchJson = async (url, options) => url === '/api/demo-seed'
    ? [article('https://example.com/seed', 'Seed')]
    : article(options.body.url, 'Saved');
  const store = factory(storage)({ fetchJson, maxArticles: 5 });

  const list = await store.createCollection('  Longreads  ');
  assert.equal(list.name, 'Longreads');
  await assert.rejects(store.createCollection('longreads'), /already have a list/);

  const [seed] = await store.list('', 'all');
  await store.setArticleCollection(seed.id, list.id, true);
  assert.deepEqual((await store.list('', `collection:${list.id}`)).map(a => a.title), ['Seed']);
  assert.equal((await store.listCollections())[0].count, 1);

  const reloaded = factory(storage)({ fetchJson, maxArticles: 5 });
  assert.deepEqual((await reloaded.listCollections()).map(c => c.name), ['Longreads']);
  assert.deepEqual((await reloaded.get(seed.id)).collections, [list.id]);

  // deleting a list leaves its articles in the library
  await reloaded.deleteCollection(list.id);
  assert.deepEqual(await reloaded.listCollections(), []);
  assert.deepEqual((await reloaded.get(seed.id)).collections, []);
});

test('a trimmed body rewrites the text, the count and the excerpt', async () => {
  const storage = memoryStorage();
  const fetchJson = async (url, options) => url === '/api/demo-seed'
    ? [article('https://example.com/seed', 'Seed')]
    : article(options.body.url, 'Saved');
  const store = factory(storage)({ fetchJson, maxArticles: 5 });

  const [seed] = await store.list('', 'all');
  const trimmed = await store.patch(seed.id, { content_html: '<p>Two words</p><p>plus three more</p>' });
  assert.equal(trimmed.text_content, 'Two words plus three more');
  assert.equal(trimmed.word_count, 5);
  assert.equal(trimmed.excerpt, 'Two words plus three more');
  assert.ok(trimmed.edited_at);

  await assert.rejects(store.patch(seed.id, { content_html: '<p>  </p>' }), /leave the article empty/);
});

test('the read tab and the reset are both exact', async () => {
  const storage = memoryStorage();
  const fetchJson = async (url, options) => url === '/api/demo-seed'
    ? [article('https://example.com/a', 'A'), article('https://example.com/b', 'B')]
    : article(options.body.url, 'Saved');
  const store = factory(storage)({ fetchJson, maxArticles: 5 });

  const [first] = await store.list('', 'all');
  await store.patch(first.id, { read: true });
  assert.deepEqual((await store.list('', 'read')).map(a => a.title), [first.title]);
  assert.equal((await store.list('', 'unread')).length, 1);

  await store.createCollection('Keep');
  assert.equal((await store.removeAll()).deleted, 2);
  assert.equal((await store.list('', 'all')).length, 0);
  assert.equal((await store.listCollections()).length, 1);

  await store.removeAll({ includeLists: true });
  assert.equal((await store.listCollections()).length, 0);
});
