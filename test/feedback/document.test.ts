import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';

const payload = '{"kind":"feedback","version":"0.1","service":{"method":"erc8004","agent":{"chainId":31337,"registry":"0x1111111111111111111111111111111111111111","agentId":"7"}},"reviewer":{"method":"eip155-eoa","chainId":31337,"address":"0x2222222222222222222222222222222222222222"},"interactionId":"0xabababababababababababababababababababababababababababababababab","requestDigest":"0x3333333333333333333333333333333333333333333333333333333333333333","acceptanceDigest":"0x4444444444444444444444444444444444444444444444444444444444444444","reputationRegistry":{"chainId":31337,"address":"0x5555555555555555555555555555555555555555"},"rubric":"evening-plan-usefulness-v0.1","value":1,"createdAt":"2026-09-24T13:02:00Z","result":{"kind":"no-result-observed","observedAt":"2026-09-24T13:01:00Z"}}';
const literal = `{"version":"0.1","scheme":"eip712-eoa","signer":{"method":"eip155-eoa","chainId":31337,"address":"0x2222222222222222222222222222222222222222"},"payloadBase64":"${Buffer.from(payload).toString('base64')}","signature":"0x${'11'.repeat(65)}"}`;
const bytes = (text: string) => new TextEncoder().encode(text);
const codec = async () => {
  const module = await import('../../src/feedback/document.js').catch(() => undefined);
  assert.ok(module, 'exact feedback document codec must be implemented');
  return module;
};

test('literal document preserves exact bytes and hashes the envelope separately from its payload', async () => {
  const { decodeFeedbackDocument, encodeFeedbackDocument } = await codec();
  const input = bytes(literal);
  const decoded = decodeFeedbackDocument(input);
  assert.deepEqual(decoded.bytes, input);
  assert.equal(decoded.documentHash, keccak256(input));
  assert.equal(decoded.feedback.digest, keccak256(bytes(payload)));
  assert.notEqual(decoded.documentHash, decoded.feedback.digest);
  assert.deepEqual(encodeFeedbackDocument(JSON.parse(literal)).bytes, input);
  const changed = decodeFeedbackDocument(bytes(literal.replace('11'.repeat(65), '22'.repeat(65))));
  assert.notEqual(changed.documentHash, decoded.documentHash);
  assert.equal(changed.feedback.digest, decoded.feedback.digest);
  input.fill(0);
  assert.deepEqual(decoded.bytes, bytes(literal), 'caller mutation cannot change decoded original bytes');
});

test('document rejects duplicate keys, whitespace, BOM, malformed Unicode and non-exact JSON spellings', async () => {
  const { decodeFeedbackDocument } = await codec();
  for (const invalid of [
    ` ${literal}`, `${literal}\n`, `\ufeff${literal}`,
    literal.replace('"version":"0.1"', '"version":"0.1","version":"0.1"'),
    literal.replace('"chainId":31337', '"chainId":3.1337e4'),
    literal.replace('eip712-eoa', 'eip712-\\u0065oa'),
    literal.replace('eip712-eoa', '\\ud800'),
  ]) assert.throws(() => decodeFeedbackDocument(bytes(invalid)), /compact|JSON|Unicode/i);
  assert.throws(() => decodeFeedbackDocument(Uint8Array.of(0xff)), /UTF-8/i);
});

test('document enforces 6 KiB and strict envelope and inner payload schemas without stripping fields', async () => {
  const { decodeFeedbackDocument, encodeFeedbackDocument } = await codec();
  assert.throws(() => decodeFeedbackDocument(new Uint8Array(6145)), /6 KiB|size/i);
  const envelope = JSON.parse(literal);
  assert.throws(() => encodeFeedbackDocument({ ...envelope, extra: true }), /unrecognized/i);
  assert.throws(() => encodeFeedbackDocument({ ...envelope, signer: { ...envelope.signer, extra: true } }), /unrecognized/i);
  assert.throws(() => encodeFeedbackDocument({ ...envelope, scheme: '\ud800' }), /Unicode/i);
  assert.throws(() => encodeFeedbackDocument({ ...envelope, payloadBase64: Buffer.from(payload.replace('"value":1', '"value":0')).toString('base64') }), /value/i);
  const atLimit = { ...envelope, scheme: 'x'.repeat(6144 - Buffer.byteLength(literal) + envelope.scheme.length) };
  assert.equal(encodeFeedbackDocument(atLimit).bytes.length, 6144);
  assert.throws(() => encodeFeedbackDocument({ ...atLimit, scheme: `${atLimit.scheme}x` }), /6 KiB|size/i);
});
