import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { createAuth } from './auth.js';
import { createDemoSeed, rateLimit } from './demo.js';
import { extractArticle, normalizeUrl, BROWSER_UA } from './extract.js';
import { isLlmConfigured, assessArticle } from './llm.js';
import { safeFetch } from './net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4747;
const DEMO_MODE = process.env.DEMO_MODE === '1';
const BASE = normalizeBase(process.env.PARTICLE_BASE || '');
const DB_PATH = process.env.PARTICLE_DB || new URL('../data/particle.db', import.meta.url).pathname;
const IMAGE_MAX_BYTES = positiveInt(process.env.IMAGE_MAX_BYTES, 8 * 1024 * 1024);
const DEMO_MAX_ARTICLES = positiveInt(process.env.DEMO_MAX_ARTICLES, 15);

const pub = join(__dirname, '..', 'public');
const landing = join(__dirname, '..', 'landing');
const demo = join(__dirname, '..', 'demo');
const shellTemplate = readFileSync(join(pub, 'index.html'), 'utf8');
const manifestTemplate = JSON.parse(readFileSync(join(pub, 'manifest.webmanifest'), 'utf8'));
const store = DEMO_MODE ? null : await import('./db.js');

const app = express();
app.disable('x-powered-by');
if (process.env.PARTICLE_TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(createAuth({ base: BASE, dbPath: DB_PATH, persistSecret: !DEMO_MODE }));

const pathAt = path => `${BASE}${path}` || '/';
const api = path => pathAt(`/api${path}`);

// ── API ──────────────────────────────────────────────────────────────────────

app.get(api('/health'), (_req, res) => res.json({ ok: true, app: 'particle', demo: DEMO_MODE }));

if (DEMO_MODE) {
  const extractLimit = rateLimit({ limit: positiveInt(process.env.DEMO_EXTRACTS_PER_MINUTE, 10) });
  const getDemoSeed = createDemoSeed({
    extractArticle,
    urlsPath: process.env.DEMO_SEED_URLS || join(demo, 'seed-urls.txt'),
    fallbackPath: join(demo, 'fallback.json'),
  });

  app.post(api('/extract'), extractLimit, async (req, res) => {
    try {
      res.json(await extractArticle(req.body?.url));
    } catch (error) {
      extractionError(res, error);
    }
  });
  app.get(api('/demo-seed'), async (_req, res) => res.json(await getDemoSeed()));
  app.use(api('/articles'), (_req, res) => res.status(404).json({ error: 'the demo library lives in your browser' }));
} else {
  registerLibraryRoutes(app);
}

// Image proxy: strips Referer so hotlink-protected article images still load.
// Every redirect is revalidated by safeFetch and the body is capped while read.
app.get(api('/image'), DEMO_MODE ? rateLimit({ limit: 120 }) : (_req, _res, next) => next(), async (req, res) => {
  let target;
  try {
    if (typeof req.query.url !== 'string') throw new Error('missing URL');
    target = new URL(req.query.url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'invalid image URL' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const upstream = await safeFetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(contentType)) return res.status(415).end();
    const advertised = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > IMAGE_MAX_BYTES) {
      controller.abort();
      return res.status(413).json({ error: 'image exceeds configured byte limit' });
    }

    const chunks = [];
    let bytes = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        bytes += chunk.byteLength;
        if (bytes > IMAGE_MAX_BYTES) {
          controller.abort();
          return res.status(413).json({ error: 'image exceeds configured byte limit' });
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(Buffer.concat(chunks));
  } catch (error) {
    if (error?.code === 'ERR_PRIVATE_ADDRESS') return res.status(403).json({ error: error.message });
    if (error?.name === 'AbortError') return res.status(504).end();
    res.status(502).end();
  } finally {
    clearTimeout(timeout);
  }
});

// ── Static frontend ─────────────────────────────────────────────────────────

app.get(pathAt('/manifest.webmanifest'), (_req, res) => {
  const scope = BASE ? `${BASE}/` : '/';
  res.type('application/manifest+json').send({
    ...manifestTemplate,
    start_url: scope,
    scope,
    icons: manifestTemplate.icons.map(icon => ({ ...icon, src: `${BASE}${icon.src}` })),
    share_target: { ...manifestTemplate.share_target, action: scope },
  });
});

app.use(BASE || '/', express.static(pub, { maxAge: '1h', index: false }));
app.get(BASE ? [BASE, `${BASE}/`] : '/', (_req, res) => res.type('html').send(renderShell()));

// SPA fallback: extensionless app routes resolve to the shell; missing files 404.
app.get(BASE ? `${BASE}/{*path}` : '/{*path}', (req, res, next) => {
  if (req.path.startsWith(api('/')) || extname(req.path)) return next();
  res.type('html').send(renderShell());
});

if (DEMO_MODE) {
  app.use('/icons', express.static(join(pub, 'icons'), { maxAge: '1d' }));
  app.use('/', express.static(landing, { maxAge: '1h', index: 'index.html' }));
}

app.listen(PORT, () => {
  const mode = DEMO_MODE ? `demo at ${BASE || '/'}` : 'library';
  console.log(`particle ${mode} listening on :${PORT}`);
});

function registerLibraryRoutes(router) {
  router.get(api('/articles'), (req, res) => {
    res.json(store.listArticles({ q: req.query.q, filter: req.query.filter }));
  });

  router.get(api('/articles/:id'), (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not found' });
    res.json(article);
  });

  router.post(api('/articles'), async (req, res) => {
    let url;
    try {
      url = normalizeUrl(req.body?.url);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const existing = store.getByUrl(url);
    if (existing) return res.json({ ...store.getArticle(existing.id), duplicate: true });

    try {
      const extracted = await extractArticle(url);
      const saved = store.insertArticle(extracted);
      if (extracted.quality_note) store.updateArticle(saved.id, { quality_note: extracted.quality_note });
      res.status(201).json(store.getArticle(saved.id));
      if (isLlmConfigured) enrichInBackground(saved.id);
    } catch (error) {
      extractionError(res, error);
    }
  });

  router.post(api('/articles/:id/refetch'), async (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not found' });
    try {
      const extracted = await extractArticle(article.url);
      const updated = store.replaceArticleContent(article.id, extracted);
      res.json(updated);
      if (isLlmConfigured) enrichInBackground(article.id);
    } catch (error) {
      extractionError(res, error);
    }
  });

  router.patch(api('/articles/:id'), (req, res) => {
    const id = Number(req.params.id);
    if (!store.getArticle(id)) return res.status(404).json({ error: 'not found' });
    const fields = {};
    const body = req.body || {};
    if ('favorite' in body) fields.favorite = body.favorite ? 1 : 0;
    if ('archived' in body) fields.archived = body.archived ? 1 : 0;
    if ('progress' in body) fields.progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
    if ('read' in body) fields.read_at = body.read ? new Date().toISOString() : null;
    if ('tags' in body && Array.isArray(body.tags)) fields.tags = body.tags;
    res.json(store.updateArticle(id, fields));
  });

  router.delete(api('/articles/:id'), (req, res) => {
    store.deleteArticle(Number(req.params.id));
    res.json({ ok: true });
  });
}

function normalizeBase(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (!trimmed.startsWith('/') || /[?#]/.test(trimmed)) {
    throw new Error('PARTICLE_BASE must be an absolute URL path such as /particle');
  }
  return trimmed.replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function analyticsTag() {
  const src = process.env.ANALYTICS_SRC;
  const siteId = process.env.ANALYTICS_SITE_ID;
  if (!src || !siteId) return '';
  let url;
  try { url = new URL(src); } catch { return ''; }
  if (!/^https?:$/.test(url.protocol)) return '';
  return `<script defer src="${htmlEscape(url.href)}" data-website-id="${htmlEscape(siteId)}"></script>`;
}

function renderShell() {
  return shellTemplate
    .replaceAll('__PARTICLE_BASE__', BASE)
    .replaceAll('__PARTICLE_DEMO__', DEMO_MODE ? '1' : '0')
    .replaceAll('__PARTICLE_DEMO_MAX__', String(DEMO_MAX_ARTICLES))
    .replaceAll('__PARTICLE_ANALYTICS__', analyticsTag());
}

function extractionError(res, error) {
  const status = error?.statusCode || (error?.code === 'ERR_PRIVATE_ADDRESS' ? 403 : 422);
  res.status(status).json({ error: error?.message || 'article extraction failed' });
}

async function enrichInBackground(id) {
  try {
    const article = store.getArticle(id);
    if (!article?.text_content) return;
    const verdict = await assessArticle(article);
    const patch = { tags: verdict.tags };
    if (article.quality !== 'partial' || verdict.quality === 'stub') patch.quality = verdict.quality;
    if (verdict.note) patch.quality_note = verdict.note;
    store.updateArticle(id, patch);
  } catch (error) {
    console.error(`enrich #${id} failed:`, error.message);
  }
}
