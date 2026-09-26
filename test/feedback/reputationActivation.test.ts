import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, custom, type Hex } from 'viem';
import { readReputationActivation, type ReputationDeploymentProvenance } from '../../src/feedback/reputationActivation.js';

// These tests never authenticate fabricated chain evidence. The invalid-input
// and already-cancelled paths must exit without compiling or requesting RPC.
const h = `0x${'11'.repeat(32)}` as Hex;
const ref = { transactionHash: h, blockNumber: '1', blockHash: h, transactionIndex: 0 };
const p: ReputationDeploymentProvenance = {
  domain: { chainId: 31337, genesisHash: h, identityRegistry: '0x1111111111111111111111111111111111111111',
    reputationRegistry: '0x2222222222222222222222222222222222222222' },
  deployer: '0x3333333333333333333333333333333333333333',
  artifacts: { referenceCommit: 'unused', solcVersion: 'unused', solcTmpVersion: 'unused', openZeppelinVersion: 'unused',
    compilerSettings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, viaIR: true }, sourceSha256: {}, artifactSha256: {} },
  bootstrap: { ...ref, address: '0x4444444444444444444444444444444444444444', nonce: '0', runtimeCodeHash: h },
  proxy: { ...ref, blockNumber: '2', address: '0x2222222222222222222222222222222222222222', nonce: '1', runtimeCodeHash: h },
  implementation: { ...ref, blockNumber: '3', address: '0x5555555555555555555555555555555555555555', nonce: '2', runtimeCodeHash: h },
  activation: { ...ref, blockNumber: '4', upgradedLogIndex: 0 },
};
const client = createPublicClient({ transport: custom({ request: async () => assert.fail('invalid/cancelled input must not request RPC') }, { retryCount: 0 }) });
const input = { client, provenance: p, observation: { blockNumber: 4n, blockHash: h } };

test('activation cancellation before work returns unavailable without RPC', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await readReputationActivation({ ...input, signal: controller.signal });
  assert.equal(result.activation, 'unavailable');
  assert.deepEqual(result.diagnostics, ['cancelled']);
  assert.equal(result.knownDeployment, undefined);
});

test('activation limit ceilings reject invalid or unbounded settings before RPC', async () => {
  for (const limits of [{ totalTimeoutMs: 60_001 }, { totalTimeoutMs: 0 }, { rpcTimeoutMs: Infinity },
    { maxBlocks: 4097 }, { maxReceiptLogs: -1 }, { maxRpcCalls: 1.5 }, { maxCodeBytes: 32_769 }]) {
    await assert.rejects(readReputationActivation({ ...input, limits }), /invalid reputation activation limit/);
  }
});

test('activation configuration requires bounded canonical coordinates and explicit observation', async () => {
  const bad = structuredClone(p); bad.bootstrap.nonce = '0'.repeat(79);
  await assert.rejects(readReputationActivation({ ...input, provenance: bad }), /invalid reputation activation configuration/);
  await assert.rejects(readReputationActivation({ ...input, observation: { blockNumber: -1n, blockHash: h } }), /invalid reputation activation configuration/);
  const unsafe = structuredClone(p); unsafe.activation.transactionIndex = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(readReputationActivation({ ...input, provenance: unsafe }), /invalid reputation activation configuration/);
});
