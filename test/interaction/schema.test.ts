import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeStatement, encodeStatement } from '../../src/interaction/bytes.js';

const request = {
  kind: 'request',
  version: '0.1',
  service: {
    method: 'erc8004',
    agent: {
      chainId: 31337,
      registry: '0x1111111111111111111111111111111111111111',
      agentId: '7',
    },
  },
  caller: {
    method: 'eip155-eoa',
    chainId: 31337,
    address: '0x2222222222222222222222222222222222222222',
  },
  interactionId: `0x${'ab'.repeat(32)}`,
  profileBasis: {
    blockNumber: '9123456',
    blockHash: `0x${'aa'.repeat(32)}`,
    agentOwner: '0x3333333333333333333333333333333333333333',
    agentUriDigest: `0x${'bb'.repeat(32)}`,
    registrationDigest: `0x${'cc'.repeat(32)}`,
    cardDigest: `0x${'dd'.repeat(32)}`,
    receiptSigner: '0x4444444444444444444444444444444444444444',
  },
  createdAt: '2026-09-24T12:00:00Z',
  deadline: '2026-09-24T13:00:00Z',
  input: {
    version: '0.1',
    capability: 'evening-plan',
    city: 'Chicago',
    timeWindow: {
      start: '2026-10-02T18:00:00-05:00',
      end: '2026-10-02T22:00:00-05:00',
      timeZone: 'America/Chicago',
    },
    area: 'The Loop',
    budget: { currency: 'USD', minorUnits: '8500' },
    transport: ['walk', 'public-transit'],
    preferences: ['Low carb', 'Step-free access'],
  },
} as const;

const acceptance = {
  kind: 'acceptance',
  version: '0.1',
  requestDigest: `0x${'11'.repeat(32)}`,
  acceptanceId: `0x${'22'.repeat(32)}`,
  acceptedAt: '2026-09-24T12:01:00Z',
  deadline: '2026-09-24T13:00:00Z',
} as const;

const completion = {
  kind: 'completion',
  version: '0.1',
  acceptanceDigest: `0x${'33'.repeat(32)}`,
  recordedAt: '2026-09-24T12:10:00Z',
  outcome: 'completed',
  answerDigest: `0x${'44'.repeat(32)}`,
} as const;

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

test('decodes exact original compact request bytes and returns their Keccak digest', () => {
  const original = bytes(request);
  const decoded = decodeStatement(original);
  assert.deepEqual(decoded.value, request);
  assert.deepEqual(decoded.bytes, original);
  assert.equal(decoded.digest, '0x72022dbf1c2efcab6a068c701df88dbb8e6e80313a8c5a9fccd0fe2c0beaef90');
});

test('encodes acceptance and completion without introducing future answer data', () => {
  assert.deepEqual(decodeStatement(encodeStatement(acceptance).bytes).value, acceptance);
  assert.deepEqual(decodeStatement(encodeStatement(completion).bytes).value, completion);
  assert.throws(() => decodeStatement(bytes({ ...acceptance, answerDigest: completion.answerDigest })), /unknown|unrecognized|answerDigest/i);
});

test('rejects noncanonical JSON, duplicate keys and malformed Unicode before authority checks', () => {
  assert.throws(() => decodeStatement(new TextEncoder().encode(` ${JSON.stringify(request)}`)), /compact|canonical/i);
  assert.throws(() => decodeStatement(new TextEncoder().encode('{"kind":"request","kind":"request"}')), /compact|canonical/i);
  assert.throws(() => decodeStatement(Uint8Array.of(0xff)), /UTF-8/i);
  assert.throws(() => decodeStatement(new TextEncoder().encode('{"kind":"request","version":"\\ud800"}')), /Unicode|surrogate/i);
  assert.throws(() => decodeStatement(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(request), 'utf8'),
  ])), /BOM|JSON|compact|canonical/i);
});

test('rejects oversized or deep payloads and unknown fields', () => {
  assert.throws(() => decodeStatement(new Uint8Array(16 * 1024 + 1)), /16 KiB|size/i);
  assert.throws(() => decodeStatement(bytes({ ...request, extra: true })), /unknown|unrecognized|extra/i);
  assert.throws(() => decodeStatement(bytes({ ...request, input: { ...request.input, preferences: [[[[[[[[['deep']]]]]]]]] } })), /depth|preferences/i);
});

test('enforces local city/zone/offset, real calendar, positive window, budget and transport', () => {
  const changed = (input: object) => bytes({ ...request, input: { ...request.input, ...input } });
  assert.throws(() => decodeStatement(changed({ timeWindow: { ...request.input.timeWindow, start: '2026-10-02T18:00:00-04:00' } })), /zone|offset|start/i);
  assert.throws(() => decodeStatement(changed({ timeWindow: { ...request.input.timeWindow, start: '2026-02-30T18:00:00-05:00' } })), /date|start|window/i);
  assert.throws(() => decodeStatement(changed({ timeWindow: { ...request.input.timeWindow, end: request.input.timeWindow.start } })), /duration|window/i);
  assert.throws(() => decodeStatement(changed({ budget: { currency: 'USD', minorUnits: '01' } })), /minorUnits/i);
  assert.throws(() => decodeStatement(changed({ transport: ['walk', 'walk'] })), /transport|unique/i);
});

test('requires outcome-specific completion fields and canonical UTC timestamps', () => {
  assert.throws(() => decodeStatement(bytes({ ...completion, outcome: 'failed', reason: 'provider-error' })), /answerDigest|unknown|unrecognized/i);
  assert.throws(() => decodeStatement(bytes({ ...completion, outcome: 'cancelled', answerDigest: undefined })), /reason/i);
  assert.throws(() => decodeStatement(bytes({ ...completion, outcome: 'expired', answerDigest: undefined, reason: 'provider-error' })), /reason|unknown|unrecognized/i);
  assert.throws(() => decodeStatement(bytes({ ...request, deadline: '2026-02-30T13:00:00Z' })), /deadline|date|UTC/i);
});

test('rejects uppercase and checksum-style hexadecimal spellings', () => {
  assert.throws(() => decodeStatement(bytes({ ...request, interactionId: `0x${'AB'.repeat(32)}` })), /interactionId|invalid_string/i);
  assert.throws(() => decodeStatement(bytes({ ...request, caller: { ...request.caller, address: '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })), /caller|address|lowercase/i);
});

test('unknown service and caller methods are explicitly unsupported', () => {
  assert.throws(() => decodeStatement(bytes({ ...request, service: { ...request.service, method: 'another-registry' } })), /unsupported/i);
  assert.throws(() => decodeStatement(bytes({ ...request, caller: { ...request.caller, method: 'did:key' } })), /unsupported/i);
});
