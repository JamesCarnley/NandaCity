import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { calculatePolicy, type PolicyInput } from '../../src/reputation/policy.js';

const digest = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const DAY = 86400;
const NOW = 200 * DAY;

function fixture(): PolicyInput {
  return {
    policy: {
      id: 'local-usefulness', version: '1',
      reviewers: ['alice', 'bob', 'carol'],
      groups: [
        { key: 'alice-control', reviewers: ['alice'] },
        { key: 'bob-control', reviewers: ['bob'] },
        { key: 'carol-control', reviewers: ['carol'] },
      ],
      curators: ['curator'], evaluators: ['evaluator'],
    },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'usefulness-v1' },
    observation: {
      id: 'observation-1000', domain: 'registry:test', block: '1000', timestamp: NOW,
      timeBasis: 'declared-fixture', provenance: 'supplied',
    },
    candidates: [{
      service: 'service:a', city: 'Chicago', task: 'evening-plan',
      profile: { id: 'profile-a', status: 'valid', endpoint: 'endpoint:a', cardDigest: digest(900), provenance: 'supplied' },
      history: {
        id: 'history-a', status: 'complete', startBlock: '1', start: 'registry-start-confirmed',
        observation: 'observation-1000', provenance: 'supplied',
      },
    }],
    reviews: [],
    admissions: [{
      kind: 'curator', id: 'curation-a', service: 'service:a', issuer: 'curator',
      city: 'Chicago', task: 'evening-plan', status: 'valid', provenance: 'supplied',
    }],
  };
}

function review(n: number, overrides: Partial<PolicyInput['reviews'][number]> = {}): PolicyInput['reviews'][number] {
  return {
    id: `review-${n}`, documentDigest: digest(n), service: 'service:a', reviewer: 'alice',
    interaction: `interaction-${n}`, city: 'Chicago', task: 'evening-plan', rubric: 'usefulness-v1', rating: 5,
    checks: {
      feedbackSignature: 'valid', requestSignature: 'valid', acceptanceSignature: 'valid',
      links: 'matched', originalAuthority: 'matched', chronology: 'consistent', result: 'signed-completion',
    },
    epoch: 'same', provenance: 'supplied',
    publication: {
      domain: 'registry:test', block: String(n + 10), transaction: 0, log: 0,
      timestamp: NOW - DAY, canonical: 'canonical', projection: 'matched', revocation: 'active',
    },
    ...overrides,
  };
}

function result(input: PolicyInput) { return calculatePolicy(input).candidates[0]!; }
function reason(input: PolicyInput, id: string) {
  return result(input).reviews.find((r) => r.id === id)?.reason;
}

function pairZeroInput(): any {
  const input: any = fixture();
  const reviewer = '0x1111111111111111111111111111111111111111';
  const domain = { chainId: 11155111, genesisHash: digest(0),
    identityRegistry: '0x2222222222222222222222222222222222222222',
    reputationRegistry: '0x3333333333333333333333333333333333333333' };
  const service = `eip155:11155111/erc721:${domain.identityRegistry}/7`;
  input.policy.reviewers = [reviewer]; input.policy.groups = [{ key: 'reviewer', reviewers: [reviewer] }];
  input.observation.domain = `eip155:11155111/erc8004:${domain.reputationRegistry}`;
  input.candidates[0].service = service; input.admissions[0].service = service;
  input.candidates[0].history = { id: 'checkpoint-history', status: 'complete', startBlock: '100',
    start: 'pair-zero-checkpoint-confirmed', observation: input.observation.id, provenance: 'supplied',
    checkpoint: { domain, zeroBasis: { blockNumber: '100', blockHash: digest(100) }, pairs: [{ agentId: '7', reviewer }] } };
  const r = review(1, { service, reviewer });
  r.publication = { ...r.publication, domain: input.observation.domain, block: '101' };
  input.reviews = [r]; return input;
}

test('pair-zero history qualifies only the explicit post-checkpoint service/reviewer scope', () => {
  const input = pairZeroInput();
  assert.equal(result(input).view, 'recommended-rated');
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  assert.deepEqual(result(input).history, input.candidates[0].history);
  input.reviews = [];
  assert.equal(result(input).view, 'recommended-newcomer');
});

test('pair-zero complete history rejects domain, service, reviewer and zero-basis substitution', () => {
  const mutations: Array<(input: any) => void> = [
    (v) => { v.candidates[0].history.checkpoint.pairs[0].agentId = '8'; },
    (v) => { v.candidates[0].history.checkpoint.pairs[0].reviewer = '0x4444444444444444444444444444444444444444'; },
    (v) => { v.candidates[0].history.checkpoint.domain.chainId = 1; },
    (v) => { v.candidates[0].history.checkpoint.domain.identityRegistry = '0x4444444444444444444444444444444444444444'; },
    (v) => { v.candidates[0].history.checkpoint.domain.reputationRegistry = '0x4444444444444444444444444444444444444444'; },
    (v) => { v.candidates[0].history.checkpoint.zeroBasis.blockNumber = '99'; },
    (v) => { v.candidates[0].history.startBlock = '1001'; v.candidates[0].history.checkpoint.zeroBasis.blockNumber = '1001'; },
    (v) => { v.candidates[0].history.checkpoint.pairs.push(v.candidates[0].history.checkpoint.pairs[0]); },
    (v) => { v.candidates[0].history.checkpoint.pairs = []; },
  ];
  for (const mutate of mutations) { const input = pairZeroInput(); mutate(input); assert.throws(() => calculatePolicy(input)); }
  const wrongObservation = pairZeroInput(); wrongObservation.candidates[0].history.observation = 'different-B';
  assert.equal(result(wrongObservation).view, 'recommended-unresolved');
  const unnamed = pairZeroInput(); unnamed.policy.reviewers.push('0x4444444444444444444444444444444444444444');
  unnamed.policy.groups.push({ key: 'other', reviewers: [unnamed.policy.reviewers[1]] });
  assert.throws(() => calculatePolicy(unnamed));
});

test('pair-zero history never recycles a canonical publication at or before C', () => {
  for (const block of ['99', '100']) {
    const input = pairZeroInput(); input.reviews[0].publication.block = block;
    assert.throws(() => calculatePolicy(input), /checkpoint/);
    input.candidates[0].history.status = 'partial';
    assert.equal(result(input).score, null);
    assert.equal(result(input).interactionCount, 0);
    assert.equal(result(input).reviews[0]?.reason, 'before-checkpoint');
  }
});

test('pair-zero coverage does not replace missing documents, private authority or epoch qualification', () => {
  for (const mutate of [
    (v: any) => { v.candidates[0].history.status = 'partial'; },
    (v: any) => { v.reviews[0].checks.feedbackSignature = 'unknown'; v.reviews[0].rating = null; },
    (v: any) => { v.reviews[0].checks.originalAuthority = 'unknown'; },
    (v: any) => { v.reviews[0].historyQualification = 'unknown'; },
  ]) {
    const input = pairZeroInput(); mutate(input);
    assert.equal(result(input).view, 'recommended-unresolved'); assert.equal(result(input).score, null);
  }
  const retired = pairZeroInput(); retired.reviews[0].epoch = 'retired';
  assert.equal(result(retired).reviews[0]?.reason, 'retired-authority');
  assert.equal(result(retired).view, 'recommended-unassessed');
});

test('partial checkpoint history cannot assign even provisional weight to an unnamed pair', () => {
  const input = pairZeroInput(), reviewer = '0x4444444444444444444444444444444444444444';
  input.candidates[0].history.status = 'partial';
  input.policy.reviewers.push(reviewer); input.policy.groups.push({ key: 'other', reviewers: [reviewer] });
  input.reviews[0].reviewer = reviewer;
  assert.equal(result(input).provisionalScore, null);
  assert.equal(result(input).reviews[0]?.reason, 'scope-mismatch');
});

test('checkpoint pair declaration order cannot change the canonical policy output', () => {
  const input = pairZeroInput(), reviewer = '0x4444444444444444444444444444444444444444';
  input.policy.reviewers.push(reviewer); input.policy.groups.push({ key: 'other', reviewers: [reviewer] });
  input.candidates[0].history.checkpoint.pairs.push({ agentId: '7', reviewer });
  const expected = calculatePolicy(input);
  input.candidates[0].history.checkpoint.pairs.reverse();
  assert.deepEqual(calculatePolicy(input), expected);
});

test('only explicit committed runtime history bypasses retirement without changing age or revocation', () => {
  const input = fixture();
  const first = review(1, { epoch: 'retired', rating: 1,
    historyQualification: 'committed-before-runtime-retirement',
    historyBasis: { version: '0.1', documentDigest: digest(1), bundleDigest: digest(90),
      original: { blockNumber: '5', blockHash: digest(5) }, publication: { blockNumber: '11', blockHash: digest(11) },
      retirement: { blockNumber: '12', blockHash: digest(12) }, observation: { blockNumber: '1000', blockHash: digest(1000) } } });
  input.reviews = [first];
  assert.deepEqual(result(input).score, { numerator: '7', denominator: '3' });
  assert.equal(result(input).reviews[0]?.epoch, 'retired');
  assert.equal(result(input).reviews[0]?.historyQualification, 'committed-before-runtime-retirement');
  const duplicate = structuredClone(first); duplicate.id = 'duplicate';
  duplicate.publication = { ...first.publication, block: '20', timestamp: NOW };
  first.publication.timestamp = NOW - 91 * DAY; input.reviews.push(duplicate);
  assert.equal(reason(input, first.id), 'aged-out');
  assert.equal(reason(input, duplicate.id), 'duplicate-publication');
  assert.equal(result(input).score, null);
  first.publication.revocation = 'revoked';
  assert.equal(reason(input, first.id), 'revoked');
  assert.notEqual(result(input).view, 'recommended-newcomer');
  input.reviews = [review(1, { epoch: 'retired' })];
  assert.equal(reason(input, 'review-1'), 'retired-authority');
  input.reviews[0]!.historyQualification = 'unknown';
  assert.equal(reason(input, 'review-1'), 'unknown-evidence');
});

test('one, two, and three groups use exact literal fractions, not rounded stars', () => {
  for (const [reviews, score] of [
    [[review(1)], { numerator: '11', denominator: '3' }],
    [[review(1), review(2, { reviewer: 'bob', rating: 1 })], { numerator: '3', denominator: '1' }],
    [[review(1), review(2, { reviewer: 'bob', rating: 1 }), review(3, { reviewer: 'carol', rating: 4 })], { numerator: '16', denominator: '5' }],
  ] as const) {
    const input = fixture(); input.reviews = [...reviews];
    assert.deepEqual(result(input).score, score);
    assert.equal(result(input).view, 'recommended-rated');
  }
});

test('each reviewer averages three latest interactions before shared-control means', () => {
  const input = fixture();
  input.policy.groups = [{ key: 'shared', reviewers: ['alice', 'bob'] }, { key: 'carol-control', reviewers: ['carol'] }];
  input.reviews = [review(1, { rating: 5 }), review(2, { rating: 1 }), review(3, { rating: 2 }), review(4, { rating: 3 }), review(5, { reviewer: 'bob', rating: 5 })];
  const out = result(input);
  assert.deepEqual(out.score, { numerator: '19', denominator: '6' });
  assert.equal(out.groupCount, 1);
  assert.equal(out.interactionCount, 4);
  assert.deepEqual(out.groups, [{ key: 'shared', mean: { numerator: '7', denominator: '2' }, reviewers: [
    { key: 'alice', mean: { numerator: '2', denominator: '1' }, evidence: ['review-2', 'review-3', 'review-4'] },
    { key: 'bob', mean: { numerator: '5', denominator: '1' }, evidence: ['review-5'] },
  ] }]);
  assert.equal(reason(input, 'review-1'), 'sample-cap');
});

test('zero reviews, failed retrieval, and retired history are different states', () => {
  const input = fixture();
  assert.equal(result(input).view, 'recommended-newcomer');
  assert.equal(result(input).score, null);
  input.candidates[0]!.history.status = 'unavailable';
  assert.equal(result(input).view, 'recommended-unresolved');
  assert.deepEqual(result(input).warnings, ['history-unresolved']);
  input.candidates[0]!.history.status = 'complete';
  input.reviews = [review(1, { epoch: 'retired' })];
  assert.equal(result(input).view, 'recommended-unassessed');
  assert.deepEqual(result(input).warnings, ['prior-history-excluded', 'current-score-unassessed']);
});

test('latest valid revision is selected before revocation and cannot revive its predecessor', () => {
  const input = fixture();
  const latest = review(2, { interaction: 'interaction-1', rating: 1 });
  latest.publication.revocation = 'revoked';
  input.reviews = [review(1), latest];
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'superseded');
  assert.equal(reason(input, 'review-2'), 'revoked');
  assert.deepEqual(result(input).warnings, ['prior-history-excluded', 'current-score-unassessed']);
});

test('a distinct replacement reorders its interaction, unlike exact republication', () => {
  const input = fixture();
  input.reviews = [review(1, { rating: 1 }), review(2, { rating: 2 }), review(3, { rating: 3 }), review(4, { rating: 4 }), review(5, { interaction: 'interaction-1', rating: 5 })];
  assert.deepEqual(result(input).score, { numerator: '10', denominator: '3' });
  assert.equal(reason(input, 'review-2'), 'sample-cap');
  const duplicate = review(1, { id: 'duplicate' });
  duplicate.rating = 1; duplicate.publication = { ...review(5).publication };
  input.reviews[4] = duplicate;
  assert.deepEqual(result(input).score, { numerator: '3', denominator: '1' });
  assert.equal(reason(input, 'review-1'), 'sample-cap');
  assert.equal(reason(input, 'duplicate'), 'duplicate-publication');
});

test('an old duplicate anchor never refreshes age, including an observed original revocation', () => {
  const input = fixture();
  const first = review(1); first.publication.timestamp = NOW - 91 * DAY;
  const duplicate = structuredClone(first); duplicate.id = 'duplicate'; duplicate.publication = { ...review(2).publication };
  input.reviews = [duplicate, first];
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'aged-out');
  assert.equal(reason(input, 'duplicate'), 'duplicate-publication');
  first.publication.revocation = 'revoked';
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'revoked');
});

test('incomplete pre-window discovery or unproven registry start withholds rank', () => {
  for (const change of ['partial', 'unproven', 'wrong-observation'] as const) {
    const input = fixture(); input.reviews = [review(1)];
    if (change === 'partial') input.candidates[0]!.history.status = 'partial';
    if (change === 'unproven') input.candidates[0]!.history.start = 'unproven';
    if (change === 'wrong-observation') input.candidates[0]!.history.observation = 'another-observation';
    assert.equal(result(input).score, null);
    assert.equal(result(input).view, 'recommended-unresolved');
    assert.deepEqual(calculatePolicy(input).selection.rated, []);
  }
});

test('a missing potentially eligible later revision is unresolved rather than an old positive fallback', () => {
  const input = fixture();
  const missing = review(2, { interaction: 'interaction-1', rating: null });
  missing.checks.result = 'unknown';
  input.reviews = [review(1), missing];
  assert.equal(result(input).score, null);
  assert.equal(result(input).provisionalScore, null);
  assert.equal(reason(input, 'review-1'), 'unresolved-revision');
  assert.equal(reason(input, 'review-2'), 'unknown-evidence');
});

test('unknown reviewer or interaction metadata cannot silently hide missing negatives', () => {
  const input = fixture();
  const missing = review(2, { reviewer: null, interaction: null, city: null, task: null, rubric: null, rating: null });
  missing.checks.feedbackSignature = 'unknown';
  input.reviews = [review(1), missing];
  assert.equal(result(input).score, null);
  assert.equal(result(input).view, 'recommended-unresolved');
});

test('a known invalid signature does not replace the earlier valid revision', () => {
  for (const field of ['feedbackSignature', 'requestSignature', 'acceptanceSignature'] as const) {
    const input = fixture();
    const invalid = review(2, { interaction: 'interaction-1', rating: 1 }); invalid.checks[field] = 'invalid';
    input.reviews = [review(1), invalid];
    assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
    assert.equal(reason(input, 'review-2'), 'invalid-evidence');
    assert.deepEqual(result(input).warnings, []);
  }
});

test('future publications are invalid and the exact 90-day boundary is inclusive', () => {
  const input = fixture(); const item = review(1); input.reviews = [item];
  item.publication.timestamp = NOW + 1;
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'future-publication');
  item.publication.timestamp = NOW - 90 * DAY;
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  item.publication.timestamp -= 1;
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'aged-out');
});

test('retired history warning persists alongside valid new current reviews', () => {
  const input = fixture();
  input.reviews = [review(1, { epoch: 'retired' }), review(2, { rating: 4 })];
  assert.deepEqual(result(input).score, { numerator: '10', denominator: '3' });
  assert.deepEqual(result(input).warnings, ['prior-history-excluded']);
  assert.equal(result(input).view, 'recommended-rated');
});

test('a selected retired revision cannot revive an earlier current-epoch revision', () => {
  const input = fixture();
  input.reviews = [review(1), review(2, { interaction: 'interaction-1', epoch: 'retired', rating: 1 })];
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'superseded');
  assert.equal(reason(input, 'review-2'), 'retired-authority');
});

test('revoking one interaction can admit an older different interaction, not its own old revision', () => {
  const input = fixture();
  const revoked = review(5, { interaction: 'interaction-4', rating: 1 }); revoked.publication.revocation = 'revoked';
  input.reviews = [review(1, { rating: 1 }), review(2, { rating: 2 }), review(3, { rating: 3 }), review(4, { rating: 5 }), revoked];
  assert.deepEqual(result(input).score, { numerator: '8', denominator: '3' });
  assert.equal(reason(input, 'review-1'), 'contributing');
  assert.equal(reason(input, 'review-4'), 'superseded');
});

test('unknown wallets have zero positive and negative weight and cannot create history warnings', () => {
  const input = fixture();
  input.reviews = [review(1), review(2, { reviewer: 'stranger', rating: 1, epoch: 'retired' }), review(3, { reviewer: 'stranger', rating: 5 })];
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  assert.equal(reason(input, 'review-2'), 'reviewer-not-accepted');
  assert.deepEqual(result(input).warnings, []);
});

test('linked signed failure and post-deadline no-result claims allow negative feedback', () => {
  for (const kind of ['signed-failure', 'post-deadline-reviewer-claim'] as const) {
    const input = fixture(); const item = review(1, { rating: 1 }); item.checks.result = kind; input.reviews = [item];
    assert.deepEqual(result(input).score, { numerator: '7', denominator: '3' });
    assert.equal(result(input).reviews[0]!.resultKind, kind);
    assert.equal(result(input).historicalOrdering, 'unknown');
  }
});

test('incomplete supporting evidence cannot receive interaction-linked weight', () => {
  const input = fixture(); const item = review(1); item.checks.acceptanceSignature = 'unknown'; input.reviews = [item];
  assert.equal(result(input).score, null);
  assert.equal(result(input).provisionalScore, null);
  assert.equal(result(input).view, 'recommended-unresolved');
});

test('city, task, rubric, service and publication domain are exact separate namespaces', () => {
  for (const field of ['city', 'task', 'rubric', 'service', 'domain'] as const) {
    const input = fixture(); const item = review(1, { rating: 1, epoch: 'retired' });
    if (field === 'domain') item.publication.domain = 'registry:other';
    else item[field] = 'other';
    input.reviews = [item];
    assert.equal(result(input).score, null);
    assert.deepEqual(result(input).warnings, []);
    assert.equal(calculatePolicy(input).evidence.find((entry) => entry.id === 'review-1')?.reason, field === 'service' ? 'service-not-in-candidates' : 'scope-mismatch');
  }
});

test('profile invalidity or lack of admission never produces Recommended status', () => {
  for (const status of ['invalid', 'inactive', 'unknown'] as const) {
    const input = fixture(); input.candidates[0]!.profile.status = status; input.reviews = [review(1)];
    assert.equal(result(input).view, 'excluded');
    assert.deepEqual(calculatePolicy(input).selection.rated, []);
  }
  const input = fixture(); input.admissions = []; input.reviews = [review(1)];
  assert.equal(result(input).view, 'explore');
  assert.equal(result(input).admitted, false);
});

test('a scoped test admits only an accepted evaluator and the current endpoint and exact card', () => {
  const input = fixture();
  input.admissions = [{ kind: 'test', id: 'test-a', service: 'service:a', issuer: 'evaluator', city: 'Chicago', task: 'evening-plan', status: 'valid', provenance: 'adapter-observed', endpoint: 'endpoint:a', cardDigest: digest(900) }];
  assert.equal(result(input).view, 'recommended-newcomer');
  input.candidates[0]!.profile.endpoint = 'endpoint:migrated';
  assert.equal(result(input).view, 'explore');
  assert.equal(result(input).admissions[0]!.reason, 'profile-binding-mismatch');
  input.candidates[0]!.profile.endpoint = 'endpoint:a';
  input.candidates[0]!.profile.cardDigest = digest(901);
  assert.equal(result(input).view, 'explore');
  input.candidates[0]!.profile.cardDigest = digest(900);
  input.admissions[0]!.issuer = 'unaccepted';
  assert.equal(result(input).view, 'explore');
});

test('endpoint migration with explicit same epoch preserves reviews, while retired or unknown epoch does not', () => {
  const input = fixture(); input.reviews = [review(1)]; input.candidates[0]!.profile.endpoint = 'endpoint:migrated';
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  input.reviews[0]!.epoch = 'retired';
  assert.equal(result(input).score, null);
  assert.equal(result(input).view, 'recommended-unassessed');
  input.reviews[0]!.epoch = 'unknown';
  assert.equal(result(input).view, 'recommended-unresolved');
});

test('superseded negatives and sample-cap exclusions alone do not create persistent warnings', () => {
  const input = fixture();
  input.reviews = [review(1, { rating: 1 }), review(2, { interaction: 'interaction-1', rating: 5 })];
  assert.deepEqual(result(input).warnings, []);
  input.reviews = [review(1, { rating: 1 }), review(2), review(3), review(4)];
  assert.deepEqual(result(input).warnings, []);
  input.reviews[0]!.epoch = 'retired';
  assert.deepEqual(result(input).warnings, ['prior-history-excluded']);
});

test('selected negative aged reviews warn, but aged neutral or positive reviews do not', () => {
  const input = fixture(); const item = review(1, { rating: 2 }); item.publication.timestamp = NOW - 91 * DAY; input.reviews = [item];
  assert.deepEqual(result(input).warnings, ['prior-history-excluded', 'current-score-unassessed']);
  item.rating = 3;
  assert.deepEqual(result(input).warnings, []);
});

test('ranking uses exact score then group count then stable key, without boosting curated newcomers', () => {
  const input = fixture();
  input.candidates.push(...['service:b', 'service:c', 'service:d', 'service:new'].map((service) => ({ ...structuredClone(input.candidates[0]!), service })));
  input.admissions.push(...['service:b', 'service:c', 'service:d', 'service:new'].map((service) => ({ ...structuredClone(input.admissions[0]!), id: `curation-${service}`, service })));
  input.reviews = [review(1, { rating: 1 }), review(2, { service: 'service:b', rating: 3 }), review(3, { service: 'service:c', rating: 3 }), review(4, { service: 'service:d', rating: 3 }), review(5, { service: 'service:d', reviewer: 'bob', rating: 3 })];
  assert.deepEqual(calculatePolicy(input).selection.rated, ['service:d', 'service:b', 'service:c', 'service:a']);
  assert.deepEqual(calculatePolicy(input).selection.newcomers, ['service:new']);
  assert.deepEqual(calculatePolicy(input).candidates.find((candidate) => candidate.service === 'service:a')!.score, { numerator: '7', denominator: '3' });
});

test('revision order is block, transaction, log, digest; input order and policy declaration order do not matter', () => {
  const input = fixture();
  input.reviews = [review(1, { rating: 1 }), review(2, { interaction: 'interaction-1', rating: 5 })];
  input.reviews[0]!.publication = { ...input.reviews[1]!.publication };
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  input.reviews[0]!.publication.log = 1;
  assert.deepEqual(result(input).score, { numerator: '7', denominator: '3' });
  input.reviews[1]!.publication.transaction = 1;
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  input.reviews[0]!.publication.block = '100';
  assert.deepEqual(result(input).score, { numerator: '7', denominator: '3' });
  const expected = calculatePolicy(input);
  input.reviews.reverse(); input.policy.reviewers.reverse(); input.policy.groups.reverse();
  assert.deepEqual(calculatePolicy(input), expected);
  assert.deepEqual(calculatePolicy(JSON.parse(JSON.stringify(input))), expected);
});

test('publication uncertainty is distinct from known noncanonical or post-observation evidence', () => {
  const input = fixture(); const item = review(1); input.reviews = [item];
  item.publication.canonical = 'unknown';
  assert.equal(result(input).view, 'recommended-unresolved');
  item.publication.canonical = 'noncanonical';
  assert.equal(result(input).view, 'recommended-newcomer');
  item.publication.canonical = 'canonical'; item.publication.block = '1001';
  assert.equal(reason(input, 'review-1'), 'after-observation');
  assert.equal(result(input).view, 'recommended-newcomer');
  item.publication.block = '11'; item.publication.revocation = 'unknown';
  assert.equal(result(input).view, 'recommended-unresolved');
});

test('unknown first-anchor canonicality prevents a later duplicate becoming a qualified first review', () => {
  const input = fixture(); const first = review(1); first.publication.canonical = 'unknown';
  const duplicate = structuredClone(first); duplicate.id = 'duplicate'; duplicate.publication = review(2).publication;
  input.reviews = [first, duplicate];
  assert.equal(result(input).score, null);
  assert.equal(result(input).view, 'recommended-unresolved');
});

test('changing the named reviewer policy changes numeric weight transparently', () => {
  const input = fixture(); input.reviews = [review(1, { rating: 1 }), review(2, { reviewer: 'bob', rating: 5 })];
  assert.deepEqual(result(input).score, { numerator: '3', denominator: '1' });
  input.policy.id = 'bob-only'; input.policy.version = '2'; input.policy.reviewers = ['bob']; input.policy.groups = [{ key: 'bob-control', reviewers: ['bob'] }];
  const out = calculatePolicy(input);
  assert.deepEqual(out.candidates[0]!.score, { numerator: '11', denominator: '3' });
  assert.equal(out.policy.id, 'bob-only'); assert.equal(out.policy.version, '2');
  assert.equal(out.candidates[0]!.reviews[0]!.reason, 'reviewer-not-accepted');
});

test('supplied and adapter-observed provenance is preserved, never promoted to crypto verification', () => {
  const input = fixture(); input.reviews = [review(1), review(2, { reviewer: 'bob', provenance: 'adapter-observed' })];
  input.candidates[0]!.history.provenance = 'adapter-observed';
  const out = calculatePolicy(input);
  assert.equal(out.observation.provenance, 'supplied');
  assert.equal(out.candidates[0]!.profile.provenance, 'supplied');
  assert.equal(out.candidates[0]!.history.provenance, 'adapter-observed');
  assert.deepEqual(out.candidates[0]!.reviews.map((entry) => entry.provenance), ['supplied', 'adapter-observed']);
  assert.equal(out.qualification, 'input-findings-not-verified-by-calculator');
});

test('input and output are independent deep copies', () => {
  const input = fixture(); input.reviews = [review(1)]; const before = structuredClone(input);
  const output = calculatePolicy(input);
  assert.deepEqual(input, before);
  input.policy.reviewers[0] = 'changed'; input.candidates[0]!.profile.status = 'invalid'; input.reviews[0]!.rating = 1;
  assert.deepEqual(output.candidates[0]!.score, { numerator: '11', denominator: '3' });
  assert.equal(output.candidates[0]!.profile.status, 'valid');
  output.candidates[0]!.history.status = 'partial';
  assert.equal(input.candidates[0]!.history.status, 'complete');
});

test('missing, duplicate and conflicting reviewer groups or policy members reject', () => {
  const mutations: ((input: PolicyInput) => void)[] = [
    (input) => { input.policy.groups.pop(); },
    (input) => { input.policy.groups[1]!.reviewers.push('alice'); },
    (input) => { input.policy.groups[0]!.reviewers.push('alice'); },
    (input) => { input.policy.groups.push({ key: 'alice-control', reviewers: [] }); },
    (input) => { input.policy.groups[0]!.reviewers.push('stranger'); },
    (input) => { input.policy.reviewers.push('alice'); },
    (input) => { input.policy.curators.push('curator'); },
    (input) => { input.policy.evaluators.push('evaluator'); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => calculatePolicy(input)); }
});

test('candidate, evidence and policy bounds reject overflow without truncation', () => {
  const candidates = fixture(); candidates.candidates = Array.from({ length: 65 }, (_, n) => ({ ...structuredClone(candidates.candidates[0]!), service: `service:${n}` }));
  assert.throws(() => calculatePolicy(candidates));
  const evidence = fixture(); evidence.reviews = Array.from({ length: 2049 }, (_, n) => review(n + 1));
  assert.throws(() => calculatePolicy(evidence));
  const policy = fixture(); policy.policy.curators = Array.from({ length: 257 }, (_, n) => `curator:${n}`);
  assert.throws(() => calculatePolicy(policy));
  const admissions = fixture(); admissions.admissions = Array.from({ length: 513 }, (_, n) => ({ ...admissions.admissions[0]!, id: `admission:${n}` }));
  assert.throws(() => calculatePolicy(admissions));
});

test('unknown fields, non-JSON values, accessors and contradictory duplicate evidence reject', () => {
  for (const bad of [undefined, NaN, Infinity, 1n, () => 1]) {
    assert.throws(() => calculatePolicy({ ...fixture(), unexpected: bad }));
  }
  const input = fixture();
  assert.throws(() => calculatePolicy({ ...input, scope: { ...input.scope, secret: 'private text' } }));
  assert.throws(() => calculatePolicy({ ...input, candidates: [input.candidates[0], input.candidates[0]] }));
  let invoked = false;
  const accessor = Object.defineProperty({}, 'policy', { enumerable: true, get() { invoked = true; return input.policy; } });
  assert.throws(() => calculatePolicy(accessor)); assert.equal(invoked, false);
  const cycle: Record<string, unknown> = {}; cycle['cycle'] = cycle;
  assert.throws(() => calculatePolicy(cycle));
  input.reviews = [review(1), review(1, { id: 'duplicate', rating: 1 })];
  assert.throws(() => calculatePolicy(input));
  input.reviews = [review(1), review(2, { id: 'review-1' })];
  assert.throws(() => calculatePolicy(input));
  input.reviews = [review(1, { rating: null })];
  assert.throws(() => calculatePolicy(input));
});

test('complete claimed registry history cannot begin after an included canonical publication', () => {
  const input = fixture(); input.reviews = [review(1)]; input.candidates[0]!.history.startBlock = '12';
  assert.throws(() => calculatePolicy(input));
});

test('conflicting findings for the same publication reject rather than letting evidence ID choose revocation', () => {
  const input = fixture(); const revoked = review(1, { id: 'z-revoked' }); revoked.publication.revocation = 'revoked';
  input.reviews = [review(1, { id: 'a-active' }), revoked];
  assert.throws(() => calculatePolicy(input));
});

test('unknown later duplicate does not change a known first anchor or revive a revoked first anchor', () => {
  const input = fixture(); const first = review(1);
  const later = structuredClone(first); later.id = 'later'; later.publication = review(2).publication; later.publication.canonical = 'unknown';
  input.reviews = [first, later];
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  assert.equal(result(input).reviews.find((entry) => entry.id === 'later')!.anchor, 'review-1');
  first.publication.revocation = 'revoked';
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'revoked');
});

test('known mismatched authority, links, chronology or result cannot give numeric weight or a warning', () => {
  for (const check of ['originalAuthority', 'links', 'chronology', 'result'] as const) {
    const input = fixture(); const item = review(1, { rating: 1, epoch: 'retired' });
    if (check === 'originalAuthority' || check === 'links') item.checks[check] = 'mismatched';
    if (check === 'chronology') item.checks.chronology = 'inconsistent';
    if (check === 'result') item.checks.result = 'invalid';
    input.reviews = [item];
    assert.equal(result(input).score, null);
    assert.equal(reason(input, 'review-1'), 'invalid-evidence');
    assert.deepEqual(result(input).warnings, []);
  }
});

test('admission evidence requires valid matching scope, not merely a named issuer', () => {
  for (const change of ['invalid', 'unknown', 'city', 'task'] as const) {
    const input = fixture();
    if (change === 'invalid' || change === 'unknown') input.admissions[0]!.status = change;
    else input.admissions[0]![change] = 'other';
    assert.equal(result(input).admitted, false);
    assert.equal(result(input).view, 'explore');
  }
  const input = fixture(); input.candidates[0]!.city = 'Boston';
  assert.equal(result(input).view, 'excluded');
  assert.equal(result(input).profileEligible, false);
});

test('the review limit accepts exactly 2048 small entries and does not silently drop the last one', () => {
  const input = fixture(); input.observation.block = '10000';
  input.reviews = Array.from({ length: 2048 }, (_, n) => review(n + 1, { rating: n === 2047 ? 1 : 5 }));
  assert.deepEqual(result(input).score, { numerator: '29', denominator: '9' });
  assert.equal(result(input).reviews.length, 2048);
  assert.equal(reason(input, 'review-2048'), 'contributing');
});

test('malformed scalar values, prototypes, sparse arrays and hidden properties reject', () => {
  const input = fixture();
  for (const rating of [0, 6, 1.5, '5']) assert.throws(() => calculatePolicy({ ...input, reviews: [{ ...review(1), rating }] }));
  for (const value of ['01', '-1', '1.0', '0x10', '9'.repeat(79)]) assert.throws(() => calculatePolicy({ ...input, observation: { ...input.observation, block: value } }));
  assert.throws(() => calculatePolicy(Object.assign(Object.create({ extra: true }) as object, input)));
  assert.throws(() => calculatePolicy({ ...input, reviews: new Array(1) }));
  assert.throws(() => calculatePolicy(Object.defineProperty(input, 'hidden', { value: true, enumerable: false })));
});

test('a separate Node process recomputes serialized inputs without hidden state', () => {
  const input = fixture();
  input.reviews = [review(1), review(2, { reviewer: 'bob', rating: 1 }), review(3, { reviewer: 'carol', rating: 4 })];
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { calculatePolicy } from ${JSON.stringify(new URL('../../src/reputation/policy.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(calculatePolicy(JSON.parse(readFileSync(0, 'utf8')))));
  `], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout) as ReturnType<typeof calculatePolicy>;
  assert.deepEqual(output.candidates[0]!.score, { numerator: '16', denominator: '5' });
  assert.deepEqual(output.selection.rated, ['service:a']);
  assert.deepEqual(output, calculatePolicy(input));
});

test('an earlier wrong-attribution revoked publication cannot poison the genuine document anchor', () => {
  const input = fixture(); const genuine = review(1, { id: 'genuine' }); genuine.publication.block = '20';
  const wrong = structuredClone(genuine); wrong.id = 'wrong-attribution'; wrong.publication.block = '10';
  wrong.publication.projection = 'mismatched'; wrong.publication.revocation = 'revoked';
  input.reviews = [genuine, wrong];
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  assert.equal(reason(input, 'wrong-attribution'), 'publication-projection-mismatch');
  assert.equal(result(input).reviews.find((entry) => entry.id === 'genuine')!.anchor, 'genuine');
  assert.deepEqual(result(input).warnings, []);
});

test('an unrelated client copying a valid document digest is excluded without changing signed identities', () => {
  const input = fixture(); const genuine = review(1);
  const copy = structuredClone(genuine); copy.id = 'unrelated-client-copy'; copy.publication = { ...review(2).publication, projection: 'mismatched' };
  input.reviews = [genuine, copy];
  assert.deepEqual(result(input).score, { numerator: '11', denominator: '3' });
  assert.equal(reason(input, 'unrelated-client-copy'), 'publication-projection-mismatch');
  assert.deepEqual(result(input).reviews.map((entry) => entry.reviewer), ['alice', 'alice']);
  assert.deepEqual(result(input).groups[0]!.reviewers[0]!.evidence, ['review-1']);
});

test('unknown potentially earliest projection is unresolved, but an unknown later duplicate cannot refresh age', () => {
  const input = fixture(); const first = review(1); first.publication.projection = 'unknown';
  const later = structuredClone(first); later.id = 'later'; later.publication = review(2).publication;
  input.reviews = [first, later];
  assert.equal(result(input).score, null);
  assert.equal(result(input).view, 'recommended-unresolved');
  assert.equal(result(input).reviews.find((entry) => entry.id === 'later')!.anchor, null);
  first.publication.projection = 'matched'; first.publication.timestamp = NOW - 91 * DAY;
  later.publication.projection = 'unknown';
  assert.equal(result(input).score, null);
  assert.equal(reason(input, 'review-1'), 'aged-out');
  assert.equal(reason(input, 'later'), 'duplicate-publication');
  assert.equal(result(input).qualification, 'qualified');
});

test('projection is required and contradictory findings for one publication reject', () => {
  const input = fixture(); const item = review(1); const { projection: _projection, ...missing } = item.publication;
  assert.throws(() => calculatePolicy({ ...input, reviews: [{ ...item, publication: missing }] }));
  const conflict = structuredClone(item); conflict.id = 'conflict'; conflict.publication.projection = 'mismatched';
  input.reviews = [item, conflict];
  assert.throws(() => calculatePolicy(input));
});

test('the exact serialized 2 MiB budget includes UTF-8, escaped values and escaped keys', () => {
  // 511 entries each occupy 4096 bytes including their separator, plus the
  // opening bracket: 2,093,057 bytes. The last item+comma must occupy 4095.
  const prefix = Array.from({ length: 511 }, () => 'a'.repeat(4093));
  const finalItems: unknown[] = [
    'a'.repeat(4092), 'é'.repeat(2046), '😀'.repeat(1023),
    '\\'.repeat(2046), '"'.repeat(2046), '\n'.repeat(2046), '\u0000'.repeat(682), '\ud800'.repeat(682),
    { 'é\n': 'a'.repeat(4083) },
  ];
  for (const last of finalItems) {
    const exact = [...prefix, last];
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), 2097152);
    // The byte budget accepts this exact size, then the policy schema rejects
    // the deliberately wrong top-level array. It must not reject the byte size.
    assert.throws(() => calculatePolicy(exact), (error: unknown) => error instanceof Error && error.name === 'ZodError');
    const over = [...prefix, typeof last === 'string' ? `${last}a` : { 'é\n': 'a'.repeat(4084) }];
    assert.equal(Buffer.byteLength(JSON.stringify(over)), 2097153);
    assert.throws(() => calculatePolicy(over), /input exceeds 2 MiB/);
  }
});

test('oversized nested JSON stops during copying before later content is traversed', () => {
  const cycle: Record<string, unknown> = {}; cycle['cycle'] = cycle;
  const input = { nested: { values: Array.from({ length: 512 }, () => 'a'.repeat(4093)) }, later: cycle };
  assert.throws(() => calculatePolicy(input), /input exceeds 2 MiB/);
});
