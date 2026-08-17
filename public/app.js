/* particle — library + reader */
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
    current: null,       // article open in reader
    progressTimer: null,
  };

  // ── prefs ────────────────────────────────────────────────────────────────
  const prefs = {
    get theme() { return localStorage.getItem('p.theme') || 'light'; },
    set theme(v) { localStorage.setItem('p.theme', v); applyPrefs(); },
    get size() { return parseFloat(localStorage.getItem('p.size') || '1.125'); },
    set size(v) { localStorage.setItem('p.size', v); applyPrefs(); },
    get face() { return localStorage.getItem('p.face') || 'serif'; },
    set face(v) { localStorage.setItem('p.face', v); applyPrefs(); },
  };
  function applyPrefs() {
    document.documentElement.dataset.theme = prefs.theme === 'light' ? '' : prefs.theme;
    document.documentElement.style.setProperty('--reader-size', prefs.size + 'rem');
    document.documentElement.style.setProperty('--reader-font', prefs.face === 'serif' ? 'var(--serif)' : 'var(--sans)');
  }
  applyPrefs();

  // ── api ──────────────────────────────────────────────────────────────────
  const serverStore = {
    list: (q, filter) => fetchJson(`/api/articles?filter=${filter}&q=${encodeURIComponent(q || '')}`),
    get: (id) => fetchJson(`/api/articles/${id}`),
    save: (url) => fetchJson('/api/articles', { method: 'POST', body: { url } }),
    patch: (id, body) => fetchJson(`/api/articles/${id}`, { method: 'PATCH', body }),
    refetch: (id) => fetchJson(`/api/articles/${id}/refetch`, { method: 'POST' }),
    remove: (id) => fetchJson(`/api/articles/${id}`, { method: 'DELETE' }),
  };
  const api = DEMO
    ? window.createParticleLocalStore({ fetchJson, maxArticles: DEMO_MAX })
    : serverStore;

  async function fetchJson(url, { method = 'GET', body } = {}) {
    const res = await fetch(appUrl(url), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── routing ──────────────────────────────────────────────────────────────
  function route() {
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
    reader.hidden = true;
    library.hidden = false;
    progressBar.style.width = '0';
    document.title = 'particle';
    await refresh();
  }

  async function refresh() {
    try {
      state.articles = await api.list(state.q, state.filter);
      renderList();
    } catch (e) {
      saveStatus.textContent = 'library failed to load: ' + e.message;
      saveStatus.classList.add('error');
    }
  }

  function renderList() {
    list.innerHTML = '';
    empty.hidden = state.articles.length > 0;
    for (const a of state.articles) list.appendChild(row(a));
  }

  function row(a) {
    const li = document.createElement('li');
    li.className = 'article-row' + (a.read_at ? ' is-read' : '');
    li.tabIndex = 0;

    const mins = Math.max(1, Math.round((a.word_count || 0) / 230));
    const tags = (a.tags || []).join(', ');
    const flag = a.quality === 'partial' || a.quality === 'stub' ? '<span class="row-flag" title="extraction may be incomplete">&#9679; partial</span>' : '';

    li.innerHTML = `
      <div class="row-top">
        <span class="row-site">${esc(a.site_name || hostOf(a.url))}</span>
        ${flag}
        ${tags ? `<span class="row-tags">${esc(tags)}</span>` : ''}
      </div>
      <div class="row-title">${esc(a.title || a.url)}</div>
      ${a.excerpt ? `<div class="row-excerpt">${esc(a.excerpt)}</div>` : ''}
      <div class="row-bottom">
        <span>${mins} min</span>
        ${a.progress > 0.02 && a.progress < 0.97 ? `<span class="row-progress"><i style="width:${Math.round(a.progress * 100)}%"></i></span>` : ''}
        ${a.read_at ? '<span>read</span>' : ''}
        <span>${relDate(a.saved_at)}</span>
        <span class="row-actions">
          <button class="row-btn ${a.favorite ? 'on' : ''}" data-act="fav" title="favorite">${a.favorite ? '★' : '☆'}</button>
          <button class="row-btn ${a.archived ? 'on' : ''}" data-act="arch" title="${a.archived ? 'unarchive' : 'archive'}">↧</button>
        </span>
      </div>`;

    li.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (btn) {
        ev.stopPropagation();
        if (btn.dataset.act === 'fav') await api.patch(a.id, { favorite: !a.favorite });
        if (btn.dataset.act === 'arch') await api.patch(a.id, { archived: !a.archived });
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

  // ── save ─────────────────────────────────────────────────────────────────
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    saveBtn.disabled = true;
    saveStatus.classList.remove('error');
    saveStatus.textContent = 'extracting…';
    try {
      const a = await api.save(url);
      urlInput.value = '';
      saveStatus.textContent = a.duplicate ? 'already in your library'
        : a.evicted_title ? `saved “${a.title}” · removed oldest article “${a.evicted_title}”`
          : `saved “${a.title}”`;
      if (DEMO && !a.duplicate && !localStorage.getItem('p.demo.selfhost-nudge')) {
        $('demo-nudge').hidden = false;
        localStorage.setItem('p.demo.selfhost-nudge', '1');
      }
      setTimeout(() => { if (!saveStatus.classList.contains('error')) saveStatus.textContent = ''; }, 4000);
      refresh();
      // tags arrive async from enrichment; refresh once more
      if (!DEMO) setTimeout(refresh, 9000);
    } catch (e) {
      if (DEMO && e.message.startsWith('demo limit reached')) {
        saveStatus.innerHTML = `${esc(e.message)} · <a href="https://github.com/crnst8/particle">self-host without a limit →</a>`;
      } else {
        saveStatus.textContent = e.message;
      }
      saveStatus.classList.add('error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  tabs.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab');
    if (!tab) return;
    state.filter = tab.dataset.filter;
    localStorage.setItem('p.filter', state.filter);
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    refresh();
  });
  // restore filter tab
  tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.filter === state.filter));

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = search.value; refresh(); }, 250);
  });

  // ── reader ───────────────────────────────────────────────────────────────
  async function openReader(id) {
    let a;
    try { a = await api.get(id); }
    catch { return go('/'); }
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
    if (a.quality === 'partial' || a.quality === 'stub') {
      note.hidden = false;
      note.innerHTML = `this extraction may be incomplete${a.quality_note ? ' — ' + esc(a.quality_note) : ''}. <button id="note-refetch">try again</button>`;
      note.querySelector('#note-refetch').addEventListener('click', () => doRefetch(a.id));
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
  $('font-smaller').addEventListener('click', () => prefs.size = Math.max(0.85, +(prefs.size - 0.0625).toFixed(4)));
  $('font-larger').addEventListener('click', () => prefs.size = Math.min(1.6, +(prefs.size + 0.0625).toFixed(4)));
  $('font-face').addEventListener('click', () => prefs.face = prefs.face === 'serif' ? 'sans' : 'serif');
  $('theme-btn').addEventListener('click', () => {
    prefs.theme = { light: 'sepia', sepia: 'dark', dark: 'light' }[prefs.theme] || 'light';
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
  $('a-delete').addEventListener('click', async () => {
    if (!state.current) return;
    if (!confirm('Delete this article from your library?')) return;
    await api.remove(state.current.id);
    go('/');
  });

  // ── keyboard ─────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, textarea')) return;
    if (!reader.hidden) {
      if (ev.key === 'Escape') go('/');
      if (ev.key === 'f') $('fav-btn').click();
      if (ev.key === 'e') $('archive-btn').click();
      if (ev.key === 'j') scroller.scrollBy({ top: scroller.clientHeight * 0.85, behavior: 'smooth' });
      if (ev.key === 'k') scroller.scrollBy({ top: -scroller.clientHeight * 0.85, behavior: 'smooth' });
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
  });

  // ── helpers ──────────────────────────────────────────────────────────────
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

  // ── pwa ──────────────────────────────────────────────────────────────────
  if (!DEMO && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register(appUrl('/sw.js'), { scope: appHome() }).catch(() => {});
  }
  // handle ?add=<url> (PWA share / bookmarklet entry)
  const addParam = new URLSearchParams(location.search).get('add');
  if (addParam) {
    history.replaceState({}, '', appHome());
    urlInput.value = addParam;
    setTimeout(() => form.requestSubmit(), 100);
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
