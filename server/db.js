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
if (version > 3) throw new Error(`Database schema ${version} is newer than this particle build supports`);

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
      text_content=?, word_count=?, lead_image=?, published_at=?, quality=?, quality_note=NULL,
      fetch_method=?, edited_at=NULL
    WHERE id=?
  `).run(a.canonical_url, a.title, a.byline, a.site_name, a.excerpt, a.content_html,
    a.text_content, a.word_count, a.lead_image, a.published_at, a.quality ?? null, a.fetch_method, id);
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
// A narration is one spoken rendering of one version of an article: the script,
// the casting decisions behind it, and the audio for each segment as it is
// synthesised. Rebuilding is cheap for the script and expensive for the audio,
// so the audio is what the cache is really for.

export function getNarration(articleId) {
  const row = db.prepare('SELECT * FROM narrations WHERE article_id = ?').get(articleId);
  if (!row) return null;
  return { ...row, direction: safeJson(row.direction, {}), script: safeJson(row.script, { segments: [] }) };
}

export function saveNarration(articleId, narration) {
  db.prepare(`
    INSERT INTO narrations (article_id, content_hash, language, voice_id, voice_name, tone, reason,
      source, direction, script, format, created_at, played_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
    ON CONFLICT(article_id) DO UPDATE SET
      content_hash=excluded.content_hash, language=excluded.language, voice_id=excluded.voice_id,
      voice_name=excluded.voice_name, tone=excluded.tone, reason=excluded.reason, source=excluded.source,
      direction=excluded.direction, script=excluded.script, format=excluded.format,
      created_at=excluded.created_at, played_at=NULL
  `).run(articleId, narration.content_hash, narration.language, narration.voice_id, narration.voice_name,
    narration.tone, narration.reason, narration.source,
    JSON.stringify(narration.direction || {}), JSON.stringify(narration.script || {}), narration.format || 'mp3');
  return getNarration(articleId);
}

export function deleteNarration(articleId) {
  db.prepare('DELETE FROM narration_segments WHERE article_id = ?').run(articleId);
  db.prepare('DELETE FROM narrations WHERE article_id = ?').run(articleId);
}

export function getNarrationSegment(articleId, seq) {
  return db.prepare('SELECT seq, audio, bytes, duration FROM narration_segments WHERE article_id = ? AND seq = ?')
    .get(articleId, seq) || null;
}

export function hasNarrationSegment(articleId, seq) {
  return Boolean(db.prepare('SELECT 1 FROM narration_segments WHERE article_id = ? AND seq = ?').get(articleId, seq));
}

export function saveNarrationSegment(articleId, seq, audio, duration) {
  db.prepare(`
    INSERT INTO narration_segments (article_id, seq, audio, bytes, duration) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(article_id, seq) DO UPDATE SET
      audio=excluded.audio, bytes=excluded.bytes, duration=excluded.duration,
      created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(articleId, seq, audio, audio.length, duration);
}

/** Which segments are already synthesised, and how long each one runs. */
export function narrationSegmentIndex(articleId) {
  return db.prepare('SELECT seq, bytes, duration FROM narration_segments WHERE article_id = ? ORDER BY seq')
    .all(articleId);
}

export function touchNarration(articleId) {
  db.prepare("UPDATE narrations SET played_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE article_id = ?")
    .run(articleId);
}

/* Audio is by far the largest thing particle stores. Keep the cache under the
   configured ceiling by dropping the least recently listened-to narrations —
   the script survives, so they re-synthesise on the next play. */
export function pruneNarrationAudio(maxBytes, keepArticleId) {
  const { total } = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM narration_segments').get();
  if (total <= maxBytes) return { total, freed: 0 };

  const candidates = db.prepare(`
    SELECT s.article_id AS article_id, SUM(s.bytes) AS bytes,
           COALESCE(n.played_at, n.created_at, '') AS used_at
    FROM narration_segments s LEFT JOIN narrations n ON n.article_id = s.article_id
    GROUP BY s.article_id ORDER BY used_at ASC
  `).all();

  let freed = 0;
  for (const row of candidates) {
    if (total - freed <= maxBytes) break;
    if (row.article_id === keepArticleId) continue;
    db.prepare('DELETE FROM narration_segments WHERE article_id = ?').run(row.article_id);
    freed += row.bytes;
  }
  return { total: total - freed, freed };
}

export function narrationCacheBytes() {
  return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM narration_segments').get().total;
}
