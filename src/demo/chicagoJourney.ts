import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPublicClient, createTestClient, createWalletClient, http, parseEther,
  parseEventLogs, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { startLoopbackA2AService, CITY_REQUEST_DATA_TYPE } from '../a2a/service.js';
import { syntheticEveningPlan } from '../a2a/answer.js';
import { a2aTaskSchema, type A2ATask } from '../a2a/wire.js';
import { searchIndexes } from '../discovery/indexClient.js';
import { verifyDiscoveryWithCard, type DiscoveredCandidate, type IdentityDomain } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AgentRef, type VerifiedProfile } from '../identity/verify.js';
import { signRequest } from '../interaction/signatures.js';
import { envelopeSchema, type CityRequest } from '../interaction/schema.js';
import { withOwnedAnvil } from './anvil.js';
import { INDEX_SOURCE_COMMIT, withOwnedIndexes } from './indexProcesses.js';
import { ownedFetch } from './ownedLifecycle.js';
import { chicago, deployRegistry, published, receipt, registryAbi } from './registryFixture.js';
import { fetchOwnedCard, listenOwnedServer } from './twoIndexes.js';
import { verifyJourneyEvidence, type JourneyEvidence, type JourneyReport } from './journeyReport.js';

const CHAIN_ID = 31_337;
const execFileAsync = promisify(execFile);
const FILTER = { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
  areaServed: [chicago], interfaces: ['application/a2a+json;version=0.3'] };

export type ChicagoJourneyResult = {
  mode: 'local-fixture'; city: 'Chicago'; indexSourceCommit: string;
  indexOrigins: [string, string];
  identities: { owner: string; runtime: string; caller: string };
  tamperRejected: boolean;
  independentProcessVerified: boolean;
  diagnosticCardMismatch: JourneyReport;
  diagnosticMalformedCompletion: JourneyReport;
  diagnosticMissingCompletion: JourneyReport;
  success: { evidence: JourneyEvidence; report: JourneyReport };
  failure: { evidence: JourneyEvidence; report: JourneyReport };
  cleanup: { ownedResourcesStopped: true };
};

function utcNow(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function waitCandidate(origin: string, agentId: string): Promise<DiscoveredCandidate> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await searchIndexes([origin], FILTER);
    const candidate = result.candidates.find((entry) => entry.agent.agentId === agentId);
    if (candidate) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('owned Index did not expose the Chicago service');
}

async function rpcTask(url: string, method: 'message/send' | 'tasks/get', params: unknown): Promise<A2ATask> {
  const id = randomUUID();
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    redirect: 'manual', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`owned A2A endpoint HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  if (body['jsonrpc'] !== '2.0' || body['id'] !== id) throw new Error('owned A2A JSON-RPC response ID mismatch');
  if ('error' in body) throw new Error(`owned A2A ${method} rejected: ${JSON.stringify(body['error'])}`);
  return a2aTaskSchema.parse(body['result']);
}

async function pollTerminal(url: string, taskId: string): Promise<A2ATask> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const task = await rpcTask(url, 'tasks/get', { id: taskId });
    if (task.status.state === 'completed' || task.status.state === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('owned A2A Task did not reach a terminal state');
}

function fixtureRequest(profile: VerifiedProfile, callerAddress: `0x${string}`,
  fail: boolean): CityRequest {
  const createdAt = utcNow();
  const deadline = new Date(Date.parse(createdAt) + 10 * 60_000).toISOString().replace('.000Z', 'Z');
  return {
    kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: profile.agent },
    caller: { method: 'eip155-eoa', chainId: CHAIN_ID, address: callerAddress.toLowerCase() as `0x${string}` },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: {
      blockNumber: profile.source.blockNumber,
      blockHash: profile.source.blockHash.toLowerCase() as `0x${string}`,
      agentOwner: profile.source.agentOwner.toLowerCase() as `0x${string}`,
      agentUriDigest: profile.source.agentUriDigest.toLowerCase() as `0x${string}`,
      registrationDigest: profile.source.registrationDigest.toLowerCase() as `0x${string}`,
      cardDigest: profile.source.cardDigest.toLowerCase() as `0x${string}`,
      receiptSigner: profile.registration['x-nandacity'].receiptSigner.toLowerCase() as `0x${string}`,
    },
    createdAt, deadline,
    input: {
      version: '0.1', capability: 'evening-plan', city: 'Chicago',
      timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
        timeZone: 'America/Chicago' },
      area: 'The Loop', budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'],
      preferences: fail ? ['Low carb', 'Trigger provider fault'] : ['Low carb'],
    },
  };
}

function cityMetadata(task: A2ATask): Record<string, unknown> {
  const metadata = task.metadata?.['org.nandacity'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('A2A Task lacks City evidence metadata');
  }
  return metadata as Record<string, unknown>;
}

async function invokeAndVerify(serviceUrl: string, candidate: DiscoveredCandidate,
  cardBytes: Uint8Array, profile: VerifiedProfile, caller: ReturnType<typeof privateKeyToAccount>,
  verifierClient: PublicClient, domain: IdentityDomain, cardOrigin: string, fail: boolean): Promise<{
    evidence: JourneyEvidence; report: JourneyReport;
  }> {
  if (profile.card.url !== serviceUrl || candidate.declaration.url !== `${cardOrigin}/cards/${profile.agent.agentId}.json`) {
    throw new Error('verified AgentCard is not the exact owned loopback service');
  }
  const request = await signRequest(fixtureRequest(profile, caller.address, fail), caller);
  const submitted = await rpcTask(serviceUrl, 'message/send', {
    message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
      data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
  });
  if (submitted.status.state !== 'submitted') throw new Error('service did not return a persisted submitted Task');
  const task = await pollTerminal(serviceUrl, submitted.id);
  const metadata = cityMetadata(task);
  const acceptance = envelopeSchema.parse(metadata['acceptance']);
  const completion = metadata['completion'] === undefined ? undefined : envelopeSchema.parse(metadata['completion']);
  const data = task.artifacts?.[0]?.parts[0]?.data;
  const answerBase64 = typeof data?.['answerBase64'] === 'string' ? data['answerBase64'] : undefined;
  const basisObservation = await readIdentitySnapshot(verifierClient, candidate.agent,
    BigInt(candidate.observationBlock.number));
  const currentObservation = await readIdentitySnapshot(verifierClient, candidate.agent);
  const evidence: JourneyEvidence = {
    candidate, cardBase64: Buffer.from(cardBytes).toString('base64'), request,
    acceptance, ...(completion ? { completion } : {}),
    ...(answerBase64 ? { answerBase64 } : {}), task,
    basisObservation, currentObservation, observedAt: utcNow(),
  };
  const report = await verifyJourneyEvidence(evidence, verifierClient, domain, FILTER, cardOrigin);
  if (!report.evidenceUsable || report.execution !== (fail ? 'failed' : 'completed')) {
    throw new Error(`owned journey evidence did not verify: ${JSON.stringify(report.reasons)}`);
  }
  return { evidence, report };
}

async function scenario(rpcUrl: string, indexCheckout: string): Promise<Omit<ChicagoJourneyResult, 'cleanup'>> {
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000, fetchFn: ownedFetch });
  const chain = createPublicClient({ transport, pollingInterval: 50 });
  const serviceChain = createPublicClient({ transport: http(rpcUrl, { retryCount: 0,
    timeout: 5_000, fetchFn: ownedFetch }) });
  const verifierClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0,
    timeout: 5_000, fetchFn: ownedFetch }) });
  const testClient = createTestClient({ mode: 'anvil', transport });
  const admin = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const runtime = privateKeyToAccount(generatePrivateKey());
  const caller = privateKeyToAccount(generatePrivateKey());
  for (const account of [admin, owner]) {
    await testClient.setBalance({ address: account.address, value: parseEther('100') });
  }
  const adminWallet = createWalletClient({ account: admin, transport });
  const ownerWallet = createWalletClient({ account: owner, transport });
  const registry = await deployRegistry(chain, adminWallet);
  const genesis = await chain.getBlock({ blockNumber: 0n });
  assert.ok(genesis.hash);
  let agent: AgentRef | undefined;
  let frozenProfile: VerifiedProfile | undefined;
  let cardBytes: Uint8Array | undefined;
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-journey-'));
  const service = await startLoopbackA2AService({
    storeDirectory: directory, runtimeSigner: runtime, now: utcNow,
    observeAuthority: async () => {
      if (!agent || !frozenProfile || !cardBytes) throw new Error('owned service not yet registered');
      const snapshot = await readIdentitySnapshot(serviceChain, agent);
      const currentProfile = verifyProfile({ agent, agentURI: snapshot.agentURI, cardBytes }, snapshot);
      const continuity = snapshot.blockNumber === frozenProfile.source.blockNumber &&
        snapshot.blockHash === frozenProfile.source.blockHash ? 'unchanged' : 'unknown';
      return { basisProfile: frozenProfile, currentProfile, continuity, observedAt: utcNow() };
    },
    execute: async (request) => {
      if (request.input.preferences.includes('Trigger provider fault')) {
        throw new Error('intentional local post-acceptance fixture fault');
      }
      return syntheticEveningPlan(request);
    },
  });
  const cards = new Map<string, Uint8Array>();
  const cardServer = createServer((request, response) => {
    const id = /^\/cards\/([0-9]+)\.json$/.exec(request.url ?? '')?.[1];
    const bytes = id ? cards.get(id) : undefined;
    response.statusCode = bytes ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(bytes ?? '{}');
  });
  let cardListening = false;
  try {
    const cardOrigin = await listenOwnedServer(cardServer);
    cardListening = true;
    const mined = await receipt(chain, await ownerWallet.writeContract({ address: registry,
      abi: registryAbi, functionName: 'register', chain: null }));
    const logs = parseEventLogs({ abi: registryAbi, eventName: 'Registered', logs: mined.logs, strict: true });
    assert.equal(logs.length, 1);
    const agentId = logs[0]!.args.agentId.toString();
    const record = published({ agentId, owner, city: 'Chicago',
      cardUrl: `${cardOrigin}/cards/${agentId}.json`, invocationUrl: service.url,
      revision: 1, cardBytes: new Uint8Array(), agentURI: '' }, CHAIN_ID, registry, true, runtime.address);
    cards.set(agentId, record.cardBytes);
    await receipt(chain, await ownerWallet.writeContract({ address: registry,
      abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(agentId), record.agentURI], chain: null }));
    agent = { chainId: CHAIN_ID, registry, agentId };
    cardBytes = record.cardBytes;
    const frozenSnapshot = await readIdentitySnapshot(serviceChain, agent);
    frozenProfile = verifyProfile({ agent, agentURI: frozenSnapshot.agentURI, cardBytes }, frozenSnapshot);
    const source = { chainId: CHAIN_ID, registry, genesisHash: genesis.hash,
      startBlock: '0', adapter: 'nandacity-0.1' as const, confirmations: 0 };
    return await withOwnedIndexes(indexCheckout, source, { A: rpcUrl, B: rpcUrl }, async (indexes) => {
      const candidateA = await waitCandidate(indexes.indexes.A.origin, agentId);
      const candidateB = await waitCandidate(indexes.indexes.B.origin, agentId);
      if (candidateA.agentURI !== candidateB.agentURI) throw new Error('owned Indexes disagree on service URI');
      const domain = { chainId: CHAIN_ID, registry };
      for (const candidate of [candidateA, candidateB]) {
        const verdict = await verifyDiscoveryWithCard(candidate, verifierClient, domain, FILTER,
          (url) => fetchOwnedCard(url, cardOrigin));
        if (verdict.status !== 'verified') {
          throw new Error(`Index candidate failed independent check: ${verdict.status}`);
        }
      }
      const success = await invokeAndVerify(service.url, candidateA, record.cardBytes,
        frozenProfile!, caller, verifierClient, domain, cardOrigin, false);
      const failure = await invokeAndVerify(service.url, candidateA, record.cardBytes,
        frozenProfile!, caller, verifierClient, domain, cardOrigin, true);
      const changedAnswer = Buffer.from(success.evidence.answerBase64!, 'base64');
      changedAnswer[0] = changedAnswer[0]! ^ 1;
      const tampered = await verifyJourneyEvidence({ ...success.evidence,
        answerBase64: changedAnswer.toString('base64') }, verifierClient, domain, FILTER, cardOrigin);
      const tamperRejected = !tampered.evidenceUsable && tampered.completion?.answerBinding === 'mismatched';
      const changedCard = Buffer.from(success.evidence.cardBase64, 'base64');
      changedCard[0] = changedCard[0]! ^ 1;
      const diagnosticCardMismatch = await verifyJourneyEvidence({ ...success.evidence,
        cardBase64: changedCard.toString('base64') }, verifierClient, domain, FILTER, cardOrigin);
      const diagnosticMalformedCompletion = await verifyJourneyEvidence({ ...success.evidence,
        completion: { ...success.evidence.completion!, payloadBase64: '*' } },
      verifierClient, domain, FILTER, cardOrigin);
      const missingEvidence = structuredClone(success.evidence);
      delete missingEvidence.completion;
      const cityTaskMetadata = missingEvidence.task.metadata?.['org.nandacity'] as Record<string, unknown>;
      delete cityTaskMetadata['completion'];
      const resultData = missingEvidence.task.artifacts?.[0]?.parts[0]?.data as Record<string, unknown>;
      delete resultData['completion'];
      const diagnosticMissingCompletion = await verifyJourneyEvidence(missingEvidence,
        verifierClient, domain, FILTER, cardOrigin);
      const evidencePath = join(directory, 'exported-evidence.json');
      await writeFile(evidencePath, JSON.stringify({ success, failure }), { mode: 0o600 });
      const currentModule = fileURLToPath(import.meta.url);
      const builtMode = currentModule.endsWith('.js');
      const verifierScript = join(dirname(currentModule), `verifyJourneyCli.${builtMode ? 'js' : 'ts'}`);
      const cityRoot = resolve(dirname(currentModule), '../..');
      const { stdout } = await execFileAsync(process.execPath, [
        ...(builtMode ? [] : ['--import', 'tsx']), verifierScript,
        '--evidence', evidencePath, '--rpc-url', rpcUrl, '--card-origin', cardOrigin,
        '--chain-id', String(CHAIN_ID), '--registry', registry,
      ], { cwd: cityRoot, env: { PATH: process.env['PATH'] ?? '' }, timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
      const independent = JSON.parse(stdout) as { success: JourneyReport; failure: JourneyReport };
      const independentProcessVerified = independent.success.evidenceUsable &&
        independent.success.execution === 'completed' && independent.failure.evidenceUsable &&
        independent.failure.execution === 'failed' &&
        independent.success.completion?.answerBinding === 'matched' &&
        independent.failure.completion?.terminalOutcome === 'failed';
      return { mode: 'local-fixture', city: 'Chicago', indexSourceCommit: INDEX_SOURCE_COMMIT,
        indexOrigins: [indexes.indexes.A.origin, indexes.indexes.B.origin],
        identities: { owner: owner.address.toLowerCase(), runtime: runtime.address.toLowerCase(),
          caller: caller.address.toLowerCase() }, success, failure, tamperRejected,
        independentProcessVerified, diagnosticCardMismatch, diagnosticMalformedCompletion,
        diagnosticMissingCompletion };
    });
  } finally {
    const cleanup = await Promise.allSettled([service.close(), ...(cardListening ? [closeServer(cardServer)] : [])]);
    await rm(directory, { recursive: true, force: true });
    const failed = cleanup.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failed.length > 0) throw new AggregateError(failed.map((entry) => entry.reason),
      'owned loopback service cleanup failed');
  }
}

/** Locally owned Anvil, two pinned actual Indexes, exact AgentCard and A2A subset. */
export async function runChicagoJourney(indexCheckout: string): Promise<ChicagoJourneyResult> {
  const marker = { blockNumber: 0n,
    timestamp: BigInt(Math.floor(Date.now() / 1_000)) + BigInt(randomBytes(3).readUIntBE(0, 3)) };
  const owned = await withOwnedAnvil((rpcUrl) => scenario(rpcUrl, indexCheckout), { genesisMarker: marker });
  return { ...owned.value, cleanup: { ownedResourcesStopped: true } };
}
