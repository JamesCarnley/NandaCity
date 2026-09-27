/** Private method-neutral weights and ordering. Authority qualification stays in each profile. */
export type Rational = { numerator: string; denominator: string };
type Fraction = { n: bigint; d: bigint };
export const WINDOW_SECONDS = 90 * 86400;
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function fraction(n: bigint, d: bigint): Fraction {
  let a = n < 0n ? -n : n, b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { n: n / a, d: d / a };
}
const add = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const mean = (values: Fraction[]): Fraction => { const sum = values.reduce(add, { n: 0n, d: 1n }); return fraction(sum.n, sum.d * BigInt(values.length)); };
const rational = (value: Fraction): Rational => ({ numerator: String(value.n), denominator: String(value.d) });
export function selectLatestByPair<T>(entries: readonly T[], order: (a: T, b: T) => number,
  pair: (value: T) => string): { selected: T[]; superseded: T[] } {
  const seen = new Set<string>(); const selected: T[] = [], superseded: T[] = [];
  for (const entry of [...entries].sort((a, b) => -order(a, b))) {
    const identity = pair(entry);
    if (seen.has(identity)) superseded.push(entry); else { seen.add(identity); selected.push(entry); }
  }
  return { selected, superseded };
}
export function scoreGroups<T extends { id: string; reviewer: string | null; rating: number | null }>(
  eligible: readonly T[], controls: readonly { key: string; reviewers: string[] }[], order: (a: T, b: T) => number,
  capped: (entry: T) => void) {
  const groups: { key: string; mean: Rational; reviewers: { key: string; mean: Rational; evidence: string[] }[] }[] = [];
  const groupMeans: Fraction[] = []; let interactionCount = 0;
  for (const group of controls) {
    const reviewers: typeof groups[number]['reviewers'] = [], reviewerMeans: Fraction[] = [];
    for (const reviewer of group.reviewers) {
      const selected = eligible.filter((review) => review.reviewer === reviewer).sort((a, b) => -order(a, b));
      selected.slice(3).forEach(capped); const sample = selected.slice(0, 3); if (!sample.length) continue;
      const value = mean(sample.map((review) => ({ n: BigInt(review.rating!), d: 1n })));
      reviewerMeans.push(value); reviewers.push({ key: reviewer, mean: rational(value), evidence: sample.map((r) => r.id).sort(compare) });
      interactionCount += sample.length;
    }
    if (!reviewers.length) continue;
    const value = mean(reviewerMeans); groupMeans.push(value); groups.push({ key: group.key, mean: rational(value), reviewers });
  }
  const sum = groupMeans.reduce(add, { n: 6n, d: 1n });
  return { groups, interactionCount,
    score: groups.length ? rational(fraction(sum.n, sum.d * BigInt(2 + groups.length))) : null };
}
