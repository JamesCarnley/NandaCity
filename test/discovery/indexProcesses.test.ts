import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOwnedIndexReady, safeCommandFailure, settleOwnedCleanup } from '../../src/demo/indexProcesses.js';

test('readiness rejects a different server origin or identity source', () => {
  const origin = 'http://127.0.0.1:31001';
  const sourceId = 'erc8004-identity:31337:0x1111111111111111111111111111111111111111';
  const response = { observerOrigin: origin,
    coverage: { identitySources: [{ sourceId }] } };
  assert.doesNotThrow(() => assertOwnedIndexReady(response, origin, sourceId));
  assert.throws(() => assertOwnedIndexReady({ ...response, observerOrigin: 'http://127.0.0.1:31002' },
    origin, sourceId), /origin mismatch/);
  assert.throws(() => assertOwnedIndexReady({ observerOrigin: origin,
    coverage: { identitySources: [{ sourceId: 'different' }] } }, origin, sourceId),
  /source mismatch/);
});

test('child command failures do not expose ephemeral database credentials', () => {
  const underlying = new Error('Command failed: docker exec -e PGPASSWORD=secret-value ...');
  const reported = safeCommandFailure('docker', underlying);
  assert.match(reported.message, /docker failed/);
  assert.equal(reported.message.includes('secret-value'), false);
});

test('cleanup attempts every stopper and owned container removal, preserving failures', async () => {
  const attempted: string[] = [];
  await assert.rejects(settleOwnedCleanup([
    async () => { attempted.push('A'); throw new Error('A stop failed'); },
    async () => { attempted.push('B'); },
  ], async () => { attempted.push('container'); }, [new Error('scenario failed')]),
  (error: unknown) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors[0]?.message === 'scenario failed' &&
    error.errors[1]?.message === 'A stop failed');
  assert.deepEqual(attempted, ['A', 'B', 'container']);
});
