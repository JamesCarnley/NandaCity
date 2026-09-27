import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingReadBudget } from '../../src/reputation/readBudget.js';

const h = `0x${'11'.repeat(32)}`, a = (n: number) => `0x${String(n).repeat(40)}`;
function configuration(): any {
  const domain = { chainId: 31337, genesisHash: h, identityRegistry: a(1), reputationRegistry: a(2) };
  const ref = { transactionHash: h, blockNumber: '1', blockHash: h, transactionIndex: 0 };
  const p = { domain, deployer: a(3), artifacts: { referenceCommit: 'unused', solcVersion: 'unused', solcTmpVersion: 'unused',
    openZeppelinVersion: 'unused', compilerSettings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, viaIR: true },
    sourceSha256: {}, artifactSha256: {} },
  bootstrap: { ...ref, address: a(4), nonce: '0', runtimeCodeHash: h },
  proxy: { ...ref, blockNumber: '2', address: a(2), nonce: '1', runtimeCodeHash: h },
  implementation: { ...ref, blockNumber: '3', address: a(5), nonce: '2', runtimeCodeHash: h },
  activation: { ...ref, blockNumber: '4', upgradedLogIndex: 0 } };
  const source = { ...domain, startBlock: '2', confirmations: 0 };
  return { rpcOrigin: 'http://127.0.0.1:1', provenance: p, observation: { blockNumber: 4n, blockHash: h },
    agentIds: ['0'], reviewers: [a(6)], indexes: [{ origin: 'http://127.0.0.1:2', source }, { origin: 'http://127.0.0.1:3', source }] };
}

test('coverage rejects unbounded selections and mismatched source domains before network or compilation', async () => {
  const api = await import('../../src/reputation/coverage.js').catch(() => undefined);
  assert.ok(api, 'accepted-reviewer coverage must exist');
  for (const bad of [{ agentIds: Array(7).fill('0') }, { reviewers: Array(9).fill('0x' + '1'.repeat(40)) },
    { agentIds: ['01'] }, { agentIds: ['0', '0'] }, { observation: { blockNumber: -1n, blockHash: '0x' + 'a'.repeat(64) } }]) {
    await assert.rejects(api.readAcceptedReviewerCoverage({ ...configuration(), ...bad }), /invalid|configuration|selection/);
  }
  const bad = configuration(); bad.indexes[0].source = { ...bad.indexes[0].source, chainId: 1 };
  await assert.rejects(api.readAcceptedReviewerCoverage(bad), /configuration/);
});

test('canceled coverage performs no work and borrowed ledgers require exact origin bindings', async () => {
  const { readAcceptedReviewerCoverage } = await import('../../src/reputation/coverage.js');
  const controller = new AbortController(); controller.abort();
  const result = await readAcceptedReviewerCoverage({ ...configuration(), signal: controller.signal });
  assert.equal(result.status, 'unknown'); assert.equal(result.activation, null); assert.equal(result.budget.calls, 0);
  const work = createRankingReadBudget({ origins: ['http://127.0.0.1:4', 'http://127.0.0.1:5'] });
  try { await assert.rejects(readAcceptedReviewerCoverage(configuration(), work), /configuration/); }
  finally { await work.dispose(); }
});
