import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:https';
import { privateKeyToAccount } from 'viem/accounts';
import { digestBytes } from '../../src/identity/profile.js';
import { encodeOriginDocument } from '../../src/origin/bytes.js';
import { signOriginStatement } from '../../src/origin/signatures.js';
import type { OriginFeedback, OriginProfile, OriginStatement } from '../../src/origin/schema.js';
import { createOriginTlsFixture } from '../../src/demo/originTls.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

async function fixture(t: TestContext) {
  const api = await import('../../src/reputation/originEvidence.js').catch(() => null);
  const bundleApi = await import('../../src/origin/supportingBundle.js').catch(() => null);
  assert.ok(api && bundleApi, 'independent origin evidence and private bundle codecs must exist');
  const tls = await createOriginTlsFixture(); t.after(() => tls.close());
  const controller = privateKeyToAccount(`0x${'11'.repeat(32)}`), runtime = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const reviewer = privateKeyToAccount(`0x${'33'.repeat(32)}`), other = privateKeyToAccount(`0x${'44'.repeat(32)}`);
  const key = (account: typeof reviewer) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
  let current = new Uint8Array(); let available = true;
  const identity = createServer(tls.serverOptions, (_req, res) => available ? res.end(current) : res.writeHead(503).end());
  await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { identity.closeAllConnections(); identity.close(() => resolve()); }));
  const address = identity.address(); assert.ok(address && typeof address !== 'string');
  const identityUrl = `https://127.0.0.1:${address.port}/identity`;
  const common = { profile: 'city-origin@0.1' as const, service: { method: 'https-origin' as const, identityUrl } };
  const endpoint = 'https://127.0.0.1:9444/'; const cardURL = 'https://127.0.0.1:9444/card';
  const card = new TextEncoder().encode(JSON.stringify({ protocolVersion: '0.3.0', name: 'Synthetic Chicago',
    description: 'Synthetic only', url: endpoint, preferredTransport: 'JSONRPC', version: '0.1', capabilities: {},
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'evening-plan', name: 'Evening plan', description: 'Synthetic only', tags: ['Chicago'] }] }));
  const profile: OriginProfile = { ...common, kind: 'profile', revision: '1', active: true,
    controllerKey: key(controller), runtimeKey: key(runtime), cardURL, cardDigest: digestBytes(card), endpoint,
    city: 'Chicago', capability: 'evening-plan' };
  const doc = async (value: OriginStatement, signer = reviewer) => encodeOriginDocument(await signOriginStatement(value, signer, profile));
  const basis = await doc(profile, controller); current = new Uint8Array(basis.bytes);
  const request = await doc({ ...common, kind: 'request', caller: key(reviewer), interactionId: `0x${'ab'.repeat(32)}`,
    profileBasis: { profileDigest: basis.documentDigest, cardDigest: profile.cardDigest },
    createdAt: '2026-09-27T12:00:00Z', deadline: '2026-09-27T12:05:00Z', input: makeInteractionFixture().request.input });
  const acceptance = await doc({ ...common, kind: 'acceptance', requestDigest: request.statement.digest,
    acceptanceId: `0x${'bc'.repeat(32)}`, acceptedAt: '2026-09-27T12:01:00Z', deadline: '2026-09-27T12:05:00Z' }, runtime);
  const completion = await doc({ ...common, kind: 'completion', acceptanceDigest: acceptance.statement.digest,
    recordedAt: '2026-09-27T12:02:00Z', outcome: 'completed', answerDigest: `0x${'cd'.repeat(32)}` }, runtime);
  const value: OriginFeedback = { ...common, kind: 'feedback', reviewer: key(reviewer), interactionId: `0x${'ab'.repeat(32)}`,
    requestDigest: request.statement.digest, acceptanceDigest: acceptance.statement.digest,
    publicationPolicy: 'city-origin-archive@0.1', rubric: 'evening-plan-usefulness-v0.1', value: 5,
    createdAt: '2026-09-27T12:03:00Z', result: { kind: 'completion', completionDigest: completion.statement.digest } };
  const positive = await doc(value), negative = await doc({ ...value, value: 1, createdAt: '2026-09-27T12:04:00Z' });
  const snapshot = async (documents = [positive, negative], overrides = {}) => doc({ ...common, kind: 'archive-snapshot',
    reviewer: reviewer.address.toLowerCase(), snapshotId: 'selected', createdAt: '2026-09-27T12:06:00Z',
    historyScope: 'reviewer-declared-from-inception', entries: documents.map((d) => d.documentDigest), ...overrides });
  const selected = await snapshot();
  const archive = { snapshotDigest: selected.documentDigest, snapshot: selected.bytes,
    documents: [positive, negative].map((d) => ({ digest: d.documentDigest, bytes: d.bytes })),
    variants: [{ digest: selected.documentDigest, bytes: selected.bytes }], variantsTruncated: false, historyAvailable: true };
  const bundle = bundleApi.encodeOriginSupportingBundle({ profile: basis.bytes, request: request.bytes,
    acceptance: acceptance.bytes, completion: completion.bytes, card });
  const policy = { reviewers: [reviewer.address.toLowerCase()], groups: [{ key: 'synthetic-caller', reviewers: [reviewer.address.toLowerCase()] }],
    curatorIncluded: true };
  const options = { archive, bundle, identityUrl, allowedUrls: [identityUrl, endpoint, cardURL], ca: tls.ca,
    observedAt: '2026-09-27T12:07:00Z', policy };
  return { api, bundleApi, options, archive, bundle, doc, snapshot, selected, positive, negative, value, profile,
    basis, request, acceptance, completion, card, reviewer, other, key,
    set current(bytes: Uint8Array) { current = new Uint8Array(bytes); }, set available(v: boolean) { available = v; } };
}

test('independent evidence selects a negative revision with exact shared weights and explicit weak bases', async (t) => {
  const f = await fixture(t); const result = await f.api.verifyOriginEvidence(f.options);
  assert.deepEqual(result.policy.score, { numerator: '7', denominator: '3' });
  assert.equal(result.policy.qualification, 'archive-snapshot-qualified');
  assert.equal(result.policy.timeBasis, 'reviewer-claimed-record-time');
  assert.equal(result.originAuthority.current, 'observed');
  assert.equal(result.historicalAuthority, 'not-independently-proven');
  assert.equal(result.semanticReplay, 'not-performed');
  assert.deepEqual(result.policy.reviews.map((r) => r.reason), ['superseded', 'contributing']);
  assert.equal(result.town, 'unsupported-not-tested');
  assert.equal(result.policy.recommended, true);
});

test('selected retraction cannot resurrect a favorable revision; repeated raw blobs cannot add weight', async (t) => {
  const f = await fixture(t);
  const retraction = await f.doc({ profile: 'city-origin@0.1', kind: 'retraction', service: f.value.service, reviewer: f.key(f.reviewer),
    interactionId: f.value.interactionId, feedbackDocumentDigest: f.negative.documentDigest, createdAt: '2026-09-27T12:05:00Z' });
  const selected = await f.snapshot([f.positive, f.negative, retraction]);
  const archive = { ...f.archive, snapshotDigest: selected.documentDigest, snapshot: selected.bytes,
    documents: [...f.archive.documents, { digest: retraction.documentDigest, bytes: retraction.bytes }, ...f.archive.documents],
    variants: [{ digest: selected.documentDigest, bytes: selected.bytes }] };
  const result = await f.api.verifyOriginEvidence({ ...f.options, archive });
  assert.equal(result.policy.score, null);
  assert.deepEqual(result.policy.reviews.map((r) => r.reason), ['superseded', 'retracted']);
  assert.equal(result.policy.interactionCount, 0);
});

test('origin policy caps interactions, shares control-group weight and ignores unaccepted reviewers', async () => {
  const api = await import('../../src/reputation/originPolicy.js');
  const reviewer = `0x${'11'.repeat(20)}`, second = `0x${'22'.repeat(20)}`, unknown = `0x${'33'.repeat(20)}`;
  const review = (n: number, author: string, rating: number, createdAt = '2026-09-27T12:00:00Z') => ({
    id: `0x${n.toString(16).padStart(64, '0')}`, interaction: `0x${n.toString(16).padStart(64, '0')}`,
    reviewer: author, rating, ordinal: n, createdAt, signature: 'valid', interactionLinks: 'matched',
    chronology: 'consistent', resultKind: 'signed-completion', retracted: false });
  const input = { service: 'https://127.0.0.1/identity', observedAt: '2026-09-27T12:07:00Z', authority: 'observed',
    active: true, coverage: 'complete', policy: { reviewers: [reviewer, second], curatorIncluded: true,
      groups: [{ key: 'one-control', reviewers: [reviewer, second] }] },
    reviews: [review(1, reviewer, 5), review(2, reviewer, 1), review(3, reviewer, 2), review(4, reviewer, 3),
      review(5, second, 4), review(6, unknown, 5)] };
  const result = api.calculateOriginPolicy(input);
  // Reviewer1 mean2; reviewer2 mean4; shared group mean3; prior leaves3.
  assert.deepEqual(result.score, { numerator: '3', denominator: '1' });
  assert.equal(result.groupCount, 1); assert.equal(result.interactionCount, 4);
  assert.equal(result.reviews[0]!.reason, 'sample-cap'); assert.equal(result.reviews[5]!.reason, 'reviewer-not-accepted');
  const revised = { ...review(8, reviewer, 1, '2026-01-01T00:00:00Z'), interaction: input.reviews[0]!.interaction };
  const aged = api.calculateOriginPolicy({ ...input, reviews: [input.reviews[0], revised, { ...input.reviews[0], ordinal: 9 }] });
  assert.equal(aged.score, null); assert.deepEqual(aged.reviews.map((r) => r.reason), ['superseded', 'aged-out']);
  assert.throws(() => api.calculateOriginPolicy({ ...input, reviews: [input.reviews[0], { ...input.reviews[0], ordinal: 9, rating: 1 }] }), /contradictory/);
  assert.throws(() => api.calculateOriginPolicy({ ...input, reviews: [input.reviews[0], { ...input.reviews[1], ordinal: 1 }] }), /ordinal/);
});

for (const slot of [0, 1]) test(`missing selected slot ${slot} is partial, never absent negative evidence`, async (t) => {
  const f = await fixture(t); f.archive.documents[slot]!.bytes = null as never;
  const result = await f.api.verifyOriginEvidence(f.options);
  assert.equal(result.coverage, 'partial'); assert.equal(result.policy.score, null); assert.equal(result.policy.recommended, false);
});

test('authenticate variants before suppressing; incompatible signed history and truncation are unresolved', async (t) => {
  const f = await fixture(t); const conflict = await f.snapshot([f.negative, f.positive], { snapshotId: 'conflict' });
  f.archive.variants.push({ digest: conflict.documentDigest, bytes: conflict.bytes });
  let result = await f.api.verifyOriginEvidence(f.options);
  assert.equal(result.coverage, 'conflict'); assert.equal(result.policy.score, null);
  const unsigned = encodeOriginDocument({ ...conflict.envelope, signature: `0x${'00'.repeat(65)}` });
  f.archive.variants[1] = { digest: unsigned.documentDigest, bytes: unsigned.bytes };
  result = await f.api.verifyOriginEvidence(f.options);
  assert.deepEqual(result.policy.score, { numerator: '7', denominator: '3' });
  const malformed = new TextEncoder().encode(JSON.stringify({ ...conflict.envelope, extra: 'unsigned-lookalike' }));
  f.archive.variants[1] = { digest: digestBytes(malformed), bytes: malformed };
  assert.deepEqual((await f.api.verifyOriginEvidence(f.options)).policy.score, { numerator: '7', denominator: '3' });
  f.archive.variantsTruncated = true;
  assert.equal((await f.api.verifyOriginEvidence(f.options)).policy.recommended, false);
});

test('wrong document digests, authored signatures and private links never qualify', async (t) => {
  const f = await fixture(t);
  for (const mode of ['digest', 'signature', 'links']) {
    const altered = mode === 'signature' ? encodeOriginDocument({ ...f.negative.envelope, signature: `0x${'00'.repeat(65)}` }) :
      mode === 'links' ? await f.doc({ ...f.value, value: 1, requestDigest: `0x${'ef'.repeat(32)}` }) : f.negative;
    const selected = await f.snapshot([f.positive, altered]);
    const archive = { ...f.archive, snapshotDigest: selected.documentDigest, snapshot: selected.bytes,
      documents: [{ digest: f.positive.documentDigest, bytes: f.positive.bytes },
        { digest: altered.documentDigest, bytes: mode === 'digest' ? f.positive.bytes : altered.bytes }],
      variants: [{ digest: selected.documentDigest, bytes: selected.bytes }] };
    const result = await f.api.verifyOriginEvidence({ ...f.options, archive });
    assert.equal(result.policy.recommended, false, mode); assert.equal(result.policy.score, null, mode);
    if (mode === 'links') assert.equal(result.reviews[1]!.resultKind, 'unknown');
  }
});

test('origin loss and changed keys retain negative findings but remove current qualification', async (t) => {
  const f = await fixture(t); f.available = false;
  let result = await f.api.verifyOriginEvidence(f.options);
  assert.equal(result.originAuthority.current, 'unknown'); assert.equal(result.policy.score, null);
  assert.equal(result.reviews[1]!.rating, 1);
  f.available = true;
  f.current = (await f.doc({ ...f.profile, runtimeKey: f.key(f.other), revision: '2' }, privateKeyToAccount(`0x${'11'.repeat(32)}`))).bytes;
  result = await f.api.verifyOriginEvidence(f.options);
  assert.equal(result.originAuthority.current, 'changed'); assert.equal(result.policy.score, null);
});

test('explicit curator policy, no Town badge, private bundle bounds, and no Ethereum URL grammar', async (t) => {
  const f = await fixture(t);
  const result = await f.api.verifyOriginEvidence({ ...f.options, policy: { ...f.options.policy, curatorIncluded: false } });
  assert.equal(result.policy.recommended, false); assert.equal(result.town, 'unsupported-not-tested');
  assert.throws(() => f.bundleApi.decodeOriginSupportingBundle(new Uint8Array(256 * 1024 + 1)));
  const decoded = f.bundleApi.decodeOriginSupportingBundle(f.bundle);
  assert.deepEqual(decoded.profile, f.basis.bytes); assert.deepEqual(decoded.card, f.card);
  const policyApi = await import('../../src/reputation/originPolicy.js');
  const input = { service: `https://127.0.0.1/${'long-'.repeat(40)}%E2%98%83`, observedAt: f.options.observedAt,
    authority: 'observed', active: true, coverage: 'complete', policy: f.options.policy, reviews: [] };
  assert.equal(policyApi.calculateOriginPolicy(input).score, null);
  assert.throws(() => policyApi.calculateOriginPolicy({ ...input, policy: { ...input.policy,
    groups: [...input.policy.groups, { key: 'inflation', reviewers: input.policy.reviewers }] } }));
  assert.throws(() => policyApi.calculateOriginPolicy({ ...input, policy: { ...input.policy, townPassed: true } }));
});

test('authenticated later extension, unavailable variant and invalid snapshot signature never imply complete selected history', async (t) => {
  const f = await fixture(t);
  const earlier = await f.snapshot([f.positive], { snapshotId: 'earlier' });
  const archive = { ...f.archive, snapshotDigest: earlier.documentDigest, snapshot: earlier.bytes,
    variants: [{ digest: earlier.documentDigest, bytes: earlier.bytes }, { digest: f.selected.documentDigest, bytes: f.selected.bytes }] };
  let result = await f.api.verifyOriginEvidence({ ...f.options, archive });
  assert.equal(result.coverage, 'partial'); assert.equal(result.policy.score, null);
  archive.variants[1]!.bytes = null as never;
  result = await f.api.verifyOriginEvidence({ ...f.options, archive });
  assert.equal(result.coverage, 'partial'); assert.equal(result.policy.score, null);
  const unsigned = encodeOriginDocument({ ...earlier.envelope, signature: `0x${'00'.repeat(65)}` });
  result = await f.api.verifyOriginEvidence({ ...f.options, archive: { ...archive, snapshot: unsigned.bytes, snapshotDigest: unsigned.documentDigest } });
  assert.equal(result.coverage, 'unavailable'); assert.equal(result.policy.recommended, false);
});

test('reviewer-signed inconsistent record order and future snapshot times are unresolved', async (t) => {
  const f = await fixture(t);
  const earlierNegative = await f.doc({ ...f.value, value: 1, createdAt: '2026-09-27T12:02:30Z' });
  for (const selected of [await f.snapshot([f.positive, earlierNegative]),
    await f.snapshot([f.positive, f.negative], { createdAt: '2026-09-28T00:00:00Z' })]) {
    const result = await f.api.verifyOriginEvidence({ ...f.options, archive: { ...f.archive, snapshot: selected.bytes, snapshotDigest: selected.documentDigest,
      documents: [...f.archive.documents, { digest: earlierNegative.documentDigest, bytes: earlierNegative.bytes }],
      variants: [{ digest: selected.documentDigest, bytes: selected.bytes }] } });
    assert.equal(result.coverage, 'partial'); assert.equal(result.policy.recommended, false);
  }
});

test('signed expiry and post-deadline reviewer claims remain attributable without inventing successful completion', async (t) => {
  const f = await fixture(t);
  const runtime = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const expired = await f.doc({ profile: 'city-origin@0.1', kind: 'completion', service: f.value.service,
    acceptanceDigest: f.acceptance.statement.digest, recordedAt: '2026-09-27T12:05:30Z', outcome: 'expired' }, runtime);
  for (const useCompletion of [true, false]) {
    const negative = await f.doc({ ...f.value, value: 1, createdAt: '2026-09-27T12:06:00Z',
      result: useCompletion ? { kind: 'completion', completionDigest: expired.statement.digest } :
        { kind: 'no-result-observed', observedAt: '2026-09-27T12:05:30Z' } });
    const selected = await f.snapshot([negative]);
    const bundle = f.bundleApi.encodeOriginSupportingBundle({ profile: f.basis.bytes, request: f.request.bytes,
      acceptance: f.acceptance.bytes, ...(useCompletion ? { completion: expired.bytes } : {}), card: f.card });
    const result = await f.api.verifyOriginEvidence({ ...f.options, bundle, archive: { ...f.archive,
      snapshotDigest: selected.documentDigest, snapshot: selected.bytes,
      documents: [{ digest: negative.documentDigest, bytes: negative.bytes }], variants: [{ digest: selected.documentDigest, bytes: selected.bytes }] } });
    assert.deepEqual(result.policy.score, { numerator: '7', denominator: '3' });
    assert.equal(result.reviews[0]!.resultKind, useCompletion ? 'signed-failure' : 'post-deadline-reviewer-claim');
  }
});
