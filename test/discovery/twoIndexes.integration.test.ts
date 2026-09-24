import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createPublicClient, http } from 'viem';

import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { withOwnedIndexes } from '../../src/demo/indexProcesses.js';
import { runTwoIndexDemo } from '../../src/demo/twoIndexes.js';

const checkout = process.env['NANDA_INDEX_CHECKOUT'];

test('six services converge through two real Index processes and owned resources clean up',
  { timeout: 180_000 }, async () => {
    assert.ok(checkout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    const result = await runTwoIndexDemo(checkout);
    assert.equal(result.mode, 'local-fixture');
    assert.match(result.cityCommit, /^[0-9a-f]{40}$/);
    assert.match(result.indexCommit, /^[0-9a-f]{40}$/);
    assert.equal(new Set(result.contactedOrigins).size, 2);
    assert.match(result.qualifiedRegistry, /^eip155:31337:0x[0-9a-f]{40}$/);
    assert.ok(result.checkpoints.every((block) => block.number && block.hash && block.timestamp));
    assert.ok(Object.values(result.acceptance).every(Boolean), JSON.stringify(result.acceptance));
    assert.equal(result.acceptance.reorgStaleRejected, true);
    assert.equal(result.cleanup.ownedResourcesStopped, true);
  });

test('callback failure stops only its owned Index processes and PostgreSQL container',
  { timeout: 60_000 }, async () => {
    assert.ok(checkout);
    let containerId = '';
    let origins: string[] = [];
    const marker = { blockNumber: 0n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)) + BigInt(randomBytes(3).readUIntBE(0, 3)) };
    await assert.rejects(withOwnedAnvil(async (rpcUrl) => {
      const client = createPublicClient({ transport: http(rpcUrl) });
      const genesis = await client.getBlock({ blockNumber: 0n });
      assert.ok(genesis.hash);
      await withOwnedIndexes(checkout, {
        chainId: 31_337, registry: '0x1111111111111111111111111111111111111111',
        genesisHash: genesis.hash, startBlock: '0', adapter: 'nandacity-0.1',
        confirmations: 0,
      }, { A: rpcUrl, B: rpcUrl }, async (owned) => {
        containerId = owned.containerId;
        origins = [owned.indexes.A.origin, owned.indexes.B.origin];
        throw new Error('intentional callback failure');
      });
    }, { genesisMarker: marker }), /intentional callback failure/);
    assert.ok(containerId);
    assert.throws(() => execFileSync('docker', ['inspect', containerId], { encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const origin of origins) {
      await assert.rejects(fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }));
    }
  });
