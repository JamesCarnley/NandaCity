import assert from 'node:assert/strict';
import test from 'node:test';

import { hashTypedData } from 'viem';

import { encodeStatement } from '../../src/interaction/bytes.js';
import {
  decodeEnvelope,
  signProviderStatement,
  signRequest,
  verifyEnvelopeSignature,
} from '../../src/interaction/signatures.js';
import { makeInteractionFixture } from './fixtures.js';

const literalRequest = '{"kind":"request","version":"0.1","service":{"method":"erc8004","agent":{"chainId":31337,"registry":"0x1111111111111111111111111111111111111111","agentId":"1"}},"caller":{"method":"eip155-eoa","chainId":31337,"address":"0x9611f5c759d4f949ba60ab22c41ec3db8a534b56"},"interactionId":"0x2222222222222222222222222222222222222222222222222222222222222222","profileBasis":{"blockNumber":"10","blockHash":"0x3333333333333333333333333333333333333333333333333333333333333333","agentOwner":"0x4444444444444444444444444444444444444444","agentUriDigest":"0x5555555555555555555555555555555555555555555555555555555555555555","registrationDigest":"0x6666666666666666666666666666666666666666666666666666666666666666","cardDigest":"0x7777777777777777777777777777777777777777777777777777777777777777","receiptSigner":"0x8888888888888888888888888888888888888888"},"createdAt":"2026-09-24T22:00:00Z","deadline":"2026-09-24T22:05:00Z","input":{"version":"0.1","capability":"evening-plan","city":"Chicago","timeWindow":{"start":"2026-09-24T18:00:00-05:00","end":"2026-09-24T22:00:00-05:00","timeZone":"America/Chicago"},"area":"Loop","budget":{"currency":"USD","minorUnits":"5000"},"transport":["walk","public-transit"],"preferences":["quiet dinner"]}}';
const literalSignature = '0x3edfc792a3af5b37c52bfb6e45b875014619144556b29847e0f2f8b8833f2cdf3420b91ba87230e5727655bc133a8f5e3024bb925100d2827603e892d6797e441c';

test('request signer proves key control and envelope retains exact payload bytes', async () => {
  const f = makeInteractionFixture();
  const envelope = await signRequest(f.request, f.caller);
  const decoded = decodeEnvelope(envelope);
  assert.deepEqual(decoded.statement.value, f.request);
  assert.deepEqual(decoded.statement.bytes, encodeStatement(f.request).bytes);
  assert.equal(decoded.envelope.signer.address, f.caller.address.toLowerCase());
  assert.equal((await verifyEnvelopeSignature(envelope, f.request.service.agent.chainId)).status, 'valid');
});

test('provider runtime can sign acceptance and completion but an unrelated or owner key cannot', async () => {
  const f = makeInteractionFixture();
  const acceptance = await signProviderStatement(f.acceptance, f.runtime, f.profile);
  const completion = await signProviderStatement(f.completion, f.runtime, f.profile);
  assert.equal((await verifyEnvelopeSignature(acceptance, f.profile.agent.chainId)).status, 'valid');
  assert.equal((await verifyEnvelopeSignature(completion, f.profile.agent.chainId)).status, 'valid');
  await assert.rejects(signProviderStatement(f.acceptance, f.stranger, f.profile), /receiptSigner|runtime/i);
  await assert.rejects(signProviderStatement(f.request as unknown as typeof f.acceptance, f.runtime, f.profile), /acceptance|completion/i);
  await assert.rejects(signRequest(f.request, f.stranger), /caller/i);
});

test('tampered payload or claimed signer does not verify, and unknown signature scheme is unsupported', async () => {
  const f = makeInteractionFixture();
  const envelope = await signRequest(f.request, f.caller);
  const altered = { ...f.request, input: { ...f.request.input, area: 'Different neighborhood' } };
  const payloadBase64 = Buffer.from(encodeStatement(altered).bytes).toString('base64');
  assert.equal((await verifyEnvelopeSignature({ ...envelope, payloadBase64 }, f.request.service.agent.chainId)).status, 'invalid');
  assert.equal((await verifyEnvelopeSignature({ ...envelope, signer: { ...envelope.signer, address: f.stranger.address.toLowerCase() } }, f.request.service.agent.chainId)).status, 'invalid');
  assert.equal((await verifyEnvelopeSignature({ ...envelope, scheme: 'future-scheme' }, f.request.service.agent.chainId)).status, 'unsupported');
});

test('wrong typed purpose or chain domain cannot be repurposed as a City request', async () => {
  const f = makeInteractionFixture();
  const envelope = await signRequest(f.request, f.caller);
  const wrongChain = await verifyEnvelopeSignature(envelope, 1);
  assert.equal(wrongChain.status, 'invalid');
  const wrongPurpose = await f.caller.signTypedData({
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId: 11155111 },
    primaryType: 'CityAcceptance',
    types: { CityAcceptance: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: encodeStatement(f.request).digest },
  });
  assert.equal((await verifyEnvelopeSignature({ ...envelope, signature: wrongPurpose }, 11155111)).status, 'invalid');
});

test('typed commitment uses the specified domain and one bytes32 payloadDigest field', () => {
  const f = makeInteractionFixture();
  const digest = encodeStatement(f.request).digest;
  const typedDigest = hashTypedData({
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId: 11155111 },
    primaryType: 'CityRequest',
    types: { CityRequest: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: digest },
  });
  assert.match(typedDigest, /^0x[0-9a-f]{64}$/);
});

test('literal byte and EIP-712 vector independently fixes the wire contract', async () => {
  const payloadBase64 = Buffer.from(literalRequest, 'utf8').toString('base64');
  const envelope = {
    version: '0.1', scheme: 'eip712-eoa',
    signer: { method: 'eip155-eoa', chainId: 31337, address: '0x9611f5c759d4f949ba60ab22c41ec3db8a534b56' },
    payloadBase64, signature: literalSignature,
  };
  assert.equal(decodeEnvelope(envelope).statement.digest, '0xbfb1f2255aaf57c36a3fd72ea930a30aa5485d03ffa354003fa511bf09ad9caa');
  assert.equal(hashTypedData({
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId: 31337 },
    primaryType: 'CityRequest',
    types: { CityRequest: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: '0xbfb1f2255aaf57c36a3fd72ea930a30aa5485d03ffa354003fa511bf09ad9caa' },
  }), '0xe7d358657e374a58f35f0d2255345fc9921e33a695aec0c3ea4ab34364d022de');
  assert.equal((await verifyEnvelopeSignature(envelope, 31337)).status, 'valid');
});

test('rejects ECDSA high-s malleation and wrong recovery byte even if recovery could succeed', async () => {
  const f = makeInteractionFixture();
  const envelope = await signRequest(f.request, f.caller);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = (order - BigInt(`0x${envelope.signature.slice(66, 130)}`)).toString(16).padStart(64, '0');
  const flippedV = envelope.signature.endsWith('1b') ? '1c' : '1b';
  const malleated = `0x${envelope.signature.slice(2, 66)}${highS}${flippedV}`;
  assert.equal((await verifyEnvelopeSignature({ ...envelope, signature: malleated }, f.request.service.agent.chainId)).status, 'invalid');
  assert.equal((await verifyEnvelopeSignature({ ...envelope, signature: `${envelope.signature.slice(0, 130)}00` }, f.request.service.agent.chainId)).status, 'invalid');
});

test('rejects a noncanonical Base64 envelope before signature verification', async () => {
  const f = makeInteractionFixture();
  const envelope = await signRequest(f.request, f.caller);
  assert.throws(() => decodeEnvelope({ ...envelope, payloadBase64: `${envelope.payloadBase64}\n` }), /canonical|Base64/i);
});
