import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import test from 'node:test';

import { CITY_REQUEST_DATA_TYPE } from '../../src/a2a/service.js';
import { withSixServiceFixture, type FixtureService, type SixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import type { CityRequest } from '../../src/interaction/schema.js';

async function sendOwnedProbe(service: FixtureService, fixture: SixServiceFixture): Promise<void> {
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
