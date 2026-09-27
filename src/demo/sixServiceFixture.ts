import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, createTestClient, createWalletClient, http, parseEther,
  parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { startLoopbackA2AService, type LoopbackA2AService } from '../a2a/service.js';
import { observeRequestAuthority } from '../a2a/authority.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import { syntheticEveningPlan, type FixtureEmphasis } from '../a2a/answer.js';
import { searchIndexes, type IndexSearchResult } from '../discovery/indexClient.js';
import { verifyDiscoveryWithCard, type DiscoveryVerification,
  type ServiceFilter } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AgentRef, type VerifiedProfile } from '../identity/verify.js';
import { signRequest } from '../interaction/signatures.js';
import type { CityRequest, SignedEnvelope } from '../interaction/schema.js';
import { signFeedback } from '../feedback/signatures.js';
import type { CityFeedback } from '../feedback/schema.js';
import type { FeedbackIndexSource } from '../feedback/indexClient.js';
import type { ReputationDeploymentProvenance } from '../feedback/reputationActivation.js';
import { prepareLocalFeedbackPublication, prepareLocalFeedbackRevocation, submitPreparedFeedback,
  type FeedbackSubmissionResult, type PreparedFeedbackPublication, type PrepareLocalFeedbackPublicationInput } from './feedbackPublication.js';
import { withOwnedAnvil } from './anvil.js';
import { withOwnedIndexes, type OwnedIndexEnvironment } from './indexProcesses.js';
import { checkOwnedCancellation, ownedFetch } from './ownedLifecycle.js';
import { boston, chicago, deployRegistryWithDomain, deployReputationRegistryWithProvenance,
  published, receipt, registryAbi } from './registryFixture.js';
import { fetchOwnedCard, listenOwnedServer } from './twoIndexes.js';

const CHAIN_ID = 31_337;
type FixtureCity = 'Chicago' | 'Boston';
type IndexName = 'A' | 'B';
const cities = ['Chicago', 'Boston'] as const;
const emphases = ['food', 'culture', 'travel-value'] as const;
const labels = ['Fixture Food', 'Fixture Culture', 'Fixture Travel/Value'] as const;
const area = { Chicago: chicago, Boston: boston };

function utcNow(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function filterFor(city: FixtureCity): ServiceFilter {
  return { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
    areaServed: [area[city]], interfaces: ['application/a2a+json;version=0.3'] };
}

export type FixtureService = {
  operatorIndex: number; city: FixtureCity; emphasis: FixtureEmphasis;
  ownerAddress: Address; runtimeAddress: Address; agent: AgentRef;
  profile: VerifiedProfile; cardBytes: Uint8Array; serviceUrl: string;
  /** Only available inside the owned callback; never include this path in exported evidence. */
  storeDirectory: string;
};
export type FixtureSearch = { filter: ServiceFilter; result: IndexSearchResult;
  verdicts: DiscoveryVerification[] };
export type SixServiceFixture = {
  services: FixtureService[];
  searches: Record<FixtureCity, Record<IndexName, FixtureSearch>>;
  indexOrigins: Record<IndexName, string>;
  ownerIsolationRejected: boolean;
  cardOrigin: string; rpcOrigin: string; chain: PublicClient; domain: IdentityContinuityDomain;
  callerAddress: Address;
  signAsCaller: (request: CityRequest) => Promise<SignedEnvelope>;
  indexes: OwnedIndexEnvironment;
  stopProvider: (agentId: string) => Promise<void>;
  stopCards: () => Promise<void>;
  feedback?: {
    /** Known pre-deployment lower bound, not exact proxy activation or completeness proof. */
    source: FeedbackIndexSource;
    /** Raw configured deployment provenance; consumers must authenticate it independently. */
    provenance: ReputationDeploymentProvenance;
    sign: (value: CityFeedback) => Promise<SignedEnvelope>;
    publish: (input: Omit<PrepareLocalFeedbackPublicationInput,
      'publicClient' | 'walletClient' | 'identityRegistry' | 'reputationRegistry' | 'allowedDocumentURL'>) => Promise<FeedbackSubmissionResult>;
    revoke: (publicationTransaction: Hex) => Promise<FeedbackSubmissionResult>;
    savePrefix: () => Promise<{ number: string; hash: Hex }>;
    replaceSuffixThrough: (blockNumber: string) => Promise<void>;
  };
};
type FixtureOptions = { feedback?: { documentUrls: string[] } };

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function waitForSearches(origins: Record<IndexName, string>): Promise<
  Record<FixtureCity, Record<IndexName, FixtureSearch>>> {
  const deadline = Date.now() + 30_000;
  let last = '';
  while (Date.now() < deadline) {
    checkOwnedCancellation();
    const searches = {} as Record<FixtureCity, Record<IndexName, FixtureSearch>>;
    for (const city of cities) {
      searches[city] = {} as Record<IndexName, FixtureSearch>;
      for (const index of ['A', 'B'] as const) {
        const filter = filterFor(city);
        searches[city][index] = { filter, result: await searchIndexes([origins[index]], filter), verdicts: [] };
      }
    }
    if (cities.every((city) => (['A', 'B'] as const).every((index) =>
      searches[city][index].result.candidates.length === 3 &&
      searches[city][index].result.origins[0]?.available === true))) return searches;
    last = JSON.stringify(cities.map((city) => (['A', 'B'] as const).map((index) =>
      searches[city][index].result.candidates.length)));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`six owned services did not converge through both Indexes: ${last}`);
}

async function scenario<T>(rpcUrl: string, indexCheckout: string,
  run: (fixture: SixServiceFixture) => Promise<T>, options: FixtureOptions): Promise<T> {
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000, fetchFn: boundRpcFetch(ownedFetch) });
  const chain = createPublicClient({ transport, pollingInterval: 50 });
  const verifier = createPublicClient({ transport: http(rpcUrl, { retryCount: 0,
    timeout: 5_000, fetchFn: boundRpcFetch(ownedFetch) }) });
  const serviceChain = createPublicClient({ transport: http(rpcUrl, { retryCount: 0,
    timeout: 5_000, fetchFn: boundRpcFetch(ownedFetch) }) });
  const testClient = createTestClient({ mode: 'anvil', transport });
  // Keep the random ownership marker in block zero, but real registry chronology at wall UTC.
  await testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  await testClient.mine({ blocks: 1 });
  const admin = privateKeyToAccount(generatePrivateKey());
  const operators = emphases.map(() => privateKeyToAccount(generatePrivateKey()));
  const caller = privateKeyToAccount(generatePrivateKey());
  for (const account of [admin, ...operators]) {
    await testClient.setBalance({ address: account.address, value: parseEther('100') });
  }
  const adminWallet = createWalletClient({ account: admin, transport });
  const wallets = operators.map((operator) => createWalletClient({ account: operator, transport }));
  const domain = await deployRegistryWithDomain(chain, adminWallet);
  const registry = domain.registry;
  const genesis = await chain.getBlock({ blockNumber: 0n });
  assert.ok(genesis.hash);
  let feedback: SixServiceFixture['feedback'];
  if (options.feedback) {
    const documentUrls = [...options.feedback.documentUrls];
    const startBlock = (await chain.getBlock()).number.toString();
    const { address: reputationRegistry, provenance } =
      await deployReputationRegistryWithProvenance(chain, adminWallet, registry);
    await testClient.setBalance({ address: caller.address, value: parseEther('1') });
    const walletClient = createWalletClient({ account: caller, transport });
    const clients = { publicClient: chain, walletClient };
    const publications = new Map<Hex, { prepared: PreparedFeedbackPublication; result: FeedbackSubmissionResult }>();
    let snapshot: Hex | undefined;
    feedback = {
      source: { chainId: CHAIN_ID, genesisHash: genesis.hash, identityRegistry: registry,
        reputationRegistry, startBlock, confirmations: 0 },
      provenance,
      sign: (value) => { checkOwnedCancellation(); return signFeedback(value, caller); },
      publish: async (input) => {
        checkOwnedCancellation();
        if (!documentUrls.includes(input.feedbackURI)) throw new Error('owned feedback document URL not configured');
        const prepared = await prepareLocalFeedbackPublication({ ...input, ...clients, identityRegistry: registry,
          reputationRegistry, allowedDocumentURL: input.feedbackURI });
        const result = await submitPreparedFeedback({ ...clients, prepared });
        publications.set(result.receipt.transactionHash, { prepared, result }); return result;
      },
      revoke: async (hash) => {
        checkOwnedCancellation();
        const original = publications.get(hash); if (!original) throw new Error('publication not owned by this fixture');
        const prepared = await prepareLocalFeedbackRevocation({ ...clients, originalPublication: original.prepared,
          publicationResult: original.result });
        return submitPreparedFeedback({ ...clients, prepared });
      },
      savePrefix: async () => {
        checkOwnedCancellation(); if (snapshot) throw new Error('owned prefix already saved');
        snapshot = await testClient.snapshot(); const block = await chain.getBlock();
        return { number: block.number.toString(), hash: block.hash };
      },
      replaceSuffixThrough: async (number) => {
        checkOwnedCancellation();
        if (!snapshot || !/^(0|[1-9][0-9]*)$/.test(number) || number.length > 78) throw new Error('owned reorg input invalid');
        const through = BigInt(number); const before = await chain.getBlock();
        if (through > before.number || before.number - through > 128n) throw new Error('owned reorg range invalid');
        const saved = snapshot; snapshot = undefined; await testClient.revert({ id: saved });
        const prefix = await chain.getBlock(); const count = through + 1n - prefix.number;
        if (count < 1n || count > 128n) throw new Error('owned replacement range invalid');
        await testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
        await testClient.mine({ blocks: Number(count), interval: 0 });
      },
    };
  }
  const cards = new Map<string, Uint8Array>();
  const cardServer = createServer((request, response) => {
    const id = /^\/cards\/([0-9]+)\.json$/.exec(request.url ?? '')?.[1];
    const bytes = id ? cards.get(id) : undefined;
    response.statusCode = bytes ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(bytes ?? '{}');
  });
  const liveServices: LoopbackA2AService[] = [];
  const directories: string[] = [];
  let cardListening = false;
  let cardsStopped: Promise<void> | undefined;
  const providerStops = new Map<number, Promise<void>>();
  const stopAt = (index: number) => {
    let stopped = providerStops.get(index);
    if (!stopped) { stopped = liveServices[index]!.close(); providerStops.set(index, stopped); } return stopped;
  };
  const stopCards = () => cardsStopped ??= cardListening ? closeServer(cardServer) : Promise.resolve();
  try {
    const cardOrigin = await listenOwnedServer(cardServer);
    cardListening = true;
    const services: FixtureService[] = [];
    const authorityStates: Array<{ agent?: AgentRef; profile?: VerifiedProfile;
      cardBytes?: Uint8Array }> = [];
    for (let operatorIndex = 0; operatorIndex < operators.length; operatorIndex++) {
      for (const city of cities) {
        const owner = operators[operatorIndex]!;
        const runtime = privateKeyToAccount(generatePrivateKey());
        const storeDirectory = await mkdtemp(join(tmpdir(), 'nandacity-six-service-'));
        directories.push(storeDirectory);
        const state: { agent?: AgentRef; profile?: VerifiedProfile; cardBytes?: Uint8Array } = {};
        authorityStates.push(state);
        const service = await startLoopbackA2AService({ storeDirectory, runtimeSigner: runtime,
          now: utcNow,
          observeAuthority: async (request) => {
            if (!state.agent || !state.profile || !state.cardBytes) {
              throw new Error('owned six-service fixture not yet registered');
            }
            return observeRequestAuthority(serviceChain, { domain, agent: state.agent,
              cardBytes: state.cardBytes, now: utcNow }, request);
          },
          execute: async (request) => {
            if (request.input.city !== city) {
              throw new Error('service city differs from the published city');
            }
            if (operatorIndex === 0 && city === 'Chicago' &&
                request.input.preferences.includes('Trigger provider fault')) {
              throw new Error('intentional local post-acceptance fixture fault');
            }
            return syntheticEveningPlan(request, emphases[operatorIndex]!);
          },
        });
        liveServices.push(service);
        const mined = await receipt(chain, await wallets[operatorIndex]!.writeContract({
          address: registry, abi: registryAbi, functionName: 'register', chain: null }));
        const logs = parseEventLogs({ abi: registryAbi, eventName: 'Registered',
          logs: mined.logs, strict: true });
        assert.equal(logs.length, 1);
        const agentId = logs[0]!.args.agentId.toString();
        const record = published({ agentId, owner, city,
          operatorLabel: labels[operatorIndex]!,
          cardUrl: `${cardOrigin}/cards/${agentId}.json`, invocationUrl: service.url,
          revision: 1, cardBytes: new Uint8Array(), agentURI: '' },
        CHAIN_ID, registry, true, runtime.address);
        cards.set(agentId, record.cardBytes);
        await receipt(chain, await wallets[operatorIndex]!.writeContract({ address: registry,
          abi: registryAbi, functionName: 'setAgentURI',
          args: [BigInt(agentId), record.agentURI], chain: null }));
        const agent: AgentRef = { chainId: CHAIN_ID, registry, agentId };
        const snapshot = await readIdentitySnapshot(serviceChain, agent);
        const profile = verifyProfile({ agent, agentURI: snapshot.agentURI,
          cardBytes: record.cardBytes }, snapshot);
        Object.assign(state, { agent, profile, cardBytes: record.cardBytes });
        services.push({ operatorIndex, city, emphasis: emphases[operatorIndex]!,
          ownerAddress: owner.address, runtimeAddress: runtime.address, agent,
          profile, cardBytes: record.cardBytes, serviceUrl: service.url, storeDirectory });
      }
    }
    const victim = services[2]!;
    const originalURI = (await readIdentitySnapshot(chain, victim.agent)).agentURI;
    let ownerIsolationRejected = false;
    try {
      const hash = await wallets[0]!.writeContract({ address: registry, abi: registryAbi,
        functionName: 'setAgentURI', args: [BigInt(victim.agent.agentId), 'data:,unauthorized'],
        chain: null });
      const attempt = await chain.waitForTransactionReceipt({ hash, timeout: 10_000 });
      ownerIsolationRejected = attempt.status === 'reverted';
    } catch (error) {
      if (!(error instanceof Error) || !/revert|not authorized|not owner|insufficient approval/i.test(error.message)) {
        throw error;
      }
      ownerIsolationRejected = true;
    }
    const settledSnapshot = await readIdentitySnapshot(chain, victim.agent);
    if (!ownerIsolationRejected || settledSnapshot.agentURI !== originalURI) {
      throw new Error('simulated operator A could alter operator B registration');
    }
    // All registrations and the denied cross-owner attempt are settled. Freeze one
    // common uncached initial basis for the six services. Each request resolves its own basis.
    // getBlockNumber() may be cached before the final setAgentURI is mined.
    const finalBlock = BigInt(settledSnapshot.blockNumber);
    if (services.some((service) => finalBlock < BigInt(service.profile.source.blockNumber))) {
      throw new Error('settled chain basis precedes a published service profile');
    }
    for (let index = 0; index < services.length; index++) {
      const service = services[index]!;
      const snapshot = await readIdentitySnapshot(serviceChain, service.agent, finalBlock);
      const profile = verifyProfile({ agent: service.agent, agentURI: snapshot.agentURI,
        cardBytes: service.cardBytes }, snapshot);
      service.profile = profile;
      authorityStates[index]!.profile = profile;
    }
    const source = { chainId: CHAIN_ID, registry, genesisHash: genesis.hash,
      startBlock: '0', adapter: 'nandacity-0.1' as const, confirmations: 0 };
    return await withOwnedIndexes(indexCheckout, source, { A: rpcUrl, B: rpcUrl }, async (indexes) => {
      const indexOrigins = { A: indexes.indexes.A.origin, B: indexes.indexes.B.origin };
      const searches = await waitForSearches(indexOrigins);
      for (const city of cities) {
        const expected = services.filter((service) => service.city === city)
          .map((service) => service.agent.agentId).sort();
        for (const index of ['A', 'B'] as const) {
          const found = searches[city][index];
          if (found.result.origins[0]?.errors.length) {
            throw new Error(`owned Index ${index} returned search errors: ${found.result.origins[0].errors.join('; ')}`);
          }
          if (JSON.stringify(found.result.candidates.map((item) => item.agent.agentId).sort()) !==
            JSON.stringify(expected)) throw new Error(`owned Index ${index} returned wrong ${city} service IDs`);
          found.verdicts = await Promise.all(found.result.candidates.map((candidate) =>
            verifyDiscoveryWithCard(candidate, verifier, domain, found.filter,
              (url) => fetchOwnedCard(url, cardOrigin))));
          if (found.verdicts.some((verdict) => verdict.status !== 'verified')) {
            throw new Error(`owned Index ${index} has an unverified ${city} service`);
          }
        }
      }
      return run({ services, searches, indexOrigins, ownerIsolationRejected, cardOrigin,
        rpcOrigin: rpcUrl,
        chain: verifier, domain, callerAddress: caller.address,
        signAsCaller: (request) => signRequest(request, caller), indexes, stopCards,
        stopProvider: (agentId) => {
          const index = services.findIndex((service) => service.agent.agentId === agentId);
          if (index < 0) return Promise.reject(new Error('provider not owned by this fixture')); return stopAt(index);
        }, ...(feedback ? { feedback } : {}) });
    }, feedback ? { feedback: { A: { ...feedback.source, documentUrls: options.feedback!.documentUrls },
      B: { ...feedback.source, documentUrls: options.feedback!.documentUrls } } } : {});
  } finally {
    const stopped = await Promise.allSettled([
      ...liveServices.map((_service, index) => stopAt(index)),
      ...(cardListening ? [stopCards()] : []),
    ]);
    const removed = await Promise.allSettled(directories.map((directory) =>
      rm(directory, { recursive: true, force: true })));
    const failures = [...stopped, ...removed]
      .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
      .map((entry) => entry.reason);
    if (failures.length) throw new AggregateError(failures, 'six-service owned resource cleanup failed');
  }
}

/** Owned synthetic services and actual pinned local Indexes exist only during the callback. */
export async function withSixServiceFixture<T>(indexCheckout: string,
  run: (fixture: SixServiceFixture) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
  const marker = { blockNumber: 0n,
    timestamp: BigInt(Math.floor(Date.now() / 1_000)) - 86401n - BigInt(randomBytes(3).readUIntBE(0, 3)) };
  const owned = await withOwnedAnvil((rpcUrl) => scenario(rpcUrl, indexCheckout, run, options),
    { genesisMarker: marker });
  return owned.value;
}
