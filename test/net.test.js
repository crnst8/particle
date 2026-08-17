import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../server/net.js';

test('private and reserved address ranges are blocked', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '::', '::1', '::ffff:7f00:1',
    'fc00::1', 'fe80::1',
  ]) assert.equal(isPrivateAddress(address), true, address);

  for (const address of ['1.1.1.1', '8.8.8.8', '198.51.99.1', '203.0.112.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('direct private targets are rejected', async () => {
  await assert.rejects(assertSafeUrl('http://169.254.169.254/latest/meta-data'), {
    code: 'ERR_PRIVATE_ADDRESS',
  });
});

test('redirect targets are checked before the next request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  try {
    await assert.rejects(safeFetch('https://1.1.1.1/start'), { code: 'ERR_PRIVATE_ADDRESS' });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
