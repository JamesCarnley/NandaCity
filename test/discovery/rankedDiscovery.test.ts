import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { encodeAbiParameters, type Hex } from 'viem';

import { cloneOriginalRegistration, dataUriFor, originalCard, originalOwner } from '../identity/fixtures.js';
import type { RankingEvidenceInput } from '../../src/reputation/evidence.js';
import type { RankedDiscoveryInput } from '../../src/client/rankedDiscovery.js';

const origins = ['http://127.0.0.1:31001', 'http://127.0.0.1:31002'] as const;
async function budget(options = {}) {
  const api = await import('../../src/discovery/readBudget.js').catch(() => undefined);
  assert.ok(api, 'origin-reserved discovery budget must exist');
  return new api.DiscoveryReadBudget({ origins, ...options });
}
async function discover(input: RankedDiscoveryInput, options = {}) {
  const api = await import('../../src/client/rankedDiscovery.js').catch(() => undefined);
  assert.ok(api, 'actual discovery composition must exist');
  return api.discoverRanked(input, options);
}

test('discovery origin reservations meter 64 physical requests and 16 MiB without borrowing', async () => {
  const work = await budget();
  try {
    for (let i = 0; i < 64; i++) { const lease = await work.requestBudget(origins[0], 'rpc').open(); lease.check(); lease.close(); }
    await assert.rejects(work.requestBudget(origins[0], 'search').open(), /request-budget/);
    const b = await work.requestBudget(origins[1], 'card').open(); b.check(); b.bytes(16 * 1024 * 1024);
    assert.throws(() => b.bytes(1), /byte-budget/); b.close();
    assert.equal(work.snapshot(origins[0]).requests, 64);
    assert.equal(work.snapshot(origins[1]).requests, 1);
    assert.equal(work.snapshot(origins[1]).bytes, 16 * 1024 * 1024);
    assert.equal(work.snapshot(origins[1]).discardedBytes, 1);
    assert.deepEqual(work.snapshot(origins[0]).exhausted, ['request-budget']);
    assert.deepEqual(work.snapshot(origins[1]).exhausted, ['byte-budget']);
  } finally { await work.dispose(); }
});

const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const address = (byte: string): Hex => `0x${byte.repeat(40)}`;
const registry = address('1'), reputation = address('2'), frozenHash = hash('a');
const block = { number: '4', hash: frozenHash, timestamp: 1789123456 };
type Mode = 'normal' | 'altered' | 'wrong-domain' | 'wrong-city' | 'timeout' | 'exhaust' | 'byte-exhaust';
type Row = { id: number; mode?: Mode };

async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => handler(request, response, Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const found = server.address(); assert.ok(found && typeof found !== 'string');
  return { origin: `http://127.0.0.1:${found.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

async function fixture(rows: [Row[], Row[]], options: { reorg?: boolean; stall?: 'observation' | 'card' | 'rpc';
  controller?: AbortController; onlyA?: boolean; bVerificationBarrier?: boolean;
  identityReadback?: 'http-error' | 'timeout' | 'cancelled' | 'changed' } = {}) {
  const calls = { search: [0, 0], observation: [0, 0], card: 0, rpc: 0, a2a: 0 };
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const filters: unknown[] = [], closed = Promise.withResolvers<void>(), bVerified = Promise.withResolvers<void>();
  const stall = (res: ServerResponse) => {
    res.on('close', () => closed.resolve()); res.write(' ');
    // A body-consumption barrier: cancellation is issued only after a chunk was sent.
    if (!options.bVerificationBarrier) setTimeout(() => options.controller?.abort(), 25);
  };
  const json = (res: ServerResponse, value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  const card = await serve((_req, res) => { calls.card++; if (options.stall === 'card') stall(res); else json(res, originalCard); });
  const registration = (id: number) => {
    const value = cloneOriginalRegistration();
    value.registrations = [{ agentId: id, agentRegistry: `eip155:31337:${registry}` }];
    value.services[0]!.endpoint = `${card.origin}/cards/${id}.json`;
    return value;
  };
  let numberedBlockReads = 0;
  const rpc = await serve((_req, res, body) => {
    calls.rpc++;
    const message = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    requests.push(message);
    if (options.stall === 'rpc') { stall(res); return; }
    // These tests use one discovery candidate: observation header, initial
    // identity header, then the identity reader's post-state canonical read-back.
    const identityReadback = message.method === 'eth_getBlockByNumber' && ++numberedBlockReads === 3;
    if (identityReadback && options.identityReadback === 'http-error') {
      res.statusCode = 503; json(res, { error: 'owned final identity read-back unavailable' }); return;
    }
    if (identityReadback && (options.identityReadback === 'timeout' || options.identityReadback === 'cancelled')) {
      stall(res); return;
    }
    let result: unknown;
    if (message.method === 'eth_chainId') result = '0x7a69';
    else if (message.method === 'eth_getBlockByNumber') result = { number: message.params[0],
      hash: options.reorg || (identityReadback && options.identityReadback === 'changed') ? hash('b') :
        message.params[0] === '0x0' ? hash('c') : frozenHash,
      timestamp: '0x6aa3db80', transactions: [], gasLimit: '0x0', gasUsed: '0x0', size: '0x0' };
    else if (message.method === 'eth_call') {
      const call = message.params[0] as { data: string };
      const id = Number(BigInt(`0x${call.data.slice(-64)}`));
      result = call.data.startsWith('0x6352211e') ? encodeAbiParameters([{ type: 'address' }], [originalOwner]) :
        call.data.startsWith('0xc87b56dd') ? encodeAbiParameters([{ type: 'string' }], [dataUriFor(registration(id))]) : '0x';
    } else if (message.method === 'eth_getCode') result = '0x';
    else if (message.method === 'eth_getStorageAt') result = hash('0');
    else if (message.method === 'eth_getLogs') result = [];
    else { json(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture unsupported' } }); return; }
    json(res, { jsonrpc: '2.0', id: message.id, result });
  });
  const indexes: Awaited<ReturnType<typeof serve>>[] = [];
  for (const lane of [0, 1] as const) {
    let origin = '';
    const index = await serve((req, res, body) => {
      if (req.url === '/api/ard/services/search') {
        const request = JSON.parse(body); calls.search[lane]!++; filters.push(request.filter);
        if (rows[lane][0]?.mode === 'timeout') { stall(res); return; }
        const barrier = options.bVerificationBarrier && lane === 1;
        const nextPage = barrier && request.pageToken === 'after-b-verification';
        // searchIndexes awaits onCandidate (including final canonical read-back)
        // before requesting the next page. No production observer hook is needed.
        if (nextPage) bVerified.resolve();
        const entries = nextPage ? [] : rows[lane].map((row) => projection(row));
        json(res, { items: entries, pageToken: barrier && !nextPage ? 'after-b-verification' : null, observerOrigin: origin, coverage: {
          scope: 'local-projection', upstreamSearch: 'not-attempted', paginationConsistency: 'live-keyset',
          readAt: '2026-09-27T00:00:00Z', identitySources: [] } });
      } else if (req.url?.includes('/identity-observations/')) {
        calls.observation[lane]!++;
        if (options.stall === 'observation' && (!options.onlyA || lane === 0)) { stall(res); return; }
        const id = Number.parseInt(req.url.split(':').at(-1)!, 16);
        const row = rows[lane].find((row) => row.id === id)!;
        const p = projection(row), observation = { agent: p.provenance.authority.agent, block,
          owner: originalOwner, agentURI: dataUriFor(registration(id)), agentUriDigest: hash('f'),
          agentUriByteLength: 1, qualification: 'eligible', reason: null,
          declaration: declaration(row) };
        json(res, { observationId: p.provenance.authority.observationId, observation,
          observationBytes: JSON.stringify(observation),
          ...(row.mode === 'byte-exhaust' ? { padding: 'x'.repeat(2 * 1024 * 1024 - 16_384) } : {}) });
      } else { calls.a2a++; res.statusCode = 404; res.end(); }
    });
    origin = index.origin; indexes.push(index);
  }
  function declaration(row: Row) {
    return { identifier: `eip155:${row.mode === 'wrong-domain' ? 1 : 31337}/erc721:${registry}/${row.id}`,
      displayName: row.mode === 'altered' ? 'Altered high-score claim' : originalCard.name,
      type: 'application/agent-card+json', url: row.mode === 'byte-exhaust' ? `http://127.0.0.1:1/cards/${row.id}.json` : `${card.origin}/cards/${row.id}.json`,
      description: 'A public identity fixture for the City profile.',
      capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
      areaServed: [row.mode === 'wrong-city' ? 'https://www.wikidata.org/entity/Q100' : 'https://www.wikidata.org/entity/Q1297'],
      interfaces: ['application/a2a+json;version=0.3'] };
  }
  function projection(row: Row) {
    const chainId = row.mode === 'wrong-domain' ? 1 : 31337;
    return { ...declaration(row), provenance: { sourceId: `erc8004-identity:${chainId}:${registry}`,
      sourceKind: 'erc8004-identity', organizationId: null, revision: '1', observedAt: '2026-09-27T00:00:00Z',
      authority: { kind: 'erc8004-identity', agent: { chainId, registry, agentId: String(row.id) }, block,
        observationId: `sha256:${row.id.toString(16).padStart(64, '0')}` } } };
  }
  const domain = { chainId: 31337, genesisHash: hash('c'), identityRegistry: registry, reputationRegistry: reputation };
  const tx = { transactionHash: hash('d'), blockNumber: '2', blockHash: frozenHash, transactionIndex: 0 };
  const creation = { ...tx, address: address('4'), nonce: '0', runtimeCodeHash: hash('e') };
  const input: Omit<RankingEvidenceInput, 'services'> & { city: 'Chicago' } = {
    city: 'Chicago', rpcOrigin: rpc.origin, cardOrigin: card.origin,
    identityDomain: { chainId: 31337, registry, genesisHash: hash('c'), knownImplementation: { address: address('5'), codeHash: hash('e') } },
    observation: { blockNumber: 4n, blockHash: frozenHash },
    provenance: { domain, deployer: address('3'), artifacts: { referenceCommit: 'fixture',
      solcVersion: '0.8.24', solcTmpVersion: '0.8.24', openZeppelinVersion: '5.4.0', sourceSha256: {}, artifactSha256: {},
      compilerSettings: { evmVersion: 'shanghai', viaIR: true, optimizer: { enabled: true, runs: 200 } } },
      bootstrap: creation, proxy: { ...creation, address: reputation }, implementation: creation, activation: { ...tx, upgradedLogIndex: 0 } },
    indexes: indexes.map(({ origin }) => ({ origin, source: { ...domain, startBlock: '2', confirmations: 0 } })) as unknown as RankingEvidenceInput['indexes'],
    policy: { id: 'fixture', version: '0.1', reviewers: [], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' },
    privateBundleFiles: [], ...(options.controller ? { signal: options.controller.signal } : {}),
  };
  return { input, calls, filters, requests, closed: closed.promise, bVerified: bVerified.promise,
    close: () => Promise.all([rpc.close(), card.close(), ...indexes.map((index) => index.close())]) };
}

test('two actual Index origins verify duplicate identities and feed the existing ranking reader', async () => {
  const f = await fixture([[{ id: 7 }], [{ id: 7 }]]);
  try {
    const result = await discover(f.input);
    assert.equal(result.selected.length, 1);
    assert.deepEqual(result.selected[0]!.origins, f.input.indexes.map(({ origin }) => origin));
    assert.deepEqual(result.candidates.map((row) => row.status), ['verified', 'verified']);
    assert.equal(result.ranking.sidecar.services.length, 1);
    assert.equal(result.ranking.snapshot, 'matched');
    assert.ok(result.ranking.policyResult);
    assert.equal(f.calls.a2a, 0);
    assert.deepEqual(f.filters, [
      { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'], areaServed: ['https://www.wikidata.org/entity/Q1297'], interfaces: ['application/a2a+json;version=0.3'] },
      { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'], areaServed: ['https://www.wikidata.org/entity/Q1297'], interfaces: ['application/a2a+json;version=0.3'] },
    ]);
    for (const origin of result.origins) {
      assert.equal(origin.budget.kinds.search, 1); assert.equal(origin.budget.kinds.observation, 1);
      assert.equal(origin.budget.kinds.card, 1); assert.equal(origin.budget.kinds.rpc, 7);
      assert.equal(origin.budget.inFlight, 0);
    }
    assert.ok(f.requests.filter((r) => r.method === 'eth_call').every((r) => r.params[1] === '0x4'));
  } finally { await f.close(); }
});

test('altered A and wrong-domain rows do not suppress verified B or spend wrong-city verification reads', async () => {
  const f = await fixture([[{ id: 7, mode: 'altered' }, { id: 9, mode: 'wrong-city' }, { id: 10, mode: 'wrong-domain' }], [{ id: 7 }]]);
  try {
    const result = await discover(f.input);
    assert.equal(result.selected.length, 1); assert.deepEqual(result.selected[0]!.origins, [f.input.indexes[1].origin]);
    assert.equal(result.candidates.filter((row) => row.status === 'rejected').length, 3);
    assert.deepEqual(f.calls.observation, [1, 1]);
    assert.ok(result.candidates.some((row) => row.reason?.includes('displayName')));
    assert.equal(result.origins[0]!.status, 'partial');
  } finally { await f.close(); }
});

test('more than six eligible identities yields a deterministic hash-ordered partial shortlist', async () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
  const f = await fixture([rows, [...rows].reverse()]);
  try {
    const result = await discover(f.input);
    assert.equal(result.eligibleCount, 7); assert.equal(result.selected.length, 6);
    assert.equal(result.shortlist, 'partial'); assert.ok(result.diagnostics.includes('partial-shortlist'));
    assert.notDeepEqual(result.selected.map(({ agent }) => agent.agentId), ['1', '2', '3', '4', '5', '6']);
    assert.equal(result.ranking.sidecar.services.length, 6);
    assert.equal(result.candidates.filter((row) => row.status === 'verified').length, 14);
  } finally { await f.close(); }
});

test('a changed frozen block rejects discovery without ranking an old profile', async () => {
  const f = await fixture([[{ id: 7 }], [{ id: 7 }]], { reorg: true });
  try {
    const result = await discover(f.input);
    assert.equal(result.selected.length, 0);
    assert.ok(result.candidates.every((row) => row.status === 'rejected' && row.reason?.includes('canonical')));
    assert.equal(result.ranking.policyResult, null);
  } finally { await f.close(); }
});

for (const failure of ['http-error', 'timeout', 'cancelled'] as const) {
  test(`final identity read-back ${failure} stays unavailable after successful initial header and state reads`, async () => {
    const controller = failure === 'cancelled' ? new AbortController() : undefined;
    const f = await fixture([[{ id: 7 }], []], { identityReadback: failure, ...(controller ? { controller } : {}) });
    try {
      const result = await discover(f.input, { limits: { requestTimeoutMs: 100 } });
      assert.deepEqual(f.requests.slice(0, 6).map(({ method }) => method), [
        'eth_getBlockByNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_call', 'eth_getBlockByNumber',
      ]);
      assert.deepEqual(f.requests.slice(3, 5).map(({ params }) => (params[0] as { data: string }).data.slice(0, 10)).sort(),
        ['0x6352211e', '0xc87b56dd']);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0]!.status, 'unavailable');
      assert.equal(result.candidates[0]!.reason, 'independent verification unavailable');
      assert.deepEqual(result.selected, []);
      assert.equal(f.calls.card, 0);
      assert.equal(result.origins[0]!.budget.kinds.rpc, 6);
      assert.equal(result.origins[0]!.budget.inFlight, 0);
    } finally { await f.close(); }
  });
}

test('a changed hash in final identity read-back remains a rejected reorganization', async () => {
  const f = await fixture([[{ id: 7 }], []], { identityReadback: 'changed' });
  try {
    const result = await discover(f.input);
    assert.deepEqual(f.requests.slice(0, 6).map(({ method }) => method), [
      'eth_getBlockByNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_call', 'eth_getBlockByNumber',
    ]);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.status, 'rejected');
    assert.equal(result.candidates[0]!.reason, 'reorganization during canonical profile read');
    assert.deepEqual(result.selected, []);
    assert.equal(f.calls.card, 0);
  } finally { await f.close(); }
});

for (const stage of ['observation', 'card', 'rpc'] as const) test(`caller abort during ${stage} body settles all acquisition before returning`, async () => {
  const controller = new AbortController(), f = await fixture([[{ id: 7 }], [{ id: 7 }]], { stall: stage, controller });
  try {
    const result = await discover(f.input);
    await Promise.race([f.closed, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('expected stalled response did not close')), 1_000); timer.unref();
    })]);
    assert.equal(result.selected.length, 0); assert.equal(result.status, 'unavailable');
    assert.equal(result.ranking.policyResult, null);
    assert.ok(result.origins.every((origin) => origin.budget.inFlight === 0));
    const before = structuredClone(f.calls); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, before);
  } finally { await f.close(); }
});

test('one origin timeout leaves the other useful and scope mismatch fails before I/O', async () => {
  const f = await fixture([[{ id: 7, mode: 'timeout' }], [{ id: 7 }]]);
  try {
    await assert.rejects(discover({ ...f.input, scope: { ...f.input.scope, city: 'Boston' } }), /scope/);
    assert.deepEqual(f.calls.search, [0, 0]);
    const result = await discover(f.input, { limits: { requestTimeoutMs: 100 } });
    assert.equal(result.selected.length, 1); assert.equal(result.origins[0]!.status, 'unavailable');
    assert.equal(result.origins[1]!.status, 'complete');
  } finally { await f.close(); }
});

test('acquisition deadline aborts slow A but does not erase B already verified at the frozen basis', async () => {
  const f = await fixture([[{ id: 7, mode: 'timeout' }], [{ id: 7 }]]);
  try {
    const result = await discover(f.input, { limits: { totalTimeoutMs: 150 } });
    assert.equal(result.selected.length, 1);
    assert.deepEqual(result.selected[0]!.origins, [f.input.indexes[1].origin]);
    assert.equal(result.status, 'partial');
    assert.ok(result.origins[0]!.budget.exhausted.includes('deadline'));
    assert.equal(result.ranking.snapshot, 'matched');
  } finally { await f.close(); }
});

test('A exhausts actual physical requests without consuming B reservation or exceeding 64 requests', async () => {
  const f = await fixture([Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), [{ id: 101 }]]);
  try {
    const result = await discover(f.input);
    assert.equal(result.origins[0]!.budget.requests, 64);
    assert.ok(result.origins[0]!.budget.exhausted.includes('request-budget'));
    assert.equal(result.origins[1]!.status, 'complete');
    assert.ok(result.candidates.some((candidate) => candidate.agent.agentId === '101' && candidate.status === 'verified'));
    assert.ok(result.eligibleCount >= 7);
    assert.equal(result.origins[0]!.budget.inFlight, 0);
  } finally { await f.close(); }
});

test('oversized decoded observation traffic exhausts only A bytes and preserves B candidates', async () => {
  const f = await fixture([Array.from({ length: 30 }, (_, i) => ({ id: i + 1, mode: 'byte-exhaust' as const })), [{ id: 101 }]]);
  try {
    const result = await discover(f.input);
    assert.ok(result.origins[0]!.budget.exhausted.includes('byte-budget'));
    assert.ok(result.origins[0]!.budget.bytes <= 16 * 1024 * 1024);
    assert.ok(result.origins[0]!.budget.bytes > 15 * 1024 * 1024);
    assert.ok(result.origins[0]!.budget.discardedBytes > 0);
    assert.equal(result.origins[0]!.budget.kinds.rpc, 0);
    assert.equal(result.origins[1]!.status, 'complete');
    assert.deepEqual(result.selected.map(({ agent }) => agent.agentId), ['101']);
  } finally { await f.close(); }
});

test('caller cancellation after B verification clears even previously successful candidates', async () => {
  const controller = new AbortController();
  const f = await fixture([[{ id: 7 }], [{ id: 8 }]], { stall: 'observation', controller, onlyA: true, bVerificationBarrier: true });
  const pending = discover(f.input);
  try {
    await Promise.race([f.bVerified, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('B did not reach its verification barrier')), 5000); timer.unref();
    })]);
    assert.equal(controller.signal.aborted, false, 'A must not cancel B on a wall-clock guess');
    assert.equal(f.calls.search[1], 2, 'B must reach the next-page barrier after its awaited candidate verification');
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.selected, []);
    assert.ok(result.candidates.every((candidate) => candidate.status !== 'verified'));
    assert.equal(result.candidates.find((candidate) => candidate.agent.agentId === '8')?.reason, 'caller cancelled discovery',
      'B must have been verified successfully before cancellation converted its verdict');
    assert.equal(result.origins[1]!.budget.kinds.rpc, 7);
    assert.equal(result.origins[1]!.budget.kinds.card, 1);
    assert.equal(result.ranking.policyResult, null);
    assert.ok(result.origins.every((origin) => origin.budget.inFlight === 0));
  } finally { controller.abort(); try { await pending; } finally { await f.close(); } }
});

test('trusted Town references neither introduce candidates nor leak private paths and duplicates fail before I/O', async () => {
  const f = await fixture([[{ id: 7 }], [{ id: 7 }]]);
  const townRuntime = { checkout: '/private/town-checkout', python: '/private/town-python' };
  const ref = { agent: { chainId: 31337, registry, agentId: '900' }, directory: '/private/never-discovered-town-bundle' };
  try {
    await assert.rejects(discover({ ...f.input, townRuntime, townBundles: [ref, ref] }), /Town references/);
    await assert.rejects(discover({ ...f.input, townRuntime, townBundles: [{ ...ref, agent: { ...ref.agent, chainId: 1 } }] }), /Town references/);
    assert.deepEqual(f.calls.search, [0, 0]);
    const result = await discover({ ...f.input, townRuntime, townBundles: [ref] });
    assert.deepEqual(result.selected.map(({ agent }) => agent.agentId), ['7']);
    assert.deepEqual(result.ranking.sidecar.town, []);
    assert.equal(JSON.stringify(result).includes('/private/'), false);
  } finally { await f.close(); }
});

test('a matching trusted Town path is delegated only to the selected service and stays private', async () => {
  const f = await fixture([[{ id: 7 }], [{ id: 7 }]]);
  try {
    const result = await discover({ ...f.input,
      townRuntime: { checkout: '/private/town-checkout', python: '/private/town-python' },
      townBundles: [{ agent: { chainId: 31337, registry, agentId: '7' }, directory: '/private/selected-town-bundle' }] });
    assert.equal(result.ranking.sidecar.town.length, 1);
    assert.equal(result.ranking.sidecar.town[0]!.admission, 'unavailable');
    assert.equal(JSON.stringify(result).includes('/private/'), false);
  } finally { await f.close(); }
});
