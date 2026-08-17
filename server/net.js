import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class UnsafeAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeAddressError';
    this.code = 'ERR_PRIVATE_ADDRESS';
    this.statusCode = 403;
  }
}

function ipv4Parts(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

export function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(value);

  if (family === 4) {
    const [a, b, c] = ipv4Parts(value);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }

  if (family === 6) {
    return value === '::'
      || value === '::1'
      || value.startsWith('::ffff:')
      || value.startsWith('fc')
      || value.startsWith('fd')
      || /^fe[89ab]/.test(value)
      || value.startsWith('ff')
      || value.startsWith('64:ff9b:')
      || value.startsWith('2001:0:')
      || value.startsWith('2001:db8:')
      || value.startsWith('2002:');
  }

  return true;
}

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

export async function assertSafeUrl(input) {
  const url = input instanceof URL ? input : new URL(input);
  if (!/^https?:$/.test(url.protocol)) {
    throw new UnsafeAddressError('Only http(s) URLs are allowed');
  }
  if (process.env.ALLOW_PRIVATE_HOSTS === '1') return url;

  const hostname = normalizedHostname(url);
  const directFamily = isIP(hostname);
  const addresses = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UnsafeAddressError('Private, local, and reserved network addresses are blocked');
  }
  return url;
}

export async function safeFetch(input, init = {}, { maxRedirects = 5 } = {}) {
  let url = input instanceof URL ? new URL(input.href) : new URL(input);
  let options = { ...init };

  for (let redirects = 0; ; redirects += 1) {
    await assertSafeUrl(url);
    const response = await fetch(url, { ...options, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);

    url = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302)
      && String(options.method || 'GET').toUpperCase() === 'POST')) {
      const { body, ...withoutBody } = options;
      options = { ...withoutBody, method: 'GET' };
    }
  }
}
