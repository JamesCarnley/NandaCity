import assert from 'node:assert/strict';
import test from 'node:test';

import { hashTypedData } from 'viem';

import { digestBytes } from '../../src/identity/profile.js';
import { encodeStatement } from '../../src/interaction/bytes.js';
import { signProviderStatement, signRequest } from '../../src/interaction/signatures.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { decodeFeedback, encodeFeedback } from '../../src/feedback/bytes.js';
import { decodeFeedbackEnvelope, signFeedback, verifyFeedbackSignature } from '../../src/feedback/signatures.js';
import { verifyHistoricalFeedback } from '../../src/feedback/verify.js';
import type { CityFeedback } from '../../src/feedback/schema.js';

const registry = { chainId: 11155111, address: '0x9999999999999999999999999999999999999999' } as const;
const literal = '{"kind":"feedback","version":"0.1","service":{"method":"erc8004","agent":{"chainId":31337,"registry":"0x1111111111111111111111111111111111111111","agentId":"7"}},"reviewer":{"method":"eip155-eoa","chainId":31337,"address":"0x2222222222222222222222222222222222222222"},"interactionId":"0xabababababababababababababababababababababababababababababababab","requestDigest":"0x3333333333333333333333333333333333333333333333333333333333333333","acceptanceDigest":"0x4444444444444444444444444444444444444444444444444444444444444444","reputationRegistry":{"chainId":31337,"address":"0x5555555555555555555555555555555555555555"},"rubric":"evening-plan-usefulness-v0.1","value":1,"createdAt":"2026-09-24T13:02:00Z","result":{"kind":"no-result-observed","observedAt":"2026-09-24T13:01:00Z"}}';

function feedbackFor(f: ReturnType<typeof makeInteractionFixture>): CityFeedback {
  const acceptance = { ...f.acceptance, requestDigest: encodeStatement(f.request).digest };
  return {
    kind: 'feedback', version: '0.1', service: f.request.service,
    reviewer: f.request.caller, interactionId: f.request.interactionId,
    requestDigest: encodeStatement(f.request).digest,
    acceptanceDigest: encodeStatement(acceptance).digest,
    reputationRegistry: registry, rubric: 'evening-plan-usefulness-v0.1', value: 1,
    createdAt: '2026-09-24T13:02:00Z',
    result: { kind: 'no-result-observed', observedAt: '2026-09-24T13:01:00Z' },
  };
}

async function chain() {
  const f = makeInteractionFixture();
  const request = await signRequest(f.request, f.caller);
  const acceptance = await signProviderStatement(
    { ...f.acceptance, requestDigest: encodeStatement(f.request).digest }, f.runtime, f.profile,
  );
  const feedback = await signFeedback(feedbackFor(f), f.caller);
  return { f, request, acceptance, feedback };
}

test('literal feedback bytes are preserved and committed exactly, with only bounded fixed fields', () => {
  const bytes = new TextEncoder().encode(literal);
  const decoded = decodeFeedback(bytes);
  assert.deepEqual(decoded.bytes, bytes);
  assert.equal(decoded.digest, digestBytes(bytes));
  assert.equal(decoded.value.result.kind, 'no-result-observed');
  assert.deepEqual(encodeFeedback(decoded.value).bytes, bytes);
});

test('codec rejects noncanonical, malformed, oversized and non-fixed feedback statements', () => {
  const raw = JSON.parse(literal) as Record<string, unknown>;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  assert.throws(() => decodeFeedback(new TextEncoder().encode(` ${literal}`)), /canonical|compact/i);
  assert.throws(() => decodeFeedback(new TextEncoder().encode(literal.replace('"kind":"feedback"', '"kind":"feedback","kind":"feedback"'))), /canonical|compact/i);
  assert.throws(() => decodeFeedback(Uint8Array.of(0xff)), /UTF-8/i);
  assert.throws(() => decodeFeedback(new Uint8Array(4097)), /4 KiB|size/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, rubric: 'general-quality-v1' })), /rubric|invalid/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, value: 0 })), /value|number/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, value: 5.5 })), /value|number/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, value: '5' })), /value|number/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, input: { preference: 'private' } })), /unknown|unrecognized/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, createdAt: '2026-02-30T13:02:00Z' })), /createdAt|UTC/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, reputationRegistry: { ...raw.reputationRegistry as object, chainId: 1 } })), /chainId|registry/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, result: { kind: 'completion', completionDigest: `0x${'aa'.repeat(32)}`, observedAt: '2026-09-24T13:01:00Z' } })), /result|unknown|unrecognized/i);
  assert.throws(() => decodeFeedback(bytes({ ...raw, result: { kind: 'no-result-observed' } })), /observedAt/i);
});

test('feedback signer is the named reviewer and EIP-712 purpose cannot be replayed as interaction', async () => {
  const f = makeInteractionFixture();
  const value = feedbackFor(f);
  const envelope = await signFeedback(value, f.caller);
  assert.deepEqual(decodeFeedbackEnvelope(envelope).feedback.value, value);
  assert.equal((await verifyFeedbackSignature(envelope, value.service.agent.chainId)).status, 'valid');
  await assert.rejects(signFeedback(value, f.stranger), /reviewer/i);
  const wrongPurpose = await f.caller.signTypedData({
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId: value.service.agent.chainId },
    primaryType: 'CityFeedback',
    types: { CityFeedback: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: encodeFeedback(value).digest },
  });
  assert.equal((await verifyFeedbackSignature({ ...envelope, signature: wrongPurpose }, value.service.agent.chainId)).status, 'invalid');
  assert.equal((await verifyFeedbackSignature(envelope, 1)).status, 'invalid');
  const changed = { ...value, value: 5 };
  assert.equal((await verifyFeedbackSignature({ ...envelope, payloadBase64: Buffer.from(encodeFeedback(changed).bytes).toString('base64') }, value.service.agent.chainId)).status, 'invalid');
  assert.equal(hashTypedData({
    domain: { name: 'NandaCityFeedback', version: '0.1', chainId: value.service.agent.chainId },
    primaryType: 'CityFeedback',
    types: { CityFeedback: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: encodeFeedback(value).digest },
  }).length, 66);
});

test('historical evaluator retains valid expired feedback without current owner or liveness input', async () => {
  const c = await chain();
  const finding = await verifyHistoricalFeedback({ ...c, basisProfile: c.f.profile, expectedReputationRegistry: registry });
  assert.equal(finding.feedbackSignature, 'valid');
  assert.equal(finding.requestSignature, 'valid');
  assert.equal(finding.acceptanceSignature, 'valid');
  assert.equal(finding.reviewerBinding, 'matched');
  assert.equal(finding.serviceLink, 'matched');
  assert.equal(finding.registryDomain, 'matched');
  assert.equal(finding.requestLink, 'matched');
  assert.equal(finding.acceptanceLink, 'matched');
  assert.equal(finding.originalProfileBasis, 'matched');
  assert.equal(finding.acceptanceSignerBinding, 'matched');
  assert.equal(finding.claimedTime, 'consistent');
  assert.equal(finding.resultEvidence, 'post-deadline-reviewer-claim');
  assert.equal(finding.historicalExistence, 'unknown');
  assert.equal(finding.publication, 'not-evaluated');
});

test('historical evaluator separates signature, reviewer, service, registry and digest/link failures', async () => {
  const c = await chain();
  const value = feedbackFor(c.f);
  const examine = async (change: Partial<CityFeedback>) => verifyHistoricalFeedback({
    ...c, feedback: await signFeedback({ ...value, ...change }, c.f.caller),
    basisProfile: c.f.profile, expectedReputationRegistry: registry,
  });
  assert.equal((await verifyHistoricalFeedback({ ...c, feedback: { ...c.feedback, signature: `0x${'00'.repeat(65)}` }, basisProfile: c.f.profile, expectedReputationRegistry: registry })).feedbackSignature, 'invalid');
  const strangerFeedback = await signFeedback({ ...value, reviewer: { ...value.reviewer, address: c.f.stranger.address.toLowerCase() as `0x${string}` } }, c.f.stranger);
  assert.equal((await verifyHistoricalFeedback({ ...c, feedback: strangerFeedback, basisProfile: c.f.profile, expectedReputationRegistry: registry })).reviewerBinding, 'mismatched');
  assert.equal((await examine({ service: { ...value.service, agent: { ...value.service.agent, agentId: '8' } } })).serviceLink, 'mismatched');
  assert.equal((await examine({ reputationRegistry: { ...registry, address: '0x8888888888888888888888888888888888888888' } })).registryDomain, 'mismatched');
  assert.equal((await examine({ interactionId: `0x${'ee'.repeat(32)}` })).requestLink, 'mismatched');
  assert.equal((await examine({ requestDigest: `0x${'ee'.repeat(32)}` })).requestLink, 'mismatched');
  assert.equal((await examine({ acceptanceDigest: `0x${'ee'.repeat(32)}` })).acceptanceLink, 'mismatched');
  assert.equal((await verifyHistoricalFeedback({ ...c, acceptance: undefined, basisProfile: c.f.profile, expectedReputationRegistry: registry })).acceptanceLink, 'missing');
  assert.equal((await verifyHistoricalFeedback({ ...c, basisProfile: { ...c.f.profile, source: { ...c.f.profile.source, blockHash: `0x${'ee'.repeat(32)}` } }, expectedReputationRegistry: registry })).originalProfileBasis, 'mismatched');
});

test('acceptance signer binding is only to request-declared bytes, not independent original authority', async () => {
  const c = await chain();
  const absent = await verifyHistoricalFeedback({ ...c, basisProfile: null, expectedReputationRegistry: registry });
  assert.equal(absent.originalProfileBasis, 'unavailable');
  assert.equal(absent.acceptanceSignerBinding, 'matched');
  assert.equal('originalRuntimeSigner' in absent, false);
  const wrongBasis = { ...c.f.profile, source: { ...c.f.profile.source, blockHash: `0x${'ee'.repeat(32)}` as `0x${string}` } };
  const mismatched = await verifyHistoricalFeedback({ ...c, basisProfile: wrongBasis, expectedReputationRegistry: registry });
  assert.equal(mismatched.originalProfileBasis, 'mismatched');
  assert.equal(mismatched.acceptanceSignerBinding, 'matched');
});

test('a cited completion must be supplied, signed and linked; no-result is only a reviewer claim', async () => {
  const c = await chain();
  const acceptanceValue = { ...c.f.acceptance, requestDigest: encodeStatement(c.f.request).digest };
  const completionValue = { ...c.f.completion, acceptanceDigest: encodeStatement(acceptanceValue).digest };
  const completion = await signProviderStatement(completionValue, c.f.runtime, c.f.profile);
  const value = { ...feedbackFor(c.f), createdAt: '2026-09-24T12:20:00Z',
    result: { kind: 'completion' as const, completionDigest: encodeStatement(completionValue).digest } };
  const feedback = await signFeedback(value, c.f.caller);
  const missing = await verifyHistoricalFeedback({ ...c, feedback, basisProfile: c.f.profile, expectedReputationRegistry: registry });
  assert.equal(missing.resultEvidence, 'unavailable');
  const linked = await verifyHistoricalFeedback({ ...c, feedback, completion, basisProfile: c.f.profile, expectedReputationRegistry: registry });
  assert.equal(linked.resultEvidence, 'matched');
  assert.equal(linked.completionSignature, 'valid');
  assert.equal(linked.claimedTime, 'consistent');
  const wrong = await signProviderStatement({ ...completionValue, acceptanceDigest: `0x${'cc'.repeat(32)}` }, c.f.runtime, c.f.profile);
  assert.equal((await verifyHistoricalFeedback({ ...c, feedback, completion: wrong, basisProfile: c.f.profile, expectedReputationRegistry: registry })).resultEvidence, 'mismatched');
  assert.equal((await verifyHistoricalFeedback({ ...c, feedback: await signFeedback({ ...value, createdAt: '2026-09-24T12:05:00Z' }, c.f.caller), completion, basisProfile: c.f.profile, expectedReputationRegistry: registry })).claimedTime, 'inconsistent');
  assert.equal((await verifyHistoricalFeedback({ ...c, feedback: await signFeedback({ ...feedbackFor(c.f), result: { kind: 'no-result-observed', observedAt: '2026-09-24T12:59:59Z' } }, c.f.caller), basisProfile: c.f.profile, expectedReputationRegistry: registry })).resultEvidence, 'too-early-claim');
});

test('a post-deadline no-result claim needs a valid linked acceptance, never just a timestamp', async () => {
  const c = await chain();
  const base = { ...c, basisProfile: c.f.profile, expectedReputationRegistry: registry };
  assert.equal((await verifyHistoricalFeedback({ ...base, acceptance: undefined })).resultEvidence, 'unavailable');
  const badSignature = { ...c.acceptance, signature: `0x${'00'.repeat(65)}` };
  assert.equal((await verifyHistoricalFeedback({ ...base, acceptance: badSignature })).resultEvidence, 'mismatched');
  const wrongAcceptance = await signProviderStatement({ ...c.f.acceptance, requestDigest: `0x${'ee'.repeat(32)}` }, c.f.runtime, c.f.profile);
  assert.equal((await verifyHistoricalFeedback({ ...base, acceptance: wrongAcceptance })).resultEvidence, 'mismatched');
  const badRequest = { ...c.request, signature: `0x${'00'.repeat(65)}` };
  assert.equal((await verifyHistoricalFeedback({ ...base, request: badRequest })).resultEvidence, 'mismatched');
});

test('supplied completions retain separate signature, content link, signer and outcome findings even for no-result feedback', async () => {
  const c = await chain();
  const acceptanceValue = { ...c.f.acceptance, requestDigest: encodeStatement(c.f.request).digest };
  const completionValue = { ...c.f.completion, acceptanceDigest: encodeStatement(acceptanceValue).digest };
  const completion = await signProviderStatement(completionValue, c.f.runtime, c.f.profile);
  const base = { ...c, basisProfile: c.f.profile, expectedReputationRegistry: registry };
  const valid = await verifyHistoricalFeedback({ ...base, completion });
  assert.equal(valid.completionSignature, 'valid');
  assert.equal(valid.completionLink, 'matched');
  assert.equal(valid.completionSignerBinding, 'matched');
  assert.equal(valid.completionClaimedOutcome, 'completed');
  assert.equal(valid.resultEvidence, 'post-deadline-reviewer-claim');

  const strangerSignature = await c.f.stranger.signTypedData({
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId: c.f.request.service.agent.chainId },
    primaryType: 'CityCompletion',
    types: { CityCompletion: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: encodeStatement(completionValue).digest },
  });
  const strangerCompletion = {
    ...completion,
    signer: { ...completion.signer, address: c.f.stranger.address.toLowerCase() },
    signature: strangerSignature,
  };
  const stranger = await verifyHistoricalFeedback({ ...base, completion: strangerCompletion });
  assert.equal(stranger.completionSignature, 'valid');
  assert.equal(stranger.completionLink, 'matched');
  assert.equal(stranger.completionSignerBinding, 'mismatched');
  assert.equal(stranger.completionClaimedOutcome, 'completed');
  assert.equal(stranger.resultEvidence, 'post-deadline-reviewer-claim');

  const wrong = await signProviderStatement({ ...completionValue, acceptanceDigest: `0x${'ff'.repeat(32)}` }, c.f.runtime, c.f.profile);
  const wrongFinding = await verifyHistoricalFeedback({ ...base, completion: wrong });
  assert.equal(wrongFinding.completionSignature, 'valid');
  assert.equal(wrongFinding.completionLink, 'mismatched');
  assert.equal(wrongFinding.completionSignerBinding, 'matched');
  assert.equal(wrongFinding.completionClaimedOutcome, 'completed');
  assert.equal(wrongFinding.resultEvidence, 'post-deadline-reviewer-claim');
});
