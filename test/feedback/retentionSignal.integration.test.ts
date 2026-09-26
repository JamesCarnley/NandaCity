import assert from 'node:assert/strict';
import test from 'node:test';
import { signalProbe } from '../discovery/signalHarness.js';

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(
  `feedback demo ${signal} stops the observed reader and owned tree and removes private bundle`,
  { timeout: 120000 }, async () => {
    assert.ok(process.env['NANDA_INDEX_CHECKOUT']);
    const result = await signalProbe(process.env['NANDA_INDEX_CHECKOUT']!, signal, 'demo-ready', false, false, false, false, true);
    assert.deepEqual(result, { observedReader: 'feedback' });
  });
