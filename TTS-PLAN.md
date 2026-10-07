# TTS implementation contract

Status: inspection complete; implementation not started.
Audience: an implementation LLM. Execute the phases in order. Decisions below are
intentional defaults; do not replace them with a broader redesign.
Inspected: 2026-10-08, commit `23ff147c06363e0ca12b240890675ed753567d3e`.

## 0. Scope and execution rules

Deliver reliable article narration: a chosen default voice, fast and recoverable
starts/switches, reliable resume, explicit start locations, prose-only speech,
bounded work and useful caching on slow connections.

- Read `AGENTS.md` and `.claude/skills/particle/SKILL.md` first.
- Shell commands use `rtk`; use `rtk proxy` for commands needing unfiltered output.
- Node 24+, modern ESM, vanilla browser JS. No framework, bundler, new runtime
  dependency, separate service, or provider replacement.
- This plan concerns the existing single-library app. `USER-PLAN.md` is an
  unrelated, pre-existing untracked proposal; do not edit or implement it.
- Make one reviewable concern per implementation diff. Run `rtk npm test` after
  each phase. Do not commit, release, or call paid providers merely to implement
  this document. A deliberate end-to-end listening check may use the configured
  provider; record its cost/request count and use a short fixture.
- Do not read or log API keys. Use synthetic articles and a scratch database for
  destructive checks. Never use the real library for migration experiments.
- Update the particle skill when modules, routes, schema, configuration, or
  documented invariants change. Do not rewrite its orientation as a code listing.
- Preserve base-path handling, auth, demo mode, extraction safety, and ordinary
  reading. Build all application URLs through the existing base-path helpers.
- A phase is complete only with its listed evidence. Passing the existing unit
  suite alone does not verify audio playback or browser lifecycle behavior.

## 1. Inspection evidence

These are source findings, not inferred provider outages. Function names are the
stable navigation anchors; line numbers describe the inspected revision.

| ID | Evidence | Consequence |
|---|---|---|
| F01 | `public/index.html` settings has no narration/default voice section. `planNarration()` in `server/narration.js:497` selects by tags, recent voices and optionally LLM. | Preferences cannot govern ordinary listening. Automatic variation conflicts with a fixed preferred narrator. |
| F02 | First-time planning awaits `listVoices()` and then `directNarration()`. An explicit voice without `reuse` still takes this path. `voiceTitle()` can fetch the catalogue even on a switch. | Known voice IDs unnecessarily depend on catalogue/LLM availability. LLM chat defaults to a 45-second timeout. |
| F03 | `tts.js:refreshVoices()` awaits six catalogue requests with `Promise.all`; each uses 20-second attempts. One failure discards successful pages. Cache is process memory only. | Cold starts and partial catalogue outages delay or empty the picker. Existing stale-while-refresh and startup prewarming help, but do not solve cold failure. |
| F04 | `tts.js:withRetry()` throws non-retryable HTTP errors inside its own `try`, then catches and retries them. Synthesis has three 120-second attempts plus delays. Body consumption occurs outside `withRetry()`. | Permanent failures can wait roughly six minutes; body-read failures have different retry behavior. No end-to-end operation deadline or external cancellation. |
| F05 | `narrator.ensure()` deduplicates equal planning keys, but different voice jobs independently delete/save the same article record after awaiting planning. Key omits content revision. | Slow earlier voice requests can overwrite later ones; edits/deletes can race a pending plan. |
| F06 | `narrator.withSlot()` prioritizes newly queued foreground closures, but joining an existing background job only changes reporting; it does not move that closure. Running work cannot be cancelled. POST warms from zero on ordinary resume. | A desired passage can remain behind abandoned work, including previous voices or the start of an article being resumed in its middle. |
| F07 | Segment cache is `(article_id, seq)`. Recast deletes every segment. `narrationRev()` uses creation time. Synthesis settings/model are absent from cache identity. | A→B→A regenerates A; unchanged audio cannot survive recasts; config changes can reuse obsolete audio. Existing revision URLs and post-synthesis revision checks are useful but incomplete. |
| F08 | Segment route reads the current narration, even if `?v=` names another revision. `sendAudio()` merely disables caching for the mismatch. Cache lookup happens before revision checking in `segment()`. | A stale URL can return a different voice/script. A cached old response and the server's new response can have different meanings under one URL. |
| F09 | `startNarration()` checks article ID after the await, not operation identity. Closing while planning leaves article ID unchanged. Pause/reset do not consistently invalidate `player.turn`. Deck identity is only sequence number. `setTime()` leaves an unguarded metadata listener. | Late requests, promises and media events can restart, pause, seek or highlight the wrong operation. An old promise can pause a deck already reused by a newer play. |
| F10 | `play()`/`playSegment()` set playing optimistically and swallow play rejection. `segmentFailed()` calls `afterSegment()` automatically. No waiting/stalled state or bounded retry UI. | UI can claim playback while silent; an outage skips unheard content, potentially repeatedly to the end. |
| F11 | `audio_pos` is a single cumulative second value. `timeline()` changes as estimated durations become actual durations and as captions are toggled. Voice switches reuse cumulative seconds. | Saved seconds identify different text later. The resume guard also resets positions near the end rather than storing completion explicitly. |
| F12 | `savePosition()` runs on pause/boundary/reset; ticker does not checkpoint. Failures are swallowed. There is pagehide keepalive, but no durable pending position. | A kill/offline failure loses progress inside a long passage. The existing keepalive path must be retained and improved, not rediscovered. |
| F13 | Only scrub and ±15 seconds navigate audio. No start-from-paragraph action or clear resume/start-over choice. Listen toggles visibility/stop rather than always meaning play. | Entering partway through an article and resuming require guessing. |
| F14 | `buildScript()` emits captions and metadata intro/outro. Only the client skips `kind === 'caption'`, with an option to read it. Paragraph captions and table descendants become ordinary text. Outer block `textContent` can include excluded nested content. | Unwanted content is synthesized, cached, and sometimes spoken. Server warm-ahead spends work on captions even when the client skips them. |
| F15 | `extract.js:readabilityParse()` uses `keepClasses: false`; sanitizer rejects data attributes. | Caption/byline/credit semantics may be lost before narration. A fix examining only surviving CSS classes is insufficient. |
| F16 | `public/sw.js` explicitly bypasses segment audio; generic API caching can cache narration metadata. Browser HTTP cache is opportunistic, not a managed offline audio store. | Server-cached audio still needs downloading. Offline startup cannot depend on POSTing a manifest. |
| F17 | `sendAudio()` interprets `bytes=-N` as `0..N`. `pruneNarrationAudio()` exempts the entire current article. | Suffix ranges are incorrect. One large active article can exceed the advertised cache ceiling. |
| F18 | Two audio decks and wake recovery exist. Comments explicitly acknowledge locked iOS segment transitions can fail. | Locked playback is a device validation requirement, not a property proven by silence padding or unit tests. |

Current flow:

```text
HTML / PDF / OCR -> saved content_html
click Listen -> SSE + POST narration
  -> ensure -> catalogue -> optional LLM -> script
  -> delete previous narration/audio -> save -> warm N segments
manifest -> estimated cumulative seek -> deck URL
  -> cache or synthesis queue -> provider -> entire MP3 buffered
  -> append silence -> SQLite BLOB -> HTTP range/full response
deck -> preload next deck -> ended -> next segment
pause/boundary/pagehide -> PATCH articles.audio_pos
```

Baseline validation:

- `rtk npm test`: **101 passed, 0 failed**, 2026-10-08.
- A pure `buildScript()` probe with a paragraph, `figcaption`, table-cell paragraph,
  and `<p class="caption">` produced: metadata intro; body; caption; ordinary text
  containing both table text and image credit; publisher outro.
- No live provider benchmark, browser reproduction, or device listening test was
  performed during this inspection. Latency budgets below are targets, not
  measured claims. Exact site-specific failures need representative fixtures.

## 2. Product decisions — implement these

### 2.1 Voice preferences

1. Default voice is **library state**, shared across devices. Store it in SQLite,
   not only localStorage. Speed and follow-along remain device preferences.
2. Settings → narration offers a searchable voice list, sample buttons, selected
   default, and an explicit `Automatic` option. A sample is a preview, never a
   change of default. Stop another sample before playing one.
3. Effective voice precedence is: enforced `TTS_VOICE_LOCK` → explicit article
   override → library default → existing automatic choice for this unchanged
   script → `TTS_VOICE_ID` → current heuristic shortlist → provider default.
   The last two fallbacks apply only when no explicit choice exists.
4. An unavailable chosen voice produces a recoverable error and Choose voice.
   Never silently replace a chosen voice with another one. Catalogue absence
   alone does not prove a saved voice is invalid: allow its ID to synthesize.
5. Changing the default affects subsequent playback starts, including previously
   automatic articles. It does not interrupt a running session. Article overrides
   persist until `Use default` is selected. Show the effective source plainly.
6. With an operator lock, show the locked voice and explanation; disable changing
   the effective voice and reject contradictory API updates. Keep existing env
   aliases. An unlocked `TTS_VOICE_ID` is a fallback, not a user override.
7. Remove automatic LLM direction from the Listen/start/switch path. Use stable
   deterministic pacing and the current normalization rules. Do not add an
   asynchronous LLM mutation of a script already playing. Tagging remains intact.
   Remove the player's ambiguous `recast` action; choosing a voice is explicit.

### 2.2 Start, resume and switch

- Main action: `Listen` on a new article; `Resume` when there is an unfinished
  bookmark; `Listen again` after completion. `Start over` is separate.
- Provide `Listen from here` for a selected/target paragraph and `Listen from
  visible paragraph` in the reader actions. Start at that paragraph's beginning.
  Text selection and links retain their normal behavior; do not make all prose
  clicks trigger playback. Include keyboard and touch access.
- Navigation/close ends playback and saves its location. Reopening does not
  autoplay; pressing Resume does. Scrolling never changes the audio bookmark.
- Pause during loading cancels playback intent immediately. Completion of a
  pending download must not resume it. A normal seek preserves paused/playing
  intent; Listen from here explicitly requests playing.
- Voice change snapshots location and intent, stops the old voice immediately,
  loads the new voice at the same text segment, and resumes only if the previous
  intent was playing. If paused, stay paused. Failure leaves Retry and Choose
  voice available; do not continue the old voice without an explicit action.
- Exact resume within the same audio revision uses segment ID + offset seconds.
  Across voices, restart the current short segment from its beginning. This may
  repeat a sentence; it must not skip text. Do not pretend character timing is
  available from this provider integration.
- A failed passage stays selected. Retry it. Skip passage is an explicit user
  action. Never call `finish()` just because all network requests failed.

### 2.3 What is spoken

- Speak body prose, substantive headings, genuine quotes, and article lists.
- Never speak captions, image alt text, image credits, byline/date/site metadata,
  reading time, share/subscribe/navigation boilerplate, code, table contents,
  footnote references, or duplicated pullquotes.
- Remove generated intro/outro completely, including the title/author preamble.
  Keep title, author and site in visual/Media Session metadata. Skip an opening
  heading identical to the saved title; keep substantive section headings.
- Remove the read-captions switch and ignore/delete `p.captions`. Exclusion is a
  server script rule, not a playback preference.
- Keep excluded material visible in the reader. Narration classification must
  not destructively trim the stored article or search text.
- Heuristics cannot identify every unlabeled caption. Favor structural evidence;
  keep ambiguous prose. Provide a saved `Exclude from narration` / `Include in
  narration` block override so a misclassified saved article is repairable
  without deletion or re-extraction. Explicit manual exclusion always wins.

## 3. Target architecture and contracts

### 3.1 Separate identities

Use three identities, never a cumulative clock as a content identifier:

```text
content_revision = hash(saved narration-relevant HTML, manual exclusions,
                        title/byline/site/date used by classification)
script_id = hash(content_revision, SCRIPT_VERSION, segmentation policy)
rev = hash(script_id, effective voice, provider endpoint identity, model,
           format, bitrate, provider speed/temperature/top_p/latency/normalize,
           pause algorithm version and every other synthesis input)
```

Use SHA-256. Include no credentials, account secrets or timestamps in `rev`.
Hash provider endpoint configuration before exposing its identity. Exclude browser
playbackRate: changing speed in the player must not synthesize new audio.
If normalization/pronunciation changes speech, it must change `script_id`.

Each spoken segment has stable `id`, `seq`, `block_id`, `dom_index`, `part`, text,
and normalized text start/end offsets. One segment belongs to one logical block.
Block IDs use canonical block text hash + occurrence number for repeated blocks;
DOM indices are for locating the rendered element, not persistent identity.
Keep mappings for excluded blocks with explicit `skip_reason`.

Remove merging across paragraph boundaries. Use the existing sentence/clause
splitter with a default target of 300 characters and maximum 450. Do not split
ordinary words at a hard character boundary; only split an overlong unbroken
token as a last resort. Respect explicit `TTS_SEGMENT_CHARS` overrides as a cap,
document the changed default, and include the actual policy in script identity.
Short segments bound startup transfer and repeated speech on voice change.
Benchmark request overhead before lowering this further.

### 3.2 Proposed schema migration

Current schema version is 3. Implement v4, or the next unused version if another
change lands first. Use one transaction, bump the guard, preserve all articles.

```text
narration_settings
  id INTEGER PRIMARY KEY CHECK(id=1)
  default_voice_id TEXT NULL             -- null means Automatic
  default_voice_name TEXT NULL           -- label snapshot, not authority
  version INTEGER NOT NULL DEFAULT 0

articles additions
  narration_voice_id TEXT NULL           -- null means use default policy
  narration_voice_name TEXT NULL
  narration_voice_version INTEGER NOT NULL DEFAULT 0
  audio_bookmark TEXT NULL               -- validated JSON contract below
  audio_bookmark_version INTEGER NOT NULL DEFAULT 0

narration_variants
  article_id FK articles ON DELETE CASCADE
  rev TEXT
  script_id TEXT
  content_revision TEXT
  voice_id TEXT NULL, voice_name TEXT, language TEXT
  config TEXT                           -- non-secret synthesis configuration
  script TEXT                           -- immutable normalized blocks/segments
  created_at TEXT, last_used_at TEXT
  PRIMARY KEY(article_id, rev)

narration_audio
  article_id, rev, seq
  audio BLOB, bytes INTEGER, duration REAL, last_used_at TEXT
  PRIMARY KEY(article_id, rev, seq)
  FOREIGN KEY(article_id, rev) REFERENCES narration_variants ON DELETE CASCADE

narration_voice_catalogue
  language TEXT PRIMARY KEY, fetched_at TEXT, payload TEXT

narration_auto_choices
  article_id FK articles ON DELETE CASCADE
  script_id TEXT
  voice_id TEXT NULL, voice_name TEXT
  PRIMARY KEY(article_id, script_id)
```

The automatic-choice row distinguishes an existing provider-default choice (null
voice ID) from no choice yet (no row). Insert it once per script with conflict
handling; do not infer automatic choice from whichever manual variant was created
first. Remove obsolete automatic-choice rows when their scripts are pruned.

Keep old `narrations`, `narration_segments`, and `audio_pos` temporarily for lazy
bookmark conversion. Never serve old audio under a new revision. On first access
to an article, map its old seconds through its old manifest/block mapping, map
the resulting block to the new script, save a bookmark and delete that article's
legacy narration/audio in one transaction. If old mapping is unavailable, offer
Start over/Listen from here; do not guess with reading scroll percentage.
Legacy audio still counts toward the cache budget and can be evicted independently
of its script. Do not require a provider call to migrate. Old application builds
will reject v4; rollback requires a consistent pre-migration database backup.

Bookmark JSON v1:

```json
{
  "v": 1,
  "content_revision": "...",
  "script_id": "...",
  "rev": "...",
  "block_id": "...",
  "segment_id": "...",
  "offset_seconds": 8.25,
  "completed": false
}
```

Validate finite nonnegative offset, known IDs, version and boolean values. On the
same revision clamp offset to actual duration after metadata is available. On a
different voice use the segment start. On changed text prefer an exact surviving
block match, then the next surviving block in the old order. If no mapping exists,
show that the article changed and offer a fresh location; never silently reinterpret
old seconds. Do not reset completion to zero; store `completed: true` explicitly.

### 3.3 Route changes

All routes stay behind existing auth/library registration. Demo keeps narration
unavailable, hides its UI, and does not call these routes. TTS-disabled real
installs show an unavailable settings note without requesting voices/audio.

| Route | Contract |
|---|---|
| `GET /api/narration/settings` | Default voice, settings version, enabled, locked, locked voice label/ID. No keys or provider secrets. |
| `PATCH /api/narration/settings` | `{default_voice_id, default_voice_name, expected_version}`; validate bounded strings; atomic compare/update, 409 on conflict. No synthesis. |
| `GET /api/narration/voices?lang=` | Cached catalogue with `{voices, stale, refreshing, error_code}`. Partial success is useful. Stable IDs and sample URLs, plus saved/default voice entry even if absent from current catalogue. |
| `GET /api/articles/:id/narration/blocks` | Pure block map with content_revision, script_id, stable IDs, DOM locators and exclusions. No catalogue, LLM or synthesis. Register before `/:seq`. |
| `POST /api/articles/:id/narration` | Prepare/reuse immutable manifest; `{voice_override?: {id,name} | null, expected_voice_version?, start?: {mode:'resume'|'beginning'|'block',block_id?,content_revision?}, request_id, session_id, generation}`. Missing override preserves stored override; null explicitly clears it. Resolve effective voice before cache lookup. |
| `GET /api/articles/:id/narration?rev=` | Exact immutable manifest; if rev omitted, return current effective manifest if already prepared. No synthesis. Missing revision 404; changed content 409. |
| `GET /api/articles/:id/narration/:seq?v=` | Exact variant only. Require revision for new clients. 409 `revision_required` for absent v; 404 `revision_missing` for absent variant; 409 `content_changed` for invalidated text. Never return a different variant. |
| `PUT /api/articles/:id/narration/position` | `{bookmark, expected_version}`; atomic compare/update, return server version/bookmark. 409 returns latest state. Position belongs to article, not a global player. |
| `POST /api/articles/:id/narration/demand` | `{session_id, generation, rev, seq, rate, target_seconds, paused}` replaces this session's requested prefetch window; renewable short lease. No new permanent table. |
| `GET /api/articles/:id/narration/status` | SSE events carry article_id, request_id where applicable, rev, seq, job_id, stage, elapsed_ms, retryable/code. Filter by operation/revision, not article alone. |
| `DELETE /api/articles/:id/narration` | Invalidate/cancel all article narration work and clear all variants/audio. Clear bookmark explicitly because it refers to deleted narration; leave preference/override intact. |

POST preparation should do local script work and cached policy resolution only.
For Automatic with no cached catalogue, use the documented provider default and
refresh the catalogue separately; freeze that choice for this script until the
user chooses a voice. Do not wait for a cold catalogue during Listen.
Return manifest with resolved start segment, bookmark version, total estimate,
actual/estimated flag per duration, server-ready flags and script exclusions.
Server-ready does not mean downloaded in this browser.

For overlapping override POSTs, use a per-client session generation on requests
and a server mutation version/CAS on article override. An older request must not
overwrite a newer override. A second device receiving 409 reloads the override;
it does not automatically retry its stale change. Immutable variants may coexist;
there is no mutable global current voice that GET segment can accidentally read.
Require expected_voice_version for an override mutation and return the new version
in the manifest. Serialize/coalesce override mutations in the client so a rapid
B→C choice does not send two updates with the same expected version. Intermediate
results can advance the version for the next mutation without starting playback.
Validate block starts against the supplied content revision; a stale DOM map gets
409 and a refreshed map, never a best-guess index into changed text.

### 3.4 Browser module boundary

Move narration behavior out of the large IIFE into native ESM modules:

- `public/narration-model.js`: pure state transitions, bookmark mapping, timeline,
  buffer policy. No DOM, storage, timers or network at module scope.
- `public/narration-player.js`: controller, deck ownership, media events, UI adapter.
- `public/narration-cache.js`: full-response caching, downloads, object URLs, limits.
- `public/app.js`: reader/settings wiring, article lifecycle, passes DOM and API
  adapters into controller. Load it as `type="module"` and add explicit imports.
  Retain its IIFE initially; do not refactor unrelated app sections.

Keep `store-local.js` loaded before app initialization. Add every new static module
to SW shell assets. Bump both shell/runtime versions. Verify module imports at
non-root `PARTICLE_BASE` and in demo mode.

## 4. Phases, edits, and exit conditions

### Phase 1 — preserve intent and stop destructive recovery

Files: `public/app.js` narration/lifecycle; extract pure transition logic into
`public/narration-model.js`; corresponding node tests.

1. Add a monotonically increasing operation generation. Increment on start,
   switch, seek, pause, close, article navigation and reset. Abort previous fetch
   controllers and remove pending metadata callbacks when ownership changes.
2. Every async continuation captures article ID, revision, generation and deck
   source token. Compare before any state/DOM/media mutation, including catches.
   An obsolete promise must not call `pause()` on a deck reused by a new owner.
3. Track `intent: playing|paused` separately from state:
   `idle|preparing|buffering|playing|paused|blocked|error|ended`.
   Only current `playing` media events confirm actual playback.
4. Handle `NotAllowedError` as blocked with `Tap play to continue`; preserve
   bookmark. Other failures are classified, visible, and recoverable. Guard
   unlockAudio's promise too; replace its empty WAV with a valid short silent
   fixture and prove it decodes on target browsers.
5. Replace automatic error skip with Retry / Choose voice / explicit Skip passage.
   Handle `waiting`, `stalled`, `error`, `ended`, and intentional `pause` distinctly.
   Do not classify every HTMLMediaElement error as a synthesis failure.
6. Close while planning must close and stay closed. Pause while buffering must
   remain paused. Listen on a paused article resumes; player visibility is separate.
7. Use media `timeupdate` for local checkpoint intent; avoid relying exclusively
   on an interval that a hidden page may suspend.

Exit: deterministic transition tests cover late A→B responses, close-before-start,
pause-before-play resolves, seek-before-metadata and obsolete catch handlers.
In a browser, a failed segment never skips; blocked play never displays Playing.

### Phase 2 — speech content and stable locations

Files: `server/narration.js`, `server/extract.js`, pure shared mapping helpers if
needed, tests/fixtures; app paragraph actions/highlighting.

1. Implement `classifyNarrationBlocks()` separately from `buildScript()`. Preserve
   full DOM query indices; excluded blocks remain in the mapping. Walk ancestors
   before reading text. Remove excluded descendants from a clone before its
   text is collected. Do not concatenate nested table/caption text into a quote.
2. Before Readability, normalize strong structural signals: figcaption; known
   caption/credit/byline class tokens; schema `itemprop`; metadata containers;
   table/pre/code ancestry. Preserve only controlled semantic classes such as
   `particle-caption`, `particle-credit`, `particle-metadata` using Readability's
   selective class preservation. Verify the installed Readability API first.
   Keep `keepClasses: false` for arbitrary classes. Pass these classes through
   sanitizer. Do not enable all source data attributes or all classes as a fix.
3. For saved HTML, classify surviving semantic tags/classes directly. Use narrow
   prefix/whole-block tests for Photo/Image credit + figure context and exact
   leading metadata matches. Do not exclude a prose paragraph merely because it
   contains “photo”, “by”, “subscribe”, a date, or a person's name.
4. Give block overrides a dedicated controlled attribute, e.g.
   `data-particle-speech="exclude|include"`, allow only this attribute through the
   sanitizer and validate its enum. Wire the reader action through the existing
   sanitized article edit path; recompute script identity and stop/remap current
   playback. Trim serialization must preserve this annotation.
   Include can override an uncertain heuristic, never tables/code or caption/
   metadata semantics explicitly known from structure.
5. Remove intro/outro/caption synthesis. No speakable blocks → 422 `nothing_to_read`.
   Update existing tests that explicitly expect metadata framing.
6. Implement one-block segments, stable IDs and source offsets from §3.1. For
   nested quotes/lists establish one owner per text node; preserve every spoken
   word exactly once. Support meaningful bare text in div/section containers
   without reading the same child paragraph twice; expose a DOM locator for it.
7. Client obtains mapping from the manifest; avoid a second, diverging classifier.
   Check article content identity before applying indices to rendered HTML.
   Listener actions on nested elements resolve to the logical owning block.
   Before the first manifest exists, fetch the cheap `/narration/blocks` map on
   reader open when narration is enabled. This starts no paid work. If the reader
   invokes Listen from here before it arrives, retain the target element, unlock
   audio in that gesture, then resolve through the map before preparing playback.
8. Listen-from-visible selects the first speakable block intersecting the reader
   viewport below its header, then the next speakable block. A selected excluded
   block offers the next spoken paragraph and explains the exclusion.
9. Increment `SCRIPT_VERSION`. Do not re-extract the user's entire library.

Exit fixtures: nested figcaption, paragraph credit, byline/time metadata, table
with paragraphs, code inside quote, genuine quote, duplicate quote, nested list,
repeated identical paragraphs, bare div prose, PDF/OCR-style paragraphs, ordinary
prose mentioning captions/dates, title duplicated in body, empty article.
Assert spoken text AND mapping AND skip reason. Browser action starts the exact
chosen paragraph and highlighting matches after exclusions/edits.

### Phase 3 — settings, immutable variants, and resume persistence

Files: `server/db.js`, `server/index.js`, `server/narrator.js`,
`server/narration.js`, settings markup/style/controller, bookmark tests.

1. Implement v4 and store functions named by operation: get/update settings,
   get/save variant, get/save audio, get/update bookmark, prune audio. Route
   SQL through `db.js`. Store immutable script/config; identical rev is reusable.
2. Implement route validation and voice precedence exactly as §2.1/§3.3. Make
   settings persistence independent of catalogue lookup. Bound voice ID/name to
   256 characters, reject control characters; render labels with textContent.
   Apply stricter provider ID syntax only if documented for all supported endpoints.
3. Remove LLM/catalogue awaits from explicit/default voice planning, including
   the label lookup. Use saved labels or `Chosen voice`; refresh labels separately.
4. Make variant insertion atomic, recheck current content revision before commit,
   and reject a deleted/edited article. Identity-based coalescing includes content,
   script and synthesis config. Deleting narration increments an article job epoch
   so a late result cannot recreate deleted state.
5. Switch exact-revision audio reads before enabling multi-variant UI. Enforce
   revision on cache hits as well as new synthesis. Reuse A after A→B→A.
6. Add settings UI and article override/default actions. Saved choice is visible
   even when catalogue loading fails. Search all returned voices; remove the hard
   first-40 truncation, or paginate the already cached list in the UI.
7. Use existing provider sample URLs only on user click; permit HTTPS URLs,
   `referrerPolicy=no-referrer` where supported, no credentials. If samples cannot
   play, show Sample unavailable without changing selection. Do not add an open
   server-side arbitrary-URL proxy just for samples.
8. Save bookmark locally at least every 2 seconds of actual progress and on
   pause/seek/hide/boundary/close; coalesce server writes to at most once every
   5 seconds during normal playback. Flush on explicit transitions and pagehide
   using the existing keepalive pattern. Storage exceptions must not stop audio.
9. Local keys include origin/base/library namespace and article ID. Keep pending
   bookmark writes until acknowledged. Serialize writes per article; retain only
   the newest queued position. Never retry an older position after a newer one.
10. Use server bookmark version CAS. On 409, retain local pending state, fetch the
    current bookmark and offer `Continue here` versus `Use saved position`; do not
    auto-overwrite another device's newer session. Choosing Continue here sends a
    fresh update against the current version. In-session delayed saves cannot
    reverse the current session. Do not order device updates by wall-clock time.
11. Offline reopen uses local bookmark and cached manifest. Online normal reopen
    uses acknowledged server state unless a local unacknowledged position exists.
    Implement legacy conversion and edited-content mapping from §3.2.
12. Persist explicit completion. Start over immediately stores a new beginning
    bookmark; ±15 seconds operates on the display timeline, while saved state
    always uses segment identity. Update estimated durations without moving the
    active segment or overwriting its offset.

Exit: default survives server/browser restart and appears on a second browser;
lock/default/override tests pass; A→B→A reuses bytes; mid-segment reload resumes
within 2 seconds locally, within the 5-second checkpoint across devices; changed
voice repeats at most the current segment; edited text never silently reuses old
seconds. Verify scratch migrations for v1/v2/v3 and newer-schema refusal.

### Phase 4 — cancellable jobs, bounded provider operations, honest status

Files: `server/narrator.js`, `server/tts.js`, routes; new pure
`server/narration-queue.js` and `server/narration-retry.js` if useful.

1. Replace closure-only queue with explicit jobs keyed `(article_id, rev, seq)`:
   state, priority, enqueue order, AbortController, consumers, progress and lease.
   Joining a queued prefetch promotes that actual job to foreground immediately.
   Use FIFO among equal priorities, not unshift/LIFO starvation.
2. Keep global concurrency default 4; reserve one slot for foreground by capping
   running speculative work at concurrency−1. With concurrency 1, do not begin
   speculative work while foreground is pending, and allow speculative preemption.
   Concurrency is a limit, not a provider throughput guarantee.
3. Demand updates replace the session's old window. Remove jobs with no remaining
   consumers; abort provider work if nobody needs it. Abort old work on switch,
   distant seek, close, content edit, article deletion and narration deletion.
   Another tab using the same revision keeps its shared job alive.
4. Use a 30-second demand lease renewed by foreground segment requests and
   heartbeat while visible/playing. Hidden-page missed heartbeats may stop
   speculative work, never kill an active segment response. Request disconnect
   releases that consumer; do not cancel a shared job based on one disconnect.
5. Before acquiring a slot and before writing audio, check content/job epoch.
   Cancellation releases its slot exactly once. Remove all per-job maps in
   finally, expire latest status, clean article watchers on deletion. Suppress
   cancellation errors from obsolete generations in current UI.
6. Refactor provider retry to encompass fetch, response validation AND complete
   body read. Compose caller cancellation with a single operation deadline.
   Suggested configurable defaults: `TTS_REQUEST_TIMEOUT_MS=45000`,
   `TTS_TOTAL_TIMEOUT_MS=90000`, max 3 attempts within that total.
   Document these new env vars; clamp them to sensible positive bounds.
7. Retry only network failures, 408, 429 and 5xx. Do not retry cancellation,
   400/401/403/404/422 or invalid selected voice. Honor Retry-After seconds/date,
   bounded by remaining deadline; otherwise exponential delay with jitter.
   If Retry-After exceeds the deadline, return retryable error with the delay.
   Failed partial bodies are discarded. Explain that retrying a provider POST
   after disconnect can duplicate provider billing; never retry unboundedly.
8. Return stable error codes (`provider_auth`, `voice_unavailable`, `rate_limited`,
   `provider_timeout`, `network`, `audio_invalid`, `cancelled`, `content_changed`)
   and retryable flag. Avoid raw upstream error bodies in client/log output.
   Reuse existing redaction practices. Never silently retry an auth failure.
9. Validate nonempty plausible MP3 data and duration before storing. Verify
   `appendSilence()` output with actual browser decoding; do not assume arbitrary
   zero payload MP3 frames are universally valid. If invalid, stop using synthetic
   frames, retain provider audio, and handle gaps honestly while a tested pause
   method is implemented. Do not add timer delays as a locked-screen solution.
10. Persist catalogue snapshots; serve stale immediately, refresh with
    `Promise.allSettled`, retain successful pages and previous voices. Cold picker
    refresh has a 5-second response budget and reports refreshing; return known
    saved voices immediately. Refresh failure is not an empty successful catalogue.
    Give server snapshots a one-hour TTL and retry failures after one minute.
11. Emit operation/revision-scoped SSE. UI remains fully usable without SSE;
    request/media events decide state. Deduplicate stage announcements for screen
    readers. Retry/cancel remain available while status stream is disconnected.
12. Record diagnostic timings: local planning, queue wait, upstream time, cache
    hit, transfer, click-to-playing, stall count/duration, cancelled jobs. Log IDs
    and timings only, not article speech or credentials. Keep bounded in-memory
    counters; no new telemetry service.

Exit: pure scheduler tests prove promotion, FIFO, deduplication, reserved slot,
cancelled queued/running jobs and exact slot release; retry policy tests prove
permanent errors get one attempt and cancellation never retries. Deferred
executor functions and fake clocks may exercise the scheduler directly without
mocking network or SQLite. Perform real local HTTP/scratch DB checks separately.

### Phase 5 — downloading, slow connections and bounded caches

Files: `public/narration-cache.js`, player, `public/sw.js`, `server/db.js`,
`server/index.js:sendAudio()`.

1. Use an explicit page-owned downloader for complete small MP3 segments. Fetch
   exact-revision URL, inspect HTTP/error JSON, await bytes, put the complete
   successful 200 response in a dedicated Cache Storage cache, then use a Blob
   object URL for the deck. This makes cancellation/errors/download completion
   observable; it deliberately does not stream partial MP3s in this phase.
2. Cache keys include base/library namespace, article, revision and sequence.
   Persist corresponding manifests. Never cache an error, partial 206, redirected
   login page, or content-type mismatch. Validate bytes before marking available.
   Track server-ready, downloading and locally-available separately.
3. Keep the SW bypass for segment network fetches because the page owns audio
   caching. Exclude narration settings/status/position and mutable manifests from
   generic API fallback. Cache immutable manifests explicitly. Update SW activate
   cleanup to preserve only this app's supported audio cache names; current code
   deletes all unrecognized origin caches. Never delete other base-path installs'
   caches. Version audio cache independently of the app shell.
4. When Cache Storage is unavailable/full, evict least recently used audio then
   retry once; fall back to in-memory Blob playback with a visible offline-cache
   limitation. Use IndexedDB for a small cache index (key, bytes, last access),
   not base64 audio in localStorage. Reconcile index/cache after interrupted writes.
5. Browser audio limit: 64 MiB by default, lowered to at most 10% of reported
   storage quota when `navigator.storage.estimate()` is available. Include explicit
   downloads in this limit. Do not promise permanent offline retention; browsers
   may evict storage. Keep current and next segment resident during playback.
6. Server cache uses byte-based LRU across individual segments and variants.
   Count legacy audio too. Protect only active demand-window segments, not the
   whole article. Evict unprotected segments oldest first. If a newly generated
   segment cannot fit, serve it without persisting; the byte ceiling must hold.
   Keep compact scripts when audio is evicted, cap unused variants per article
   at three after active leases expire, and do not discard a bookmark's mapping.
7. Full matching audio responses get immutable private caching and ETag; no URL
   serves mutable bytes. Implement proper single ranges: N-M, N-, -N, clamp last
   byte, reject unsatisfiable ranges with 416 and `Content-Range: bytes */length`.
   Unsupported multi-range requests may be ignored with a full 200 response.
   Include accurate Content-Length; implement If-Range consistently. Pure range
   parser tests cover zero, suffix, oversized suffix, empty and malformed ranges.
8. Start downloading/synthesizing the requested segment FIRST. Warm only after
   resolved resume/from-here position; never warm zero for a mid-article start.
   Allow one foreground download and one speculative download, deduplicated by
   cache key. Current segment always outranks next, which outranks further ahead.
9. Base prefetch on seconds of audio at playbackRate, not a fixed three segments.
   Start at 30 seconds ahead. On measured slow delivery/repeated buffering grow
   to 60, maximum 90 seconds and six segments. Existing `TTS_WARM_AHEAD` becomes
   the configurable segment-count ceiling (default six); document the semantic
   change. With Save-Data enabled cap speculation at one next segment.
10. Use observed end-to-end ready times (including synthesis) and actual durations
     to adapt. `navigator.connection` is optional; do not depend on it for Safari.
     Sustained download faster than consumption allows buffering; slower sustained
     throughput cannot be fixed by larger queues. Show `Buffering` and offer
     `Download before listening`, rather than claiming uninterrupted playback.
11. Do not await spare-deck readiness to start the current downloaded segment.
     On a stall, preserve offset. Retry one transient client transfer once after
     a short delay; server already retries provider work. Thereafter show Retry.
     Offline state waits for connection or a user action; no tight polling loop.
     Return online resumes a pending operation only if playing intent is still set.
12. Retain at most the current/next Blob URLs plus an in-flight replacement.
     Revoke URLs only after no deck uses them. Pause/clear idle source and remove
     listeners when replaced. Do not load every segment into memory.
13. Add explicit `Download for offline listening` with progress, cancel and remove.
     Estimate size before starting; reject a download that cannot fit the bounded
     cache. Generate/download serially at background priority and never block
     ordinary foreground playback. Offline-ready means every segment AND manifest
     exist locally, checked on open. Partial download is resumable by missing keys.
     A fresh uncached article offline gets a clear unavailable state, not a spinner.
14. On article/reset deletion clear matching browser audio/manifests/bookmarks.
     On content edits invalidate old local variants. Bind cache access to the
     existing authenticated library; clear private audio on explicit logout/reset.
     Document that offline availability permits this device to retain article audio.

Exit: repeat playback generates and downloads zero already-local segments; A→B→A
reuses retained variant; stale URL never returns another voice; budgets hold for
a very long active article; offline fully downloaded article starts without POST
or SSE; cache denial still allows online playback; seek/switch cancels irrelevant
downloads without interrupting another consumer.

### Phase 6 — device validation, tuning and documentation

1. Run the matrix below on actual supported browsers. Desktop emulation does not
   establish iOS audio-session behavior. Report unavailable hardware honestly.
2. Keep the two-deck transport only if it passes at least ten consecutive segment
   transitions while locked/backgrounded on tested iOS Safari/PWA and Android
   Chrome. At any browser-imposed rejection show a truthful paused/blocked state
   on return with one-tap resume at the saved segment; never display fake playback.
3. If the lock-screen test fails, do not label the result seamless or complete.
   First implement a continuous-file mode for explicitly downloaded narration:
   assemble validated same-format MP3 segments in sequence on the server, build
   a segment→time index, serve byte ranges, and use one media source for the whole
   article. Verify MP3 frame/ID3 handling, browser duration and seek accuracy;
   naive `Buffer.concat` without those checks is not an accepted implementation.
   Bound assembly memory/cache and make its bytes count toward cache budgets.
   Continuous downloaded playback must pass the same locked test. Keep its
   bookmark mapped through the segment index so switching transport preserves text.
4. Continuous-file fallback solves prepared/downloaded playback, not immediate
   streaming of uncached long articles. If uncached locked playback still fails,
   record that remaining requirement explicitly and stop claiming full completion;
   a separate measured continuous streaming design is needed. Do not add MSE,
   WebAudio scheduling, or a WebSocket rewrite on the assumption it fixes iOS.
5. Tune chunk size/prefetch only against recorded request counts, time to first
   speech, stall time, memory, and generated-unused audio. Do not increase provider
   concurrency or change the provider model/paid tier without evidence and scope.
6. Update README, `.env.example`, particle skill, and changelog as appropriate.
   Document default/override/lock precedence, no spoken metadata, new resume
   semantics, cache limits, offline behavior, migration and any device limitation.

## 5. Required validation matrix

Run automated pure tests in `node:test`. The repo skill favors no network/DB mocks:
factor algorithms into pure functions and directly exercisable state machines.
Use an isolated manual/scripted local integration harness with a temporary real
SQLite file and local controllable HTTP provider for end-to-end faults. Do not
introduce a test framework. New harness instructions must refuse the real DB path.

| Scenario | Required result |
|---|---|
| Fresh article, chosen default, catalogue+LLM unavailable | Manifest preparation uses chosen ID without waiting on either service. |
| Default changed; article override set/cleared; lock enabled | Exact precedence; no unexpected voice; active playback not interrupted by default save. |
| A→B→C rapidly, completions C/B/A; A→B→A | C remains selected; no overlapping audio; returning A reuses surviving cache. |
| Four old synthesis jobs, seek/new voice | Desired work obtains a reserved slot or cancels obsolete speculation; actual queued promotion proven. |
| Close/back/pause before plan/download/play settles | No later autoplay, reopened player, obsolete message or offset mutation. |
| Same audio element reused before old play rejects/resolves | Old handler cannot pause or seek the new source. |
| 401/403/invalid voice | One provider attempt, actionable error, no automatic fallback voice. |
| 429 with Retry-After; 503; body disconnect; deadline | Bounded correct retry; cancelled job stops; slot count returns to zero. |
| SSE closed/buffered/unavailable | Playback, retry and errors still work; no stale events change active state. |
| Resume near beginning/middle/final seconds/completed | Stable text location; final seconds not reset; completed action is Listen again. |
| Earlier durations change after metadata load | Bookmark/active text unchanged; only approximate time display changes. |
| Browser kill, offline pause, reconnect; two devices | Local checkpoint retained; serialized/CAS saves never silently roll position backward. |
| Listen from selected/visible paragraph; excluded caption | Correct first spoken block, no preceding metadata, keyboard/touch works. |
| Edit/refetch/delete while queued/synthesizing | No stale write/recreation/playback; mapping or explicit changed-content state. |
| Downloaded article offline after browser restart | Starts from cached manifest/audio and correct bookmark; no network dependency. |
| Partial offline cache; quota denied/full | Stops at missing passage with explanation; no skip; online fallback works. |
| Throttle 400 kbps/400 ms RTT; 128 kbps/800 ms RTT; drop connection 15 seconds | No silent loss; buffering/Retry visible; measured recovery; no extra work at article beginning on resume. |
| Playback at 0.85×, 1×, 2× | Correct local offsets, faster-rate buffer demand, no regeneration for speed alone. |
| Locked iOS Safari, installed iOS PWA, Android Chrome | Ten transitions checked; headset/media play/pause/seek; one voice; truthful recovery. |
| Desktop Chrome/Firefox/Safari | Play rejection, seek/range decoding, background return, keyboard and labels verified. |
| Non-root base, auth expiry, demo, TTS disabled | Correct URLs; no login HTML cached as audio; unavailable modes do not call narration routes. |

Performance acceptance targets (report median/p95 and environment; do not invent
numbers or treat a provider's latency as under application control):

- Click acknowledgement/cancel/pause state change within 100 ms.
- Locally cached segment to audible playback within 500 ms on reference desktop;
  within 1 second on tested mobile. Measure from click to `playing` event.
- Cached/manual voice manifest preparation under 250 ms on reference server,
  excluding network transport. No catalogue or LLM call in this measurement.
- Uncached speech: report queue, provider and transfer separately; target under
  5 seconds median on normal connection, but always expose stage and cancel, and
  terminate by configured deadline. Provider misses are recorded, not hidden by
  larger timeouts.
- Normal warm playback: no skipped text or overlapping audio; target gaps below
  250 ms excluding intended recorded pauses. Inspect audibly as well as timestamps.
- No stale generation writes, no duplicate synthesis for the same job, no cache
  growth past configured limits, no permanent maps/listeners/object URL leaks.

## 6. Implementation traps and review checklist

- Don't solve preference by sending `voice_id` while leaving `ensure()` to reuse
  an old voice when the field is absent. Effective voice must precede cache lookup.
- Don't introduce an app-wide request timeout that aborts extraction/OCR. Add
  per-call AbortSignal support to `fetchJson()` and set narration-specific budgets.
- Don't “cancel” only by ignoring a result: remove its speculative queue work and
  propagate an AbortSignal through retries/body reading. Shared consumers matter.
- Don't use `rev` only as a cache-busting query. It identifies immutable content.
- Don't delete A's audio when selecting B. Eviction policy, not recasting, removes it.
- Don't save seconds from a changing total. Display estimates and persistent
  content location have separate responsibilities.
- Don't use a slow UI interval as the only progress recorder or background scheduler.
- Don't trust `preload='auto'` as a download-completion guarantee. Track explicit bytes.
- Don't claim server SQLite cache makes audio available offline on a phone.
- Don't inspect class names only after Readability removed them; test the complete
  extraction→sanitization→script path using realistic markup fixtures.
- Don't silently exclude ambiguous prose. Exact “never metadata” guarantees apply
  to recognized/annotated structure; retain a correction path for unlabeled content.
- Don't add a captions toggle back. User specifically requested captions/metadata
  never be read; tests expecting the old behavior must change.
- Don't mistake mocked media promises for device proof, or silence padding for
  proof of uninterrupted locked-screen playback.
- Don't update narration after a library reset or use a stale bookmark CAS conflict
  as permission to overwrite another device.
- Don't optimize cold startup by synthesizing the entire library on save/open.

## 7. External references checked during planning

These inform narrow protocol/browser decisions, not claims of provider performance:

- [MDN: HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
  — playback returns a promise; rejection must be reflected in UI state.
- [MDN: Range header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)
  — `bytes=-N` requests the last N bytes.
- [MDN: HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)
  — range responses support media seeking and partial retrieval.

## 8. Final handoff required from the implementing agent

Provide: changed files by phase; migrations applied; route/config changes;
automated test results; browser/device matrix with observed outcomes; measured
startup/switch/stall/cache figures; unresolved limitations. Never mark an unrun
device check passed. Record remaining work explicitly if locked uncached playback
is still unreliable. `rtk npm test` must pass before reporting completion.
