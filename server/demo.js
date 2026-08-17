import { readFile } from 'node:fs/promises';

export function rateLimit({ limit, windowMs = 60_000 }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (clients.size > 2048) {
      for (const [client, entry] of clients) {
        if (entry.resetAt <= now) clients.delete(client);
      }
      while (clients.size > 10_000) clients.delete(clients.keys().next().value);
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = clients.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    entry.count += 1;
    clients.set(key, entry);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > limit) return res.status(429).json({ error: 'rate limit exceeded; try again shortly' });
    next();
  };
}

export function createDemoSeed({ extractArticle, urlsPath, fallbackPath }) {
  const promise = (async () => {
    const [urlText, fallbackText] = await Promise.all([
      readFile(urlsPath, 'utf8'),
      readFile(fallbackPath, 'utf8'),
    ]);
    const urls = urlText.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const settled = await Promise.allSettled(urls.map(url => extractArticle(url)));
    const extracted = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    const fallback = JSON.parse(fallbackText);
    return [...extracted, ...fallback].slice(0, Math.max(3, extracted.length));
  })().catch(async () => JSON.parse(await readFile(fallbackPath, 'utf8')));

  return () => promise;
}
