import type { PublicClient } from 'viem';

import { a2aTaskSchema, CITY_RESULT_DATA_TYPE, type A2ATask } from '../a2a/wire.js';
import { verifyDiscoveryWithCard, type DiscoveredCandidate, type DiscoveryVerification,
  type IdentityDomain, type ServiceFilter } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AuthoritySnapshot } from '../identity/verify.js';
import { verifyInteraction, type InteractionFinding, type ContinuityFinding } from '../interaction/verify.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import type { SignedEnvelope } from '../interaction/schema.js';
import { fetchOwnedCard } from './twoIndexes.js';

export type JourneyEvidence = {
  candidate: DiscoveredCandidate;
  cardBase64: string;
  request: SignedEnvelope;
  acceptance: SignedEnvelope;
  completion?: SignedEnvelope;
  answerBase64?: string;
  task: A2ATask;
  /** Chain snapshot at signed request.profileBasis.blockNumber (M), not Index publication observation N. */
  basisObservation: AuthoritySnapshot;
  currentObservation: AuthoritySnapshot;
  observedAt: string;
};

export type JourneyReport = {
  discovery: DiscoveryVerification;
  request?: InteractionFinding['request'];
  acceptance?: InteractionFinding['acceptance'];
  completion?: InteractionFinding['completion'];
  continuity: ContinuityFinding | 'not-tested';
  execution: 'completed' | 'failed' | 'inconsistent' | 'not-tested';
  contentValidation: 'not-tested';
  evidenceUsable: boolean;
  firstBrokenBoundary: 'evidence' | 'discovery' | 'authority-basis' |
    'current-authority' | 'authority-continuity' | 'interaction' | 'acceptance' | 'execution' | 'answer' | null;
  reasons: string[];
  limitations: string[];
};

function exactBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('evidence contains noncanonical or oversized Base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== value) {
    throw new Error('evidence contains noncanonical or oversized Base64');
  }
  return new Uint8Array(bytes);
}

function sameSnapshot(left: AuthoritySnapshot, right: AuthoritySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskConsistency(task: A2ATask, evidence: JourneyEvidence): JourneyReport['execution'] {
  const metadata = task.metadata?.['org.nandacity'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'inconsistent';
  const city = metadata as Record<string, unknown>;
  if (JSON.stringify(city['acceptance']) !== JSON.stringify(evidence.acceptance) ||
      JSON.stringify(city['completion']) !== JSON.stringify(evidence.completion)) return 'inconsistent';
  if (task.status.state === 'failed' && !evidence.answerBase64 && !task.artifacts?.length) return 'failed';
  if (task.status.state !== 'completed') return 'inconsistent';
  const data = task.artifacts?.[0]?.parts[0]?.data;
  if (!data || data['type'] !== CITY_RESULT_DATA_TYPE || data['version'] !== '0.1' ||
      data['answerBase64'] !== evidence.answerBase64 ||
      JSON.stringify(data['completion']) !== JSON.stringify(evidence.completion)) return 'inconsistent';
  return 'completed';
}

const limitations = [
  'Local synthetic fixture only; no live hours, bookings, travel times, or semantic quality verified.',
  'RPC snapshots are observations, not Ethereum state proofs; post-basis history is unknown unless the same canonical block is observed.',
  'A2A polling is loopback-only without HTTP authentication; this is not full A2A conformance.',
];

function stopped(discovery: DiscoveryVerification, boundary: NonNullable<JourneyReport['firstBrokenBoundary']>,
  reason: string, continuity: JourneyReport['continuity'] = 'not-tested'): JourneyReport {
  return { discovery, continuity, execution: 'not-tested', contentValidation: 'not-tested',
    evidenceUsable: false, firstBrokenBoundary: boundary, reasons: [reason], limitations };
}

function unavailable(origin: string, reason: string): DiscoveryVerification {
  return { status: 'unavailable', observerOrigin: origin, reason };
}

/** Re-reads chain and card with a separate client. Exported observations are evidence to compare, not authority. */
export async function verifyJourneyEvidence(evidence: JourneyEvidence, client: PublicClient,
  domain: IdentityDomain, filter: ServiceFilter, allowedCardOrigin: string): Promise<JourneyReport> {
  const reasons: string[] = [];
  const origin = evidence?.candidate?.observerOrigin ?? 'unknown';
  let task: A2ATask;
  let cardBytes: Uint8Array;
  let requestBasisBlock: bigint;
  try {
    task = a2aTaskSchema.parse(evidence.task);
    cardBytes = exactBase64(evidence.cardBase64, 64 * 1024);
    const request = decodeEnvelope(evidence.request).statement.value;
    if (request.kind !== 'request') throw new Error('signed request has wrong statement kind');
    const requestAgent = request.service.agent;
    const candidateAgent = evidence.candidate.agent;
    if (requestAgent.chainId !== candidateAgent.chainId ||
        requestAgent.registry.toLowerCase() !== candidateAgent.registry.toLowerCase() ||
        requestAgent.agentId !== candidateAgent.agentId ||
        requestAgent.chainId !== domain.chainId ||
        requestAgent.registry.toLowerCase() !== domain.registry.toLowerCase()) {
      throw new Error('signed request service differs from the Index candidate or selected domain');
    }
    requestBasisBlock = BigInt(request.profileBasis.blockNumber);
  } catch (error) {
    return stopped(unavailable(origin, 'evidence format was not accepted'), 'evidence',
      error instanceof Error ? error.message : 'malformed exported evidence');
  }
  let discovery: DiscoveryVerification;
  try {
    discovery = await verifyDiscoveryWithCard(evidence.candidate, client, domain, filter,
      (url) => fetchOwnedCard(url, allowedCardOrigin));
  } catch (error) {
    return stopped(unavailable(origin, 'discovery check could not complete'), 'discovery',
      error instanceof Error ? error.message : 'discovery check failed');
  }
  if (discovery.status !== 'verified') return stopped(discovery, 'discovery',
    `${discovery.status}: ${discovery.reason}`);
  let fetchedCard: Uint8Array;
  try { fetchedCard = await fetchOwnedCard(evidence.candidate.declaration.url, allowedCardOrigin); }
  catch (error) {
    return stopped(unavailable(origin, 'independent card fetch failed'), 'discovery',
      error instanceof Error ? error.message : 'card fetch failed');
  }
  if (!Buffer.from(cardBytes).equals(Buffer.from(fetchedCard))) {
    return stopped({ status: 'rejected', observerOrigin: origin,
      reason: 'exported card bytes differ from independently fetched card' }, 'discovery',
    'exported card bytes differ from independently fetched card');
  }
  let basis: AuthoritySnapshot;
  try {
    basis = await readIdentitySnapshot(client, evidence.candidate.agent, requestBasisBlock);
  } catch (error) {
    return stopped(discovery, 'authority-basis', `exact request basis block read failed: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  if (!sameSnapshot(basis, evidence.basisObservation)) {
    return stopped(discovery, 'authority-basis', 'exported basis observation differs from independent chain read');
  }
  let current: AuthoritySnapshot;
  try { current = await readIdentitySnapshot(client, evidence.candidate.agent); }
  catch (error) {
    return stopped(discovery, 'current-authority', `current authority read failed: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  if (!sameSnapshot(current, evidence.currentObservation)) {
    return stopped(discovery, 'current-authority',
      'exported current observation differs from independent chain read');
  }
  const continuity: ContinuityFinding = basis.blockNumber === current.blockNumber &&
    basis.blockHash === current.blockHash ? 'unchanged' : 'unknown';
  if (continuity === 'unknown') reasons.push('authority continuity is unknown after the basis block');
  let basisProfile;
  try {
    basisProfile = verifyProfile({ agent: evidence.candidate.agent,
      agentURI: evidence.candidate.agentURI, cardBytes }, basis);
  } catch (error) {
    return stopped(discovery, 'authority-basis', `basis profile invalid: ${
      error instanceof Error ? error.message : String(error)}`, continuity);
  }
  let currentProfile;
  try {
    currentProfile = verifyProfile({ agent: evidence.candidate.agent,
      agentURI: current.agentURI, cardBytes }, current);
  } catch (error) {
    return stopped(discovery, 'current-authority', `current profile invalid: ${
      error instanceof Error ? error.message : String(error)}`, continuity);
  }
  let answerBytes: Uint8Array | undefined;
  let answerIssue: string | undefined;
  if (evidence.answerBase64 !== undefined) {
    try { answerBytes = exactBase64(evidence.answerBase64, 256 * 1024); }
    catch (error) { answerIssue = error instanceof Error ? error.message : String(error); }
  }
  let finding: InteractionFinding;
  try {
    finding = await verifyInteraction({
      request: evidence.request, acceptance: evidence.acceptance,
      ...(evidence.completion ? { completion: evidence.completion } : {}),
      ...(answerBytes ? { answerBytes } : {}),
      basisProfile, currentProfile, continuity,
      // The producer's recorded clock is provenance, not the verifier's clock.
      observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  } catch (error) {
    return stopped(discovery, 'interaction', `interaction envelope invalid: ${
      error instanceof Error ? error.message : String(error)}`, continuity);
  }
  const execution = taskConsistency(task, evidence);
  const signedOutcome = finding.completion?.terminalOutcome;
  if (!signedOutcome ||
      (execution === 'completed' && signedOutcome !== 'completed') ||
      (execution === 'failed' && !['failed', 'expired'].includes(signedOutcome))) {
    reasons.push('A2A Task state does not match signed completion');
  }
  if (!finding.request.usableAtObservation) reasons.push('signed request is not usable at observation');
  if (!finding.acceptance?.usableAtObservation) reasons.push('signed acceptance is not usable at observation');
  if (evidence.completion && !finding.completion?.usableAtObservation) {
    reasons.push('signed completion is not usable at observation');
  }
  if (execution === 'failed') reasons.push('service accepted the request but failed execution');
  if (execution === 'inconsistent') reasons.push('A2A Task/evidence mismatch');
  if (!evidence.completion) reasons.push('provider-signed completion missing');
  if (answerIssue) reasons.push(`answer bytes invalid: ${answerIssue}`);
  const firstBrokenBoundary: JourneyReport['firstBrokenBoundary'] =
    continuity === 'unknown' ? 'authority-continuity' :
      !finding.request.usableAtObservation ? 'interaction' :
      !finding.acceptance?.usableAtObservation ? 'acceptance' :
        !evidence.completion ? 'interaction' :
        answerIssue || (finding.completion?.answerBinding === 'mismatched' ||
          finding.completion?.answerBinding === 'unavailable') ? 'answer' :
          evidence.completion && !finding.completion?.usableAtObservation ? 'interaction' :
            execution === 'failed' || execution === 'inconsistent' ? 'execution' : null;
  return {
    discovery,
    request: finding.request,
    ...(finding.acceptance ? { acceptance: finding.acceptance } : {}),
    ...(finding.completion ? { completion: finding.completion } : {}),
    continuity, execution, contentValidation: 'not-tested', firstBrokenBoundary,
    evidenceUsable: discovery.status === 'verified' && continuity === 'unchanged' &&
      finding.allPresentedEvidenceUsableAtObservation &&
      (execution === 'completed' || execution === 'failed') &&
      signedOutcome !== undefined &&
      ((execution === 'completed' && signedOutcome === 'completed') ||
        (execution === 'failed' && ['failed', 'expired'].includes(signedOutcome))),
    reasons, limitations,
  };
}

export function formatJourneyPlain(success: JourneyReport, failure: JourneyReport): string {
  const stage = (name: string, report: JourneyReport): string => [
    `${name}: discovery ${report.discovery.status}; request ${report.request?.cryptography ?? 'not-tested'}; ` +
      `acceptance ${report.acceptance?.cryptography ?? 'not-tested'}; ` +
      `execution ${report.execution}; completion ${report.completion?.cryptography ?? 'not-tested'}; ` +
      `answer binding ${report.completion?.answerBinding ?? 'not-tested'}; semantic quality ${report.contentValidation}`,
    ...report.reasons.map((reason) => `  - ${reason}`),
  ].join('\n');
  return ['Nanda City local Chicago journey (synthetic fixture)', stage('Success case', success),
    stage('Accepted failure case', failure),
    'No live city data, full A2A conformance, or trust/quality endorsement is claimed.'].join('\n');
}
