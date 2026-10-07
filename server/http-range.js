// One byte range out of a Range header, the way RFC 9110 reads it. Media
// elements seek with ranges and Safari will not start playback without a range
// answer, so audio is served with them — and a wrong answer to `bytes=-N`
// (the last N bytes) is a corrupt file as far as the browser is concerned.

/**
 * `{ type: 'none' }` — no usable Range: send the whole thing.
 * `{ type: 'range', start, end }` — inclusive byte offsets, already clamped.
 * `{ type: 'unsatisfiable' }` — answer 416 with `Content-Range: bytes * /length`.
 * Several ranges at once are answered with the whole body, which the spec allows.
 */
export function parseRange(header, length) {
  if (typeof header !== 'string' || !header.trim()) return { type: 'none' };
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match) return { type: 'none' };
  const specs = match[1].split(',').map(part => part.trim()).filter(Boolean);
  if (specs.length !== 1) return { type: 'none' };

  const range = /^(\d*)\s*-\s*(\d*)$/.exec(specs[0]);
  if (!range || (range[1] === '' && range[2] === '')) return { type: 'none' };

  if (range[1] === '') {
    // the last N bytes
    const suffix = Number(range[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || length === 0) return { type: 'unsatisfiable' };
    return { type: 'range', start: Math.max(0, length - suffix), end: length - 1 };
  }

  const start = Number(range[1]);
  const end = range[2] === '' ? length - 1 : Math.min(Number(range[2]), length - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { type: 'none' };
  if (range[2] !== '' && Number(range[2]) < start) return { type: 'none' };   // malformed: ignore it
  if (start >= length) return { type: 'unsatisfiable' };
  return { type: 'range', start, end };
}
