# USER-PLAN.md — hosted particle, with accounts

A plan for turning particle from one person's app into a hosted service other
people can sign up for, without turning it into a different application.

**Audience:** a coding agent implementing this with no prior context on the repo.
Read this whole file before writing anything, then read
[`.claude/skills/particle/SKILL.md`](.claude/skills/particle/SKILL.md) for how
particle actually works today. This file says what to build; the skill says what
you are building it on.

Nothing here is built yet. Every path, table and route below is a proposal.

---

## 0. The shape of it, in one paragraph

particle today is one person, one SQLite file, one process, no accounts. Hosted
particle keeps that exactly as it is and adds a mode on top: **Postgres holds
the people, SQLite still holds their libraries — one file each.** A request
arrives, a session cookie identifies the user, and the library routes open that
user's own SQLite file instead of the single global one. Extraction, search,
PDFs, OCR, narration and the entire frontend do not change. That is the whole
design, and everything below is a consequence of it.

---

## 1. Read this first — what must not change

particle is a public, MIT, self-hosted app. The hosted service is a *second
deployment mode of the same codebase*, not a fork and not a rewrite. These are
hard constraints, not preferences:

```
[RULE] Single-user self-hosting keeps working, unchanged and un-degraded.
       With PARTICLE_USERS unset, the app behaves exactly as it does today:
       one file at PARTICLE_DB, optional PARTICLE_PASSWORD, no Postgres, no
       Resend, no accounts. This is the default and the majority of installs.
[RULE] No build step, no bundler, no framework, no TypeScript. See CONTRIBUTING.md.
[RULE] Dependencies stay countable. Postgres access is the only new runtime
       dependency this plan permits (`pg`). Everything else — password hashing,
       tokens, CSRF, rate limits, encryption — is node:crypto and code you write.
[RULE] Do not port server/db.js to Postgres. It is 400 lines of SQLite,
       including FTS5 triggers and audio BLOBs, and it is the highest-risk file
       to touch. It becomes per-user; it does not become Postgres.
[RULE] The three load-bearing safety lines stay exactly as they are — publish.sh
       refuses to release without them:
         server/net.js     `await assertSafeUrl(url);` inside the redirect loop
         server/auth.js    `secure: req.secure,` on the session cookie
         server/index.js   `app.get(api('/health')`
[RULE] Demo mode keeps working. Any new route needs a demo-mode answer, or the
       public demo breaks silently.
[RULE] Never commit a secret. Document env vars by KEY NAME only.
```

**Non-goals.** Teams, sharing, collaboration, public profiles, a mobile app, an
admin web UI, billing, or federation. A hosted particle is the same private
reading library, hosted. If a feature would not make sense for the single-user
install, it is out of scope here.

---

## 2. The decision that matters: where a library lives

This is the one architectural choice, so it gets argued properly. A later agent
should not relitigate it without reading this section.

### The options

**A — everything in Postgres.** One database, `user_id` on every row.
**B — Postgres for accounts, one SQLite file per user for the library.** ← chosen
**C — everything in SQLite,** including accounts, in one shared file.

### Why B

| | A: all Postgres | B: split | C: all SQLite |
|---|---|---|---|
| Rewrite of `server/db.js` | total | none | none |
| Full-text search | rewrite FTS5 → `tsvector` | FTS5 untouched | untouched |
| Narration audio (mp3 BLOBs) | TOAST bloat, backups balloon | stays in SQLite, cheap | cheap |
| Concurrent writers on accounts | good | good | poor (one writer) |
| Per-user backup / export / delete | a query | copy or delete one file | a query, but entangled |
| Horizontal scaling | yes | no — one host's disk | no |
| New dependencies | `pg` | `pg` | none |

The libraries are not concurrent, not relational across users, and not queried
together. They are private documents with an index and a pile of audio. That is
what SQLite is for. Accounts, sessions, verification tokens, quotas and audit
records *are* concurrent and relational, and there is exactly one of that table
set. That is what Postgres is for.

`../__init/INIT.md` §5.2 sets PostgreSQL 16 as the default primary store and asks
you to identify "portable vs centralised data" and "SQLite/file/embedded
candidates". This split **is** that answer, not a departure from it: the
centralised data goes to Postgres, the portable data stays a file. Record it in
`PROJECT.md` as a considered override with this reasoning.

### What B costs, honestly

- **One host.** Libraries are files on a disk, so the app does not scale
  horizontally. A single VPS serving a few hundred readers is the target, and
  that is what the deployment section assumes.
- **Open file handles.** Every active user holds an open SQLite connection. This
  needs an LRU cache with a hard ceiling (§5).
- **Two backup mechanisms**: `pg_dump` and a file sync.

### When to revisit

Move libraries into Postgres only if **all three** become true. Write the
trigger down so it is a measurement, not a mood:

1. more than one app host is genuinely required (a single VPS is saturated), and
2. more than ~2,000 active libraries, and
3. per-user file backup has become the operational bottleneck.

Until then, B is correct and A is a large rewrite bought with no benefit.

---

## 3. Decisions register

Answers to `INIT.md` §5, so the `[DECIDE]` items are closed before feature work.
Copy these into `PROJECT.md` as they are implemented.

### 3.1 Deployment and environments

| Question | Answer |
|---|---|
| Environment model | `dev` (local, Docker/OrbStack) and `prod` (`vpsau2`). No staging — the app is small and prod rolls back by image tag. |
| Isolation | Separate Postgres database, separate library directory, separate secrets, separate domain. Never a shared database. |
| Domain | prod `read.<domain>`; the existing demo stays where it is. |
| Secrets | Environment variables injected by compose from a root-owned `.env` on the host, `0600`. Sourced from Bitwarden, never committed. |
| Database per environment | Yes. |
| CI/CD | The existing GitHub Actions workflow already builds and pushes multi-arch images to GHCR on every push to main. Deployment stays a manual pull-and-restart on the VPS. |
| Rollback | `docker compose pull <previous tag> && up -d`. Postgres migrations must be additive so the previous image still runs against the new schema. **Test the rollback once and write the date in `INFRA.md`.** |
| CDN | Cloudflare in front, proxied. Cache static assets; never cache `/api/`. |
| Scaling | Vertical only, by the decision in §2. |

### 3.2 Data

| Question | Answer |
|---|---|
| Primary database | PostgreSQL 16 — accounts and control plane only. |
| Per-user store | One SQLite file per user, the existing schema, unchanged. |
| Migrations | Postgres: numbered SQL files in `migrations/`, applied in order, recorded in a `schema_migrations` table. SQLite: the existing `if (version < N)` blocks against `PRAGMA user_version`, run on open, per file. |
| Backups | Nightly `pg_dump` plus a nightly rsync of the library directory, both to Cloudflare R2 (free tier), 30 days retained. |
| Restore | Documented in `INFRA.md`, tested once, with the date. |
| Data ownership | A user's library file is theirs: export downloads it, delete removes it. |

### 3.3 Conventions

| Question | Answer |
|---|---|
| Auth model | Email + password, server session in a cookie. |
| Password hashing | `node:crypto` **scrypt**, not bcrypt — see §6.2 for why and for parameters. |
| Authorisation | One rule: a request may only touch its own library. Enforced once, in middleware, by resolving the store from the session. Never per-handler. |
| Email | Resend, transactional only: verify, reset, and a security notice on password change. |
| Env vars | `SCREAMING_SNAKE_CASE`, documented in `.env.example` by key name. |
| Files | kebab-case, matching `server/`. |

---

## 4. Postgres: the control plane

One new module, `server/accounts.js`, owns every query below. Nothing else in the
codebase talks to Postgres.

### 4.1 Schema

`migrations/001_accounts.sql`:

```sql
CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  -- lower(email), written by the app; the uniqueness that actually matters
  email_key       TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,          -- see §6.2 for the encoded format
  verified_at     TIMESTAMPTZ,            -- NULL until the emailed link is followed
  library_key     TEXT NOT NULL UNIQUE,   -- 16 random bytes, base32; names the file
  status          TEXT NOT NULL DEFAULT 'active',   -- active | suspended | deleting
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb  -- see §8; secrets are encrypted values
);

CREATE TABLE sessions (
  -- only the SHA-256 of the token is stored: a stolen database cannot be worn
  token_hash  BYTEA PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  user_agent  TEXT,
  ip          INET
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

-- One table for both flows: they differ only in purpose and lifetime.
CREATE TABLE tokens (
  token_hash  BYTEA PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,              -- verify_email | reset_password
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX ON tokens (user_id, purpose);

-- Rate limiting and quotas that must survive a restart. The in-memory limiter
-- in server/demo.js stays for per-request bursts; this is for the slow counters
-- that decide whether someone may sign up or save another article today.
CREATE TABLE counters (
  scope       TEXT NOT NULL,              -- 'signup:ip:1.2.3.4', 'save:user:12'
  window_at   TIMESTAMPTZ NOT NULL,       -- start of the bucket
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, window_at)
);
CREATE INDEX ON counters (window_at);

-- Security-relevant events only. Not analytics, not page views.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event      TEXT NOT NULL,   -- signup, verify, login, login_failed, logout,
                              -- password_changed, reset_requested, settings_changed,
                              -- export, delete_requested, suspended
  ip         INET,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (user_id, at DESC);
```

Notes a lesser agent will otherwise get wrong:

- **`email_key`, not a lowercase index on `email`.** Keep the address the reader
  typed for display, match on the folded copy. Fold with
  `email.trim().toLowerCase()` only — do not strip dots or `+tags`. Stripping
  them silently merges addresses that are genuinely different at some providers,
  and it is a support problem you cannot undo. Handle `+tag` signup abuse with
  rate limits (§7), not by rewriting people's addresses.
- **`library_key` names the file, `id` does not.** A random key means the
  filename leaks nothing and cannot be guessed from a user id in a URL.
- **`ON DELETE CASCADE` on sessions and tokens** means deleting a user really
  ends their sessions. Deleting the SQLite file is a separate step — see §7.6.

### 4.2 Migrations

```
migrations/001_accounts.sql
migrations/002_....sql
```

On boot, when `PARTICLE_USERS=1`: create `schema_migrations (filename TEXT PRIMARY
KEY, applied_at TIMESTAMPTZ)` if absent, read the directory sorted by name, apply
anything not recorded, each inside a transaction, and record it. No ORM, no
implicit schema change, no down-migrations — roll back by deploying the previous
image, which is why migrations must be additive.

**Additive means:** add tables and nullable columns freely; never rename or drop
a column in the same release that stops using it. Drop it a release later.

---

## 5. Per-user libraries

### 5.1 Where the files live

```
$PARTICLE_LIBRARY_DIR/<library_key>.db     # default: /app/data/libraries
```

Same schema, same migrations, same code as today's single file.

### 5.2 The store cache

`server/db.js` today is a module with module-level state — it opens one database
and exports functions over it. For hosted mode it needs to become **a factory**:
`openLibrary(path)` returning an object with the same function names. The
single-user path then becomes one call to that factory, so there is exactly one
implementation and self-hosting is not a second code path that can rot.

This is the largest mechanical change in the plan and it is a pure refactor:
wrap the existing body in a function, return the exports as an object, change
call sites from `store.getArticle(...)` to the same thing on a resolved store.
Do it as its own commit, with the tests passing, before anything else.

Then, in hosted mode, an LRU:

```
PARTICLE_MAX_OPEN_LIBRARIES   default 64
```

- Key by `library_key`. Opening is cheap; holding thousands open is not.
- Evict least-recently-used past the ceiling, and close on eviction.
- SQLite in WAL mode is safe to close and reopen between requests.
- Never key the cache by anything a request controls other than through a
  verified session.

### 5.3 Resolving the store

One middleware, after the session is resolved, sets `req.store`. Library route
handlers use `req.store` and nothing else. In single-user mode the same
middleware sets it to the one global store. **No handler ever computes a path
from a request parameter.** That is the whole authorisation model, and it is one
line in one place — which is why it can be trusted.

---

## 6. Accounts

### 6.1 New routes

All under `${PARTICLE_BASE}`, registered only when `PARTICLE_USERS=1`.

```
GET    /signup                     the form
POST   /api/auth/signup            {email, password} → 202, always
GET    /verify?token=              follow from email → session + /onboard
POST   /api/auth/verify/resend     {email} → 202, always
GET    /login                      the form
POST   /api/auth/login             {email, password} → session cookie
POST   /api/auth/logout            clears the session
POST   /api/auth/forgot            {email} → 202, always
GET    /reset?token=               the form
POST   /api/auth/reset             {token, password} → session, ends all others
GET    /api/me                     {email, verified, created_at, usage, settings}
PATCH  /api/me/settings            per-user settings (§8)
POST   /api/me/password            {current, next} → ends every other session
GET    /api/me/export              the raw SQLite file, as a download
POST   /api/me/delete              {password} → schedules deletion (§7.6)
```

`202, always` is deliberate and appears three times: signup, resend and forgot
must answer identically whether or not the address is registered. Anything else
is an account-existence oracle. Do not "helpfully" return `already registered`.

### 6.2 Passwords

**Use `node:crypto` scrypt.** `INIT.md` §3.2 defaults to bcrypt; this is a
recorded override with a reason: bcrypt is a native module that needs a compiler,
and particle has no build step and seven dependencies. scrypt is in Node core, is
memory-hard, and costs nothing to add.

```
format:  scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
params:  N = 16384, r = 8, p = 1, keylen = 64, salt = 16 random bytes
call:    crypto.scrypt(password, salt, 64, { N, r, p, maxmem: 32 * 1024 * 1024 })
```

Three things that will otherwise bite:

1. **`maxmem` must be raised.** Node's default is 32 MB and `128 * N * r` at
   these parameters is exactly 16 MB; the default leaves no headroom for the
   parallelisation factor and throws `ERR_CRYPTO_INVALID_SCRYPT_PARAM`. Pass
   `maxmem` explicitly.
2. **Serialise the hashing.** Each hash costs ~16 MB. A burst of login attempts
   would otherwise be a memory exhaustion attack against your own process. Put
   hashing behind a small concurrency gate — `server/narrator.js` already
   contains one worth copying, `withSlot`.
3. **The parameters are in the string** so they can be raised later. On a
   successful login, if the stored parameters are below current policy, rehash
   and store. Compare with `crypto.timingSafeEqual`, never `===`.

Policy: minimum **12 characters**, no composition rules, no maximum below 200.
Reject the ~200 most common passwords from a small list in the repo. Do not add
a password-strength dependency; length is the part that matters and a list of
200 catches the rest.

**On a login failure, always run a hash anyway** against a fixed dummy value, so
a missing account and a wrong password take the same time.

### 6.3 Sessions

Extend `server/auth.js` rather than replacing it. It keeps its current job (the
single-password mode) and gains a second: when `PARTICLE_USERS=1`, resolve a
session from Postgres.

- Token: 32 random bytes, base64url. Cookie holds the token; Postgres holds
  `sha256(token)`.
- Cookie: `httpOnly`, `sameSite: 'lax'`, `path: base || '/'`, 30 days,
  and — **exactly as today** — `secure: req.secure`. Hard-coding it `true`
  breaks every LAN and tailnet install, which is why `publish.sh` scans for it.
- Rotate the token on login and on password change. Delete every other session
  on password change and on reset.
- Sweep expired rows hourly.
- Update `last_used_at` at most once a minute per session; a write per request
  is a needless write per request.

### 6.4 Email

Resend, free tier — 3,000/month and 100/day, comfortably inside a self-signup
service of this size. Three templates, all plain text and short:

- **verify** — one link, 24-hour expiry
- **reset** — one link, 1-hour expiry, single use
- **password changed** — no link, a notice with a contact address

Wrap it in `server/mail.js` behind one function so the provider can change.
When the daily cap is reached or Resend is down: **do not fail the signup.**
Record the user, log it, and let the reader use the resend route. An email
provider outage must not look like a broken signup form.

---

## 7. Security on an open signup

An internet-facing particle is a URL fetcher, a PDF parser, an OCR engine and a
paid TTS account that strangers can point at things. Treat every one of those as
a resource someone will try to spend.

### 7.1 The one that matters most: SSRF

`server/net.js` already re-checks `assertSafeUrl` on **every redirect hop**. That
is what stops a 302 to `169.254.169.254` or a LAN box being fetched on your
behalf. On a hosted instance:

```
[RULE] ALLOW_PRIVATE_HOSTS must never be set. Refuse to boot if
       ALLOW_PRIVATE_HOSTS=1 and PARTICLE_USERS=1 are both set.
```

Also cap outbound work globally, not just per user — one process, one shared
egress budget — and set a per-user ceiling on saves per hour (§7.3).

### 7.2 Rate limits

Two layers. `server/demo.js` already exports an in-memory `rateLimit({limit,
windowMs})`; use it for bursts. Use the `counters` table for anything that must
survive a restart or a deploy.

| Route | Limit | Where |
|---|---|---|
| `POST /api/auth/signup` | 3 / hour / IP, 20 / day / IP | counters |
| | 1 / hour / email address | counters |
| `POST /api/auth/login` | 10 / 15 min / IP | memory |
| | 5 consecutive failures / account → 15 min lock, doubling to 24 h | counters |
| `POST /api/auth/forgot` | 3 / hour / IP, 3 / day / email | counters |
| `POST /api/auth/verify/resend` | 3 / hour / email | counters |
| `POST /api/articles` | 30 / hour / user, 200 / day / user | counters |
| `POST /api/handoff` | 10 / hour / IP | memory |
| `GET /api/articles/:id/narration/:seq` | 300 / hour / user | memory |
| everything else under `/api/` | 300 / 5 min / user | memory |

Behind Cloudflare, `req.ip` is the proxy unless `PARTICLE_TRUST_PROXY=1` is set
and `app.set('trust proxy', 1)` runs — which the app already does. **Verify this
before relying on any per-IP limit**, or every visitor shares one bucket.

### 7.3 Quotas

Per user, checked before the work starts and reported in `GET /api/me`:

```
PARTICLE_QUOTA_ARTICLES        default 2000
PARTICLE_QUOTA_LIBRARY_MB      default 500     # the whole .db, audio included
PARTICLE_QUOTA_SAVES_PER_DAY   default 200
PARTICLE_QUOTA_OCR_PAGES_DAY   default 50      # OCR is the most expensive path
PARTICLE_QUOTA_TTS_CHARS_DAY   default 40000   # only when the shared key is used
```

Over quota returns `429` with a plain sentence the reader can act on, never a
silent failure. Library size is `stat()` on the file, cached for a minute.

### 7.4 CSRF

`INIT.md` §7.1 makes this a rule wherever cookie auth applies.

- `SameSite=Lax` on the session cookie — already the case.
- **Reject state-changing requests whose `Origin` does not match** the app's own
  origin. One middleware over every non-`GET`/`HEAD` under `/api/`. This is the
  whole defence and it needs no token plumbing on a same-origin app.
- Reject `application/x-www-form-urlencoded` and `multipart/form-data` on `/api/`
  routes. Those are the content types a cross-origin form can send without a
  preflight; JSON cannot be sent cross-origin without one.

**One exception, and understand it before you touch it.** `POST /api/handoff`
takes `text/plain` from an archive.today tab, cross-origin, deliberately: it is
how a reader rescues a page after clearing a captcha. It is not CSRF-exposed
because it carries a single-use, unguessable, 15-minute ticket instead of a
cookie (`server/handoff.js`). Keep it exempt from the Origin check and keep its
own rate limit. Do not "fix" it by requiring a session — that breaks the feature.

### 7.5 Headers and CORS

Applied globally, once, not per route:

```
Content-Security-Policy    default-src 'self'; img-src 'self' data: blob:;
                           media-src 'self' blob:; style-src 'self';
                           script-src 'self'; frame-ancestors 'none';
                           base-uri 'none'; form-action 'self'
Strict-Transport-Security  max-age=63072000; includeSubDomains
X-Content-Type-Options     nosniff
Referrer-Policy            no-referrer
Cross-Origin-Opener-Policy same-origin
Permissions-Policy         geolocation=(), camera=(), microphone=()
```

CORS: no cross-origin access at all, except the single handoff route.

**Before shipping the CSP, load the reader and check the console.** Article HTML
is sanitised by DOMPurify and rendered inline, images go through `/api/image`,
and narration audio is a same-origin URL — so `'self'` should hold. Verify it
rather than assuming it; a CSP that breaks the reader is worse than none.

### 7.6 Deletion and export

- **Export** streams the user's SQLite file. It is the whole library — articles,
  lists, positions, narration audio — and it opens in any SQLite browser. That is
  the point: a hosted account is not a lock-in.
- **Delete** sets `status='deleting'`, ends every session, and unlinks the file
  on a sweep 7 days later — long enough to undo a mistake by asking, short enough
  to be an honest promise. Postgres rows go with the row delete; keep the
  `audit_log` entry with a null user id.

### 7.7 Abuse

Suspension is manual and blunt: `status='suspended'` returns `403` on everything
but export. Add an operator CLI (`node server/admin.js …`) for list, suspend,
unsuspend, delete. **No admin web UI** — it is a second auth surface to get
wrong, and `INIT.md` §2 puts admin surfaces on Tailscale anyway.

---

## 8. Env vars, and which of them become settings

Today every knob is an env var because there is one user and they own the
server. Hosted, an env var is an operator's decision and a setting is a reader's.
Sort every one of them into exactly one column.

### 8.1 Operator only — never a setting

`PORT`, `PARTICLE_DB`, `PARTICLE_BASE`, `PARTICLE_TRUST_PROXY`,
`PARTICLE_LIBRARY_DIR`, `PARTICLE_MAX_OPEN_LIBRARIES`, `DATABASE_URL`,
`PARTICLE_SESSION_SECRET`, `PARTICLE_SECRET_KEY`, `RESEND_API_KEY`,
`ALLOW_PRIVATE_HOSTS` (must be unset), every `PARTICLE_QUOTA_*`,
`SNAPSHOT_MAX_BYTES`, `IMAGE_MAX_BYTES`, `PDF_MAX_*`, `OCR_*`,
`TTS_MAX_CACHE_MB`, `TTS_CONCURRENCY`, `TTS_WARM_AHEAD`, `ARCHIVE_TODAY_*`.

These are capacity and safety. A reader who could set them could spend your
server or reach your network.

### 8.2 Per user — a setting, stored in `users.settings`

| Setting | Why it belongs to the reader |
|---|---|
| `llm.key`, `llm.url`, `llm.model` | Tagging costs money per call. Bring your own. |
| `tts.key`, `tts.url`, `tts.model` | Same, and more so — narration is the expensive one. |
| `tts.voice_id`, `tts.voice_lock` | Taste. |
| `narration.enabled`, `llm.enabled` | Off by default; a reader opts in. |
| `locale`, `email.notify` | Preference. |

Display preferences — theme, accent, typeface, size, where read articles show up
— **stay in `localStorage` and do not move.** A phone and a laptop read the same
library differently, on purpose. Do not "improve" this by syncing them.

### 8.3 The shared-key question

You will want to let people try narration without pasting a key. Do it like this
and it stays free-tier on your side:

```
PARTICLE_SHARED_TTS=1          # offer the operator's key
PARTICLE_SHARED_TTS_TRIAL=20000 # characters, lifetime, per account
```

Under the trial the operator's key is used and the characters are counted in
`counters`. Past it, narration says plainly that the trial is used up and points
at the setting. The same shape works for the LLM key. **Default both to off.**
An operator who has not thought about it should not be paying for strangers.

### 8.4 Storing a reader's key

A reader's API key is a secret you are holding on their behalf.

- Encrypt with `AES-256-GCM` from `node:crypto`, key from `PARTICLE_SECRET_KEY`
  (32 bytes, base64). Store `iv:ciphertext:tag`, base64, in the `settings` JSONB.
- **Never return it.** `GET /api/me` returns `{ llm: { key_set: true } }` and the
  last four characters at most. There is no read-back route.
- Refuse to boot with `PARTICLE_USERS=1` and no `PARTICLE_SECRET_KEY`. Do not
  generate one silently — a generated key that is lost is every reader's keys
  lost with it.
- Rotation: keep `PARTICLE_SECRET_KEY_OLD` accepted on read for one release, so
  a rotation is a deploy and a background re-encrypt rather than a data loss.

---

## 9. Landing → signup → onboard

`landing/` already exists and is served at `/` in demo mode. Hosted, it is served
at `/` for signed-out visitors. Reuse it — do not build a second marketing page.

```
  /                 landing        what it is, three screenshots, "try it" → demo,
                                   "create an account" → /signup
  /signup           form           email + password, one screen, no confirm field
  ↓ 202
  "check your email"               plain page, resend link, no account created
  ↓ the emailed link
  /verify?token=    → session      verified, library file created, straight in
  ↓
  /onboard          three steps    save something · install it · make it yours
  ↓
  /                 the library
```

### The onboard, and why it is only three steps

`INIT.md` §8.3: Hick's law says fewer choices, always a default; Goal-Gradient
says show progress; Zeigarnik says an unfinished thing is what gets remembered.
Three steps, each skippable, progress shown, nothing required.

1. **Save something.** A URL field with three suggested articles beside it. The
   reader watches a real save happen. This is the whole product in one action —
   if they only ever do step one, the account was worth making.
2. **Reach it from anywhere.** The bookmarklet to drag, and — on iOS and Android
   — "add to home screen", which is how particle is actually used. The app is
   already a PWA; this step just points at it.
3. **Make it yours.** Theme and typeface, then the optional keys with one honest
   line each about what they cost and that they are not required.

Do not ask for a name. Do not ask what they read. Do not send a welcome tour.

**Signed-out routing:** every app route redirects to `/login` with the
destination remembered, except `/`, `/signup`, `/login`, `/verify`, `/reset` and
`/api/health` — which stays open, because the Docker healthcheck and the CI
smoke job both poll it.

---

## 10. Deployment

Target `vpsau2`, per `INIT.md` §2 and §10.2. Before anything, in this order:

1. read the host nginx config shape
2. list running containers
3. check host port usage — **assign a port only after this**
4. confirm the DNS target in Cloudflare
5. confirm TLS (host nginx + existing certbot; do not add a containerised nginx)
6. confirm env injection (root-owned `.env`, `0600`)
7. confirm the backup target exists before there is data to lose
8. confirm the rollback path — and run it once

```
particle-app   the existing image, PARTICLE_USERS=1, volume for libraries
particle-db    postgres:16-alpine, volume, no published port
```

Both on an internal compose network. **Postgres publishes no host port.** Host
nginx reverse-proxies the app port only.

nginx needs two things beyond the default proxy block:

- `proxy_buffering off;` on `/api/` — the narration status endpoint is an event
  stream and buffering turns it into nothing. (The app already sends
  `X-Accel-Buffering: no`; set both.)
- `client_max_body_size` at least `SNAPSHOT_MAX_BYTES` (8 MB), or the
  archive.today rescue fails on large pages.

Cloudflare: proxied, cache static assets, bypass `/api/`. Long-lived event
streams work through Cloudflare's proxy; if they misbehave, a page rule that
bypasses cache for `/api/` is the fix.

Backups, both to R2, nightly, 30 days:
`pg_dump` and an rsync of the library directory. **A backup you have not
restored is a hypothesis.** Restore one into a scratch container, open the
library, and write the date in `INFRA.md`.

---

## 11. Implementation order

Each phase ends with something demonstrable and `npm test` green. Do not start a
phase before the one above it works. Estimates assume an agent that reads the
skill first.

| # | Phase | Ends when | Rough size |
|---|---|---|---|
| 1 | **`db.js` becomes a factory.** `openLibrary(path)` returns the store; single-user calls it once. No behaviour change, no Postgres. | full test suite passes, app runs identically, diff touches only `db.js` and its call sites | half a day |
| 2 | **Postgres and migrations.** `pg`, `server/accounts.js`, the migration runner, `001_accounts.sql`. Nothing uses it yet. | `PARTICLE_USERS=1` boots, migrates, and `/api/health` reports the connection | half a day |
| 3 | **Signup, verify, login, session.** Including scrypt, the hashing gate, the `202, always` answers, and the audit log. | a real account can be made, verified by email and signed into | 1–2 days |
| 4 | **Store resolution.** The LRU, the middleware, `req.store` through the library routes. | two accounts see two libraries, and no handler computes a path | 1 day |
| 5 | **Security pass.** Rate limits, quotas, Origin check, headers, the `ALLOW_PRIVATE_HOSTS` boot refusal. | every row of §7.2 has a test or a checked-off manual verification | 1–2 days |
| 6 | **Settings and secrets.** `users.settings`, AES-GCM, per-user LLM/TTS keys, the shared-key trial. | a reader pastes a TTS key and narration uses theirs, not the operator's | 1 day |
| 7 | **Landing, signup, onboard.** | a stranger gets from the landing page to a saved article without help | 1–2 days |
| 8 | **Export, delete, admin CLI.** | export opens in a SQLite browser; delete really deletes, after 7 days | half a day |
| 9 | **Deploy.** §10, in order, rollback tested. | it is running, and the restore has a date next to it | 1 day |

**About a fortnight of focused work.** Phases 1 and 4 carry the risk; 3 and 5
carry the consequences of getting it wrong.

### Tests

`node:test`, the repo's own runner, no framework. The repo convention is that
new logic is reachable by a pure function so it can be tested without network or
database — hold to it:

- password encode/verify round-trip; a wrong password fails; parameters upgrade
- token hashing; an expired token; a used token; a single-use token used twice
- the settings encrypt/decrypt round-trip, and that decryption fails on a
  tampered ciphertext
- email folding — `A@B.com` and `a@b.com` are one account; `a+1@b.com` is not
- quota arithmetic and window rollover, as pure functions over a clock you pass in
- the Origin check: same origin passes, cross origin fails, the handoff route is
  exempt

---

## 12. Definition of done

From `INIT.md` §11. State which you ran, which you skipped, and why. Do not
paraphrase a run you did not do.

```
[CHECK] every §3 decision is in PROJECT.md, or deferred in writing with a reason
[CHECK] npm test passes
[CHECK] ./dev.sh start brings the stack up from a clean checkout; stop frees every port
[CHECK] with PARTICLE_USERS unset the app is byte-for-byte the app it was —
        no Postgres, no accounts, no new required env var
[CHECK] the three load-bearing lines in §1 are intact; ./publish.sh check passes
[CHECK] demo mode still works
[CHECK] two accounts cannot see each other's libraries — verified by trying
[CHECK] every §7.2 rate limit verified, behind the proxy, with a real client IP
[CHECK] no secret in the repo, the logs, or the response bodies
[CHECK] a reader's stored API key cannot be read back through any route
[CHECK] the CSP does not break the reader — checked in a browser console
[CHECK] backups run; a restore has been done once and the date is in INFRA.md
[CHECK] rollback has been done once
[CHECK] README, .env.example, INFRA.md, PROJECT.md and the particle skill updated
```

---

## 13. Traps

Hard-won from this codebase, and each one costs an afternoon:

- **`secure: req.secure` on the session cookie.** Hard-code it `true` and every
  LAN and tailnet install signs in and is signed straight back out.
- **`/api/health` must stay open and unauthenticated.** The Docker healthcheck
  and the CI smoke job both poll it. A container that fails its healthcheck
  restarts forever.
- **`req.ip` is the proxy** until `PARTICLE_TRUST_PROXY=1`. Every per-IP limit
  is decoration until you have checked this against a real request.
- **`POST /api/handoff` is deliberately cookie-less and cross-origin.** It is
  protected by a single-use ticket. Do not require a session on it.
- **Narration audio lives in the library file.** A 500 MB quota is mostly mp3.
  `TTS_MAX_CACHE_MB` prunes per library, so it must be set *below* the per-user
  quota or the quota is what the reader hits first.
- **`cache.addAll()` in `public/sw.js` fails as a whole if one entry 404s.** If
  you add a signed-out page to the shell, add it to `SHELL_ASSETS` only if it
  always exists — and bump both cache names.
- **An event stream must not be cached or buffered.** The service worker skips
  `text/event-stream`; nginx needs `proxy_buffering off`. Miss either and the
  live narration status silently shows nothing.
- **`scrypt` throws on the default `maxmem`** at any sensible `N`. Pass it.
- **Do not fold `+tags` out of email addresses.** It merges real accounts and
  you cannot un-merge them.

---

## 14. Open questions

Answer these in `PROJECT.md` before phase 3. None of them blocks phase 1 or 2.

1. **Open signup, or invite codes first?** An invite list is one table and one
   check, and it makes every abuse limit in §7 a second line of defence rather
   than the only one. Recommended for the first months.
2. **What is the free tier?** §7.3 proposes numbers with no evidence behind
   them. Measure a real library — the one in `data/` — and set them from that.
3. **Who is the operator, legally?** A hosted service holding other people's
   reading histories wants a privacy note on the landing page saying what is
   stored, where, for how long, and that export and delete are one click. One
   short honest page, before the first stranger signs up.
