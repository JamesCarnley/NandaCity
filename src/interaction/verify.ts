import type { VerifiedProfile } from '../identity/verify.js';
import { digestBytes } from '../identity/profile.js';
import { decodeEnvelope, verifyEnvelopeSignature, type CryptoFinding } from './signatures.js';
import { isUtcSecond, type CityAcceptance, type CityCompletion, type CityRequest } from './schema.js';

export type ContinuityFinding = 'unchanged' | 'changed' | 'unknown';

export type StageFinding = {
  cryptography: CryptoFinding['status'];
  signerBinding: 'matched' | 'mismatched';
  profileBasis: 'matched' | 'mismatched' | 'unavailable';
  currentAuthority: 'authorized' | 'unauthorized' | 'unavailable';
  continuity: ContinuityFinding;
  deadline: 'live' | 'expired';
  claimedTime: 'observed' | 'future';
  link: 'matched' | 'mismatched' | 'not-applicable';
  answerBinding: 'matched' | 'mismatched' | 'unavailable' | 'not-applicable';
  historicalExistence: 'unknown';
  usableAtObservation: boolean;
  terminalOutcome?: CityCompletion['outcome'];
};

export type InteractionFinding = {
  request: StageFinding;
  acceptance?: StageFinding;
  completion?: StageFinding;
  allPresentedEvidenceUsableAtObservation: boolean;
};

type Input = {
  request: unknown;
  acceptance?: unknown;
  completion?: unknown;
  basisProfile: VerifiedProfile | null;
  currentProfile: VerifiedProfile | null;
  continuity: ContinuityFinding;
  observedAt: string;
  answerBytes?: Uint8Array;
};

const equalHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function sameAgent(a: VerifiedProfile['agent'], b: CityRequest['service']['agent']): boolean {
  return a.chainId === b.chainId && equalHex(a.registry, b.registry) && a.agentId === b.agentId;
}

function matchesBasis(profile: VerifiedProfile | null, request: CityRequest): StageFinding['profileBasis'] {
  if (!profile) return 'unavailable';
  const basis = request.profileBasis;
  const source = profile.source;
  const signer = profile.registration['x-nandacity'].receiptSigner;
  return sameAgent(profile.agent, request.service.agent) &&
    source.blockNumber === basis.blockNumber &&
    equalHex(source.blockHash, basis.blockHash) &&
    equalHex(source.agentOwner, basis.agentOwner) &&
    equalHex(source.agentUriDigest, basis.agentUriDigest) &&
    equalHex(source.registrationDigest, basis.registrationDigest) &&
    equalHex(source.cardDigest, basis.cardDigest) &&
    equalHex(signer, basis.receiptSigner)
    ? 'matched' : 'mismatched';
}

function currentAuthority(profile: VerifiedProfile | null, request: CityRequest): StageFinding['currentAuthority'] {
  if (!profile) return 'unavailable';
  const source = profile.source;
  const basis = request.profileBasis;
  const registration = profile.registration;
  const extension = registration['x-nandacity'];
  return registration.active && sameAgent(profile.agent, request.service.agent) &&
    BigInt(source.blockNumber) >= BigInt(basis.blockNumber) &&
    (source.blockNumber !== basis.blockNumber || equalHex(source.blockHash, basis.blockHash)) &&
    equalHex(source.agentOwner, basis.agentOwner) &&
    equalHex(source.agentUriDigest, basis.agentUriDigest) &&
    equalHex(source.registrationDigest, basis.registrationDigest) &&
    equalHex(source.cardDigest, basis.cardDigest) &&
    equalHex(extension.receiptSigner, basis.receiptSigner) &&
    equalHex(extension.ownerAtPublication, source.agentOwner)
    ? 'authorized' : 'unauthorized';
}

function stage(
  crypto: CryptoFinding['status'], binding: StageFinding['signerBinding'],
  basis: StageFinding['profileBasis'], current: StageFinding['currentAuthority'],
  continuity: ContinuityFinding, deadline: StageFinding['deadline'], link: StageFinding['link'],
  answerBinding: StageFinding['answerBinding'], claimedTime: StageFinding['claimedTime'],
  terminalOutcome?: CityCompletion['outcome'],
): StageFinding {
  const result: StageFinding = {
    cryptography: crypto,
    signerBinding: binding,
    profileBasis: basis,
    currentAuthority: current,
    continuity,
    deadline,
    claimedTime,
    link,
    answerBinding,
    historicalExistence: 'unknown',
    usableAtObservation: crypto === 'valid' && binding === 'matched' && basis === 'matched' &&
      current === 'authorized' && continuity === 'unchanged' && deadline === 'live' &&
      claimedTime === 'observed' &&
      link !== 'mismatched' && answerBinding !== 'mismatched' && answerBinding !== 'unavailable',
  };
  if (terminalOutcome) result.terminalOutcome = terminalOutcome;
  return result;
}

/**
 * Pure policy evaluation over explicitly supplied, independently checked profiles.
 * The observer clock and continuity result are inputs, not claims established here.
 */
export async function verifyInteraction(input: Input): Promise<InteractionFinding> {
  const observed = Date.parse(input.observedAt);
  if (!isUtcSecond(input.observedAt) || !Number.isFinite(observed)) {
    throw new Error('observedAt must be a real UTC whole-second timestamp');
  }
  const requestEnvelope = decodeEnvelope(input.request);
  if (requestEnvelope.statement.value.kind !== 'request') throw new Error('request envelope has wrong statement kind');
  const request = requestEnvelope.statement.value;
  const chainId = request.service.agent.chainId;
  const basis = matchesBasis(input.basisProfile, request);
  const current = currentAuthority(input.currentProfile, request);
  const deadline: StageFinding['deadline'] = observed <= Date.parse(request.deadline) ? 'live' : 'expired';
  const requestCrypto = await verifyEnvelopeSignature(input.request, chainId);
  const requestReport = stage(
    requestCrypto.status,
    equalHex(requestEnvelope.envelope.signer.address, request.caller.address) &&
      requestEnvelope.envelope.signer.chainId === request.caller.chainId ? 'matched' : 'mismatched',
    basis, current, input.continuity, deadline, 'not-applicable', 'not-applicable',
    Date.parse(request.createdAt) <= observed ? 'observed' : 'future',
  );

  let acceptanceReport: StageFinding | undefined;
  let acceptanceValue: CityAcceptance | undefined;
  let acceptanceDigest: string | undefined;
  if (input.acceptance !== undefined) {
    const acceptanceEnvelope = decodeEnvelope(input.acceptance);
    if (acceptanceEnvelope.statement.value.kind !== 'acceptance') throw new Error('acceptance envelope has wrong statement kind');
    acceptanceValue = acceptanceEnvelope.statement.value;
    acceptanceDigest = acceptanceEnvelope.statement.digest;
    const link = equalHex(acceptanceValue.requestDigest, requestEnvelope.statement.digest) &&
      acceptanceValue.deadline === request.deadline &&
      Date.parse(acceptanceValue.acceptedAt) >= Date.parse(request.createdAt) &&
      Date.parse(acceptanceValue.acceptedAt) <= Date.parse(request.deadline)
      ? 'matched' : 'mismatched';
    const crypto = await verifyEnvelopeSignature(input.acceptance, chainId);
    acceptanceReport = stage(
      crypto.status,
      equalHex(acceptanceEnvelope.envelope.signer.address, request.profileBasis.receiptSigner) &&
        acceptanceEnvelope.envelope.signer.chainId === chainId ? 'matched' : 'mismatched',
      basis, current, input.continuity, deadline, link, 'not-applicable',
      Date.parse(acceptanceValue.acceptedAt) <= observed ? 'observed' : 'future',
    );
    acceptanceReport.usableAtObservation &&= requestReport.usableAtObservation;
  }

  let completionReport: StageFinding | undefined;
  if (input.completion !== undefined) {
    const completionEnvelope = decodeEnvelope(input.completion);
    if (completionEnvelope.statement.value.kind !== 'completion') throw new Error('completion envelope has wrong statement kind');
    const completion = completionEnvelope.statement.value;
    const completionTime = Date.parse(completion.recordedAt);
    const link = acceptanceValue && acceptanceDigest &&
      equalHex(completion.acceptanceDigest, acceptanceDigest) &&
      completionTime >= Date.parse(acceptanceValue.acceptedAt) &&
      (completion.outcome !== 'completed' || completionTime <= Date.parse(request.deadline)) &&
      (completion.outcome !== 'expired' || completionTime > Date.parse(request.deadline))
      ? 'matched' : 'mismatched';
    const crypto = await verifyEnvelopeSignature(input.completion, chainId);
    let answerBinding: StageFinding['answerBinding'] = 'not-applicable';
    if (completion.outcome === 'completed') {
      if (input.answerBytes === undefined) answerBinding = 'unavailable';
      else if (!(input.answerBytes instanceof Uint8Array) || input.answerBytes.byteLength > 256 * 1024) {
        answerBinding = 'mismatched';
      } else {
        answerBinding = equalHex(digestBytes(input.answerBytes), completion.answerDigest) ? 'matched' : 'mismatched';
      }
    }
    completionReport = stage(
      crypto.status,
      equalHex(completionEnvelope.envelope.signer.address, request.profileBasis.receiptSigner) &&
        completionEnvelope.envelope.signer.chainId === chainId ? 'matched' : 'mismatched',
      basis, current, input.continuity, deadline, link, answerBinding,
      completionTime <= observed ? 'observed' : 'future', completion.outcome,
    );
    completionReport.usableAtObservation &&= acceptanceReport?.usableAtObservation === true;
  }

  return {
    request: requestReport,
    ...(acceptanceReport ? { acceptance: acceptanceReport } : {}),
    ...(completionReport ? { completion: completionReport } : {}),
    allPresentedEvidenceUsableAtObservation: requestReport.usableAtObservation &&
      (acceptanceReport?.usableAtObservation ?? true) &&
      (completionReport?.usableAtObservation ?? true),
  };
}
