import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { makeInteractionFixture } from '../interaction/fixtures.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = makeInteractionFixture();
// Complete synthetic statements. The codec checks structure, not these dummy signatures.
const envelope = (value: unknown) => ({ version: '0.1', scheme: 'eip712-eoa',
  signer: { method: 'eip155-eoa', chainId: 11155111, address: '0x2222222222222222222222222222222222222222' },
  payloadBase64: Buffer.from(JSON.stringify(value)).toString('base64'), signature: `0x${'11'.repeat(65)}` });
const value = () => ({ version: '0.1', request: envelope(fixture.request),
  acceptance: envelope(fixture.acceptance), completion: envelope(fixture.completion), cardBase64: 'AP+A' });
const codec = async () => {
  const module = await import('../../src/feedback/supportingBundle.js').catch(() => undefined);
  assert.ok(module, 'private supporting-bundle codec must be implemented');
  return module;
};

test('commitment hashes validated exact bundle bytes including signatures and freezes caller bytes', async () => {
  const module = await codec();
  assert.equal(typeof module.commitSupportingBundle, 'function');
  const input = bytes(JSON.stringify(value()));
  const committed = module.commitSupportingBundle(input);
  assert.equal(committed.digest, keccak256(input));
  input.fill(0);
  assert.equal(committed.digest, keccak256(committed.bytes));
  const changed = value(); changed.request.signature = `0x${'22'.repeat(65)}`;
  assert.notEqual(module.commitSupportingBundle(bytes(JSON.stringify(changed))).digest, committed.digest);
  const missing = value(); delete (missing.request as Record<string, unknown>).signature;
  assert.throws(() => module.commitSupportingBundle(bytes(JSON.stringify(missing))), { code: 'bundle-malformed' });
});

test('bundle preserves copied outer, statement, signature and opaque card bytes without requiring completion', async () => {
  const { decodeSupportingBundle: decode, encodeSupportingBundle: encode } = await codec();
  const original = value();
  const input = bytes(JSON.stringify(original));
  const decoded = decode(input);
  assert.deepEqual(decoded.bytes, input);
  assert.deepEqual(decoded.cardBytes, Uint8Array.of(0, 255, 128));
  assert.equal(decoded.request.envelope.signature, `0x${'11'.repeat(65)}`);
  assert.deepEqual(decoded.request.statement.bytes, bytes(JSON.stringify(fixture.request)));
  assert.equal(decoded.acceptance.statement.value.kind, 'acceptance');
  assert.equal(decoded.completion?.statement.value.kind, 'completion');
  assert.deepEqual(encode(original).bytes, input);
  input.fill(0);
  original.request.signer.address = '0x3333333333333333333333333333333333333333';
  assert.equal(decoded.request.envelope.signer.address, '0x2222222222222222222222222222222222222222');
  assert.deepEqual(decoded.bytes, bytes(JSON.stringify(value())));
  const { completion: _, ...without } = value();
  assert.equal(encode(without).completion, undefined);
  const first = encode(without);
  first.cardBytes.fill(0);
  first.request.statement.bytes.fill(0);
  assert.deepEqual(decode(first.bytes).cardBytes, Uint8Array.of(0, 255, 128));
  assert.deepEqual(decode(first.bytes).request.statement.bytes, bytes(JSON.stringify(fixture.request)));
});

test('bundle distinguishes incomplete top-level fields from malformed shape and wrong statement kinds', async () => {
  const { encodeSupportingBundle: encode } = await codec();
  for (const key of ['version', 'request', 'acceptance', 'cardBase64']) {
    const raw: Record<string, unknown> = value(); delete raw[key];
    assert.throws(() => encode(raw), { code: 'bundle-incomplete' });
  }
  for (const raw of [null, [], { ...value(), version: '0.2' }, { ...value(), request: null },
    { ...value(), request: value().acceptance }, { ...value(), acceptance: value().request },
    { ...value(), completion: value().acceptance }, { ...value(), completion: undefined },
    { ...value(), cardBase64: 3 }]) assert.throws(() => encode(raw), { code: 'bundle-malformed' });
  for (const extra of ['answer', 'task', 'snapshot', 'url', 'keys', 'document', 'index']) {
    assert.throws(() => encode({ ...value(), [extra]: undefined }), { code: 'bundle-malformed' });
  }
  assert.throws(() => encode({ ...value(), request: { ...value().request, extra: undefined } }), { code: 'bundle-malformed' });
});

test('bundle rejects non-exact JSON, duplicate keys, malformed Unicode/UTF-8 and BOM', async () => {
  const { decodeSupportingBundle: decode, encodeSupportingBundle: encode } = await codec();
  const literal = JSON.stringify(value());
  for (const text of [` ${literal}`, `${literal}\n`, `\ufeff${literal}`,
    literal.replace('"version":"0.1"', '"version":"0.1","version":"0.1"'),
    literal.replace('"chainId":11155111', '"chainId":1.1155111e7'),
    literal.replace('eip712-eoa', 'eip712-\\u0065oa'),
    literal.replace('eip712-eoa', '\\ud800')]) {
    assert.throws(() => decode(bytes(text)), { code: 'bundle-malformed' });
  }
  assert.throws(() => decode(Uint8Array.of(0xff)), { code: 'bundle-malformed' });
  assert.throws(() => encode({ ...value(), '\ud800': 'x' }), { code: 'bundle-malformed' });
  assert.throws(() => encode({ ...value(), request: { ...value().request, scheme: '\ud800' } }), { code: 'bundle-malformed' });
});

test('bundle rejects excessive depth before recursive validation or stringification including inner payloads', async () => {
  const { decodeSupportingBundle: decode, encodeSupportingBundle: encode } = await codec();
  const deepText = '['.repeat(10_000) + '0' + ']'.repeat(10_000);
  assert.throws(() => decode(bytes(deepText)), { code: 'bundle-malformed', diagnostic: 'bundle-depth-exceeded' });
  assert.throws(() => encode(JSON.parse(deepText)), { code: 'bundle-malformed', diagnostic: 'bundle-depth-exceeded' });
  const deepPayload = '['.repeat(7_000) + '0' + ']'.repeat(7_000);
  assert.throws(() => encode({ ...value(), request: { ...value().request,
    payloadBase64: Buffer.from(deepPayload).toString('base64') } }), { code: 'bundle-malformed', diagnostic: 'bundle-depth-exceeded' });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => encode(cycle), { code: 'bundle-malformed' });
});

test('bundle enforces canonical padded Base64 and card, statement and outer byte bounds', async () => {
  const { decodeSupportingBundle: decode, encodeSupportingBundle: encode } = await codec();
  for (const cardBase64 of ['AA', 'AB==', 'AA==\n', 'AA-=', '=AAA']) {
    assert.throws(() => encode({ ...value(), cardBase64 }), { code: 'bundle-malformed' });
  }
  assert.equal(encode({ ...value(), cardBase64: Buffer.alloc(64 * 1024).toString('base64') }).cardBytes.length, 64 * 1024);
  assert.throws(() => encode({ ...value(), cardBase64: Buffer.alloc(64 * 1024 + 1).toString('base64') }), { code: 'bundle-malformed' });
  assert.throws(() => encode({ ...value(), request: { ...value().request, payloadBase64: Buffer.alloc(16 * 1024 + 1).toString('base64') } }), { code: 'bundle-malformed' });
  assert.throws(() => encode({ ...value(), acceptance: envelope({ ...fixture.acceptance, extra: 'x'.repeat(4096) }) }), { code: 'bundle-malformed' });
  assert.throws(() => decode(new Uint8Array(128 * 1024 + 1)), { code: 'bundle-malformed', diagnostic: 'bundle-size-exceeded' });
  assert.throws(() => encode({ ...value(), request: { ...value().request, scheme: 'x'.repeat(128 * 1024) } }), { code: 'bundle-malformed', diagnostic: 'bundle-size-exceeded' });
});
