import assert from 'node:assert/strict';
import test from 'node:test';
import { rateLimit } from '../server/demo.js';

test('demo rate limiter rejects requests over the per-window cap', () => {
  const middleware = rateLimit({ limit: 2, windowMs: 60_000 });
  const req = { ip: '203.0.113.8', socket: {} };
  let passed = 0;
  let status;
  let body;
  const res = {
    set() {},
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };

  middleware(req, res, () => { passed += 1; });
  middleware(req, res, () => { passed += 1; });
  middleware(req, res, () => { passed += 1; });

  assert.equal(passed, 2);
  assert.equal(status, 429);
  assert.match(body.error, /rate limit/i);
});
