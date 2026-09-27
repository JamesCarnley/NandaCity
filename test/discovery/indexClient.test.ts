import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { searchIndexes } from '../../src/discovery/indexClient.js';
import { DiscoveryReadBudget } from '../../src/discovery/readBudget.js';
import { originalAgent, originalBasis, originalCandidate } from '../identity/fixtures.js';

const area = 'https://www.wikidata.org/entity/Q1297';
const observationId = `sha256:${'a'.repeat(64)}`;
const sourceId = `erc8004-identity:${originalAgent.chainId}:${originalAgent.registry}`;
const block = { number: originalBasis.blockNumber, hash: originalBasis.blockHash,
  timestamp: originalBasis.blockTimestamp };
const declaration = {
  identifier: `eip155:11155111/erc721:${originalAgent.registry}/7`,
  displayName: 'NANDA City Chicago Planner', type: 'application/agent-card+json',
  url: 'https://planner.example/.well-known/agent-card.json',
  description: 'A public identity fixture for the City profile.',
  capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
  areaServed: [area], interfaces: ['application/a2a+json;version=0.3'],
};
const coverage = {
  sourceId, stateVersion: '2', availability: 'available', progress: 'synchronized',
  checkpoint: block, observedHead: block, finalizedBlock: block, confirmations: 0,
  lastSuccessAt: '2026-09-23T00:00:00.000Z', lastAttemptAt: '2026-09-23T00:00:00.000Z',
};
const observation = {
  agent: originalAgent, block, owner: originalBasis.agentOwner,
  agentURI: originalCandidate.agentURI, agentUriDigest: '0x' + 'b'.repeat(64),
  agentUriByteLength: Buffer.byteLength(originalCandidate.agentURI),
  qualification: 'eligible', reason: null, declaration,
};

async function serve(handler: (path: string) => { status?: number; body: unknown }): Promise<{
  origin: string; close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const result = handler(request.url ?? '/');
    response.statusCode = result.status ?? 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function indexResponse(origin: string, authorityKind = 'erc8004-identity') {
  return { items: [{ ...declaration, provenance: {
    sourceId, sourceKind: 'erc8004-identity', organizationId: null,
    revision: observationId, observedAt: '2026-09-23T00:00:00.000Z',
    authority: { kind: authorityKind, agent: originalAgent, block, observationId },
  } }], pageToken: null, observerOrigin: origin,
  coverage: { scope: 'local-projection', upstreamSearch: 'not-attempted',
    paginationConsistency: 'live-keyset', readAt: '2026-09-23T00:00:00.000Z',
    identitySources: [coverage] } };
}

test('keeps identical source labels from two contacted origins distinct', async () => {
  const servers: Awaited<ReturnType<typeof serve>>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      let origin = '';
      const server = await serve((path) => path.includes('identity-observations/')
        ? { body: { observationId, observation, observationBytes: JSON.stringify(observation) } }
        : { body: indexResponse(origin) });
      origin = server.origin;
      servers.push(server);
    }
    const result = await searchIndexes(servers.map((server) => server.origin), { areaServed: [area] });
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map((candidate) => candidate.observerOrigin).sort(),
      servers.map((server) => server.origin).sort());
    assert.deepEqual(result.origins.map((entry) => entry.coverage?.identitySources[0]?.sourceId),
      [sourceId, sourceId]);
  } finally { await Promise.all(servers.map((server) => server.close())); }
});

test('unknown authority is rejected while another origin remains usable', async () => {
  let badOrigin = '';
  const bad = await serve(() => ({ body: indexResponse(badOrigin, 'origin-asserted') }));
  badOrigin = bad.origin;
  let goodOrigin = '';
  const good = await serve((path) => path.includes('identity-observations/')
    ? { body: { observationId, observation, observationBytes: JSON.stringify(observation) } }
    : { body: indexResponse(goodOrigin) });
  goodOrigin = good.origin;
  try {
    const result = await searchIndexes([bad.origin, good.origin], { areaServed: [area] });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.observerOrigin, good.origin);
    assert.match(result.origins[0]!.errors.join(' '), /authority/i);
    assert.equal(result.origins[0]!.coverage?.identitySources[0]?.sourceId, sourceId);
  } finally { await bad.close(); await good.close(); }
});

test('HTTP failures preserve per-origin unavailability, not empty catalog', async () => {
  const server = await serve(() => ({ status: 503, body: { error: 'unavailable' } }));
  try {
    const result = await searchIndexes([server.origin], { areaServed: [area] });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.origins[0]!.coverage, null);
    assert.match(result.origins[0]!.errors.join(' '), /503/);
  } finally { await server.close(); }
});

test('malformed returned search data is rejected, unlike a failed fetch', async () => {
  const server = await serve(() => ({ body: { items: 'not-an-array' } }));
  try {
    const result = await searchIndexes([server.origin], { areaServed: [area] });
    assert.equal(result.candidates.length, 0);
    assert.match(result.origins[0]!.errors[0]!, /^rejected: malformed Index search response$/);
  } finally { await server.close(); }
});

test('rejects uncontracted off-origin observation link instead of following it', async () => {
  let origin = '';
  const server = await serve((path) => {
    if (path.includes('identity-observations/')) {
      return { body: { observationId, observation, observationBytes: JSON.stringify(observation) } };
    }
    const body = indexResponse(origin);
    Object.assign(body.items[0]!, { observationUrl: 'https://elsewhere.example/observation' });
    return { body };
  });
  origin = server.origin;
  try {
    const result = await searchIndexes([origin], { areaServed: [area] });
    assert.equal(result.candidates.length, 0);
    assert.match(result.origins[0]!.errors.join(' '), /malformed|unknown|uncontracted/i);
  } finally { await server.close(); }
});

test('rejects an over-budget search body without treating it as empty coverage', async () => {
  const server = await serve(() => ({ body: { padding: 'x'.repeat(2 * 1024 * 1024 + 1) } }));
  try {
    const result = await searchIndexes([server.origin], { areaServed: [area] });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.origins[0]!.coverage, null);
    assert.match(result.origins[0]!.errors.join(' '), /2 MiB/);
  } finally { await server.close(); }
});

test('configured search filters irrelevant declarations before observation reads and awaits candidates', async () => {
  let origin = '', observations = 0, consumed = 0;
  const server = await serve((path) => {
    if (path.includes('identity-observations/')) {
      observations++;
      return { body: { observationId, observation, observationBytes: JSON.stringify(observation) } };
    }
    const body = indexResponse(origin);
    body.items.unshift({ ...body.items[0]!, areaServed: ['https://www.wikidata.org/entity/Q100'] });
    return { body };
  });
  origin = server.origin;
  try {
    const result = await searchIndexes([origin], { areaServed: [area] }, {
      filterDeclarations: true,
      onCandidate: async () => { await Promise.resolve(); consumed++; },
    });
    assert.equal(observations, 1);
    assert.equal(consumed, 1);
    assert.equal(result.candidates.length, 1);
  } finally { await server.close(); }
});

test('configured caller cancellation settles an observation body without later requests', async () => {
  const controller = new AbortController();
  let origin = '', calls = 0;
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    calls++;
    response.setHeader('content-type', 'application/json');
    if (request.url?.includes('identity-observations/')) {
      response.write('{');
      response.once('close', () => { closed.resolve(); });
      controller.abort();
    } else response.end(JSON.stringify(indexResponse(origin)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await searchIndexes([origin], {}, { signal: controller.signal });
    await Promise.race([closed.promise, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('cancelled body remained open')), 1_000); timer.unref();
    })]);
    assert.equal(result.candidates.length, 0);
    assert.equal(calls, 2);
    assert.match(result.origins[0]!.errors.join(' '), /unavailable/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('configured search retains the ten-page ceiling and meters physical page reads', async () => {
  let origin = '', calls = 0, bytes = 0, pages = 0;
  const server = await serve(() => {
    const body = indexResponse(origin); body.items = []; body.pageToken = `page-${++pages}` as never;
    return { body };
  });
  origin = server.origin;
  try {
    const result = await searchIndexes([origin], {}, { requestBudget: () => ({ open: async () => {
      let charged = false;
      return { signal: new AbortController().signal, check: () => { if (!charged) { calls++; charged = true; } },
        bytes: (length) => { bytes += length; }, close: () => {} };
    } }) });
    assert.equal(calls, 10); assert.equal(pages, 10); assert.ok(bytes > 0);
    assert.match(result.origins[0]!.errors.join(' '), /page limit/);
  } finally { await server.close(); }
});

for (const budgeted of [true, false]) test(`default five-second Index deadline ${budgeted ? 'records the lease exhaustion' : 'still bounds unbudgeted reads'}`, { timeout: 10000 }, async () => {
  const closed = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.once('close', () => closed.resolve()); response.write('{');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const work = budgeted ? new DiscoveryReadBudget({ origins: [origin, 'http://127.0.0.1:1'] }) : undefined;
  try {
    const result = await searchIndexes([origin], {}, work ? { requestBudget: (lane, kind) => ({
      open: async (signal) => {
        // Exercise asynchronous lease acquisition with the real default five-second
        // deadline. An outer timer started before open would win and lose the code.
        await delay(50); return work.requestBudget(lane, kind).open(signal);
      },
    }) } : {});
    assert.equal(result.candidates.length, 0); assert.equal(result.origins[0]!.available, false);
    assert.match(result.origins[0]!.errors.join(' '), /unavailable/);
    if (work) {
      assert.deepEqual(work.snapshot(origin).exhausted, ['request-timeout']);
      assert.equal(work.snapshot(origin).inFlight, 0);
      assert.equal(work.snapshot(origin).requests, 1);
    }
    await closed.promise;
  } finally {
    await work?.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
