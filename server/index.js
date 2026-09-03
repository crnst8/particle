import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { createAuth } from './auth.js';
import { createDemoSeed, rateLimit } from './demo.js';
import { extractArticle, normalizeUrl, sanitizeArticleHtml, textFromHtml, BROWSER_UA } from './extract.js';
import { findArchiveSnapshot, parseArchiveUrl } from './archive-today.js';
import { claimTicket, createTicket, readTicket, settleTicket } from './handoff.js';
import { isLlmConfigured, assessArticle } from './llm.js';
import { createNarrator } from './narrator.js';
import { shortlistVoices, toneProfile } from './narration.js';
import { isTtsConfigured, listVoices, prewarmVoices } from './tts.js';
import { safeFetch } from './net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4747;
const DEMO_MODE = process.env.DEMO_MODE === '1';
const BASE = normalizeBase(process.env.PARTICLE_BASE || '');
const DB_PATH = process.env.PARTICLE_DB || new URL('../data/particle.db', import.meta.url).pathname;
const IMAGE_MAX_BYTES = positiveInt(process.env.IMAGE_MAX_BYTES, 8 * 1024 * 1024);
const DEMO_MAX_ARTICLES = positiveInt(process.env.DEMO_MAX_ARTICLES, 15);
// Page source handed back by the browser after a human clears an archive.today
// captcha. Snapshots are much larger than an ordinary API body.
const SNAPSHOT_MAX_BYTES = positiveInt(process.env.SNAPSHOT_MAX_BYTES, 8 * 1024 * 1024);

const pub = join(__dirname, '..', 'public');
const landing = join(__dirname, '..', 'landing');
const demo = join(__dirname, '..', 'demo');
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
const shellTemplate = readFileSync(join(pub, 'index.html'), 'utf8');
const manifestTemplate = JSON.parse(readFileSync(join(pub, 'manifest.webmanifest'), 'utf8'));
const store = DEMO_MODE ? null : await import('./db.js');
// Narration needs somewhere to keep the audio, so it follows the library server.
const narrator = store && isTtsConfigured ? createNarrator(store) : null;

const app = express();
app.disable('x-powered-by');
if (process.env.PARTICLE_TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(createAuth({
  base: BASE, dbPath: DB_PATH, persistSecret: !DEMO_MODE,
  // The bookmarklet posts from an archive.today tab and authorises itself with
  // a single-use ticket, so no session cookie reaches this one route.
  openPaths: [`${BASE}/api/handoff`],
}));

const pathAt = path => `${BASE}${path}` || '/';
const api = path => pathAt(`/api${path}`);

// Routes that accept pasted/fetched page source get a bigger body budget; they
// sit behind auth so the allowance is not open to the internet.
app.post([api('/extract'), api('/articles'), api('/articles/:id/refetch')],
  express.json({ limit: SNAPSHOT_MAX_BYTES }));
// The bookmarklet posts cross-origin, so it sends a CORS-simple text body.
app.post(api('/handoff'), express.text({ limit: SNAPSHOT_MAX_BYTES, type: '*/*' }));
app.use(express.json({ limit: '1mb' }));

// ── API ──────────────────────────────────────────────────────────────────────

app.get(api('/health'), (_req, res) => res.json({
  ok: true, app: 'particle', version: VERSION, demo: DEMO_MODE, narration: Boolean(narrator),
}));

if (DEMO_MODE) {
  const extractLimit = rateLimit({ limit: positiveInt(process.env.DEMO_EXTRACTS_PER_MINUTE, 10) });
  const getDemoSeed = createDemoSeed({
    extractArticle,
    urlsPath: process.env.DEMO_SEED_URLS || join(demo, 'seed-urls.txt'),
    fallbackPath: join(demo, 'fallback.json'),
  });

  app.post(api('/extract'), extractLimit, async (req, res) => {
    try {
      res.json(await extractArticle(req.body?.url, pageSource(req.body)));
    } catch (error) {
      extractionError(res, error);
    }
  });
  app.get(api('/demo-seed'), async (_req, res) => res.json(await getDemoSeed()));
  app.use([api('/articles'), api('/collections')],
    (_req, res) => res.status(404).json({ error: 'the demo library lives in your browser' }));
} else {
  registerLibraryRoutes(app);
}

// Where archive.today keeps a snapshot of this article. Answering this needs no
// captcha, so the browser can fetch the snapshot itself when the server is blocked.
app.get(api('/archive-snapshot'), DEMO_MODE ? rateLimit({ limit: 30 }) : (_req, _res, next) => next(),
  async (req, res) => {
    let target;
    try {
      target = normalizeUrl(req.query.url);
    } catch {
      return res.status(400).json({ error: 'invalid url' });
    }
    const pasted = typeof req.query.url === 'string' ? parseArchiveUrl(req.query.url) : null;
    const snapshotUrl = pasted?.snapshotUrl || await findArchiveSnapshot(target);
    if (!snapshotUrl) return res.status(404).json({ error: 'archive.today has no snapshot of that page' });
    res.json({ snapshot_url: snapshotUrl, original_url: target });
  });

// ── captcha handoff ─────────────────────────────────────────────────────────
// One ticket admits one delivery of page source from another origin. The
// bookmarklet carries the token, so the archive.today session that cleared the
// captcha is the one that reads the page — which a cookieless fetch cannot do.
app.post(api('/handoff/tickets'), (req, res) => {
  let url;
  try {
    url = normalizeUrl(req.body?.url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json({ ...createTicket(url), endpoint: `${req.protocol}://${req.get('host')}${api('/handoff')}` });
});

app.options(api('/handoff'), (_req, res) => {
  handoffCors(res);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.post(api('/handoff'), rateLimit({ limit: 20 }), async (req, res) => {
  handoffCors(res);
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    payload = null;
  }
  if (!payload?.token || typeof payload.html !== 'string' || !payload.html.trim()) {
    return res.status(400).json({ error: 'send { token, url, html }' });
  }

  const ticket = claimTicket(payload.token);
  if (!ticket) return res.status(404).json({ error: 'that particle handoff has expired — reopen the panel' });

  try {
    const extracted = await extractArticle(ticket.url, {
      html: payload.html,
      sourceUrl: typeof payload.url === 'string' ? payload.url : undefined,
    });
    const article = DEMO_MODE ? extracted : saveExtracted(extracted);
    settleTicket(payload.token, { article });
    res.json({ ok: true, title: article.title });
  } catch (error) {
    settleTicket(payload.token, { error: error.message });
    res.status(422).json({ error: error.message });
  }
});

app.get(api('/handoff/:token'), (req, res) => res.json(readTicket(req.params.token)));

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
  // The catalogue is a network round trip the first article would otherwise
  // wait on, and it changes about as often as the provider ships voices.
  if (narrator) prewarmVoices().catch(() => {});
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

    const source = pageSource(req.body);
    const existing = store.getByUrl(url);
    // Page source for an article already in the library rewrites it in place —
    // that is the captcha rescue finishing a save that came back partial.
    if (existing && !source.html) return res.json({ ...store.getArticle(existing.id), duplicate: true });

    try {
      const extracted = await extractArticle(url, source);
      // A short-code snapshot resolves to the story's own URL, which may already be filed.
      const filed = extracted.url === url ? existing : store.getByUrl(extracted.url);
      if (filed) {
        const updated = store.replaceArticleContent(filed.id, extracted);
        res.json(withChallenge(updated, extracted));
        if (isLlmConfigured) enrichInBackground(filed.id);
        return;
      }
      const saved = store.insertArticle(extracted);
      if (extracted.quality_note) store.updateArticle(saved.id, { quality_note: extracted.quality_note });
      res.status(201).json(withChallenge(store.getArticle(saved.id), extracted));
      if (isLlmConfigured) enrichInBackground(saved.id);
    } catch (error) {
      extractionError(res, error);
    }
  });

  router.post(api('/articles/:id/refetch'), async (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not found' });
    try {
      const extracted = await extractArticle(article.url, pageSource(req.body));
      const updated = store.replaceArticleContent(article.id, extracted);
      res.json(withChallenge(updated, extracted));
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
    if ('audio_pos' in body) fields.audio_pos = Math.max(0, Number(body.audio_pos) || 0);
    // A hand-trimmed body: re-sanitised here, and its text and word count
    // recomputed so search and the reading estimate follow the edit.
    if (typeof body.content_html === 'string') {
      const clean = sanitizeArticleHtml(body.content_html);
      const { text, wordCount } = textFromHtml(clean);
      if (!text) return res.status(400).json({ error: 'that edit would leave the article empty' });
      fields.content_html = clean;
      fields.text_content = text;
      fields.word_count = wordCount;
      fields.excerpt = text.slice(0, 300);
      fields.edited_at = new Date().toISOString();
    }
    res.json(store.updateArticle(id, fields));
  });

  router.delete(api('/articles/:id'), (req, res) => {
    store.deleteArticle(Number(req.params.id));
    res.json({ ok: true });
  });

  // Settings → reset. Destructive and unrecoverable, so it is its own route
  // rather than a flag on anything else.
  router.delete(api('/articles'), (req, res) => {
    res.json(store.deleteAllArticles({ includeCollections: req.query.lists === '1' }));
  });

  // ── collections ───────────────────────────────────────────────────────────
  router.get(api('/collections'), (_req, res) => res.json(store.listCollections()));

  router.post(api('/collections'), (req, res) => {
    try {
      res.status(201).json(store.createCollection(req.body?.name));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.patch(api('/collections/:id'), (req, res) => {
    const id = Number(req.params.id);
    if (!store.getCollection(id)) return res.status(404).json({ error: 'not found' });
    try {
      res.json(store.renameCollection(id, req.body?.name));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete(api('/collections/:id'), (req, res) => {
    store.deleteCollection(Number(req.params.id));
    res.json({ ok: true });
  });

  router.put(api('/articles/:id/collections/:collectionId'), (req, res) => {
    const id = Number(req.params.id);
    const collectionId = Number(req.params.collectionId);
    if (!store.getArticle(id)) return res.status(404).json({ error: 'not found' });
    if (!store.getCollection(collectionId)) return res.status(404).json({ error: 'no such list' });
    res.json(store.setArticleCollection(id, collectionId, req.body?.member !== false));
  });

  if (narrator) registerNarrationRoutes(router);
}

/* ── narration ───────────────────────────────────────────────────────────────
   The script and the casting come back as one manifest; the audio for each
   segment is a separate URL the player pulls as it goes, which is what keeps a
   long article from being synthesised in full before a word is heard. */
function registerNarrationRoutes(router) {
  const findArticle = (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) res.status(404).json({ error: 'not found' });
    return article;
  };

  /* `for` is an article id: the same ranking that cast it, so the picker offers
     the voices that suit this piece rather than whichever the provider lists
     first. Without it the catalogue comes back in the provider's own order. */
  router.get(api('/narration/voices'), async (req, res) => {
    try {
      const voices = await listVoices(String(req.query.lang || 'en'));
      const article = req.query.for ? store.getArticle(Number(req.query.for)) : null;
      const profile = article ? toneProfile(article) : null;
      const ranked = article ? shortlistVoices(article, voices, profile) : voices;
      res.json(ranked.map(({ id, title, description, tags, sample }, index) => ({
        id, title, description, tags, sample,
        suits: Boolean(article) && index < 6,
      })));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.get(api('/articles/:id/narration'), async (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    const existing = store.getNarration(article.id);
    if (!existing) return res.status(404).json({ error: 'not narrated yet' });
    res.set('Cache-Control', 'no-store');
    res.json(narrator.manifest(article, existing));
  });

  router.post(api('/articles/:id/narration'), async (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    if (!article.text_content) return res.status(422).json({ error: 'nothing to read aloud' });
    try {
      const narration = await narrator.ensure(article, {
        force: Boolean(req.body?.force),
        voiceId: typeof req.body?.voice_id === 'string' ? req.body.voice_id.trim() : null,
      });
      const manifest = narrator.manifest(article, narration);
      res.set('Cache-Control', 'no-store');
      res.json(manifest);
      narrator.warm(article, narration, Math.max(0, Number(req.body?.from) || 0));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  /* What the narration is doing right now, as it does it. Casting and synthesis
     take real seconds and a reader deserves to know which one they are in, so
     the stages are streamed rather than guessed at by the client. Registered
     ahead of the segment route: "status" is not a segment number. */
  router.get(api('/articles/:id/narration/status'), (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      // nginx buffers event streams into uselessness unless told not to
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const stop = narrator.watch(article.id, send);
    // a comment frame no client reads, purely so proxies keep the socket open
    const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
    beat.unref?.();
    req.on('close', () => { clearInterval(beat); stop(); });
  });

  router.get(api('/articles/:id/narration/:seq'), async (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    const narration = store.getNarration(article.id);
    if (!narration) return res.status(404).json({ error: 'not narrated yet' });

    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'bad segment' });

    try {
      const { audio, duration } = await narrator.segment(article, narration, seq);
      store.touchNarration(article.id);
      sendAudio(req, res, audio, { duration, rev: narrator.rev(narration), asked: String(req.query.v || '') });
      narrator.warm(article, narration, seq + 1);
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  router.delete(api('/articles/:id/narration'), (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    narrator.drop(article.id);
    res.json({ ok: true });
  });
}

// Segments are small and complete, but Safari will not start playback without a
// range answer, so give it one.
function sendAudio(req, res, audio, { duration, rev, asked }) {
  res.set('Content-Type', 'audio/mpeg');
  // The URL carries the casting's revision, so an answer that matches keeps for
  // a week. Anything else is the article's *current* audio under a stale name —
  // recasting reuses the segment numbers — and must not be remembered.
  res.set('Cache-Control', rev && asked === rev ? 'private, max-age=604800, immutable' : 'no-store');
  res.set('X-Narration-Duration', String(duration));
  res.set('Accept-Ranges', 'bytes');

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range) return res.status(200).send(audio);

  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
  if (!(start <= end && start < audio.length)) {
    return res.status(416).set('Content-Range', `bytes */${audio.length}`).end();
  }
  res.status(206)
    .set('Content-Range', `bytes ${start}-${end}/${audio.length}`)
    .send(audio.subarray(start, end + 1));
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
  const payload = { error: error?.message || 'article extraction failed' };
  // 428 carries the snapshot a reader can unlock by hand; the app offers to retry with it.
  if (error?.challenge) payload.challenge = error.challenge;
  res.status(status).json(payload);
}

// Page source the browser fetched (or a reader pasted) instead of the server.
function pageSource(body) {
  const html = typeof body?.html === 'string' && body.html.trim() ? body.html : undefined;
  const sourceUrl = typeof body?.source_url === 'string' ? body.source_url : undefined;
  return html ? { html, sourceUrl } : {};
}

function handoffCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Vary', 'Origin');
}

/* File an article the bookmarklet delivered, rewriting the row in place when the
   same story is already saved — that is a partial extraction being rescued. */
function saveExtracted(extracted) {
  const existing = store.getByUrl(extracted.url);
  if (existing) {
    const updated = store.replaceArticleContent(existing.id, extracted);
    if (isLlmConfigured) enrichInBackground(existing.id);
    return updated;
  }
  const saved = store.insertArticle(extracted);
  if (extracted.quality_note) store.updateArticle(saved.id, { quality_note: extracted.quality_note });
  if (isLlmConfigured) enrichInBackground(saved.id);
  return store.getArticle(saved.id);
}

function withChallenge(article, extracted) {
  return extracted?.challenge ? { ...article, challenge: extracted.challenge } : article;
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
