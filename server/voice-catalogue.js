// The provider's voice catalogue, kept in the library so a restart does not
// start from nothing. Listening never waits on it: a chosen voice is an id, and
// an id plays whether or not the catalogue currently lists it. The picker does
// wait, briefly, the first time — and after that is answered from the saved
// copy while a fresh one is fetched behind it.
//
// The catalogue is several pages (one per register). Each page that arrives is
// used; a page that fails keeps the voices the last good copy had from it. A
// refresh where every page failed is a failure with an error code, never an
// empty catalogue that looks like a successful answer.

export function createVoiceCatalogue({
  fetchPages,                    // (language, signal) → Array<Promise<voice[]>>
  load = () => null,             // language → { fetched_at, voices } | null
  save = () => {},               // (language, voices, fetched_at) → void
  now = () => Date.now(),
  ttlMs = 60 * 60 * 1000,
  retryMs = 60 * 1000,
  waitMs = 5000,
  log = () => {},
} = {}) {
  const entries = new Map();     // language → { voices, fetchedAt, errorCode, failedAt, refreshing }
  const byId = new Map();        // id → voice, from any language seen

  function entry(language) {
    if (!entries.has(language)) {
      const stored = safe(() => load(language));
      const voices = Array.isArray(stored?.voices) ? stored.voices : [];
      const fetchedAt = stored?.fetched_at ? Date.parse(stored.fetched_at) || 0 : 0;
      entries.set(language, { voices, fetchedAt, errorCode: null, failedAt: null, refreshing: null });
      remember(voices);
    }
    return entries.get(language);
  }

  function remember(voices) {
    for (const voice of voices) if (voice?.id) byId.set(voice.id, voice);
  }

  const fresh = state => state.voices.length > 0 && now() - state.fetchedAt < ttlMs;
  const coolingOff = state => state.failedAt !== null && now() - state.failedAt < retryMs;

  function refresh(language) {
    const state = entry(language);
    if (state.refreshing) return state.refreshing;
    state.refreshing = (async () => {
      const pages = await Promise.allSettled(safe(() => fetchPages(language)) || []);
      const ok = pages.filter(page => page.status === 'fulfilled').map(page => page.value || []);
      const failed = pages.filter(page => page.status === 'rejected');
      if (!ok.length) {
        state.failedAt = now();
        state.errorCode = failed[0]?.reason?.code || 'network';
        log(`voice catalogue (${language}) unavailable: ${state.errorCode}`);
        return state;
      }
      const seen = new Map();
      for (const voice of ok.flat()) if (voice?.id && !seen.has(voice.id)) seen.set(voice.id, voice);
      // a page that failed this time still had voices last time; keep those
      if (failed.length) for (const voice of state.voices) if (!seen.has(voice.id)) seen.set(voice.id, voice);
      state.voices = [...seen.values()];
      state.fetchedAt = now();
      state.failedAt = failed.length ? now() : null;
      state.errorCode = failed.length ? 'partial' : null;
      remember(state.voices);
      safe(() => save(language, state.voices, new Date(state.fetchedAt).toISOString()));
      return state;
    })().finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  /**
   * What the picker shows. Fresh: as is. Stale: as is, with a refresh started.
   * Empty: wait up to `wait` for the first refresh, then answer either way.
   */
  async function get(language = 'en', { wait = waitMs } = {}) {
    const state = entry(language);
    if (!fresh(state) && !coolingOff(state)) refresh(language).catch(() => {});
    if (!state.voices.length && state.refreshing && wait > 0) {
      await Promise.race([state.refreshing.catch(() => {}), delay(wait)]);
    }
    return view(state);
  }

  function view(state) {
    return {
      voices: state.voices,
      stale: !fresh(state),
      refreshing: Boolean(state.refreshing),
      error_code: state.errorCode,
      fetched_at: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
    };
  }

  /** The voices already at hand, without waiting for anything. */
  function peek(language = 'en') {
    const state = entry(language);
    if (!fresh(state) && !coolingOff(state)) refresh(language).catch(() => {});
    return state.voices;
  }

  return {
    get,
    peek,
    refresh,
    known: id => (id ? byId.get(id) || null : null),
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    id.unref?.();
  });
}

function safe(run) {
  try { return run(); } catch { return undefined; }
}
