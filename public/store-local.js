/* particle demo store — the server extracts; this browser owns the library */
(() => {
  const STORAGE_KEY = 'particle.demo.library.v1';
  const LISTS_KEY = 'particle.demo.collections.v1';

  window.createParticleLocalStore = function createParticleLocalStore({ fetchJson, maxArticles = 15 }) {
    let library = readLibrary();
    let collections = readCollections();
    let nextId = library.reduce((max, article) => Math.max(max, Number(article.id) || 0), 0) + 1;
    let nextListId = collections.reduce((max, list) => Math.max(max, Number(list.id) || 0), 0) + 1;
    const firstVisit = localStorage.getItem(STORAGE_KEY) === null;

    const ready = (async () => {
      if (!firstVisit) return;
      try {
        const seed = await fetchJson('/api/demo-seed');
        const now = Date.now();
        library = seed.slice(0, maxArticles).map((article, index) => hydrate(article, {
          id: nextId++,
          saved_at: new Date(now - index * 60_000).toISOString(),
        }));
      } catch {
        library = [];
      }
      persist();
    })();

    return {
      async list(q, filter) {
        await ready;
        const query = String(q || '').trim().toLowerCase();
        const inList = /^collection:(\d+)$/.exec(String(filter || ''));
        return library
          .filter(article => inList ? !article.archived && article.collections.includes(Number(inList[1]))
            : filter === 'unread' ? !article.read_at && !article.archived
              : filter === 'read' ? Boolean(article.read_at) && !article.archived
                : filter === 'favorites' ? article.favorite
                  : filter === 'archived' ? article.archived
                    : !article.archived)
          .filter(article => !query || [article.title, article.site_name, article.byline, article.text_content]
            .some(value => String(value || '').toLowerCase().includes(query)))
          .sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
      },

      async get(id) {
        await ready;
        const article = find(id);
        if (!article) throw new Error('not found');
        return article;
      },

      async save(url, source) {
        await ready;
        const extracted = await fetchJson('/api/extract', { method: 'POST', body: { url, ...sourceBody(source) } });
        const duplicate = library.find(article => article.url === extracted.url);
        if (duplicate) return { ...duplicate, duplicate: true };

        let evictedTitle = '';
        if (library.length >= maxArticles) {
          const candidate = [...library]
            .filter(article => !article.favorite)
            .sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)))[0];
          if (!candidate) {
            throw new Error(`demo limit reached (${maxArticles}); unfavourite or delete an article to save another`);
          }
          evictedTitle = candidate.title || candidate.url;
          library = library.filter(article => article.id !== candidate.id);
        }

        const article = hydrate(extracted, { id: nextId++, saved_at: new Date().toISOString() });
        library.unshift(article);
        persist();
        return evictedTitle ? { ...article, evicted_title: evictedTitle } : article;
      },

      // An article the server already extracted (the captcha handoff delivered it
      // to the server, not to this tab) still has to be filed in this library.
      async adopt(extracted) {
        await ready;
        const existing = library.find(item => item.url === extracted.url);
        const article = hydrate(extracted, {
          id: existing ? existing.id : nextId++,
          saved_at: existing?.saved_at || new Date().toISOString(),
          favorite: Boolean(existing?.favorite),
          archived: Boolean(existing?.archived),
          progress: Number(existing?.progress) || 0,
          read_at: existing?.read_at || null,
          collections: existing?.collections || [],
        });
        if (existing) library[library.indexOf(existing)] = article;
        else library.unshift(article);
        persist();
        return article;
      },

      async patch(id, body) {
        await ready;
        const article = find(id);
        if (!article) throw new Error('not found');
        if ('favorite' in body) article.favorite = Boolean(body.favorite);
        if ('archived' in body) article.archived = Boolean(body.archived);
        if ('progress' in body) article.progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
        if ('read' in body) article.read_at = body.read ? new Date().toISOString() : null;
        if (Array.isArray(body.tags)) article.tags = body.tags;
        // A hand-trimmed body. The markup came out of the article this browser
        // already holds, so the text and word count are recomputed from it.
        if (typeof body.content_html === 'string') {
          const text = htmlToText(body.content_html);
          if (!text) throw new Error('that edit would leave the article empty');
          article.content_html = body.content_html;
          article.text_content = text;
          article.word_count = text.split(/\s+/).length;
          article.excerpt = text.slice(0, 300);
          article.edited_at = new Date().toISOString();
        }
        persist();
        return article;
      },

      async refetch(id, source) {
        await ready;
        const current = find(id);
        if (!current) throw new Error('not found');
        const extracted = await fetchJson('/api/extract', {
          method: 'POST',
          body: { url: current.url, ...sourceBody(source) },
        });
        const updated = hydrate(extracted, {
          id: current.id,
          saved_at: current.saved_at,
          read_at: current.read_at,
          favorite: current.favorite,
          archived: current.archived,
          progress: current.progress,
          tags: current.tags,
          collections: current.collections,
          edited_at: null,
        });
        library[library.indexOf(current)] = updated;
        persist();
        return updated;
      },

      async remove(id) {
        await ready;
        library = library.filter(article => Number(article.id) !== Number(id));
        persist();
        return { ok: true };
      },

      async removeAll({ includeLists = false } = {}) {
        await ready;
        const deleted = library.length;
        library = [];
        if (includeLists) { collections = []; persistLists(); }
        persist();
        return { deleted };
      },

      // ── collections ──────────────────────────────────────────────────────
      async listCollections() {
        await ready;
        return collections
          .map(list => ({
            ...list,
            count: library.filter(a => !a.archived && a.collections.includes(list.id)).length,
          }))
          .sort((a, b) => a.position - b.position || a.id - b.id);
      },

      async createCollection(name) {
        await ready;
        const clean = String(name || '').trim().slice(0, 40);
        if (!clean) throw new Error('a list needs a name');
        if (collections.some(list => list.name.toLowerCase() === clean.toLowerCase())) {
          throw new Error('you already have a list with that name');
        }
        const list = { id: nextListId++, name: clean, position: collections.length + 1 };
        collections.push(list);
        persistLists();
        return list;
      },

      async renameCollection(id, name) {
        await ready;
        const clean = String(name || '').trim().slice(0, 40);
        if (!clean) throw new Error('a list needs a name');
        const list = collections.find(item => item.id === Number(id));
        if (!list) throw new Error('no such list');
        if (collections.some(item => item.id !== list.id && item.name.toLowerCase() === clean.toLowerCase())) {
          throw new Error('you already have a list with that name');
        }
        list.name = clean;
        persistLists();
        return list;
      },

      async deleteCollection(id) {
        await ready;
        collections = collections.filter(list => list.id !== Number(id));
        for (const article of library) {
          article.collections = article.collections.filter(listId => listId !== Number(id));
        }
        persistLists();
        persist();
        return { ok: true };
      },

      async setArticleCollection(articleId, collectionId, member) {
        await ready;
        const article = find(articleId);
        if (!article) throw new Error('not found');
        const listId = Number(collectionId);
        article.collections = article.collections.filter(id => id !== listId);
        if (member) article.collections.push(listId);
        persist();
        return article;
      },
    };

    function persistLists() {
      try { localStorage.setItem(LISTS_KEY, JSON.stringify(collections)); } catch { /* full: lists are small */ }
    }

    function readCollections() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LISTS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(list => list && list.id && list.name) : [];
      } catch {
        return [];
      }
    }

    function find(id) {
      return library.find(article => Number(article.id) === Number(id));
    }

    function persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
      } catch (error) {
        if (error?.name !== 'QuotaExceededError') throw error;
        const oldest = [...library].sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)));
        for (const article of oldest) {
          if (!article.content_html) continue;
          article.content_html = '';
          article.text_content = '';
          article.storage_trimmed = true;
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
            return;
          } catch (retryError) {
            if (retryError?.name !== 'QuotaExceededError') throw retryError;
          }
        }
        throw new Error('browser storage is full; delete an article and try again');
      }
    }
  };

  // Page source the browser fetched itself — the archive.today captcha rescue.
  function sourceBody(source) {
    return {
      ...(source?.html ? { html: source.html, source_url: source.sourceUrl || null } : {}),
      // What a screenshot said about an article whose page may not open at all.
      ...(source?.linkFallback ? { link_fallback: source.linkFallback } : {}),
    };
  }

  // A block boundary is a word boundary; textContent alone would run the last
  // word of one paragraph into the first of the next.
  const TEXT_BREAKS = 'p, h1, h2, h3, h4, h5, h6, blockquote, figure, figcaption, li, pre, hr, br,'
    + ' tr, td, th, caption, div, section, dt, dd';

  function htmlToText(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    for (const node of holder.querySelectorAll(TEXT_BREAKS)) node.after(document.createTextNode(' '));
    return (holder.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function readLibrary() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(article => hydrate(article)) : [];
    } catch {
      return [];
    }
  }

  function hydrate(article, overrides = {}) {
    return {
      ...article,
      id: Number(article.id) || 0,
      saved_at: article.saved_at || new Date().toISOString(),
      read_at: article.read_at || null,
      favorite: Boolean(article.favorite),
      archived: Boolean(article.archived),
      progress: Number(article.progress) || 0,
      tags: Array.isArray(article.tags) ? article.tags : [],
      collections: Array.isArray(article.collections) ? article.collections.map(Number) : [],
      edited_at: article.edited_at || null,
      ...overrides,
    };
  }
})();
