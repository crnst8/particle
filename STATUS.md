---
summary: Self-hosted read-later app: URL to article extraction (Readability/PDF/OCR) into a searchable SQLite library, with optional LLM tagging and TTS.
brief: Paused after the narration upgrade release in October. Waiting on your decision about turning it into a hosted service with accounts.
state: paused
priority: 2
updated: 2026-11-24
next: Read the first section of `USER-PLAN.md` and decide whether hosted accounts go ahead.
---

# particle status

## Where it stands
Release 1.4.0 (tag `v1.4.0`, GitHub release 2026-10-08) shipped the narration upgrade: a
default voice from the full catalogue, listen from a selection or paragraph, offline
download of narrated articles, and many playback fixes (see `CHANGELOG.md`). No work since.
`USER-PLAN.md` (now committed) proposes a hosted service with accounts; nothing in it is built.
`TTS-PLAN.md` records the narration design.

## Done since 2026-10-06
- Narration upgrade (21f8d0a): voice catalogue and default voice, listen-from-here, skip
  passage, offline narration, narration settings, passage-based bookmarks, retry/timeout
  fixes, HTTP range fixes; new narration tests and `tools/narration-harness.mjs`.
- Released 1.4.0 (f32bbd9).

## Next
1. Read the first section of `USER-PLAN.md` and decide whether hosted accounts go ahead.
2. If it goes ahead, start at its first milestone; if not, move it out of the repo.

## Waiting on you
- Decision on the hosted-accounts plan in `USER-PLAN.md`.

## Loose ends
- `CHANGELOG.md` keeps an "Unreleased — narration" heading below 1.4.0 for changes that
  shipped in 1.4.0 (unverified whether intended).
- Status-only commits not pushed. Working tree clean.
