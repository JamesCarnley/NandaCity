import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Address } from 'viem';

import { CITY_REQUEST_DATA_TYPE } from '../a2a/service.js';
import { a2aTaskSchema, type A2ATask } from '../a2a/wire.js';
import type { DiscoveredCandidate } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import type { AgentRef } from '../identity/verify.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../interaction/schema.js';
import { INDEX_SOURCE_COMMIT } from './indexProcesses.js';
import { verifyJourneyEvidence, type JourneyEvidence, type JourneyReport } from './journeyReport.js';
import { checkOwnedCancellation, ownedFetch } from './ownedLifecycle.js';
import { withSixServiceFixture, type FixtureService, type SixServiceFixture } from './sixServiceFixture.js';

type City = FixtureService['city'];
type VerifiedCase = { evidence: JourneyEvidence; report: JourneyReport };
type Calls = { messageSend: number; tasksGet: number; exactRetries: number };
const execFileAsync = promisify(execFile);

export type SixServiceJourneyResult = {
  mode: 'local-fixture';
  indexSourceCommit: string;
  /** These loopback origins stop when this function returns. */
  indexOrigins: { A: string; B: string };
  alternatives: Array<{
    city: City; emphasis: FixtureService['emphasis']; operatorIndex: number;
    agent: AgentRef; ownerAddress: Address; runtimeAddress: Address;
    success: VerifiedCase;
  }>;
  retry: { agent: AgentRef; taskId: string; sameTask: true };
  fault: { agent: AgentRef; evidence: JourneyEvidence; report: JourneyReport };
  executionOrder: Array<{ agentId: string; outcome: 'completed' | 'failed' }>;
  calls: Calls;
  independentProcessVerified: boolean;
  tamperRejected: boolean;
  cleanup: { ownedResourcesStopped: true };
  limitations: string[];
};

const MAX_RPC_RESPONSE_BYTES = 512 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const TASK_DEADLINE_MS = 20_000;

function utcNow(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function requestFor(service: FixtureService, fixture: SixServiceFixture, fail: boolean): CityRequest {
  const createdAt = utcNow();
  const deadline = new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z');
  const source = service.profile.source;
  return {
    kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: service.agent },
    caller: { method: 'eip155-eoa', chainId: fixture.domain.chainId,
      address: fixture.callerAddress.toLowerCase() as Address },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: {
      blockNumber: source.blockNumber,
      blockHash: source.blockHash.toLowerCase() as `0x${string}`,
      agentOwner: source.agentOwner.toLowerCase() as Address,
      agentUriDigest: source.agentUriDigest.toLowerCase() as `0x${string}`,
      registrationDigest: source.registrationDigest.toLowerCase() as `0x${string}`,
      cardDigest: source.cardDigest.toLowerCase() as `0x${string}`,
      receiptSigner: service.runtimeAddress.toLowerCase() as Address,
    },
    createdAt, deadline,
    input: {
      version: '0.1', capability: 'evening-plan', city: service.city,
      timeWindow: service.city === 'Chicago'
        ? { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
          timeZone: 'America/Chicago' }
        : { start: '2026-10-02T18:00:00-04:00', end: '2026-10-02T22:00:00-04:00',
          timeZone: 'America/New_York' },
      area: service.city === 'Chicago' ? 'The Loop' : 'Back Bay',
      budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'],
      preferences: fail ? ['Fixture request', 'Trigger provider fault'] : ['Fixture request'],
    },
  };
}

async function boundedRpcJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('owned A2A endpoint returned no body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('owned A2A response exceeded the 512 KiB limit');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function rpcTask(serviceUrl: string, method: 'message/send' | 'tasks/get',
  params: unknown, calls: Calls): Promise<A2ATask> {
  checkOwnedCancellation();
  if (method === 'message/send') calls.messageSend++;
  else calls.tasksGet++;
  const id = randomUUID();
  const response = await ownedFetch(serviceUrl, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`owned A2A endpoint HTTP ${response.status}`);
  const body = await boundedRpcJson(response) as Record<string, unknown>;
  if (body['jsonrpc'] !== '2.0' || body['id'] !== id) {
    throw new Error('owned A2A response has the wrong JSON-RPC identity');
  }
  if (body['error'] !== undefined) throw new Error(`owned A2A ${method} rejected: ${JSON.stringify(body['error'])}`);
  return a2aTaskSchema.parse(body['result']);
}

async function terminalTask(serviceUrl: string, taskId: string, calls: Calls): Promise<A2ATask> {
  const deadline = Date.now() + TASK_DEADLINE_MS;
  while (Date.now() < deadline) {
    checkOwnedCancellation();
    const task = await rpcTask(serviceUrl, 'tasks/get', { id: taskId }, calls);
    if (task.id !== taskId) throw new Error('owned A2A task identity changed during polling');
    if (task.status.state === 'completed' || task.status.state === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('owned A2A Task did not reach a terminal state in 20 seconds');
}

function matchingCandidate(fixture: SixServiceFixture, service: FixtureService): DiscoveredCandidate {
  const search = fixture.searches[service.city];
  const a = search.A.result.candidates.find((candidate) => candidate.agent.agentId === service.agent.agentId);
  const b = search.B.result.candidates.find((candidate) => candidate.agent.agentId === service.agent.agentId);
  if (!a || !b || a.agentURI !== b.agentURI ||
      JSON.stringify(a.declaration) !== JSON.stringify(b.declaration) ||
      a.declaration.url !== `${fixture.cardOrigin}/cards/${service.agent.agentId}.json` ||
      service.profile.card.url !== service.serviceUrl ||
      search.A.verdicts.some((item) => item.status !== 'verified') ||
      search.B.verdicts.some((item) => item.status !== 'verified')) {
    throw new Error('service is not identically discovered and verified through both owned Indexes');
  }
  return a;
}

function sendParams(request: SignedEnvelope): Record<string, unknown> {
  return {
    message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
      data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
  };
}

async function invoke(service: FixtureService, fixture: SixServiceFixture,
  candidate: DiscoveredCandidate, calls: Calls, fail: boolean, retry: boolean): Promise<{
    verified: VerifiedCase; retry?: { taskId: string; sameTask: true };
  }> {
  const request = await fixture.signAsCaller(requestFor(service, fixture, fail));
  const params = sendParams(request);
  const submitted = await rpcTask(service.serviceUrl, 'message/send', params, calls);
  if (submitted.status.state !== 'submitted') throw new Error('service did not persist a submitted A2A Task');
  let retryResult: { taskId: string; sameTask: true } | undefined;
  if (retry) {
    const repeated = await rpcTask(service.serviceUrl, 'message/send', params, calls);
    calls.exactRetries++;
    if (repeated.id !== submitted.id || repeated.contextId !== submitted.contextId) {
      throw new Error('exact request retry created a second A2A Task');
    }
    retryResult = { taskId: repeated.id, sameTask: true };
  }
  const task = await terminalTask(service.serviceUrl, submitted.id, calls);
  if (task.status.state !== (fail ? 'failed' : 'completed')) {
    throw new Error(`owned A2A task ended ${task.status.state}, expected ${fail ? 'failed' : 'completed'}`);
  }
  const metadata = task.metadata?.['org.nandacity'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('terminal A2A Task lacks City evidence metadata');
  }
  const signed = metadata as Record<string, unknown>;
  const acceptance = envelopeSchema.parse(signed['acceptance']);
  const completion = envelopeSchema.parse(signed['completion']);
  const answer = task.artifacts?.[0]?.parts[0]?.data?.['answerBase64'];
  if (!fail && typeof answer !== 'string') throw new Error('completed A2A Task lacks answer bytes');
  if (fail && answer !== undefined) throw new Error('failed A2A Task contains a successful answer');
  const decoded = decodeEnvelope(request).statement.value;
  if (decoded.kind !== 'request') throw new Error('signed request has wrong statement kind');
  // Publication observation N belongs to the Index candidate; the signed request
  // names the later authority basis M and is always read independently by block.
  const basisObservation = await readIdentitySnapshot(fixture.chain, service.agent,
    BigInt(decoded.profileBasis.blockNumber));
  const currentObservation = await readIdentitySnapshot(fixture.chain, service.agent);
  const evidence: JourneyEvidence = {
    candidate, cardBase64: Buffer.from(service.cardBytes).toString('base64'), request,
    acceptance, completion, ...(typeof answer === 'string' ? { answerBase64: answer } : {}),
    task, basisObservation, currentObservation, observedAt: utcNow(),
  };
  // fixture.chain is a separate PublicClient from the service and owner clients.
  const report = await verifyJourneyEvidence(evidence, fixture.chain, fixture.domain,
    fixture.searches[service.city].A.filter, fixture.cardOrigin);
  if (!report.evidenceUsable || report.execution !== (fail ? 'failed' : 'completed')) {
    throw new Error(`owned journey evidence did not verify: ${JSON.stringify(report.reasons)}`);
  }
  return { verified: { evidence, report }, ...(retryResult ? { retry: retryResult } : {}) };
}

async function verifyInSeparateProcess(fixture: SixServiceFixture,
  batch: Pick<SixServiceJourneyResult, 'mode' | 'alternatives' | 'fault'>): Promise<{
    independentProcessVerified: true; tamperRejected: true;
  }> {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-six-verifier-'));
  const currentModule = fileURLToPath(import.meta.url);
  const builtMode = currentModule.endsWith('.js');
  const script = join(dirname(currentModule), `verifySixServiceCli.${builtMode ? 'js' : 'ts'}`);
  const cityRoot = resolve(dirname(currentModule), '../..');
  const args = (path: string) => [
    ...(builtMode ? [] : ['--import', 'tsx']), script,
    '--evidence', path, '--rpc-url', fixture.rpcOrigin, '--card-origin', fixture.cardOrigin,
    '--chain-id', String(fixture.domain.chainId), '--registry', fixture.domain.registry,
    '--genesis-hash', fixture.domain.genesisHash, '--implementation', fixture.domain.knownImplementation.address,
    '--implementation-code-hash', fixture.domain.knownImplementation.codeHash,
  ];
  const options = { cwd: cityRoot, env: { PATH: process.env['PATH'] ?? '' },
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const };
  try {
    const evidencePath = join(directory, 'original-evidence.json');
    await writeFile(evidencePath, JSON.stringify(batch), { mode: 0o600 });
    const { stdout } = await execFileAsync(process.execPath, args(evidencePath), options);
    const verified = JSON.parse(stdout) as { verified?: boolean; cases?: Array<{ report?: JourneyReport }>;
      fault?: { report?: JourneyReport } };
    if (verified.verified !== true || verified.cases?.length !== 6 ||
        verified.cases.some((item) => !item.report?.evidenceUsable || item.report.execution !== 'completed') ||
        !verified.fault?.report?.evidenceUsable || verified.fault.report.execution !== 'failed') {
      throw new Error('separate Node verifier did not confirm six successes and one accepted fault');
    }
    const tampered = structuredClone(batch);
    const bytes = Buffer.from(tampered.alternatives[0]!.success.evidence.answerBase64!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    tampered.alternatives[0]!.success.evidence.answerBase64 = bytes.toString('base64');
    const tamperedPath = join(directory, 'tampered-evidence.json');
    await writeFile(tamperedPath, JSON.stringify(tampered), { mode: 0o600 });
    let tamperRejected = false;
    try {
      await execFileAsync(process.execPath, args(tamperedPath), options);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      tamperRejected = /Six-service verification failed: batch completion/.test(stderr);
    }
    if (!tamperRejected) throw new Error('separate Node verifier did not reject changed answer bytes');
    return { independentProcessVerified: true, tamperRejected: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Six owned synthetic services, two actual local Indexes, and bounded signed A2A journeys. */
export async function runSixServiceJourney(indexCheckout: string): Promise<SixServiceJourneyResult> {
  const result = await withSixServiceFixture(indexCheckout, async (fixture) => {
    const calls: Calls = { messageSend: 0, tasksGet: 0, exactRetries: 0 };
    const alternatives: SixServiceJourneyResult['alternatives'] = [];
    const executionOrder: SixServiceJourneyResult['executionOrder'] = [];
    let firstRetry: { agent: AgentRef; taskId: string; sameTask: true } | undefined;
    let acceptedFault: VerifiedCase | undefined;
    const faultService = fixture.services[0]!;
    for (const service of fixture.services) {
      const candidate = matchingCandidate(fixture, service);
      const invoked = await invoke(service, fixture, candidate, calls, false, alternatives.length === 0);
      alternatives.push({ city: service.city, emphasis: service.emphasis,
        operatorIndex: service.operatorIndex, agent: service.agent,
        ownerAddress: service.ownerAddress, runtimeAddress: service.runtimeAddress,
        success: invoked.verified });
      executionOrder.push({ agentId: service.agent.agentId, outcome: 'completed' });
      if (invoked.retry) firstRetry = { agent: service.agent, ...invoked.retry };
      if (alternatives.length === 1) {
        acceptedFault = (await invoke(faultService, fixture,
          matchingCandidate(fixture, faultService), calls, true, false)).verified;
        executionOrder.push({ agentId: faultService.agent.agentId, outcome: 'failed' });
      }
    }
    if (!firstRetry || !acceptedFault) throw new Error('exact retry or accepted fault was not recorded');
    const batch = { mode: 'local-fixture' as const, alternatives,
      fault: { agent: faultService.agent, ...acceptedFault } };
    const independent = await verifyInSeparateProcess(fixture, batch);
    return {
      mode: 'local-fixture' as const, indexSourceCommit: INDEX_SOURCE_COMMIT,
      indexOrigins: fixture.indexOrigins, alternatives, retry: firstRetry,
      fault: batch.fault, executionOrder, calls, ...independent,
      limitations: [
        'Authored synthetic fixture plans only; no live venue, event, price, travel, accessibility, or semantic-quality check.',
        'Three simulated operators have shared local code and one hosting failure domain; they are not independent businesses.',
        'Both local Indexes and the Ethereum chain stop at cleanup; exported observations are not durable state proofs.',
        'Separate Node verification uses the same owned test host and loopback chain; it is process separation, not an independent operator or state proof.',
        'Comparing three alternatives makes three service calls per city; no ranking or trust endorsement is asserted.',
      ],
    };
  });
  return { ...result, cleanup: { ownedResourcesStopped: true } };
}

/** Human comparison of already-verified authored plans; not a semantic-quality verdict. */
export function formatComparePlain(result: SixServiceJourneyResult): string {
  const lines = ['NANDA City local six-service comparison (synthetic fixture)'];
  for (const city of ['Chicago', 'Boston'] as const) {
    const items = result.alternatives.filter((item) => item.city === city);
    lines.push(`${city} (${items.length} verified alternatives)`);
    for (const item of items) {
      const answer = JSON.parse(Buffer.from(item.success.evidence.answerBase64!, 'base64').toString('utf8')) as {
        schedule: Array<{ place: string }>;
        route: { mode: string };
        budget: { estimatedTotalMinorUnits: number };
      };
      const label = { food: 'Food', culture: 'Culture', 'travel-value': 'Travel/Value' }[item.emphasis];
      lines.push(`  ${label} (fixture operator ${item.operatorIndex + 1}, agent ${item.agent.agentId}): ` +
        `${answer.schedule[0]!.place} → ${answer.schedule[1]!.place}; ` +
        `${answer.route.mode}; example $${(answer.budget.estimatedTotalMinorUnits / 100).toFixed(2)} (not a verified quote).`);
    }
  }
  lines.push('Sources: authored fixture concepts, conceptual routes, and example cost allocations; no live venue, event, availability, price, travel-time, accessibility, or quality check.');
  lines.push(`Verification: ${result.alternatives.length} signed completions and one separate accepted/failed case rechecked by a separate Node process against the live local RPC and exact cards; same test host, not independent real-world custody.`);
  lines.push(`Calls: 7 service calls for six plans plus the accepted fault, and 1 exact retry returned the same task (8 message/send attempts total).`);
  lines.push('Scope: simulated operators share local code/hosting; no reputation ranking, independent business custody, or trust endorsement.');
  lines.push('Ephemeral: local chain and Indexes stopped at cleanup; JSON is not a durable authority proof.');
  return lines.join('\n');
}
