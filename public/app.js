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
    narration: false,    // server has a text-to-speech key configured
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
    save: (url, source) => fetchJson('/api/articles', { method: 'POST', body: { url, ...sourceBody(source) } }),
    patch: (id, body) => fetchJson(`/api/articles/${id}`, { method: 'PATCH', body }),
    refetch: (id, source) => fetchJson(`/api/articles/${id}/refetch`, { method: 'POST', body: sourceBody(source) }),
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
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  // Page source this browser fetched (or the reader pasted) after clearing a captcha.
  function sourceBody(source) {
    return source?.html ? { html: source.html, source_url: source.sourceUrl || null } : {};
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
    resetNarration();
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
    $('rescue').hidden = true;
    try {
      const a = await api.save(url);
      urlInput.value = '';
      saveStatus.textContent = a.duplicate ? 'already in your library'
        : a.evicted_title ? `saved “${a.title}” · removed oldest article “${a.evicted_title}”`
          : `saved “${a.title}”`;
      if (a.challenge) {
        offerRescue({
          url: a.url, articleId: a.id, challenge: a.challenge, mount: $('rescue'),
          head: 'partial extraction. archive.today may hold a fuller snapshot.',
          onDone: saved => { saveStatus.textContent = `re-extracted “${saved.title}”`; refresh(); },
        });
      }
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
      // 428 means a snapshot is known and blocked, so go straight at it. Any other
      // failed extraction just gets the offer; the snapshot may not exist.
      const rescuable = e.status === 428 || e.status === 422;
      if (rescuable) {
        urlInput.value = '';
        const target = e.data?.challenge?.original_url || url;
        const onDone = saved => {
          saveStatus.classList.remove('error');
          saveStatus.textContent = `saved “${saved.title}” from archive.today`;
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
    resetNarration();
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
    if (a.quality === 'partial' || a.quality === 'stub') {
      note.hidden = false;
      note.innerHTML = `this extraction may be incomplete${a.quality_note ? ' — ' + esc(a.quality_note) : ''}. <button id="note-refetch">try again</button> <button id="note-archive">try archive.today</button>`;
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
    $('listen-btn').hidden = !state.narration;
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
      const listening = !$('player').hidden;
      if (ev.key === 'Escape') go('/');
      if (ev.key === 'f') $('fav-btn').click();
      if (ev.key === 'e') $('archive-btn').click();
      if (ev.key === 'l' && state.narration) $('listen-btn').click();
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
    const body = { progress: p };
    if (player.manifest && player.articleId === state.current.id) body.audio_pos = elapsed();
    fetch(appUrl(`/api/articles/${state.current.id}`), {
      method: 'PATCH',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
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
  // The server hands back a script: what to read, in what order, and the pause
  // each block earns. Audio arrives one segment at a time, so listening starts
  // after the opening line rather than after the whole article is synthesised.
  // Two audio elements take turns, which is what removes the seam between them.
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, pre, dt, dd';
  const RATES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const SKIP_SECONDS = 15;
  // played inside the click that starts narration, so iOS and Chrome count the
  // audio elements as user-initiated before the first segment has downloaded
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

  const player = {
    el: $('player'),
    manifest: null,
    articleId: null,
    blocks: [],
    index: 0,
    playing: false,
    decks: null,
    deck: 0,
    saveTimer: null,
    ticker: null,
    lit: [],
    lastScrollAt: 0,
    get rate() { return Number(localStorage.getItem('p.rate')) || 1; },
    set rate(v) { localStorage.setItem('p.rate', String(v)); },
    get follow() { return localStorage.getItem('p.follow') !== '0'; },
    set follow(v) { localStorage.setItem('p.follow', v ? '1' : '0'); },
    get captions() { return localStorage.getItem('p.captions') === '1'; },
    set captions(v) { localStorage.setItem('p.captions', v ? '1' : '0'); },
  };

  /* Two audio elements take turns: one plays while the other loads what comes
     next. They live in the document and carry the pause between passages inside
     their own audio, because a phone with a locked screen keeps playing a file
     but stops running the timer that would have started the next one. */
  function decks() {
    if (!player.decks) {
      player.decks = [new Audio(), new Audio()];
      for (const deck of player.decks) {
        deck.preload = 'auto';
        deck.playsInline = true;
        deck.hidden = true;
        player.el.appendChild(deck);
        deck.addEventListener('ended', () => { if (deck === current()) afterSegment(); });
        deck.addEventListener('loadedmetadata', () => reconcileDuration(deck));
        deck.addEventListener('error', () => { if (deck === current() && deck.dataset.seq) segmentFailed(); });
      }
    }
    return player.decks;
  }
  const current = () => decks()[player.deck];
  const idle = () => decks()[1 - player.deck];

  const segmentUrl = seq => appUrl(`/api/articles/${player.articleId}/narration/${seq}`);
  const audible = segment => Boolean(segment) && (player.captions || segment.kind !== 'caption');

  function unlockAudio() {
    for (const deck of decks()) {
      if (deck.dataset.seq) continue;
      deck.src = SILENCE;
      deck.play().then(() => deck.pause()).catch(() => {});
    }
  }

  function toggleNarration() {
    if (!state.current) return;
    unlockAudio();
    if (player.manifest && player.articleId === state.current.id) {
      if (player.el.hidden) return showPlayer();
      return stopNarration();
    }
    return startNarration();
  }

  async function startNarration({ voiceId, force } = {}) {
    const article = state.current;
    if (!article) return;
    player.articleId = article.id;
    showPlayer();
    setNow(force ? 'recasting the narration…' : 'reading the article…');
    setPlayIcon(false);
    try {
      const manifest = await fetchJson(`/api/articles/${article.id}/narration`, {
        method: 'POST',
        body: { voice_id: voiceId || undefined, force: force || undefined },
      });
      if (player.articleId !== article.id) return;   // reader moved on while we waited
      adoptManifest(manifest);
      const total = timeline().total;
      const resume = manifest.audio_pos > 2 && manifest.audio_pos < total - 5 ? manifest.audio_pos : 0;
      seekTo(resume, { play: true });
    } catch (e) {
      setNow(`narration failed: ${e.message}`, 'error');
      setPlayIcon(false);
    }
  }

  function adoptManifest(manifest) {
    player.manifest = manifest;
    // the server indexed every matching node of this same document, in order
    player.blocks = [...$('a-body').querySelectorAll(BLOCK_SELECTOR)];
    player.index = 0;
    renderPanel();
    updateTransport();
  }

  function showPlayer() {
    player.el.hidden = false;
    $('listen-btn').classList.add('on');
    document.documentElement.dataset.listening = '1';
  }

  function stopNarration() {
    pause();
    clearHighlight();
    player.el.hidden = true;
    $('pl-panel').hidden = true;
    $('pl-more').setAttribute('aria-expanded', 'false');
    $('listen-btn').classList.remove('on');
    delete document.documentElement.dataset.listening;
  }

  /* Leaving the article ends the session; the position is already on the server,
     so reopening picks the narration back up where it stopped. */
  function resetNarration() {
    if (player.manifest) savePosition(elapsed(), { now: true });
    clearInterval(player.ticker);
    player.ticker = null;
    if (player.decks) {
      for (const deck of player.decks) {
        deck.pause();
        deck.removeAttribute('src');
        delete deck.dataset.seq;
      }
    }
    player.playing = false;
    player.manifest = null;
    player.articleId = null;
    player.index = 0;
    player.lit = [];
    player.el.hidden = true;
    $('pl-panel').hidden = true;
    $('listen-btn').classList.remove('on');
    delete document.documentElement.dataset.listening;
  }

  // ── transport ────────────────────────────────────────────────────────────
  function play() {
    if (!player.manifest) return;
    player.playing = true;
    setPlayIcon(true);
    const deck = current();
    if (deck.dataset.seq === String(player.index) && deck.src) {
      deck.playbackRate = player.rate;
      deck.play().catch(() => {});
      startTicker();
      preloadNext();
      updateMediaSession();
      return;
    }
    playSegment(player.index, 0);
  }

  function pause({ persist = true } = {}) {
    player.playing = false;
    setPlayIcon(false);
    clearInterval(player.ticker);
    player.ticker = null;
    if (player.decks) for (const deck of player.decks) deck.pause();
    if (persist && player.manifest) savePosition(elapsed());
    updateMediaSession();
  }

  function togglePlay() {
    if (!player.manifest) return startNarration();
    return player.playing ? pause() : play();
  }

  async function playSegment(index, offset = 0) {
    const segments = player.manifest?.segments || [];
    if (index >= segments.length) return finish();
    if (!audible(segments[index])) return playSegment(index + 1, 0);

    for (const deck of decks()) deck.pause();
    // the spare deck may already hold this segment from the prefetch
    if (idle().dataset.seq === String(index) && current().dataset.seq !== String(index)) {
      player.deck = 1 - player.deck;
    }

    player.index = index;
    const deck = current();
    if (deck.dataset.seq !== String(index)) {
      deck.src = segmentUrl(index);
      deck.dataset.seq = String(index);
    }
    deck.playbackRate = player.rate;
    setTime(deck, offset);

    highlight(index);
    setNow(nowLabel(segments[index]));
    if (player.playing) {
      try { await deck.play(); } catch { /* refused until a gesture; the button still works */ }
      startTicker();
    }
    preloadNext();
    updateMediaSession();
    updateTransport();
  }

  function setTime(deck, offset) {
    const apply = () => { try { deck.currentTime = offset; } catch { /* not seekable yet */ } };
    if (deck.readyState >= 1) apply();
    else deck.addEventListener('loadedmetadata', apply, { once: true });
  }

  function afterSegment() {
    const segments = player.manifest?.segments || [];
    savePosition(elapsed());
    let next = player.index + 1;
    while (next < segments.length && !audible(segments[next])) next += 1;
    if (next >= segments.length) return finish();
    // straight into the next file: the pause was already spoken as silence
    playSegment(next, 0);
  }

  function preloadNext() {
    const segments = player.manifest?.segments || [];
    let next = player.index + 1;
    while (next < segments.length && !audible(segments[next])) next += 1;
    if (next >= segments.length) return;
    const spare = idle();
    if (spare.dataset.seq === String(next)) return;
    spare.src = segmentUrl(next);
    spare.dataset.seq = String(next);
    spare.load();
  }

  function segmentFailed() {
    setNow('that passage would not synthesise — skipping it', 'error');
    afterSegment();
  }

  function finish() {
    pause({ persist: false });
    setNow('finished');
    savePosition(0, { now: true });
    clearHighlight();
    updateTransport();
  }

  // ── timeline ─────────────────────────────────────────────────────────────
  /* Where each segment sits on one continuous clock. Each duration already
     covers the pause that follows it. They start as the server's estimate and
     are replaced by the real thing as the audio loads, so the bar tightens up
     rather than jumping. */
  function timeline() {
    const segments = player.manifest?.segments || [];
    const marks = [];
    let at = 0;
    for (const segment of segments) {
      marks.push(at);
      if (audible(segment)) at += segment.duration;
    }
    return { marks, total: at };
  }

  function elapsed() {
    if (!player.manifest) return 0;
    return (timeline().marks[player.index] || 0) + (current().currentTime || 0);
  }

  function seekTo(seconds, { play: shouldPlay = false } = {}) {
    if (!player.manifest) return;
    const segments = player.manifest.segments;
    const { marks, total } = timeline();
    const target = Math.max(0, Math.min(seconds, Math.max(0, total - 0.5)));
    let index = 0;
    for (let i = 0; i < segments.length; i++) {
      if (audible(segments[i]) && marks[i] <= target) index = i;
    }
    const offset = Math.max(0, Math.min(target - marks[index], Math.max(0, (segments[index]?.duration || 0) - 0.3)));
    if (shouldPlay) { player.playing = true; setPlayIcon(true); }
    playSegment(index, offset);
  }

  const jump = delta => seekTo(elapsed() + delta, { play: player.playing });

  let sessionTick = 0;
  function startTicker() {
    clearInterval(player.ticker);
    player.ticker = setInterval(() => {
      updateTransport();
      if (++sessionTick % 8 === 0) updateMediaSession();
    }, 250);
  }

  function updateTransport() {
    if (!player.manifest) return;
    const { total } = timeline();
    const at = elapsed();
    $('pl-time').textContent = `${clock(at)} / ${clock(total)}`;
    const seek = $('pl-seek');
    if (document.activeElement !== seek) seek.value = String(total ? Math.round((at / total) * 1000) : 0);
    $('pl-rate').textContent = `${player.rate}×`;
  }

  function reconcileDuration(deck) {
    const seq = Number(deck.dataset.seq);
    const segment = player.manifest?.segments?.[seq];
    if (!segment || !Number.isFinite(deck.duration) || deck.duration <= 0) return;
    segment.duration = deck.duration;
    segment.ready = true;
    updateTransport();
  }

  // ── follow along ─────────────────────────────────────────────────────────
  function highlight(index) {
    clearHighlight();
    const segment = player.manifest?.segments?.[index];
    if (!segment) return;
    const nodes = (segment.blocks || []).map(at => player.blocks[at]).filter(Boolean);
    for (const node of nodes) node.classList.add('is-narrating');
    player.lit = nodes;
    // a reader who just scrolled somewhere is reading there; do not yank them back
    if (!nodes.length || !player.follow || Date.now() - player.lastScrollAt < 4000) return;
    const box = nodes[0].getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    if (box.top < frame.top + 80 || box.bottom > frame.bottom - 140) {
      scroller.scrollTo({
        top: scroller.scrollTop + box.top - frame.top - frame.height * 0.32,
        behavior: 'smooth',
      });
    }
  }

  function clearHighlight() {
    for (const node of player.lit) node.classList.remove('is-narrating');
    player.lit = [];
  }

  function nowLabel(segment) {
    const voice = player.manifest?.voice;
    const cast = voice?.name ? `${voice.name}${voice.tone ? ` · ${voice.tone}` : ''}` : '';
    return { intro: 'opening', outro: 'closing', heading: 'section', quote: 'quotation', caption: 'caption' }[segment?.kind] || cast;
  }

  function setNow(message, kind) {
    const now = $('pl-now');
    now.textContent = message;
    now.classList.toggle('error', kind === 'error');
  }

  function setPlayIcon(playing) {
    const button = $('pl-play');
    button.innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function clock(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function savePosition(at, { now = false } = {}) {
    if (!player.articleId || DEMO) return;
    const id = player.articleId;
    clearTimeout(player.saveTimer);
    const send = () => api.patch(id, { audio_pos: Math.max(0, at || 0) }).catch(() => {});
    if (now) send();
    else player.saveTimer = setTimeout(send, 500);
  }

  // ── settings ─────────────────────────────────────────────────────────────
  function renderPanel() {
    const panel = $('pl-panel');
    const voice = player.manifest?.voice || {};
    const words = player.manifest?.pronunciations || [];
    panel.innerHTML = `
      <div class="pl-cast">
        <span class="pl-cast-name">${esc(voice.name || 'default voice')}</span>
        ${voice.tone ? `<span class="pl-chip">${esc(voice.tone)}</span>` : ''}
        ${voice.source ? `<span class="pl-chip pl-chip-quiet">${esc(voice.source)}</span>` : ''}
      </div>
      ${voice.reason ? `<p class="pl-reason">${esc(voice.reason)}</p>` : ''}
      ${words.length ? `<p class="pl-reason">said as: ${esc(words.map(w => `${w.find} → ${w.say}`).join(' · '))}</p>` : ''}
      <div class="pl-toggles">
        <label><input type="checkbox" id="pl-follow" ${player.follow ? 'checked' : ''}> follow along</label>
        <label><input type="checkbox" id="pl-captions" ${player.captions ? 'checked' : ''}> read captions</label>
      </div>
      <div class="pl-actions">
        <button class="linklike" id="pl-recast">recast</button>
        <button class="linklike" id="pl-pick">choose a voice</button>
      </div>
      <div id="pl-voices" class="pl-voices" hidden></div>`;

    panel.querySelector('#pl-follow').addEventListener('change', ev => { player.follow = ev.target.checked; });
    panel.querySelector('#pl-captions').addEventListener('change', (ev) => {
      player.captions = ev.target.checked;
      updateTransport();
    });
    panel.querySelector('#pl-recast').addEventListener('click', () => startNarration({ force: true }));
    panel.querySelector('#pl-pick').addEventListener('click', showVoicePicker);
  }

  async function showVoicePicker() {
    const mount = $('pl-voices');
    mount.hidden = false;
    mount.textContent = 'loading voices…';
    try {
      const voices = await fetchJson(`/api/narration/voices?lang=${encodeURIComponent(player.manifest?.language || 'en')}`);
      if (!voices.length) { mount.textContent = 'no voice catalogue available'; return; }
      mount.innerHTML = voices.slice(0, 40).map(voice => `
        <button class="pl-voice" data-voice="${esc(voice.id)}" title="${esc(voice.description || '')}">
          <span class="pl-voice-name">${esc(voice.title)}</span>
          <span class="pl-voice-tags">${esc((voice.tags || []).slice(0, 4).join(' · '))}</span>
        </button>`).join('');
      mount.onclick = (ev) => {
        const button = ev.target.closest('[data-voice]');
        if (!button) return;
        mount.hidden = true;
        startNarration({ voiceId: button.dataset.voice, force: true });
      };
    } catch (e) {
      mount.textContent = `voices unavailable: ${e.message}`;
    }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !state.current) return;
    const article = state.current;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: article.title || 'particle',
        artist: article.byline || article.site_name || 'particle',
        album: article.site_name || 'particle',
        artwork: article.lead_image
          ? [{ src: appUrl(`/api/image?url=${encodeURIComponent(article.lead_image)}`), sizes: '512x512' }]
          : [],
      });
      navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
      // gives the lock screen a real scrub bar over the whole article
      const { total } = timeline();
      if (total > 0) {
        navigator.mediaSession.setPositionState({
          duration: total,
          position: Math.min(elapsed(), total),
          playbackRate: player.rate,
        });
      }
    } catch { /* metadata is a nicety */ }
    const bind = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    bind('play', play);
    bind('pause', () => pause());
    bind('seekbackward', () => jump(-SKIP_SECONDS));
    bind('seekforward', () => jump(SKIP_SECONDS));
    bind('nexttrack', () => afterSegment());
    bind('previoustrack', () => seekTo(timeline().marks[Math.max(0, player.index - 1)] || 0, { play: player.playing }));
    bind('seekto', (details) => {
      if (Number.isFinite(details?.seekTime)) seekTo(details.seekTime, { play: player.playing });
    });
    bind('stop', () => pause());
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  $('listen-btn').addEventListener('click', toggleNarration);
  $('pl-play').addEventListener('click', () => { unlockAudio(); togglePlay(); });
  $('pl-back').addEventListener('click', () => jump(-SKIP_SECONDS));
  $('pl-fwd').addEventListener('click', () => jump(SKIP_SECONDS));
  $('pl-close').addEventListener('click', stopNarration);
  $('pl-rate').addEventListener('click', () => {
    player.rate = RATES[(RATES.indexOf(player.rate) + 1) % RATES.length] || 1;
    for (const deck of decks()) deck.playbackRate = player.rate;
    updateTransport();
  });
  $('pl-more').addEventListener('click', () => {
    const panel = $('pl-panel');
    panel.hidden = !panel.hidden;
    $('pl-more').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('pl-seek').addEventListener('input', (ev) => {
    const { total } = timeline();
    $('pl-time').textContent = `${clock((Number(ev.target.value) / 1000) * total)} / ${clock(total)}`;
  });
  $('pl-seek').addEventListener('change', (ev) => {
    const { total } = timeline();
    seekTo((Number(ev.target.value) / 1000) * total, { play: player.playing });
  });

  // A tap on a paragraph while the player is open reads from there.
  $('a-body').addEventListener('click', (ev) => {
    if (!player.manifest || player.el.hidden || ev.target.closest('a, button')) return;
    let block = ev.target.closest(BLOCK_SELECTOR);
    if (!block) return;
    for (let up = block.parentElement?.closest(BLOCK_SELECTOR); up; up = up.parentElement?.closest(BLOCK_SELECTOR)) {
      block = up;
    }
    const blockIndex = player.blocks.indexOf(block);
    const index = player.manifest.segments.findIndex(segment => (segment.blocks || []).includes(blockIndex));
    if (blockIndex < 0 || index < 0) return;
    unlockAudio();
    player.playing = true;
    setPlayIcon(true);
    playSegment(index, 0);
  });

  scroller.addEventListener('scroll', () => { player.lastScrollAt = Date.now(); }, { passive: true });

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

  // Narration needs a text-to-speech key on the server; without one the reader
  // never offers it.
  if (!DEMO) {
    fetchJson('/api/health')
      .then((health) => {
        state.narration = Boolean(health.narration);
        if (state.narration && !reader.hidden) $('listen-btn').hidden = false;
      })
      .catch(() => {});
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
