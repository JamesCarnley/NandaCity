import { z } from 'zod';

const WINDOW_SECONDS = 90 * 86400;
const key = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const block = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((s) => BigInt(s) < (1n << 256n));
const timestamp = z.number().int().min(0).max(253402300799);
const provenance = z.enum(['supplied', 'adapter-observed']);
const signature = z.enum(['valid', 'invalid', 'unknown']);
const match = z.enum(['matched', 'mismatched', 'unknown']);
const checksSchema = z.strictObject({
  feedbackSignature: signature, requestSignature: signature, acceptanceSignature: signature,
  links: match, originalAuthority: match,
  chronology: z.enum(['consistent', 'inconsistent', 'unknown']),
  result: z.enum(['signed-completion', 'signed-failure', 'post-deadline-reviewer-claim', 'invalid', 'unknown']),
});
const reviewSchema = z.strictObject({
  id: key, documentDigest: digest, service: key, reviewer: key.nullable(), interaction: key.nullable(),
  city: key.nullable(), task: key.nullable(), rubric: key.nullable(), rating: z.number().int().min(1).max(5).nullable(),
  checks: checksSchema, epoch: z.enum(['same', 'retired', 'unknown']), provenance,
  publication: z.strictObject({
    domain: key, block, transaction: z.number().int().min(0).max(4294967295), log: z.number().int().min(0).max(4294967295),
    timestamp, canonical: z.enum(['canonical', 'noncanonical', 'unknown']), projection: match, revocation: z.enum(['active', 'revoked', 'unknown']),
  }),
});
const admissionFields = {
  id: key, service: key, issuer: key, city: key, task: key,
  status: z.enum(['valid', 'invalid', 'unknown']), provenance,
};
const inputSchema = z.strictObject({
  policy: z.strictObject({
    id: key, version: key, reviewers: z.array(key).max(256),
    groups: z.array(z.strictObject({ key, reviewers: z.array(key).min(1).max(256) })).max(256),
    curators: z.array(key).max(256), evaluators: z.array(key).max(256),
  }),
  scope: z.strictObject({ city: key, task: key, rubric: key }),
  observation: z.strictObject({
    id: key, domain: key, block, timestamp,
    timeBasis: z.enum(['declared-fixture', 'adapter-observed-publication-time']), provenance,
  }),
  candidates: z.array(z.strictObject({
    service: key, city: key, task: key,
    profile: z.strictObject({
      id: key, status: z.enum(['valid', 'invalid', 'inactive', 'unknown']), endpoint: key.nullable(), cardDigest: digest.nullable(), provenance,
    }),
    history: z.strictObject({
      id: key, status: z.enum(['complete', 'partial', 'unavailable']), startBlock: block,
      start: z.enum(['registry-start-confirmed', 'unproven']), observation: key, provenance,
    }),
  })).max(64),
  reviews: z.array(reviewSchema).max(2048),
  admissions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('curator'), ...admissionFields }),
    z.strictObject({ kind: z.literal('test'), ...admissionFields, endpoint: key, cardDigest: digest }),
  ])).max(512),
});

export type PolicyInput = z.infer<typeof inputSchema>;
type Review = PolicyInput['reviews'][number];
type Candidate = PolicyInput['candidates'][number];
export type Rational = { numerator: string; denominator: string };
type Fraction = { n: bigint; d: bigint };
export type ReviewReason =
  | 'contributing' | 'sample-cap' | 'superseded' | 'duplicate-publication'
  | 'revoked' | 'aged-out' | 'retired-authority' | 'unknown-evidence' | 'unresolved-revision'
  | 'invalid-evidence' | 'reviewer-not-accepted' | 'scope-mismatch' | 'service-not-in-candidates'
  | 'noncanonical' | 'after-observation' | 'future-publication' | 'publication-projection-mismatch';
type ReviewExplanation = {
  id: string; documentDigest: string; reviewer: string | null; interaction: string | null;
  reason: ReviewReason; anchor: string | null; provenance: Review['provenance'];
  rating: number | null; epoch: Review['epoch']; checks: Review['checks'];
  resultKind: Review['checks']['result']; publication: Review['publication'];
};
type AdmissionExplanation = { id: string; kind: 'test' | 'curator'; issuer: string; provenance: Review['provenance']; reason: string };
type GroupResult = { key: string; mean: Rational; reviewers: { key: string; mean: Rational; evidence: string[] }[] };
type View = 'recommended-rated' | 'recommended-newcomer' | 'recommended-unassessed' | 'recommended-unresolved' | 'explore' | 'excluded';
export type CandidateResult = {
  service: string; profile: Candidate['profile']; history: Candidate['history'];
  admitted: boolean; profileEligible: boolean; view: View; qualification: 'qualified' | 'unknown';
  score: Rational | null; provisionalScore: Rational | null;
  groupCount: number; interactionCount: number; groups: GroupResult[];
  warnings: string[]; historicalOrdering: 'unknown'; reviews: ReviewExplanation[]; admissions: AdmissionExplanation[];
};
export type PolicyResult = {
  algorithm: { id: 'city-usefulness'; version: '0.1'; windowSeconds: number; interactionsPerReviewer: 3; priorWeight: 2; priorMean: 3 };
  qualification: 'input-findings-not-verified-by-calculator'; policy: PolicyInput['policy'];
  scope: PolicyInput['scope']; observation: PolicyInput['observation']; candidates: CandidateResult[];
  evidence: { id: string; service: string; reason: string }[];
  selection: { rated: string[]; newcomers: string[]; unassessed: string[]; unresolved: string[]; explore: string[]; excluded: string[] };
};

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Reject accessors, custom prototypes, cycles and non-JSON values before schema parsing. */
function copyJson(input: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  function charge(fragment: string): void {
    bytes += encoder.encode(fragment).length;
    if (bytes > 2 * 1024 * 1024) throw new Error('input exceeds 2 MiB');
  }
  const active = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 12) throw new Error('input exceeds JSON structure bounds');
    if (value === null || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 4096)) {
      // Serialize only an already bounded primitive, never the whole input.
      charge(JSON.stringify(value));
      return value;
    }
    if (typeof value !== 'object' || value === null) throw new Error('input must contain bounded JSON values');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new Error('input must use plain JSON objects');
    if (active.has(value)) throw new Error('cyclic input');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((name) => typeof name !== 'string')) throw new Error('symbol keys are not JSON');
    for (const name of keys as string[]) {
      const descriptor = descriptors[name]!;
      if (!('value' in descriptor) || (!descriptor.enumerable && !(array && name === 'length'))) throw new Error('accessors or hidden fields are not JSON');
    }
    let output: unknown;
    if (array) {
      if (value.length > 2048 || keys.length !== value.length + 1) throw new Error('invalid or oversized JSON array');
      charge('[]');
      output = Array.from({ length: value.length }, (_, index) => {
        if (index !== 0) charge(',');
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw new Error('sparse JSON array');
        return copy(descriptor.value, depth + 1);
      });
    } else {
      if (keys.length > 40) throw new Error('oversized JSON object');
      charge('{}');
      output = Object.fromEntries((keys as string[]).map((name, index) => {
        if (name.length > 160) throw new Error('oversized JSON key');
        charge(`${index === 0 ? '' : ','}${JSON.stringify(name)}:`);
        return [name, copy(descriptors[name]!.value, depth + 1)];
      }));
    }
    active.delete(value);
    return output;
  }
  return copy(input, 0);
}

function unique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${description}`);
}

function documentFinding(review: Review): string {
  const { id: _id, publication: _publication, provenance: _provenance, ...document } = review;
  return JSON.stringify(document);
}

function parse(input: unknown): PolicyInput {
  const parsed = inputSchema.parse(copyJson(input));
  const policy = parsed.policy;
  unique(policy.reviewers, 'reviewer'); unique(policy.curators, 'curator'); unique(policy.evaluators, 'evaluator');
  unique(policy.groups.map((group) => group.key), 'group');
  const members = policy.groups.flatMap((group) => group.reviewers);
  unique(members, 'group assignment');
  if (members.length !== policy.reviewers.length || members.some((member) => !policy.reviewers.includes(member))) throw new Error('every accepted reviewer requires exactly one explicit group');
  unique(parsed.candidates.map((candidate) => candidate.service), 'candidate');
  unique([...parsed.reviews, ...parsed.admissions].map((evidence) => evidence.id), 'evidence ID');
  const documents = new Map<string, string>();
  const publications = new Map<string, string>();
  for (const review of parsed.reviews) {
    const descriptor = documentFinding(review);
    const previous = documents.get(review.documentDigest);
    if (previous !== undefined && previous !== descriptor) throw new Error('contradictory duplicate document findings');
    documents.set(review.documentDigest, descriptor);
    const publicationKey = JSON.stringify([review.documentDigest, review.publication.domain, review.publication.block, review.publication.transaction, review.publication.log]);
    const publicationFinding = JSON.stringify(review.publication);
    const previousPublication = publications.get(publicationKey);
    if (previousPublication !== undefined && previousPublication !== publicationFinding) throw new Error('contradictory findings for one publication');
    publications.set(publicationKey, publicationFinding);
    if (Object.values(review.checks).every((value) => !['invalid', 'mismatched', 'inconsistent', 'unknown'].includes(value)) &&
        [review.reviewer, review.interaction, review.city, review.task, review.rubric, review.rating].includes(null)) throw new Error('qualified document requires complete metadata');
  }
  for (const candidate of parsed.candidates) {
    if (candidate.profile.status === 'valid' && (candidate.profile.endpoint === null || candidate.profile.cardDigest === null)) throw new Error('valid profile requires endpoint and card binding');
    if (BigInt(candidate.history.startBlock) > BigInt(parsed.observation.block)) throw new Error('history start is after observation');
    if (candidate.history.status === 'complete' && candidate.history.start === 'registry-start-confirmed' &&
        parsed.reviews.some((review) => review.service === candidate.service && review.publication.domain === parsed.observation.domain &&
          review.publication.canonical === 'canonical' && BigInt(review.publication.block) < BigInt(candidate.history.startBlock))) throw new Error('canonical publication predates claimed registry start');
  }
  policy.reviewers.sort(compare); policy.curators.sort(compare); policy.evaluators.sort(compare);
  policy.groups.sort((a, b) => compare(a.key, b.key)).forEach((group) => group.reviewers.sort(compare));
  parsed.candidates.sort((a, b) => compare(a.service, b.service));
  parsed.reviews.sort((a, b) => compare(a.id, b.id)); parsed.admissions.sort((a, b) => compare(a.id, b.id));
  return parsed;
}

function fraction(n: bigint, d: bigint): Fraction {
  let a = n < 0n ? -n : n; let b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { n: n / a, d: d / a };
}
const add = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const mean = (values: Fraction[]): Fraction => {
  const sum = values.reduce(add, { n: 0n, d: 1n });
  return fraction(sum.n, sum.d * BigInt(values.length));
};
const rational = (value: Fraction): Rational => ({ numerator: String(value.n), denominator: String(value.d) });

function order(a: Review, b: Review): number {
  const left = BigInt(a.publication.block); const right = BigInt(b.publication.block);
  return (left < right ? -1 : left > right ? 1 : 0) ||
    a.publication.transaction - b.publication.transaction || a.publication.log - b.publication.log ||
    compare(a.documentDigest, b.documentDigest) || compare(a.id, b.id);
}

function explain(review: Review): ReviewExplanation {
  return {
    id: review.id, documentDigest: review.documentDigest, reviewer: review.reviewer, interaction: review.interaction,
    reason: 'contributing', anchor: review.id, provenance: review.provenance,
    rating: review.rating, epoch: review.epoch, checks: review.checks,
    resultKind: review.checks.result, publication: review.publication,
  };
}

function documentStatus(review: Review): 'valid' | 'invalid' | 'unknown' {
  const findings = Object.values(review.checks);
  if (findings.some((value) => ['invalid', 'mismatched', 'inconsistent'].includes(value))) return 'invalid';
  if (findings.includes('unknown') || [review.reviewer, review.interaction, review.city, review.task, review.rubric, review.rating].includes(null)) return 'unknown';
  return 'valid';
}

function initialExclusion(input: PolicyInput, review: Review): ReviewReason | null {
  if (review.publication.domain !== input.observation.domain ||
      (review.city !== null && review.city !== input.scope.city) ||
      (review.task !== null && review.task !== input.scope.task) ||
      (review.rubric !== null && review.rubric !== input.scope.rubric)) return 'scope-mismatch';
  if (review.reviewer !== null && !input.policy.reviewers.includes(review.reviewer)) return 'reviewer-not-accepted';
  if (documentStatus(review) === 'invalid') return 'invalid-evidence';
  if (BigInt(review.publication.block) > BigInt(input.observation.block)) return 'after-observation';
  if (review.publication.timestamp > input.observation.timestamp) return 'future-publication';
  if (review.publication.canonical === 'noncanonical') return 'noncanonical';
  if (review.publication.projection === 'mismatched') return 'publication-projection-mismatch';
  return null;
}

type Anchor = { review: Review; unknown: boolean };

function selectReviews(input: PolicyInput, candidate: Candidate, byId: Map<string, ReviewExplanation>): {
  eligible: Review[]; unresolved: boolean; priorExcluded: boolean;
} {
  let unresolved = candidate.history.status !== 'complete' || candidate.history.start !== 'registry-start-confirmed' ||
    candidate.history.observation !== input.observation.id;
  let priorExcluded = false;
  const documents = new Map<string, Review[]>();
  for (const review of input.reviews.filter((item) => item.service === candidate.service)) {
    const exclusion = initialExclusion(input, review);
    if (exclusion) { byId.get(review.id)!.reason = exclusion; byId.get(review.id)!.anchor = null; continue; }
    const publications = documents.get(review.documentDigest) ?? [];
    publications.push(review); documents.set(review.documentDigest, publications);
  }
  const anchors: Anchor[] = [];
  for (const publications of documents.values()) {
    publications.sort(order);
    const canonical = publications.find((review) => review.publication.canonical === 'canonical' && review.publication.projection === 'matched');
    const first = publications[0]!;
    // An earlier unqualified publication could change both age and revision order.
    const uncertainAnchor = !canonical || first.publication.canonical !== 'canonical' || first.publication.projection !== 'matched';
    const anchor = uncertainAnchor ? first : canonical;
    const unknown = uncertainAnchor || documentStatus(anchor) === 'unknown';
    for (const publication of publications) {
      const explanation = byId.get(publication.id)!;
      explanation.anchor = uncertainAnchor ? null : anchor.id;
      explanation.reason = publication === anchor ? (unknown ? 'unknown-evidence' : 'contributing') : 'duplicate-publication';
    }
    // Conservative for unavailable document/anchor findings: never infer absence
    // of negative evidence. Known later duplicates of a known first anchor do not
    // affect its age, current revocation finding, or qualification.
    if (unknown) unresolved = true;
    if (!unknown && anchor.epoch === 'retired') priorExcluded = true;
    anchors.push({ review: anchor, unknown });
  }
  const eligible: Review[] = [];
  const known = anchors.filter((anchor) => !anchor.unknown).sort((a, b) => -order(a.review, b.review));
  const selected = new Set<string>();
  for (const { review } of known) {
    const pair = JSON.stringify([review.reviewer, review.interaction]);
    if (selected.has(pair)) { byId.get(review.id)!.reason = 'superseded'; continue; }
    selected.add(pair);
    // Missing metadata is a wildcard, not a claim that the review belongs to a
    // different reviewer/interaction. Uncertain first anchors can also move later.
    const possiblyLater = anchors.some((entry) => entry.unknown &&
      (entry.review.reviewer === null || entry.review.reviewer === review.reviewer) &&
      (entry.review.interaction === null || entry.review.interaction === review.interaction) &&
      (entry.review.publication.canonical === 'unknown' || entry.review.publication.projection === 'unknown' || order(entry.review, review) >= 0));
    if (possiblyLater) { byId.get(review.id)!.reason = 'unresolved-revision'; continue; }
    let exclusion: ReviewReason | null = null;
    if (review.publication.revocation === 'revoked') exclusion = 'revoked';
    else if (review.epoch === 'retired') exclusion = 'retired-authority';
    else if (input.observation.timestamp - review.publication.timestamp > WINDOW_SECONDS) exclusion = 'aged-out';
    else if (review.publication.revocation === 'unknown' || review.epoch === 'unknown') { exclusion = 'unknown-evidence'; unresolved = true; }
    if (exclusion) {
      byId.get(review.id)!.reason = exclusion;
      if ((exclusion === 'revoked' || exclusion === 'aged-out') && review.rating! < 3) priorExcluded = true;
    } else eligible.push(review);
  }
  return { eligible, unresolved, priorExcluded };
}

function admissionExplanations(input: PolicyInput, candidate: Candidate): AdmissionExplanation[] {
  return input.admissions.filter((admission) => admission.service === candidate.service).map((admission) => {
    let reason = 'accepted';
    if (admission.city !== input.scope.city || admission.task !== input.scope.task) reason = 'scope-mismatch';
    else if (!(admission.kind === 'curator' ? input.policy.curators : input.policy.evaluators).includes(admission.issuer)) reason = 'issuer-not-accepted';
    else if (admission.status !== 'valid') reason = admission.status === 'invalid' ? 'invalid-evidence' : 'unknown-evidence';
    else if (admission.kind === 'test' && (admission.endpoint !== candidate.profile.endpoint || admission.cardDigest !== candidate.profile.cardDigest)) reason = 'profile-binding-mismatch';
    return { id: admission.id, kind: admission.kind, issuer: admission.issuer, provenance: admission.provenance, reason };
  });
}

function calculateCandidate(input: PolicyInput, candidate: Candidate): CandidateResult {
  const explanations = input.reviews.filter((review) => review.service === candidate.service).map(explain);
  const byId = new Map(explanations.map((explanation) => [explanation.id, explanation]));
  const { eligible, unresolved, priorExcluded } = selectReviews(input, candidate, byId);
  const groups: GroupResult[] = [];
  const groupMeans: Fraction[] = [];
  let interactionCount = 0;
  for (const group of input.policy.groups) {
    const reviewers: GroupResult['reviewers'] = [];
    const reviewerMeans: Fraction[] = [];
    for (const reviewer of group.reviewers) {
      const selected = eligible.filter((review) => review.reviewer === reviewer).sort((a, b) => -order(a, b));
      for (const omitted of selected.slice(3)) byId.get(omitted.id)!.reason = 'sample-cap';
      const sample = selected.slice(0, 3);
      if (sample.length === 0) continue;
      const value = mean(sample.map((review) => ({ n: BigInt(review.rating!), d: 1n })));
      reviewerMeans.push(value);
      reviewers.push({ key: reviewer, mean: rational(value), evidence: sample.map((review) => review.id).sort(compare) });
      interactionCount += sample.length;
    }
    if (reviewers.length === 0) continue;
    const value = mean(reviewerMeans); groupMeans.push(value);
    groups.push({ key: group.key, mean: rational(value), reviewers });
  }
  const sum = groupMeans.reduce(add, { n: 6n, d: 1n });
  const score = groups.length === 0 ? null : rational(fraction(sum.n, sum.d * BigInt(2 + groups.length)));
  const admissions = admissionExplanations(input, candidate);
  const profileEligible = candidate.profile.status === 'valid' && candidate.city === input.scope.city && candidate.task === input.scope.task;
  const admitted = profileEligible && admissions.some((admission) => admission.reason === 'accepted');
  const warnings: string[] = [];
  if (priorExcluded) warnings.push('prior-history-excluded');
  if (priorExcluded && score === null) warnings.push('current-score-unassessed');
  if (unresolved) warnings.push('history-unresolved');
  const view: View = !profileEligible ? 'excluded' : !admitted ? 'explore' : unresolved ? 'recommended-unresolved' :
    score ? 'recommended-rated' : priorExcluded ? 'recommended-unassessed' : 'recommended-newcomer';
  return {
    service: candidate.service, profile: candidate.profile, history: candidate.history,
    admitted, profileEligible, view, qualification: unresolved ? 'unknown' : 'qualified',
    score: unresolved ? null : score, provisionalScore: unresolved ? score : null, groupCount: groups.length, interactionCount, groups,
    warnings, historicalOrdering: 'unknown', reviews: explanations, admissions,
  };
}

/** Pure arithmetic over explicit input findings; no signature, chain, retrieval, or identity verification. */
export function calculatePolicy(input: unknown): PolicyResult {
  const parsed = parse(input);
  const candidates = parsed.candidates.map((candidate) => calculateCandidate(parsed, candidate));
  const selection: PolicyResult['selection'] = { rated: [], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] };
  const viewKeys = {
    'recommended-rated': 'rated', 'recommended-newcomer': 'newcomers', 'recommended-unassessed': 'unassessed',
    'recommended-unresolved': 'unresolved', explore: 'explore', excluded: 'excluded',
  } as const;
  for (const candidate of candidates) selection[viewKeys[candidate.view]].push(candidate.service);
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.service, candidate]));
  selection.rated.sort((a, b) => {
    const left = candidateByKey.get(a)!; const right = candidateByKey.get(b)!;
    const delta = BigInt(left.score!.numerator) * BigInt(right.score!.denominator) - BigInt(right.score!.numerator) * BigInt(left.score!.denominator);
    return (delta > 0n ? -1 : delta < 0n ? 1 : 0) || right.groupCount - left.groupCount || compare(a, b);
  });
  const evidence = [...parsed.reviews, ...parsed.admissions].map((entry) => ({
    id: entry.id, service: entry.service,
    reason: [...(candidateByKey.get(entry.service)?.reviews ?? []), ...(candidateByKey.get(entry.service)?.admissions ?? [])]
      .find((explanation) => explanation.id === entry.id)?.reason ?? 'service-not-in-candidates',
  })).sort((a, b) => compare(a.id, b.id));
  return {
    algorithm: { id: 'city-usefulness', version: '0.1', windowSeconds: WINDOW_SECONDS, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator', policy: parsed.policy,
    scope: parsed.scope, observation: parsed.observation, candidates, evidence, selection,
  };
}
