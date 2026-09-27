import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createPublicClient, http, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { eveningPlanInputSchema, type EveningPlanInput } from '../a2a/input.js';

import { CITY_REQUEST_DATA_TYPE } from '../a2a/wire.js';
import { a2aTaskSchema, type A2ATask } from '../a2a/wire.js';
import { searchIndexes } from '../discovery/indexClient.js';
import { fetchOwnedCard } from '../discovery/cardClient.js';
import { verifyDiscoveryAtCurrentChain, type DiscoveredCandidate,
  type ServiceFilter } from '../discovery/verifyDiscovery.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
export { boundedRpcFetch } from '../identity/rpcTransport.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { decodeEnvelope, signRequest } from '../interaction/signatures.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../interaction/schema.js';
import { verifyJourneyEvidence, type JourneyEvidence, type JourneyReport } from '../demo/journeyReport.js';
import { retentionSchema, licensedRetentionSchema, TransientByteHolder, contentFinding, projectReceiptEvidence,
  projectReceiptSummary, type Retention, type LicensedRetention, type ContentFinding, type EarlierByteCheck, type ReceiptSummary } from '../live/retention.js';

export type City = 'Chicago' | 'Boston';
export type ExternalClientConfig = {
  /** Programmatic only: never serialize a caller key in CLI arguments. */
  live?: { input: EveningPlanInput; caller: PrivateKeyAccount };
  retention?: Retention;
  city: City;
  indexOrigins: [string, string];
  rpcOrigin: string;
  cardOrigin: string;
  serviceOrigins: string[];
  domain: IdentityContinuityDomain;
  chosenAgentId?: string;
};
export type ExternalClientResult = {
  city: City;
  selectedAgentId: string;
  selectionReason: string;
  callerAddress: Address;
  evidence: JourneyEvidence;
  report: JourneyReport;
  retry: { sameTask: true; taskId: string };
  childVerified: true;
};
export type RetainedJourney = { retention: LicensedRetention; evidence: JourneyEvidence; report: JourneyReport;
  earlierByteCheck?: EarlierByteCheck; content: () => ContentFinding;
  /** Server-only disposable byte copy. Never serialize or cache this capability's result. */
  readContent: () => Uint8Array | undefined; close: () => void };
export type LicensedExternalClientResult = Omit<ExternalClientResult, 'childVerified' | 'evidence' | 'report'> & RetainedJourney & {
  mode: 'licensed-receipts-only'; childVerified: false;
};

/** Takes ownership only of a bounded byte copy; all returned evidence is receipt-only.
 * Verification receives the effective local/runtime policy, never the longer configured ceiling. */
export async function retainLicensedJourney(evidence: JourneyEvidence, configured: LicensedRetention,
  verify: (safe: JourneyEvidence, bytes: Uint8Array | undefined, retention: LicensedRetention) => Promise<JourneyReport>, now: () => string = utcNow): Promise<RetainedJourney> {
  const local = licensedRetentionSchema.parse(configured);
  const metadata = evidence.task.metadata?.['org.nandacity'] as Record<string, unknown> | undefined;
  const runtime = licensedRetentionSchema.safeParse(metadata?.retention);
  if (!runtime.success || runtime.data.policyId !== local.policyId) throw new Error('incompatible runtime retention policy');
  // Response metadata may restrict local permission, never grant or extend it.
  const retention = Object.freeze({ ...local, expiresAt: Date.parse(runtime.data.expiresAt) < Date.parse(local.expiresAt) ? runtime.data.expiresAt : local.expiresAt });
  const holder = new TransientByteHolder(now);
  const safe = projectReceiptEvidence(evidence);
  const taskId = safe.task.id;
  try {
    const encoded = evidence.answerBase64 ?? evidence.task.artifacts?.[0]?.parts[0]?.data.answerBase64;
    if (encoded !== undefined && contentFinding(retention, now()).contentAvailability !== 'expired') {
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(256 * 1024 / 3) * 4 ||
          !encoded.length) throw new Error('invalid transient answer encoding');
      const decoded = Buffer.from(encoded, 'base64');
      try {
        if (decoded.toString('base64') !== encoded) throw new Error('invalid transient answer encoding');
        const nested = evidence.task.artifacts?.[0]?.parts[0]?.data.answerBase64;
        if (nested !== undefined && nested !== encoded) throw new Error('transient answer copies disagree');
        holder.put(taskId, decoded, retention);
      } finally { decoded.fill(0); }
    }
    let earlierByteCheck: EarlierByteCheck | undefined;
    const bytes = holder.read(taskId);
    if (bytes) {
      const observedAt = now();
      try {
        const earlier = await verify(safe, bytes, retention);
        earlierByteCheck = { observedAt, answerBinding: earlier.completion?.answerBinding ?? 'unavailable', evidenceUsable: earlier.evidenceUsable };
      } finally { bytes.fill(0); }
    }
    const report = await verify(safe, undefined, retention);
    return { retention, evidence: safe, report,
      ...(earlierByteCheck ? { earlierByteCheck } : {}),
      content: () => contentFinding(retention, now(), holder.has(taskId)),
      readContent: () => holder.read(taskId), close: () => holder.close() };
  } catch (error) { holder.close(); throw error; }
}

export function projectExternalClientResult(result: LicensedExternalClientResult, now?: () => string): ReceiptSummary;
export function projectExternalClientResult(result: ExternalClientResult, now?: () => string): ExternalClientResult;
export function projectExternalClientResult(result: ExternalClientResult | LicensedExternalClientResult, now?: () => string): ExternalClientResult | ReceiptSummary;
export function projectExternalClientResult(result: ExternalClientResult | LicensedExternalClientResult, now: () => string = utcNow): ExternalClientResult | ReceiptSummary {
  if (!('retention' in result)) return result;
  return projectReceiptSummary(result.evidence, result.report, result.retention, now(),
    result.content().contentAvailability === 'available', result.earlierByteCheck);
}

const MAX_RPC_BYTES = 512 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const TASK_TIMEOUT_MS = 20_000;

export function exactLoopbackOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== raw.replace(/\/$/, '')) {
    throw new Error('client origins must be exact 127.0.0.1 HTTP origins');
  }
  return url.origin;
}

export function filterForCity(city: City): ServiceFilter {
  return { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
    areaServed: [city === 'Chicago' ? 'https://www.wikidata.org/entity/Q1297' :
      'https://www.wikidata.org/entity/Q100'],
    interfaces: ['application/a2a+json;version=0.3'] };
}

function serviceUrlAllowed(raw: string, origins: Set<string>): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !origins.has(url.origin) || url.pathname !== '/' || url.username || url.password ||
      url.search || url.hash || url.href !== `${url.origin}/`) {
    throw new Error('selected service URL outside exact configured origin');
  }
  return url.href;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) throw new Error('A2A redirect refused');
  if (!response.ok) throw new Error(`A2A HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RPC_BYTES) throw new Error('A2A response exceeds 512 KiB');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('A2A response has no body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RPC_BYTES) throw new Error('A2A response exceeds 512 KiB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('A2A response is not JSON'); }
}

/** Bounded JSON-RPC task read for an already allowlisted service URL. */
export async function rpcTask(url: string, method: 'message/send' | 'tasks/get', params: unknown,
  timeoutMs = RPC_TIMEOUT_MS, signal?: AbortSignal): Promise<A2ATask> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > RPC_TIMEOUT_MS) {
    throw new Error('invalid A2A request deadline');
  }
  const id = randomUUID();
  signal?.throwIfAborted();
  const response = await fetch(url, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  let raw: unknown;
  try { raw = await boundedJson(response); }
  catch (error) { signal?.throwIfAborted(); throw error; }
  finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A2A response is not an object');
  const body = raw as Record<string, unknown>;
  if (body['jsonrpc'] !== '2.0' || body['id'] !== id) throw new Error('A2A JSON-RPC identity changed');
  if (body['error'] !== undefined) throw new Error(`A2A ${method} rejected`);
  return a2aTaskSchema.parse(body['result']);
}

/** Poll an already allowlisted A2A service until completion or a bounded task deadline. */
export async function pollTerminalTask(url: string, taskId: string,
  timeoutMs = TASK_TIMEOUT_MS, mode: 'fixture' | 'live' = 'fixture', signal?: AbortSignal): Promise<A2ATask> {
  if (!['fixture', 'live'].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > (mode === 'live' ? 65_000 : TASK_TIMEOUT_MS)) {
    throw new Error('invalid task deadline');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let polled: A2ATask;
    try {
      polled = await rpcTask(url, 'tasks/get', { id: taskId },
        Math.max(1, Math.min(RPC_TIMEOUT_MS, remaining)), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline ||
          (error instanceof Error && error.name === 'TimeoutError' && remaining <= RPC_TIMEOUT_MS)) {
        throw new Error('A2A task deadline expired', { cause: error });
      }
      throw error;
    }
    if (Date.now() >= deadline) throw new Error('A2A task deadline expired');
    if (polled.id !== taskId) throw new Error('A2A task changed identity during polling');
    if (polled.status.state === 'completed' || polled.status.state === 'failed') return polled;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error('A2A task deadline expired');
}

function utcNow(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function requestFor(candidate: DiscoveredCandidate, profile: Awaited<ReturnType<typeof verifyDiscoveryAtCurrentChain>> &
  { status: 'verified' }, city: City, callerAddress: Address): CityRequest {
  const source = profile.profile.source;
  const createdAt = utcNow();
  return { kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: candidate.agent },
    caller: { method: 'eip155-eoa', chainId: candidate.agent.chainId,
      address: callerAddress.toLowerCase() as Address },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: { blockNumber: source.blockNumber,
      blockHash: source.blockHash.toLowerCase() as `0x${string}`,
      agentOwner: source.agentOwner.toLowerCase() as Address,
      agentUriDigest: source.agentUriDigest.toLowerCase() as `0x${string}`,
      registrationDigest: source.registrationDigest.toLowerCase() as `0x${string}`,
      cardDigest: source.cardDigest.toLowerCase() as `0x${string}`,
      receiptSigner: profile.profile.registration['x-nandacity'].receiptSigner.toLowerCase() as Address },
    createdAt, deadline: new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z'),
    input: { version: '0.1', capability: 'evening-plan', city,
      timeWindow: city === 'Chicago' ?
        { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
          timeZone: 'America/Chicago' } :
        { start: '2026-10-02T18:00:00-04:00', end: '2026-10-02T22:00:00-04:00',
          timeZone: 'America/New_York' },
      area: city === 'Chicago' ? 'The Loop' : 'Back Bay',
      budget: { currency: 'USD', minorUnits: '8500' }, transport: ['walk', 'public-transit'],
      preferences: ['External client example'] },
  };
}

function sameCandidate(a: DiscoveredCandidate, b: DiscoveredCandidate): boolean {
  return a.agent.chainId === b.agent.chainId &&
    a.agent.registry.toLowerCase() === b.agent.registry.toLowerCase() &&
    a.agent.agentId === b.agent.agentId && a.agentURI === b.agentURI &&
    JSON.stringify(a.declaration) === JSON.stringify(b.declaration);
}

/** City-authored separate-process example; owns its caller signing key in this process only. */
export function runExternalClient(config: ExternalClientConfig & { retention: LicensedRetention }): Promise<LicensedExternalClientResult>;
export function runExternalClient(config: ExternalClientConfig & { retention?: Extract<Retention, { kind: 'authored-fixture' }> }): Promise<ExternalClientResult>;
export function runExternalClient(config: ExternalClientConfig): Promise<ExternalClientResult | LicensedExternalClientResult>;
export async function runExternalClient(config: ExternalClientConfig): Promise<ExternalClientResult | LicensedExternalClientResult> {
  const retention = config.retention === undefined ? undefined : retentionSchema.parse(config.retention);
  if (config.live && (retention?.kind !== 'licensed' || eveningPlanInputSchema.parse(config.live.input).city !== config.city ||
      !/^0x[0-9a-fA-F]{40}$/.test(config.live.caller.address))) throw new Error('invalid live caller configuration');
  if (config.city !== 'Chicago' && config.city !== 'Boston') throw new Error('unsupported city');
  const indexOrigins = config.indexOrigins.map(exactLoopbackOrigin);
  if (indexOrigins.length !== 2 || indexOrigins[0] === indexOrigins[1]) throw new Error('two distinct Index origins required');
  const rpcOrigin = exactLoopbackOrigin(config.rpcOrigin);
  const cardOrigin = exactLoopbackOrigin(config.cardOrigin);
  const serviceOrigins = new Set(config.serviceOrigins.map(exactLoopbackOrigin));
  if (serviceOrigins.size === 0 || serviceOrigins.size !== config.serviceOrigins.length) {
    throw new Error('distinct service origins required');
  }
  if (!Number.isSafeInteger(config.domain.chainId) || config.domain.chainId <= 0 ||
      !/^0x[0-9a-fA-F]{40}$/.test(config.domain.registry)) throw new Error('invalid selected identity domain');
  const chain = createPublicClient({ transport: http(rpcOrigin, { retryCount: 0, timeout: RPC_TIMEOUT_MS,
    fetchFn: boundedRpcFetch }) });
  if (await chain.getChainId() !== config.domain.chainId) throw new Error('independent RPC is not selected chain');
  const filter = filterForCity(config.city);
  const search = await searchIndexes(indexOrigins, filter);
  if (search.origins.some((origin) => !origin.available || origin.errors.length || !origin.coverage)) {
    throw new Error('Index search unavailable or rejected');
  }
  const byIndex = indexOrigins.map((origin) => search.candidates.filter((item) => item.observerOrigin === origin));
  if (byIndex.some((items) => items.length !== 3)) throw new Error('expected three candidates from each Index');
  if (byIndex.some((items) => new Set(items.map((item) => item.agent.agentId)).size !== 3)) {
    throw new Error('Index returned duplicate city candidates');
  }
  const verified: Array<{ candidate: DiscoveredCandidate; cardBytes: Uint8Array;
    verdict: Awaited<ReturnType<typeof verifyDiscoveryAtCurrentChain>> & { status: 'verified' } }> = [];
  for (const candidate of byIndex[0]!) {
    const counterpart = byIndex[1]!.find((item) => sameCandidate(candidate, item));
    if (!counterpart) throw new Error('Index observations disagree');
    const cardBytes = await fetchOwnedCard(candidate.declaration.url, cardOrigin);
    const verdict = await verifyDiscoveryAtCurrentChain(candidate, chain, config.domain, cardBytes, filter);
    if (verdict.status !== 'verified') throw new Error(`discovery ${verdict.status}: ${verdict.reason}`);
    const second = await verifyDiscoveryAtCurrentChain(counterpart, chain, config.domain, cardBytes, filter);
    if (second.status !== 'verified') throw new Error(`second Index discovery ${second.status}: ${second.reason}`);
    serviceUrlAllowed(verdict.profile.card.url, serviceOrigins);
    verified.push({ candidate, cardBytes, verdict });
  }
  verified.sort((a, b) => BigInt(a.candidate.agent.agentId) < BigInt(b.candidate.agent.agentId) ? -1 :
    BigInt(a.candidate.agent.agentId) > BigInt(b.candidate.agent.agentId) ? 1 : 0);
  const selected = config.chosenAgentId ? verified.find((item) => item.candidate.agent.agentId === config.chosenAgentId) :
    verified[0];
  if (!selected) throw new Error('chosen agent is not a verified city candidate');
  const url = serviceUrlAllowed(selected.verdict.profile.card.url, serviceOrigins);
  const account = config.live?.caller ?? privateKeyToAccount(generatePrivateKey());
  const unsigned = requestFor(selected.candidate, selected.verdict, config.city, account.address);
  if (config.live) unsigned.input = eveningPlanInputSchema.parse(config.live.input);
  const request = await signRequest(unsigned, account);
  const params = { message: { kind: 'message', role: 'user', messageId: randomUUID(),
    parts: [{ kind: 'data', data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] } };
  const submitted = await rpcTask(url, 'message/send', params);
  if (submitted.status.state !== 'submitted') throw new Error('A2A request not persisted as submitted');
  const repeated = await rpcTask(url, 'message/send', params);
  if (repeated.id !== submitted.id || repeated.contextId !== submitted.contextId) {
    throw new Error('exact retry created a different task');
  }
  const task = await pollTerminalTask(url, submitted.id, config.live ? 65_000 : TASK_TIMEOUT_MS, config.live ? 'live' : 'fixture');
  if (task.status.state !== 'completed' && retention?.kind !== 'licensed') throw new Error('A2A task did not complete successfully');
  const metadata = task.metadata?.['org.nandacity'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('A2A evidence metadata missing');
  const signed = metadata as Record<string, unknown>;
  const acceptance = envelopeSchema.parse(signed['acceptance']);
  const completion = retention?.kind === 'licensed' && signed['completion'] === undefined ? undefined : envelopeSchema.parse(signed['completion']);
  const answerBase64 = task.artifacts?.[0]?.parts[0]?.data?.['answerBase64'];
  if (retention?.kind !== 'licensed' && typeof answerBase64 !== 'string') throw new Error('A2A answer bytes missing');
  const decoded = decodeEnvelope(request).statement.value;
  if (decoded.kind !== 'request') throw new Error('signed request kind changed');
  const evidence: JourneyEvidence = { candidate: selected.candidate,
    cardBase64: Buffer.from(selected.cardBytes).toString('base64'), request, acceptance, ...(completion ? { completion } : {}),
    ...(typeof answerBase64 === 'string' ? { answerBase64 } : {}), task,
    basisObservation: await readIdentitySnapshot(chain, selected.candidate.agent,
      BigInt(decoded.profileBasis.blockNumber)),
    currentObservation: await readIdentitySnapshot(chain, selected.candidate.agent), observedAt: utcNow() };
  if (retention?.kind === 'licensed') {
    const retained = await retainLicensedJourney(evidence, retention, (safe, bytes, effectiveRetention) => verifyJourneyEvidence(safe,
      chain, config.domain, filter, cardOrigin, { retention: effectiveRetention, ...(bytes ? { answerBytes: bytes } : {}) }));
    return { ...retained, mode: 'licensed-receipts-only', city: config.city,
      selectedAgentId: selected.candidate.agent.agentId, selectionReason: 'configured licensed receipt-only result',
      callerAddress: account.address.toLowerCase() as Address, retry: { sameTask: true, taskId: repeated.id }, childVerified: false };
  }
  const report = await verifyJourneyEvidence(evidence, chain, config.domain, filter, cardOrigin);
  if (!report.evidenceUsable || report.execution !== 'completed' || report.firstBrokenBoundary !== null) {
    throw new Error(`external client evidence failed at ${report.firstBrokenBoundary ?? 'unknown'}`);
  }
  return { city: config.city, selectedAgentId: selected.candidate.agent.agentId,
    selectionReason: config.chosenAgentId ? 'explicit verified agent ID' :
      'lowest numeric agent ID among three verified city candidates; demo order, not reputation',
    callerAddress: account.address.toLowerCase() as Address, evidence, report,
    retry: { sameTask: true, taskId: repeated.id }, childVerified: true };
}
