import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createRankingReadBudget } from '../../src/reputation/readBudget.js';
import { readAcceptedReviewerCoverage } from '../../src/reputation/coverage.js';
import { listenOwnedServer } from '../../src/demo/twoIndexes.js';
import { checkpointFixture, block, h as checkpointHash, REVIEWER, TOPICS, response } from '../feedback/fixtures/pairZeroCheckpoint.js';

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

function checkpointConfiguration(count = 2): any {
  const checkpoint = checkpointFixture({ count });
  const source = { ...checkpoint.domain, startBlock: '100', confirmations: 0 };
  return { rpcOrigin: 'http://127.0.0.1:1', checkpoint, observation: { ...checkpoint.observation },
    agentIds: ['7'], reviewers: [REVIEWER],
    indexes: [{ origin: 'http://127.0.0.1:2', source }, { origin: 'http://127.0.0.1:3', source }] };
}

test('checkpoint coverage retains authenticated slots without Index history or document availability', async () => {
  const servers = [0, 1].map(() => createServer((request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(rpc.method, 'eth_getBlockByNumber'); assert.deepEqual(rpc.params, ['0x66', false]);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: block(102) }));
      });
    } else { response.statusCode = 404; response.end(); }
  }));
  try {
    const origins = await Promise.all(servers.map(listenOwnedServer));
    for (const count of [0, 2]) {
      const config = checkpointConfiguration(count); config.rpcOrigin = origins[0];
      config.indexes.forEach((index: any, i: number) => { index.origin = origins[i]; });
      const out = await readAcceptedReviewerCoverage(config);
      assert.equal(out.status, 'complete'); assert.equal(out.activation, null);
      assert.equal(out.checkpoint?.status, 'matched');
      assert.equal(out.pairs[0]?.lastIndex, String(count)); assert.equal(out.pairs[0]?.slots.length, count);
      assert.deepEqual(out.pairs[0]?.missingSlots, []); assert.equal(out.rows.length, 0);
      assert.equal(out.privateCheckpointLedger!.entries.length, config.checkpoint.source.exchanges.length);
      assert.equal(out.budget.calls, out.privateCheckpointLedger!.entries.length + 2 + (count ? 2 : 0));
      assert.ok(out.documents.every((document) => document.availability === 'unavailable'));
      if (count) assert.equal(out.pairs[0]?.slots[1]?.observation.revocation, 'revoked');
    }
  } finally { await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  }))); }
});

test('checkpoint coverage rejects substituted scope and asserted success before acquisition', async () => {
  const mutations: Array<(v: any) => void> = [
    (v) => { v.provenance = configuration().provenance; },
    (v) => { delete v.checkpoint; },
    (v) => { v.agentIds = ['8']; },
    (v) => { v.reviewers = [a(7)]; },
    (v) => { v.reviewers.push(a(7)); },
    (v) => { v.checkpoint.pairs.push({ agentId: '8', reviewer: REVIEWER }); },
    (v) => { v.checkpoint.domain.chainId = 1; },
    (v) => { v.observation.blockNumber = 103n; },
    (v) => { v.observation.blockHash = checkpointHash(103); },
    (v) => { v.checkpoint.status = 'matched'; v.checkpoint.qualifiedPairs = []; },
    (v) => { v.checkpoint.parentBudget = {}; },
  ];
  for (const mutate of mutations) { const config = checkpointConfiguration(); mutate(config);
    await assert.rejects(readAcceptedReviewerCoverage(config), /configuration/); }
});

test('checkpoint acquisition shares the parent RPC allowance and preserves its unavailable ledger', async () => {
  const config = checkpointConfiguration();
  const work = createRankingReadBudget({ origins: [config.indexes[0].origin, config.indexes[1].origin] });
  try {
    for (let i = 0; i < 4095; i++) { const lease = await work.requestBudget('shared', 'rpc').open(); lease.check(); lease.close(); }
    const out = await readAcceptedReviewerCoverage(config, work);
    assert.equal(out.status, 'unknown'); assert.equal(out.checkpoint?.status, 'unavailable');
    assert.ok(out.privateCheckpointLedger); assert.equal(out.budget.calls, 4096);
    assert.equal(out.pairs[0]?.slots.length, 0);
  } finally { await work.dispose(); }
});

test('a gapped checkpoint scan, wrong C or local cap never becomes complete or empty coverage', async () => {
  for (const mutate of [
    (v: any) => {
      const entry = v.checkpoint.source.exchanges.find((e: any) => e.method === 'eth_getLogs' && e.params[0].topics[0] === TOPICS.feedback);
      entry.responseUtf8 = response(entry.requestId, JSON.parse(Buffer.from(entry.responseUtf8).toString()).result.slice(0, 1));
    },
    (v: any) => { v.checkpoint.zeroBasis.blockHash = checkpointHash(999); },
    (v: any) => { v.checkpoint.zeroBasis.blockNumber = 101n; },
    (v: any) => { v.checkpoint.limits = { maxRpcCalls: 1 }; },
  ]) {
    const config = checkpointConfiguration(); mutate(config);
    const out = await readAcceptedReviewerCoverage(config);
    assert.equal(out.status, 'unknown'); assert.notEqual(out.checkpoint?.status, 'matched');
    assert.equal(out.pairs[0]?.status, 'unknown'); assert.equal(out.pairs[0]?.lastIndex, null);
    assert.deepEqual(out.pairs[0]?.slots, []); assert.ok(out.privateCheckpointLedger);
  }
});
