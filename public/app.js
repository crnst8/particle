/* particle — library + reader */
import { createNarrationPlayer, silentWavUrl } from './narration-player.js';
import { createBookmarkSync, resolveStart, segmentForBlock, SKIP_SECONDS } from './narration-model.js';
import { createAudioStore } from './narration-cache.js';

(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = document.documentElement.dataset.base || '';
  const DEMO = document.documentElement.dataset.demo === '1';
  const DEMO_MAX = Number(document.documentElement.dataset.demoMax) || 15;
  const library = $('library'), reader = $('reader');
  const list = $('list'), empty = $('empty');
  const form = $('save-form'), urlInput = $('url-input'), saveBtn = $('save-btn'), saveStatus = $('save-status');
  const tabs = $('tabs'), search = $('search');
  const scroller = $('reader-scroll'), progressBar = $('progress-bar');

  const state = {
    filter: localStorage.getItem('p.filter') || 'all',
    q: '',
    articles: [],
    collections: [],     // lists the reader made, shown as extra tabs
    current: null,       // article open in reader
    progressTimer: null,
    narration: false,    // server has a text-to-speech key configured
    justSaved: null,     // id of the article whose row still owes an entrance
  };

  // ── prefs ────────────────────────────────────────────────────────────────
  // Everything here is a display choice, so it lives in this browser rather
  // than the library — a phone and a laptop can read the same library
  // differently. Lists and article edits are library state and go to the server.
  const THEMES = ['system', 'light', 'sepia', 'dark'];
  const ACCENTS = [
    { id: 'ember', value: '', swatch: '#d64b2f', label: 'ember (default)' },
    { id: 'crimson', value: '#a8323f', swatch: '#a8323f', label: 'crimson' },
    { id: 'ochre', value: '#b07d2b', swatch: '#b07d2b', label: 'ochre' },
    { id: 'moss', value: '#3f7a5e', swatch: '#3f7a5e', label: 'moss' },
    { id: 'slate', value: '#3a5c99', swatch: '#3a5c99', label: 'slate' },
    { id: 'plum', value: '#7b4f96', swatch: '#7b4f96', label: 'plum' },
  ];
  const SIZE_MIN = 0.85, SIZE_MAX = 1.6, SIZE_STEP = 0.0625;

  const prefs = {
    get theme() {
      const saved = localStorage.getItem('p.theme');
      return THEMES.includes(saved) ? saved : 'light';
    },
    set theme(v) { localStorage.setItem('p.theme', THEMES.includes(v) ? v : 'light'); applyPrefs(); },
    get size() { return clampSize(parseFloat(localStorage.getItem('p.size') || '1.125')); },
    set size(v) { localStorage.setItem('p.size', clampSize(v)); applyPrefs(); },
    get face() { return localStorage.getItem('p.face') === 'sans' ? 'sans' : 'serif'; },
    set face(v) { localStorage.setItem('p.face', v === 'sans' ? 'sans' : 'serif'); applyPrefs(); },
    get accent() {
      const saved = localStorage.getItem('p.accent') || 'ember';
      return ACCENTS.some(a => a.id === saved) ? saved : 'ember';
    },
    set accent(v) { localStorage.setItem('p.accent', v); applyPrefs(); },
    // read articles in the main tab, or only under their own tab
    get readsInAll() { return localStorage.getItem('p.readsInAll') !== '0'; },
    set readsInAll(v) { localStorage.setItem('p.readsInAll', v ? '1' : '0'); },
  };

  const clampSize = v => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number.isFinite(v) ? v : 1.125));
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  /** The theme actually painted: `system` resolves against the device here. */
  function resolvedTheme() {
    if (prefs.theme !== 'system') return prefs.theme;
    return darkMedia.matches ? 'dark' : 'light';
  }

  function applyPrefs() {
    const root = document.documentElement;
    const theme = resolvedTheme();
    root.dataset.theme = theme === 'light' ? '' : theme;
    root.style.setProperty('--reader-size', prefs.size + 'rem');
    root.style.setProperty('--reader-font', prefs.face === 'serif' ? 'var(--serif)' : 'var(--sans)');
    const accent = ACCENTS.find(a => a.id === prefs.accent);
    if (accent?.value) root.style.setProperty('--accent', accent.value);
    else root.style.removeProperty('--accent');
    paintBrowserChrome();
  }

  /* The status bar in a standalone PWA follows theme-color, and both of the
     tags in the shell carry a media query, so both are kept in step. */
  function paintBrowserChrome() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!bg) return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', bg);
  }

  applyPrefs();
  darkMedia.addEventListener('change', () => { if (prefs.theme === 'system') applyPrefs(); });

  // ── api ──────────────────────────────────────────────────────────────────
  const serverStore = {
    list: (q, filter) => fetchJson(`/api/articles?filter=${filter}&q=${encodeURIComponent(q || '')}`),
    get: (id) => fetchJson(`/api/articles/${id}`),
    save: (url, source) => fetchJson('/api/articles', { method: 'POST', body: { url, ...sourceBody(source) } }),
    patch: (id, body) => fetchJson(`/api/articles/${id}`, { method: 'PATCH', body }),
    refetch: (id, source) => fetchJson(`/api/articles/${id}/refetch`, { method: 'POST', body: sourceBody(source) }),
    remove: (id) => fetchJson(`/api/articles/${id}`, { method: 'DELETE' }),
    removeAll: ({ includeLists } = {}) =>
      fetchJson(`/api/articles${includeLists ? '?lists=1' : ''}`, { method: 'DELETE' }),
    listCollections: () => fetchJson('/api/collections'),
    createCollection: (name) => fetchJson('/api/collections', { method: 'POST', body: { name } }),
    renameCollection: (id, name) => fetchJson(`/api/collections/${id}`, { method: 'PATCH', body: { name } }),
    deleteCollection: (id) => fetchJson(`/api/collections/${id}`, { method: 'DELETE' }),
    setArticleCollection: (id, collectionId, member) =>
      fetchJson(`/api/articles/${id}/collections/${collectionId}`, { method: 'PUT', body: { member } }),
    tagging: () => fetchJson('/api/tagging'),
    tagUntagged: () => fetchJson('/api/tagging', { method: 'POST', body: {} }),
  };
  const api = DEMO
    ? window.createParticleLocalStore({ fetchJson, maxArticles: DEMO_MAX })
    : serverStore;

  // `signal` is per call: narration cancels its own requests without giving
  // extraction or OCR a timeout they were never meant to have
  async function fetchJson(url, { method = 'GET', body, signal } = {}) {
    const res = await fetch(appUrl(url), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  // Page source this browser fetched (or the reader pasted) after clearing a captcha,
  // and what to fall back to when the page will not be read at all.
  function sourceBody(source) {
    return {
      ...(source?.html ? { html: source.html, source_url: source.sourceUrl || null } : {}),
      ...(source?.linkFallback ? { link_fallback: source.linkFallback } : {}),
    };
  }

  // ── routing ──────────────────────────────────────────────────────────────
  function route() {
    stopAllPolling();
    const path = BASE && location.pathname.startsWith(BASE)
      ? location.pathname.slice(BASE.length) || '/'
      : location.pathname;
    const m = path.match(/^\/read\/(\d+)$/);
    if (m) openReader(Number(m[1]));
    else showLibrary();
  }
  window.addEventListener('popstate', route);

  function go(path) {
    history.pushState({}, '', `${BASE}${path}` || '/');
    route();
  }

  // ── library ──────────────────────────────────────────────────────────────
  async function showLibrary() {
    saveReadingProgress();
    narrationClose();
    exitTrim();
    closeMenu();
    reader.hidden = true;
    library.hidden = false;
    progressBar.style.width = '0';
    document.title = 'particle';
    await refresh();
  }

  async function refresh() {
    try {
      const [articles, collections] = await Promise.all([
        api.list(state.q, requestFilter()),
        loadCollections(),
      ]);
      state.articles = articles;
      state.collections = collections;
      renderTabs();
      renderList();
    } catch (e) {
      saveStatus.textContent = 'library failed to load: ' + e.message;
      saveStatus.classList.remove('ok');
      saveStatus.classList.add('error');
    }
  }

  async function loadCollections() {
    try { return await api.listCollections(); } catch { return state.collections; }
  }

  /* `all` means every unarchived article, unless the reader has asked for read
     ones to stay in their own tab — which is exactly the unread view. */
  function requestFilter() {
    if (state.filter === 'all' && !prefs.readsInAll) return 'unread';
    return state.filter;
  }

  function tabList() {
    const built = [
      { id: 'all', label: 'all' },
      prefs.readsInAll ? { id: 'unread', label: 'unread' } : { id: 'read', label: 'read' },
      { id: 'favorites', label: 'favorites' },
      { id: 'archived', label: 'archive' },
    ];
    return built.concat(state.collections.map(c => ({ id: `collection:${c.id}`, label: c.name, list: c })));
  }

  function renderTabs() {
    const available = tabList();
    // a list the reader deleted, or a tab a setting just retired, falls back to all
    if (!available.some(t => t.id === state.filter)) setFilter('all', { refresh: false });
    tabs.innerHTML = available.map(tab => `
      <button data-filter="${esc(tab.id)}" class="tab${tab.id === state.filter ? ' active' : ''}">${esc(tab.label)}</button>
    `).join('');
  }

  function setFilter(filter, { refresh: reload = true } = {}) {
    state.filter = filter;
    localStorage.setItem('p.filter', filter);
    if (reload) refresh();
  }

  function renderList() {
    list.innerHTML = '';
    empty.hidden = state.articles.length > 0;
    if (empty.hidden) {
      for (const a of state.articles) {
        const li = row(a);
        list.appendChild(li);
        if (state.justSaved === a.id) openRow(li);
      }
      return;
    }
    const current = tabList().find(t => t.id === state.filter);
    $('empty-big').textContent = state.q ? 'nothing matches that'
      : current?.list ? `“${current.list.name}” is empty`
        : 'nothing here yet';
  }

  /* ── save confirmation ───────────────────────────────────────────────────
     Decoration, and deliberately fire-and-forget: every one of these is safe to
     lose, so nothing in the save path waits on or branches off them. */

  /* Restart from the top even if the reader saves twice in a row, then hand the
     element back to its resting styles once every animation on it has finished. */
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    settled(el).then(() => el.classList.remove(cls));
  }

  const settled = el => Promise.allSettled(
    (el.getAnimations?.({ subtree: true }) || []).map(anim => anim.finished));

  /* The row is claimed by id rather than animated here: it may not exist yet,
     and under some filters it never renders at all — hence the expiry. */
  let saveFlourish;
  function celebrateSave(id) {
    state.justSaved = id;
    clearTimeout(saveFlourish);
    saveFlourish = setTimeout(() => { state.justSaved = null; }, 10000);
    saveStatus.classList.add('ok');
    replay(form, 'is-saved');
    replay($('brand-dot'), 'is-saved');
  }

  /* The row grows into place instead of shoving the list down. Its height has
     to be measured here — there is nothing for CSS to animate to from `auto`. */
  function openRow(li) {
    state.justSaved = null;
    li.style.setProperty('--row-h', `${li.offsetHeight}px`);
    li.classList.add('is-new');
    settled(li).then(() => {
      li.classList.remove('is-new');
      li.style.removeProperty('--row-h');
    });
  }

  function row(a) {
    const li = document.createElement('li');
    li.className = 'article-row' + (a.read_at ? ' is-read' : '');
    li.tabIndex = 0;

    const mins = Math.max(1, Math.round((a.word_count || 0) / 230));
    const tags = (a.tags || []).join(', ');
    const lists = collectionNames(a);
    const flag = a.quality === 'link'
      ? '<span class="row-flag" title="the page could not be read; this is the link">&#9679; link</span>'
      : a.quality === 'partial' || a.quality === 'stub'
        ? '<span class="row-flag" title="extraction may be incomplete">&#9679; partial</span>' : '';

    li.innerHTML = `
      <div class="row-top">
        <span class="row-site">${esc(a.site_name || hostOf(a.url))}</span>
        ${flag}
        ${lists ? `<span class="row-flag" title="in your lists">${esc(lists)}</span>` : ''}
        ${tags ? `<span class="row-tags">${esc(tags)}</span>` : ''}
      </div>
      <div class="row-title">${esc(a.title || a.url)}</div>
      ${a.excerpt ? `<div class="row-excerpt">${esc(a.excerpt)}</div>` : ''}
      <div class="row-bottom">
        <span>${a.quality === 'link' ? 'link only' : `${mins} min`}</span>
        ${a.progress > 0.02 && a.progress < 0.97 ? `<span class="row-progress"><i style="width:${Math.round(a.progress * 100)}%"></i></span>` : ''}
        ${a.read_at ? '<span>read</span>' : ''}
        ${a.edited_at ? '<span class="row-edited" title="you trimmed this article">trimmed</span>' : ''}
        <span>${relDate(a.saved_at)}</span>
        <span class="row-actions">
          <button class="row-btn ${a.favorite ? 'on' : ''}" data-act="fav" title="favorite">${a.favorite ? '★' : '☆'}</button>
          <button class="row-btn ${a.archived ? 'on' : ''}" data-act="arch" title="${a.archived ? 'unarchive' : 'archive'}">↧</button>
          <button class="row-btn" data-act="del" title="delete">✕</button>
          <button class="row-btn row-more" data-act="more" title="lists and more" aria-haspopup="menu">⋯</button>
        </span>
      </div>`;

    li.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (btn) {
        ev.stopPropagation();
        if (btn.dataset.act === 'fav') await api.patch(a.id, { favorite: !a.favorite });
        if (btn.dataset.act === 'arch') await api.patch(a.id, { archived: !a.archived });
        if (btn.dataset.act === 'del') return deleteArticle(a, { after: refresh });
        if (btn.dataset.act === 'more') return openArticleMenu(btn, a, { after: refresh });
        refresh();
        return;
      }
      go(`/read/${a.id}`);
    });
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') go(`/read/${a.id}`);
    });
    return li;
  }

  const collectionNames = a => state.collections
    .filter(list => (a.collections || []).includes(list.id))
    .map(list => list.name)
    .join(' · ');

  /* One confirmation, one wording, wherever delete is reached from. */
  async function deleteArticle(article, { after } = {}) {
    const title = article.title || article.url;
    const short = title.length > 60 ? `${title.slice(0, 57)}…` : title;
    if (!confirm(`Delete “${short}” from your library?\n\nThis cannot be undone.`)) return false;
    try {
      await api.remove(article.id);
    } catch (e) {
      alert(`could not delete that article: ${e.message}`);
      return false;
    }
    // its audio and its place in this browser go with it
    if (!DEMO) {
      audioStore?.remove(article.id).catch(() => {});
      try { localStorage.removeItem(localPlaceKey(article.id)); } catch { /* storage refused */ }
    }
    after?.();
    return true;
  }

  // ── save ─────────────────────────────────────────────────────────────────
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    saveBtn.disabled = true;
    saveStatus.classList.remove('error', 'ok');
    saveStatus.textContent = 'extracting…';
    $('rescue').hidden = true;
    try {
      const a = await api.save(url);
      urlInput.value = '';
      saveStatus.textContent = a.duplicate ? 'already in your library'
        : a.evicted_title ? `saved “${a.title}” · removed oldest article “${a.evicted_title}”`
          : `saved “${a.title}”`;
      // an article already in the library has nothing to announce
      if (!a.duplicate) celebrateSave(a.id);
      if (a.challenge) {
        offerRescue({
          url: a.url, articleId: a.id, challenge: a.challenge, mount: $('rescue'),
          head: 'partial extraction. archive.today may hold a fuller snapshot.',
          onDone: saved => {
            saveStatus.textContent = `re-extracted “${saved.title}”`;
            celebrateSave(saved.id);
            refresh();
          },
        });
      }
      if (DEMO && !a.duplicate && !localStorage.getItem('p.demo.selfhost-nudge')) {
        $('demo-nudge').hidden = false;
        localStorage.setItem('p.demo.selfhost-nudge', '1');
      }
      setTimeout(() => {
        if (saveStatus.classList.contains('error')) return;
        saveStatus.textContent = '';
        saveStatus.classList.remove('ok');
      }, 4000);
      refresh();
      // tags arrive async from enrichment; a reasoning model can take a while
      if (!DEMO) { setTimeout(refresh, 9000); setTimeout(refresh, 30000); }
    } catch (e) {
      if (DEMO && e.message.startsWith('demo limit reached')) {
        saveStatus.innerHTML = `${esc(e.message)} · <a href="https://github.com/crnst8/particle">self-host without a limit →</a>`;
      } else {
        saveStatus.textContent = e.message;
      }
      saveStatus.classList.remove('ok');
      saveStatus.classList.add('error');
      // 428 means a snapshot is known and blocked, so go straight at it. Any other
      // failed extraction just gets the offer; the snapshot may not exist.
      const rescuable = e.status === 428 || e.status === 422;
      if (rescuable) {
        urlInput.value = '';
        const target = e.data?.challenge?.original_url || url;
        const onDone = saved => {
          saveStatus.classList.remove('error');
          saveStatus.textContent = `saved “${saved.title}” from archive.today`;
          celebrateSave(saved.id);
          refresh();
        };
        if (e.data?.challenge) {
          saveStatus.textContent = 'source blocked; trying archive.today';
          startRescue({ url: target, challenge: e.data.challenge, mount: $('rescue'), onDone });
        } else {
          offerRescue({ url: target, mount: $('rescue'), onDone });
        }
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  tabs.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab');
    if (!tab) return;
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    setFilter(tab.dataset.filter);
  });
  renderTabs();

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = search.value; refresh(); }, 250);
  });

  /* ── screenshot ───────────────────────────────────────────────────────────
     The reader is in TikTok, a video mentions a piece, and a screenshot is the
     only thing they can take with them. The server reads the picture and looks
     the article up; this end offers what it found rather than filing it blind,
     because a screenshot naming four articles is not four articles the reader
     asked for. One find saves itself; several ask. */

  const shotInput = $('shot-input'), shotPicker = $('shot-picker');

  /* The server answers in stages, so the reader is told which one it is in, and
     for as long as it runs the field steps aside and the progress takes its
     place. A save that can take a minute should never leave an idle text box
     sitting there: there is nothing to type into it, and a status line that has
     not changed for forty seconds reads as a hang whether or not it is one. */
  const shotStage = $('shot-stage'), shotElapsed = $('shot-elapsed');
  let shotClock = null;
  let shotAbort = null;

  function shotBusy(text) {
    shotStage.textContent = text;
  }

  function shotStart() {
    shotAbort = new AbortController();
    saveStatus.textContent = '';
    saveStatus.classList.remove('error', 'ok');
    shotPicker.hidden = true;
    shotPicker.innerHTML = '';
    form.classList.add('is-busy');
    $('shot-progress').hidden = false;
    document.body.classList.add('is-reading-shot');
    shotBusy('uploading the screenshot…');

    const from = Date.now();
    shotElapsed.textContent = '';
    clearInterval(shotClock);
    // Only after a few seconds: a counter that starts at 0s makes a fast read
    // look slow, and the point of it is to reassure during a long one.
    shotClock = setInterval(() => {
      const seconds = Math.round((Date.now() - from) / 1000);
      shotElapsed.textContent = seconds >= 3 ? `${seconds}s` : '';
    }, 1000);
  }

  function shotDone() {
    clearInterval(shotClock);
    shotClock = null;
    shotAbort = null;
    form.classList.remove('is-busy');
    $('shot-progress').hidden = true;
    saveBtn.disabled = false;
    shotInput.value = '';
    document.body.classList.remove('is-reading-shot');
  }

  $('shot-stop').addEventListener('click', () => shotAbort?.abort());

  async function readShot(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      saveStatus.textContent = 'that is not an image';
      saveStatus.classList.add('error');
      return;
    }
    saveBtn.disabled = true;
    shotStart();

    let done = null;
    try {
      const res = await fetch(appUrl('/api/screenshot'), {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
        signal: shotAbort.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      let looked = 0;
      for await (const event of ndjson(res.body)) {
        if (event.phase === 'received') shotBusy(`reading ${event.kb}KB…`);
        else if (event.phase === 'reading') {
          shotBusy(event.ocr ? 'reading the picture (no vision model — OCR)…' : 'reading the picture…');
        } else if (event.phase === 'read') {
          const [first, ...rest] = event.titles;
          shotBusy(rest.length
            ? `found ${event.titles.length} articles · looking them up…`
            : `“${clip(first, 46)}” · looking it up…`);
        } else if (event.phase === 'looked') {
          looked += 1;
          shotBusy(`${event.found ? 'found' : 'no link for'} “${clip(event.title, 40)}”${looked > 1 ? ` · ${looked} done` : ''}…`);
        } else if (event.phase === 'failed') throw new Error(event.error);
        else if (event.phase === 'done') done = event;
      }
      if (!done) throw new Error('that screenshot could not be read');

      const found = done.candidates.filter(one => one.url);
      const unresolved = done.candidates.filter(one => !one.url);
      if (!found.length && !unresolved.length) throw new Error('no article could be read out of that screenshot');

      /* One find, or one the picture confirmed twice over, is not a question —
         it is what the reader took the screenshot for. Whatever else the picture
         named is offered underneath afterwards rather than standing in the way. */
      const [best, ...others] = found;
      shotDone();
      if (best && (best.certain || found.length === 1)) {
        const article = await saveCandidate(best);
        if (article && (others.length || unresolved.length)) {
          offerCandidates(others, unresolved, { alsoFound: true });
        }
        return;
      }
      offerCandidates(found, unresolved);
    } catch (error) {
      const cancelled = error.name === 'AbortError';
      shotDone();
      saveStatus.textContent = cancelled ? 'stopped' : error.message;
      saveStatus.classList.remove('ok');
      if (!cancelled) saveStatus.classList.add('error');
    }
  }

  /* One JSON object per line, handed over as each stage finishes. */
  async function* ndjson(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? '' : decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) return;
    }
  }

  const clip = (text, at) => (String(text || '').length > at ? `${String(text).slice(0, at - 1)}…` : String(text || ''));

  /* What the picture said, kept for the save so a page that will not open is
     still filed under its real title rather than its hostname. */
  function candidateFallback(candidate) {
    return {
      title: candidate.title || null,
      byline: candidate.byline || null,
      site_name: candidate.publication || null,
      excerpt: candidate.subtitle || candidate.excerpt || null,
      published_at: candidate.published || null,
    };
  }

  async function saveCandidate(candidate) {
    saveStatus.classList.remove('error', 'ok');
    saveStatus.textContent = `saving “${candidate.title || candidate.url}”…`;
    try {
      const article = await api.save(candidate.url, { linkFallback: candidateFallback(candidate) });
      urlInput.value = '';
      saveStatus.textContent = article.duplicate ? 'already in your library'
        : article.quality === 'link' ? `saved “${article.title}” as a link — the page would not open`
          : `saved “${article.title}”`;
      if (!article.duplicate) celebrateSave(article.id);
      refresh();
      if (!DEMO) setTimeout(refresh, 9000);
      return article;
    } catch (error) {
      saveStatus.textContent = error.message;
      saveStatus.classList.add('error');
      return null;
    }
  }

  /* More than one article in the picture, or one that could not be looked up.
     `alsoFound` is the gentler case: the certain one is already in the library
     and these are the rest of what the picture named, offered rather than
     pressed — so nothing is ticked and the heading does not ask for a decision. */
  function offerCandidates(found, unresolved, { alsoFound = false } = {}) {
    const rows = found.map((candidate, index) => `
      <label class="shot-row">
        <input type="checkbox" data-shot="${index}"${!alsoFound && index === 0 ? ' checked' : ''}>
        <span class="shot-row-text">
          <span class="shot-title">${esc(candidate.title || candidate.url)}</span>
          <span class="shot-where">${esc(hostOf(candidate.url))}${candidate.via ? ` · found via ${esc(candidate.via)}` : ''}</span>
        </span>
      </label>`).join('');

    const misses = unresolved.map(candidate => `
      <li class="shot-miss">
        <span class="shot-title">${esc(candidate.title || 'something unreadable')}</span>
        <span class="shot-where">no link found${candidate.publication ? ` · ${esc(candidate.publication)}` : ''}</span>
      </li>`).join('');

    const head = alsoFound
      ? `also in that screenshot${found.length ? '' : ' — but no link for these'}`
      : found.length
        ? `${found.length} article${found.length === 1 ? '' : 's'} found`
        : 'nothing could be looked up';

    shotPicker.innerHTML = `
      <p class="shot-head">${head}</p>
      ${rows}
      ${misses ? `<ul class="shot-misses">${misses}</ul>` : ''}
      <div class="shot-actions">
        <button type="button" id="shot-save" class="shot-go"${found.length ? '' : ' disabled'}>${alsoFound ? 'add these too' : 'save selected'}</button>
        <button type="button" id="shot-cancel" class="shot-cancel">${alsoFound ? 'no thanks' : 'cancel'}</button>
      </div>`;
    shotPicker.hidden = false;
    if (!alsoFound) saveStatus.textContent = '';

    $('shot-cancel').addEventListener('click', () => { shotPicker.hidden = true; shotPicker.innerHTML = ''; });
    $('shot-save').addEventListener('click', async (ev) => {
      const picked = [...shotPicker.querySelectorAll('[data-shot]')]
        .filter(box => box.checked)
        .map(box => found[Number(box.dataset.shot)]);
      if (!picked.length) return;
      ev.target.disabled = true;
      shotPicker.hidden = true;
      let saved = 0;
      for (const candidate of picked) if (await saveCandidate(candidate)) saved += 1;
      if (saved > 1) saveStatus.textContent = `saved ${saved} articles`;
      shotPicker.innerHTML = '';
    });
  }

  $('shot-btn').addEventListener('click', () => shotInput.click());
  shotInput.addEventListener('change', () => readShot(shotInput.files?.[0]));

  // A screenshot is on the clipboard far more often than it is in a file picker.
  document.addEventListener('paste', (ev) => {
    if (reader.hidden === false || document.activeElement === search) return;
    const file = [...(ev.clipboardData?.files || [])].find(one => /^image\//.test(one.type));
    if (!file) return;
    ev.preventDefault();
    readShot(file);
  });

  // Only a dragged file is claimed: a dragged link still belongs to the browser.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (ev) => {
      if (!ev.dataTransfer?.types?.includes('Files')) return;
      ev.preventDefault();
      document.body.classList.toggle('is-dropping', type === 'dragover');
      if (type !== 'drop') return;
      const file = [...(ev.dataTransfer.files || [])].find(one => /^image\//.test(one.type));
      if (file) readShot(file);
    });
  }
  document.addEventListener('dragleave', () => document.body.classList.remove('is-dropping'));

  // ── reader ───────────────────────────────────────────────────────────────
  async function openReader(id) {
    let a;
    try { a = await api.get(id); }
    catch { return go('/'); }
    narrationClose();
    exitTrim({ restore: false });
    closeMenu();
    state.current = a;

    library.hidden = true;
    reader.hidden = false;
    document.title = a.title + ' — particle';

    $('a-site').textContent = a.site_name || hostOf(a.url);
    $('a-title').textContent = a.title || '';
    const mins = Math.max(1, Math.round((a.word_count || 0) / 230));
    const meta = [];
    if (a.byline) meta.push(`<em>${esc(a.byline)}</em>`);
    if (a.published_at) meta.push(esc(fmtDate(a.published_at)));
    meta.push(`${mins} min read`);
    $('a-meta').innerHTML = meta.join('<span class="sep">&middot;</span>');

    const note = $('a-note');
    $('reader-rescue').hidden = true;
    $('reader-rescue').innerHTML = '';
    if (a.quality === 'link' || a.quality === 'partial' || a.quality === 'stub') {
      note.hidden = false;
      // A link saved because the page would not open takes the same two ways
      // out as a partial one: ask the site again, or ask archive.today.
      note.innerHTML = (a.quality === 'link'
        ? `particle could not read this page, so only the link is saved${a.quality_note ? ' — ' + esc(a.quality_note) : ''}.`
        : `this extraction may be incomplete${a.quality_note ? ' — ' + esc(a.quality_note) : ''}.`)
        + ` <button id="note-refetch">try again</button> <button id="note-archive">try archive.today</button>`;
      note.querySelector('#note-refetch').addEventListener('click', () => doRefetch(a.id));
      note.querySelector('#note-archive').addEventListener('click', () => startRescue({
        url: a.url, articleId: a.id, mount: $('reader-rescue'), onDone: () => openReader(a.id),
      }));
    } else {
      note.hidden = true;
    }

    const articleHtml = BASE
      ? String(a.content_html || '').replaceAll('src="/api/', `src="${BASE}/api/`)
      : a.content_html || '';
    $('a-body').innerHTML = articleHtml;
    if (a.storage_trimmed) {
      saveStatusInline('This article body was removed because browser storage was full. Re-extract it to read again.');
    }
    // drop cap on the first substantial body paragraph (not pullquotes/notes)
    const firstP = [...$('a-body').querySelectorAll('p')].find(p =>
      !p.closest('blockquote, figure, figcaption') &&
      !p.querySelector('img') &&
      (p.textContent || '').trim().length > 120 &&
      !/[""]/.test((p.textContent || '').trim()[0] || '') &&
      !p.querySelector('em:first-child'));
    if (firstP) firstP.classList.add('dropcap');
    $('a-original').href = a.url;
    narrationOpen(a);
    updateFavUi(a);

    // mark read on open
    if (!a.read_at) api.patch(a.id, { read: true }).catch(() => {});

    // restore scroll position
    requestAnimationFrame(() => {
      const target = (a.progress || 0) * (scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = a.progress > 0.02 && a.progress < 0.97 ? target : 0;
      updateProgressBar();
    });
  }

  function updateFavUi(a) {
    $('fav-btn').classList.toggle('on', a.favorite);
    $('fav-btn').innerHTML = a.favorite ? '&#9733;' : '&#9734;';
    $('archive-btn').classList.toggle('on', a.archived);
  }

  function updateProgressBar() {
    const max = scroller.scrollHeight - scroller.clientHeight;
    const p = max > 0 ? scroller.scrollTop / max : 1;
    progressBar.style.width = (p * 100).toFixed(1) + '%';
    return p;
  }

  scroller.addEventListener('scroll', () => {
    if (reader.hidden) return;
    updateProgressBar();
    clearTimeout(state.progressTimer);
    state.progressTimer = setTimeout(saveReadingProgress, 800);
  }, { passive: true });

  function saveReadingProgress() {
    if (!state.current || reader.hidden) return;
    const p = updateProgressBar();
    api.patch(state.current.id, { progress: p }).catch(() => {});
  }

  async function doRefetch(id) {
    saveStatusInline('re-extracting…');
    try {
      await api.refetch(id);
      if (!DEMO) audioStore?.remove(id).catch(() => {});
      openReader(id);
    } catch (e) {
      saveStatusInline('re-extract failed: ' + e.message);
    }
  }
  function saveStatusInline(msg) {
    const note = $('a-note');
    note.hidden = false;
    note.textContent = msg;
  }

  $('back-btn').addEventListener('click', () => go('/'));
  $('font-smaller').addEventListener('click', () => prefs.size = +(prefs.size - SIZE_STEP).toFixed(4));
  $('font-larger').addEventListener('click', () => prefs.size = +(prefs.size + SIZE_STEP).toFixed(4));
  $('font-face').addEventListener('click', () => prefs.face = prefs.face === 'serif' ? 'sans' : 'serif');
  $('theme-btn').addEventListener('click', () => {
    prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length];
    if (!sheet.hidden) syncSettings();
  });
  $('fav-btn').addEventListener('click', async () => {
    if (!state.current) return;
    state.current = await api.patch(state.current.id, { favorite: !state.current.favorite });
    updateFavUi(state.current);
  });
  $('archive-btn').addEventListener('click', async () => {
    if (!state.current) return;
    state.current = await api.patch(state.current.id, { archived: !state.current.archived });
    updateFavUi(state.current);
  });
  $('a-refetch').addEventListener('click', () => state.current && doRefetch(state.current.id));
  $('a-delete').addEventListener('click', () => {
    if (state.current) deleteArticle(state.current, { after: () => go('/') });
  });
  $('more-btn').addEventListener('click', (ev) => {
    if (!state.current) return;
    ev.stopPropagation();
    openArticleMenu($('more-btn'), state.current, {
      inReader: true,
      after: async () => { state.current = await api.get(state.current.id).catch(() => state.current); },
      onDelete: () => go('/'),
    });
  });

  // ── article menu ─────────────────────────────────────────────────────────
  // The lists an article belongs to, then the things that change the article
  // itself. Same menu in the library row and in the reader bar.
  const menu = $('menu');
  let menuAnchor = null;

  function openArticleMenu(anchor, article, { inReader = false, after, onDelete } = {}) {
    if (menuAnchor === anchor && !menu.hidden) return closeMenu();
    const lists = state.collections;
    const memberOf = new Set(article.collections || []);
    menu.innerHTML = `
      <p class="menu-label">lists</p>
      ${lists.length
        ? lists.map(list => `
          <button class="menu-item" role="menuitem" data-list="${list.id}" aria-checked="${memberOf.has(list.id)}">
            <span class="menu-tick">${memberOf.has(list.id) ? '✓' : ''}</span>
            <span class="menu-name">${esc(list.name)}</span>
          </button>`).join('')
        : '<p class="menu-empty">no lists yet — make one in settings</p>'}
      <div class="menu-sep"></div>
      ${inReader && state.narration && !DEMO ? '<button class="menu-item" role="menuitem" data-do="listen-visible"><span class="menu-tick">▶</span><span class="menu-name">listen from visible paragraph</span></button>' : ''}
      ${inReader && state.narration && !DEMO ? '<button class="menu-item" role="menuitem" data-do="offline"><span class="menu-tick">⇣</span><span class="menu-name">listening offline…</span></button>' : ''}
      ${inReader ? '<button class="menu-item" role="menuitem" data-do="trim"><span class="menu-tick">✂</span><span class="menu-name">trim sections…</span></button>' : ''}
      ${inReader ? '<button class="menu-item" role="menuitem" data-do="refetch"><span class="menu-tick">↻</span><span class="menu-name">re-extract</span></button>' : ''}
      <button class="menu-item" role="menuitem" data-do="open"><span class="menu-tick">↗</span><span class="menu-name">view original</span></button>
      <button class="menu-item danger" role="menuitem" data-do="delete"><span class="menu-tick">✕</span><span class="menu-name">delete article</span></button>`;

    menu.hidden = false;
    menuAnchor = anchor;
    placeMenu(anchor);

    menu.onclick = async (ev) => {
      const item = ev.target.closest('[data-list], [data-do]');
      if (!item) return;
      ev.stopPropagation();

      if (item.dataset.list) {
        const listId = Number(item.dataset.list);
        const member = item.getAttribute('aria-checked') !== 'true';
        try {
          const updated = await api.setArticleCollection(article.id, listId, member);
          article.collections = updated.collections || [];
        } catch (e) {
          return alert(`could not update that list: ${e.message}`);
        }
        item.setAttribute('aria-checked', String(member));
        item.querySelector('.menu-tick').textContent = member ? '✓' : '';
        if (!inReader) refresh();
        return;
      }

      closeMenu();
      if (item.dataset.do === 'open') window.open(article.url, '_blank', 'noopener');
      if (item.dataset.do === 'refetch') doRefetch(article.id);
      if (item.dataset.do === 'trim') enterTrim();
      if (item.dataset.do === 'listen-visible') listenFromVisible();
      if (item.dataset.do === 'offline') { showPlayer(); openPanel(); }
      if (item.dataset.do === 'delete') {
        const gone = await deleteArticle(article, { after: onDelete || after });
        if (gone && !onDelete) refresh();
      }
    };
  }

  function placeMenu(anchor) {
    const box = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(Math.max(pad, box.right - size.width), window.innerWidth - size.width - pad);
    const below = box.bottom + 6;
    const top = below + size.height > window.innerHeight - pad
      ? Math.max(pad, box.top - size.height - 6)
      : below;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function closeMenu() {
    menu.hidden = true;
    menu.onclick = null;
    menuAnchor = null;
  }

  document.addEventListener('pointerdown', (ev) => {
    if (menu.hidden) return;
    if (menu.contains(ev.target) || menuAnchor?.contains(ev.target)) return;
    closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, { passive: true, capture: true });

  // ── trim ─────────────────────────────────────────────────────────────────
  /* Hand-editing a saved article. Nothing is written until the reader confirms:
     marks are made on the live DOM, the pre-trim markup is held aside so cancel
     is exact, and the saved copy is only rewritten by "remove & save". */
  const trim = { on: false, snapshot: '' };
  const TRIM_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, blockquote, figure, figcaption, pre, li, ul, ol, table, hr, dl';

  function enterTrim() {
    if (!state.current || reader.hidden || trim.on) return;
    stopNarration();
    trim.on = true;
    trim.snapshot = $('a-body').innerHTML;
    document.documentElement.dataset.editing = '1';
    $('trim-bar').hidden = false;
    updateTrimCount();
  }

  function exitTrim({ restore = true } = {}) {
    if (!trim.on) return;
    if (restore) $('a-body').innerHTML = trim.snapshot;
    trim.on = false;
    trim.snapshot = '';
    delete document.documentElement.dataset.editing;
    $('trim-bar').hidden = true;
  }

  function marks() { return [...$('a-body').querySelectorAll('.trim-mark')]; }

  function updateTrimCount() {
    const n = marks().length;
    $('trim-count').textContent = n ? `${n} section${n === 1 ? '' : 's'} marked` : 'nothing marked';
    $('trim-apply').disabled = n === 0;
  }

  /** The outermost block under a click, so tapping a caption marks its figure. */
  function blockAt(node) {
    const body = $('a-body');
    let block = node.closest?.(TRIM_BLOCKS) || node.parentElement?.closest(TRIM_BLOCKS);
    for (let up = block?.parentElement?.closest(TRIM_BLOCKS); up && body.contains(up); up = up.parentElement?.closest(TRIM_BLOCKS)) {
      block = up;
    }
    if (block && body.contains(block)) return block;
    // an unwrapped div/section child of the body still gets to be a target
    let child = node.nodeType === 1 ? node : node.parentElement;
    while (child && child.parentElement !== body) child = child.parentElement;
    return child && child !== body ? child : null;
  }

  function unmark(node) {
    if (node.dataset?.trimSpan === '1') node.replaceWith(...node.childNodes);
    else node.classList.remove('trim-mark');
  }

  $('a-body').addEventListener('click', (ev) => {
    if (!trim.on) return;
    ev.preventDefault();
    ev.stopPropagation();
    // a click that ends a drag-selection is the reader choosing text, not a block
    if (!window.getSelection()?.isCollapsed) return;
    const existing = ev.target.closest('.trim-mark');
    if (existing) { unmark(existing); return updateTrimCount(); }
    const block = blockAt(ev.target);
    if (!block || block === $('a-body')) return;
    block.classList.add('trim-mark');
    updateTrimCount();
  }, true);

  /* A selection inside one block marks exactly that run of text; one that
     crosses blocks marks each block it touches, which is what a reader dragging
     over three paragraphs means. */
  function markSelection() {
    const body = $('a-body');
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return 0;
    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return 0;

    const touched = [...body.querySelectorAll(TRIM_BLOCKS)]
      .filter(block => range.intersectsNode(block) && !block.parentElement.closest('.trim-mark'));
    const spansBlocks = touched.filter(block => !block.querySelector(TRIM_BLOCKS)).length > 1;

    if (spansBlocks) {
      for (const block of touched) {
        if (block.closest('.trim-mark')) continue;
        block.classList.add('trim-mark');
      }
    } else {
      const span = document.createElement('span');
      span.className = 'trim-mark';
      span.dataset.trimSpan = '1';
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      } catch {
        const block = blockAt(range.startContainer);
        if (block) block.classList.add('trim-mark');
      }
    }
    selection.removeAllRanges();
    updateTrimCount();
    return marks().length;
  }

  $('trim-selection').addEventListener('click', () => {
    if (!markSelection()) $('trim-count').textContent = 'select some article text first';
  });
  $('trim-cancel').addEventListener('click', () => exitTrim());

  $('trim-apply').addEventListener('click', async () => {
    const count = marks().length;
    if (!count || !state.current) return;
    if (!confirm(`Remove ${count} marked section${count === 1 ? '' : 's'} from your saved copy?\n\n`
      + 'This rewrites what particle stores for this article. There is no undo — '
      + 're-extracting the article is the only way back to the original.')) return;

    const html = trimmedHtml();
    if (!html) return alert('that would remove the whole article — delete it instead if that is what you want.');

    $('trim-apply').disabled = true;
    $('trim-count').textContent = 'saving…';
    try {
      const updated = await api.patch(state.current.id, { content_html: html });
      if (!DEMO) audioStore?.remove(updated.id).catch(() => {});
      exitTrim({ restore: false });
      state.current = updated;
      openReader(updated.id);
    } catch (e) {
      $('trim-count').textContent = `could not save: ${e.message}`;
      $('trim-apply').disabled = false;
    }
  });

  /** The body without its marked passages, in the form the library stores. */
  function trimmedHtml() {
    const clone = $('a-body').cloneNode(true);
    for (const node of clone.querySelectorAll('.trim-mark')) node.remove();
    // a partial removal can leave an empty paragraph behind
    for (const node of clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption')) {
      if (!node.textContent.trim() && !node.querySelector('img, video, audio, iframe')) node.remove();
    }
    if (!clone.textContent.trim() && !clone.querySelector('img')) return '';
    return storedHtml(clone);
  }

  /** A copy of the body without the classes this page adds for display. The
      reader's speech marks are attributes, not display, and stay. */
  function storedHtml(clone) {
    const display = ['is-narrating', 'is-unspoken', 'dropcap'];
    for (const node of clone.querySelectorAll(display.map(name => `.${name}`).join(', '))) {
      node.classList.remove(...display);
      if (!node.getAttribute('class')) node.removeAttribute('class');
    }
    let html = clone.innerHTML.trim();
    // images are shown through a base-prefixed proxy path; store the plain one
    if (BASE) html = html.replaceAll(`src="${BASE}/api/`, 'src="/api/');
    return html;
  }

  // ── keyboard ─────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, textarea')) return;
    if (!menu.hidden && ev.key === 'Escape') return closeMenu();
    if (trim.on) {
      if (ev.key === 'Escape') exitTrim();
      if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); markSelection(); }
      return;
    }
    if (!reader.hidden) {
      const listening = !$('player').hidden;
      if (ev.key === 'Escape') go('/');
      if (ev.key === 'f') $('fav-btn').click();
      if (ev.key === 'e') $('archive-btn').click();
      // with text selected, "l" starts from that paragraph; shift-l from the first one showing
      if (ev.key === 'l' && state.narration) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && $('a-body').contains(selection.anchorNode)) listenFrom(selection.anchorNode);
        else primaryAction();
      }
      if (ev.key === 'L' && state.narration) listenFromVisible();
      if (ev.key === 'j') scroller.scrollBy({ top: scroller.clientHeight * 0.85, behavior: 'smooth' });
      if (ev.key === 'k') scroller.scrollBy({ top: -scroller.clientHeight * 0.85, behavior: 'smooth' });
      if (listening && ev.key === ' ') { ev.preventDefault(); $('pl-play').click(); }
      if (listening && ev.key === 'ArrowLeft') { ev.preventDefault(); $('pl-back').click(); }
      if (listening && ev.key === 'ArrowRight') { ev.preventDefault(); $('pl-fwd').click(); }
    } else if (ev.key === '/') {
      ev.preventDefault();
      search.focus();
    }
  });

  // save progress when leaving the page
  window.addEventListener('pagehide', () => {
    if (!state.current || reader.hidden) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const p = max > 0 ? scroller.scrollTop / max : 1;
    if (DEMO) {
      api.patch(state.current.id, { progress: p }).catch(() => {});
      return;
    }
    fetch(appUrl(`/api/articles/${state.current.id}`), {
      method: 'PATCH',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: p }),
    }).catch(() => {});
    // the place goes too, on the same keepalive footing; until the server
    // acknowledges it, this browser keeps it as unsent and offers it next time
    const place = player.unload();
    if (place?.body) {
      fetch(appUrl(`/api/articles/${place.articleId}/narration/position`), {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(place.body),
      }).catch(() => {});
    }
  });

  // ── archive.today rescue ─────────────────────────────────────────────────
  // The mirrors rate-limit by IP, gate on a captcha cookie and do not send CORS
  // headers on a served snapshot, so neither the server nor this page can be
  // relied on to read one. Both are tried; the page source is otherwise supplied
  // from the archive.today tab itself, by bookmarklet or by paste.
  const CHALLENGED = /<title>\s*archive\.[a-z]{2,6}\s*<\/title>/i;
  const polling = new Set();

  async function startRescue({ url, articleId, challenge, mount, onDone }) {
    stopAllPolling();
    const session = { url, articleId, mount, onDone, snapshotUrl: challenge?.snapshot_url || '' };
    mount.hidden = false;
    if (!session.snapshotUrl) {
      say(mount, 'locating snapshot…');
      try {
        const found = await fetchJson(`/api/archive-snapshot?url=${encodeURIComponent(url)}`);
        session.snapshotUrl = found.snapshot_url;
      } catch (e) {
        return say(mount, e.message, 'error');
      }
    }
    return tryRescue(session, { allowServerRetry: false });
  }

  async function tryRescue(session, { allowServerRetry }) {
    const { mount } = session;
    say(mount, 'fetching snapshot…');
    const page = await fetchSnapshot(session.snapshotUrl);

    if (!page && allowServerRetry) {
      say(mount, 'retrying from the server…');
      try { return await finishRescue(session, null); } catch { /* still blocked */ }
    }
    if (!page) return renderChallenge(session);

    say(mount, 'parsing snapshot…');
    try {
      await finishRescue(session, { html: page.html, sourceUrl: page.finalUrl });
    } catch (e) {
      renderChallenge(session, e.message);
    }
  }

  async function finishRescue(session, source) {
    const saved = session.articleId
      ? await api.refetch(session.articleId, source)
      : await api.save(session.url, source);
    session.mount.hidden = true;
    session.mount.innerHTML = '';
    session.onDone(saved);
    return saved;
  }

  async function fetchSnapshot(snapshotUrl) {
    try {
      const res = await fetch(snapshotUrl, { credentials: 'omit', redirect: 'follow' });
      const html = await res.text();
      if (!res.ok || CHALLENGED.test(html.slice(0, 4000))) return null;
      return { html, finalUrl: res.url || snapshotUrl };
    } catch {
      return null; // CORS or network: fall back to supplying the source by hand
    }
  }

  /* Neither fetch could read the snapshot. The page source has to come out of
     the archive.today tab itself: by bookmarklet, or pasted. */
  async function renderChallenge(session, error) {
    const { mount } = session;
    stopPolling(session);
    mount.hidden = false;
    mount.innerHTML = '<p class="rescue-head">preparing handoff…</p>';

    let ticket = null;
    try {
      ticket = await fetchJson('/api/handoff/tickets', { method: 'POST', body: { url: session.url } });
    } catch { /* no ticket: pasting still works */ }

    mount.innerHTML = `
      <p class="rescue-head">can't fetch this snapshot. supply the page source:</p>
      ${error ? `<p class="rescue-error">${esc(error)}</p>` : ''}
      <ol class="rescue-steps">
        <li><a class="rescue-link" href="${esc(session.snapshotUrl)}" target="_blank" rel="noopener">open snapshot &#8599;</a></li>
        <li>wait for the article. solve the captcha if one appears</li>
        ${ticket ? `<li>click <a class="rescue-link rescue-bookmarklet" href="${bookmarkletHref(ticket)}">send page to particle</a>
          <span class="rescue-hint">(drag to bookmarks bar first)</span></li>` : ''}
      </ol>
      ${ticket ? '<p class="rescue-wait">waiting for page…</p>' : ''}
      <form class="rescue-manual">
        <label>or paste it: view source, select all, copy.</label>
        <textarea rows="3" spellcheck="false" placeholder="page source, or the article text"></textarea>
        <div class="rescue-buttons">
          <button class="rescue-submit" type="submit">use this source</button>
          <button class="rescue-go" type="button">retry fetch</button>
        </div>
      </form>
      <p class="rescue-note">Bookmarklet: desktop only, and blocked from an https page to a
        plain http particle. Paste always works; on mobile, copy the article text.</p>`;

    mount.querySelector('.rescue-go').addEventListener('click', () => {
      tryRescue(session, { allowServerRetry: true });
    });
    mount.querySelector('.rescue-bookmarklet')?.addEventListener('click', (ev) => {
      // Clicked here it would only ever read particle's own page.
      ev.preventDefault();
      const wait = mount.querySelector('.rescue-wait');
      if (wait) wait.textContent = 'drag it to the bookmarks bar, then click it on the archive.today tab';
    });
    mount.querySelector('.rescue-manual').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const html = ev.target.querySelector('textarea').value.trim();
      if (!html) return;
      stopPolling(session);
      say(mount, 'parsing source…');
      try {
        await finishRescue(session, { html, sourceUrl: session.snapshotUrl });
      } catch (e) {
        renderChallenge(session, e.message);
      }
    });
    if (ticket) pollTicket(session, ticket.token);
  }

  function bookmarkletHref(ticket) {
    const code = `(function(){var b={token:${JSON.stringify(ticket.token)},url:location.href,`
      + 'html:document.documentElement.outerHTML};'
      + `fetch(${JSON.stringify(ticket.endpoint)},{method:'POST',headers:{'Content-Type':'text/plain'},`
      + 'body:JSON.stringify(b)}).then(function(r){return r.json()}).then(function(j){'
      + "alert(j.error?'particle: '+j.error:'particle saved: '+(j.title||'ok'))})"
      + ".catch(function(e){alert('particle could not be reached: '+e)})})()";
    return 'javascript:' + encodeURIComponent(code);
  }

  function pollTicket(session, token) {
    session.poll = setInterval(async () => {
      let state;
      try { state = await fetchJson(`/api/handoff/${token}`); } catch { return; }
      if (state.status === 'ready' && state.article) {
        stopPolling(session);
        const saved = DEMO ? await api.adopt(state.article) : state.article;
        session.mount.hidden = true;
        session.mount.innerHTML = '';
        session.onDone(saved);
        return;
      }
      if (state.status === 'expired') return stopPolling(session);
      const wait = session.mount.querySelector('.rescue-wait');
      if (wait && state.error) wait.textContent = `that page did not parse: ${state.error}`;
      else if (wait && state.status === 'claimed') wait.textContent = 'parsing received page…';
    }, 2500);
    polling.add(session);
  }

  function stopPolling(session) {
    clearInterval(session.poll);
    session.poll = null;
    polling.delete(session);
  }
  function stopAllPolling() {
    for (const session of [...polling]) stopPolling(session);
  }

  function offerRescue({ url, articleId, challenge, mount, onDone, head }) {
    mount.hidden = false;
    mount.innerHTML = `<p class="rescue-head">${esc(head || 'archive.today may hold a snapshot of this page.')}</p>
      <p class="rescue-alt"><button class="rescue-submit" type="button">try archive.today</button></p>`;
    mount.querySelector('.rescue-submit').addEventListener('click', () => {
      startRescue({ url, articleId, challenge, mount, onDone });
    });
  }

  function say(mount, message, kind) {
    mount.hidden = false;
    mount.innerHTML = `<p class="rescue-head${kind === 'error' ? ' error' : ''}">${esc(message)}</p>`;
  }

  // ── narration ────────────────────────────────────────────────────────────
  // The controller in narration-player.js owns the audio: what plays, when,
  // and what a late reply is allowed to change. This section is its adapter to
  // this page — the reader's DOM, the API, storage, and the controls — and the
  // reader-side actions: listen from a paragraph, skip a paragraph, choose a
  // voice, keep an article for offline listening.
  const RATES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const SOURCE_LABEL = {
    locked: 'set for this install',
    article: 'chosen for this article',
    default: 'your default',
    automatic: 'automatic',
    configured: 'install default',
    earlier: 'an earlier choice',
  };
  const SKIP_LABEL = {
    manual: 'you chose to skip it', caption: 'a caption', credit: 'a credit', metadata: 'byline or date',
    table: 'part of a table', code: 'code', title: 'the title again', boilerplate: 'page furniture',
    duplicate: 'a repeated pullquote', empty: 'nothing to say',
  };

  const narration = {
    map: null,             // the open article's block map: { content_revision, selector, blocks }
    mapReady: null,        // a promise for it, for "listen from here" before it arrives
    nodes: [],             // rendered elements by DOM index, once checked against the map
    lit: [],
    lastScrollAt: 0,
    status: null,          // EventSource
    stageTimer: null,
    view: null,
    offline: null,         // { local, total, ready } for the open article
    download: null,        // { articleId, abort, done, total }
    get rate() { return Number(safeGet('p.rate')) || 1; },
    set rate(v) { safeSet('p.rate', String(v)); },
    get follow() { return safeGet('p.follow') !== '0'; },
    set follow(v) { safeSet('p.follow', v ? '1' : '0'); },
  };
  // a read-captions switch used to live here; captions are never read now
  try { localStorage.removeItem('p.captions'); } catch { /* storage refused */ }

  const localPlaceKey = id => `p.place:${location.origin}${BASE}:${id}`;
  const audioStore = DEMO ? null : createAudioStore({ scope: BASE || '/', appUrl });
  const bookmarkSync = createBookmarkSync({
    local: {
      load: id => JSON.parse(localStorage.getItem(localPlaceKey(id)) || 'null'),
      save: (id, value) => localStorage.setItem(localPlaceKey(id), JSON.stringify(value)),
      remove: id => localStorage.removeItem(localPlaceKey(id)),
    },
    send: (id, body) => fetchJson(`/api/articles/${id}/narration/position`, { method: 'PUT', body }),
    onState: () => { if (narration.view) renderPlayer(player.view()); },
  });

  const decks = [new Audio(), new Audio()];
  for (const deck of decks) {
    deck.preload = 'auto';
    deck.playsInline = true;
    deck.hidden = true;
    $('player').appendChild(deck);
  }

  const player = createNarrationPlayer({
    api: {
      prepare: prepareNarration,
      demand: (id, body) => fetchJson(`/api/articles/${id}/narration/demand`, { method: 'POST', body }),
    },
    source: {
      load: (manifest, seq, options) => {
        audioStore.protect(manifest, [seq, seq + 1]);
        return audioStore.load(manifest, seq, options);
      },
    },
    bookmarks: bookmarkSync,
    decks,
    silence: silentWavUrl(),
    rate: () => narration.rate,
    saveData: () => Boolean(navigator.connection?.saveData),
    visible: () => !document.hidden,
    onOnline: callback => window.addEventListener('online', callback, { once: true }),
    ui: {
      update: renderPlayer,
      highlight,
      manifest: adoptManifest,
      contentChanged: () => loadBlockMap(state.current, { force: true }),
    },
  });

  /* Prepare on the server; offline, fall back to the manifest this browser
     kept and the place it saved. A voice cannot be changed offline. */
  async function prepareNarration(id, body, { signal } = {}) {
    try {
      const manifest = await fetchJson(`/api/articles/${id}/narration`, { method: 'POST', body, signal });
      audioStore.saveManifest(manifest).catch(() => {});
      return manifest;
    } catch (error) {
      if (error.status || error.name === 'AbortError' || body.voice_override !== undefined) throw error;
      const place = body.start?.bookmark || bookmarkSync.view(id).bookmark;
      const manifest = (place && await audioStore.loadManifest(id, place.rev)) || await audioStore.loadManifest(id);
      if (!manifest) {
        throw Object.assign(new Error('this article has not been downloaded for offline listening'),
          { code: 'offline_unavailable', retryable: true });
      }
      let start = resolveStart(manifest, place);
      if (body.start?.mode === 'beginning') start = { seq: 0, offset: 0, mode: 'beginning' };
      if (body.start?.mode === 'block') {
        const found = segmentForBlock(manifest, body.start.block_id);
        start = found ? { seq: found.seq, offset: 0, mode: 'block' } : { mode: 'nothing' };
      }
      return { ...manifest, start, offline: true };
    }
  }

  // ── the article's block map ──
  /* Fetched when the reader opens, so "listen from here" knows which paragraph
     is which before anything is prepared. It starts no paid work. */
  function loadBlockMap(article, { force = false } = {}) {
    if (DEMO || !state.narration || !article) return null;
    if (!force && narration.map?.article === article.id) return narration.mapReady;
    const id = article.id;
    narration.map = null;
    narration.mapReady = fetchJson(`/api/articles/${id}/narration/blocks`)
      .then((map) => {
        if (state.current?.id !== id) return null;
        narration.map = { ...map, article: id };
        mapNodes(map);
        if (map.bookmark) player.seed(map.bookmark);
        return narration.map;
      })
      .catch(() => null);
    return narration.mapReady;
  }

  /* The block map's DOM indices only mean something against the text it was
     made from; a page showing other text gets no highlighting rather than the
     wrong paragraph lit. */
  function mapNodes(map) {
    const sameText = map && state.current && map.content_revision === state.current.content_revision;
    narration.nodes = sameText ? [...$('a-body').querySelectorAll(map.selector)] : [];
    for (const node of $('a-body').querySelectorAll('.is-unspoken')) node.classList.remove('is-unspoken');
    if (!sameText) return;
    for (const block of map.blocks || []) {
      if (block.skip_reason && block.skip_reason !== 'empty') narration.nodes[block.dom_index]?.classList.add('is-unspoken');
    }
  }

  function adoptManifest(manifest) {
    if (narration.map?.content_revision !== manifest.content_revision && state.current?.id === manifest.article_id) {
      narration.map = { article: manifest.article_id, content_revision: manifest.content_revision, selector: manifest.selector, blocks: manifest.blocks };
      narration.mapReady = Promise.resolve(narration.map);
      mapNodes(narration.map);
    }
    refreshOffline(manifest);
  }

  /** The block (an entry of the map) that owns a node in the article. */
  function blockFor(node, map = narration.map) {
    if (!map || !node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const owner = el?.closest?.(map.selector);
    if (!owner || !$('a-body').contains(owner)) return null;
    const nodes = narration.nodes.length ? narration.nodes : [...$('a-body').querySelectorAll(map.selector)];
    const index = nodes.indexOf(owner);
    if (index < 0) return null;
    // a container with no words of its own stands for the first block inside it
    return (map.blocks || []).find(block => block.dom_index === index)
      || (map.blocks || []).find(block => block.dom_index > index) || null;
  }

  // ── starting ──
  function showPlayer() {
    $('player').hidden = false;
    document.documentElement.dataset.listening = '1';
    watchStatus();
  }

  function hidePlayer() {
    $('player').hidden = true;
    $('pl-panel').hidden = true;
    $('pl-more').setAttribute('aria-expanded', 'false');
    delete document.documentElement.dataset.listening;
    closeStatus();
  }

  /** The main action: Listen, Resume, Listen again — or pause while playing. */
  function primaryAction() {
    if (!state.current || !state.narration) return;
    player.unlock();
    if (player.intent === 'playing') return player.pause();
    showPlayer();
    return player.resume();
  }

  function startOver() {
    if (!state.current) return;
    player.unlock();
    showPlayer();
    player.listen({ from: 'beginning' });
  }

  /* Listen from a paragraph the reader pointed at. The gesture unlocks audio
     now; the paragraph is resolved through the block map, which may still be
     on its way. */
  async function listenFrom(node) {
    if (!state.current || !state.narration || !node) return;
    player.unlock();
    showPlayer();
    const id = state.current.id;
    const map = narration.map || await loadBlockMap(state.current);
    if (!map || state.current?.id !== id) return;
    const block = blockFor(node, map);
    if (!block) return;
    player.listen({ from: { block_id: block.id, content_revision: map.content_revision } });
  }

  /* The first spoken paragraph showing below the reader's header, or the next
     one after the screen if the screen shows none. */
  function listenFromVisible() {
    const map = narration.map;
    if (!map) return listenFrom($('a-body').firstElementChild);
    const top = scroller.getBoundingClientRect().top + ($('reader').querySelector('.reader-bar')?.offsetHeight || 0);
    for (const block of map.blocks || []) {
      if (block.skip_reason) continue;
      const node = narration.nodes[block.dom_index];
      if (node && node.getBoundingClientRect().bottom > top + 4) return listenFrom(node);
    }
  }

  // ── what is happening ──
  function renderPlayer(view) {
    narration.view = view;
    if (!state.current || view.articleId !== state.current.id) return renderListenRow(null);
    const playing = view.intent === 'playing';
    const button = $('pl-play');
    button.innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    button.classList.toggle('is-waiting', view.state === 'preparing' || view.state === 'buffering');

    const seek = $('pl-seek');
    const total = view.total || 0;
    if (document.activeElement !== seek) seek.value = String(total ? Math.round((view.position / total) * 1000) : 0);
    seek.disabled = !view.ready;
    $('pl-time').textContent = view.ready ? `${clock(view.position)} / ${view.estimated ? '~' : ''}${clock(total)}` : '';
    $('pl-rate').textContent = `${narration.rate}×`;
    setNow(statusLine(view), view.state === 'error' || view.state === 'blocked' ? 'error' : '');
    renderActions(view);
    renderListenRow(view);
    if (!$('pl-panel').hidden) renderPanel();
    updateMediaSession(view);
    if (view.state === 'preparing' || view.state === 'buffering') {
      if (!narration.stageTimer) narration.stageTimer = setInterval(() => renderPlayer(player.view()), 1000);
    } else if (narration.stageTimer) {
      clearInterval(narration.stageTimer);
      narration.stageTimer = null;
    }
  }

  function statusLine(view) {
    const voice = view.voice?.name || '';
    if (view.state === 'error') return view.error?.message || 'that passage could not be played';
    if (view.state === 'blocked') return 'tap play to continue';
    if (view.state === 'preparing' || view.state === 'buffering') {
      const stage = view.stage;
      const seconds = stage ? Math.floor((Date.now() - stage.at) / 1000) : 0;
      const detail = stage?.detail || (view.state === 'preparing' ? 'preparing' : 'buffering');
      const where = Number.isInteger(stage?.seq) && stage?.total ? ` (${stage.seq + 1}/${stage.total})` : '';
      return `${detail}${where}${seconds >= 3 ? ` · ${seconds}s` : ''}…`;
    }
    if (view.notice) return view.notice;
    if (view.state === 'ended') return 'finished';
    if (view.state === 'paused') return voice ? `paused · ${voice}` : 'paused';
    return voice;
  }

  /* The way out of every stopped state is on screen, not in a menu: a failed
     passage gets Retry, Choose voice and Skip passage; a bookmark another
     device moved gets both places; changed text gets a fresh start. */
  function renderActions(view) {
    const mount = $('pl-actions');
    const buttons = [];
    if (view.state === 'error') {
      if (view.error?.retryable !== false || view.error?.code === 'offline_unavailable') buttons.push(['retry', 'retry']);
      buttons.push(['voice', 'choose voice']);
      if (view.ready) buttons.push(['skip', 'skip passage']);
    }
    if (view.state === 'blocked') buttons.push(['resume', 'play']);
    // a connection slower than the listening cannot be fixed by waiting longer
    if (view.slow && audioStore && (view.state === 'buffering' || view.error?.code === 'network')
      && !narration.offline?.ready && !narration.download) buttons.push(['download', 'download before listening']);
    if (view.changed) buttons.push(['beginning', 'start over'], ['visible', 'listen from here']);
    if (view.conflict) buttons.push(['mine', 'continue here'], ['theirs', 'use saved position']);
    mount.hidden = !buttons.length;
    mount.innerHTML = buttons.map(([action, label]) =>
      `<button type="button" class="linklike" data-pl="${action}">${esc(label)}</button>`).join('');
  }

  $('pl-actions').addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-pl]')?.dataset.pl;
    if (!action) return;
    player.unlock();
    if (action === 'retry') player.retry();
    if (action === 'skip') player.skipPassage();
    if (action === 'resume') player.resume();
    if (action === 'beginning') player.listen({ from: 'beginning' });
    if (action === 'visible') listenFromVisible();
    if (action === 'mine' || action === 'theirs') player.resolveConflict(action);
    if (action === 'voice') openPanel({ picking: true });
    if (action === 'download') { player.pause(); openPanel(); downloadForOffline(); }
  });

  /* The reader's own row under the title: Listen, Resume or Listen again, and
     Start over once there is a place to start over from. */
  function renderListenRow(view) {
    const row = $('a-listen');
    const enabled = Boolean(state.narration && state.current && !DEMO);
    row.hidden = !enabled;
    $('listen-btn').hidden = !enabled;
    if (!enabled) return;
    const action = view?.action || 'listen';
    const label = { listen: 'listen', resume: 'resume', 'listen again': 'listen again', pause: 'pause' }[action] || 'listen';
    $('a-listen-go').textContent = `${action === 'pause' ? '❚❚' : '▶'} ${label}`;
    $('a-listen-over').hidden = !(view && (action === 'resume' || (action === 'pause' && view.seq > 0)));
    $('listen-btn').title = `${label[0].toUpperCase()}${label.slice(1)} (l)`;
    $('listen-btn').setAttribute('aria-label', label);
    $('listen-btn').classList.toggle('on', action === 'pause');
  }

  // ── the status stream ──
  /* What the server is doing, while the reader waits for it. The player works
     without it; the controller ignores any event that is not about the
     revision and passage it is waiting for. */
  function watchStatus() {
    const article = state.current;
    if (DEMO || !article || typeof EventSource === 'undefined') return;
    if (narration.status?.articleId === article.id) return;
    closeStatus();
    try {
      const stream = new EventSource(appUrl(`/api/articles/${article.id}/narration/status`));
      stream.onmessage = (event) => {
        try { player.stage(JSON.parse(event.data)); } catch { /* a frame we cannot read is not worth a stack */ }
      };
      stream.onerror = () => {};
      narration.status = { stream, articleId: article.id };
    } catch { /* no stream: the labels the player makes up still show */ }
  }

  function closeStatus() {
    narration.status?.stream.close();
    narration.status = null;
  }

  // ── follow along ──
  function highlight(segment, { follow = false } = {}) {
    for (const node of narration.lit) node.classList.remove('is-narrating');
    narration.lit = [];
    if (!segment) return;
    const node = narration.nodes[segment.dom_index];
    if (!node) return;
    node.classList.add('is-narrating');
    narration.lit = [node];
    // a reader who just scrolled somewhere is reading there; do not pull them back
    if (!follow || !narration.follow || Date.now() - narration.lastScrollAt < 4000) return;
    const box = node.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    if (box.top < frame.top + 80 || box.bottom > frame.bottom - 140) {
      scroller.scrollTo({ top: scroller.scrollTop + box.top - frame.top - frame.height * 0.32, behavior: 'smooth' });
    }
  }

  /* The visible line counts seconds while waiting; the line read out by a
     screen reader changes only when what is happening changes. */
  function setNow(message, kind) {
    const now = $('pl-now');
    if (now.textContent !== message) now.textContent = message;
    now.classList.toggle('error', kind === 'error');
    const spoken = message.replace(/ · \d+s…$/, '…');
    if ($('pl-live').textContent !== spoken) $('pl-live').textContent = spoken;
  }

  function clock(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // ── the panel: voice, follow along, offline ──
  function openPanel({ picking = false } = {}) {
    const panel = $('pl-panel');
    panel.hidden = false;
    $('pl-more').setAttribute('aria-expanded', 'true');
    renderPanel({ picking });
  }

  function renderPanel({ picking = false } = {}) {
    const panel = $('pl-panel');
    const view = narration.view || player.view();
    const voice = view.voice;
    const locked = voice?.source === 'locked';
    const offline = narration.offline;
    const download = narration.download?.articleId === state.current?.id ? narration.download : null;
    const keepPicker = !picking && panel.querySelector('#pl-voices:not([hidden])');
    if (keepPicker) return;   // a list the reader is searching is not redrawn under them

    panel.innerHTML = `
      <div class="pl-cast">
        <span class="pl-cast-name">${esc(voice?.name || 'voice chosen when you press play')}</span>
        ${voice?.source ? `<span class="pl-chip pl-chip-quiet">${esc(SOURCE_LABEL[voice.source] || voice.source)}</span>` : ''}
      </div>
      <div class="pl-actions">
        ${locked ? '' : '<button class="linklike" id="pl-pick" type="button">choose a voice for this article</button>'}
        ${voice?.source === 'article' ? '<button class="linklike" id="pl-default" type="button">use default</button>' : ''}
      </div>
      <div id="pl-voices" class="voice-picker" hidden></div>
      <div class="pl-toggles">
        <label><input type="checkbox" id="pl-follow" ${narration.follow ? 'checked' : ''}> follow along</label>
      </div>
      <div class="pl-offline" id="pl-offline">${offlineLine(offline, download)}</div>`;

    panel.querySelector('#pl-follow').addEventListener('change', (ev) => { narration.follow = ev.target.checked; });
    panel.querySelector('#pl-pick')?.addEventListener('click', () => toggleArticlePicker());
    panel.querySelector('#pl-default')?.addEventListener('click', () => { player.unlock(); player.setVoice(null); });
    bindOffline(panel);
    if (picking && !locked) toggleArticlePicker(true);
  }

  function toggleArticlePicker(open) {
    const mount = $('pl-voices');
    if (!mount) return;
    mount.hidden = open === undefined ? !mount.hidden : !open;
    if (mount.hidden) { stopSample(); return; }
    renderVoicePicker(mount, {
      articleId: state.current?.id,
      language: player.manifest?.language || 'en',
      current: narration.view?.voice?.id,
      onPick: (voice) => {
        mount.hidden = true;
        stopSample();
        // choosing the voice already reading is not a change
        if (voice.id === narration.view?.voice?.id && narration.view?.voice?.source === 'article') return;
        player.unlock();
        showPlayer();
        player.setVoice({ id: voice.id, name: voice.title });
      },
    });
  }

  function offlineLine(offline, download) {
    if (!audioStore) return '';
    if (download) {
      return `<span>downloading ${download.done}/${download.total || '…'}</span>
        <button class="linklike" type="button" data-offline="cancel">cancel</button>`;
    }
    if (offline?.ready) {
      return `<span>available offline</span> <button class="linklike" type="button" data-offline="remove">remove download</button>`;
    }
    const partial = offline?.local ? ` <span class="pl-chip pl-chip-quiet">${offline.local}/${offline.total} here</span>` : '';
    const note = narration.offlineError ? ` <span class="pl-error">${esc(narration.offlineError)}</span>` : '';
    return `<button class="linklike" type="button" data-offline="download">download for offline listening</button>${partial}${note}`
      + (audioStore.limited ? ' <span class="pl-chip pl-chip-quiet">this browser is not keeping audio</span>' : '');
  }

  function bindOffline(panel) {
    panel.querySelector('#pl-offline').addEventListener('click', (ev) => {
      const action = ev.target.closest('[data-offline]')?.dataset.offline;
      if (action === 'download') downloadForOffline();
      if (action === 'cancel') narration.download?.abort.abort();
      if (action === 'remove' && state.current) {
        audioStore.remove(state.current.id).then(() => refreshOffline(player.manifest));
      }
    });
  }

  /* Every passage and the manifest, one passage at a time at background
     priority, so listening meanwhile is never behind it. Stopping halfway
     keeps what arrived; starting again fetches only what is missing. */
  async function downloadForOffline() {
    const article = state.current;
    if (!article || narration.download) return;
    narration.offlineError = null;
    const abort = new AbortController();
    narration.download = { articleId: article.id, abort, done: 0, total: 0 };
    renderPanel();
    try {
      const manifest = player.manifest?.article_id === article.id ? player.manifest
        : await fetchJson(`/api/articles/${article.id}/narration`, { method: 'POST', body: { start: { mode: 'resume' } }, signal: abort.signal });
      narration.download.total = manifest.segments.length;
      await audioStore.downloadAll(manifest, {
        signal: abort.signal,
        onProgress: ({ done, total }) => {
          if (narration.download) Object.assign(narration.download, { done, total });
          if (state.current?.id === article.id && !$('pl-panel').hidden) renderPanel();
        },
      });
      await refreshOffline(manifest);
    } catch (error) {
      if (error.name !== 'AbortError') narration.offlineError = error.message;
    } finally {
      narration.download = null;
      if (state.current?.id === article.id && !$('pl-panel').hidden) renderPanel();
    }
  }

  async function refreshOffline(manifest) {
    if (!audioStore || !state.current) return;
    const id = state.current.id;
    const target = manifest?.article_id === id ? manifest : await audioStore.loadManifest(id);
    const status = target ? await audioStore.status(target) : null;
    if (state.current?.id !== id) return;
    narration.offline = status;
    if (!$('pl-panel').hidden) renderPanel();
  }

  // ── choosing voices ──
  /* One picker, used for the library default in settings and for a single
     article in the player. The whole catalogue is searchable; the saved
     choices are listed even when the catalogue is not available. */
  const sample = { audio: null, url: null, button: null };

  async function renderVoicePicker(mount, { articleId = null, language = 'en', current = null, automatic = false, onPick }) {
    mount.innerHTML = '<p class="voice-note">loading voices…</p>';
    let listing;
    try {
      listing = await fetchJson(`/api/narration/voices?lang=${encodeURIComponent(language)}${articleId ? `&for=${encodeURIComponent(articleId)}` : ''}`);
    } catch (error) {
      listing = { voices: [], saved: [], error_code: 'network', error: error.message };
    }
    const saved = (listing.saved || []).map(voice => ({ ...voice, description: '', tags: [] }));
    const all = [...saved.filter(voice => !voice.listed), ...listing.voices];
    let shown = 60;

    mount.innerHTML = `
      <input type="search" class="voice-search" placeholder="search voices" aria-label="Search voices">
      <p class="voice-note" hidden></p>
      <div class="voice-list" role="listbox" aria-label="Voices"></div>`;
    const search = mount.querySelector('.voice-search');
    const note = mount.querySelector('.voice-note');
    const listEl = mount.querySelector('.voice-list');
    const problems = [];
    if (listing.error_code && listing.error_code !== 'partial') problems.push('the voice catalogue is unavailable right now');
    if (listing.error_code === 'partial') problems.push('part of the voice catalogue did not load');
    if (listing.refreshing && !listing.voices.length) problems.push('the voice catalogue is still loading');
    note.hidden = !problems.length;
    note.textContent = problems.join('; ');

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const matches = all.filter(voice => !q || `${voice.title} ${(voice.tags || []).join(' ')} ${voice.description || ''}`.toLowerCase().includes(q));
      const rows = [];
      if (automatic && !q) rows.push(voiceRow({ id: '', title: 'Automatic', tags: ['picked per article'] }, current === null));
      for (const voice of matches.slice(0, shown)) rows.push(voiceRow(voice, voice.id === current));
      if (matches.length > shown) rows.push(`<button type="button" class="linklike voice-more">show ${Math.min(60, matches.length - shown)} more of ${matches.length - shown}</button>`);
      if (!rows.length) rows.push('<p class="voice-note">no voices match</p>');
      listEl.innerHTML = rows.join('');
    };
    draw();
    search.addEventListener('input', () => { shown = 60; draw(); });
    listEl.addEventListener('click', (ev) => {
      if (ev.target.closest('.voice-more')) { shown += 60; draw(); return; }
      const sampleButton = ev.target.closest('[data-sample]');
      if (sampleButton) return playSample(sampleButton);
      const row = ev.target.closest('[data-voice-pick]');
      if (!row) return;
      const voice = row.dataset.voicePick ? all.find(one => one.id === row.dataset.voicePick) : null;
      onPick(voice ? { id: voice.id, title: voice.title } : null);
    });
  }

  function voiceRow(voice, chosen) {
    const tags = (voice.tags || []).slice(0, 4).join(' · ');
    return `<div class="voice-row${chosen ? ' is-chosen' : ''}">
      <button type="button" class="voice-pick" data-voice-pick="${esc(voice.id)}" role="option" aria-selected="${chosen}"
        title="${esc(voice.description || '')}">
        <span class="voice-name">${esc(voice.title)}${voice.role ? ` <span class="voice-role">${esc(voice.role === 'default' ? 'default' : voice.role === 'article' ? 'this article' : voice.role)}</span>` : ''}</span>
        ${tags ? `<span class="voice-tags">${esc(tags)}</span>` : ''}
      </button>
      ${voice.sample ? `<button type="button" class="voice-sample" data-sample="${esc(voice.sample)}" aria-label="Play a sample of ${esc(voice.title)}">▶</button>` : ''}
    </div>`;
  }

  /* A sample is a preview: it never changes a choice, and only one plays at a
     time. It is fetched without cookies or a referrer, straight from the
     provider; if the provider will not allow that, the button says so. */
  async function playSample(button) {
    const url = button.dataset.sample;
    const same = sample.button === button;
    stopSample();
    if (same) return;
    if (!/^https:\/\//i.test(url)) return;
    sample.button = button;
    button.textContent = '…';
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
      if (!res.ok) throw new Error('unavailable');
      const blob = await res.blob();
      if (sample.button !== button) return;
      sample.url = URL.createObjectURL(blob);
      sample.audio = new Audio(sample.url);
      sample.audio.addEventListener('ended', stopSample);
      await sample.audio.play();
      button.textContent = '■';
      button.setAttribute('aria-label', 'Stop the sample');
    } catch {
      if (sample.button === button) {
        stopSample();
        button.textContent = 'sample unavailable';
        button.disabled = true;
      }
    }
  }

  function stopSample() {
    if (sample.audio) { sample.audio.pause(); sample.audio.src = ''; }
    if (sample.url) URL.revokeObjectURL(sample.url);
    if (sample.button && !sample.button.disabled) {
      sample.button.textContent = '▶';
      sample.button.setAttribute('aria-label', 'Play a sample');
    }
    Object.assign(sample, { audio: null, url: null, button: null });
  }

  // ── skipping and including paragraphs ──
  /* A reader's mark on one block, saved through the ordinary edit path. The
     block stays on the page; only what is read aloud changes. Playback picks
     up at the paragraph it was on, in the script the mark produced. */
  async function setSpeechMark(node, mark) {
    if (!state.current || !narration.map) return;
    const block = blockFor(node);
    const owner = block && narration.nodes[block.dom_index];
    if (!owner) return;
    const before = owner.getAttribute('data-particle-speech');
    if (mark) owner.setAttribute('data-particle-speech', mark);
    else owner.removeAttribute('data-particle-speech');
    try {
      const updated = await api.patch(state.current.id, { content_html: storedHtml($('a-body').cloneNode(true)) });
      state.current = { ...state.current, ...updated };
      // audio this browser kept was made from the text before the mark
      audioStore?.remove(updated.id).catch(() => {});
      await loadBlockMap(state.current, { force: true });
      player.reload();
    } catch (error) {
      if (before) owner.setAttribute('data-particle-speech', before);
      else owner.removeAttribute('data-particle-speech');
      setNow(`could not save that: ${error.message}`, 'error');
    }
  }

  // ── the selection popover ──
  /* Text selection keeps its ordinary meaning: copy, look up, share. When a
     selection sits inside the article, two narration actions sit beside it —
     start here, and skip or read this paragraph — reachable by touch, mouse
     and keyboard alike. Plain taps on prose do nothing new. */
  const speechPop = $('speech-pop');
  let popTarget = null;

  function placeSpeechPop() {
    if (DEMO || !state.narration || trim.on || reader.hidden) return hideSpeechPop();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return hideSpeechPop();
    const range = selection.getRangeAt(0);
    if (!$('a-body').contains(range.startContainer)) return hideSpeechPop();
    popTarget = range.startContainer;
    const block = blockFor(popTarget);
    const reason = block?.skip_reason;
    const markable = !reason || reason === 'manual' || block?.inferred;
    speechPop.innerHTML = `
      ${reason ? `<span class="speech-why">not read aloud: ${esc(SKIP_LABEL[reason] || reason)}</span>` : ''}
      <button type="button" data-speech="listen">${reason ? 'listen from the next paragraph' : 'listen from here'}</button>
      ${narration.map && markable
        ? `<button type="button" data-speech="${reason ? 'include' : 'exclude'}">${reason ? 'read this aloud' : 'skip when reading aloud'}</button>`
        : ''}`;
    speechPop.hidden = false;
    const box = range.getBoundingClientRect();
    const size = speechPop.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left + box.width / 2 - size.width / 2), window.innerWidth - size.width - 8);
    // below the selection: phones put their own menu above it
    const below = box.bottom + 10;
    const top = below + size.height > window.innerHeight - 8 ? Math.max(8, box.top - size.height - 10) : below;
    speechPop.style.left = `${Math.round(left)}px`;
    speechPop.style.top = `${Math.round(top)}px`;
  }

  function hideSpeechPop() {
    speechPop.hidden = true;
    popTarget = null;
  }

  let popTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(popTimer);
    popTimer = setTimeout(placeSpeechPop, 220);
  });
  speechPop.addEventListener('pointerdown', ev => ev.preventDefault());   // keep the selection while pressing
  speechPop.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-speech]')?.dataset.speech;
    const target = popTarget;
    if (!action || !target) return;
    hideSpeechPop();
    if (action === 'listen') listenFrom(target);
    if (action === 'exclude') setSpeechMark(target, 'exclude');
    if (action === 'include') {
      const block = blockFor(target);
      setSpeechMark(target, block?.skip_reason === 'manual' ? null : 'include');
    }
    window.getSelection()?.removeAllRanges();
  });
  scroller.addEventListener('scroll', () => {
    narration.lastScrollAt = Date.now();
    if (!speechPop.hidden) placeSpeechPop();
  }, { passive: true });

  // ── lifecycle ──
  /** A reader opened an article: nothing plays, but Resume knows where it would. */
  function narrationOpen(article) {
    stopSample();
    hidePlayer();
    hideSpeechPop();
    narration.map = null;
    narration.mapReady = null;
    narration.nodes = [];
    narration.offline = null;
    narration.offlineError = null;
    player.attach(article, { bookmark: article.audio_bookmark || null, version: article.audio_bookmark_version || 0 });
    renderListenRow(player.view());
    if (state.narration && !DEMO) {
      loadBlockMap(article);
      refreshOffline(null);
    }
  }

  /** Leaving the article: playback ends and its place is saved. */
  function narrationClose() {
    stopSample();
    hideSpeechPop();
    player.detach();
    hidePlayer();
    for (const node of narration.lit) node.classList.remove('is-narrating');
    narration.lit = [];
  }

  function stopNarration() {
    player.close();
    hidePlayer();
  }

  function updateMediaSession(view) {
    if (!('mediaSession' in navigator) || !state.current) return;
    const article = state.current;
    try {
      if (narration.sessionFor !== article.id) {
        narration.sessionFor = article.id;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: article.title || 'particle',
          artist: article.byline || article.site_name || 'particle',
          album: article.site_name || 'particle',
          artwork: article.lead_image
            ? [{ src: appUrl(`/api/image?url=${encodeURIComponent(article.lead_image)}`), sizes: '512x512' }]
            : [],
        });
      }
      navigator.mediaSession.playbackState = view.state === 'playing' ? 'playing' : view.ready ? 'paused' : 'none';
      // a real scrub bar on the lock screen, over the whole article
      if (view.total > 0) {
        navigator.mediaSession.setPositionState({
          duration: view.total,
          position: Math.min(view.position, view.total),
          playbackRate: narration.rate,
        });
      }
    } catch { /* metadata is a nicety */ }
  }

  if ('mediaSession' in navigator) {
    const bind = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    bind('play', () => { showPlayer(); player.resume(); });
    bind('pause', () => player.pause());
    bind('seekbackward', () => player.skip(-SKIP_SECONDS));
    bind('seekforward', () => player.skip(SKIP_SECONDS));
    bind('seekto', (details) => { if (Number.isFinite(details?.seekTime)) player.seekTo(details.seekTime); });
    bind('nexttrack', () => player.seekSegment(player.view().seq + 1));
    bind('previoustrack', () => player.seekSegment(Math.max(0, player.view().seq - 1)));
    bind('stop', () => stopNarration());
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  $('listen-btn').addEventListener('click', primaryAction);
  $('a-listen-go').addEventListener('click', primaryAction);
  $('a-listen-over').addEventListener('click', startOver);
  $('pl-play').addEventListener('click', () => { player.unlock(); player.toggle(); });
  $('pl-back').addEventListener('click', () => player.skip(-SKIP_SECONDS));
  $('pl-fwd').addEventListener('click', () => player.skip(SKIP_SECONDS));
  $('pl-close').addEventListener('click', stopNarration);
  $('pl-rate').addEventListener('click', () => {
    narration.rate = RATES[(RATES.indexOf(narration.rate) + 1) % RATES.length] || 1;
    player.setRate(narration.rate);
  });
  $('pl-more').addEventListener('click', () => {
    if ($('pl-panel').hidden) return openPanel();
    $('pl-panel').hidden = true;
    stopSample();
    $('pl-more').setAttribute('aria-expanded', 'false');
  });
  $('pl-seek').addEventListener('input', (ev) => {
    const total = narration.view?.total || 0;
    $('pl-time').textContent = `${clock((Number(ev.target.value) / 1000) * total)} / ${clock(total)}`;
  });
  $('pl-seek').addEventListener('change', (ev) => {
    const total = narration.view?.total || 0;
    player.seekTo((Number(ev.target.value) / 1000) * total);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) player.flush();
    else player.wake();
  });

  // ── settings ─────────────────────────────────────────────────────────────
  // Display choices, the lists, and the one destructive action, in one sheet
  // reached from the library. Every control writes through immediately; there
  // is no save button and nothing to lose by closing.
  const sheet = $('settings');
  let lastFocus = null;

  function openSettings() {
    lastFocus = document.activeElement;
    closeMenu();
    sheet.hidden = false;
    syncSettings();
    renderSettingsLists();
    renderTagging();
    renderNarrationSettings();
    sheet.querySelector('.sheet-x').focus();
  }

  function closeSettings() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    stopSample();
    $('set-reset-confirm').value = '';
    $('set-reset').disabled = true;
    $('set-reset-status').hidden = true;
    $('set-list-error').hidden = true;
    lastFocus?.focus?.();
  }

  $('settings-btn').addEventListener('click', openSettings);
  sheet.addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) closeSettings(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !sheet.hidden) closeSettings();
  });

  /** Paint every control from the prefs it reflects. */
  function syncSettings() {
    pickSeg($('set-theme'), prefs.theme);
    pickSeg($('set-face'), prefs.face);
    pickSeg($('set-reads'), prefs.readsInAll ? '1' : '0');
    const size = $('set-size');
    size.min = SIZE_MIN; size.max = SIZE_MAX; size.step = SIZE_STEP;
    size.value = prefs.size;
    for (const swatch of $('set-accent').children) {
      swatch.setAttribute('aria-checked', String(swatch.dataset.value === prefs.accent));
    }
  }

  function pickSeg(group, value) {
    for (const button of group.children) {
      button.setAttribute('aria-checked', String(button.dataset.value === String(value)));
    }
  }

  function onSeg(group, handler) {
    group.addEventListener('click', (ev) => {
      const button = ev.target.closest('button[data-value]');
      if (!button) return;
      handler(button.dataset.value);
      syncSettings();
    });
  }

  onSeg($('set-theme'), value => { prefs.theme = value; });
  onSeg($('set-face'), value => { prefs.face = value; });
  onSeg($('set-reads'), (value) => {
    prefs.readsInAll = value === '1';
    // the retired tab may be the one being shown; renderTabs falls back to all
    refresh();
  });
  $('set-size').addEventListener('input', (ev) => { prefs.size = parseFloat(ev.target.value); });

  $('set-accent').innerHTML = ACCENTS.map(accent => `
    <button type="button" class="swatch" role="radio" data-value="${accent.id}"
            title="${esc(accent.label)}" aria-label="${esc(accent.label)}"
            style="background:${accent.swatch}"></button>`).join('');
  $('set-accent').addEventListener('click', (ev) => {
    const swatch = ev.target.closest('[data-value]');
    if (!swatch) return;
    prefs.accent = swatch.dataset.value;
    syncSettings();
  });

  // ── narration settings ───────────────────────────────────────────────────
  /* The library's default voice, shared by every device that opens it. A
     change applies to the next time anything is played; whatever is playing
     now carries on in the voice it started with. */
  const voiceSettings = { value: null, open: false };

  async function renderNarrationSettings() {
    const group = $('set-narration');
    if (DEMO) { group.hidden = true; return; }
    group.hidden = false;
    const now = $('set-voice-now');
    const note = $('set-voice-note');
    const choose = $('set-voice-choose');
    if (!state.narration) {
      now.textContent = 'off';
      note.textContent = 'narration is not set up on this install';
      note.hidden = false;
      choose.hidden = true;
      $('set-voice-picker').hidden = true;
      return;
    }
    try {
      voiceSettings.value = await fetchJson('/api/narration/settings');
    } catch (error) {
      now.textContent = 'unavailable';
      note.textContent = error.message;
      note.hidden = false;
      choose.hidden = true;
      return;
    }
    const settings = voiceSettings.value;
    if (settings.locked) {
      now.textContent = settings.locked_voice?.name || 'locked voice';
      note.textContent = 'this install reads every article in this voice';
      note.hidden = false;
      choose.hidden = true;
      $('set-voice-picker').hidden = true;
      return;
    }
    now.textContent = settings.default_voice_id ? (settings.default_voice_name || 'chosen voice') : 'automatic';
    note.hidden = true;
    choose.hidden = false;
    choose.textContent = voiceSettings.open ? 'done' : 'change';
  }

  $('set-voice-choose').addEventListener('click', () => {
    const mount = $('set-voice-picker');
    voiceSettings.open = mount.hidden;
    mount.hidden = !voiceSettings.open;
    $('set-voice-choose').textContent = voiceSettings.open ? 'done' : 'change';
    if (!voiceSettings.open) { stopSample(); return; }
    renderVoicePicker(mount, {
      current: voiceSettings.value?.default_voice_id ?? null,
      automatic: true,
      onPick: voice => saveDefaultVoice(voice),
    });
  });

  async function saveDefaultVoice(voice) {
    const note = $('set-voice-note');
    try {
      voiceSettings.value = await fetchJson('/api/narration/settings', {
        method: 'PATCH',
        body: {
          default_voice_id: voice?.id ?? null,
          default_voice_name: voice?.title ?? null,
          expected_version: voiceSettings.value?.version ?? 0,
        },
      });
      note.hidden = true;
    } catch (error) {
      note.hidden = false;
      note.textContent = error.data?.code === 'settings_conflict'
        ? 'the default was changed on another device — showing that one now'
        : `could not save: ${error.message}`;
    }
    stopSample();
    $('set-voice-picker').hidden = true;
    voiceSettings.open = false;
    const message = note.hidden ? '' : note.textContent;
    await renderNarrationSettings();
    if (message) { note.hidden = false; note.textContent = message; }
  }

  /** A library reset: the audio and places this browser kept go too. */
  function forgetNarrationHere() {
    player.detach();
    audioStore?.clear().catch(() => {});
    try {
      const prefix = `p.place:${location.origin}${BASE}:`;
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    } catch { /* storage refused */ }
  }

  // ── tagging ──────────────────────────────────────────────────────────────
  // Tags arrive on save, from the server's LLM pass. Articles saved before a key
  // was set, or while the provider was down, never get them, and until now the
  // only way to tell "no key" from "key, but failing" was the server log. This
  // says which it is, and offers to fill the holes. Demo mode has no server
  // library and no key, so the section stays hidden there. A run outlives the
  // sheet: polling carries on behind a closed sheet so the library repaints
  // with the new tags when it finishes.
  let taggingTimer = null;

  function stopTaggingWatch() {
    clearTimeout(taggingTimer);
    taggingTimer = null;
  }

  async function renderTagging() {
    if (DEMO) return;
    const section = $('set-tagging');
    section.hidden = false;
    try {
      paintTagging(await api.tagging());
    } catch (e) {
      paintTagging({ enabled: false, error: e.message });
    }
  }

  function paintTagging(status) {
    const line = $('set-tag-state'), note = $('set-tag-note'), run = $('set-tag-run');
    line.classList.toggle('is-off', !status.enabled);
    line.classList.toggle('is-error', Boolean(status.error) && !status.running);
    run.hidden = !status.enabled;
    run.disabled = status.running || !status.untagged;
    stopTaggingWatch();

    if (!status.enabled) {
      line.textContent = 'off';
      note.textContent = 'Set LLM_API_KEY on the server and restart to tag articles as they are saved.';
      return;
    }
    if (status.running) {
      const reached = status.done + status.failed;
      line.textContent = `tagging ${reached + 1 > status.total ? status.total : reached + 1} of ${status.total}…`;
      note.textContent = status.failed ? `${status.failed} failed so far${status.error ? `: ${status.error}` : ''}` : '';
      taggingTimer = setTimeout(async () => {
        try { paintTagging(await api.tagging()); } catch { /* the next open will ask again */ }
        // a finished run has changed rows the library is showing
        if (!taggingTimer) refresh();
      }, 1500);
      return;
    }
    line.textContent = status.untagged
      ? `${status.untagged} article${status.untagged === 1 ? '' : 's'} untagged`
      : 'every article is tagged';
    if (status.finished_at && status.total) {
      note.textContent = `tagged ${status.done} of ${status.total}`
        + (status.failed ? `, ${status.failed} failed${status.error ? `: ${status.error}` : ''}` : '.');
    } else if (status.error) note.textContent = `last attempt failed: ${status.error}`;
    else note.textContent = '';
  }

  $('set-tag-run').addEventListener('click', async () => {
    $('set-tag-run').disabled = true;
    try {
      paintTagging(await api.tagUntagged());
    } catch (e) {
      paintTagging({ enabled: true, untagged: 0, error: e.message });
    }
  });

  // ── lists ────────────────────────────────────────────────────────────────
  async function renderSettingsLists() {
    state.collections = await loadCollections();
    const mount = $('set-lists');
    mount.innerHTML = state.collections.map(list => `
      <li class="set-list" data-id="${list.id}">
        <input class="set-list-name" value="${esc(list.name)}" maxlength="40" aria-label="List name">
        <span class="set-list-count">${list.count || 0}</span>
        <button class="set-list-x" type="button" title="delete list" aria-label="Delete ${esc(list.name)}">&times;</button>
      </li>`).join('');
    renderTabs();
  }

  function listError(message) {
    const box = $('set-list-error');
    box.hidden = !message;
    box.textContent = message || '';
  }

  $('set-newlist').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('set-listname');
    const name = input.value.trim();
    if (!name) return;
    try {
      await api.createCollection(name);
      input.value = '';
      listError('');
      await renderSettingsLists();
    } catch (e) {
      listError(e.message);
    }
  });

  $('set-lists').addEventListener('click', async (ev) => {
    const row = ev.target.closest('.set-list');
    if (!row || !ev.target.closest('.set-list-x')) return;
    const name = row.querySelector('.set-list-name').value;
    if (!confirm(`Delete the list “${name}”?\n\nThe articles in it stay in your library.`)) return;
    await api.deleteCollection(Number(row.dataset.id));
    await renderSettingsLists();
    refresh();
  });

  $('set-lists').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('.set-list-name')) ev.target.blur();
  });

  $('set-lists').addEventListener('focusout', async (ev) => {
    if (!ev.target.matches('.set-list-name')) return;
    const row = ev.target.closest('.set-list');
    const id = Number(row.dataset.id);
    const list = state.collections.find(item => item.id === id);
    const name = ev.target.value.trim();
    if (!list || !name || name === list.name) { ev.target.value = list?.name || name; return; }
    try {
      await api.renameCollection(id, name);
      listError('');
      await renderSettingsLists();
      refresh();
    } catch (e) {
      listError(e.message);
      ev.target.value = list.name;
    }
  });

  // ── reset ────────────────────────────────────────────────────────────────
  $('set-reset-confirm').addEventListener('input', (ev) => {
    $('set-reset').disabled = ev.target.value.trim().toUpperCase() !== 'DELETE';
  });

  $('set-reset').addEventListener('click', async () => {
    const includeLists = $('set-reset-lists').checked;
    if (!confirm(`Delete every saved article${includeLists ? ' and every list' : ''}?\n\n`
      + 'This is permanent. Nothing is exported and nothing can be recovered.')) return;
    const status = $('set-reset-status');
    $('set-reset').disabled = true;
    status.hidden = false;
    status.textContent = 'deleting…';
    try {
      const result = await api.removeAll({ includeLists });
      if (!DEMO) forgetNarrationHere();
      status.textContent = `deleted ${result?.deleted ?? 'every'} article${result?.deleted === 1 ? '' : 's'}.`;
      $('set-reset-confirm').value = '';
      $('set-reset-lists').checked = false;
      await renderSettingsLists();
      go('/');
    } catch (e) {
      status.textContent = `reset failed: ${e.message}`;
      $('set-reset').disabled = false;
    }
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  // storage can be refused (private windows, full quota); a preference is never worth an exception
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* not kept */ }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
  function fmtDate(s) {
    const d = new Date(s);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  function relDate(s) {
    const d = new Date(s + (s.endsWith('Z') ? '' : 'Z'));
    if (isNaN(d)) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function appUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${BASE}${path.startsWith('/') ? path : `/${path}`}` || '/';
  }

  function appHome() {
    return `${BASE}/` || '/';
  }

  // Narration needs a text-to-speech key on the server; without one the reader
  // never offers it.
  fetchJson('/api/health')
    .then((health) => {
      $('set-version').textContent = `particle ${health.version || ''}`.trim();
      if (DEMO) return;
      state.narration = Boolean(health.narration);
      if (state.narration && !reader.hidden && state.current) {
        renderListenRow(player.view());
        loadBlockMap(state.current);
      }
      if (!sheet.hidden) renderNarrationSettings();
    })
    .catch(() => {});

  // ── pwa ──────────────────────────────────────────────────────────────────
  if (!DEMO && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register(appUrl('/sw.js'), { scope: appHome() }).catch(() => {});
  }
  // handle ?add=<url> (PWA share / bookmarklet entry)
  const entry = new URLSearchParams(location.search);
  const addParam = entry.get('add');
  if (addParam) {
    history.replaceState({}, '', appHome());
    urlInput.value = addParam;
    setTimeout(() => form.requestSubmit(), 100);
  }

  /* A screenshot shared in from another app. The OS hands the file to the
     service worker, never to the page, so the worker parks it in a cache and
     sends us here to collect it. */
  const SHARED_SHOT = 'particle-shared-v1';
  if (entry.get('shared') === 'screenshot') {
    history.replaceState({}, '', appHome());
    caches.open(SHARED_SHOT)
      .then(async (cache) => {
        const key = appUrl('/shared-screenshot');
        const held = await cache.match(key);
        // Read once and gone, whether or not it survives the next line.
        await cache.delete(key);
        if (!held) throw new Error('that shared screenshot went missing');
        const type = held.headers.get('content-type') || 'image/png';
        readShot(new File([await held.blob()], 'shared', { type }));
      })
      .catch((error) => {
        saveStatus.textContent = error.message;
        saveStatus.classList.add('error');
      });
  } else if ('caches' in window) {
    /* A share whose app was closed before it was collected leaves someone's
       screenshot sitting in this browser's cache. Nothing but the redirect
       immediately after a share has any business reading it, so any copy still
       here on an ordinary load is stale and goes. */
    caches.delete(SHARED_SHOT).catch(() => {});
  }

  const bookmarkTarget = `${location.origin}${appHome()}?add=`;
  $('bookmarklet').href = `javascript:location.href='${bookmarkTarget}'+encodeURIComponent(location.href)`;

  if (DEMO) {
    $('demo-strip').hidden = false;
    $('demo-reader-note').hidden = false;
    $('empty-copy').innerHTML = `paste a url above, or <a href="https://github.com/crnst8/particle">self-host particle</a> for an unlimited library`;
    $('copy-demo-command').addEventListener('click', async () => {
      const command = $('demo-nudge').querySelector('code').textContent;
      try {
        await navigator.clipboard.writeText(command);
        $('copy-demo-command').textContent = 'copied';
      } catch {
        $('copy-demo-command').textContent = 'select it';
      }
    });
  }

  route();
})();
