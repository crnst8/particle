import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { createAuth } from './auth.js';
import { createDemoSeed, rateLimit } from './demo.js';
import { extractArticle, linkStub, normalizeUrl, sanitizeArticleHtml, textFromHtml, BROWSER_UA } from './extract.js';
import { findArchiveSnapshot, parseArchiveUrl } from './archive-today.js';
import { claimTicket, createTicket, readTicket, settleTicket } from './handoff.js';
import { isLlmConfigured, assessArticle } from './llm.js';
import { createNarrator } from './narrator.js';
import { shortlistVoices, toneProfile } from './narration.js';
import { contentRevision } from './narration-identity.js';
import {
  isTtsConfigured, synthesize, synthesisConfig, fetchVoicePages, VOICE_LOCKED, pinnedVoiceId, audioFormat, audioMime,
} from './tts.js';
import { createVoiceCatalogue } from './voice-catalogue.js';
import { parseRange } from './http-range.js';
import { validBookmark } from '../public/narration-model.js';
import { safeFetch } from './net.js';
import { log, readScreenshot, screenshotMaxBytes, screenshotReadingEnabled } from './screenshot.js';
import { isCertain, resolveCandidates } from './resolve.js';

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
const catalogue = store && isTtsConfigured ? createVoiceCatalogue({
  fetchPages: language => fetchVoicePages(language),
  load: language => store.loadCatalogue(language),
  save: (language, voices, fetchedAt) => store.saveCatalogue(language, voices, fetchedAt),
  log: message => console.error(`tts: ${message}`),
}) : null;
const narrator = catalogue ? createNarrator(store, {
  synthesize,
  synthesisConfig,
  catalogue,
  audioFormat,
  audioMime,
  lockedVoiceId: VOICE_LOCKED ? pinnedVoiceId : null,
  envVoiceId: VOICE_LOCKED ? null : pinnedVoiceId,
  concurrency: positiveInt(process.env.TTS_CONCURRENCY, 4),
  maxCacheBytes: positiveInt(process.env.TTS_MAX_CACHE_MB, 512) * 1024 * 1024,
  warmAhead: Math.min(12, positiveInt(process.env.TTS_WARM_AHEAD, 6)),
  log: message => console.error(message),
}) : null;

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
// A screenshot arrives as its own bytes rather than wrapped in JSON: base64 in
// a body costs a third again in size, on the one route where size is the cost.
app.post(api('/screenshot'), express.raw({ type: 'image/*', limit: screenshotMaxBytes }));
app.use(express.json({ limit: '1mb' }));

// ── API ──────────────────────────────────────────────────────────────────────

app.get(api('/health'), (_req, res) => res.json({
  ok: true, app: 'particle', version: VERSION, demo: DEMO_MODE, narration: Boolean(narrator),
  screenshots: screenshotReadingEnabled, tagging: isLlmConfigured,
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
      const fallback = linkFallback(req.body);
      if (!fallback) return extractionError(res, error);
      try {
        res.json(linkStub(normalizeUrl(req.body?.url), { ...fallback, note: error.message }));
      } catch {
        extractionError(res, error);
      }
    }
  });
  app.get(api('/demo-seed'), async (_req, res) => res.json(await getDemoSeed()));
  app.use([api('/articles'), api('/collections')],
    (_req, res) => res.status(404).json({ error: 'the demo library lives in your browser' }));
} else {
  registerLibraryRoutes(app);
}

/* A screenshot, read for the article it points at.

   This one only reads and looks up — it files nothing — so it is the same route
   in demo mode, and a reader can see what particle made of a picture before
   anything lands in the library. Saving is the ordinary POST /api/articles that
   follows, with whatever the reader picked.

   It answers in stages rather than at the end. Reading a picture and then
   asking four archives about it is the slowest thing particle does, and a
   spinner for a minute is indistinguishable from a hang — so every stage is
   written out as it happens, one JSON object per line. */
app.post(api('/screenshot'), DEMO_MODE ? rateLimit({ limit: 6 }) : (_req, _res, next) => next(),
  async (req, res) => {
    if (!screenshotReadingEnabled) {
      return res.status(501).json({ error: 'particle cannot read screenshots: set LLM_API_KEY, or leave OCR on' });
    }
    res.type('application/x-ndjson');
    res.set('Cache-Control', 'no-store');
    // Proxies that buffer a response would hold every stage back to the end,
    // which is the one thing this shape exists to avoid.
    res.set('X-Accel-Buffering', 'no');

    const emit = (event) => res.write(`${JSON.stringify(event)}\n`);
    const started = Date.now();
    try {
      emit({ phase: 'received', kb: Math.round((req.body?.length || 0) / 1024) });
      const seen = await readScreenshot(req.body, req.get('content-type'),
        (phase, detail) => emit({ phase, ...detail }));
      emit({
        phase: 'read',
        source: seen.source,
        titles: seen.candidates.map(one => one.title || one.url),
      });

      const candidates = await resolveCandidates(seen.candidates, one => emit({
        phase: 'looked',
        title: one.title || one.url,
        found: Boolean(one.url),
      }));
      emit({
        phase: 'done',
        source: seen.source,
        poster: seen.poster,
        ms: Date.now() - started,
        candidates: candidates.map(one => ({ ...one, certain: isCertain(one) })),
      });
      log(`done in ${Date.now() - started}ms`);
    } catch (error) {
      const message = error?.code === 'ERR_PRIVATE_ADDRESS'
        ? error.message
        : error?.message || 'that screenshot could not be read';
      log(`failed after ${Date.now() - started}ms — ${message}`, 'error');
      emit({ phase: 'failed', error: message });
    }
    res.end();
  });

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

/* The PWA share target posts here, and the service worker answers it. This is
   only reached when no worker is controlling yet — a first launch, or an update
   swapping over — where opening the app empty-handed beats a 404. */
app.post(BASE ? [BASE, `${BASE}/`] : '/', (_req, res) => res.redirect(303, `${BASE}/` || '/'));

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
  // Listening never waits on the catalogue, but the picker does the first time;
  // fetch it now (or refresh the saved copy) so it rarely has to.
  if (catalogue) catalogue.get('en', { wait: 0 }).catch(() => {});
});

function registerLibraryRoutes(router) {
  router.get(api('/articles'), (req, res) => {
    res.json(store.listArticles({ q: req.query.q, filter: req.query.filter }));
  });

  router.get(api('/articles/:id'), (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not found' });
    res.json(withNarrationState(article));
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

    const file = (extracted, status) => {
      // A short-code snapshot resolves to the story's own URL, which may already be filed.
      const filed = extracted.url === url ? existing : store.getByUrl(extracted.url);
      if (filed) {
        const updated = store.replaceArticleContent(filed.id, extracted);
        narrator?.invalidate(filed.id);
        res.json(withChallenge(withNarrationState(updated), extracted));
        return filed.id;
      }
      const saved = store.insertArticle(extracted);
      if (extracted.quality_note) store.updateArticle(saved.id, { quality_note: extracted.quality_note });
      res.status(status).json(withChallenge(store.getArticle(saved.id), extracted));
      return saved.id;
    };

    try {
      const id = file(await extractArticle(url, source), 201);
      if (isLlmConfigured) enrichInBackground(id);
    } catch (error) {
      // A link the reader found is worth keeping even when the page will not be
      // read — that is the whole of what a screenshot recovered.
      const fallback = linkFallback(req.body);
      if (!fallback) return extractionError(res, error);
      file(linkStub(url, { ...fallback, note: error.message }), 201);
    }
  });

  router.post(api('/articles/:id/refetch'), async (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not found' });
    try {
      const extracted = await extractArticle(article.url, pageSource(req.body));
      const updated = store.replaceArticleContent(article.id, extracted);
      narrator?.invalidate(article.id);
      res.json(withChallenge(withNarrationState(updated), extracted));
      if (isLlmConfigured) enrichInBackground(article.id);
    } catch (error) {
      extractionError(res, error);
    }
  });

  /* Tagging happens on save, so a library that predates the key, or outlived a
     provider outage, has holes in it. This is the one way to fill them without
     re-saving: what is untagged, and a button that tags it. The run is answered
     immediately and watched by polling; the sheet is open for seconds, the run
     takes minutes. */
  router.get(api('/tagging'), (_req, res) => res.json(taggingStatus()));

  router.post(api('/tagging'), (_req, res) => {
    if (!isLlmConfigured) return res.status(409).json({ error: 'tagging is off: LLM_API_KEY is not set' });
    startTagBackfill();
    res.status(202).json(taggingStatus());
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
      // marking a paragraph "skip when reading aloud" changes what is spoken,
      // not what is saved; it is not a trim and does not say "trimmed"
      const previous = store.getArticle(id).content_html || '';
      if (withoutSpeechMarks(clean) !== withoutSpeechMarks(sanitizeArticleHtml(previous))) {
        fields.edited_at = new Date().toISOString();
      }
    }
    const updated = store.updateArticle(id, fields);
    if ('content_html' in fields) narrator?.invalidate(id);
    res.json(withNarrationState(updated));
  });

  router.delete(api('/articles/:id'), (req, res) => {
    const id = Number(req.params.id);
    narrator?.forget(id);
    store.deleteArticle(id);
    res.json({ ok: true });
  });

  // Settings → reset. Destructive and unrecoverable, so it is its own route
  // rather than a flag on anything else.
  router.delete(api('/articles'), (req, res) => {
    narrator?.invalidateAll();
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
   Preparing returns a manifest — the script, the voice, where to start — and
   each passage's audio is its own URL under the variant's revision, pulled as
   the player reaches it. A revision names exact bytes: no URL ever serves a
   different voice or script than the one it names. */
function registerNarrationRoutes(router) {
  const findArticle = (req, res) => {
    const article = store.getArticle(Number(req.params.id));
    if (!article) res.status(404).json({ error: 'not found', code: 'not_found' });
    return article;
  };
  const fail = (res, error) => {
    const status = error?.statusCode || (error?.code === 'cancelled' ? 409 : 502);
    const { statusCode: _s, message, code, retryable, stack: _stack, name: _name, ...extra } = error || {};
    res.status(status).json({
      error: message || 'narration failed',
      code: code || 'failed',
      retryable: Boolean(retryable ?? status >= 500),
      ...pick(extra, ['voice_version', 'voice', 'blocks', 'bookmark', 'version', 'settings', 'retryAfterMs']),
    });
  };

  // ── settings ──
  router.get(api('/narration/settings'), (_req, res) => {
    const settings = store.getNarrationSettings();
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: true,
      default_voice_id: settings.default_voice_id,
      default_voice_name: settings.default_voice_name,
      version: settings.version,
      locked: VOICE_LOCKED,
      locked_voice: VOICE_LOCKED ? { id: pinnedVoiceId, name: catalogue.known(pinnedVoiceId)?.title || 'locked voice' } : null,
      configured_voice: !VOICE_LOCKED && pinnedVoiceId ? { id: pinnedVoiceId, name: catalogue.known(pinnedVoiceId)?.title || 'configured voice' } : null,
    });
  });

  router.patch(api('/narration/settings'), (req, res) => {
    const body = req.body || {};
    const voice = voiceInput(body.default_voice_id, body.default_voice_name);
    if (voice === undefined) return res.status(400).json({ error: 'default_voice_id must be a voice id or null', code: 'bad_request' });
    if (!Number.isSafeInteger(body.expected_version)) return res.status(400).json({ error: 'expected_version is required', code: 'bad_request' });
    if (VOICE_LOCKED) return res.status(409).json({ error: 'this install reads every article in one voice', code: 'voice_locked' });
    const result = store.updateNarrationSettings({
      default_voice_id: voice?.id ?? null,
      default_voice_name: voice?.name ?? null,
      expected_version: body.expected_version,
    });
    res.set('Cache-Control', 'no-store');
    if (!result.ok) return res.status(409).json({ error: 'the default voice was changed elsewhere', code: 'settings_conflict', settings: result.settings });
    res.json(result.settings);
  });

  /* The catalogue as the picker shows it. `for` is an article id: the same
     ranking an automatic choice would use, so the voices that suit this piece
     come first. The library's saved choices are always listed, catalogue or no
     catalogue, so a choice can be seen and kept while the provider is away. */
  router.get(api('/narration/voices'), async (req, res) => {
    const language = /^[a-z]{2,3}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
    const listing = await catalogue.get(language);
    const article = req.query.for ? store.getArticle(Number(req.query.for)) : null;
    const ranked = article ? shortlistVoices(article, listing.voices, toneProfile(article)) : listing.voices;
    const voices = ranked.map(({ id, title, description, tags, sample }, index) => ({
      id, title, description, tags: (tags || []).slice(0, 8), sample, suits: Boolean(article) && index < 6,
    }));
    const settings = store.getNarrationSettings();
    const saved = [];
    const keep = (id, name, role) => {
      if (!id || saved.some(one => one.id === id)) return;
      const known = voices.find(one => one.id === id);
      saved.push({ id, title: known?.title || name || 'chosen voice', role, listed: Boolean(known), sample: known?.sample || null });
    };
    keep(settings.default_voice_id, settings.default_voice_name, 'default');
    if (article?.narration_voice_id) keep(article.narration_voice_id, article.narration_voice_name, 'article');
    if (VOICE_LOCKED) keep(pinnedVoiceId, 'locked voice', 'locked');
    res.set('Cache-Control', 'no-store');
    res.json({ voices, saved, stale: listing.stale, refreshing: listing.refreshing, error_code: listing.error_code, fetched_at: listing.fetched_at });
  });

  router.get(api('/narration/diagnostics'), (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(narrator.diagnostics());
  });

  // ── one article ──
  // Registered before "/:seq": none of these words is a passage number.
  router.get(api('/articles/:id/narration/blocks'), (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(narrator.blocks(Number(req.params.id)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get(api('/articles/:id/narration'), (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(narrator.current(Number(req.params.id), typeof req.query.rev === 'string' ? req.query.rev : null));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post(api('/articles/:id/narration'), (req, res) => {
    const body = req.body || {};
    const prepare = {
      request_id: shortString(body.request_id, 64),
      session_id: shortString(body.session_id, 64),
      generation: Number.isSafeInteger(body.generation) ? body.generation : 0,
      start: startInput(body.start),
    };
    if (prepare.start === undefined) return res.status(400).json({ error: 'start is not one of resume, beginning or block', code: 'bad_request' });
    if ('voice_override' in body) {
      const voice = body.voice_override === null ? null : voiceInput(body.voice_override?.id, body.voice_override?.name);
      if (voice === undefined) return res.status(400).json({ error: 'voice_override must be {id, name} or null', code: 'bad_request' });
      if (!Number.isSafeInteger(body.expected_voice_version)) {
        return res.status(400).json({ error: 'expected_voice_version is required to change the voice', code: 'bad_request' });
      }
      prepare.voice_override = voice;
      prepare.expected_voice_version = body.expected_voice_version;
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.json(narrator.prepare(Number(req.params.id), prepare));
    } catch (error) {
      fail(res, error);
    }
  });

  router.put(api('/articles/:id/narration/position'), (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    const body = req.body || {};
    const bookmark = body.bookmark === null ? null : validBookmark(body.bookmark);
    if (body.bookmark !== null && !bookmark) return res.status(400).json({ error: 'that is not a bookmark', code: 'bad_request' });
    if (!Number.isSafeInteger(body.expected_version)) return res.status(400).json({ error: 'expected_version is required', code: 'bad_request' });
    if (bookmark && !knownPlace(article.id, bookmark)) {
      return res.status(422).json({ error: 'that bookmark names a passage this article does not have', code: 'unknown_place' });
    }
    const result = store.updateBookmark(article.id, bookmark, body.expected_version);
    res.set('Cache-Control', 'no-store');
    if (!result.ok) {
      return res.status(409).json({ error: 'the bookmark was moved on another device', code: 'bookmark_conflict', bookmark: result.bookmark, version: result.version });
    }
    res.json({ bookmark: result.bookmark, version: result.version });
  });

  router.post(api('/articles/:id/narration/demand'), (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(narrator.demand(Number(req.params.id), req.body || {}));
    } catch (error) {
      fail(res, error);
    }
  });

  /* What the narration is doing right now, as it does it. Each event names the
     revision, passage and request it belongs to, so a player can ignore what is
     not its own; the player works without this stream entirely. */
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

  /* One passage of one exact variant. The revision is required: answering a
     bare number with whatever the article currently sounds like is how a stale
     page used to get a paragraph in a voice the reader had already replaced. */
  router.get(api('/articles/:id/narration/:seq'), async (req, res) => {
    const id = Number(req.params.id);
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'bad segment', code: 'bad_request' });
    const rev = typeof req.query.v === 'string' ? req.query.v : '';
    if (!rev) return res.status(409).json({ error: 'a narration revision is required', code: 'revision_required' });

    const controller = new AbortController();
    // `close` on the response, not the request: the request side closes as soon
    // as its (empty) body has been read
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const { audio, duration } = await narrator.segment(id, rev, seq, {
        signal: controller.signal,
        priority: req.query.priority === 'background' ? 'background' : 'foreground',
      });
      if (controller.signal.aborted) return;
      sendAudio(req, res, audio, { duration, etag: `"${rev}-${seq}-${audio.length}"` });
    } catch (error) {
      if (controller.signal.aborted || res.headersSent) return;
      fail(res, error);
    }
  });

  router.delete(api('/articles/:id/narration'), (req, res) => {
    const article = findArticle(req, res);
    if (!article) return;
    narrator.drop(article.id);
    res.json({ ok: true });
  });

  /* A bookmark is accepted only for a passage that exists: in a kept variant,
     or in the script the article has right now. */
  function knownPlace(articleId, bookmark) {
    if (bookmark.rev === 'legacy') return true;
    const variant = store.getVariant(articleId, bookmark.rev) || store.getVariantByScript(articleId, bookmark.script_id);
    if (!variant) return false;
    const segment = variant.script.segments.find(one => one.id === bookmark.segment_id);
    return Boolean(segment) && segment.block_id === bookmark.block_id;
  }
}

/* A voice from the request: an id and a label, both bounded, no control
   characters. null means "none" (Automatic, or back to the default);
   undefined means the input was not one of those. */
function voiceInput(id, name) {
  if (id === null) return null;
  if (typeof id !== 'string') return undefined;
  const clean = id.trim();
  if (!clean || clean.length > 256 || /[\u0000-\u001f\u007f]/.test(clean)) return undefined;
  const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256) : '';
  return { id: clean, name: label || null };
}

function startInput(start) {
  if (start === undefined || start === null) return { mode: 'resume' };
  if (typeof start !== 'object') return undefined;
  if (start.mode === 'beginning') return { mode: 'beginning' };
  if (start.mode === 'resume' || start.mode === undefined) {
    return { mode: 'resume', ...(start.bookmark ? { bookmark: validBookmark(start.bookmark) } : {}) };
  }
  if (start.mode === 'block' && typeof start.block_id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(start.block_id)) {
    const revision = shortString(start.content_revision, 64);
    return { mode: 'block', block_id: start.block_id, ...(revision ? { content_revision: revision } : {}) };
  }
  return undefined;
}

const shortString = (value, max) => (typeof value === 'string' && value.length <= max ? value : undefined);
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));

/* What the reader needs alongside an article to offer Listen, Resume or Listen
   again without asking anything else: its content revision and its bookmark. */
function withNarrationState(article) {
  if (!article) return article;
  return {
    ...article,
    content_revision: contentRevision(article),
    audio_bookmark: safeParse(article.audio_bookmark),
  };
}

function safeParse(value) {
  if (!value || typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}

/* A body with the reader's speech marks taken out, to tell a trim from a mark.
   Whitespace between tags is layout, not content, and the browser's copy of
   the body does not keep it the way the stored one does. */
function withoutSpeechMarks(html) {
  return String(html || '')
    .replace(/\s+data-particle-speech="(?:exclude|include)"/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/* Passages are small and complete, and each URL names exact bytes, so a full
   answer is cached hard. Ranges are answered properly — Safari will not start
   playback without one, and media elements seek with them. */
function sendAudio(req, res, audio, { duration, etag }) {
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.set('ETag', etag);
  res.set('X-Narration-Duration', String(duration));
  res.set('Accept-Ranges', 'bytes');

  // If-Range with a different validator means "the whole thing", not the slice
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? { type: 'none' } : parseRange(req.headers.range, audio.length);
  if (range.type === 'unsatisfiable') {
    return res.status(416).set('Content-Range', `bytes */${audio.length}`).end();
  }
  if (range.type !== 'range') {
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('Content-Length', String(audio.length));
    return res.status(200).end(audio);
  }
  const slice = audio.subarray(range.start, range.end + 1);
  res.status(206)
    .set('Content-Range', `bytes ${range.start}-${range.end}/${audio.length}`)
    .set('Content-Length', String(slice.length))
    .end(slice);
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

/* What the reader knows about an article whose page would not open — read off a
   screenshot, and worth filing under even when nothing else could be. Absent
   means the caller wants the failure, not a stub. */
function linkFallback(body) {
  if (!body || body.link_fallback === undefined || body.link_fallback === null) return null;
  const meta = typeof body.link_fallback === 'object' ? body.link_fallback : {};
  const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 400) : null);
  return {
    title: text(meta.title),
    byline: text(meta.byline),
    site_name: text(meta.site_name),
    excerpt: text(meta.excerpt),
    published_at: text(meta.published_at),
    fetch_method: 'screenshot',
  };
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
    narrator?.invalidate(existing.id);
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
    if (!article?.text_content) return true;
    const verdict = await assessArticle(article);
    const patch = { tags: verdict.tags };
    if (article.quality !== 'partial' || verdict.quality === 'stub') patch.quality = verdict.quality;
    if (verdict.note) patch.quality_note = verdict.note;
    store.updateArticle(id, patch);
    // a save that tags clears a stale failure; inside a run the failure stays
    // on the report until the run is over
    if (!backfill.running) backfill.lastError = null;
    return true;
  } catch (error) {
    console.error(`enrich #${id} failed:`, error.message);
    // Kept for the settings sheet: a failing provider used to be indistinguishable
    // from one that was never configured, and the log is the last place anyone looks.
    backfill.lastError = error.message;
    return false;
  }
}

/* One backfill at a time, articles read in turn. Sequential is deliberate: the
   provider is the slow part, and a burst of thirty parallel calls is how a key
   gets rate-limited for the saves that matter more. */
const backfill = { running: false, total: 0, done: 0, failed: 0, lastError: null, finishedAt: null };

function taggingStatus() {
  return {
    enabled: isLlmConfigured,
    untagged: store.untaggedArticleIds().length,
    running: backfill.running,
    total: backfill.total,
    done: backfill.done,
    failed: backfill.failed,
    error: backfill.lastError,
    finished_at: backfill.finishedAt,
  };
}

function startTagBackfill() {
  if (backfill.running) return;
  const ids = store.untaggedArticleIds();
  Object.assign(backfill, { running: true, total: ids.length, done: 0, failed: 0, lastError: null, finishedAt: null });
  (async () => {
    for (const id of ids) {
      if (await enrichInBackground(id)) backfill.done += 1;
      else backfill.failed += 1;
    }
  })().finally(() => {
    backfill.running = false;
    backfill.finishedAt = new Date().toISOString();
  });
}
