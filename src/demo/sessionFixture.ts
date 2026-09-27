import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseError, createPublicClient, createTestClient, createWalletClient, http, keccak256, parseEther,
  type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { startLoopbackA2AService, type LoopbackA2AService, type RuntimeExecutor } from '../a2a/service.js';
import { observeRequestAuthority } from '../a2a/authority.js';
import { syntheticEveningPlan, type FixtureEmphasis } from '../a2a/answer.js';
import { searchIndexes } from '../discovery/indexClient.js';
import { filterForCity, type City } from '../client/externalClient.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AgentRef, type VerifiedProfile } from '../identity/verify.js';
import type { CityRequest } from '../interaction/schema.js';
import type { LicensedRetention } from '../live/retention.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import type { FeedbackIndexSource } from '../feedback/indexClient.js';
import type { ReputationDeploymentProvenance } from '../feedback/reputationActivation.js';
import type { BackupBinding, BackupMetadata } from '../safe/backup.js';
import type { SessionWalletOperations, SessionWalletResults } from './sessionWalletWorker.js';
import type { MigrationReport } from '../safe/migration.js';
import type * as adapter from '../safe/adapter.js';
import type * as onboarding from '../safe/onboarding.js';
import { createJournalController } from '../safe/onboardingJournal.js';
import { deploySafeSupportContracts } from './safeFixture.js';
import { deployRegistryWithDomain, deployReputationRegistryWithProvenance, published } from './registryFixture.js';
import { withOwnedAnvil } from './anvil.js';
import { withOwnedIndexes, type OwnedIndexEnvironment } from './indexProcesses.js';
import { withOwnedLifecycle, ownedFetch, checkOwnedCancellation } from './ownedLifecycle.js';
import { createTamperProxy, listenOwnedServer } from './twoIndexes.js';

const cities = ['Chicago', 'Boston'] as const;
const emphases = ['food', 'culture', 'travel-value'] as const;
export const SESSION_FEEDBACK_CAPACITY = 8;
export const sessionNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export type SessionOperator = { id: string; label: string; config: onboarding.OnboardingConfig;
  primary: Hex | null; backup: Hex; payer: Hex; report: onboarding.OnboardingReport; recovery?: SessionRecovery };
export type SessionRecovery = { restoredInFreshProcess: true; retiredOwnerRejected: true; report: MigrationReport;
  qualification: 'same-host-generated-EOA-demo' };
export type SessionService = { operatorId: string; city: City; emphasis: FixtureEmphasis; agent: AgentRef;
  profile: VerifiedProfile; cardBytes: Uint8Array; agentURI: string; runtime: PrivateKeyAccount;
  server: LoopbackA2AService; storeDirectory: string; stopped: boolean };
/** Private capabilities: never serialize the fixture, its options, or private directories. */
export type SessionFixture = {
  root: string; rpcOrigin: string; cardOrigin: string; chain: PublicClient; domain: IdentityContinuityDomain;
  services: SessionService[]; operators: SessionOperator[]; callers: Record<'accepted' | 'new', PrivateKeyAccount>;
  indexes: OwnedIndexEnvironment; origins: Record<'A' | 'B', string>;
  feedback: { source: FeedbackIndexSource; provenance: ReputationDeploymentProvenance; urls: readonly string[];
    documents: Map<string, Uint8Array>; wallets: Record<'accepted' | 'new', adapter.PayerWallet> };
  crossOperatorWrite: 'rejected';
  index: (name: 'A' | 'B', state: 'stop' | 'start' | 'restart' | 'tamper') => Promise<void>;
  stopProvider: (agent: AgentRef) => Promise<void>;
  recover: (operatorId: string, signal: AbortSignal) => Promise<SessionRecovery>;
};
type ExecutorFactory = (service: { operatorId: string; city: City; emphasis: FixtureEmphasis }) => RuntimeExecutor<CityRequest>;
export type SessionFixtureOptions = { mode?: 'fixture'; executor?: ExecutorFactory } |
  { mode: 'licensed'; executor: ExecutorFactory; retention: LicensedRetention; admittedReviewer: 'accepted' | 'new' };

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

/** Private IPC only. Aborting owns the process and awaits close; it never means
 * an already submitted transaction was rolled back or its effect is known. */
async function walletOperation<K extends keyof SessionWalletOperations>(kind: K, input: SessionWalletOperations[K],
  journal: string, signal: AbortSignal): Promise<SessionWalletResults[K]> {
  signal.throwIfAborted();
  const built = import.meta.url.endsWith('.js');
  const child = fork(new URL(`./sessionWalletWorker.${built ? 'js' : 'ts'}`, import.meta.url), [],
    { execArgv: built ? [] : ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env['PATH'] ?? '' } });
  let result: SessionWalletResults[K] | undefined; let childError = false;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('message', (message: { type?: string; kind?: string; result?: SessionWalletResults[K] }) => {
    if (message.type === 'complete' && message.kind === kind) result = message.result;
  });
  child.once('error', () => { childError = true; });
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const timer = setTimeout(stopChild, 90000); signal.addEventListener('abort', stopChild, { once: true });
  try {
    const access = createJournalController(journal, () => signal.throwIfAborted()).trackCaller(child);
    if (signal.aborted) stopChild();
    else child.send({ ...input, kind, journal: { root: access.root, controller: access.controller, caller: access.caller } },
      (error) => { if (error) { childError = true; stopChild(); } });
    await exited; signal.throwIfAborted();
    if (childError || child.exitCode !== 0 || !result) throw new Error('wallet operation unavailable; chain effects unresolved');
    return result;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stopChild); stopChild(); await exited; }
}

export async function waitSessionIndexes(fixture: Pick<SessionFixture, 'origins'>, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const results = await Promise.all(cities.map((city) => searchIndexes(Object.values(fixture.origins), filterForCity(city), { signal })));
    if (results.every((result) => result.origins.every((origin) => origin.available) && result.candidates.length === 6)) return;
    await delay(100, undefined, { signal });
  }
  throw new Error('session Index discovery did not converge');
}

/** Generated keys, one owned chain, two disposable databases. Existing fixtures are unchanged. */
export async function withSessionFixture<T>(checkout: string, signal: AbortSignal,
  run: (fixture: SessionFixture) => Promise<T>, options: SessionFixtureOptions = {}): Promise<T> {
  return withOwnedLifecycle(async ({ signal }) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-session-'));
    const cards = new Map<string, Uint8Array>(); const documents = new Map<string, Uint8Array>();
    const servers: Server[] = []; const services: SessionService[] = [];
    const liveServices = new Set<LoopbackA2AService>();
    try {
      const cardServer = createServer((request, response) => {
        const bytes = cards.get(request.url ?? ''); response.statusCode = bytes ? 200 : 404;
        response.setHeader('content-type', 'application/json'); response.end(bytes);
      }); servers.push(cardServer); const cardOrigin = await listenOwnedServer(cardServer);
      const documentServer = createServer((request, response) => {
        const bytes = request.method === 'GET' ? documents.get(request.url ?? '') : undefined;
        response.statusCode = bytes ? 200 : 404; response.setHeader('content-type', 'application/octet-stream'); response.end(bytes);
      }); servers.push(documentServer); const documentOrigin = await listenOwnedServer(documentServer);
      const urls = Array.from({ length: SESSION_FEEDBACK_CAPACITY }, (_, i) => `${documentOrigin}/feedback/${i}`);
      const owned = await withOwnedAnvil(async (rpcOrigin) => {
        const transport = http(rpcOrigin, { retryCount: 0, timeout: 5000, fetchFn: boundRpcFetch(ownedFetch) });
        const chain = createPublicClient({ transport, pollingInterval: 25, cacheTime: 0 });
        const control = createTestClient({ mode: 'anvil', transport });
        await control.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }); await control.mine({ blocks: 1 });
        const admin = privateKeyToAccount(generatePrivateKey());
        await control.setBalance({ address: admin.address, value: parseEther('100') });
        const adminWallet = createWalletClient({ account: admin, transport });
        const network = await deploySafeSupportContracts(chain, adminWallet);
        const domain = await deployRegistryWithDomain(chain, adminWallet);
        const { address: reputationRegistry, provenance } = await deployReputationRegistryWithProvenance(chain, adminWallet, domain.registry);
        const source: FeedbackIndexSource = { chainId: 31337, genesisHash: domain.genesisHash,
          identityRegistry: domain.registry, reputationRegistry, startBlock: '0', confirmations: 0 };
        const callers = { accepted: privateKeyToAccount(generatePrivateKey()), new: privateKeyToAccount(generatePrivateKey()) };
        for (const caller of Object.values(callers)) await control.setBalance({ address: caller.address, value: parseEther('1') });
        const wallets = { accepted: createWalletClient({ account: callers.accepted, transport }), new: createWalletClient({ account: callers.new, transport }) };
        // Initial and recovered services share exactly the same execution/admission boundary.
        const execution = (scope: Parameters<ExecutorFactory>[0]) => {
          const custom = options.executor?.(scope);
          if (options.mode !== 'licensed' && custom?.retention !== undefined) throw new Error('licensed execution requires the separate retention-aware session path');
          const execute: RuntimeExecutor<CityRequest> = async (request, context) => {
            const joined = AbortSignal.any([context.signal, signal]); joined.throwIfAborted();
            if (options.mode === 'licensed' && (Date.parse(request.input.timeWindow.start) <= Date.now() || Date.parse(options.retention.expiresAt) <= Date.now())) {
              throw new Error('licensed input or retention expired before dispatch');
            }
            if (custom) return custom(request, { ...context, signal: joined });
            if (request.input.city !== scope.city) throw new Error('wrong city');
            if (request.input.preferences.includes('Trigger provider fault')) throw new Error('intentional fixture failure');
            return syntheticEveningPlan(request, scope.emphasis);
          };
          if (custom?.retention !== undefined) Object.defineProperty(execute, 'retention', { value: custom.retention, enumerable: true });
          return { execute, ...(options.mode === 'licensed' ? { retention: options.retention,
            live: { caller: { method: 'eip155-eoa' as const, chainId: 31337, address: callers[options.admittedReviewer].address.toLowerCase() } } } : {}) };
        };
        const operators: SessionOperator[] = [];
        for (const [operatorIndex, emphasis] of emphases.entries()) {
          checkOwnedCancellation();
          const primary = generatePrivateKey(), backup = generatePrivateKey(), payer = generatePrivateKey();
          const payerAccount = privateKeyToAccount(payer);
          await control.setBalance({ address: payerAccount.address, value: parseEther('20') });
          const id = `operator-${operatorIndex + 1}`, label = `Fixture ${emphasis}`;
          const directory = join(root, id); await mkdir(directory, { mode: 0o700 });
          const pending: { city: City; runtime: PrivateKeyAccount; server: LoopbackA2AService; storeDirectory: string; state: { service?: SessionService } }[] = [];
          for (const city of cities) {
            const runtime = privateKeyToAccount(generatePrivateKey()); const storeDirectory = join(directory, city);
            await mkdir(storeDirectory, { mode: 0o700 }); const state: { service?: SessionService } = {};
            const server = await startLoopbackA2AService({ storeDirectory, runtimeSigner: runtime, now: sessionNow,
              observeAuthority: async (request) => {
                if (!state.service) throw new Error('session service not published');
                return observeRequestAuthority(chain, { domain, agent: state.service.agent, cardBytes: state.service.cardBytes, now: sessionNow }, request);
              }, ...execution({ operatorId: id, city, emphasis }) });
            liveServices.add(server); pending.push({ city, runtime, server, storeDirectory, state });
          }
          // This sole writer uses the pinned registry's zero-based sequence only for publication URLs;
          // discovery and selection always come from the actual Indexes and verifier.
          const specs = pending.map((entry, i) => ({ intentKey: `${id}-${entry.city}`, city: entry.city,
            cardUrl: `${cardOrigin}/cards/${operatorIndex * 2 + i}.json`, invocationUrl: entry.server.url,
            revision: 1, operatorLabel: label, runtime: entry.runtime.address })) as [onboarding.ServiceIntent, onboarding.ServiceIntent];
          const { config, report } = await walletOperation('onboard', { network, domain,
            registryRuntimeCodeHash: keccak256((await chain.getCode({ address: domain.registry }))!),
            primary, backup, payer, saltNonce: String(operatorIndex), services: specs }, directory, signal);
          if (report.services.some((service) => service.status !== 'verified')) throw new Error('session onboarding not verified');
          operators.push({ id, label, config, primary, backup, payer, report });
          for (const [i, entry] of pending.entries()) {
            const agentId = report.services[i]!.agentId!;
            if (specs[i]!.cardUrl !== `${cardOrigin}/cards/${agentId}.json`) throw new Error('session registration sequence changed');
            const record = published({ ...specs[i]!, agentId, owner: { address: config.account.predictedAddress },
              cardBytes: new Uint8Array(), agentURI: '' }, 31337, domain.registry, true, entry.runtime.address);
            const agent: AgentRef = { chainId: 31337, registry: domain.registry, agentId };
            const profile = verifyProfile({ agent, agentURI: record.agentURI, cardBytes: record.cardBytes }, await readIdentitySnapshot(chain, agent));
            const service: SessionService = { operatorId: id, city: entry.city, emphasis, agent, profile, cardBytes: record.cardBytes,
              agentURI: record.agentURI, runtime: entry.runtime, server: entry.server, storeDirectory: entry.storeDirectory, stopped: false };
            cards.set(`/cards/${agentId}.json`, record.cardBytes); services.push(service); entry.state.service = service;
          }
        }
        const attacker = operators[0]!, victim = services[2]!;
        const before = await readIdentitySnapshot(chain, victim.agent);
        const { rejected } = await walletOperation('cross-operator', { network, registry: domain.registry,
          safe: attacker.config.account.predictedAddress, primary: attacker.primary!, payer: attacker.payer,
          victimId: victim.agent.agentId }, root, signal);
        if (!rejected || (await readIdentitySnapshot(chain, victim.agent)).agentURI !== before.agentURI) throw new Error('cross-operator write was not rejected');
        return withOwnedIndexes(checkout, { chainId: 31337, registry: domain.registry, genesisHash: domain.genesisHash,
          startBlock: '0', adapter: 'nandacity-0.1', confirmations: 0 }, { A: rpcOrigin, B: rpcOrigin }, async (indexes) => {
          const origins = { A: indexes.indexes.A.origin, B: indexes.indexes.B.origin };
          const directOrigins = { ...origins };
          let proxy: Server | undefined;
          const fixture: SessionFixture = { root, rpcOrigin, cardOrigin, chain, domain, services, operators, callers, indexes, origins,
            feedback: { source, provenance, urls, documents, wallets }, crossOperatorWrite: 'rejected',
            index: async (name, state) => {
              if (name === 'A' && proxy) { await close(proxy); proxy = undefined; }
              if (state === 'tamper') {
                if (name !== 'A') throw new Error('only Index A has an owned tamper scenario');
                proxy = createTamperProxy(directOrigins.A); servers.push(proxy); origins.A = await listenOwnedServer(proxy);
              } else if (state === 'stop') { await indexes.stop(name); origins[name] = directOrigins[name]; }
              else origins[name] = directOrigins[name] = (await indexes[state](name)).origin;
            },
            stopProvider: async (agent) => {
              const service = services.find((entry) => entry.agent.agentId === agent.agentId && entry.agent.registry === agent.registry && entry.agent.chainId === agent.chainId);
              if (!service) throw new Error('unknown owned provider');
              if (!service.stopped) { await service.server.close(); liveServices.delete(service.server); service.stopped = true; }
            },
            recover: async (operatorId, cancellation) => {
              const operator = operators.find((item) => item.id === operatorId);
              if (!operator?.primary || operator.recovery) throw new Error('operator cannot be recovered again');
              const pair = services.filter((service) => service.operatorId === operatorId);
              const exportDirectory = join(root, `${operatorId}-backup`), journal = join(root, `${operatorId}-migration`);
              await mkdir(exportDirectory, { mode: 0o700 }); await mkdir(journal, { mode: 0o700 });
              const binding: BackupBinding = { network, domain, registryRuntimeCodeHash: operator.config.registryRuntimeCodeHash,
                account: operator.config.account, backupOwner: privateKeyToAccount(operator.backup).address };
              const metadata: BackupMetadata = { ...binding, version: '0.1', services: pair.map((service) => ({ city: service.city,
                agentId: service.agent.agentId, agentURI: service.agentURI, cardUrl: `${cardOrigin}/cards/${service.agent.agentId}.json`,
                invocationUrl: service.server.url, cardDigest: keccak256(service.cardBytes), profileDigest: keccak256(new TextEncoder().encode(service.agentURI)),
                observation: { blockNumber: service.profile.source.blockNumber, blockHash: service.profile.source.blockHash } })) as BackupMetadata['services'] };
              const password = randomBytes(32).toString('base64');
              await walletOperation('export-backup', { exportDirectory, backup: operator.backup, password, metadata, binding,
                cardsBase64: pair.map((service) => Buffer.from(service.cardBytes).toString('base64')) }, exportDirectory, cancellation);
              const next: { service: SessionService; record: { agentURI: string; cardBytes: Uint8Array }; runtime: PrivateKeyAccount; server: LoopbackA2AService }[] = [];
              for (const service of pair) {
                cancellation.throwIfAborted(); await fixture.stopProvider(service.agent);
                const runtime = privateKeyToAccount(generatePrivateKey()); const storeDirectory = join(root, `${operatorId}-${service.city}-recovered`);
                await mkdir(storeDirectory, { mode: 0o700 });
                const server = await startLoopbackA2AService({ storeDirectory, runtimeSigner: runtime, now: sessionNow,
                  observeAuthority: (request) => observeRequestAuthority(chain, { domain, agent: service.agent, cardBytes: service.cardBytes, now: sessionNow }, request),
                  ...execution({ operatorId, city: service.city, emphasis: service.emphasis }) });
                liveServices.add(server);
                const record = published({ agentId: service.agent.agentId, owner: { address: binding.account.predictedAddress },
                  city: service.city, operatorLabel: operator.label, revision: 2, cardUrl: `${cardOrigin}/cards/${service.agent.agentId}.json`,
                  invocationUrl: server.url, cardBytes: new Uint8Array(), agentURI: '' }, 31337, domain.registry, true, runtime.address);
                next.push({ service, record, runtime, server });
              }
              cancellation.throwIfAborted();
              const result = await walletOperation('recover', { exportDirectory, password, binding, retiredPrimary: operator.primary,
                services: next.map(({ service, record }) => ({ city: service.city, agentId: service.agent.agentId,
                  previous: { agentURI: service.agentURI, cardBase64: Buffer.from(service.cardBytes).toString('base64') },
                  next: { agentURI: record.agentURI, cardBase64: Buffer.from(record.cardBytes).toString('base64') } })) as unknown as SessionWalletOperations['recover']['services'] }, journal, cancellation);
              if (result.report.ownerStatus !== 'verified' || !result.retiredOwnerRejected) throw new Error('recovery read-back unavailable');
              for (const entry of next) {
                const snapshot = await readIdentitySnapshot(chain, entry.service.agent);
                const profile = verifyProfile({ agent: entry.service.agent, agentURI: entry.record.agentURI, cardBytes: entry.record.cardBytes }, snapshot);
                Object.assign(entry.service, { ...entry.record, runtime: entry.runtime, server: entry.server, profile, stopped: false });
                cards.set(`/cards/${entry.service.agent.agentId}.json`, entry.record.cardBytes);
              }
              operator.primary = null;
              operator.recovery = { restoredInFreshProcess: true, retiredOwnerRejected: true,
                report: result.report, qualification: 'same-host-generated-EOA-demo' };
              return operator.recovery;
            } };
          await waitSessionIndexes(fixture, signal); return run(fixture);
        }, { feedback: { A: { ...source, documentUrls: urls }, B: { ...source, documentUrls: urls } } });
      }, { genesisMarker: { blockNumber: 0n, timestamp: BigInt(Math.floor(Date.now() / 1000)) - 86401n - BigInt(randomBytes(3).readUIntBE(0, 3)) } });
      return owned.value;
    } catch (error) {
      // viem wraps a settled owned read's abort. Preserve the caller reason so
      // reset can proceed, but never suppress aggregate resource-cleanup errors.
      if (signal.aborted && error instanceof BaseError && error.walk((cause) => cause === signal.reason) === signal.reason) throw signal.reason;
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([...liveServices].map((service) => service.close()).concat(servers.map(close)));
      await rm(root, { recursive: true, force: true });
      const errors = cleanup.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map((error) => error.reason), 'session owned cleanup failed');
    }
  }, signal);
}
