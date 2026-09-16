import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicClient } from 'viem';

import { assertLocalWriteRpcUrl } from '../../src/demo/anvil.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';

const agent = {
  chainId: 31_337,
  registry: '0x1111111111111111111111111111111111111111' as const,
  agentId: '7',
};
const owner = '0x2222222222222222222222222222222222222222' as const;
const blockHash =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

test('qualifies owner and URI reads to one numbered block', async () => {
  const getBlockCalls: unknown[] = [];
  const readFunctions: string[] = [];
  const client = {
    async getChainId() {
      return 31_337;
    },
    async getBlock(parameters: unknown) {
      getBlockCalls.push(parameters);
      return { number: 42n, hash: blockHash, timestamp: 1_700_000_000n };
    },
    async readContract(parameters: {
      functionName: string;
      blockNumber?: bigint;
    }) {
      assert.equal(parameters.blockNumber, 42n);
      readFunctions.push(parameters.functionName);
      return parameters.functionName === 'ownerOf' ? owner : 'data:example';
    },
  } as unknown as PublicClient;

  const snapshot = await readIdentitySnapshot(client, agent);

  assert.deepEqual(snapshot, {
    agent,
    blockNumber: '42',
    blockHash,
    blockTimestamp: 1_700_000_000,
    agentOwner: owner,
    agentURI: 'data:example',
  });
  assert.deepEqual(readFunctions.sort(), ['ownerOf', 'tokenURI']);
  assert.deepEqual(getBlockCalls, [{ blockTag: 'latest' }, { blockNumber: 42n }]);
});

test('rejects a block hash change during block-qualified reads', async () => {
  let blockRead = 0;
  const client = {
    async getChainId() {
      return 31_337;
    },
    async getBlock() {
      blockRead += 1;
      return {
        number: 42n,
        hash:
          blockRead === 1
            ? blockHash
            : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        timestamp: 1_700_000_000n,
      };
    },
    async readContract(parameters: { functionName: string }) {
      return parameters.functionName === 'ownerOf' ? owner : 'data:example';
    },
  } as unknown as PublicClient;

  await assert.rejects(readIdentitySnapshot(client, agent), /reorganization detected/i);
});

test('refuses identity demo writes to non-loopback RPCs', () => {
  assert.doesNotThrow(() => assertLocalWriteRpcUrl('http://127.0.0.1:8545'));
  assert.doesNotThrow(() => assertLocalWriteRpcUrl('http://localhost:8545'));
  assert.throws(
    () => assertLocalWriteRpcUrl('https://mainnet.example'),
    /loopback HTTP RPC/i,
  );
  assert.throws(
    () => assertLocalWriteRpcUrl('http://127.0.0.1.evil.example:8545'),
    /loopback HTTP RPC/i,
  );
});
