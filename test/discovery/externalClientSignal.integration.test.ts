import assert from 'node:assert/strict';
import test from 'node:test';

import { signalProbe } from './signalHarness.js';

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(
  `external-client demo stops its observed child and parent-owned resources on ${signal}`,
  { timeout: 90_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout);
    await signalProbe(checkout, signal, 'demo-ready', false, false, false, true);
  });
