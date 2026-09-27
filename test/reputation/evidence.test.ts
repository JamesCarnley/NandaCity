import assert from 'node:assert/strict';
import test from 'node:test';

import { readRankingEvidence } from '../../src/reputation/evidence.js';

const hash = (byte: string): `0x${string}` => `0x${byte.repeat(64)}`;
const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;

function rawInput(): Record<string, unknown> {
  const identity = address('1');
  const reputation = address('2');
  return {
    rpcOrigin: 'http://127.0.0.1:39101',
    provenance: {
      domain: { chainId: 31_337, genesisHash: hash('a'), identityRegistry: identity,
        reputationRegistry: reputation },
      deployer: address('3'),
      artifacts: {
        referenceCommit: 'fixture', solcVersion: '0.8.24', solcTmpVersion: '0.8.24',
        openZeppelinVersion: '5.4.0', sourceSha256: {}, artifactSha256: {},
        compilerSettings: { evmVersion: 'shanghai', viaIR: true,
          optimizer: { enabled: true, runs: 200 } },
      },
      bootstrap: { transactionHash: hash('b'), blockNumber: '1', blockHash: hash('c'),
        transactionIndex: 0, address: address('4'), nonce: '0', runtimeCodeHash: hash('d') },
      proxy: { transactionHash: hash('e'), blockNumber: '2', blockHash: hash('f'),
        transactionIndex: 0, address: reputation, nonce: '1', runtimeCodeHash: hash('1') },
      implementation: { transactionHash: hash('2'), blockNumber: '3', blockHash: hash('3'),
        transactionIndex: 0, address: address('5'), nonce: '2', runtimeCodeHash: hash('4') },
      activation: { transactionHash: hash('5'), blockNumber: '4', blockHash: hash('6'),
        transactionIndex: 0, upgradedLogIndex: 0 },
    },
    identityDomain: { chainId: 31_337, registry: identity, genesisHash: hash('a'),
      knownImplementation: { address: address('6'), codeHash: hash('7') } },
    cardOrigin: 'http://127.0.0.1:39102',
    observation: { blockNumber: 4n, blockHash: hash('6') },
    indexes: [
      { origin: 'http://127.0.0.1:39103', source: { chainId: 31_337, genesisHash: hash('a'),
        identityRegistry: identity, reputationRegistry: reputation, startBlock: '2', confirmations: 0 } },
      { origin: 'http://127.0.0.1:39104', source: { chainId: 31_337, genesisHash: hash('a'),
        identityRegistry: identity, reputationRegistry: reputation, startBlock: '2', confirmations: 0 } },
    ],
    policy: { id: 'test-policy', version: '0.1', reviewers: [], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' },
    services: [], privateBundleFiles: [],
  };
}

test('raw composer input rejects a caller-supplied completed finding before I/O', async () => {
  const input = { ...rawInput(), policyResult: { selection: { rated: ['forged'] } } };
  await assert.rejects(readRankingEvidence(input as never), /invalid ranking evidence configuration/);
});

test('raw composer rejects expanded authority and allowance inputs before I/O', async () => {
  const base = rawInput();
  const identity = (base['identityDomain'] as { registry: string }).registry;
  const agent = (agentId: string) => ({ chainId: 31_337, registry: identity, agentId });
  const cases = [
    { ...base, cardOrigin: 'https://cards.example' },
    { ...base, budget: { calls: 1 } },
    { ...base, services: Array.from({ length: 7 }, (_, index) => ({ agent: agent(String(index)) })) },
    { ...base, privateBundleFiles: [{ documentHash: hash('8'), path: null },
      { documentHash: hash('8'), path: null }] },
    { ...base, services: [{ agent: { ...agent('0'), registry: address('9') } }] },
  ];
  for (const input of cases) {
    await assert.rejects(readRankingEvidence(input as never), /invalid ranking evidence configuration/);
  }
});

test('an aborted raw read returns a sanitized unavailable snapshot', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await readRankingEvidence({ ...rawInput(), signal: controller.signal } as never);
  assert.equal(result.qualification, 'rpc-derived-not-state-proof');
  assert.equal(result.snapshot, 'unavailable');
  assert.equal(result.policyInput, null);
  assert.equal(result.policyResult, null);
  assert.deepEqual(result.diagnostics, ['final-observation-unavailable']);
  assert.deepEqual(result.sidecar.services, []);
  assert.deepEqual(result.sidecar.town, []);
  assert.equal(JSON.stringify(result).includes('39101'), false);
  assert.ok(result.budget.diagnostics.includes('batch-cancelled'));
});
