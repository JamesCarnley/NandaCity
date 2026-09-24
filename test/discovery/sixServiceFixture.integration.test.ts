import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import test from 'node:test';

import { CITY_REQUEST_DATA_TYPE } from '../../src/a2a/service.js';
import { a2aTaskSchema, type A2ATask } from '../../src/a2a/wire.js';
import { withSixServiceFixture, type FixtureService, type SixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import { verifyJourneyEvidence, type JourneyEvidence } from '../../src/demo/journeyReport.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../../src/interaction/schema.js';

async function sendOwnedProbe(service: FixtureService, fixture: SixServiceFixture): Promise<{
  request: SignedEnvelope; task: A2ATask;
}> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const deadline = new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z');
  const profile = service.profile;
  const request: CityRequest = {
    kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: service.agent },
    caller: { method: 'eip155-eoa', chainId: 31_337,
      address: fixture.callerAddress.toLowerCase() as `0x${string}` },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: {
      blockNumber: profile.source.blockNumber,
      blockHash: profile.source.blockHash.toLowerCase() as `0x${string}`,
      agentOwner: profile.source.agentOwner.toLowerCase() as `0x${string}`,
      agentUriDigest: profile.source.agentUriDigest.toLowerCase() as `0x${string}`,
      registrationDigest: profile.source.registrationDigest.toLowerCase() as `0x${string}`,
      cardDigest: profile.source.cardDigest.toLowerCase() as `0x${string}`,
      receiptSigner: service.runtimeAddress.toLowerCase() as `0x${string}`,
    },
    createdAt, deadline,
    input: { version: '0.1', capability: 'evening-plan', city: service.city,
      timeWindow: service.city === 'Chicago'
        ? { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
          timeZone: 'America/Chicago' }
        : { start: '2026-10-02T18:00:00-04:00', end: '2026-10-02T22:00:00-04:00',
          timeZone: 'America/New_York' },
      area: service.city === 'Chicago' ? 'The Loop' : 'Back Bay',
      budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'], preferences: ['Fixture request'],
    },
  };
  const envelope = await fixture.signAsCaller(request);
  const id = randomUUID();
  const response = await fetch(service.serviceUrl, { method: 'POST',
    headers: { 'content-type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send', params: {
      message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
        data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope } }] },
      configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
    } }), signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const body = await response.json() as { id: string; error?: unknown;
    result?: { status?: { state?: string } } };
  assert.equal(body.id, id);
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  assert.equal(body.result?.status?.state, 'submitted');
  return { request: envelope, task: a2aTaskSchema.parse(body.result) };
}

async function terminalTask(service: FixtureService, taskId: string): Promise<A2ATask> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const id = randomUUID();
    const response = await fetch(service.serviceUrl, { method: 'POST',
      headers: { 'content-type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tasks/get', params: { id: taskId } }),
      signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    const body = await response.json() as { id: string; result?: unknown; error?: unknown };
    assert.equal(body.id, id);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    const task = a2aTaskSchema.parse(body.result);
    if (task.status.state === 'completed' || task.status.state === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('owned service did not finish its A2A Task');
}

test('six owned services converge as three verified city alternatives through both real Indexes',
  { timeout: 180_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    let serviceUrls: string[] = [];
    let indexOrigins: string[] = [];
    let storeDirectories: string[] = [];
    const summary = await withSixServiceFixture(checkout, async (fixture) => {
      const { services, searches } = fixture;
      assert.equal(services.length, 6);
      assert.deepEqual(services.map((service) => service.operatorIndex), [0, 0, 1, 1, 2, 2]);
      assert.deepEqual(services.map((service) => service.city),
        ['Chicago', 'Boston', 'Chicago', 'Boston', 'Chicago', 'Boston']);
      assert.equal(new Set(services.map((service) => service.ownerAddress)).size, 3);
      assert.equal(new Set(services.map((service) => service.agent.agentId)).size, 6);
      assert.equal(new Set(services.map((service) => service.runtimeAddress)).size, 6);
      assert.ok(services.every((service) => service.ownerAddress.toLowerCase() !==
        service.runtimeAddress.toLowerCase() && service.ownerAddress.toLowerCase() !==
        fixture.callerAddress.toLowerCase() && service.runtimeAddress.toLowerCase() !==
        fixture.callerAddress.toLowerCase()));
      assert.equal(new Set(services.map((service) => service.serviceUrl)).size, 6);
      assert.equal(new Set(services.map((service) => service.storeDirectory)).size, 6);
      serviceUrls = services.map((service) => service.serviceUrl);
      storeDirectories = services.map((service) => service.storeDirectory);
      indexOrigins = Object.values(fixture.indexOrigins);
      for (const service of services) {
        assert.equal((await stat(service.storeDirectory)).isDirectory(), true);
        assert.equal(service.profile.card.url, service.serviceUrl);
        assert.equal(service.profile.registration['x-nandacity'].receiptSigner.toLowerCase(),
          service.runtimeAddress.toLowerCase());
      }
      for (const city of ['Chicago', 'Boston'] as const) {
        const expected = services.filter((service) => service.city === city)
          .map((service) => service.agent.agentId).sort();
        const names = services.filter((service) => service.city === city)
          .map((service) => service.profile.registration.name);
        assert.equal(new Set(names).size, 3);
        assert.ok(names.every((name) => name.includes('Fixture')));
        for (const index of ['A', 'B'] as const) {
          const found = searches[city][index];
          assert.equal(found.filter.capabilityIds?.[0], 'urn:nandacity:capability:evening-plan:0.1');
          assert.equal(found.filter.interfaces?.[0], 'application/a2a+json;version=0.3');
          assert.equal(found.filter.areaServed?.length, 1);
          assert.equal(found.result.origins[0]?.available, true);
          assert.deepEqual(found.result.candidates.map((candidate) => candidate.agent.agentId).sort(), expected);
          assert.deepEqual(found.verdicts.map((verdict) => verdict.status),
            ['verified', 'verified', 'verified']);
        }
      }
      assert.equal(fixture.ownerIsolationRejected, true);
      for (const service of services) await sendOwnedProbe(service, fixture);
      return { mode: 'local-fixture' as const, identitiesVerified: services.length,
        ownerIsolationRejected: fixture.ownerIsolationRejected };
    });
    assert.deepEqual(summary, { mode: 'local-fixture', identitiesVerified: 6,
      ownerIsolationRejected: true });
    assert.equal(new Set(indexOrigins).size, 2);
    for (const url of [...serviceUrls, ...indexOrigins]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
    }
    for (const directory of storeDirectories) await assert.rejects(stat(directory), { code: 'ENOENT' });
  });

test('journey verifier separates Index publication N from the later signed request basis M',
  { timeout: 180_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    await withSixServiceFixture(checkout, async (fixture) => {
      const service = fixture.services[0]!;
      const publishedCandidate = fixture.searches.Chicago.A.result.candidates.find((item) =>
        item.agent.agentId === service.agent.agentId);
      assert.ok(publishedCandidate);
      const { request, task: submitted } = await sendOwnedProbe(service, fixture);
      const task = await terminalTask(service, submitted.id);
      assert.equal(task.status.state, 'completed');
      const metadata = task.metadata?.['org.nandacity'] as Record<string, unknown>;
      const data = task.artifacts?.[0]?.parts[0]?.data;
      assert.equal(typeof data?.['answerBase64'], 'string');
      const basisObservation = await readIdentitySnapshot(fixture.chain, service.agent,
        BigInt(service.profile.source.blockNumber));
      const currentObservation = await readIdentitySnapshot(fixture.chain, service.agent);
      const earlierObservation = await readIdentitySnapshot(fixture.chain, service.agent,
        BigInt(basisObservation.blockNumber) - 1n);
      assert.equal(earlierObservation.agentURI, basisObservation.agentURI);
      assert.equal(earlierObservation.agentOwner.toLowerCase(), basisObservation.agentOwner.toLowerCase());
      // Model an Index row issued at the earlier canonical block while retaining
      // the exact declaration and card supplied by the running Index.
      const candidate = { ...publishedCandidate, observationBlock: {
        number: earlierObservation.blockNumber, hash: earlierObservation.blockHash,
        timestamp: earlierObservation.blockTimestamp } };
      assert.ok(BigInt(candidate.observationBlock.number) < BigInt(basisObservation.blockNumber),
        'the publication observation must precede the signed request basis');
      assert.equal(currentObservation.blockNumber, basisObservation.blockNumber);
      const evidence: JourneyEvidence = { candidate,
        cardBase64: Buffer.from(service.cardBytes).toString('base64'), request,
        acceptance: envelopeSchema.parse(metadata['acceptance']),
        completion: envelopeSchema.parse(metadata['completion']),
        answerBase64: data!['answerBase64'] as string, task,
        basisObservation, currentObservation,
        observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
      const valid = await verifyJourneyEvidence(evidence, fixture.chain, fixture.domain,
        fixture.searches.Chicago.A.filter, fixture.cardOrigin);
      assert.equal(valid.discovery.status, 'verified');
      assert.equal(valid.request?.profileBasis, 'matched');
      assert.equal(valid.evidenceUsable, true, JSON.stringify(valid.reasons));

      const wrongBasis = await verifyJourneyEvidence({ ...evidence,
        basisObservation: await readIdentitySnapshot(fixture.chain, service.agent,
          BigInt(candidate.observationBlock.number)) }, fixture.chain, fixture.domain,
      fixture.searches.Chicago.A.filter, fixture.cardOrigin);
      assert.equal(wrongBasis.firstBrokenBoundary, 'authority-basis');
      assert.equal(wrongBasis.evidenceUsable, false);

      const requestValue = JSON.parse(Buffer.from(request.payloadBase64, 'base64').toString('utf8')) as CityRequest;
      const wrongAgents = [fixture.services[1]!.agent,
        { ...service.agent, registry: '0x7777777777777777777777777777777777777777' as const },
        { ...service.agent, chainId: service.agent.chainId + 1 }];
      for (const wrongAgent of wrongAgents) {
        const wrongService = await verifyJourneyEvidence({ ...evidence,
          request: await fixture.signAsCaller({ ...requestValue,
            service: { method: 'erc8004', agent: wrongAgent },
            caller: { ...requestValue.caller, chainId: wrongAgent.chainId } }),
        }, fixture.chain, fixture.domain, fixture.searches.Chicago.A.filter,
        fixture.cardOrigin);
        assert.equal(wrongService.evidenceUsable, false);
        assert.equal(wrongService.firstBrokenBoundary, 'evidence');
      }

      const wrongKind = await verifyJourneyEvidence({ ...evidence,
        request: evidence.acceptance }, fixture.chain, fixture.domain,
      fixture.searches.Chicago.A.filter, fixture.cardOrigin);
      assert.equal(wrongKind.evidenceUsable, false);
      assert.equal(wrongKind.firstBrokenBoundary, 'evidence');

      const tamperedPublication = await verifyJourneyEvidence({ ...evidence,
        candidate: { ...candidate, observationBlock: { ...candidate.observationBlock,
          hash: `0x${'ab'.repeat(32)}` } } }, fixture.chain, fixture.domain,
      fixture.searches.Chicago.A.filter, fixture.cardOrigin);
      assert.equal(tamperedPublication.discovery.status, 'rejected');
      assert.equal(tamperedPublication.firstBrokenBoundary, 'discovery');
    });
  });
