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
if (version > 1) throw new Error(`Database schema ${version} is newer than this particle build supports`);

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

const LIST_COLS = `id, url, canonical_url, title, byline, site_name, excerpt, word_count,
  lead_image, published_at, saved_at, read_at, favorite, archived, tags, quality, fetch_method, progress`;

export function listArticles({ q, filter } = {}) {
  const where = [];
  const params = [];
  if (filter === 'unread') where.push('read_at IS NULL AND archived = 0');
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
  return db.prepare(sql).all(...params).map(hydrate);
}

export function getArticle(id) {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function getByUrl(url) {
  const row = db.prepare(`SELECT ${LIST_COLS} FROM articles WHERE url = ?`).get(url);
  return row ? hydrate(row) : null;
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
      text_content=?, word_count=?, lead_image=?, published_at=?, quality=?, quality_note=NULL, fetch_method=?
    WHERE id=?
  `).run(a.canonical_url, a.title, a.byline, a.site_name, a.excerpt, a.content_html,
    a.text_content, a.word_count, a.lead_image, a.published_at, a.quality ?? null, a.fetch_method, id);
  return getArticle(id);
}

export function updateArticle(id, fields) {
  const allowed = ['favorite', 'archived', 'progress', 'read_at', 'tags', 'quality', 'quality_note', 'title'];
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

function hydrate(row) {
  return {
    ...row,
    tags: safeJson(row.tags, []),
    favorite: !!row.favorite,
    archived: !!row.archived,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
