import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPublicClient, http, isAddress, type Address, type Hex, type PublicClient } from 'viem';

import type { ServiceFilter } from '../discovery/verifyDiscovery.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
import type { AgentRef } from '../identity/verify.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { boston, chicago } from './registryFixture.js';
import { verifyJourneyEvidence, type JourneyEvidence, type JourneyReport } from './journeyReport.js';
import type { SixServiceJourneyResult } from './sixServiceJourney.js';

type City = 'Chicago' | 'Boston';
type Batch = Pick<SixServiceJourneyResult, 'mode' | 'alternatives' | 'fault'>;
export type SixServiceVerification = {
  cases: Array<{ city: City; agentId: string; report: JourneyReport }>;
  fault: { agentId: string; report: JourneyReport };
  verified: true;
};

const usage = 'Usage: node --import tsx src/demo/verifySixServiceCli.ts --evidence /absolute/file.json --rpc-url http://127.0.0.1:PORT --card-origin http://127.0.0.1:PORT --chain-id 31337 --registry 0x... --genesis-hash 0x... --implementation 0x... --implementation-code-hash 0x...';
const emphases = ['food', 'culture', 'travel-value'] as const;

function option(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length || args.indexOf(flag, index + 1) >= 0) throw new Error(usage);
  return args[index + 1]!;
}

function loopbackOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== raw.replace(/\/$/, '')) {
    throw new Error('verifier RPC and card origin must be exact 127.0.0.1 HTTP origins');
  }
  return url.origin;
}

function filterFor(city: City): ServiceFilter {
  return { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
    areaServed: [city === 'Chicago' ? chicago : boston],
    interfaces: ['application/a2a+json;version=0.3'] };
}

function requestOf(evidence: JourneyEvidence) {
  const request = decodeEnvelope(evidence.request).statement.value;
  if (request.kind !== 'request') throw new Error('batch case has no signed request');
  return request;
}

function sameAgent(left: AgentRef, right: AgentRef): boolean {
  return left.chainId === right.chainId &&
    left.registry.toLowerCase() === right.registry.toLowerCase() &&
    left.agentId === right.agentId;
}

function checkAnswerShape(evidence: JourneyEvidence, city: City, emphasis: string): void {
  if (!evidence.answerBase64) throw new Error('completed case lacks answer bytes');
  const answer = JSON.parse(Buffer.from(evidence.answerBase64, 'base64').toString('utf8')) as Record<string, unknown>;
  const budget = answer['budget'] as Record<string, unknown> | undefined;
  const sources = answer['sources'];
  const schedule = answer['schedule'];
  if (answer['kind'] !== 'synthetic-evening-plan' || answer['city'] !== city ||
      answer['emphasis'] !== emphasis || answer['liveDataChecked'] !== false ||
      !Array.isArray(schedule) || schedule.length !== 2 || !answer['route'] ||
      !budget || budget['estimateOnly'] !== true ||
      !Array.isArray(sources) || sources.length === 0 ||
      !sources.every((source) => source && typeof source === 'object' &&
        (source as Record<string, unknown>)['kind'] === 'authored-fixture' &&
        (source as Record<string, unknown>)['live'] === false)) {
    throw new Error('answer is not a complete, source-labeled synthetic fixture plan');
  }
}

function usable(report: JourneyReport, execution: 'completed' | 'failed'): boolean {
  return report.evidenceUsable && report.discovery.status === 'verified' &&
    report.continuity === 'unchanged' && report.execution === execution &&
    report.request?.cryptography === 'valid' && report.acceptance?.cryptography === 'valid' &&
    report.completion?.cryptography === 'valid' && report.completion.signerBinding === 'matched' &&
    report.completion.terminalOutcome === execution &&
    (execution === 'failed' || report.completion.answerBinding === 'matched');
}

/** A separate process rechecks each original envelope against caller-selected live loopback authority. */
export async function verifySixServiceBatch(raw: unknown, client: PublicClient,
  domain: IdentityContinuityDomain, cardOrigin: string): Promise<SixServiceVerification> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('batch evidence must be an object');
  const batch = raw as Batch;
  if (batch.mode !== 'local-fixture' || !Array.isArray(batch.alternatives) || batch.alternatives.length !== 6 ||
      !batch.fault || typeof batch.fault !== 'object') {
    throw new Error('batch requires exactly six completed alternatives and a separate fault');
  }
  const agentIds = new Set<string>();
  const taskIds = new Set<string>();
  const interactionIds = new Set<string>();
  const ownerByOperator = new Map<number, string>();
  const runtimeAddresses = new Set<string>();
  const cityOperator = new Set<string>();
  const cases: SixServiceVerification['cases'] = [];
  const prepared: Array<{ city: City; emphasis: string; agentId: string; evidence: JourneyEvidence }> = [];
  for (const item of batch.alternatives) {
    if (!item || (item.city !== 'Chicago' && item.city !== 'Boston') ||
        !Number.isInteger(item.operatorIndex) || item.operatorIndex < 0 || item.operatorIndex > 2 ||
        item.emphasis !== emphases[item.operatorIndex] || !item.success?.evidence) {
      throw new Error('batch alternative has invalid city, operator, emphasis, or evidence');
    }
    const evidence = item.success.evidence;
    const request = requestOf(evidence);
    const agentId = evidence.candidate.agent.agentId;
    const pair = `${item.city}:${item.operatorIndex}`;
    const owner = item.ownerAddress.toLowerCase();
    const runtime = item.runtimeAddress.toLowerCase();
    if (request.input.city !== item.city || request.service.agent.agentId !== agentId ||
        !sameAgent(item.agent, evidence.candidate.agent) ||
        request.profileBasis.agentOwner.toLowerCase() !== owner ||
        request.profileBasis.receiptSigner.toLowerCase() !== runtime ||
        agentIds.has(agentId) || taskIds.has(evidence.task.id) ||
        interactionIds.has(request.interactionId) || runtimeAddresses.has(runtime) || cityOperator.has(pair) ||
        (ownerByOperator.has(item.operatorIndex) && ownerByOperator.get(item.operatorIndex) !== owner)) {
      throw new Error('batch alternatives violate signed city, outer agent reference, identity, or uniqueness bindings');
    }
    agentIds.add(agentId);
    taskIds.add(evidence.task.id);
    interactionIds.add(request.interactionId);
    runtimeAddresses.add(runtime);
    cityOperator.add(pair);
    ownerByOperator.set(item.operatorIndex, owner);
    prepared.push({ city: item.city, emphasis: item.emphasis, agentId, evidence });
  }
  if (cityOperator.size !== 6 || ownerByOperator.size !== 3 ||
      new Set(ownerByOperator.values()).size !== 3) {
    throw new Error('batch requires three distinct operators, each with one service in each city');
  }
  const faultEvidence = batch.fault.evidence;
  if (!faultEvidence) throw new Error('batch fault lacks evidence');
  const faultRequest = requestOf(faultEvidence);
  const faultAgentId = faultEvidence.candidate.agent.agentId;
  if (faultAgentId !== batch.alternatives[0]!.agent.agentId ||
      !sameAgent(batch.fault.agent, faultEvidence.candidate.agent) ||
      !sameAgent(batch.fault.agent, batch.alternatives[0]!.agent) ||
      faultRequest.input.city !== 'Chicago' || !faultRequest.input.preferences.includes('Trigger provider fault') ||
      !agentIds.has(faultAgentId) || taskIds.has(faultEvidence.task.id) ||
      interactionIds.has(faultRequest.interactionId) || faultEvidence.answerBase64 !== undefined) {
    throw new Error('accepted fault outer agent reference or task is not separate from six successful service calls');
  }
  for (const item of prepared) {
    const report = await verifyJourneyEvidence(item.evidence, client, domain, filterFor(item.city), cardOrigin);
    if (!usable(report, 'completed')) {
      throw new Error(`batch completion ${item.agentId} failed live verification: ${report.reasons.join('; ')}`);
    }
    checkAnswerShape(item.evidence, item.city, item.emphasis);
    cases.push({ city: item.city, agentId: item.agentId, report });
  }
  const faultReport = await verifyJourneyEvidence(faultEvidence, client, domain,
    filterFor('Chicago'), cardOrigin);
  if (!usable(faultReport, 'failed')) {
    throw new Error(`batch accepted fault failed live verification: ${faultReport.reasons.join('; ')}`);
  }
  return { cases, fault: { agentId: faultAgentId, report: faultReport }, verified: true };
}

export async function runVerifySixServiceCli(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 16) throw new Error(usage);
    const file = option(args, '--evidence');
    if (!isAbsolute(file)) throw new Error('evidence path must be absolute');
    const rpcOrigin = loopbackOrigin(option(args, '--rpc-url'));
    const cardOrigin = loopbackOrigin(option(args, '--card-origin'));
    const chainId = Number(option(args, '--chain-id'));
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('invalid chain ID');
    const registry = option(args, '--registry');
    if (!isAddress(registry, { strict: true })) throw new Error('invalid registry address');
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('evidence file exceeds 8 MiB');
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    const client = createPublicClient({ transport: http(rpcOrigin, { retryCount: 0, timeout: 5_000, fetchFn: boundedRpcFetch }) });
    const report = await verifySixServiceBatch(raw, client,
      { chainId, registry: registry as Address,
        genesisHash: option(args, '--genesis-hash') as Hex,
        knownImplementation: { address: option(args, '--implementation') as Address,
          codeHash: option(args, '--implementation-code-hash') as Hex } }, cardOrigin);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Six-service verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runVerifySixServiceCli().then((status) => { process.exitCode = status; });
}
