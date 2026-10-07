import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.PARTICLE_DB || new URL('../data/particle.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

const { user_version: version } = db.prepare('PRAGMA user_version').get();
export const SCHEMA_VERSION = 4;
if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than this particle build supports`);

if (version < 1) db.exec(`
  BEGIN IMMEDIATE;

  CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    canonical_url TEXT,
    title        TEXT,
    byline       TEXT,
    site_name    TEXT,
    excerpt      TEXT,
    content_html TEXT,
    text_content TEXT,
    word_count   INTEGER DEFAULT 0,
    lead_image   TEXT,
    published_at TEXT,
    saved_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    read_at      TEXT,
    favorite     INTEGER DEFAULT 0,
    archived     INTEGER DEFAULT 0,
    tags         TEXT DEFAULT '[]',
    quality      TEXT,
    quality_note TEXT,
    fetch_method TEXT,
    progress     REAL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_articles_saved ON articles(saved_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url ON articles(url);

  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title, byline, site_name, text_content, tags,
    content='articles', content_rowid='id', tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, byline, site_name, text_content, tags)
    VALUES (new.id, new.title, new.byline, new.site_name, new.text_content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, byline, site_name, text_content, tags)
    VALUES ('delete', old.id, old.title, old.byline, old.site_name, old.text_content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, byline, site_name, text_content, tags)
    VALUES ('delete', old.id, old.title, old.byline, old.site_name, old.text_content, old.tags);
    INSERT INTO articles_fts(rowid, title, byline, site_name, text_content, tags)
    VALUES (new.id, new.title, new.byline, new.site_name, new.text_content, new.tags);
  END;

  PRAGMA user_version = 1;
  COMMIT;
`);

// v2 — narration: where a spoken rendering of an article and its audio live.
if (version < 2) db.exec(`
  BEGIN IMMEDIATE;

  ALTER TABLE articles ADD COLUMN audio_pos REAL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS narrations (
    article_id   INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    language     TEXT,
    voice_id     TEXT,
    voice_name   TEXT,
    tone         TEXT,
    reason       TEXT,
    source       TEXT,
    direction    TEXT NOT NULL DEFAULT '{}',
    script       TEXT NOT NULL DEFAULT '{}',
    format       TEXT NOT NULL DEFAULT 'mp3',
    created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    played_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS narration_segments (
    article_id INTEGER NOT NULL REFERENCES narrations(article_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    audio      BLOB NOT NULL,
    bytes      INTEGER NOT NULL,
    duration   REAL NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (article_id, seq)
  );

  PRAGMA user_version = 2;
  COMMIT;
`);

// v3 — collections (reader-made lists) and a mark for a hand-edited body.
if (version < 3) db.exec(`
  BEGIN IMMEDIATE;

  ALTER TABLE articles ADD COLUMN edited_at TEXT;

  CREATE TABLE IF NOT EXISTS collections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS article_collections (
    article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    added_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (article_id, collection_id)
  );
  CREATE INDEX IF NOT EXISTS idx_article_collections_c ON article_collections(collection_id);

  PRAGMA user_version = 3;
  COMMIT;
`);

/* v4 — narration you choose and can come back to.

   A voice is chosen once for the library (or per article) instead of cast per
   play, so the choice is stored. Narrations become immutable variants keyed by
   a revision that names their content, script and voice: choosing B never
   deletes A's audio, and coming back to A plays what is already cached. The
   bookmark names a passage, not seconds on a clock that moves.

   The old narration tables and audio_pos stay for now: each article's old
   bookmark is converted through its own script the first time it is opened,
   then the old rows go. The search index stops being rewritten on every
   bookmark save — it only follows the columns it indexes. */
if (version < 4) db.exec(`
  BEGIN IMMEDIATE;

  CREATE TABLE IF NOT EXISTS narration_settings (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    default_voice_id   TEXT,
    default_voice_name TEXT,
    version            INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO narration_settings (id) VALUES (1);

  ALTER TABLE articles ADD COLUMN narration_voice_id TEXT;
  ALTER TABLE articles ADD COLUMN narration_voice_name TEXT;
  ALTER TABLE articles ADD COLUMN narration_voice_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE articles ADD COLUMN audio_bookmark TEXT;
  ALTER TABLE articles ADD COLUMN audio_bookmark_version INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS narration_variants (
    article_id       INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    rev              TEXT NOT NULL,
    script_id        TEXT NOT NULL,
    content_revision TEXT NOT NULL,
    voice_id         TEXT,
    voice_name       TEXT,
    language         TEXT,
    config           TEXT NOT NULL DEFAULT '{}',
    script           TEXT NOT NULL,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (article_id, rev)
  );

  CREATE TABLE IF NOT EXISTS narration_audio (
    article_id   INTEGER NOT NULL,
    rev          TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    audio        BLOB NOT NULL,
    bytes        INTEGER NOT NULL,
    duration     REAL NOT NULL,
    last_used_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (article_id, rev, seq),
    FOREIGN KEY (article_id, rev) REFERENCES narration_variants(article_id, rev) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_narration_audio_used ON narration_audio(last_used_at);

  CREATE TABLE IF NOT EXISTS narration_voice_catalogue (
    language   TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS narration_auto_choices (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    script_id  TEXT NOT NULL,
    voice_id   TEXT,
    voice_name TEXT,
    PRIMARY KEY (article_id, script_id)
  );

  DROP TRIGGER IF EXISTS articles_au;
  CREATE TRIGGER articles_au AFTER UPDATE OF title, byline, site_name, text_content, tags ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, byline, site_name, text_content, tags)
    VALUES ('delete', old.id, old.title, old.byline, old.site_name, old.text_content, old.tags);
    INSERT INTO articles_fts(rowid, title, byline, site_name, text_content, tags)
    VALUES (new.id, new.title, new.byline, new.site_name, new.text_content, new.tags);
  END;

  PRAGMA user_version = 4;
  COMMIT;
`);

const LIST_COLS = `id, url, canonical_url, title, byline, site_name, excerpt, word_count,
  lead_image, published_at, saved_at, read_at, favorite, archived, tags, quality, fetch_method,
  progress, edited_at`;

/* A filter is one of the built-in views, or `collection:<id>` for a list the
   reader made. `all` and `unread` both exclude the archive; hiding read articles
   from the main tab is the client asking for `unread` instead of `all`. */
export function listArticles({ q, filter } = {}) {
  const where = [];
  const params = [];
  const collection = /^collection:(\d+)$/.exec(String(filter || ''));
  if (collection) {
    where.push('archived = 0');
    where.push('id IN (SELECT article_id FROM article_collections WHERE collection_id = ?)');
    params.push(Number(collection[1]));
  } else if (filter === 'unread') where.push('read_at IS NULL AND archived = 0');
  else if (filter === 'read') where.push('read_at IS NOT NULL AND archived = 0');
  else if (filter === 'favorites') where.push('favorite = 1');
  else if (filter === 'archived') where.push('archived = 1');
  else where.push('archived = 0');

  if (q && q.trim()) {
    // escape FTS special syntax; quote each term
    const terms = q.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
    where.push('id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)');
    params.push(terms);
  }
  const sql = `SELECT ${LIST_COLS} FROM articles WHERE ${where.join(' AND ')} ORDER BY saved_at DESC LIMIT 500`;
  return withCollections(db.prepare(sql).all(...params).map(hydrate));
}

export function getArticle(id) {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  return row ? withCollections([hydrate(row)])[0] : null;
}

export function getByUrl(url) {
  const row = db.prepare(`SELECT ${LIST_COLS} FROM articles WHERE url = ?`).get(url);
  return row ? withCollections([hydrate(row)])[0] : null;
}

export function insertArticle(a) {
  const stmt = db.prepare(`
    INSERT INTO articles (url, canonical_url, title, byline, site_name, excerpt, content_html,
      text_content, word_count, lead_image, published_at, quality, fetch_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(a.url, a.canonical_url, a.title, a.byline, a.site_name, a.excerpt,
    a.content_html, a.text_content, a.word_count, a.lead_image, a.published_at,
    a.quality ?? null, a.fetch_method);
  return getArticle(Number(r.lastInsertRowid));
}

export function replaceArticleContent(id, a) {
  db.prepare(`
    UPDATE articles SET canonical_url=?, title=?, byline=?, site_name=?, excerpt=?, content_html=?,
      text_content=?, word_count=?, lead_image=?, published_at=?, quality=?, quality_note=?,
      fetch_method=?, edited_at=NULL
    WHERE id=?
  `).run(a.canonical_url, a.title, a.byline, a.site_name, a.excerpt, a.content_html,
    a.text_content, a.word_count, a.lead_image, a.published_at, a.quality ?? null,
    a.quality_note ?? null, a.fetch_method, id);
  return getArticle(id);
}

export function updateArticle(id, fields) {
  const allowed = ['favorite', 'archived', 'progress', 'read_at', 'tags', 'quality', 'quality_note',
    'title', 'audio_pos', 'content_html', 'text_content', 'word_count', 'excerpt', 'edited_at'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      params.push(k === 'tags' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getArticle(id);
  params.push(id);
  db.prepare(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getArticle(id);
}

export function deleteArticle(id) {
  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
}

/* Articles the tagging pass has not reached: saved before a key was set, or
   saved while the provider was down. A link stub has no text to read, so it is
   not untagged so much as untaggable, and stays out. */
export function untaggedArticleIds() {
  return db.prepare(`SELECT id FROM articles
    WHERE (tags IS NULL OR tags IN ('', '[]')) AND text_content IS NOT NULL AND text_content != ''
    ORDER BY saved_at DESC`).all().map(row => row.id);
}

/* The settings reset. Narrations and list membership cascade off the articles;
   the collections themselves are the reader's own structure, so they survive
   unless the caller asks for them too. */
export function deleteAllArticles({ includeCollections = false } = {}) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
  db.exec('DELETE FROM articles');
  if (includeCollections) db.exec('DELETE FROM collections');
  return { deleted: n };
}

// ── collections ──────────────────────────────────────────────────────────────
// Lists the reader makes by hand. They sit beside the built-in tabs rather than
// replacing them, and an article can be in any number of them.

export function listCollections() {
  return db.prepare(`
    SELECT c.id, c.name, c.position,
           (SELECT COUNT(*) FROM article_collections ac
              JOIN articles a ON a.id = ac.article_id
             WHERE ac.collection_id = c.id AND a.archived = 0) AS count
    FROM collections c ORDER BY c.position ASC, c.id ASC
  `).all();
}

export function getCollection(id) {
  return db.prepare('SELECT id, name, position FROM collections WHERE id = ?').get(id) || null;
}

export function createCollection(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('a list needs a name');
  const existing = db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE').get(clean);
  if (existing) throw new Error('you already have a list with that name');
  const { next } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM collections').get();
  const r = db.prepare('INSERT INTO collections (name, position) VALUES (?, ?)').run(clean, next);
  return getCollection(Number(r.lastInsertRowid));
}

export function renameCollection(id, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('a list needs a name');
  const clash = db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE AND id != ?').get(clean, id);
  if (clash) throw new Error('you already have a list with that name');
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(clean, id);
  return getCollection(id);
}

export function deleteCollection(id) {
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

export function setArticleCollection(articleId, collectionId, member) {
  if (member) {
    db.prepare('INSERT OR IGNORE INTO article_collections (article_id, collection_id) VALUES (?, ?)')
      .run(articleId, collectionId);
  } else {
    db.prepare('DELETE FROM article_collections WHERE article_id = ? AND collection_id = ?')
      .run(articleId, collectionId);
  }
  return getArticle(articleId);
}

/** Attach each article's list membership in one query rather than one per row. */
function withCollections(rows) {
  if (!rows.length) return rows;
  const holes = rows.map(() => '?').join(',');
  const links = db.prepare(
    `SELECT article_id, collection_id FROM article_collections WHERE article_id IN (${holes})`
  ).all(...rows.map(r => r.id));
  const byArticle = new Map();
  for (const link of links) {
    if (!byArticle.has(link.article_id)) byArticle.set(link.article_id, []);
    byArticle.get(link.article_id).push(link.collection_id);
  }
  for (const row of rows) row.collections = byArticle.get(row.id) || [];
  return rows;
}

function hydrate(row) {
  return {
    ...row,
    tags: safeJson(row.tags, []),
    favorite: !!row.favorite,
    archived: !!row.archived,
    collections: [],
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── narration ────────────────────────────────────────────────────────────────
// A narration variant is one spoken rendering of one version of an article in
// one voice: an immutable script plus the audio of each passage as it is
// synthesised. Variants are never rewritten, only added and, past a small
// number per article, forgotten; the audio is the expensive part and is evicted
// passage by passage under a byte ceiling.

const now = () => new Date().toISOString();

function transaction(run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ── settings and the reader's choices ──

export function getNarrationSettings() {
  const row = db.prepare('SELECT default_voice_id, default_voice_name, version FROM narration_settings WHERE id = 1').get();
  return row || { default_voice_id: null, default_voice_name: null, version: 0 };
}

/** Compare-and-set: a stale version changes nothing and says so. */
export function updateNarrationSettings({ default_voice_id, default_voice_name, expected_version }) {
  const result = db.prepare(`UPDATE narration_settings
    SET default_voice_id = ?, default_voice_name = ?, version = version + 1
    WHERE id = 1 AND version = ?`).run(default_voice_id ?? null, default_voice_name ?? null, expected_version);
  return { ok: result.changes === 1, settings: getNarrationSettings() };
}

export function getVoiceOverride(articleId) {
  const row = db.prepare(`SELECT narration_voice_id AS id, narration_voice_name AS name,
    narration_voice_version AS version FROM articles WHERE id = ?`).get(articleId);
  return row ? { voice: row.id ? { id: row.id, name: row.name } : null, version: row.version } : null;
}

/** null clears the override; the article goes back to the library default. */
export function setVoiceOverride(articleId, voice, expectedVersion) {
  const result = db.prepare(`UPDATE articles
    SET narration_voice_id = ?, narration_voice_name = ?, narration_voice_version = narration_voice_version + 1
    WHERE id = ? AND narration_voice_version = ?`).run(voice?.id ?? null, voice?.id ? voice.name ?? null : null,
    articleId, expectedVersion);
  return { ok: result.changes === 1, ...getVoiceOverride(articleId) };
}

// ── bookmarks ──

export function getBookmark(articleId) {
  const row = db.prepare('SELECT audio_bookmark, audio_bookmark_version FROM articles WHERE id = ?').get(articleId);
  if (!row) return null;
  return { bookmark: safeJson(row.audio_bookmark, null), version: row.audio_bookmark_version };
}

export function updateBookmark(articleId, bookmark, expectedVersion) {
  const result = db.prepare(`UPDATE articles
    SET audio_bookmark = ?, audio_bookmark_version = audio_bookmark_version + 1
    WHERE id = ? AND audio_bookmark_version = ?`).run(bookmark ? JSON.stringify(bookmark) : null, articleId, expectedVersion);
  return { ok: result.changes === 1, ...getBookmark(articleId) };
}

// ── variants ──

function hydrateVariant(row) {
  if (!row) return null;
  return { ...row, config: safeJson(row.config, {}), script: safeJson(row.script, { segments: [], blocks: [] }) };
}

export function getVariant(articleId, rev) {
  return hydrateVariant(db.prepare('SELECT * FROM narration_variants WHERE article_id = ? AND rev = ?').get(articleId, rev));
}

/** Any variant of one script — every voice of it shares the same blocks. */
export function getVariantByScript(articleId, scriptId) {
  return hydrateVariant(db.prepare(`SELECT * FROM narration_variants WHERE article_id = ? AND script_id = ?
    ORDER BY last_used_at DESC LIMIT 1`).get(articleId, scriptId));
}

export function listVariants(articleId) {
  return db.prepare(`SELECT rev, script_id, content_revision, voice_id, voice_name, created_at, last_used_at
    FROM narration_variants WHERE article_id = ? ORDER BY last_used_at DESC`).all(articleId);
}

/**
 * File a variant, or find the identical one already filed. The article is read
 * again inside the same transaction: a variant for text that was edited or
 * deleted while it was being prepared is refused rather than saved.
 */
export function saveVariant(articleId, variant, { contentRevisionOf }) {
  return transaction(() => {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
    if (!article) throw Object.assign(new Error('that article is gone'), { statusCode: 404, code: 'not_found' });
    if (contentRevisionOf(hydrate(article)) !== variant.content_revision) {
      throw Object.assign(new Error('the article changed while its narration was being prepared'),
        { statusCode: 409, code: 'content_changed' });
    }
    db.prepare(`INSERT OR IGNORE INTO narration_variants
      (article_id, rev, script_id, content_revision, voice_id, voice_name, language, config, script)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(articleId, variant.rev, variant.script_id, variant.content_revision,
      variant.voice_id ?? null, variant.voice_name ?? null, variant.language ?? null,
      JSON.stringify(variant.config || {}), JSON.stringify(variant.script));
    db.prepare('UPDATE narration_variants SET last_used_at = ? WHERE article_id = ? AND rev = ?').run(now(), articleId, variant.rev);
    return getVariant(articleId, variant.rev);
  });
}

export function touchVariant(articleId, rev) {
  db.prepare('UPDATE narration_variants SET last_used_at = ? WHERE article_id = ? AND rev = ?').run(now(), articleId, rev);
}

/* Past `keep` variants an article forgets the least recently used, audio and
   all. Variants still being listened to, and the one the bookmark was made on
   (it is how a changed article maps the bookmark forward), are kept. */
export function pruneVariants(articleId, { keep = 3, protect = [] } = {}) {
  const keepRevs = new Set(protect.filter(Boolean));
  const bookmark = getBookmark(articleId)?.bookmark;
  const variants = listVariants(articleId);
  if (bookmark?.rev) keepRevs.add(bookmark.rev);
  if (bookmark?.script_id && !variants.some(v => keepRevs.has(v.rev) && v.script_id === bookmark.script_id)) {
    const forScript = variants.find(v => v.script_id === bookmark.script_id);
    if (forScript) keepRevs.add(forScript.rev);
  }
  let kept = 0;
  const gone = [];
  for (const variant of variants) {
    if (keepRevs.has(variant.rev) || kept < keep) { kept += 1; continue; }
    gone.push(variant.rev);
  }
  if (!gone.length) return [];
  transaction(() => {
    for (const rev of gone) db.prepare('DELETE FROM narration_variants WHERE article_id = ? AND rev = ?').run(articleId, rev);
    // an automatic choice belongs to a script; once no variant of it is left, neither is the choice
    db.prepare(`DELETE FROM narration_auto_choices WHERE article_id = ?
      AND script_id NOT IN (SELECT script_id FROM narration_variants WHERE article_id = ?)`).run(articleId, articleId);
  });
  return gone;
}

// ── audio ──

export function getAudio(articleId, rev, seq) {
  const row = db.prepare('SELECT audio, bytes, duration FROM narration_audio WHERE article_id = ? AND rev = ? AND seq = ?')
    .get(articleId, rev, seq);
  if (!row) return null;
  db.prepare('UPDATE narration_audio SET last_used_at = ? WHERE article_id = ? AND rev = ? AND seq = ?')
    .run(now(), articleId, rev, seq);
  return row;
}

export function hasAudio(articleId, rev, seq) {
  return Boolean(db.prepare('SELECT 1 FROM narration_audio WHERE article_id = ? AND rev = ? AND seq = ?').get(articleId, rev, seq));
}

/** Which passages of a variant are synthesised, and how long each runs. */
export function audioIndex(articleId, rev) {
  return db.prepare('SELECT seq, bytes, duration FROM narration_audio WHERE article_id = ? AND rev = ? ORDER BY seq')
    .all(articleId, rev);
}

export function narrationCacheBytes() {
  const current = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM narration_audio').get().total;
  const legacy = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM narration_segments').get().total;
  return current + legacy;
}

/**
 * Store one passage under the byte ceiling. Room is made by evicting the least
 * recently used passages — old-format audio included — except those `protect`
 * names (what someone is about to hear). If it still cannot fit, nothing is
 * stored and the caller serves the bytes it has: the ceiling holds.
 */
export function saveAudio(articleId, rev, seq, audio, duration, { maxBytes = Infinity, protect = new Set() } = {}) {
  return transaction(() => {
    if (!db.prepare('SELECT 1 FROM narration_variants WHERE article_id = ? AND rev = ?').get(articleId, rev)) {
      return { stored: false, reason: 'variant_gone' };
    }
    const existing = db.prepare('SELECT bytes FROM narration_audio WHERE article_id = ? AND rev = ? AND seq = ?')
      .get(articleId, rev, seq);
    let total = narrationCacheBytes() - (existing?.bytes || 0);
    if (audio.length > maxBytes) return { stored: false, reason: 'too_large' };
    if (total + audio.length > maxBytes) {
      const candidates = db.prepare(`
        SELECT 'audio' AS kind, article_id, rev, seq, bytes, last_used_at AS used FROM narration_audio
        UNION ALL
        SELECT 'legacy' AS kind, s.article_id, NULL AS rev, s.seq, s.bytes,
               COALESCE(n.played_at, n.created_at, s.created_at, '') AS used
        FROM narration_segments s LEFT JOIN narrations n ON n.article_id = s.article_id
        ORDER BY used ASC`).all();
      const victims = [];
      let freeable = 0;
      for (const row of candidates) {
        if (total - freeable + audio.length <= maxBytes) break;
        if (row.kind === 'audio' && (protect.has(`${row.article_id}:${row.rev}:${row.seq}`)
          || (row.article_id === articleId && row.rev === rev && row.seq === seq))) continue;
        victims.push(row);
        freeable += row.bytes;
      }
      if (total - freeable + audio.length > maxBytes) return { stored: false, reason: 'cache_full' };
      for (const row of victims) {
        if (row.kind === 'audio') {
          db.prepare('DELETE FROM narration_audio WHERE article_id = ? AND rev = ? AND seq = ?').run(row.article_id, row.rev, row.seq);
        } else {
          db.prepare('DELETE FROM narration_segments WHERE article_id = ? AND seq = ?').run(row.article_id, row.seq);
        }
      }
      total -= freeable;
    }
    db.prepare(`INSERT INTO narration_audio (article_id, rev, seq, audio, bytes, duration, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(article_id, rev, seq) DO UPDATE SET audio = excluded.audio, bytes = excluded.bytes,
        duration = excluded.duration, last_used_at = excluded.last_used_at`)
      .run(articleId, rev, seq, audio, audio.length, duration, now());
    return { stored: true, total: total + audio.length };
  });
}

// ── automatic choices ──

/* An automatic voice is chosen once per script and then kept, so the same
   article does not change narrator between plays. A row with no voice id is a
   real choice — the provider's default — and is different from no row. */
export function getAutoChoice(articleId, scriptId) {
  const row = db.prepare('SELECT voice_id, voice_name FROM narration_auto_choices WHERE article_id = ? AND script_id = ?')
    .get(articleId, scriptId);
  return row ? { voice_id: row.voice_id, voice_name: row.voice_name } : null;
}

/** The first choice for a script wins; a racing second one gets the first back. */
export function saveAutoChoice(articleId, scriptId, voice) {
  db.prepare('INSERT OR IGNORE INTO narration_auto_choices (article_id, script_id, voice_id, voice_name) VALUES (?, ?, ?, ?)')
    .run(articleId, scriptId, voice?.voice_id ?? null, voice?.voice_name ?? null);
  return getAutoChoice(articleId, scriptId);
}

/* The voices this library has heard lately, so automatic choices spread across
   the catalogue rather than settling on one narrator. */
export function recentNarrationVoices(limit = 6) {
  return db.prepare(`SELECT voice_id FROM narration_variants WHERE voice_id IS NOT NULL
    GROUP BY voice_id ORDER BY MAX(last_used_at) DESC LIMIT ?`).all(limit).map(row => row.voice_id);
}

// ── the voice catalogue ──

export function loadCatalogue(language) {
  const row = db.prepare('SELECT fetched_at, payload FROM narration_voice_catalogue WHERE language = ?').get(language);
  return row ? { fetched_at: row.fetched_at, voices: safeJson(row.payload, []) } : null;
}

export function saveCatalogue(language, voices, fetchedAt = now()) {
  db.prepare(`INSERT INTO narration_voice_catalogue (language, fetched_at, payload) VALUES (?, ?, ?)
    ON CONFLICT(language) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`)
    .run(language, fetchedAt, JSON.stringify(voices));
}

// ── clearing ──

/* Everything spoken for one article goes; the bookmark goes with it because it
   names passages that no longer exist. The reader's voice choice stays. */
export function deleteNarrationData(articleId) {
  transaction(() => {
    db.prepare('DELETE FROM narration_variants WHERE article_id = ?').run(articleId);
    db.prepare('DELETE FROM narration_auto_choices WHERE article_id = ?').run(articleId);
    db.prepare('DELETE FROM narration_segments WHERE article_id = ?').run(articleId);
    db.prepare('DELETE FROM narrations WHERE article_id = ?').run(articleId);
    db.prepare(`UPDATE articles SET audio_bookmark = NULL, audio_bookmark_version = audio_bookmark_version + 1,
      audio_pos = 0 WHERE id = ?`).run(articleId);
  });
}

// ── the old format ──
// Kept only until each article's old bookmark has been converted.

export function getLegacyNarration(articleId) {
  const row = db.prepare('SELECT * FROM narrations WHERE article_id = ?').get(articleId);
  if (!row) return null;
  return { ...row, direction: safeJson(row.direction, {}), script: safeJson(row.script, { segments: [] }) };
}

export function legacyDurations(articleId) {
  const rows = db.prepare('SELECT seq, duration FROM narration_segments WHERE article_id = ?').all(articleId);
  return new Map(rows.map(row => [row.seq, row.duration]));
}

/* One step: the converted bookmark (if any) is saved and the old narration and
   its audio are gone together, so the conversion never runs twice. A bookmark
   saved meanwhile by a newer client is left alone. */
export function finishLegacyConversion(articleId, bookmark) {
  transaction(() => {
    if (bookmark) {
      db.prepare(`UPDATE articles SET audio_bookmark = ?, audio_bookmark_version = audio_bookmark_version + 1
        WHERE id = ? AND audio_bookmark IS NULL`).run(JSON.stringify(bookmark), articleId);
    }
    db.prepare('DELETE FROM narration_segments WHERE article_id = ?').run(articleId);
    db.prepare('DELETE FROM narrations WHERE article_id = ?').run(articleId);
    db.prepare('UPDATE articles SET audio_pos = 0 WHERE id = ?').run(articleId);
  });
}

export function hasLegacyNarration(articleId) {
  const row = db.prepare('SELECT audio_pos FROM articles WHERE id = ?').get(articleId);
  if (!row) return false;
  return row.audio_pos > 0 || Boolean(db.prepare('SELECT 1 FROM narrations WHERE article_id = ?').get(articleId));
}
