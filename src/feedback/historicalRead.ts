import { isAddress, zeroAddress, type Hex, type PublicClient } from 'viem';
import { readIdentityFeedbackEpoch, type IdentityContinuityDomain, type IdentityFeedbackEpoch } from '../identity/continuity.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type VerifiedProfile } from '../identity/verify.js';
import { decodeFeedbackDocument, type FeedbackDocument } from './document.js';
import { readFeedbackPublication, type FeedbackPublicationObservation, type ReadFeedbackPublicationInput } from './publication.js';
import { commitSupportingBundle, decodeSupportingBundle, SupportingBundleError, type SupportingBundle, type SupportingBundleDiagnostic } from './supportingBundle.js';
import { verifyHistoricalFeedback, type HistoricalFeedbackFinding } from './verify.js';

export type ReadHistoricalFeedbackInput = ReadFeedbackPublicationInput & { bundleBytes: Uint8Array | null };

type PublicBasis = { blockNumber: string; blockHash: Hex };
export type FeedbackCarryForwardObservation = {
  historical: HistoricalFeedbackObservation;
  epoch: IdentityFeedbackEpoch | null;
  bundleCommitment: 'matched' | 'mismatched' | 'unavailable' | 'uncommitted';
  carryForward: {
    status: 'qualified' | 'ineligible' | 'unknown';
    qualification: 'rpc-derived-not-state-proof';
    reasons: ('legacy-uncommitted' | 'bundle-unavailable' | 'bundle-commitment-mismatch' | 'domain-mismatch' |
      'historical-evidence-unqualified' | 'publication-unqualified' | 'epoch-unknown' | 'ownership-transferred' |
      'deauthorization-observed' | 'runtime-not-retired' | 'publication-not-before-retirement' |
      'basis-order-invalid' | 'basis-recheck-failed' | 'committed-before-runtime-retirement')[];
    basis?: { documentDigest: Hex; bundleDigest: Hex; original: PublicBasis; publication: PublicBasis;
      retirement: PublicBasis; observation: PublicBasis };
  };
};

export type ReadFeedbackCarryForwardInput = ReadHistoricalFeedbackInput & {
  identityDomain: IdentityContinuityDomain;
  limits: { maxBlocks: number; maxLogs: number };
  signal?: AbortSignal;
};
type NotEvaluatedReason = 'bundle-absent' | 'bundle-incomplete' | 'bundle-malformed' |
  'document-unavailable' | 'document-malformed';
type AuthorityDiagnostic = NotEvaluatedReason | 'request-domain-mismatch' | 'feedback-domain-mismatch' |
  'profile-agent-id-unsupported' | 'chain-id-mismatch' | 'chain-unavailable' |
  'genesis-unavailable' | 'genesis-hash-mismatch' | 'original-basis-unavailable' |
  'original-basis-mismatch' | 'original-snapshot-unavailable' | 'original-profile-mismatch' |
  'original-basis-changed' | 'original-recheck-unavailable';

export type HistoricalFeedbackObservation = {
  bundle: {
    availability: 'available' | 'absent' | 'incomplete' | 'malformed';
    diagnostics: (SupportingBundleDiagnostic | 'bundle-absent')[];
  };
  originalAuthority: {
    status: 'matched' | 'mismatched' | 'unavailable';
    qualification: 'rpc-derived-not-state-proof';
    /** Declared by the signed request, not independently authoritative. */
    requestedBasis?: { blockNumber: string; blockHash: `0x${string}` };
    /** Numbered snapshot obtained from the configured RPC, not current authority. */
    basis?: { blockNumber: string; blockHash: `0x${string}`; blockTimestamp: string };
    diagnostics: AuthorityDiagnostic[];
  };
  publication: FeedbackPublicationObservation;
  historical: { status: 'evaluated'; findings: HistoricalFeedbackFinding } |
    { status: 'not-evaluated'; reason: NotEvaluatedReason };
  answerEvidence: 'not-supplied';
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Read-only composition over separately retained public and private bytes. No
 * provider, URI fetch, latest authority, deadline clock, answer or Index is used.
 * Configure bounded RPC responses/timeouts and no retries on the supplied client.
 * Components have separate RPC-derived qualifications, not an atomic chain view.
 */
export async function readHistoricalFeedback(input: ReadHistoricalFeedbackInput): Promise<HistoricalFeedbackObservation> {
  const { client, observationBlock } = input;
  const domain = { ...input.domain };
  // Fail caller configuration explicitly before attempting original authority.
  // The existing publication reader additionally validates all event coordinates.
  if (typeof observationBlock !== 'bigint' || observationBlock < 0n || observationBlock >= 1n << 256n) {
    throw new Error('observationBlock must be an explicit nonnegative numbered block');
  }
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 ||
    typeof domain.genesisHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(domain.genesisHash) ||
    ![domain.identityRegistry, domain.reputationRegistry].every((address) => isAddress(address) && !same(address, zeroAddress))) {
    throw new Error('invalid feedback publication domain');
  }
  const eventRef = { ...input.eventRef };
  // Copy before the first await so caller mutation cannot change either decoding.
  const documentBytes = input.documentBytes instanceof Uint8Array ? new Uint8Array(input.documentBytes) : input.documentBytes;
  const bundleBytes = input.bundleBytes instanceof Uint8Array ? new Uint8Array(input.bundleBytes) : input.bundleBytes;
  let bundle: SupportingBundle | undefined;
  let document: FeedbackDocument | undefined;
  const bundleFinding: HistoricalFeedbackObservation['bundle'] = { availability: 'absent', diagnostics: ['bundle-absent'] };
  let reason: NotEvaluatedReason | undefined;
  if (bundleBytes === null) reason = 'bundle-absent';
  else {
    try {
      bundle = decodeSupportingBundle(bundleBytes);
      bundleFinding.availability = 'available'; bundleFinding.diagnostics = [];
    } catch (error) {
      reason = error instanceof SupportingBundleError ? error.code : 'bundle-malformed';
      bundleFinding.availability = reason === 'bundle-incomplete' ? 'incomplete' : 'malformed';
      bundleFinding.diagnostics = [error instanceof SupportingBundleError ? error.diagnostic : 'bundle-shape-invalid'];
    }
  }
  if (documentBytes === null) reason ??= 'document-unavailable';
  else {
    try { document = decodeFeedbackDocument(documentBytes); }
    catch { reason ??= 'document-malformed'; }
  }

  const authority: HistoricalFeedbackObservation['originalAuthority'] = {
    status: 'unavailable', qualification: 'rpc-derived-not-state-proof', diagnostics: [],
    ...(bundle ? { requestedBasis: { blockNumber: bundle.request.statement.value.profileBasis.blockNumber,
      blockHash: bundle.request.statement.value.profileBasis.blockHash as `0x${string}` } } : {}),
  };
  const note = (status: typeof authority.status, code: AuthorityDiagnostic) => {
    authority.status = status;
    if (!authority.diagnostics.includes(code)) authority.diagnostics.push(code);
  };
  let profile: VerifiedProfile | null = null;
  let checkedOriginalBasis = false;
  if (reason) note('unavailable', reason);

  if (bundle && document) {
    const request = bundle.request.statement.value;
    const agent = { ...request.service.agent, registry: request.service.agent.registry as `0x${string}` };
    const feedbackAgent = document.feedback.value.service.agent;
    // Do not query a subject selected by untrusted request/document metadata until
    // BOTH service domains match the caller-selected Identity Registry and chain.
    const requestDomain = agent.chainId === domain.chainId && same(agent.registry, domain.identityRegistry);
    const feedbackDomain = feedbackAgent.chainId === domain.chainId && same(feedbackAgent.registry, domain.identityRegistry);
    if (!requestDomain) note('mismatched', 'request-domain-mismatch');
    if (!feedbackDomain) note('mismatched', 'feedback-domain-mismatch');
    if (requestDomain && feedbackDomain) {
      if (BigInt(agent.agentId) > BigInt(Number.MAX_SAFE_INTEGER)) note('unavailable', 'profile-agent-id-unsupported');
      else {
        let phase: AuthorityDiagnostic = 'chain-unavailable';
        let contradictoryBasis = false;
        try {
          const readOriginal = async (): Promise<void> => {
            if (await client.getChainId() !== domain.chainId) { note('mismatched', 'chain-id-mismatch'); return; }
            phase = 'genesis-unavailable';
            const genesis = await client.getBlock({ blockNumber: 0n });
            if (genesis.number !== 0n || !genesis.hash) { note('unavailable', phase); return; }
            if (!same(genesis.hash, domain.genesisHash)) { note('mismatched', 'genesis-hash-mismatch'); return; }
            const basis = request.profileBasis;
            const number = BigInt(basis.blockNumber);
            phase = 'original-basis-unavailable';
            const selected = await client.getBlock({ blockNumber: number });
            if (!selected.hash || selected.number === null) { note('unavailable', phase); return; }
            if (selected.number !== number || !same(selected.hash, basis.blockHash)) {
              note('mismatched', 'original-basis-mismatch'); return;
            }
            phase = 'original-snapshot-unavailable';
            // The shared snapshot reader uses the number returned by getBlock.
            // Guard each header before it can redirect a subject read to another
            // number, without changing that reader's existing public semantics.
            const snapshotClient = { ...client, getBlock: (async (parameters) => {
              const block = await client.getBlock(parameters);
              if (block.number === null || !block.hash) throw new Error('original block unavailable');
              if (block.number !== number || !same(block.hash, basis.blockHash)) {
                contradictoryBasis = true;
                throw new Error('original basis mismatch');
              }
              return block;
            }) as PublicClient['getBlock'] };
            const snapshot = await readIdentitySnapshot(snapshotClient, agent, number);
            // The underlying snapshot reader guards internal consistency; also
            // compare its returned number AND hash to the exact signed request.
            if (snapshot.blockNumber !== basis.blockNumber || !same(snapshot.blockHash, basis.blockHash)) {
              note('mismatched', 'original-basis-mismatch'); return;
            }
            checkedOriginalBasis = true;
            authority.basis = { blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash,
              blockTimestamp: snapshot.blockTimestamp.toString() };
            try {
              profile = verifyProfile({ agent, agentURI: snapshot.agentURI, cardBytes: bundle.cardBytes }, snapshot);
            } catch { note('mismatched', 'original-profile-mismatch'); }
          };
          await readOriginal();
        } catch {
          note(contradictoryBasis ? 'mismatched' : 'unavailable', contradictoryBasis ? 'original-basis-mismatch' : phase);
        }
      }
    }
  }

  const evaluate = () => verifyHistoricalFeedback({ feedback: document!.envelope,
    request: bundle!.request.envelope, acceptance: bundle!.acceptance.envelope,
    ...(bundle!.completion ? { completion: bundle!.completion.envelope } : {}),
    basisProfile: profile, expectedReputationRegistry: { chainId: domain.chainId, address: domain.reputationRegistry } });
  let historical: HistoricalFeedbackObservation['historical'];
  if (bundle && document) {
    let findings = await evaluate();
    if (profile) {
      if (findings.originalProfileBasis === 'matched') authority.status = 'matched';
      else {
        note('mismatched', 'original-profile-mismatch');
        profile = null;
        findings = await evaluate();
      }
    }
    historical = { status: 'evaluated', findings };
  } else historical = { status: 'not-evaluated', reason: reason! };

  // Publication observation is returned verbatim and cannot suppress signed
  // history, including when revoked, orphaned or unavailable.
  const publication = await readFeedbackPublication({ client, domain, eventRef, observationBlock, documentBytes });

  if (checkedOriginalBasis && bundle) {
    const basis = bundle.request.statement.value.profileBasis;
    let downgraded = false;
    try {
      const checked = await client.getBlock({ blockNumber: BigInt(basis.blockNumber) });
      if (checked.number?.toString() !== basis.blockNumber || !checked.hash || !same(checked.hash, basis.blockHash)) {
        note('mismatched', 'original-basis-changed'); downgraded = true;
      }
    } catch { note('unavailable', 'original-recheck-unavailable'); downgraded = true; }
    if (downgraded) {
      profile = null;
      historical = { status: 'evaluated', findings: await evaluate() };
    }
  }
  return { bundle: bundleFinding, originalAuthority: authority, publication, historical, answerEvidence: 'not-supplied' };
}

/** Exact byte commitment before runtime retirement, not service-use or compromise time.
 * The caller supplies a bounded transport (ranking lends its existing aggregate budget).
 * All conclusions are re-derived from raw evidence; no supplied qualification is accepted.
 */
export async function readFeedbackCarryForward(input: ReadFeedbackCarryForwardInput): Promise<FeedbackCarryForwardObservation> {
  const copied = { ...input, domain: { ...input.domain }, identityDomain: { ...input.identityDomain,
    knownImplementation: { ...input.identityDomain.knownImplementation } }, limits: { ...input.limits },
    eventRef: { ...input.eventRef }, documentBytes: input.documentBytes && new Uint8Array(input.documentBytes),
    bundleBytes: input.bundleBytes && new Uint8Array(input.bundleBytes) };
  // Cancellation is checked around every awaited RPC, including inside reused readers.
  const methods = new Set(['getChainId', 'getBlock', 'getTransactionReceipt', 'readContract', 'getStorageAt', 'getCode', 'request']);
  const client = new Proxy(input.client, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof key !== 'string' || !methods.has(key) || typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      copied.signal?.throwIfAborted();
      const result: unknown = await Reflect.apply(value, target, args);
      copied.signal?.throwIfAborted();
      return result;
    };
  } });
  const historical = await readHistoricalFeedback({ ...copied, client });
  const result: FeedbackCarryForwardObservation = { historical, epoch: null, bundleCommitment: 'unavailable',
    carryForward: { status: 'unknown', qualification: 'rpc-derived-not-state-proof', reasons: [] } };
  const conclude = (status: FeedbackCarryForwardObservation['carryForward']['status'],
    reason: FeedbackCarryForwardObservation['carryForward']['reasons'][number]) => {
    result.carryForward.status = status; result.carryForward.reasons = [reason]; return result;
  };
  let bundle: ReturnType<typeof commitSupportingBundle> | undefined;
  let document: FeedbackDocument | undefined;
  try { if (copied.bundleBytes) bundle = commitSupportingBundle(copied.bundleBytes); } catch { /* controlled finding below */ }
  try { if (copied.documentBytes) document = decodeFeedbackDocument(copied.documentBytes); } catch { /* same */ }
  if (document?.feedback.value.version === '0.1') result.bundleCommitment = 'uncommitted';
  else if (document && bundle) result.bundleCommitment = document.feedback.value.supportingBundleDigest === bundle.digest
    ? 'matched' : 'mismatched';
  if (!bundle || !document) return conclude('unknown', 'bundle-unavailable');
  const request = bundle.request.statement.value;
  const identity = copied.identityDomain, domain = copied.domain;
  if (identity.chainId !== domain.chainId || !same(identity.registry, domain.identityRegistry) ||
      !same(identity.genesisHash, domain.genesisHash) || request.service.agent.chainId !== domain.chainId ||
      !same(request.service.agent.registry, identity.registry)) return conclude('ineligible', 'domain-mismatch');
  const observation = historical.publication.observation;
  if (!observation) return conclude('unknown', 'publication-unqualified');
  result.epoch = await readIdentityFeedbackEpoch(client, { domain: identity,
    agent: { ...request.service.agent, registry: request.service.agent.registry as Hex },
    basis: { blockNumber: BigInt(request.profileBasis.blockNumber), blockHash: request.profileBasis.blockHash as Hex },
    observation: { blockNumber: copied.observationBlock, blockHash: observation.blockHash },
    limits: copied.limits, ...(copied.signal ? { signal: copied.signal } : {}) });
  const epoch = result.epoch;
  if (result.bundleCommitment === 'uncommitted') return conclude('ineligible', 'legacy-uncommitted');
  if (result.bundleCommitment !== 'matched') return conclude('ineligible', 'bundle-commitment-mismatch');
  const findings = historical.historical.status === 'evaluated' ? historical.historical.findings : null;
  if (historical.originalAuthority.status !== 'matched' || !findings ||
      [findings.feedbackSignature, findings.requestSignature, findings.acceptanceSignature].some((value) => value !== 'valid') ||
      [findings.reviewerBinding, findings.requestCallerBinding, findings.serviceLink, findings.registryDomain,
        findings.requestLink, findings.acceptanceLink, findings.originalProfileBasis, findings.acceptanceSignerBinding]
        .some((value) => value !== 'matched') || findings.claimedTime !== 'consistent' ||
      !['matched', 'post-deadline-reviewer-claim'].includes(findings.resultEvidence) ||
      ((bundle.completion || document.feedback.value.result.kind === 'completion') && (findings.completionSignature !== 'valid' ||
        findings.completionLink !== 'matched' || findings.completionSignerBinding !== 'matched'))) {
    return conclude('unknown', 'historical-evidence-unqualified');
  }
  const publication = historical.publication;
  if (publication.publication !== 'matched' || !publication.source || publication.claimedFeedbackTime !== 'not-after-publication') {
    return conclude('unknown', 'publication-unqualified');
  }
  if (epoch.epoch === 'unknown' || epoch.ownerEpoch === 'unknown' || epoch.deauthorization === 'unknown') {
    return conclude('unknown', 'epoch-unknown');
  }
  const retirement = epoch.firstRuntimeRetirement;
  const original = { blockNumber: request.profileBasis.blockNumber, blockHash: request.profileBasis.blockHash as Hex };
  try {
    const bases = new Map<string, Hex>();
    for (const basis of [original, publication.source, observation, ...(retirement ? [retirement] : []),
      ...(epoch.eventBases ?? []), { blockNumber: '0', blockHash: domain.genesisHash }]) {
      const prior = bases.get(basis.blockNumber);
      if (prior && !same(prior, basis.blockHash)) throw new Error();
      bases.set(basis.blockNumber, basis.blockHash);
    }
    for (const [number, hash] of bases) {
      const block = await client.getBlock({ blockNumber: BigInt(number) });
      if (block.number?.toString() !== number || !block.hash || !same(block.hash, hash)) throw new Error();
    }
  } catch {
    result.epoch = { ...epoch, epoch: 'unknown', ownerEpoch: 'unknown', deauthorization: 'unknown',
      diagnostics: [...epoch.diagnostics, 'composition-basis-recheck-failed'] };
    return conclude('unknown', 'basis-recheck-failed');
  }
  if (epoch.ownerEpoch === 'transferred') return conclude('ineligible', 'ownership-transferred');
  if (epoch.deauthorization === 'observed') return conclude('ineligible', 'deauthorization-observed');
  if (!retirement) return conclude('ineligible', 'runtime-not-retired');
  if (BigInt(publication.source.blockNumber) >= BigInt(retirement.blockNumber)) {
    return conclude('ineligible', 'publication-not-before-retirement');
  }
  if (BigInt(request.profileBasis.blockNumber) > BigInt(publication.source.blockNumber) ||
      BigInt(retirement.blockNumber) > copied.observationBlock) return conclude('ineligible', 'basis-order-invalid');
  const publicBasis = ({ blockNumber, blockHash }: PublicBasis): PublicBasis => ({ blockNumber, blockHash });
  result.carryForward.basis = { documentDigest: document.documentHash, bundleDigest: bundle.digest,
    original, publication: publicBasis(publication.source), retirement: publicBasis(retirement), observation: publicBasis(observation) };
  return conclude('qualified', 'committed-before-runtime-retirement');
}
