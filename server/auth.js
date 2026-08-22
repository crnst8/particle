import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COOKIE_NAME = 'particle_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=');
    if (at < 0) return ['', ''];
    const value = part.slice(at + 1).trim();
    try {
      return [part.slice(0, at).trim(), decodeURIComponent(value)];
    } catch {
      return [part.slice(0, at).trim(), value];
    }
  }).filter(([key]) => key));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function loadSecret({ dbPath, persist }) {
  if (process.env.PARTICLE_SESSION_SECRET) return process.env.PARTICLE_SESSION_SECRET;
  if (!persist) return randomBytes(32).toString('hex');

  const path = join(dirname(dbPath), '.particle-session-secret');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, secret, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return secret;
}

function sign(expires, secret) {
  return createHmac('sha256', secret).update(String(expires)).digest('base64url');
}

function validSession(value, secret) {
  const [expiresRaw, signature] = String(value || '').split('.');
  const expires = Number(expiresRaw);
  return Number.isFinite(expires)
    && expires > Date.now()
    && safeEqual(signature || '', sign(expires, secret));
}

function loginPage({ action, error = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sign in — particle</title><style>
:root{color-scheme:light dark;font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f7f6f3;color:#141414}
@media(prefers-color-scheme:dark){:root{background:#131311;color:#e8e5de}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1.5rem}main{width:min(22rem,100%)}
h1{font-size:1.3rem;margin:0 0 1.5rem}form{display:flex;border-bottom:2px solid currentColor}input{min-width:0;flex:1;border:0;background:none;color:inherit;padding:.7rem 0;font:inherit;outline:none}button{border:0;background:none;color:#d64b2f;font:inherit;cursor:pointer;padding:.7rem}.error{color:#d64b2f;font-size:.85rem}
</style></head><body><main><h1>particle</h1>${error ? '<p class="error">wrong password</p>' : ''}
<form method="post" action="${action}"><input name="password" type="password" placeholder="password" aria-label="Password" autofocus required><button>sign in</button></form>
</main></body></html>`;
}

export function createAuth({ base = '', dbPath, persistSecret = true, openPaths = [] } = {}) {
  const password = process.env.PARTICLE_PASSWORD || '';
  if (!password) return (_req, _res, next) => next();

  const secret = loadSecret({ dbPath, persist: persistSecret });
  const loginPath = `${base}/login` || '/login';
  const logoutPath = `${base}/logout` || '/logout';
  const healthPath = `${base}/api/health` || '/api/health';
  const cookiePath = base || '/';

  return (req, res, next) => {
    const inApp = !base || req.path === base || req.path.startsWith(`${base}/`);
    // openPaths carry their own single-use token instead of the session cookie.
    if (!inApp || req.path === healthPath || openPaths.includes(req.path)) return next();

    if (req.path === logoutPath) {
      res.clearCookie(COOKIE_NAME, { path: cookiePath });
      return res.redirect(loginPath);
    }

    if (req.path === loginPath && req.method === 'GET') {
      return res.type('html').send(loginPage({ action: loginPath }));
    }
    if (req.path === loginPath && req.method === 'POST') {
      if (!safeEqual(req.body?.password || '', password)) {
        return res.status(401).type('html').send(loginPage({ action: loginPath, error: true }));
      }
      const expires = Date.now() + MAX_AGE_SECONDS * 1000;
      res.cookie(COOKIE_NAME, `${expires}.${sign(expires, secret)}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: MAX_AGE_SECONDS * 1000,
        path: cookiePath,
      });
      return res.redirect(base || '/');
    }

    if (validSession(parseCookies(req.headers.cookie)[COOKIE_NAME], secret)) return next();
    if (req.path.startsWith(`${base}/api/`)) return res.status(401).json({ error: 'authentication required' });
    return res.redirect(loginPath);
  };
}
