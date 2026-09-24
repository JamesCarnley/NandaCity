import assert from 'node:assert/strict';
import test from 'node:test';

import { digestBytes } from '../../src/identity/profile.js';
import { encodeStatement, idempotencyKey, requestsMatchForRetry } from '../../src/interaction/bytes.js';
import { signProviderStatement, signRequest } from '../../src/interaction/signatures.js';
import { verifyInteraction } from '../../src/interaction/verify.js';
import { makeInteractionFixture } from './fixtures.js';

async function signedChain() {
  const f = makeInteractionFixture();
  const request = await signRequest(f.request, f.caller);
  const acceptanceValue = { ...f.acceptance, requestDigest: encodeStatement(f.request).digest };
  const acceptance = await signProviderStatement(acceptanceValue, f.runtime, f.profile);
  const answerBytes = new TextEncoder().encode('{"venue":"Synthetic Chicago fixture"}');
  const completionValue = { ...f.completion, acceptanceDigest: encodeStatement(acceptanceValue).digest, answerDigest: digestBytes(answerBytes) };
  const completion = await signProviderStatement(completionValue, f.runtime, f.profile);
  const context = {
    basisProfile: f.profile,
    currentProfile: f.profile,
    continuity: 'unchanged' as const,
    observedAt: '2026-09-24T12:30:00Z',
  };
  return { f, request, acceptance, completion, answerBytes, context };
}

test('verifies linked caller request, runtime acceptance and terminal completion without historical timing claim', async () => {
  const chain = await signedChain();
  const report = await verifyInteraction({ ...chain.context, request: chain.request, acceptance: chain.acceptance, completion: chain.completion, answerBytes: chain.answerBytes });
  assert.equal(report.request.cryptography, 'valid');
  assert.equal(report.request.signerBinding, 'matched');
  assert.equal(report.request.profileBasis, 'matched');
  assert.equal(report.request.currentAuthority, 'authorized');
  assert.equal(report.request.historicalExistence, 'unknown');
  assert.equal(report.acceptance?.link, 'matched');
  assert.equal(report.completion?.link, 'matched');
  assert.equal(report.completion?.answerBinding, 'matched');
  assert.equal(report.allPresentedEvidenceUsableAtObservation, true);
});

test('a valid stranger signature is not caller or provider authorization', async () => {
  const chain = await signedChain();
  const stolen = { ...chain.request, signer: { ...chain.request.signer, address: chain.f.stranger.address.toLowerCase() } };
  const report = await verifyInteraction({ ...chain.context, request: stolen });
  assert.equal(report.request.signerBinding, 'mismatched');
  assert.equal(report.allPresentedEvidenceUsableAtObservation, false);
});

test('rejects a correctly signed acceptance for the wrong request digest or deadline', async () => {
  const chain = await signedChain();
  const wrongDigest = await signProviderStatement({ ...chain.f.acceptance, requestDigest: `0x${'ff'.repeat(32)}` }, chain.f.runtime, chain.f.profile);
  const wrongDeadline = await signProviderStatement({ ...chain.f.acceptance, requestDigest: encodeStatement(chain.f.request).digest, deadline: '2026-09-24T14:00:00Z' }, chain.f.runtime, chain.f.profile);
  for (const acceptance of [wrongDigest, wrongDeadline]) {
    const report = await verifyInteraction({ ...chain.context, request: chain.request, acceptance });
    assert.equal(report.acceptance?.cryptography, 'valid');
    assert.equal(report.acceptance?.link, 'mismatched');
    assert.equal(report.allPresentedEvidenceUsableAtObservation, false);
  }
});

test('rejects completion linked to a different acceptance, while failed after acceptance remains attributable', async () => {
  const chain = await signedChain();
  const wrong = await signProviderStatement({ ...chain.f.completion, acceptanceDigest: `0x${'ee'.repeat(32)}` }, chain.f.runtime, chain.f.profile);
  const wrongReport = await verifyInteraction({ ...chain.context, request: chain.request, acceptance: chain.acceptance, completion: wrong });
  assert.equal(wrongReport.completion?.link, 'mismatched');
  assert.equal(wrongReport.allPresentedEvidenceUsableAtObservation, false);
  const failure = await signProviderStatement({
    kind: 'completion', version: '0.1',
    acceptanceDigest: encodeStatement({ ...chain.f.acceptance, requestDigest: encodeStatement(chain.f.request).digest }).digest,
    recordedAt: '2026-09-24T12:10:00Z', outcome: 'failed', reason: 'dependency-unavailable',
  }, chain.f.runtime, chain.f.profile);
  const failedReport = await verifyInteraction({ ...chain.context, request: chain.request, acceptance: chain.acceptance, completion: failure });
  assert.equal(failedReport.completion?.link, 'matched');
  assert.equal(failedReport.completion?.terminalOutcome, 'failed');
  assert.equal(failedReport.completion?.answerBinding, 'not-applicable');
});

test('basis mismatch, missing current authority, interrupted or unknown continuity fail closed separately', async () => {
  const chain = await signedChain();
  const changedBasis = { ...chain.f.profile, source: { ...chain.f.profile.source, blockHash: `0x${'bb'.repeat(32)}` as `0x${string}` } };
  const mismatched = await verifyInteraction({ ...chain.context, basisProfile: changedBasis, request: chain.request });
  assert.equal(mismatched.request.profileBasis, 'mismatched');
  assert.equal(mismatched.allPresentedEvidenceUsableAtObservation, false);
  const unavailable = await verifyInteraction({ ...chain.context, currentProfile: null, request: chain.request });
  assert.equal(unavailable.request.currentAuthority, 'unavailable');
  assert.equal(unavailable.allPresentedEvidenceUsableAtObservation, false);
  const interrupted = await verifyInteraction({ ...chain.context, continuity: 'changed', request: chain.request });
  assert.equal(interrupted.request.continuity, 'changed');
  assert.equal(interrupted.allPresentedEvidenceUsableAtObservation, false);
  const unknown = await verifyInteraction({ ...chain.context, continuity: 'unknown', request: chain.request });
  assert.equal(unknown.request.continuity, 'unknown');
  assert.equal(unknown.allPresentedEvidenceUsableAtObservation, false);
});

test('deadline is evaluated against an injected observer clock, not signer-authored historical existence', async () => {
  const chain = await signedChain();
  const report = await verifyInteraction({ ...chain.context, observedAt: '2026-09-24T14:00:00Z', request: chain.request });
  assert.equal(report.request.deadline, 'expired');
  assert.equal(report.request.cryptography, 'valid');
  assert.equal(report.request.historicalExistence, 'unknown');
  assert.equal(report.allPresentedEvidenceUsableAtObservation, false);
});

test('completed evidence requires exact bounded answer bytes; absent or altered bytes are not a success', async () => {
  const chain = await signedChain();
  const base = { ...chain.context, request: chain.request, acceptance: chain.acceptance, completion: chain.completion };
  const missing = await verifyInteraction(base);
  assert.equal(missing.completion?.answerBinding, 'unavailable');
  assert.equal(missing.allPresentedEvidenceUsableAtObservation, false);
  const altered = await verifyInteraction({ ...base, answerBytes: new TextEncoder().encode('{"venue":"Altered"}') });
  assert.equal(altered.completion?.answerBinding, 'mismatched');
  assert.equal(altered.allPresentedEvidenceUsableAtObservation, false);
  const oversized = await verifyInteraction({ ...base, answerBytes: new Uint8Array(256 * 1024 + 1) });
  assert.equal(oversized.completion?.answerBinding, 'mismatched');
  assert.equal(oversized.allPresentedEvidenceUsableAtObservation, false);
});

test('same qualified idempotency key with changed bytes conflicts, while other callers remain distinct', () => {
  const f = makeInteractionFixture();
  const original = encodeStatement(f.request);
  assert.equal(requestsMatchForRetry(original, encodeStatement(f.request)), true);
  assert.throws(() => requestsMatchForRetry(original, encodeStatement({ ...f.request, input: { ...f.request.input, area: 'River North' } })), /idempotency conflict/i);
  const changedBytes = encodeStatement({ ...f.request, input: { ...f.request.input, area: 'River North' } });
  assert.throws(() => requestsMatchForRetry(original, { ...changedBytes, digest: original.digest }), /idempotency conflict/i);
  assert.notEqual(idempotencyKey(f.request), idempotencyKey({ ...f.request, caller: { ...f.request.caller, address: f.stranger.address.toLowerCase() as `0x${string}` } }));
});

test('a newly signed completion cannot ride through runtime rotation or reordered signer times', async () => {
  const chain = await signedChain();
  const changedCurrent = {
    ...chain.f.profile,
    registration: {
      ...chain.f.profile.registration,
      'x-nandacity': {
        ...chain.f.profile.registration['x-nandacity'],
        receiptSigner: chain.f.stranger.address.toLowerCase(),
      },
    },
  };
  const rotated = await verifyInteraction({ ...chain.context, request: chain.request, currentProfile: changedCurrent });
  assert.equal(rotated.request.currentAuthority, 'unauthorized');
  assert.equal(rotated.allPresentedEvidenceUsableAtObservation, false);

  const earlyCompletion = await signProviderStatement({
    ...chain.f.completion,
    acceptanceDigest: encodeStatement({ ...chain.f.acceptance, requestDigest: encodeStatement(chain.f.request).digest }).digest,
    recordedAt: '2026-09-24T12:00:30Z',
  }, chain.f.runtime, chain.f.profile);
  const reordered = await verifyInteraction({ ...chain.context, request: chain.request, acceptance: chain.acceptance, completion: earlyCompletion, answerBytes: chain.answerBytes });
  assert.equal(reordered.completion?.link, 'mismatched');
  assert.equal(reordered.allPresentedEvidenceUsableAtObservation, false);
});

test('current authority cannot be an older block or a conflicting block at the same height', async () => {
  const chain = await signedChain();
  const older = {
    ...chain.f.profile,
    source: { ...chain.f.profile.source, blockNumber: '9123455' },
  };
  const oldReport = await verifyInteraction({ ...chain.context, request: chain.request, currentProfile: older });
  assert.equal(oldReport.request.currentAuthority, 'unauthorized');

  const conflict = {
    ...chain.f.profile,
    source: { ...chain.f.profile.source, blockHash: `0x${'bb'.repeat(32)}` as `0x${string}` },
  };
  const conflictReport = await verifyInteraction({ ...chain.context, request: chain.request, currentProfile: conflict });
  assert.equal(conflictReport.request.currentAuthority, 'unauthorized');
});

test('observer clock must be a real explicit UTC instant, not a date-only or normalized invalid date', async () => {
  const chain = await signedChain();
  await assert.rejects(verifyInteraction({ ...chain.context, request: chain.request, observedAt: '2026-09-24' }), /observedAt|UTC/i);
  await assert.rejects(verifyInteraction({ ...chain.context, request: chain.request, observedAt: '2026-02-30T12:30:00Z' }), /observedAt|UTC/i);
});

test('expired outcome cannot precede the request deadline', async () => {
  const chain = await signedChain();
  const completion = await signProviderStatement({
    kind: 'completion', version: '0.1',
    acceptanceDigest: encodeStatement({ ...chain.f.acceptance,
      requestDigest: encodeStatement(chain.f.request).digest }).digest,
    recordedAt: '2026-09-24T12:10:00Z', outcome: 'expired',
  }, chain.f.runtime, chain.f.profile);
  const report = await verifyInteraction({ ...chain.context, request: chain.request,
    acceptance: chain.acceptance, completion });
  assert.equal(report.completion?.link, 'mismatched');
  assert.equal(report.completion?.usableAtObservation, false);
  assert.equal(report.allPresentedEvidenceUsableAtObservation, false);
});

test('signer-claimed future times cannot qualify evidence at the observer clock', async () => {
  const chain = await signedChain();
  const futureRequest = await signRequest({ ...chain.f.request, createdAt: '2026-09-24T12:40:00Z' }, chain.f.caller);
  const requestReport = await verifyInteraction({ ...chain.context, request: futureRequest });
  assert.equal(requestReport.request.claimedTime, 'future');
  assert.equal(requestReport.request.usableAtObservation, false);

  const futureAcceptance = await signProviderStatement({ ...chain.f.acceptance,
    requestDigest: encodeStatement(chain.f.request).digest, acceptedAt: '2026-09-24T12:40:00Z',
  }, chain.f.runtime, chain.f.profile);
  const acceptanceReport = await verifyInteraction({ ...chain.context, request: chain.request, acceptance: futureAcceptance });
  assert.equal(acceptanceReport.acceptance?.claimedTime, 'future');
  assert.equal(acceptanceReport.acceptance?.usableAtObservation, false);

  const futureCompletion = await signProviderStatement({
    kind: 'completion', version: '0.1',
    acceptanceDigest: encodeStatement({ ...chain.f.acceptance,
      requestDigest: encodeStatement(chain.f.request).digest }).digest,
    recordedAt: '2026-09-24T13:00:01Z', outcome: 'expired',
  }, chain.f.runtime, chain.f.profile);
  const completionReport = await verifyInteraction({ ...chain.context, request: chain.request,
    acceptance: chain.acceptance, completion: futureCompletion });
  assert.equal(completionReport.completion?.claimedTime, 'future');
  assert.equal(completionReport.completion?.usableAtObservation, false);
  assert.equal(completionReport.allPresentedEvidenceUsableAtObservation, false);
});

test('acceptance and completion are not usable without valid signed parents', async () => {
  const chain = await signedChain();
  const invalidSignature = `0x${'00'.repeat(65)}`;
  const badRequest = await verifyInteraction({ ...chain.context,
    request: { ...chain.request, signature: invalidSignature }, acceptance: chain.acceptance });
  assert.equal(badRequest.request.cryptography, 'invalid');
  assert.equal(badRequest.acceptance?.usableAtObservation, false);
  const badAcceptance = await verifyInteraction({ ...chain.context, request: chain.request,
    acceptance: { ...chain.acceptance, signature: invalidSignature },
    completion: chain.completion, answerBytes: chain.answerBytes });
  assert.equal(badAcceptance.acceptance?.cryptography, 'invalid');
  assert.equal(badAcceptance.completion?.usableAtObservation, false);
  assert.equal(badAcceptance.allPresentedEvidenceUsableAtObservation, false);
});
