## 1.4.0 — 2026-10-08

- feat: tts upgrades
- status: 2026-10-06

## Unreleased — narration

- feat: a default voice for the library, chosen in settings from the whole
  searchable catalogue (with samples), shared by every device; or Automatic,
  which picks once per article and keeps it. Any article can have its own voice,
  and the player says where the voice came from. `TTS_VOICE_LOCK` shows the
  locked voice and refuses changes
- feat: listen from here (select text), listen from the visible paragraph, and
  Listen / Resume / Listen again / Start over in the reader
- feat: skip a paragraph when reading aloud, or read one particle guessed was
  furniture; saved with the article, without marking it trimmed
- feat: download an article for offline listening; it plays with no connection
- feat: settings → narration; `TTS_REQUEST_TIMEOUT_MS`, `TTS_TOTAL_TIMEOUT_MS`
- change: captions, credits, bylines, datelines, reading times, tables and code
  are never read, and there is no spoken intro or outro. The read-captions
  switch is gone. Passages are one paragraph at most, about 300 characters
  (`TTS_SEGMENT_CHARS` now caps at 450 by default); `TTS_WARM_AHEAD` is now a
  ceiling (default 6) on a 30–90 second window
- change: narration no longer asks the LLM to cast or direct; pacing is fixed
  by the text
- change: the bookmark is a passage, not seconds. Old bookmarks convert to the
  paragraph they pointed at the first time each article is opened
- fix: a late reply, a slow download or an old play() can no longer restart,
  pause or seek a newer session; closing while loading stays closed
- fix: a passage that fails is no longer skipped; Retry, Choose voice and Skip
  passage are offered. A refused play shows "tap play to continue", never a
  playing state over silence
- fix: choosing voice B no longer deletes voice A's audio, and a stale audio URL
  can no longer return a different voice
- fix: provider calls have one deadline covering retries and reading the body;
  401/403/404 are not retried; Retry-After is honoured; work nobody is waiting
  for is cancelled
- fix: `bytes=-N` ranges, 416 answers, ETags; the server audio ceiling holds for
  a single long article
- fix: silence after a passage updates the mp3's Xing/Info frame count
- fix: bookmark saves no longer re-index the article for search
- schema: v4. Back up `particle.db` first; older builds refuse a v4 library

## 1.3.4 — 2026-09-15

- chore: cleanup
- fix: reading state + tagging fix

## 1.3.3 — 2026-09-03

- feat: screenshot link extraction (beta)

requires LLM key

## 1.3.2 — 2026-09-03

- fixes overlapping voice bug
- fixes audio timeout without recovery
- fixes slow loadtime on tts recast
- fixes default narration casting

## Unreleased

- feat: settings shows whether tagging is on, how many articles have no tags,
  and a button that tags them — a library saved before the key was set no
  longer has to be re-saved article by article. A failing provider is reported
  there too; it used to be indistinguishable from one never configured
- fix: OpenCode Go began refusing requests that carry no `x-opencode-session`,
  which silently turned tagging, casting and screenshot reading off for anyone
  on the default endpoint. Every call now carries one, and identifies itself
- fix: the screenshot progress row — spinner, "reading…", cancel — showed on
  every page load, next to the URL field, whether or not a screenshot was being
  read. Its `display: flex` overrode the `hidden` attribute

- feat: save an article from a screenshot of it. Hand particle a picture — the
  TikTok that mentioned the piece, a newsletter in someone's inbox, a paper's
  title page — and it reads what the picture refers to and looks the article up
  in the publishing platforms' own archives, which costs nothing. A candidate is
  only saved when its title, date and byline agree with the picture; two of the
  addresses these names guess are real publications holding the wrong articles
- feat: a link that resolves but will not open is saved as a link, under its real
  title and byline, rather than lost
- feat: the PWA share target accepts an image, so a screenshot can be shared
  straight into particle
- feat: a screenshot save reports itself stage by stage while it runs — a save
  that can take a minute should not look like a hang for any of it
- perf: the picture is re-encoded before it is sent to the model. A phone
  screenshot is a lossless PNG of a photograph, and JPEG at the same resolution
  is five to eight times smaller; nothing is resampled at phone sizes
- perf: candidates are looked up in parallel, and only the surest few at all
- feat: a find the picture confirmed twice over is filed rather than offered;
  whatever else the picture named is offered underneath it
- feat: every stage of a screenshot save is logged with timings, and the
  container's log is capped so it cannot fill a disk
- fix: a hostname read off a screenshot, or taken from a publisher's API reply,
  is now checked to be only a hostname before it is put into a URL — `a@169.254.
  169.254` is not a request to `a`
- fix: the screenshot log redacts key-shaped text, since some providers take
  their key in the query string and echo the request back in an error
- fix: a screenshot shared in but never collected no longer sits in the
  browser's cache; a later ordinary load clears it
- fix: a vision model's reply is now read even when it arrives fenced, prefaced
  with a sentence, or cut off at the token limit — a reply that ran out of budget
  mid-object used to lose every article in it, not just the last one
- fix: the URL field is replaced by the progress while a screenshot is read,
  with the stage, the elapsed time and a cancel, rather than sitting there idle
- fix: a caption set as large as the headline above it is no longer read as part
  of that headline when there is no vision model and OCR is doing the reading

- fix: casting no longer lands on one voice for the whole library — a voice is
  scored on how much of the article's register it covers *and* how much of the
  voice that register is, clones of one narrator collapse to a single entry, and
  the voices heard most recently give way to ones that have not been
- fix: narration direction was under-budgeted for a reasoning model, so every
  cast silently fell back to the heuristic
- fix: overlapping voices after a phone wakes — a `play()` that settles on a deck
  already abandoned no longer starts it
- fix: narration that stopped with the screen off and needed the app restarted
  now picks itself back up when the page is next in front of someone
- feat: the player says what it is waiting for, live, streamed from the server
- feat: the voice picker ranks the catalogue for the article you are reading

## 1.3.1 — 2026-09-03

- feat: ocr start for pdf

## 1.3.0 — 2026-09-03

- feat: PDF extraction

This release adds basic PDF extractor tools. OCR & image parsing to come.

## 1.2.1 — 2026-08-27

- feat: reader overhaul & better visual feedback

## 1.2.0 — 2026-08-24

- **Settings page**: theme, accent, typeface & size defaults, library vis, lists & reset
- **Delete items**: you can now delete items, an overlooked feature
- **Adjusted view**: simplified the logo & ux

## 1.1.1 — 2026-08-23

- fix: lockscreen playback & tts fine-tuning

## 1.1.0 — 2026-08-23

- feat: add tts via fish.audio

## 1.0.1 — 2026-08-22

- Release 1.0.1.

## 1.0.0 — 2026-08-22

- fix: verify release package publishing
- feat: archive dot * functionality
- feat: archive dot * handling
- Initial public release

