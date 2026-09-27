import { isDeepStrictEqual } from 'node:util';
import { BaseError, createPublicClient, encodeFunctionData, http, parseAbi, TransactionNotFoundError,
  TransactionReceiptNotFoundError, type Address, type Hash, type PublicClient } from 'viem';
import { published, registryAbi, type CardRecord } from '../demo/registryFixture.js';
import { decodeCard, decodeRegistration, digestBytes, encodeRegistration } from '../identity/profile.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile } from '../identity/verify.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
import { exactKeys, requireAddress, validateAccount, validateNetwork,
  type SafeAccountDeploymentConfig, type SafeNetworkConfig } from './contracts.js';
import * as adapter from './adapter.js';
import { JournalLocked, readJournal, withJournalLock, type JournalAccess } from './onboardingJournal.js';

export type ServiceIntent = Pick<CardRecord, 'city' | 'cardUrl' | 'invocationUrl' | 'revision' | 'operatorLabel'> &
  { intentKey: string; runtime: Address };
export type OnboardingConfig = { journalDirectory: string; network: SafeNetworkConfig;
  domain: IdentityContinuityDomain; registryRuntimeCodeHash: Hash; account: SafeAccountDeploymentConfig;
  payer: Address; services: readonly [ServiceIntent, ServiceIntent] };
type Reference = { transactionHash: Hash; blockNumber: string; blockHash: Hash };
type RegistrationReference = Reference & { safeTxHash: Hash; registeredLogIndex: number };
type Registered = Awaited<ReturnType<typeof adapter.readRegisteredAgentEffect>>;
type CallAction = { prepared: adapter.PreparedSafeCall; approved: adapter.ApprovedSafeCall | null;
  execution: adapter.PreparedSafeExecution | null; effect: Reference | Registered | null };
type Service = { specBytes: string; specDigest: Hash; registration: CallAction | null;
  publication: CallAction | null; profile: { agentURI: string; cardBase64: string } | null };
type Journal = { version: '0.1'; config: OnboardingConfig;
  deployment: { prepared: adapter.PreparedSafeDeployment; execution: adapter.PreparedDeploymentExecution | null;
    effect: (Reference & { safe: Address }) | null }; services: [Service, Service] };
export type ServiceStatus = 'approval-required' | 'prepared' | 'registered-unpublished' | 'verified' | 'unknown' | 'conflict' | 'locked';
export type OnboardingReport = { safe: Address; deployment?: Reference;
  services: { intentKey: string; city: 'Chicago' | 'Boston'; status: ServiceStatus; agentId?: string;
    registration?: RegistrationReference; publication?: Reference }[] };
export type NextAction = { kind: 'deploy'; prepared: adapter.PreparedSafeDeployment } |
  { kind: 'register' | 'publish'; intentKey: string; prepared: adapter.PreparedSafeCall };
class Outcome extends Error { constructor(readonly status: 'unknown' | 'conflict') { super(status); } }
const failureStatus = (error: unknown): ServiceStatus => error instanceof JournalLocked ? 'locked' :
  error instanceof Outcome ? error.status : error instanceof BaseError ? 'unknown' : 'conflict';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) &&
  value.length <= 78 && BigInt(value) < 1n << 256n;
const bytes = (value: string) => new TextEncoder().encode(value);

function makeProfile(config: OnboardingConfig, index: number, agentId: string) {
  const spec = config.services[index]!;
  const record = published({ ...spec, agentId, owner: { address: config.account.predictedAddress },
    cardBytes: new Uint8Array(), agentURI: '' }, config.network.chainId, config.domain.registry, true, spec.runtime);
  decodeCard(record.cardBytes);
  // Preserve the exact existing registration codec's numeric-ID boundary.
  if (encodeRegistration(decodeRegistration(record.agentURI)) !== record.agentURI) throw new Outcome('conflict');
  return { agentURI: record.agentURI, cardBase64: Buffer.from(record.cardBytes).toString('base64') };
}
function validateConfig(config: OnboardingConfig, access: JournalAccess) {
  validateNetwork(config.network); validateAccount(config.network, config.account); requireAddress(config.payer);
  exactKeys(config, ['journalDirectory', 'network', 'domain', 'registryRuntimeCodeHash', 'account', 'payer', 'services']);
  exactKeys(config.domain, ['chainId', 'genesisHash', 'registry', 'knownImplementation']);
  if (!config.domain.knownImplementation) throw new Outcome('conflict');
  exactKeys(config.domain.knownImplementation, ['address', 'codeHash']);
  requireAddress(config.domain.registry); requireAddress(config.domain.knownImplementation.address);
  if (config.journalDirectory !== access.root || config.domain.chainId !== config.network.chainId ||
      !same(config.domain.genesisHash, config.network.genesisHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(config.registryRuntimeCodeHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(config.domain.knownImplementation.codeHash) ||
      [...config.account.owners, config.account.predictedAddress].some((owner) => same(owner, config.payer)) ||
      config.services.length !== 2 || config.services[0].city !== 'Chicago' || config.services[1].city !== 'Boston' ||
      config.services[0].intentKey === config.services[1].intentKey) throw new Outcome('conflict');
  for (const [index, spec] of config.services.entries()) {
    exactKeys(spec, ['intentKey', 'city', 'cardUrl', 'invocationUrl', 'revision', 'runtime',
      ...(spec.operatorLabel === undefined ? [] : ['operatorLabel'])]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(spec.intentKey) ||
        [spec.cardUrl, spec.invocationUrl].some((url) => typeof url !== 'string' || bytes(url).length > 2048) ||
        (spec.operatorLabel !== undefined && (typeof spec.operatorLabel !== 'string' || !spec.operatorLabel.isWellFormed() ||
          bytes(spec.operatorLabel).length < 1 || bytes(spec.operatorLabel).length > 128))) throw new Outcome('conflict');
    requireAddress(spec.runtime);
    if ([...config.account.owners, config.account.predictedAddress].some((owner) => same(owner, spec.runtime))) throw new Outcome('conflict');
    makeProfile(config, index, '0');
  }
}

function reference(value: Reference) {
  if (!uint(value.blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash)) throw new Outcome('conflict');
}
function decodeJournal(input: unknown): Journal {
  const value = input as Journal;
  exactKeys(value, ['version', 'config', 'deployment', 'services']);
  if (value.version !== '0.1' || !Array.isArray(value.services) || value.services.length !== 2) throw new Outcome('conflict');
  exactKeys(value.deployment, ['prepared', 'execution', 'effect']);
  const nullable = (entry: unknown) => {
    if (entry !== null && (typeof entry !== 'object' || Array.isArray(entry))) throw new Outcome('conflict');
  };
  nullable(value.deployment.execution); nullable(value.deployment.effect);
  if (value.deployment.effect) { exactKeys(value.deployment.effect, ['safe', 'transactionHash', 'blockNumber', 'blockHash']); reference(value.deployment.effect); }
  for (const service of value.services) {
    exactKeys(service, ['specBytes', 'specDigest', 'registration', 'publication', 'profile']);
    nullable(service.registration); nullable(service.publication); nullable(service.profile);
    if (typeof service.specBytes !== 'string' || typeof service.specDigest !== 'string') throw new Outcome('conflict');
    if (service.profile) {
      exactKeys(service.profile, ['agentURI', 'cardBase64']);
      if (typeof service.profile.agentURI !== 'string' || typeof service.profile.cardBase64 !== 'string' ||
          service.profile.cardBase64.length > 87384) throw new Outcome('conflict');
    }
    for (const [kind, action] of [['registration', service.registration], ['publication', service.publication]] as const) {
      if (action === null) continue;
      exactKeys(action, ['prepared', 'approved', 'execution', 'effect']);
      nullable(action.approved); nullable(action.execution); nullable(action.effect);
      if (action.effect) {
        exactKeys(action.effect, kind === 'registration' ? ['transactionHash', 'safeTxHash', 'registry', 'agentId', 'owner',
          'agentURI', 'payment', 'blockNumber', 'blockHash', 'registeredLogIndex'] : ['transactionHash', 'blockNumber', 'blockHash']);
        reference(action.effect);
        if (kind === 'registration' && (!uint((action.effect as Registered).agentId) ||
            !Number.isSafeInteger((action.effect as Registered).registeredLogIndex) ||
            (action.effect as Registered).registeredLogIndex < 0 ||
            !/^0x[0-9a-fA-F]{64}$/.test((action.effect as Registered).safeTxHash) ||
            (action.effect as Registered).agentURI !== '' || (action.effect as Registered).payment !== '0')) throw new Outcome('conflict');
      }
    }
  }
  return value;
}
function registerCall(config: OnboardingConfig): adapter.SafeSingleCall {
  return { to: config.domain.registry, value: '0', data: '0x1aa3a008', operation: 0 };
}
function publishCall(config: OnboardingConfig, service: Service): adapter.SafeSingleCall {
  const effect = service.registration?.effect as Registered | null;
  if (!effect || !service.profile) throw new Outcome('conflict');
  return { to: config.domain.registry, value: '0', operation: 0,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(effect.agentId), service.profile.agentURI] }) };
}
function expected(config: OnboardingConfig, call: adapter.SafeSingleCall) {
  return { network: config.network, account: config.account, payer: config.payer,
    domain: config.domain, registryRuntimeCodeHash: config.registryRuntimeCodeHash, call };
}
async function validateJournal(journal: Journal, config: OnboardingConfig) {
  if (!isDeepStrictEqual(journal.config, config)) throw new Outcome('conflict');
  if (!isDeepStrictEqual(journal.deployment.prepared.account, config.account) ||
      !isDeepStrictEqual(journal.deployment.prepared.network, config.network)) throw new Outcome('conflict');
  await adapter.validateStoredDeployment(journal.deployment.prepared, journal.deployment.prepared, config.payer);
  if (journal.deployment.execution) await adapter.validateStoredDeployment(journal.deployment.execution, journal.deployment.prepared, config.payer);
  if (journal.deployment.effect && !journal.deployment.execution) throw new Outcome('conflict');
  let earlierIncomplete = !journal.deployment.effect;
  for (const [index, service] of journal.services.entries()) {
    const spec = JSON.stringify(config.services[index]);
    if (service.specBytes !== spec || service.specDigest !== digestBytes(bytes(spec))) throw new Outcome('conflict');
    if (earlierIncomplete && (service.registration || service.publication || service.profile)) throw new Outcome('conflict');
    const registered = service.registration?.effect as Registered | null;
    if (service.profile && (!registered || !isDeepStrictEqual(service.profile, makeProfile(config, index, registered.agentId)))) throw new Outcome('conflict');
    if (service.publication && (!registered || !service.profile)) throw new Outcome('conflict');
    for (const [kind, action] of [['register', service.registration], ['publish', service.publication]] as const) {
      if (!action) continue;
      if (action.prepared.nonce !== index * 2 + (kind === 'publish' ? 1 : 0)) throw new Outcome('conflict');
      const basis = expected(config, kind === 'register' ? registerCall(config) : publishCall(config, service));
      await adapter.validateStoredCall(action.prepared, basis);
      if (action.approved) {
        await adapter.validateStoredCall(action.approved, basis);
        for (const key of Object.keys(action.prepared) as (keyof adapter.PreparedSafeCall)[]) {
          if (!isDeepStrictEqual(action.prepared[key], action.approved[key])) throw new Outcome('conflict');
        }
      }
      if (action.execution) {
        if (!action.approved) throw new Outcome('conflict');
        if (!journal.deployment.execution || action.execution.payerNonce !==
            journal.deployment.execution.payerNonce + action.prepared.nonce + 1) throw new Outcome('conflict');
        await adapter.validateStoredCall(action.execution, basis);
        for (const key of Object.keys(action.approved) as (keyof adapter.ApprovedSafeCall)[]) {
          if (!isDeepStrictEqual(action.approved[key], action.execution[key])) throw new Outcome('conflict');
        }
      }
      if (action.effect && !action.execution) throw new Outcome('conflict');
    }
    earlierIncomplete = !service.publication?.effect;
  }
}
function report(config: OnboardingConfig, journal: Journal | null, override?: ServiceStatus): OnboardingReport {
  return { safe: config.account.predictedAddress,
    ...(journal?.deployment.effect ? { deployment: { transactionHash: journal.deployment.effect.transactionHash,
      blockNumber: journal.deployment.effect.blockNumber, blockHash: journal.deployment.effect.blockHash } } : {}),
    services: config.services.map((spec, index) => {
      const service = journal?.services[index]; const registered = service?.registration?.effect as Registered | null;
      const status: ServiceStatus = override ?? (service?.publication?.effect ? 'verified' :
        registered ? 'registered-unpublished' : !journal?.deployment.effect || service?.registration?.approved ? 'prepared' : 'approval-required');
      return { intentKey: spec.intentKey, city: spec.city, status,
        ...(registered ? { agentId: registered.agentId, registration: { transactionHash: registered.transactionHash,
          safeTxHash: registered.safeTxHash, blockNumber: registered.blockNumber, blockHash: registered.blockHash,
          registeredLogIndex: registered.registeredLogIndex } } : {}),
        ...(service?.publication?.effect ? { publication: { transactionHash: service.publication.effect.transactionHash,
          blockNumber: service.publication.effect.blockNumber, blockHash: service.publication.effect.blockHash } } : {}) };
    }) };
}
function publicClient(config: OnboardingConfig) {
  return createPublicClient({ transport: http(config.network.rpcUrl, { retryCount: 0, timeout: 5000, fetchFn: boundedRpcFetch }) });
}
async function exactReceipt(client: PublicClient, hash: Hash) {
  try { return await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw new Outcome('unknown'); }
}
async function executeOrObserve(config: OnboardingConfig, execution: adapter.PreparedDeploymentExecution | adapter.PreparedSafeExecution,
  alreadyObserved: boolean, send: boolean) {
  const client = publicClient(config);
  // Always exact hash first. Nonce movement is never success evidence.
  if (await exactReceipt(client, execution.transactionHash)) return;
  if (alreadyObserved) throw new Outcome('unknown');
  let transaction;
  try { transaction = await client.getTransaction({ hash: execution.transactionHash }); }
  catch (error) { if (!(error instanceof TransactionNotFoundError)) throw new Outcome('unknown'); }
  if (transaction) throw new Outcome('unknown');
  const nonce = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [config.payer, 'pending'] }));
  if (nonce !== BigInt(execution.payerNonce)) throw new Outcome('unknown');
  if ('safe' in execution) {
    const safeNonce = await client.readContract({ address: execution.safe,
      abi: parseAbi(['function nonce() view returns(uint256)']), functionName: 'nonce' });
    if (safeNonce !== BigInt(execution.nonce)) throw new Outcome('unknown');
  }
  if (!send) return false;
  try {
    if ('safe' in execution) await adapter.executePrepared(execution);
    else await adapter.executeSafeDeployment(execution);
  } catch {
    if (!await exactReceipt(client, execution.transactionHash)) throw new Outcome('unknown');
  }
  return true;
}
async function reconcile(config: OnboardingConfig, journal: Journal, persist: (next: Journal) => Promise<void>, send: boolean) {
  const client = publicClient(config); const deployment = journal.deployment;
  if (!deployment.execution) return;
  // Re-fsync the complete validated journal before any possible broadcast.
  if (send) await persist(journal);
  if (await executeOrObserve(config, deployment.execution, !!deployment.effect, send) === false) return;
  const deployed = await adapter.readSafeDeploymentEffect(client, deployment.execution, deployment.prepared, config.payer);
  if (deployment.effect && !isDeepStrictEqual(deployment.effect, deployed)) throw new Outcome('conflict');
  if (!deployment.effect) { deployment.effect = deployed; await persist(journal); }
  await adapter.readSafeAccount(config.network, config.account.predictedAddress, config.account);
  for (const [index, service] of journal.services.entries()) {
    await adapter.assertRuntimeSeparated(config.services[index]!.runtime, { network: config.network, safe: config.account.predictedAddress },
      config.domain.registry, (service.registration?.effect as Registered | null)?.agentId);
    for (const [kind, action] of [['register', service.registration], ['publish', service.publication]] as const) {
      if (!action?.execution) return;
      if (send) await persist(journal);
      if (await executeOrObserve(config, action.execution, !!action.effect, send) === false) return;
      const basis = expected(config, kind === 'register' ? registerCall(config) : publishCall(config, service));
      let effect: Reference | Registered;
      if (kind === 'register') effect = await adapter.readRegisteredAgentEffect(client, action.execution, basis);
      else {
        const { receipt } = await adapter.readSafeExecutionEffect(client, action.execution, basis);
        effect = { transactionHash: action.execution.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash };
        const agent = { chainId: config.network.chainId, registry: config.domain.registry,
          agentId: (service.registration!.effect as Registered).agentId };
        const candidate = { agent, agentURI: service.profile!.agentURI, cardBytes: Buffer.from(service.profile!.cardBase64, 'base64') };
        verifyProfile(candidate, await readIdentitySnapshot(client, agent, receipt.blockNumber));
        verifyProfile(candidate, await readIdentitySnapshot(client, agent));
      }
      if (action.effect && !isDeepStrictEqual(action.effect, effect)) throw new Outcome('conflict');
      if (!action.effect) { action.effect = effect; await persist(journal); }
      if (kind === 'register' && !service.profile) {
        if (BigInt((effect as Registered).agentId) > BigInt(Number.MAX_SAFE_INTEGER)) return;
        service.profile = makeProfile(config, index, (effect as Registered).agentId); await persist(journal);
      }
    }
  }
}
type Persist = (next: Journal) => Promise<void>;
async function transition(configInput: OnboardingConfig, access: JournalAccess,
  run: (config: OnboardingConfig, journal: Journal, persist: Persist) => Promise<NextAction | void>, initialize = false):
Promise<{ report: OnboardingReport; action?: NextAction }> {
  const config = structuredClone(configInput); let observed: Journal | null = null;
  try {
    validateConfig(config, access);
    return await withJournalLock(access, decodeJournal, async (stored, persist) => {
      let journal = stored;
      if (!journal) {
        if (!initialize) throw new Outcome('conflict');
        const prepared = await adapter.prepareSafeDeployment(config.network, config.account);
        journal = { version: '0.1', config, deployment: { prepared, execution: null, effect: null },
          services: config.services.map((spec) => ({ specBytes: JSON.stringify(spec), specDigest: digestBytes(bytes(JSON.stringify(spec))),
            registration: null, publication: null, profile: null })) as [Service, Service] };
        await persist(journal);
      }
      await validateJournal(journal, config); observed = journal;
      await adapter.readSafeRegistryConfiguration(publicClient(config), config);
      await reconcile(config, journal, persist, false);
      const action = await run(config, journal, persist);
      return { report: report(config, journal), ...(action ? { action: structuredClone(action) } : {}) };
    });
  } catch (error) {
    // No caught RPC, filesystem, signer, transaction or validation payload is exposed.
    return { report: report(config, observed, failureStatus(error)) };
  }
}
export async function prepareOnboarding(config: OnboardingConfig, access: JournalAccess): Promise<OnboardingReport> {
  return (await transition(config, access, async () => undefined, true)).report;
}
function outstanding(journal: Journal): { index: number; kind: 'register' | 'publish'; action: CallAction | null } | null {
  if (!journal.deployment.effect) return null;
  for (const [index, service] of journal.services.entries()) {
    if (!service.registration?.effect) return { index, kind: 'register', action: service.registration };
    if (!service.publication?.effect) return { index, kind: 'publish', action: service.publication };
  }
  return null;
}
export async function prepareNextAction(config: OnboardingConfig, access: JournalAccess) {
  return transition(config, access, async (trusted, journal, persist) => {
    if (!journal.deployment.effect) return { kind: 'deploy', prepared: journal.deployment.prepared };
    const next = outstanding(journal); if (!next) return;
    const service = journal.services[next.index]!;
    if (next.kind === 'publish' && !service.profile) return;
    if (!next.action) {
      const call = next.kind === 'register' ? registerCall(trusted) : publishCall(trusted, service);
      const prepared = await adapter.prepareSingleCall(trusted.network, trusted.account.predictedAddress, call);
      if (prepared.nonce !== next.index * 2 + (next.kind === 'publish' ? 1 : 0)) throw new Outcome('conflict');
      next.action = { prepared, approved: null, execution: null, effect: null };
      service[next.kind === 'register' ? 'registration' : 'publication'] = next.action;
      await persist(journal); // Reservation survives while an owner considers approval.
    }
    return { kind: next.kind, intentKey: trusted.services[next.index]!.intentKey, prepared: next.action.prepared };
  });
}
export async function recordApproval(config: OnboardingConfig, access: JournalAccess, approval: adapter.ApprovedSafeCall): Promise<OnboardingReport> {
  approval = structuredClone(approval);
  return (await transition(config, access, async (trusted, journal, persist) => {
    const next = outstanding(journal); if (!next?.action || next.action.execution) throw new Outcome('conflict');
    const expectedCall = next.action.prepared;
    await adapter.validateStoredCall(approval, expected(trusted, expectedCall.call));
    for (const key of Object.keys(expectedCall) as (keyof adapter.PreparedSafeCall)[]) {
      if (!isDeepStrictEqual(expectedCall[key], approval[key])) throw new Outcome('conflict');
    }
    if (next.action.approved && !isDeepStrictEqual(next.action.approved, approval)) throw new Outcome('conflict');
    next.action.approved = structuredClone(approval); await persist(journal);
  })).report;
}
export async function prepareExecution(config: OnboardingConfig, access: JournalAccess, payer: adapter.PayerWallet): Promise<OnboardingReport> {
  return (await transition(config, access, async (trusted, journal, persist) => {
    if (!same(payer.account.address, trusted.payer)) throw new Outcome('conflict');
    if (!journal.deployment.effect) {
      if (!journal.deployment.execution) {
        journal.deployment.execution = await adapter.prepareDeploymentExecution(journal.deployment.prepared, payer);
        await persist(journal);
      }
      return;
    }
    const next = outstanding(journal);
    if (!next?.action?.approved || next.action.execution) return;
    const requiredNonce = BigInt(journal.deployment.execution!.payerNonce) + BigInt(next.action.prepared.nonce) + 1n;
    const currentNonce = BigInt(await publicClient(trusted).request({ method: 'eth_getTransactionCount', params: [trusted.payer, 'pending'] }));
    if (currentNonce !== requiredNonce) throw new Outcome('conflict');
    next.action.execution = await adapter.prepareExecution(next.action.approved, payer); await persist(journal);
  })).report;
}
export async function resumeOnboarding(config: OnboardingConfig, access: JournalAccess): Promise<OnboardingReport> {
  return (await transition(config, access, async (trusted, journal, persist) => reconcile(trusted, journal, persist, true))).report;
}

/** Locked journals remain readable, but this operation cannot advance or broadcast. */
export async function inspectOnboarding(config: OnboardingConfig, access: JournalAccess): Promise<OnboardingReport> {
  try {
    validateConfig(config, access); const journal = await readJournal(access, decodeJournal);
    if (!journal) throw new Outcome('conflict');
    await validateJournal(journal, config);
    await adapter.readSafeRegistryConfiguration(publicClient(config), config);
    await reconcile(config, journal, async () => undefined, false);
    return report(config, journal);
  } catch (error) { return report(config, null, failureStatus(error)); }
}
