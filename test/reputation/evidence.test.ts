import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem';

import { readRankingEvidence } from '../../src/reputation/evidence.js';
import { listenOwnedServer } from '../../src/demo/twoIndexes.js';
import { checkpointFixture, block, REVIEWER, CALLS, TOPICS, I, R, abiString, addr, response as rpcResponse } from '../feedback/fixtures/pairZeroCheckpoint.js';
import { originalCandidate, originalOwner, originalRegistration } from '../identity/fixtures.js';
import { encodeRegistration } from '../../src/identity/profile.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';

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

function checkpointInput(): any {
  const input: any = rawInput(); delete input.provenance;
  input.checkpoint = checkpointFixture({ count: 0 });
  const c = input.checkpoint;
  input.observation = { ...c.observation };
  input.identityDomain = { chainId: c.domain.chainId, genesisHash: c.domain.genesisHash, registry: c.domain.identityRegistry,
    knownImplementation: { address: c.pins.identity.implementation, codeHash: c.pins.identity.fullRuntimeHash } };
  input.indexes.forEach((index: any) => { index.source = { ...c.domain, startBlock: '100', confirmations: 0 }; });
  input.services = [{ agent: { chainId: c.domain.chainId, registry: c.domain.identityRegistry, agentId: '7' } }];
  input.policy.reviewers = [REVIEWER]; input.policy.groups = [{ key: 'reviewer', reviewers: [REVIEWER] }];
  return input;
}

test('raw composer accepts only checkpoint input bound to its selected domain, pairs and B', async () => {
  for (const mutate of [
    (v: any) => { v.provenance = rawInput()['provenance']; },
    (v: any) => { v.checkpoint.status = 'matched'; },
    (v: any) => { v.identityDomain.knownImplementation.address = address('9'); },
    (v: any) => { v.identityDomain.knownImplementation.codeHash = hash('9'); },
    (v: any) => { v.checkpoint.pairs[0].agentId = '8'; },
    (v: any) => { v.checkpoint.pairs[0].reviewer = address('9'); },
    (v: any) => { v.checkpoint.domain.genesisHash = hash('9'); },
    (v: any) => { v.checkpoint.observation.blockHash = hash('9'); },
    (v: any) => { v.checkpoint.observation.blockNumber = 103n; },
  ]) { const input = checkpointInput(); mutate(input);
    await assert.rejects(readRankingEvidence(input), /invalid ranking evidence configuration/); }
});

test('composer snapshots raw checkpoint bytes before yielding and keeps its ledger private', async () => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
        ...(rpc.method === 'eth_getBlockByNumber' ? { result: block(102) } : { error: { code: -32000, message: 'synthetic unavailable current state' } }) }));
    });
  });
  try {
    const origin = await listenOwnedServer(server);
    const input = checkpointInput(); input.rpcOrigin = origin;
    const header = input.checkpoint.source.exchanges.find((entry: any) => entry.method === 'eth_getBlockByNumber');
    const raw = JSON.parse(Buffer.from(header.responseUtf8).toString()); raw.result.providerPrivateMarker = 'private-untrusted-reply-marker';
    header.responseUtf8 = new TextEncoder().encode(JSON.stringify(raw));
    const read = readRankingEvidence(input);
    input.checkpoint.registrations[0].cardBytes.fill(0);
    input.checkpoint.source.exchanges.forEach((entry: any) => { entry.responseUtf8.fill(0); entry.params = []; });
    input.checkpoint.pairs[0].agentId = '999'; input.checkpoint.zeroBasis.blockNumber = 101n;
    input.checkpoint.pins.identity.sourceBuildId = 'mutated'; input.checkpoint.domain.genesisHash = hash('9');
    const result = await read;
    assert.equal(result.snapshot, 'matched'); assert.equal(result.sidecar.coverage.activation, null);
    assert.equal(result.sidecar.coverage.checkpoint?.status, 'matched');
    assert.equal(result.sidecar.coverage.checkpoint?.zeroBasis.blockNumber, '100');
    assert.equal(result.sidecar.coverage.checkpoint?.pins.identity.sourceBuildId, 'synthetic-identity-not-a-source-proof');
    assert.equal(result.policyInput?.candidates[0]?.history.start, 'pair-zero-checkpoint-confirmed');
    assert.equal(result.policyInput?.candidates[0]?.history.status, 'complete');
    assert.ok(result.privateCheckpointLedger!.entries.length > 0);
    assert.equal(result.privateCheckpointLedger?.complete, true);
    assert.ok(result.privateCheckpointLedger!.entries.some((entry) =>
      entry.responseUtf8 && new TextDecoder().decode(entry.responseUtf8).includes('private-untrusted-reply-marker')));
    const publicText = JSON.stringify(result.sidecar);
    for (const privateField of ['responseUtf8', 'cardBytes', 'privateCheckpointLedger', 'exchanges', 'private-untrusted-reply-marker', origin]) {
      assert.equal(publicText.includes(privateField), false);
    }
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});

test('checkpoint slots remain covered while missing public documents or private bundles withhold a rating', async () => {
  const rubric = 'evening-plan-usefulness-v0.1';
  const feedback = { kind: 'feedback', version: '0.1', service: { method: 'erc8004', agent: { chainId: 11155111, registry: I, agentId: '7' } },
    reviewer: { method: 'eip155-eoa', chainId: 11155111, address: REVIEWER }, interactionId: hash('a'),
    requestDigest: hash('b'), acceptanceDigest: hash('c'), reputationRegistry: { chainId: 11155111, address: R },
    rubric, value: 5, createdAt: '2026-09-24T13:02:00Z', result: { kind: 'no-result-observed', observedAt: '2026-09-24T13:01:00Z' } };
  // Literal envelope is codec-valid, not an asserted valid signature or interaction.
  const document = encodeFeedbackDocument({ version: '0.1', scheme: 'eip712-eoa', signer: feedback.reviewer,
    payloadBase64: Buffer.from(JSON.stringify(feedback)).toString('base64'), signature: `0x${'11'.repeat(65)}` });
  for (const available of [false, true]) {
    const input = checkpointInput(); input.checkpoint = checkpointFixture({ count: 1 });
    const exchanges = input.checkpoint.source.exchanges;
    for (const entry of exchanges) {
      const reply = JSON.parse(Buffer.from(entry.responseUtf8).toString());
      const logs = entry.method === 'eth_getLogs' && Array.isArray(reply.result) ? reply.result : reply.result?.logs ?? [];
      for (const log of logs) if (log.topics[0] === TOPICS.feedback) {
        log.topics[3] = keccak256(toHex(rubric));
        log.data = encodeAbiParameters(parseAbiParameters('uint64, int128, uint8, bytes, bytes, bytes, bytes, bytes32'),
          [1n, 5n, 0, toHex(rubric), '0x', '0x', '0x', document.documentHash]);
      }
      if (entry.method === 'eth_call' && entry.params[0].data === CALLS.read1) {
        reply.result = encodeAbiParameters(parseAbiParameters('int128, uint8, bytes, bytes, bool'), [5n, 0, toHex(rubric), '0x', false]);
      }
      if (['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(entry.method) && reply.result.blockNumber === '0x65') {
        reply.result.to = R; reply.result.from = REVIEWER;
      }
      entry.responseUtf8 = rpcResponse(entry.requestId, reply.result);
    }
    const replies = new Map(exchanges.map((entry: any) => [JSON.stringify([entry.method, entry.params]), JSON.parse(Buffer.from(entry.responseUtf8).toString()).result]));
    let origin = '';
    const servers = [0, 1].map(() => createServer((request, response) => {
      if (request.method === 'GET') {
        if (request.url === '/cards/7.json') { response.setHeader('content-type', 'application/json'); response.end(originalCandidate.cardBytes); }
        else if (available && request.url?.endsWith(document.documentHash)) { response.end(document.bytes); }
        else { response.statusCode = 404; response.end(); }
        return;
      }
      const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString());
        let result: unknown = replies.get(JSON.stringify([rpc.method, rpc.params ?? []]));
        if (rpc.method === 'eth_call' && rpc.params[0].to === I && rpc.params[0].data === CALLS.ownerOf) result = `0x${addr(originalOwner)}`;
        if (rpc.method === 'eth_call' && rpc.params[0].to === I && rpc.params[0].data === CALLS.uri) result = abiString(encodeRegistration({ ...originalRegistration,
          services: originalRegistration.services.map((service) => ({ ...service, endpoint: `${origin}/cards/7.json` })) }));
        if (rpc.method === 'eth_getBlockByNumber') result = block(Number(BigInt(rpc.params[0])));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...(result !== undefined ? { result } :
          { error: { code: -32000, message: 'unavailable synthetic acquisition' } }) }));
      });
    }));
    try {
      const origins = await Promise.all(servers.map(listenOwnedServer)); origin = origins[0]!;
      input.rpcOrigin = origin; input.cardOrigin = origin;
      input.indexes.forEach((index: any, i: number) => { index.origin = origins[i]; });
      input.policy.curators = ['curator']; input.curatorInclusions = [{ curator: 'curator', agent: input.services[0].agent }];
      const result = await readRankingEvidence(input);
      assert.equal(result.snapshot, 'matched'); assert.equal(result.sidecar.coverage.status, 'complete');
      assert.equal(result.sidecar.coverage.checkpoint?.status, 'matched');
      assert.equal(result.sidecar.services[0]?.profile.status, 'valid', JSON.stringify(result.sidecar.services[0]?.profile));
      const slot = result.sidecar.services[0]?.slots[0];
      assert.equal(slot?.document, available ? 'available' : 'unavailable'); assert.equal(slot?.bundle, 'absent');
      assert.equal(slot?.historical, 'not-evaluated'); assert.equal(slot?.epoch, 'unknown');
      assert.equal(result.policyResult?.candidates[0]?.view, 'recommended-unresolved', JSON.stringify({ available,
        candidate: result.policyResult?.candidates[0], slot }));
      assert.equal(result.policyResult?.candidates[0]?.score, null);
    } finally { await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve()); server.closeAllConnections();
    }))); }
  }
});
