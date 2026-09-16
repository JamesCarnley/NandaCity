import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyProfile } from '../../src/identity/verify.js';
import {
  bytesFor,
  cloneOriginalCard,
  cloneOriginalRegistration,
  dataUriFor,
  makeFixtureCandidate,
  newAgentUriDigest,
  newBasis,
  newCandidate,
  newCard,
  newCardDigest,
  newOwner,
  newRegistrationDigest,
  originalAgentUriDigest,
  originalBasis,
  originalCandidate,
  originalCard,
  originalCardDigest,
  originalOwner,
  originalRegistrationDigest,
  registryAddress,
} from './fixtures.js';

test('accepts an owner-bound profile at an explicit historical snapshot', () => {
  const verified = verifyProfile(originalCandidate, originalBasis);

  assert.equal(verified.agent.agentId, '7');
  assert.deepEqual(verified.card, originalCard);
  assert.equal(verified.registration.registrations[0]?.agentId, '7');
  assert.deepEqual(verified.source, {
    blockNumber: '9123456',
    blockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    blockTimestamp: 1_789_123_456,
    agentOwner: originalOwner,
    agentUriDigest: originalAgentUriDigest,
    registrationDigest: originalRegistrationDigest,
    cardDigest: originalCardDigest,
  });
  assert.equal('trusted' in verified, false);
  assert.equal('safe' in verified, false);
  assert.equal('endorsed' in verified, false);
  assert.equal('live' in verified, false);
});

test('accepts a new owner profile and card when the new snapshot matches', () => {
  const verified = verifyProfile(newCandidate, newBasis);

  assert.deepEqual(verified.card, newCard);
  assert.equal(verified.registration['x-nandacity'].ownerAtPublication, newOwner);
  assert.deepEqual(verified.source, {
    blockNumber: '9123999',
    blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    blockTimestamp: 1_789_127_999,
    agentOwner: newOwner,
    agentUriDigest: newAgentUriDigest,
    registrationDigest: newRegistrationDigest,
    cardDigest: newCardDigest,
  });
});

test('rejects an Index changing the invocation endpoint', () => {
  const changed = makeFixtureCandidate({ endpoint: 'https://different.example/a2a' });
  assert.throws(() => verifyProfile(changed, originalBasis), /agentURI/i);
});

test('does not carry old signer authority across ownership transfer', () => {
  assert.throws(
    () => verifyProfile(originalCandidate, { ...originalBasis, agentOwner: newOwner }),
    /ownerAtPublication|owner/i,
  );
});

test('rejects a candidate reference that does not match the authority snapshot', () => {
  assert.throws(
    () =>
      verifyProfile(
        { ...originalCandidate, agent: { ...originalCandidate.agent, chainId: 1 } },
        originalBasis,
      ),
    /snapshot agent/i,
  );
});

test('requires the registration to match the exact chain, registry, and agent ID', () => {
  const cases = [
    { ...originalCandidate.agent, chainId: 1 },
    {
      ...originalCandidate.agent,
      registry: '0x6666666666666666666666666666666666666666' as const,
    },
    { ...originalCandidate.agent, agentId: '8' },
  ];

  for (const agent of cases) {
    assert.throws(
      () =>
        verifyProfile(
          { ...originalCandidate, agent },
          { ...originalBasis, agent },
        ),
      /matching registration/i,
    );
  }
});

test('rejects card bytes that differ from the owner-published digest', () => {
  const alteredCard = cloneOriginalCard();
  alteredCard.description = 'Altered after publication.';
  assert.throws(
    () =>
      verifyProfile(
        { ...originalCandidate, cardBytes: bytesFor(alteredCard) },
        originalBasis,
      ),
    /cardDigest/i,
  );
});

test('binds the card invocation URL exactly to the registration endpoint', () => {
  const registration = cloneOriginalRegistration();
  registration['x-nandacity'].endpoint = 'https://different.example/a2a';
  const candidate = {
    ...originalCandidate,
    agentURI: dataUriFor(registration),
  };
  const basis = { ...originalBasis, agentURI: candidate.agentURI };

  assert.throws(() => verifyProfile(candidate, basis), /card URL.*endpoint/i);
});

test('rejects malformed and oversized card bytes before treating them as a profile', () => {
  assert.throws(
    () => verifyProfile({ ...originalCandidate, cardBytes: Uint8Array.of(0xff) }, originalBasis),
    /UTF-8/i,
  );
  assert.throws(
    () =>
      verifyProfile(
        { ...originalCandidate, cardBytes: new Uint8Array(64 * 1024 + 1) },
        originalBasis,
      ),
    /64 KiB/i,
  );
});

test('rejects malformed snapshot and candidate identifiers', () => {
  assert.throws(
    () =>
      verifyProfile(originalCandidate, {
        ...originalBasis,
        blockNumber: '09123456',
      }),
    /blockNumber/i,
  );
  assert.throws(
    () =>
      verifyProfile(
        {
          ...originalCandidate,
          agent: { ...originalCandidate.agent, registry: registryAddress.toUpperCase() as `0x${string}` },
        },
        originalBasis,
      ),
    /registry|snapshot agent/i,
  );
});
