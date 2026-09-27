import { z } from 'zod';
import { originDigestSchema, originKeySchema, originUrlSchema } from '../origin/schema.js';
import { isUtcSecond } from '../interaction/schema.js';
import { compare, scoreGroups, selectLatestByPair, WINDOW_SECONDS } from './engine.js';

const reviewer = originKeySchema.shape.address;
export const originConsumerPolicySchema = z.strictObject({ reviewers: z.array(reviewer).max(256),
  groups: z.array(z.strictObject({ key: z.string().min(1).max(160), reviewers: z.array(reviewer).min(1).max(256) })).max(256),
  curatorIncluded: z.boolean() }).superRefine((value, context) => {
  const members = value.groups.flatMap((g) => g.reviewers);
  if (new Set(value.reviewers).size !== value.reviewers.length || new Set(members).size !== members.length ||
    new Set(value.groups.map((g) => g.key)).size !== value.groups.length || members.length !== value.reviewers.length ||
    members.some((m) => !value.reviewers.includes(m))) context.addIssue({ code: 'custom', message: 'each accepted reviewer requires exactly one named group' });
});
export type OriginConsumerPolicy = z.infer<typeof originConsumerPolicySchema>;
const time = z.string().refine(isUtcSecond);
const reviewSchema = z.strictObject({ id: originDigestSchema, reviewer, interaction: originDigestSchema,
  rating: z.number().int().min(1).max(5), ordinal: z.number().int().min(0).max(255), createdAt: time,
  signature: z.enum(['valid', 'invalid']), interactionLinks: z.enum(['matched', 'mismatched', 'unknown']),
  resultKind: z.enum(['signed-completion', 'signed-failure', 'post-deadline-reviewer-claim', 'unknown']),
  chronology: z.enum(['consistent', 'inconsistent']), retracted: z.boolean() });
const inputSchema = z.strictObject({ service: originUrlSchema, observedAt: time,
  authority: z.enum(['observed', 'unknown', 'changed']), active: z.boolean(),
  coverage: z.enum(['complete', 'partial', 'conflict', 'unavailable']),
  policy: originConsumerPolicySchema, reviews: z.array(reviewSchema).max(256) });
export type OriginPolicyInput = z.infer<typeof inputSchema>;
/** Pure origin findings calculator; it never manufactures Ethereum history coordinates. */
export function calculateOriginPolicy(input: unknown) {
  const parsed = inputSchema.parse(input);
  const policy = parsed.policy;
  policy.groups.sort((a, b) => compare(a.key, b.key)).forEach((g) => g.reviewers.sort(compare));
  policy.reviewers.sort(compare);
  // First exact document occurrence wins: repeated documents cannot refresh order or age.
  const distinct = new Map<string, OriginPolicyInput['reviews'][number]>();
  const ordinals = new Map<number, string>();
  const descriptor = (review: OriginPolicyInput['reviews'][number]) => { const { ordinal: _ordinal, ...findings } = review; return JSON.stringify(findings); };
  for (const review of [...parsed.reviews].sort((a, b) => a.ordinal - b.ordinal)) {
    const previous = distinct.get(review.id);
    if (previous && descriptor(previous) !== descriptor(review)) throw new Error('contradictory duplicate origin findings');
    if (ordinals.has(review.ordinal) && ordinals.get(review.ordinal) !== review.id) throw new Error('ambiguous snapshot ordinal');
    ordinals.set(review.ordinal, review.id);
    if (!previous) distinct.set(review.id, review);
  }
  const reviews = [...distinct.values()].map((r) => ({ ...r, reason: 'contributing' }));
  const accepted = reviews.filter((r) => {
    if (!policy.reviewers.includes(r.reviewer)) { r.reason = 'reviewer-not-accepted'; return false; }
    if (r.signature !== 'valid') { r.reason = 'invalid-signature'; return false; }
    return true;
  });
  const latest = selectLatestByPair(accepted, (a, b) => a.ordinal - b.ordinal,
    (r) => JSON.stringify([r.reviewer, r.interaction]));
  latest.superseded.forEach((r) => { r.reason = 'superseded'; });
  let unresolved = parsed.coverage !== 'complete';
  const eligible = latest.selected.filter((r) => {
    if (r.interactionLinks !== 'matched' || r.chronology !== 'consistent' || r.resultKind === 'unknown') {
      r.reason = 'unresolved-evidence'; unresolved = true; return false;
    }
    if (r.retracted) { r.reason = 'retracted'; return false; }
    const age = (Date.parse(parsed.observedAt) - Date.parse(r.createdAt)) / 1000;
    if (age < 0) { r.reason = 'future-record'; unresolved = true; return false; }
    if (age > WINDOW_SECONDS) { r.reason = 'aged-out'; return false; }
    return true;
  });
  const scored = scoreGroups(eligible, policy.groups, (a, b) => a.ordinal - b.ordinal, (r) => { r.reason = 'sample-cap'; });
  const qualified = !unresolved && parsed.authority === 'observed' && parsed.active;
  return { algorithm: 'city-origin-usefulness@0.1' as const, service: parsed.service, policy,
    qualification: qualified ? 'archive-snapshot-qualified' as const : 'unresolved' as const,
    timeBasis: 'reviewer-claimed-record-time' as const, orderBasis: 'authenticated-selected-snapshot-ordinal' as const,
    historicalAuthority: 'not-independently-proven' as const,
    score: qualified ? scored.score : null, provisionalScore: qualified ? null : scored.score,
    groups: scored.groups, groupCount: scored.groups.length, interactionCount: scored.interactionCount, reviews,
    recommended: qualified && policy.curatorIncluded && scored.score !== null };
}
