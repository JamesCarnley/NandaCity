import { decodeCard, digestBytes } from '../identity/profile.js';
import { isUtcSecond } from '../interaction/schema.js';
import { decodeOriginDocument, type OriginDocument } from '../origin/bytes.js';
import { readOriginArchive, type OriginArchive } from '../origin/archive.js';
import { observeOriginProfile, type OriginReadOptions } from '../origin/profile.js';
import { decodeOriginSupportingBundle } from '../origin/supportingBundle.js';
import { verifyOriginSignature } from '../origin/signatures.js';
import { originUrlSchema, type OriginFeedback, type OriginProfile, type OriginRequest,
  type OriginAcceptance, type OriginCompletion, type OriginSnapshot, type OriginRetraction } from '../origin/schema.js';
import { calculateOriginPolicy, originConsumerPolicySchema, type OriginConsumerPolicy, type OriginPolicyInput } from './originPolicy.js';

export type OriginEvidenceOptions = OriginReadOptions & { identityUrl: string; observedAt: string;
  policy: OriginConsumerPolicy; bundle: Uint8Array; archive: OriginArchive };
type Event = OriginDocument<OriginFeedback | OriginRetraction>;
const seconds = (time: string) => Date.parse(time) / 1000;
async function authentic(document: OriginDocument, identityUrl: string): Promise<boolean> {
  return (await verifyOriginSignature(document.envelope, identityUrl, document.statement.value.kind)).status === 'valid';
}
function pinned(bytes: Uint8Array | null, digest: string): OriginDocument | null {
  try { if (!bytes || digestBytes(bytes) !== digest) return null; return decodeOriginDocument(bytes); } catch { return null; }
}
/** Re-derive signatures, private links, current TLS authority and snapshot scope; no Index qualification is trusted. */
export async function verifyOriginEvidence(options: OriginEvidenceOptions) {
  const identityUrl = originUrlSchema.parse(options.identityUrl), policy = originConsumerPolicySchema.parse(options.policy);
  if (!isUtcSecond(options.observedAt)) throw new Error('invalid origin observation time');
  const archive = options.archive;
  if (archive.documents.length > 512 || archive.variants.length > 32) throw new Error('origin evidence exceeds archive bounds');
  const privateBytes = decodeOriginSupportingBundle(options.bundle);
  const basis = decodeOriginDocument(privateBytes.profile) as OriginDocument<OriginProfile>;
  const request = decodeOriginDocument(privateBytes.request) as OriginDocument<OriginRequest>;
  const acceptance = decodeOriginDocument(privateBytes.acceptance) as OriginDocument<OriginAcceptance>;
  const completion = privateBytes.completion ? decodeOriginDocument(privateBytes.completion) as OriginDocument<OriginCompletion> : null;
  const profile = basis.statement.value, req = request.statement.value, acc = acceptance.statement.value;
  const card = decodeCard(privateBytes.card);
  const signatures = { profile: await authentic(basis, identityUrl), request: await authentic(request, identityUrl),
    acceptance: await authentic(acceptance, identityUrl), completion: completion ? await authentic(completion, identityUrl) : null };
  const baseLinks = signatures.profile && signatures.request && signatures.acceptance &&
    profile.active && profile.city === 'Chicago' && req.input.city === profile.city &&
    req.profileBasis.profileDigest === basis.documentDigest && req.profileBasis.cardDigest === profile.cardDigest &&
    digestBytes(privateBytes.card) === profile.cardDigest && card.url === profile.endpoint &&
    card.skills.some((s) => s.id === profile.capability) && card.defaultInputModes.includes('application/json') &&
    card.defaultOutputModes.includes('application/json') && acceptance.envelope.signer.address === profile.runtimeKey.address &&
    acc.requestDigest === request.statement.digest && acc.deadline === req.deadline;
  const current = await observeOriginProfile({ ...options, now: () => options.observedAt, includeCard: false });
  const authority: 'observed' | 'unknown' | 'changed' = current.current === 'unknown' ? 'unknown' :
    !signatures.profile || current.profile.statement.value.controllerKey.address !== profile.controllerKey.address ||
    current.profile.statement.value.runtimeKey.address !== profile.runtimeKey.address ? 'changed' : 'observed';
  const active = current.current === 'observed' && current.profile.statement.value.active && current.profile.statement.value.city === 'Chicago';
  let coverage: OriginPolicyInput['coverage'] = 'complete';
  const warnings = ['reviewer-declared-sample-not-global-history', 'never-observed-withheld-reviews-undetectable',
    'claimed-times-not-independent-publication-proof', 'unseen-away-and-back-key-changes-undetectable'];
  const incomplete = () => { if (coverage === 'complete') coverage = 'partial'; };
  let snapshot: OriginDocument<OriginSnapshot> | null = null;
  const rawSelected = pinned(archive.snapshot, archive.snapshotDigest);
  if (rawSelected?.statement.value.kind === 'archive-snapshot' && await authentic(rawSelected, identityUrl)) snapshot = rawSelected as OriginDocument<OriginSnapshot>;
  if (!snapshot) coverage = 'unavailable';
  const reviews: OriginPolicyInput['reviews'] = [];
  const retractions: { documentDigest: string; target: string; status: 'applied' | 'invalid' }[] = [];
  const variants: { digest: string; status: 'compatible' | 'incompatible' | 'unauthenticated' | 'unavailable' | 'later-history' }[] = [];
  if (snapshot) {
    const selected = snapshot.statement.value;
    if (!archive.historyAvailable || archive.variantsTruncated || !archive.variants.some((v) => v.digest === snapshot!.documentDigest)) incomplete();
    if (policy.reviewers.length !== 1 || !policy.reviewers.includes(selected.reviewer) || seconds(selected.createdAt) > seconds(options.observedAt)) incomplete();
    for (const variant of archive.variants) {
      const decoded = pinned(variant.bytes, variant.digest);
      if (!variant.bytes || digestBytes(variant.bytes) !== variant.digest) { variants.push({ digest: variant.digest, status: 'unavailable' }); incomplete(); continue; }
      if (!decoded || decoded.statement.value.kind !== 'archive-snapshot' || !await authentic(decoded, identityUrl)) {
        variants.push({ digest: variant.digest, status: 'unauthenticated' }); continue;
      }
      const value = decoded.statement.value;
      if (value.reviewer !== selected.reviewer) { variants.push({ digest: variant.digest, status: 'unauthenticated' }); continue; }
      const prefix = (a: string[], b: string[]) => a.every((entry, i) => b[i] === entry);
      if (!prefix(value.entries, selected.entries) && !prefix(selected.entries, value.entries)) {
        variants.push({ digest: variant.digest, status: 'incompatible' }); coverage = 'conflict';
      } else if (value.entries.length > selected.entries.length) {
        variants.push({ digest: variant.digest, status: 'later-history' }); incomplete();
      } else variants.push({ digest: variant.digest, status: 'compatible' });
    }
    const events = new Map<string, { document: Event; ordinal: number }>();
    let previousTime = -Infinity;
    for (const [ordinal, digest] of selected.entries.entries()) {
      const copies = archive.documents.filter((entry) => entry.digest === digest);
      // Every supplied copy must match its address; extra duplicates cannot hide corruption.
      const document = copies.length && copies.every((entry) => entry.bytes && digestBytes(entry.bytes) === digest) ? pinned(copies[0]!.bytes, digest) : null;
      if (!document || !['feedback', 'retraction'].includes(document.statement.value.kind)) { incomplete(); continue; }
      const event = document as Event, value = event.statement.value;
      const signature = await authentic(event, identityUrl);
      if (!signature || value.reviewer.address !== selected.reviewer) { incomplete(); continue; }
      const recordTime = seconds(value.createdAt);
      const consistent = recordTime >= previousTime && recordTime <= seconds(selected.createdAt) && recordTime <= seconds(options.observedAt);
      previousTime = recordTime;
      if (!consistent) incomplete();
      if (value.kind === 'retraction') {
        const target = events.get(value.feedbackDocumentDigest);
        const valid = consistent && target?.document.statement.value.kind === 'feedback' &&
          target.document.statement.value.interactionId === value.interactionId && target.ordinal < ordinal &&
          seconds(target.document.statement.value.createdAt) <= recordTime;
        retractions.push({ documentDigest: digest, target: value.feedbackDocumentDigest, status: valid ? 'applied' : 'invalid' });
        if (!valid) incomplete(); else reviews.find((r) => r.id === value.feedbackDocumentDigest)!.retracted = true;
      } else {
        let links = baseLinks && value.requestDigest === request.statement.digest && value.acceptanceDigest === acceptance.statement.digest &&
          value.interactionId === req.interactionId && value.reviewer.address === req.caller.address;
        let chronology = consistent && seconds(req.createdAt) <= seconds(acc.acceptedAt) && seconds(acc.acceptedAt) <= seconds(req.deadline) &&
          seconds(acc.acceptedAt) <= recordTime;
        if (value.result.kind === 'completion') {
          links = links && !!completion && signatures.completion === true && completion.envelope.signer.address === profile.runtimeKey.address &&
            value.result.completionDigest === completion.statement.digest && completion.statement.value.acceptanceDigest === acceptance.statement.digest;
          chronology = chronology && !!completion && seconds(acc.acceptedAt) <= seconds(completion.statement.value.recordedAt) &&
            (completion.statement.value.outcome === 'expired' ? seconds(completion.statement.value.recordedAt) >= seconds(req.deadline) :
              seconds(completion.statement.value.recordedAt) <= seconds(req.deadline)) && seconds(completion.statement.value.recordedAt) <= recordTime;
        } else chronology = chronology && seconds(value.result.observedAt) >= seconds(req.deadline) && seconds(value.result.observedAt) <= recordTime;
        if (!links || !chronology) incomplete();
        reviews.push({ id: digest, reviewer: value.reviewer.address, interaction: value.interactionId, rating: value.value, ordinal,
          createdAt: value.createdAt, signature: 'valid', interactionLinks: links ? 'matched' : 'mismatched',
          resultKind: !links ? 'unknown' : value.result.kind === 'no-result-observed' ? 'post-deadline-reviewer-claim' :
            completion?.statement.value.outcome === 'completed' ? 'signed-completion' : 'signed-failure',
          chronology: chronology ? 'consistent' : 'inconsistent', retracted: false });
      }
      events.set(digest, { document: event, ordinal });
    }
  }
  const result = calculateOriginPolicy({ service: identityUrl, observedAt: options.observedAt,
    authority, active, coverage, policy, reviews });
  return { originAuthority: { current: authority, observedAt: options.observedAt,
    profileDigest: current.current === 'observed' ? current.profile.documentDigest : null },
    historicalAuthority: 'not-independently-proven' as const, snapshotDigest: archive.snapshotDigest,
    snapshotSignature: snapshot ? 'valid' as const : 'invalid-or-unavailable' as const,
    coverage, retrieval: { selected: archive.snapshot ? 'retained' : 'unavailable',
      retainedDocuments: archive.documents.filter((d) => d.bytes).length, historyAvailable: archive.historyAvailable,
      variantsTruncated: archive.variantsTruncated },
    signatures, reviews, retractions, variants, policy: result, warnings,
    town: 'unsupported-not-tested' as const, semanticReplay: 'not-performed' as const };
}
export async function readOriginEvidence(options: Omit<OriginEvidenceOptions, 'archive'> & { indexOrigin: string; snapshotDigest: string }) {
  return verifyOriginEvidence({ ...options, archive: await readOriginArchive(options) });
}
