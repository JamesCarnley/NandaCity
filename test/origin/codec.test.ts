import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { decodeEnvelope as decodeEthereum } from '../../src/interaction/signatures.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

const controller = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const runtime = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const caller = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const key = (account: typeof controller) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
const digest = `0x${'ab'.repeat(32)}`;
const service = { method: 'https-origin' as const, identityUrl: 'https://127.0.0.1:9443/identity' };
const common = { profile: 'city-origin@0.1' as const, service };
const profile = { ...common, kind: 'profile' as const, revision: '1', active: true,
  controllerKey: key(controller), runtimeKey: key(runtime), cardURL: 'https://127.0.0.1:9444/card',
  cardDigest: digest, endpoint: 'https://127.0.0.1:9445/', city: 'Chicago' as const, capability: 'evening-plan' as const };
const request = { ...common, kind: 'request' as const, caller: key(caller), interactionId: digest,
  profileBasis: { profileDigest: digest, cardDigest: digest }, createdAt: '2026-09-27T12:00:00Z',
  deadline: '2026-09-27T12:05:00Z', input: makeInteractionFixture().request.input };
const acceptance = { ...common, kind: 'acceptance' as const, requestDigest: digest,
  acceptanceId: digest, acceptedAt: '2026-09-27T12:01:00Z', deadline: request.deadline };
const completion = { ...common, kind: 'completion' as const, acceptanceDigest: digest,
  recordedAt: '2026-09-27T12:02:00Z', outcome: 'completed' as const, answerDigest: digest };
const feedback = { ...common, kind: 'feedback' as const, reviewer: key(caller), interactionId: digest,
  requestDigest: digest, acceptanceDigest: digest, publicationPolicy: 'city-origin-archive@0.1' as const,
  rubric: 'evening-plan-usefulness-v0.1' as const, value: 1, createdAt: '2026-09-27T12:03:00Z',
  result: { kind: 'completion' as const, completionDigest: digest } };
const retraction = { ...common, kind: 'retraction' as const, reviewer: key(caller), interactionId: digest,
  feedbackDocumentDigest: digest, createdAt: '2026-09-27T12:04:00Z' };
const snapshot = { ...common, kind: 'archive-snapshot' as const, reviewer: caller.address.toLowerCase(), snapshotId: 'initial:1',
  createdAt: '2026-09-27T12:05:00Z', historyScope: 'reviewer-declared-from-inception' as const, entries: [digest] };

async function codecs() {
  const modules = await Promise.all([
    import('../../src/origin/bytes.js').catch(() => null),
    import('../../src/origin/signatures.js').catch(() => null),
  ]);
  assert.ok(modules[0] && modules[1], 'strict origin codec and signature modules must exist');
  return { ...modules[0], ...modules[1] };
}

for (const [value, signer] of [[profile, controller], [request, caller], [acceptance, runtime],
  [completion, runtime], [feedback, caller], [retraction, caller], [snapshot, caller]] as const) {
  test(`origin ${value.kind} exact bytes, document identity, and purpose/domain binding`, async () => {
    const api = await codecs();
    const envelope = await api.signOriginStatement(value, signer, profile);
    assert.equal((await api.verifyOriginSignature(envelope, service.identityUrl, value.kind)).status, 'valid');
    const document = api.encodeOriginDocument(envelope);
    assert.deepEqual(document.statement.value, value);
    assert.equal(document.documentDigest, keccak256(document.bytes));
    assert.equal(document.statement.digest, keccak256(toBytes(JSON.stringify(value))));
    assert.notEqual(document.documentDigest, document.statement.digest);
    assert.throws(() => decodeEthereum(envelope));
    assert.equal((await api.verifyOriginSignature(envelope, `${service.identityUrl}/other`, value.kind)).status, 'invalid');
    const wrongKind = value.kind === 'request' ? 'profile' : 'request';
    assert.equal((await api.verifyOriginSignature(envelope, service.identityUrl, wrongKind)).status, 'invalid');
    const changed = { ...envelope, payloadBase64: Buffer.from(JSON.stringify({ ...value, service: { ...service,
      identityUrl: `${service.identityUrl}/changed` } })).toString('base64') };
    assert.equal((await api.verifyOriginSignature(changed, `${service.identityUrl}/changed`, value.kind)).status, 'invalid');
    const badSignature = { ...envelope, signature: `0x${'00'.repeat(65)}` };
    assert.equal((await api.verifyOriginSignature(badSignature, service.identityUrl, value.kind)).status, 'invalid');
    const highS = { ...envelope, signature: `${envelope.signature.slice(0, 66)}${'ff'.repeat(32)}1b` };
    assert.equal((await api.verifyOriginSignature(highS, service.identityUrl, value.kind)).status, 'invalid');
  });
}

test('origin schema refuses unsupported fields, noncanonical URLs, keys, times and cross-profile payloads', async () => {
  const api = await codecs();
  for (const identityUrl of ['http://127.0.0.1:9443/identity', 'https://user@127.0.0.1/identity',
    'https://127.0.0.1/identity?q=1', 'https://127.0.0.1/identity#x', 'https://LOCALHOST/identity',
    'https://127.0.0.1:443/identity', 'https://127.0.0.1/a/../identity', 'https://127.1/identity']) {
    assert.throws(() => api.encodeOriginStatement({ ...request, service: { ...service, identityUrl } }));
  }
  for (const value of [
    { ...profile, runtimeKey: profile.controllerKey }, { ...request, chainId: 1 },
    { ...request, caller: { method: 'eip155-eoa', chainId: 1, address: caller.address.toLowerCase() } },
    { ...request, createdAt: '2026-02-30T12:00:00Z' }, { ...request, deadline: request.createdAt },
    { ...feedback, value: 6 }, { ...feedback, result: { kind: 'no-result-observed', observedAt: '2026-09-28T00:00:00Z' } },
    { ...snapshot, snapshotId: 'bad space' }, { ...snapshot, entries: [digest, digest] },
    { ...snapshot, entries: [`0x${'00'.repeat(32)}`] },
    { ...snapshot, entries: Array.from({ length: 257 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`) },
    makeInteractionFixture().request,
  ]) assert.throws(() => api.encodeOriginStatement(value as typeof request));
  const envelope = await api.signOriginStatement(request, caller);
  assert.throws(() => api.decodeOriginEnvelope({ ...envelope, signer: { ...envelope.signer, chainId: 1 } }));
  assert.throws(() => api.decodeOriginEnvelope({ ...envelope, payloadBase64: `${envelope.payloadBase64}\n` }));
  await assert.rejects(api.signOriginStatement(profile, caller));
  await assert.rejects(api.signOriginStatement(request, runtime));
  await assert.rejects(api.signOriginStatement(feedback, controller));
  await assert.rejects(api.signOriginStatement(retraction, controller));
  await assert.rejects(api.signOriginStatement(snapshot, controller));
  await assert.rejects(api.signOriginStatement(acceptance, controller, profile));
  await assert.rejects(api.signOriginStatement(completion, runtime, { ...profile, service: { ...service, identityUrl: `${service.identityUrl}/else` } }));
});

test('origin signatures reject otherwise valid signatures with wrong EIP-712 purpose or domain fields', async () => {
  const api = await codecs();
  const envelope = await api.signOriginStatement(request, caller);
  const payloadDigest = keccak256(toBytes(JSON.stringify(request)));
  for (const [primaryType, domain] of [
    ['CityOriginFeedback', { name: 'NandaCityOrigin', version: '0.1', salt: keccak256(toBytes(service.identityUrl)) }],
    ['CityOriginRequest', { name: 'NandaCityOrigin', version: '0.1', salt: keccak256(toBytes(service.identityUrl)), chainId: 1 }],
    ['CityOriginRequest', { name: 'NandaCityInteraction', version: '0.1', salt: keccak256(toBytes(service.identityUrl)) }],
  ] as const) {
    const signature = await caller.signTypedData({ domain, primaryType,
      types: { [primaryType]: [{ name: 'payloadDigest', type: 'bytes32' }] }, message: { payloadDigest } });
    assert.equal((await api.verifyOriginSignature({ ...envelope, signature }, service.identityUrl, 'request')).status, 'invalid');
  }
});

test('origin codecs enforce compact UTF-8, bounded payloads, and public envelope limits', async () => {
  const api = await codecs();
  const bytes = (s: string) => new TextEncoder().encode(s);
  for (const value of [bytes(`${JSON.stringify(request)}\n`), bytes('{"kind":"request","kind":"request"}'),
    new Uint8Array([0xff]), bytes(JSON.stringify({ ...profile, revision: '\ud800' })), new Uint8Array(32769)]) {
    assert.throws(() => api.decodeOriginStatement(value));
  }
  const envelope = await api.signOriginStatement(feedback, caller);
  assert.throws(() => api.decodeOriginDocument(new Uint8Array(6145)));
  assert.throws(() => api.decodeOriginDocument(bytes(`${JSON.stringify(envelope)} `)));
  assert.throws(() => api.decodeOriginDocument(bytes(JSON.stringify({ ...envelope, extra: true }))));
  const largeSnapshot = { ...snapshot, entries: Array.from({ length: 256 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`) };
  const snapshotDocument = api.encodeOriginDocument(await api.signOriginStatement(largeSnapshot, caller));
  assert.ok(snapshotDocument.bytes.length > 6144 && snapshotDocument.bytes.length < 32768);
  assert.equal(api.decodeOriginDocument(snapshotDocument.bytes).statement.value.kind, 'archive-snapshot');
  assert.throws(() => api.decodeOriginDocument(new Uint8Array(32769)));
});

test('snapshot wire matches the released Index scalar reviewer contract without accepting structured alternatives', async () => {
  const api = await codecs();
  const envelope = await api.signOriginStatement(snapshot, caller);
  const payload = JSON.parse(Buffer.from(envelope.payloadBase64, 'base64').toString()) as Record<string, unknown>;
  assert.equal(payload.reviewer, '0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb');
  assert.deepEqual(envelope.signer, { method: 'secp256k1-key', address: payload.reviewer });
  assert.throws(() => api.encodeOriginStatement({ ...snapshot, reviewer: key(caller) } as never));
  assert.throws(() => api.encodeOriginStatement({ ...snapshot, reviewer: `0x${'00'.repeat(20)}` }));
  await assert.rejects(api.signOriginStatement(snapshot, controller));
});

test('otherwise valid compact profile and request payloads exercise the reachable byte guards', async () => {
  const api = await codecs();
  const { originProfileSchema, originRequestSchema } = await import('../../src/origin/schema.js');
  const sizedProfile = { ...profile, service: { ...service, identityUrl: `https://127.0.0.1/${'a'.repeat(1780)}` },
    cardURL: 'https://127.0.0.1/' };
  sizedProfile.cardURL += 'b'.repeat(4096 - Buffer.byteLength(JSON.stringify(sizedProfile)));
  assert.equal(Buffer.byteLength(JSON.stringify(sizedProfile)), 4096);
  originProfileSchema.parse(sizedProfile);
  const document = api.encodeOriginDocument(await api.signOriginStatement(sizedProfile, controller));
  assert.equal(document.bytes.length, 5778, '4096 payload bytes -> 5464 Base64 bytes + 314 strict envelope bytes');
  assert.deepEqual(api.decodeOriginDocument(document.bytes).statement.value, sizedProfile);
  const overProfile = { ...sizedProfile, cardURL: `${sizedProfile.cardURL}b` };
  originProfileSchema.parse(overProfile);
  assert.throws(() => api.decodeOriginStatement(new TextEncoder().encode(JSON.stringify(overProfile))), /kind size limit/);
  const sizedRequest = { ...request, input: { ...request.input, preferences: Array<string>(16).fill('') } };
  for (let i = 0; i < 16; i++) {
    while (sizedRequest.input.preferences[i]!.length < 256 && Buffer.byteLength(JSON.stringify(sizedRequest)) + 6 <= 16384) {
      sizedRequest.input.preferences[i] += '\0';
    }
  }
  const remaining = 16384 - Buffer.byteLength(JSON.stringify(sizedRequest));
  const available = sizedRequest.input.preferences.findIndex((p) => p.length + remaining + 1 <= 256);
  assert.ok(available >= 0); sizedRequest.input.preferences[available] += 'a'.repeat(remaining);
  originRequestSchema.parse(sizedRequest); assert.equal(Buffer.byteLength(JSON.stringify(sizedRequest)), 16384);
  assert.equal(api.encodeOriginStatement(sizedRequest).bytes.length, 16384);
  sizedRequest.input.preferences[available] += 'a'; originRequestSchema.parse(sizedRequest);
  assert.throws(() => api.decodeOriginStatement(new TextEncoder().encode(JSON.stringify(sizedRequest))), /kind size limit/);
});
