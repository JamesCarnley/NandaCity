import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createPublicClient, http } from 'viem';
import { recordedCli, events } from './signalHarness.js';

import { assertOwnedIndexReady, resolveLocalDocker, safeCommandFailure, settleOwnedCleanup, withOwnedIndexes } from '../../src/demo/indexProcesses.js';
import { withOwnedLifecycle } from '../../src/demo/ownedLifecycle.js';

test('owned RPC cancellation composes with the transport request timeout', async () => {
  const lifecycleModule = await import('../../src/demo/ownedLifecycle.js') as
    { ownedFetch?: typeof fetch };
  assert.equal(typeof lifecycleModule.ownedFetch, 'function', 'owned fetch must preserve transport timeouts');
  const server = createServer(() => { /* deliberately stalled owned RPC */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await withOwnedLifecycle(async () => {
      const client = createPublicClient({ transport: http(`http://127.0.0.1:${address.port}`, {
        retryCount: 0, timeout: 50, fetchFn: lifecycleModule.ownedFetch!,
      }) });
      await assert.rejects(client.getChainId(), /timed out|timeout/i);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const endpoint of ['ssh://remote.invalid', 'tcp://127.0.0.1:2375', 'tcp://remote.invalid:2376',
  'unix://remote.invalid/socket', 'unix:relative', 'unix:///socket?redirect=remote', 'npipe:////./pipe/docker_engine']) {
  test(`Docker refuses unsupported endpoint ${endpoint} without a daemon command`, async () => {
    const calls: string[][] = [];
    await assert.rejects(resolveLocalDocker({ DOCKER_HOST: endpoint }, async (args) => {
      calls.push(args); throw new Error('must not reach Docker');
    }), /local Unix socket/);
    assert.deepEqual(calls, []);
  });
}

test('Docker selection is resolved once and pinned for run, exec, inspect, and removal', async () => {
  const env = { DOCKER_CONTEXT: 'local-test', DOCKER_HOST: 'tcp://ignored.invalid:2375', DOCKER_CONFIG: '/test/config' };
  const calls: string[][] = [];
  const docker = await resolveLocalDocker(env, async (args) => {
    calls.push(args);
    return args.includes('context') ? 'unix:///test/docker.sock' : '';
  });
  env.DOCKER_CONTEXT = 'changed-to-remote';
  env.DOCKER_CONFIG = '/changed/config';
  for (const operation of ['run', 'exec', 'inspect', 'rm']) await docker.command([operation, 'owned-id'], 1000);
  assert.deepEqual(calls, [
    ['--config', '/test/config', 'context', 'inspect', 'local-test', '--format', '{{.Endpoints.docker.Host}}'],
    ...['run', 'exec', 'inspect', 'rm'].map((operation) =>
      ['--config', '/test/config', '--host', 'unix:///test/docker.sock', operation, 'owned-id']),
  ]);
});

test('nested scopes share one cancellation owner and restore handlers after failures', async () => {
  const before = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') };
  await assert.rejects(withOwnedLifecycle(async (outer) => {
    assert.equal(process.listenerCount('SIGINT'), before.interrupt + 1);
    await withOwnedLifecycle(async (inner) => {
      assert.equal(outer, inner);
      assert.equal(process.listenerCount('SIGTERM'), before.terminate + 1);
      throw new Error('nested startup failure');
    });
  }), /nested startup failure/);
  assert.equal(process.listenerCount('SIGINT'), before.interrupt);
  assert.equal(process.listenerCount('SIGTERM'), before.terminate);
});

test('remote saved Docker context is refused before container creation', async () => {
  const { directory, log } = await recordedCli({ remote: true });
  const path = process.env['PATH'];
  process.env['PATH'] = `${directory}:${path ?? ''}`;
  try {
    await assert.rejects(withOwnedIndexes('/missing-index-must-not-be-checked-before-docker-guard', {
      chainId: 31337, registry: '0x1111111111111111111111111111111111111111',
      genesisHash: `0x${'1'.repeat(64)}`, startBlock: '0', adapter: 'nandacity-0.1', confirmations: 0,
    }, { A: 'http://127.0.0.1:1', B: 'http://127.0.0.1:1' }, async () => {}),
    /Docker.*local.*Unix|local.*Docker.*Unix/);
    assert.equal((await events(log)).some((event) => event.args?.includes('run')), false);
  } finally {
    if (path === undefined) delete process.env['PATH']; else process.env['PATH'] = path;
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup attempts all stoppers even if a stopper throws synchronously', async () => {
  const attempted: string[] = [];
  await assert.rejects(settleOwnedCleanup([
    () => { attempted.push('A'); throw new Error('synchronous failure'); },
    async () => { attempted.push('B'); },
  ], async () => { attempted.push('container'); }), /synchronous failure/);
  assert.deepEqual(attempted, ['A', 'B', 'container']);
});

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
