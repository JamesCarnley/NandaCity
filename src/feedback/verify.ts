import type { VerifiedProfile } from '../identity/verify.js';
import { decodeEnvelope, verifyEnvelopeSignature, type CryptoFinding } from '../interaction/signatures.js';
import type { CityAcceptance, CityCompletion, CityRequest } from '../interaction/schema.js';
import { decodeFeedbackEnvelope, verifyFeedbackSignature } from './signatures.js';

type Match = 'matched' | 'mismatched';
type AvailabilityMatch = Match | 'unavailable';
type Signature = CryptoFinding['status'];

export type HistoricalFeedbackFinding = {
  feedbackSignature: Signature;
  requestSignature: Signature;
  acceptanceSignature: Signature | 'missing';
  completionSignature: Signature | 'not-present';
  completionLink: Match | 'unavailable' | 'not-present';
  /** Links a supplied completion signer to the request-declared receiptSigner only. */
  completionSignerBinding: Match | 'not-present';
  completionClaimedOutcome: CityCompletion['outcome'] | 'not-present';
  reviewerBinding: Match;
  requestCallerBinding: Match;
  serviceLink: Match;
  registryDomain: Match;
  requestLink: Match;
  acceptanceLink: Match | 'missing';
  originalProfileBasis: AvailabilityMatch;
  /** Links acceptance signer to the request-declared receiptSigner; original authority is reported separately. */
  acceptanceSignerBinding: AvailabilityMatch;
  claimedTime: 'consistent' | 'inconsistent' | 'unavailable';
  resultEvidence: 'matched' | 'mismatched' | 'unavailable' | 'post-deadline-reviewer-claim' | 'too-early-claim';
  historicalExistence: 'unknown';
  historicalOrdering: 'unknown';
  publication: 'not-evaluated';
  revocation: 'not-evaluated';
};

type RegistryDomain = { chainId: number; address: `0x${string}` };

type Input = {
  feedback: unknown;
  request: unknown;
  acceptance?: unknown;
  completion?: unknown;
  basisProfile: VerifiedProfile | null;
  expectedReputationRegistry: RegistryDomain;
};

const equalHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function sameAgent(a: CityRequest['service']['agent'], b: CityRequest['service']['agent']): boolean {
  return a.chainId === b.chainId && equalHex(a.registry, b.registry) && a.agentId === b.agentId;
}

function originalBasis(profile: VerifiedProfile | null, request: CityRequest): AvailabilityMatch {
  if (!profile) return 'unavailable';
  const basis = request.profileBasis;
  const source = profile.source;
  const extension = profile.registration['x-nandacity'];
  return profile.registration.active && sameAgent(profile.agent, request.service.agent) &&
    source.blockNumber === basis.blockNumber && equalHex(source.blockHash, basis.blockHash) &&
    equalHex(source.agentOwner, basis.agentOwner) && equalHex(source.agentUriDigest, basis.agentUriDigest) &&
    equalHex(source.registrationDigest, basis.registrationDigest) && equalHex(source.cardDigest, basis.cardDigest) &&
    equalHex(extension.receiptSigner, basis.receiptSigner) &&
    equalHex(extension.ownerAtPublication, source.agentOwner)
    ? 'matched' : 'mismatched';
}

function acceptanceMatches(acceptance: CityAcceptance, request: CityRequest, requestDigest: string, feedbackAcceptanceDigest: string, actualAcceptanceDigest: string): boolean {
  const accepted = Date.parse(acceptance.acceptedAt);
  return equalHex(acceptance.requestDigest, requestDigest) &&
    equalHex(feedbackAcceptanceDigest, actualAcceptanceDigest) &&
    acceptance.deadline === request.deadline &&
    accepted >= Date.parse(request.createdAt) && accepted <= Date.parse(request.deadline);
}

function completionMatches(completion: CityCompletion, acceptance: CityAcceptance, acceptanceDigest: string): boolean {
  const recorded = Date.parse(completion.recordedAt);
  return equalHex(completion.acceptanceDigest, acceptanceDigest) &&
    recorded >= Date.parse(acceptance.acceptedAt) &&
    (completion.outcome !== 'completed' || recorded <= Date.parse(acceptance.deadline)) &&
    (completion.outcome !== 'expired' || recorded > Date.parse(acceptance.deadline));
}

/**
 * Evaluate only supplied, exact signed artifacts and the supplied original verified profile.
 * Claimed UTC times are chronology checks, not proof of existence before retirement.
 * No current owner, live endpoint, current deadline, chain publication or revocation is consulted.
 */
export async function verifyHistoricalFeedback(input: Input): Promise<HistoricalFeedbackFinding> {
  const feedbackEnvelope = decodeFeedbackEnvelope(input.feedback);
  const requestEnvelope = decodeEnvelope(input.request);
  if (requestEnvelope.statement.value.kind !== 'request') throw new Error('request envelope has wrong statement kind');
  const feedback = feedbackEnvelope.feedback.value;
  const request = requestEnvelope.statement.value;
  const chainId = request.service.agent.chainId;
  const feedbackSignature = (await verifyFeedbackSignature(input.feedback, chainId)).status;
  const requestSignature = (await verifyEnvelopeSignature(input.request, chainId)).status;

  const reviewerBinding: Match = equalHex(feedback.reviewer.address, request.caller.address) &&
    feedback.reviewer.chainId === request.caller.chainId &&
    equalHex(feedbackEnvelope.envelope.signer.address, feedback.reviewer.address) &&
    feedbackEnvelope.envelope.signer.chainId === feedback.reviewer.chainId ? 'matched' : 'mismatched';
  const requestCallerBinding: Match = equalHex(requestEnvelope.envelope.signer.address, request.caller.address) &&
    requestEnvelope.envelope.signer.chainId === request.caller.chainId ? 'matched' : 'mismatched';
  const serviceLink: Match = sameAgent(feedback.service.agent, request.service.agent) ? 'matched' : 'mismatched';
  const registryDomain: Match = feedback.reputationRegistry.chainId === input.expectedReputationRegistry.chainId &&
    equalHex(feedback.reputationRegistry.address, input.expectedReputationRegistry.address) ? 'matched' : 'mismatched';
  const requestLink: Match = equalHex(feedback.requestDigest, requestEnvelope.statement.digest) &&
    equalHex(feedback.interactionId, request.interactionId) ? 'matched' : 'mismatched';
  const originalProfileBasis = originalBasis(input.basisProfile, request);

  let acceptanceSignature: HistoricalFeedbackFinding['acceptanceSignature'] = 'missing';
  let acceptanceLink: HistoricalFeedbackFinding['acceptanceLink'] = 'missing';
  let acceptanceSignerBinding: AvailabilityMatch = 'unavailable';
  let acceptance: CityAcceptance | undefined;
  let acceptanceDigest: string | undefined;
  if (input.acceptance !== undefined) {
    const decoded = decodeEnvelope(input.acceptance);
    if (decoded.statement.value.kind !== 'acceptance') throw new Error('acceptance envelope has wrong statement kind');
    acceptance = decoded.statement.value;
    acceptanceDigest = decoded.statement.digest;
    acceptanceSignature = (await verifyEnvelopeSignature(input.acceptance, chainId)).status;
    acceptanceLink = acceptanceMatches(acceptance, request, requestEnvelope.statement.digest, feedback.acceptanceDigest, acceptanceDigest)
      ? 'matched' : 'mismatched';
    acceptanceSignerBinding = equalHex(decoded.envelope.signer.address, request.profileBasis.receiptSigner) &&
      decoded.envelope.signer.chainId === chainId ? 'matched' : 'mismatched';
  }

  let completionSignature: HistoricalFeedbackFinding['completionSignature'] = 'not-present';
  let completionLink: HistoricalFeedbackFinding['completionLink'] = 'not-present';
  let completionSignerBinding: HistoricalFeedbackFinding['completionSignerBinding'] = 'not-present';
  let completionClaimedOutcome: HistoricalFeedbackFinding['completionClaimedOutcome'] = 'not-present';
  let completion: CityCompletion | undefined;
  let completionDigest: string | undefined;
  if (input.completion !== undefined) {
    const decoded = decodeEnvelope(input.completion);
    if (decoded.statement.value.kind !== 'completion') throw new Error('completion envelope has wrong statement kind');
    completion = decoded.statement.value;
    completionDigest = decoded.statement.digest;
    completionSignature = (await verifyEnvelopeSignature(input.completion, chainId)).status;
    completionLink = acceptance && acceptanceDigest
      ? (completionMatches(completion, acceptance, acceptanceDigest) ? 'matched' : 'mismatched')
      : 'unavailable';
    completionSignerBinding = equalHex(decoded.envelope.signer.address, request.profileBasis.receiptSigner) &&
      decoded.envelope.signer.chainId === chainId ? 'matched' : 'mismatched';
    completionClaimedOutcome = completion.outcome;
  }

  const reviewTime = Date.parse(feedback.createdAt);
  let claimedTime: HistoricalFeedbackFinding['claimedTime'] = acceptance ? 'consistent' : 'unavailable';
  if (acceptance && (reviewTime < Date.parse(acceptance.acceptedAt) ||
      (input.basisProfile && Date.parse(request.createdAt) < input.basisProfile.source.blockTimestamp * 1000))) {
    claimedTime = 'inconsistent';
  }

  const signedAcceptanceLinked = feedbackSignature === 'valid' && requestSignature === 'valid' &&
    acceptanceSignature === 'valid' && reviewerBinding === 'matched' &&
    requestCallerBinding === 'matched' && serviceLink === 'matched' &&
    requestLink === 'matched' && acceptanceLink === 'matched' &&
    acceptanceSignerBinding === 'matched';

  let resultEvidence: HistoricalFeedbackFinding['resultEvidence'];
  if (feedback.result.kind === 'no-result-observed') {
    const observed = Date.parse(feedback.result.observedAt);
    if (!acceptance) {
      resultEvidence = 'unavailable';
    } else if (!signedAcceptanceLinked) {
      resultEvidence = 'mismatched';
    } else if (observed <= Date.parse(request.deadline) || reviewTime < observed) {
      resultEvidence = 'too-early-claim';
      claimedTime = 'inconsistent';
    } else {
      resultEvidence = 'post-deadline-reviewer-claim';
    }
  } else if (!completion || !completionDigest || !acceptance || !acceptanceDigest) {
    resultEvidence = 'unavailable';
  } else {
    const linked = equalHex(feedback.result.completionDigest, completionDigest) &&
      completionLink === 'matched' && completionSignerBinding === 'matched' &&
      completionSignature === 'valid' && signedAcceptanceLinked;
    resultEvidence = linked ? 'matched' : 'mismatched';
    if (reviewTime < Date.parse(completion.recordedAt)) claimedTime = 'inconsistent';
  }

  return {
    feedbackSignature, requestSignature, acceptanceSignature, completionSignature,
    completionLink, completionSignerBinding, completionClaimedOutcome,
    reviewerBinding, requestCallerBinding, serviceLink, registryDomain, requestLink,
    acceptanceLink, originalProfileBasis, acceptanceSignerBinding, claimedTime, resultEvidence,
    historicalExistence: 'unknown', historicalOrdering: 'unknown',
    publication: 'not-evaluated', revocation: 'not-evaluated',
  };
}
