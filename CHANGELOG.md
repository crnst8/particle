## Unreleased

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

