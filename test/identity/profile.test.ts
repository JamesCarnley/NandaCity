import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CARD_BYTES,
  MAX_REGISTRATION_BYTES,
  decodeCard,
  decodeRegistration,
  digestBytes,
  encodeRegistration,
} from '../../src/identity/profile.js';
import {
  bytesFor,
  cloneOriginalCard,
  cloneOriginalRegistration,
  dataUriFor,
  originalCard,
  originalCardDigest,
  originalRegistration,
  registryAddress,
} from './fixtures.js';

test('roundtrips a registration, qualifies numeric IDs, and retains unrelated extensions', () => {
  const encoded = encodeRegistration(originalRegistration);
  const decoded = decodeRegistration(encoded);
  const encodedJson = JSON.parse(
    Buffer.from(encoded.split(',')[1]!, 'base64').toString('utf8'),
  ) as { registrations: Array<{ agentId: unknown }> };

  assert.equal(typeof encodedJson.registrations[0]?.agentId, 'number');
  assert.equal(decoded.registrations[0]?.agentId, '7');
  assert.equal(
    decoded.registrations[0]?.agentRegistry,
    `eip155:11155111:${registryAddress}`,
  );
  assert.deepEqual(decoded['x-example'], { source: 'public-test-fixture' });
  assert.deepEqual(decodeRegistration(encodeRegistration(decoded)), decoded);
});

test('hashes the exact supplied bytes with keccak256', () => {
  assert.equal(digestBytes(bytesFor(originalCard)), originalCardDigest);
  assert.equal(
    digestBytes(new TextEncoder().encode('abc')),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
});

test('decodes the fully shaped selected A2A 0.3 card subset', () => {
  assert.deepEqual(decodeCard(bytesFor(originalCard)), originalCard);
});

test('rejects unsafe and noncanonical registration IDs', () => {
  const unsafe = cloneOriginalRegistration();
  unsafe.registrations[0]!.agentId = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => encodeRegistration(unsafe), /agentId/i);

  const noncanonical = cloneOriginalRegistration() as unknown as {
    registrations: Array<{ agentId: string }>;
  };
  noncanonical.registrations[0]!.agentId = '07';
  assert.throws(() => encodeRegistration(noncanonical), /agentId/i);

  const unsafeString = cloneOriginalRegistration() as unknown as {
    registrations: Array<{ agentId: string }>;
  };
  unsafeString.registrations[0]!.agentId = '9007199254740992';
  assert.throws(() => encodeRegistration(unsafeString), /agentId/i);

  const oversizedString = cloneOriginalRegistration() as unknown as {
    registrations: Array<{ agentId: string }>;
  };
  oversizedString.registrations[0]!.agentId = '1'.repeat(17);
  assert.throws(
    () => encodeRegistration(oversizedString),
    /agentId.*at most 16 digits/i,
  );
});

test('rejects string registration IDs on the wire', () => {
  const stringId = cloneOriginalRegistration() as unknown as {
    registrations: Array<{ agentId: string }>;
  };
  stringId.registrations[0]!.agentId = '7';

  assert.throws(() => decodeRegistration(dataUriFor(stringId)), /agentId/i);
});

test('rejects malformed registration payloads and fatal UTF-8 failures', () => {
  assert.throws(() => decodeRegistration('https://city.example/profile.json'), /data URI/i);
  assert.throws(
    () => decodeRegistration('data:application/json;base64,%%%'),
    /base64/i,
  );
  assert.throws(
    () =>
      decodeRegistration(
        `data:application/json;base64,${Buffer.from(Uint8Array.of(0xff)).toString('base64')}`,
      ),
    /UTF-8/i,
  );
});

test('rejects registration and card inputs above their byte limits', () => {
  const tooLargeRegistration = new Uint8Array(MAX_REGISTRATION_BYTES + 1).fill(0x20);
  const tooLongEncoded = `data:application/json;base64,${Buffer.from(tooLargeRegistration).toString('base64')}`;
  assert.throws(() => decodeRegistration(tooLongEncoded), /32 KiB/i);

  const tooLargeCard = new Uint8Array(MAX_CARD_BYTES + 1).fill(0x20);
  assert.throws(() => decodeCard(tooLargeCard), /64 KiB/i);

  const hugeInput = cloneOriginalRegistration();
  hugeInput.description = 'x'.repeat(MAX_REGISTRATION_BYTES);
  assert.throws(() => encodeRegistration(hugeInput), /32 KiB/i);
});

test('requires exactly one A2A 0.3 service', () => {
  const duplicate = cloneOriginalRegistration();
  duplicate.services.push(structuredClone(duplicate.services[0]!));
  assert.throws(() => encodeRegistration(duplicate), /exactly one A2A/i);

  const missing = cloneOriginalRegistration();
  missing.services = [];
  assert.throws(() => encodeRegistration(missing), /exactly one A2A/i);

  const wrongVersion = cloneOriginalRegistration();
  wrongVersion.services[0]!.version = '0.2.0';
  assert.throws(() => encodeRegistration(wrongVersion), /A2A.*0\.3\.0/i);
});

test('rejects unsupported or extended x-nandacity versions', () => {
  const unsupported = cloneOriginalRegistration();
  unsupported['x-nandacity'].version = '0.2' as '0.1';
  assert.throws(() => encodeRegistration(unsupported), /version/i);

  const unknownField = cloneOriginalRegistration() as typeof originalRegistration & {
    'x-nandacity': typeof originalRegistration['x-nandacity'] & { extra?: string };
  };
  unknownField['x-nandacity'].extra = 'not-versioned';
  assert.throws(() => encodeRegistration(unknownField), /unrecognized|extra/i);
});

test('rejects malformed hashes, zero addresses, and invalid revisions', () => {
  const malformedDigest = cloneOriginalRegistration();
  malformedDigest['x-nandacity'].cardDigest = '0x12' as typeof originalCardDigest;
  assert.throws(() => encodeRegistration(malformedDigest), /cardDigest/i);

  const zeroOwner = cloneOriginalRegistration();
  zeroOwner['x-nandacity'].ownerAtPublication =
    '0x0000000000000000000000000000000000000000' as typeof zeroOwner['x-nandacity']['ownerAtPublication'];
  assert.throws(() => encodeRegistration(zeroOwner), /ownerAtPublication/i);

  const zeroRevision = cloneOriginalRegistration();
  zeroRevision['x-nandacity'].revision = 0;
  assert.throws(() => encodeRegistration(zeroRevision), /revision/i);
});

test('accepts HTTPS and explicit loopback HTTP but rejects unsafe bound URLs', () => {
  const loopback = cloneOriginalRegistration();
  loopback.image = 'http://127.0.0.1:8080/image.png';
  loopback.services[0]!.endpoint = 'http://localhost:8080/agent-card.json';
  loopback['x-nandacity'].endpoint = 'http://[::1]:8080/a2a';
  assert.doesNotThrow(() => encodeRegistration(loopback));

  for (const endpoint of [
    'http://planner.example/a2a',
    'https://user:password@planner.example/a2a',
    'https://planner.example/a2a#fragment',
    'https://planner.example/a2a#',
  ]) {
    const invalid = cloneOriginalRegistration();
    invalid['x-nandacity'].endpoint = endpoint;
    assert.throws(() => encodeRegistration(invalid), /endpoint/i);
  }
});

test('rejects incomplete or unsupported A2A cards', () => {
  const unsupported = cloneOriginalCard();
  unsupported.protocolVersion = '0.2.0';
  assert.throws(() => decodeCard(bytesFor(unsupported)), /protocolVersion/i);

  const incomplete = cloneOriginalCard() as Partial<typeof originalCard>;
  delete incomplete.defaultOutputModes;
  assert.throws(() => decodeCard(bytesFor(incomplete)), /defaultOutputModes/i);

  const wrongTransport = cloneOriginalCard();
  wrongTransport.preferredTransport = 'HTTP+JSON' as 'JSONRPC';
  assert.throws(() => decodeCard(bytesFor(wrongTransport)), /preferredTransport/i);
});

test('registration decoding validates manually encoded documents', () => {
  const duplicate = cloneOriginalRegistration();
  duplicate.services.push(structuredClone(duplicate.services[0]!));
  assert.throws(() => decodeRegistration(dataUriFor(duplicate)), /exactly one A2A/i);
});
