# Contributing

particle is a small, opinionated personal tool that happens to be open source.

## Good things to send

- **Extraction fixes.** A site that particle mangles or refuses is the most
  useful bug report there is. Include the URL and what you got instead.
- **Self-hosting friction.** Anything that made the install harder than
  "one command" is a bug.
- **Small, focused fixes** with a clear before/after.

## Things that probably won't land

Multi-user accounts, a hosted service, plugin systems, a rewrite in another
framework, or anything that adds a build step to the frontend. particle is
deliberately four dependencies and no bundler.

Feel free to fork!
## Working on it

```sh
npm ci
npm run dev     # node --watch on http://localhost:4747
```

Node 24+ (`node:sqlite` is built in). No build step: `public/` is served as-is,
so edit and reload.

Where things live:

| Path | What |
|---|---|
| `server/extract.js` | Fetch + Readability + the paywall fallback chain |
| `server/db.js` | SQLite schema, FTS, queries |
| `server/index.js` | Routes |
| `server/llm.js` | Optional tagging pass |
| `public/app.js` | The whole frontend |

## Before opening a PR

- Keep the diff to one concern.
- Match the surrounding style; it's plain modern JS, no framework, comments
  only where the *why* isn't obvious.
- Say what you tested. There is no test suite yet; "saved these five URLs and
  checked the reader" is a legitimate answer.

## Reporting a security issue

Don't open a public issue, see [SECURITY.md](SECURITY.md).
