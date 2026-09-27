import { z } from 'zod';
import { isUtcSecond, type SignedEnvelope } from '../interaction/schema.js';
import type { A2AMessage, A2ATask } from '../a2a/wire.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import type { JourneyEvidence, JourneyReport } from '../demo/journeyReport.js';
import type { AuthoritySnapshot } from '../identity/verify.js';
import type { StageFinding } from '../interaction/verify.js';

export const licensedRetentionSchema = z.strictObject({
  kind: z.literal('licensed'), policyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  expiresAt: z.string().refine(isUtcSecond), export: z.literal('receipts-only'), persistContent: z.literal(false),
});
export const retentionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authored-fixture'), export: z.literal('full') }), licensedRetentionSchema,
]);
export type Retention = z.infer<typeof retentionSchema>;
export type LicensedRetention = z.infer<typeof licensedRetentionSchema>;
export type ContentAvailability = 'available' | 'expired' | 'not-retained';
export type ContentFinding = { contentAvailability: ContentAvailability; semanticReplay: 'available' | 'unavailable' };

function clock(now: string): number {
  if (!isUtcSecond(now)) throw new Error('invalid retention observation time');
  return Date.parse(now);
}
export function contentFinding(retention: LicensedRetention, now: string, available = false): ContentFinding {
  const expired = clock(now) >= Date.parse(licensedRetentionSchema.parse(retention).expiresAt);
  return { contentAvailability: expired ? 'expired' : available ? 'available' : 'not-retained',
    semanticReplay: !expired && available ? 'available' : 'unavailable' };
}

/** Process-local bounded ownership. Reads copy; eviction overwrites the owned buffer. */
export class TransientByteHolder {
  readonly #entries = new Map<string, { bytes: Uint8Array; policy: LicensedRetention; timer: NodeJS.Timeout }>();
  #closed = false;
  constructor(private readonly now: () => string, private readonly maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('invalid transient byte bound');
  }
  put(key: string, bytes: Uint8Array, policy: LicensedRetention): void {
    const validated = licensedRetentionSchema.parse(policy);
    this.evict(key);
    if (this.#closed || contentFinding(validated, this.now()).contentAvailability === 'expired') return;
    if (!bytes.byteLength || bytes.byteLength > Math.min(this.maxBytes, 256 * 1024)) throw new Error('invalid transient answer size');
    for (const existing of this.#entries.keys()) this.has(existing);
    while (this.#entries.size >= 128 || [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0) + bytes.byteLength > this.maxBytes) {
      this.evict(this.#entries.keys().next().value!);
    }
    // Timers are capped to avoid Node's overflowing long-delay timeout behavior.
    const expire = () => {
      const entry = this.#entries.get(key);
      if (!entry) return;
      const remaining = Date.parse(validated.expiresAt) - clock(this.now());
      if (remaining <= 0) this.evict(key);
      else { entry.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); entry.timer.unref(); }
    };
    const timer = setTimeout(expire, Math.min(Date.parse(validated.expiresAt) - clock(this.now()), 2_147_483_647));
    timer.unref();
    this.#entries.set(key, { bytes: Uint8Array.from(bytes), policy: validated, timer });
  }
  read(key: string): Uint8Array | undefined {
    return this.has(key) ? Uint8Array.from(this.#entries.get(key)!.bytes) : undefined;
  }
  has(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (contentFinding(entry.policy, this.now()).contentAvailability === 'expired') { this.evict(key); return false; }
    return true;
  }
  evict(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) { clearTimeout(entry.timer); entry.bytes.fill(0); this.#entries.delete(key); }
  }
  close(): void { this.#closed = true; for (const key of this.#entries.keys()) this.evict(key); }
}

const failureReasonSchema = z.enum(['execution-timeout', 'provider-error', 'terminal-signing-failed',
  'terminal-time-invalid', 'authority-unavailable', 'request-evidence-invalid', 'authority-observation-invalid',
  'authority-observation-stale', 'runtime-signer-unauthorized', 'request-signature-invalid', 'profile-basis-mismatch',
  'deadline-expired', 'authority-changed', 'interrupted-unresolved']);
const receiptDataSchema = z.union([
  z.strictObject({ type: z.literal('org.nandacity.city-request'), version: z.literal('0.1'), envelope: z.unknown() }),
  z.strictObject({ type: z.literal('org.nandacity.city-status'), version: z.literal('0.1'),
    state: z.enum(['accepted', 'failed']), acceptance: z.unknown(), completion: z.unknown().optional(), reason: failureReasonSchema.optional() }),
  z.strictObject({ type: z.literal('org.nandacity.city-result'), version: z.literal('0.1'), completion: z.unknown() }),
]);
const receiptPartSchema = z.strictObject({ kind: z.literal('data'), data: receiptDataSchema });
const receiptMessageSchema = z.strictObject({ kind: z.literal('message'), role: z.enum(['user', 'agent']),
  messageId: z.string().min(1).max(256), parts: z.array(receiptPartSchema).length(1) });
export const receiptTaskSchema = z.strictObject({ kind: z.literal('task'), id: z.string().uuid(), contextId: z.string().uuid(),
  status: z.strictObject({ state: z.enum(['submitted', 'completed', 'failed']), timestamp: z.string().refine(isUtcSecond),
    message: receiptMessageSchema.optional() }),
  history: z.array(receiptMessageSchema).length(1),
  artifacts: z.array(z.strictObject({ artifactId: z.string().uuid(), parts: z.array(receiptPartSchema).length(1) })).length(1).optional(),
  metadata: z.strictObject({ 'org.nandacity': z.strictObject({ subset: z.literal('a2a-0.3-jsonrpc-loopback'),
    pollingAuthentication: z.literal('none-loopback-only'), interactionId: z.string().regex(/^0x[0-9a-f]{64}$/),
    acceptance: z.unknown(), completion: z.unknown().optional(), failureReason: failureReasonSchema.optional() }) }),
});

/** Explicit private receipt projection, not recursive redaction of unknown data. */
export function projectReceiptTask(task: A2ATask): A2ATask {
  const message = (value: A2AMessage): A2AMessage => ({ kind: 'message', role: value.role, messageId: value.messageId,
    parts: value.parts.map(({ data }) => {
      const projected: Record<string, unknown> = { type: data.type, version: data.version };
      if (data.type === 'org.nandacity.city-request') projected.envelope = data.envelope;
      else if (data.type === 'org.nandacity.city-result') projected.completion = data.completion;
      else if (data.type === 'org.nandacity.city-status') {
        projected.state = data.state; projected.acceptance = data.acceptance;
        if (data.completion !== undefined) projected.completion = data.completion;
        if (data.reason !== undefined) projected.reason = failureReasonSchema.parse(data.reason);
      }
      return { kind: 'data', data: projected };
    }) });
  const city = task.metadata?.['org.nandacity'] as Record<string, unknown>;
  const projected = { kind: 'task', id: task.id, contextId: task.contextId,
    status: { state: task.status.state, timestamp: task.status.timestamp,
      ...(task.status.message ? { message: message(task.status.message) } : {}) },
    history: (task.history ?? []).map(message),
    ...(task.artifacts ? { artifacts: task.artifacts.map((artifact) => ({ artifactId: artifact.artifactId,
      parts: message({ kind: 'message', role: 'agent', messageId: artifact.artifactId, parts: artifact.parts }).parts })) } : {}),
    metadata: { 'org.nandacity': { subset: city.subset, pollingAuthentication: city.pollingAuthentication,
      interactionId: city.interactionId, acceptance: city.acceptance,
      ...(city.completion !== undefined ? { completion: city.completion } : {}),
      ...(city.failureReason !== undefined ? { failureReason: failureReasonSchema.parse(city.failureReason) } : {}) } } };
  return structuredClone(receiptTaskSchema.parse(projected)) as A2ATask;
}

/** Private verification material is deliberately separate from public presentation. */
export function projectReceiptEvidence(evidence: JourneyEvidence): JourneyEvidence {
  const task = projectReceiptTask(evidence.task);
  const request = decodeEnvelope(evidence.request);
  const acceptance = decodeEnvelope(evidence.acceptance);
  const completion = evidence.completion ? decodeEnvelope(evidence.completion) : undefined;
  if (request.statement.value.kind !== 'request' || acceptance.statement.value.kind !== 'acceptance' ||
      acceptance.statement.value.requestDigest !== request.statement.digest ||
      (completion && (completion.statement.value.kind !== 'completion' || completion.statement.value.acceptanceDigest !== acceptance.statement.digest))) {
    throw new Error('private evidence requires linked Ethereum request and receipt kinds');
  }
  const city = task.metadata!['org.nandacity'] as Record<string, unknown>;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(city.acceptance, acceptance.envelope) || !same(city.completion, completion?.envelope) ||
      city.interactionId !== request.statement.value.interactionId) throw new Error('private task receipt linkage mismatch');
  for (const { data } of [...task.history!.flatMap((message) => message.parts), ...(task.status.message?.parts ?? []),
    ...(task.artifacts ?? []).flatMap((artifact) => artifact.parts)]) {
    if (data.type === 'org.nandacity.city-request' && !same(data.envelope, request.envelope)) throw new Error('private task request mismatch');
    if ('acceptance' in data && !same(data.acceptance, acceptance.envelope)) throw new Error('private task acceptance mismatch');
    if ('completion' in data && !same(data.completion, completion?.envelope)) throw new Error('private task completion mismatch');
  }
  const agent = (value: AuthoritySnapshot['agent']) => ({ chainId: value.chainId, registry: value.registry, agentId: value.agentId });
  const observation = (value: AuthoritySnapshot): AuthoritySnapshot => ({ agent: agent(value.agent), blockNumber: value.blockNumber,
    blockHash: value.blockHash, blockTimestamp: value.blockTimestamp, agentOwner: value.agentOwner, agentURI: value.agentURI });
  const candidate = evidence.candidate;
  const declaration = candidate.declaration;
  return structuredClone({ candidate: { observerOrigin: candidate.observerOrigin, agent: agent(candidate.agent), agentURI: candidate.agentURI,
    observationBlock: { number: candidate.observationBlock.number, hash: candidate.observationBlock.hash, timestamp: candidate.observationBlock.timestamp },
    declaration: { identifier: declaration.identifier, displayName: declaration.displayName, type: declaration.type,
      url: declaration.url, description: declaration.description, capabilityIds: [...declaration.capabilityIds],
      areaServed: [...declaration.areaServed], interfaces: [...declaration.interfaces] } },
    cardBase64: evidence.cardBase64, request: request.envelope, acceptance: acceptance.envelope,
    ...(completion ? { completion: completion.envelope } : {}),
    task, basisObservation: observation(evidence.basisObservation),
    currentObservation: observation(evidence.currentObservation), observedAt: evidence.observedAt });
}

const stageSchema = z.strictObject({ cryptography: z.enum(['valid', 'invalid', 'unsupported']),
  signerBinding: z.enum(['matched', 'mismatched']), profileBasis: z.enum(['matched', 'mismatched', 'unavailable']),
  currentAuthority: z.enum(['authorized', 'unauthorized', 'unavailable']), continuity: z.enum(['unchanged', 'changed', 'unknown']),
  deadline: z.enum(['live', 'expired']), claimedTime: z.enum(['observed', 'future']),
  link: z.enum(['matched', 'mismatched', 'not-applicable']), answerBinding: z.enum(['matched', 'mismatched', 'unavailable', 'not-applicable']),
  historicalExistence: z.literal('unknown'), usableAtObservation: z.boolean(),
  terminalOutcome: z.enum(['completed', 'failed', 'expired', 'cancelled']).optional() });
function projectStage(value: StageFinding): StageFinding {
  return stageSchema.parse({ cryptography: value.cryptography, signerBinding: value.signerBinding, profileBasis: value.profileBasis,
    currentAuthority: value.currentAuthority, continuity: value.continuity, deadline: value.deadline, claimedTime: value.claimedTime,
    link: value.link, answerBinding: value.answerBinding, historicalExistence: value.historicalExistence,
    usableAtObservation: value.usableAtObservation, ...(value.terminalOutcome ? { terminalOutcome: value.terminalOutcome } : {}) }) as StageFinding;
}
export type EarlierByteCheck = { observedAt: string; answerBinding: StageFinding['answerBinding']; evidenceUsable: boolean };
/** Unknown envelope methods remain private; never relabel them as supported. */
function publicReceiptEnvelope(envelope: SignedEnvelope) {
  if (envelope.scheme !== 'eip712-eoa' || envelope.signer.method !== 'eip155-eoa') return undefined;
  return { version: '0.1' as const, scheme: 'eip712-eoa' as const,
    signer: { method: 'eip155-eoa' as const, chainId: envelope.signer.chainId, address: envelope.signer.address },
    payloadBase64: envelope.payloadBase64, signature: envelope.signature };
}
export function projectReceiptSummary(evidence: JourneyEvidence, report: JourneyReport, policy: LicensedRetention,
  now: string, available = false, earlier?: EarlierByteCheck) {
  const retention = licensedRetentionSchema.parse(policy);
  const request = decodeEnvelope(evidence.request).statement;
  const acceptance = decodeEnvelope(evidence.acceptance);
  const completion = evidence.completion ? decodeEnvelope(evidence.completion) : undefined;
  if (request.value.kind !== 'request' || acceptance.statement.value.kind !== 'acceptance' ||
      acceptance.statement.value.requestDigest !== request.digest ||
      (completion && (completion.statement.value.kind !== 'completion' || completion.statement.value.acceptanceDigest !== acceptance.statement.digest))) {
    throw new Error('receipt summary requires linked request and provider receipt kinds');
  }
  const content = contentFinding(retention, now, available);
  const publicAcceptance = publicReceiptEnvelope(acceptance.envelope);
  const publicCompletion = completion ? publicReceiptEnvelope(completion.envelope) : undefined;
  return { mode: 'licensed-receipts-only' as const, retention,
    taskId: z.string().uuid().parse(evidence.task.id), contextId: z.string().uuid().parse(evidence.task.contextId),
    interactionId: request.value.interactionId, requestDigest: request.digest,
    acceptanceDigest: acceptance.statement.digest,
    ...(publicAcceptance ? { acceptance: publicAcceptance } : { acceptanceOmitted: 'unsupported-envelope' as const }),
    ...(completion ? { completionDigest: completion.statement.digest,
      ...(publicCompletion ? { completion: publicCompletion } : { completionOmitted: 'unsupported-envelope' as const }) } : {}),
    providerOutcome: completion?.statement.value.kind === 'completion' ? completion.statement.value.outcome : 'unresolved',
    content, findings: { discovery: z.enum(['verified', 'rejected', 'unavailable']).parse(report.discovery.status),
      ...(report.request ? { request: projectStage(report.request) } : {}),
      ...(report.acceptance ? { acceptance: projectStage(report.acceptance) } : {}),
      ...(report.completion ? { completion: projectStage(report.completion) } : {}),
      continuity: z.enum(['unchanged', 'changed', 'unknown', 'not-tested']).parse(report.continuity),
      execution: z.enum(['completed', 'failed', 'inconsistent', 'not-tested']).parse(report.execution),
      evidenceUsable: z.boolean().parse(report.evidenceUsable), contentValidation: z.literal('not-tested').parse(report.contentValidation),
      firstBrokenBoundary: z.enum(['evidence', 'discovery', 'authority-basis', 'current-authority', 'authority-continuity',
        'interaction', 'acceptance', 'execution', 'answer']).nullable().parse(report.firstBrokenBoundary) },
    ...(earlier ? { earlierByteCheck: { observedAt: z.string().refine(isUtcSecond).parse(earlier.observedAt),
      answerBinding: stageSchema.shape.answerBinding.parse(earlier.answerBinding), evidenceUsable: z.boolean().parse(earlier.evidenceUsable) } } : {}),
    notice: 'Public receipt/findings summary only; separate private evidence is required for verification. Earlier byte checks are observations, not current semantic replay.' };
}
export type ReceiptSummary = ReturnType<typeof projectReceiptSummary>;
