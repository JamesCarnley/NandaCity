import { isAddress, zeroAddress, type PublicClient } from 'viem';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type VerifiedProfile } from '../identity/verify.js';
import { decodeFeedbackDocument, type FeedbackDocument } from './document.js';
import { readFeedbackPublication, type FeedbackPublicationObservation, type ReadFeedbackPublicationInput } from './publication.js';
import { decodeSupportingBundle, SupportingBundleError, type SupportingBundle, type SupportingBundleDiagnostic } from './supportingBundle.js';
import { verifyHistoricalFeedback, type HistoricalFeedbackFinding } from './verify.js';

export type ReadHistoricalFeedbackInput = ReadFeedbackPublicationInput & { bundleBytes: Uint8Array | null };
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
