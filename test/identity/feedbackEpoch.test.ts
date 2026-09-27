import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';

const hash = `0x${'11'.repeat(32)}` as const;
const domain = {
  chainId: 31337,
  registry: '0x1111111111111111111111111111111111111111' as const,
  genesisHash: hash,
  knownImplementation: { address: '0x2222222222222222222222222222222222222222' as const, codeHash: hash },
};
const agent = { chainId: 31337, registry: domain.registry, agentId: '0' };

test('feedback epoch rejects invalid copied coordinates before RPC I/O', async () => {
  const module = await import('../../src/identity/continuity.js');
  assert.equal(typeof module.readIdentityFeedbackEpoch, 'function');
  let reads = 0;
  const client = new Proxy({} as PublicClient, {
    get() {
      reads += 1;
      throw new Error('invalid input must not reach RPC');
    },
  });
  const result = await module.readIdentityFeedbackEpoch(client, {
    domain: {
      chainId: 0,
      registry: '0x1111111111111111111111111111111111111111',
      genesisHash: hash,
      knownImplementation: {
        address: '0x2222222222222222222222222222222222222222',
        codeHash: hash,
      },
    },
    agent: {
      chainId: 31337,
      registry: '0x1111111111111111111111111111111111111111',
      agentId: '0',
    },
    basis: { blockNumber: 1n, blockHash: hash },
    observation: { blockNumber: 1n, blockHash: hash },
    limits: { maxBlocks: 1, maxLogs: 1 },
  });
  assert.equal(reads, 0);
  assert.deepEqual(result, {
    epoch: 'unknown',
    ownerEpoch: 'unknown', deauthorization: 'unknown',
    qualification: 'rpc-derived-not-state-proof',
    basis: { blockNumber: '1', blockHash: hash },
    observation: { blockNumber: '1', blockHash: hash },
    diagnostics: ['invalid feedback epoch domain, subject, coordinates or limits'],
  });
});

test('feedback epoch range and admission ceilings fail before RPC I/O', async () => {
  const { readIdentityFeedbackEpoch } = await import('../../src/identity/continuity.js');
  for (const input of [
    { basis: { blockNumber: 2n, blockHash: hash }, observation: { blockNumber: 1n, blockHash: hash },
      limits: { maxBlocks: 2, maxLogs: 2 } },
    { basis: { blockNumber: 1n, blockHash: hash }, observation: { blockNumber: 4n, blockHash: hash },
      limits: { maxBlocks: 2, maxLogs: 2 } },
  ]) {
    let reads = 0;
    const client = new Proxy({} as PublicClient, { get() { reads += 1; throw new Error('range failure reached RPC'); } });
    const result = await readIdentityFeedbackEpoch(client, { domain, agent, ...input });
    assert.equal(result.epoch, 'unknown');
    assert.match(result.diagnostics[0]!, /range exceeds bounds/);
    assert.equal(reads, 0);
  }
});

test('feedback epoch checks cancellation and its own total deadline around I/O', async () => {
  const { readIdentityFeedbackEpoch } = await import('../../src/identity/continuity.js');
  const coordinate = { blockNumber: 1n, blockHash: hash };
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const cancelledClient = new Proxy({} as PublicClient, { get() { reads += 1; throw new Error('cancelled read reached RPC'); } });
  const cancelled = await readIdentityFeedbackEpoch(cancelledClient, { domain, agent,
    basis: coordinate, observation: coordinate, limits: { maxBlocks: 2, maxLogs: 2 }, signal: controller.signal });
  assert.equal(cancelled.epoch, 'unknown');
  assert.match(cancelled.diagnostics[0]!, /abort|cancel/i);
  assert.equal(reads, 0);

  const realNow = Date.now;
  let advanced = false;
  const deadlineClient = { getChainId: async () => { advanced = true; return 31337; } } as PublicClient;
  try {
    Date.now = () => realNow() + (advanced ? 11_000 : 0);
    const deadline = await readIdentityFeedbackEpoch(deadlineClient, { domain, agent,
      basis: coordinate, observation: coordinate, limits: { maxBlocks: 2, maxLogs: 2 } });
    assert.equal(deadline.epoch, 'unknown');
    assert.deepEqual(deadline.diagnostics, ['feedback epoch total deadline exceeded']);
  } finally { Date.now = realNow; }
});
