import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicClient, http } from 'viem';
import { verifyDiscovery, verifyDiscoveryAtCurrentChain, verifyDiscoveryWithCard,
  type DiscoveredCandidate } from '../../src/discovery/verifyDiscovery.js';
import {
  bytesFor, newBasis, originalAgent, originalBasis, originalCandidate,
  originalCard, originalOwner,
} from '../identity/fixtures.js';

const chicago = 'https://www.wikidata.org/entity/Q1297';
const filter = { areaServed: [chicago] };
const trustedDomain = { chainId: originalAgent.chainId, registry: originalAgent.registry };
const declaration = {
  identifier: `eip155:11155111/erc721:${originalAgent.registry}/7`,
  displayName: 'NANDA City Chicago Planner',
  type: 'application/agent-card+json',
  url: 'https://planner.example/.well-known/agent-card.json',
  description: 'A public identity fixture for the City profile.',
  capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
  areaServed: [chicago],
  interfaces: ['application/a2a+json;version=0.3'],
};
const candidate: DiscoveredCandidate = {
  observerOrigin: 'http://127.0.0.1:31001', agent: originalAgent,
  agentURI: originalCandidate.agentURI, declaration,
  observationBlock: {
    number: originalBasis.blockNumber, hash: originalBasis.blockHash,
    timestamp: originalBasis.blockTimestamp,
  },
};

test('accepts an exact declaration at an explicit authority basis', () => {
  const result = verifyDiscovery(candidate, originalBasis, bytesFor(originalCard), filter);
  assert.equal(result.status, 'verified');
  assert.equal(result.observerOrigin, candidate.observerOrigin);
});

test('rejects every changed normalized declaration field', () => {
  const alterations = [
    { displayName: 'Changed Name' },
    { url: 'https://altered.example/card.json' },
    { description: 'Changed description' },
    { capabilityIds: ['urn:wrong'] },
    { areaServed: ['https://www.wikidata.org/entity/Q100'] },
    { interfaces: ['application/json'] },
    { identifier: 'unqualified' },
    { type: 'application/json' },
  ];
  for (const change of alterations) {
    const result = verifyDiscovery({ ...candidate, declaration: { ...declaration, ...change } },
      originalBasis, bytesFor(originalCard), filter);
    assert.equal(result.status, 'rejected', JSON.stringify(change));
  }
});

test('rejects stale registration against fresh state but permits explicit history', () => {
  assert.equal(verifyDiscovery(candidate, newBasis, bytesFor(originalCard), filter).status, 'rejected');
  assert.equal(verifyDiscovery(candidate, originalBasis, bytesFor(originalCard), filter).status, 'verified');
});

test('same-height observation timestamp must match its claimed authority block', () => {
  const altered = { ...candidate, observationBlock: { ...candidate.observationBlock,
    timestamp: candidate.observationBlock.timestamp + 1 } };
  assert.equal(verifyDiscovery(altered, originalBasis, bytesFor(originalCard), filter).status,
    'rejected');
});

test('rejects inactive profile, changed exact card bytes and filtered-out city', () => {
  const inactive = structuredClone(candidate);
  const registration = JSON.parse(Buffer.from(candidate.agentURI.split(',')[1]!, 'base64').toString());
  registration.active = false;
  inactive.agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
  assert.equal(verifyDiscovery(inactive, { ...originalBasis, agentURI: inactive.agentURI },
    bytesFor(originalCard), filter).status, 'rejected');
  const changedCard = { ...originalCard, description: 'changed exact card bytes' };
  assert.equal(verifyDiscovery(candidate, originalBasis, bytesFor(changedCard), filter).status, 'rejected');
  assert.equal(verifyDiscovery(candidate, originalBasis, bytesFor(originalCard),
    { areaServed: ['https://www.wikidata.org/entity/Q100'] }).status, 'rejected');
  assert.equal(verifyDiscovery(candidate, { ...originalBasis, agentOwner: originalOwner },
    bytesFor(originalCard), filter).status, 'verified');
});

test('separate unavailable chain connection does not become a rejected candidate', async () => {
  const offline = createPublicClient({ transport: http('http://127.0.0.1:1', {
    retryCount: 0, timeout: 200 }) });
  const verdict = await verifyDiscoveryAtCurrentChain(candidate, offline,
    trustedDomain, bytesFor(originalCard), filter);
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.observerOrigin, candidate.observerOrigin);
});

test('unavailable card transport is not reported as a profile rejection', async () => {
  const offline = createPublicClient({ transport: http('http://127.0.0.1:1', {
    retryCount: 0, timeout: 200 }) });
  const verdict = await verifyDiscoveryWithCard(candidate, offline, trustedDomain, filter,
    async () => { throw new Error('owned card service unavailable'); });
  assert.equal(verdict.status, 'unavailable');
  assert.match(verdict.status === 'unavailable' ? verdict.reason : '', /card fetch/);
});

test('client-selected identity domain rejects a foreign registry before card or chain I/O', async () => {
  const foreign = { ...candidate, agent: { ...candidate.agent,
    registry: '0x9999999999999999999999999999999999999999' as const } };
  const offline = createPublicClient({ transport: http('http://127.0.0.1:1', {
    retryCount: 0, timeout: 200 }) });
  let cardReads = 0;
  const verdict = await verifyDiscoveryWithCard(foreign, offline, trustedDomain, filter,
    async () => { cardReads++; return bytesFor(originalCard); });
  assert.equal(verdict.status, 'rejected');
  assert.equal(cardReads, 0);
  const direct = await verifyDiscoveryAtCurrentChain(foreign, offline, trustedDomain,
    bytesFor(originalCard), filter);
  assert.equal(direct.status, 'rejected');
  const foreignChain = { ...candidate, agent: { ...candidate.agent, chainId: 31337 } };
  assert.equal((await verifyDiscoveryWithCard(foreignChain, offline, trustedDomain, filter,
    async () => { cardReads++; return bytesFor(originalCard); })).status, 'rejected');
  assert.equal(cardReads, 0);
});
