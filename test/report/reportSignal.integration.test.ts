import assert from 'node:assert/strict';
import test from 'node:test';

import { signalProbe } from '../discovery/signalHarness.js';

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(
  `report CLI removes reserved outputs and owned resources on ${signal} during fixture startup`,
  { timeout: 90_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    await signalProbe(checkout, signal, 'container-acquiring', false, false, true);
  });
