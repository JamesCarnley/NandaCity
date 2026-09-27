import { isDeepStrictEqual } from 'node:util';
import SafeExport from '@safe-global/protocol-kit';
import { BaseError, createPublicClient, encodeFunctionData, http, parseAbi, TransactionNotFoundError,
  TransactionReceiptNotFoundError, type Address, type Hash, type PublicClient } from 'viem';
import { decodeCard, decodeRegistration, digestBytes } from '../identity/profile.js';
import { verifyProfile } from '../identity/verify.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { registryAbi } from '../demo/registryFixture.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
import { exactKeys, protocolContractNetworks, requireAddress, validateAccount, validateNetwork,
  type SafeAccountDeploymentConfig, type SafeNetworkConfig } from './contracts.js';
import * as adapter from './adapter.js';
import { JournalLocked, withJournalLock, type JournalAccess } from './onboardingJournal.js';

const Safe = SafeExport as unknown as typeof SafeExport.default;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ownerAbi = parseAbi(['function swapOwner(address prevOwner,address oldOwner,address newOwner)',
  'function nonce() view returns(uint256)']);
type Point = { blockNumber: string; blockHash: Hash };
type Effect = Point & { transactionHash: Hash; gasUsed: string };
export type MigrationService = { city: 'Chicago' | 'Boston'; agentId: string;
  previous: { agentURI: string; cardBase64: string }; next: { agentURI: string; cardBase64: string } };
export type MigrationConfig = { journalDirectory: string; onboardingWritersStopped: true;
  network: SafeNetworkConfig; domain: IdentityContinuityDomain; registryRuntimeCodeHash: Hash;
  account: SafeAccountDeploymentConfig; backup: Address; retiredPrimary: Address; replacementPrimary: Address;
  payer: Address; initialSafeNonce: number; initialPayerNonce: number; basis: Point;
  services: readonly [MigrationService, MigrationService] };
type Action = { basis: Point; prepared: adapter.PreparedSafeCall; approved: adapter.ApprovedSafeCall | null;
  execution: adapter.PreparedSafeExecution | null; effect: Effect | null };
type Journal = { version: '0.1'; kind: 'existing-id-migration'; config: MigrationConfig;
  actions: [Action | null, Action | null, Action | null] };
export type MigrationReport = { safe: Address; ownerStatus: Status; services: { city: 'Chicago' | 'Boston'; agentId: string; status: Status }[];
  effects: Effect[] };
type Status = 'approval-required' | 'prepared' | 'verified' | 'unknown' | 'conflict' | 'locked';
class Outcome extends Error { constructor(readonly status: 'unknown' | 'conflict') { super(status); } }
const fail = () => { throw new Outcome('conflict'); };
const bytes = (s: string) => new TextEncoder().encode(s);
const clientFor = (c: MigrationConfig) => createPublicClient({ transport: http(c.network.rpcUrl,
  { retryCount: 0, timeout: 5000, fetchFn: boundedRpcFetch }), pollingInterval: 25 });
const owners = (c: MigrationConfig, rotated: boolean): [Address, Address] => [rotated ? c.replacementPrimary : c.retiredPrimary, c.backup];
function point(p: Point) {
  exactKeys(p, ['blockNumber', 'blockHash']);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(p.blockNumber) || BigInt(p.blockNumber) >= 1n << 256n ||
      !/^0x[0-9a-fA-F]{64}$/.test(p.blockHash)) fail();
}
function validateConfig(c: MigrationConfig, access: JournalAccess) {
  exactKeys(c, ['journalDirectory', 'onboardingWritersStopped', 'network', 'domain', 'registryRuntimeCodeHash', 'account',
    'backup', 'retiredPrimary', 'replacementPrimary', 'payer', 'initialSafeNonce', 'initialPayerNonce', 'basis', 'services']);
  validateNetwork(c.network); validateAccount(c.network, c.account); point(c.basis);
  exactKeys(c.domain, ['chainId', 'genesisHash', 'registry', 'knownImplementation']);
  if (!c.domain.knownImplementation) fail();
  exactKeys(c.domain.knownImplementation!, ['address', 'codeHash']);
  requireAddress(c.domain.registry); requireAddress(c.domain.knownImplementation!.address);
  const addresses = [c.backup, c.retiredPrimary, c.replacementPrimary, c.payer, c.account.predictedAddress];
  addresses.forEach(requireAddress);
  adapter.checkedNonce(c.initialSafeNonce); adapter.checkedNonce(c.initialPayerNonce);
  adapter.checkedNonce(c.initialSafeNonce + 3); adapter.checkedNonce(c.initialPayerNonce + 3);
  if (new Set(addresses.map((a) => a.toLowerCase())).size !== addresses.length || c.onboardingWritersStopped !== true ||
      c.journalDirectory !== access.root || c.domain.chainId !== c.network.chainId || !same(c.domain.genesisHash, c.network.genesisHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(c.registryRuntimeCodeHash) || !/^0x[0-9a-fA-F]{64}$/.test(c.domain.knownImplementation!.codeHash) ||
      !c.account.owners.every((a) => owners(c, false).some((b) => same(a, b))) ||
      c.services.length !== 2 || c.services[0].city !== 'Chicago' || c.services[1].city !== 'Boston' ||
      c.services[0].agentId === c.services[1].agentId) fail();
  for (const service of c.services) {
    exactKeys(service, ['city', 'agentId', 'previous', 'next']);
    if (!/^(0|[1-9][0-9]{0,15})$/.test(service.agentId) || BigInt(service.agentId) > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    for (const profile of [service.previous, service.next]) {
      exactKeys(profile, ['agentURI', 'cardBase64']);
      if (typeof profile.cardBase64 !== 'string' || profile.cardBase64.length > 87384 ||
          Buffer.from(profile.cardBase64, 'base64').toString('base64') !== profile.cardBase64) fail();
      const registration = decodeRegistration(profile.agentURI);
      decodeCard(Buffer.from(profile.cardBase64, 'base64'));
      // Include the future owner policy before any swap can be approved.
      if (addresses.some((address) => same(address, registration['x-nandacity'].receiptSigner))) fail();
    }
    const before = decodeRegistration(service.previous.agentURI); const after = decodeRegistration(service.next.agentURI);
    if (same(before['x-nandacity'].receiptSigner, after['x-nandacity'].receiptSigner) ||
        digestBytes(bytes(service.previous.agentURI)) === digestBytes(bytes(service.next.agentURI))) fail();
  }
}
function decode(input: unknown): Journal {
  const j = input as Journal; exactKeys(j, ['version', 'kind', 'config', 'actions']);
  if (j.version !== '0.1' || j.kind !== 'existing-id-migration' || !Array.isArray(j.actions) || j.actions.length !== 3) fail();
  for (const action of j.actions) {
    if (action === null) continue;
    exactKeys(action, ['basis', 'prepared', 'approved', 'execution', 'effect']); point(action.basis);
    for (const value of [action.approved, action.execution, action.effect]) {
      if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) fail();
    }
    if (action.effect) {
      exactKeys(action.effect, ['blockNumber', 'blockHash', 'transactionHash', 'gasUsed']);
      point({ blockNumber: action.effect.blockNumber, blockHash: action.effect.blockHash });
      if (!/^0x[0-9a-fA-F]{64}$/.test(action.effect.transactionHash) || !/^[0-9]+$/.test(action.effect.gasUsed)) fail();
    }
  }
  return j;
}
async function canonical(client: PublicClient, basis: Point) {
  const block = await client.getBlock({ blockNumber: BigInt(basis.blockNumber) });
  if (String(block.number) !== basis.blockNumber || !block.hash || !same(block.hash, basis.blockHash)) throw new Outcome('unknown');
}
async function checkReplacementOwner(client: PublicClient, c: MigrationConfig) {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  if (!block.hash || block.number !== blockNumber) throw new Outcome('unknown');
  const code = await client.getCode({ address: c.replacementPrimary, blockNumber });
  await canonical(client, { blockNumber: String(blockNumber), blockHash: block.hash });
  if (code && code !== '0x') fail();
}
async function callFor(c: MigrationConfig, index: number): Promise<adapter.SafeSingleCall> {
  if (index > 0) return { to: c.domain.registry, value: '0', operation: 0,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'setAgentURI',
      args: [BigInt(c.services[index - 1]!.agentId), c.services[index - 1]!.next.agentURI] }) };
  const state = await adapter.readSafeAccount(c.network, c.account.predictedAddress, c.account, BigInt(c.basis.blockNumber));
  const position = state.owners.findIndex((a) => same(a, c.retiredPrimary)); if (position < 0) fail();
  const previous = position === 0 ? '0x0000000000000000000000000000000000000001' : state.owners[position - 1]!;
  return { to: c.account.predictedAddress, value: '0', operation: 0, data: encodeFunctionData({ abi: ownerAbi,
    functionName: 'swapOwner', args: [previous, c.retiredPrimary, c.replacementPrimary] }) };
}
const expected = (c: MigrationConfig, call: adapter.SafeSingleCall, index: number) => ({ network: c.network, account: c.account,
  payer: c.payer, call, currentOwners: owners(c, index > 0) });
async function validate(j: Journal, c: MigrationConfig) {
  if (!isDeepStrictEqual(j.config, c)) fail();
  const client = clientFor(c); await canonical(client, c.basis);
  await adapter.readSafeRegistryConfiguration(client, c);
  let incomplete = false;
  for (const [index, action] of j.actions.entries()) {
    if (incomplete && action) fail();
    if (!action) { incomplete = true; continue; }
    await canonical(client, action.basis);
    if (BigInt(action.basis.blockNumber) < BigInt(c.basis.blockNumber)) fail();
    const basis = expected(c, await callFor(c, index), index);
    if (action.prepared.nonce !== c.initialSafeNonce + index) fail();
    await adapter.validateStoredCall(action.prepared, basis, BigInt(action.basis.blockNumber));
    if (action.approved) {
      if (!same(action.approved.owner, c.backup)) fail();
      await adapter.validateStoredCall(action.approved, basis, BigInt(action.basis.blockNumber));
      for (const key of Object.keys(action.prepared) as (keyof adapter.PreparedSafeCall)[]) {
        if (!isDeepStrictEqual(action.approved[key], action.prepared[key])) fail();
      }
    }
    if (action.execution) {
      if (!action.approved || action.execution.payerNonce !== c.initialPayerNonce + index) fail();
      await adapter.validateStoredCall(action.execution, basis, BigInt(action.basis.blockNumber));
      for (const key of Object.keys(action.approved!) as (keyof adapter.ApprovedSafeCall)[]) {
        if (!isDeepStrictEqual(action.execution[key], action.approved![key])) fail();
      }
    }
    if (action.effect && !action.execution) fail();
    incomplete = !action.effect;
  }
}
async function checkProfiles(c: MigrationConfig, j: Journal, atBlock?: bigint) {
  const client = clientFor(c);
  for (const [index, service] of c.services.entries()) {
    const current = j.actions[index + 1]?.effect ? service.next : service.previous;
    const agent = { chainId: c.network.chainId, registry: c.domain.registry, agentId: service.agentId };
    const snapshot = await readIdentitySnapshot(client, agent, atBlock);
    verifyProfile({ agent, agentURI: current.agentURI, cardBytes: Buffer.from(current.cardBase64, 'base64') },
      snapshot);
    // Prospective subject/owner/card binding only: the planned URI is not a chain observation.
    // Current authority is checked above; publication effect is checked separately after execution.
    verifyProfile({ agent, agentURI: service.next.agentURI, cardBytes: Buffer.from(service.next.cardBase64, 'base64') },
      { ...snapshot, agentURI: service.next.agentURI });
    for (const profile of [service.previous, service.next]) await adapter.assertRuntimeSeparated(
      decodeRegistration(profile.agentURI)['x-nandacity'].receiptSigner as Address,
      { network: c.network, safe: c.account.predictedAddress }, c.domain.registry, service.agentId);
  }
}
async function reconcile(c: MigrationConfig, j: Journal, persist: (j: Journal) => Promise<void>, send: boolean) {
  const client = clientFor(c);
  if (!j.actions[0]?.execution) await checkReplacementOwner(client, c);
  for (const [index, action] of j.actions.entries()) {
    if (!action?.execution) break;
    const execution = action.execution;
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: execution.transactionHash }); }
    catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
    if (!receipt) {
      if (action.effect) throw new Outcome('unknown');
      try { await client.getTransaction({ hash: execution.transactionHash }); throw new Outcome('unknown'); }
      catch (error) { if (!(error instanceof TransactionNotFoundError)) throw error; }
      const nonce = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [c.payer, 'pending'] }));
      const safeNonce = await client.readContract({ address: c.account.predictedAddress, abi: ownerAbi, functionName: 'nonce' });
      if (nonce !== BigInt(execution.payerNonce) || safeNonce !== BigInt(execution.nonce)) throw new Outcome('unknown');
      // Only unsent swaps get current preflight; mined effects keep their exact historical reconciliation.
      if (index === 0) await checkReplacementOwner(client, c);
      if (!send) break;
      // Reconcile earlier exact hashes first: a lost reply may already have changed these profiles.
      // Only an absent action must still satisfy current preconditions before spending/mutating.
      await adapter.readSafeAccount(c.network, c.account.predictedAddress, c.account, undefined, owners(c, index > 0));
      await checkProfiles(c, j);
      await persist(j);
      try { await adapter.executePrepared(execution); }
      catch { throw new Outcome('unknown'); }
    }
    const call = await callFor(c, index);
    const read = index === 0 ? await adapter.readSingleCallEffect(client, execution, call) :
      await adapter.readSafeExecutionEffect(client, execution, { ...c, call });
    await adapter.readSafeAccount(c.network, c.account.predictedAddress, c.account, read.receipt.blockNumber, owners(c, true));
    if (index > 0) {
      const service = c.services[index - 1]!; const agent = { chainId: c.network.chainId, registry: c.domain.registry, agentId: service.agentId };
      verifyProfile({ agent, agentURI: service.next.agentURI, cardBytes: Buffer.from(service.next.cardBase64, 'base64') },
        await readIdentitySnapshot(client, agent, read.receipt.blockNumber));
    }
    const effect = { transactionHash: execution.transactionHash, blockNumber: String(read.receipt.blockNumber),
      blockHash: read.receipt.blockHash, gasUsed: String(read.receipt.gasUsed) };
    if (action.effect && !isDeepStrictEqual(action.effect, effect)) fail();
    if (!action.effect) { action.effect = effect; await persist(j); }
  }
  await adapter.readSafeAccount(c.network, c.account.predictedAddress, c.account, undefined, owners(c, !!j.actions[0]?.effect));
  await checkProfiles(c, j);
}
function report(c: MigrationConfig, j: Journal | null, override?: Status): MigrationReport {
  const status = (i: number): Status => j?.actions[i]?.effect ? 'verified' : override ?? (j?.actions[i]?.approved ? 'prepared' : 'approval-required');
  return { safe: c.account.predictedAddress, ownerStatus: status(0),
    services: c.services.map((s, i) => ({ city: s.city, agentId: s.agentId, status: status(i + 1) })),
    effects: j?.actions.flatMap((a) => a?.effect ? [a.effect] : []) ?? [] };
}
type Command = { kind: 'initialize' | 'next' | 'resume' | 'inspect' } |
  { kind: 'approve'; approval: adapter.ApprovedSafeCall } | { kind: 'execute'; payer: adapter.PayerWallet };
/** Existing IDs only, one account-wide reservation; callers must stop all onboarding writers first.
 * Config is independently trusted, not loaded from this private capability journal. */
export async function migrate(config: MigrationConfig, access: JournalAccess, command: Command):
Promise<{ report: MigrationReport; action?: adapter.PreparedSafeCall }> {
  const c = structuredClone(config); let verified: Journal | null = null;
  try {
    validateConfig(c, access);
    return await withJournalLock(access, decode, async (stored, persist) => {
      let j = stored;
      if (!j) {
        if (command.kind !== 'initialize') fail();
        j = { version: '0.1', kind: 'existing-id-migration', config: c, actions: [null, null, null] };
        await validate(j, c); await reconcile(c, j, persist, false);
        const client = clientFor(c);
        if (await client.readContract({ address: c.account.predictedAddress, abi: ownerAbi, functionName: 'nonce' }) !== BigInt(c.initialSafeNonce) ||
            BigInt(await client.request({ method: 'eth_getTransactionCount', params: [c.payer, 'pending'] })) !== BigInt(c.initialPayerNonce)) fail();
        await persist(j);
      }
      await validate(j, c); await reconcile(c, j, persist, command.kind === 'resume'); verified = j;
      const index = j.actions.findIndex((a) => !a?.effect);
      if (index < 0 || ['initialize', 'inspect', 'resume'].includes(command.kind)) return { report: report(c, j) };
      let action = j.actions[index];
      if (command.kind === 'next') {
        if (!action) {
          const call = await callFor(c, index);
          if (index === 0) {
            const kit = await Safe.init({ provider: c.network.rpcUrl, safeAddress: c.account.predictedAddress,
              isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(c.network) });
            const swap = await kit.createSwapOwnerTx({ oldOwnerAddress: c.retiredPrimary, newOwnerAddress: c.replacementPrimary });
            if (swap.data.data !== call.data || !same(swap.data.to, call.to) || swap.data.value !== '0' || swap.data.operation !== 0) fail();
          }
          const state = await adapter.readSafeAccount(c.network, c.account.predictedAddress, c.account, undefined, owners(c, index > 0));
          const prepared = await adapter.prepareSingleCall(c.network, c.account.predictedAddress, call);
          if (prepared.nonce !== c.initialSafeNonce + index) fail();
          action = { basis: { blockNumber: state.blockNumber, blockHash: state.blockHash }, prepared, approved: null, execution: null, effect: null };
          j.actions[index] = action; await persist(j);
        }
        return { report: report(c, j), action: structuredClone(action.prepared) };
      }
      if (!action) fail();
      if (command.kind === 'approve') {
        if (action!.execution || !same(command.approval.owner, c.backup)) fail();
        await adapter.validateStoredCall(command.approval, expected(c, await callFor(c, index), index));
        for (const key of Object.keys(action!.prepared) as (keyof adapter.PreparedSafeCall)[]) {
          if (!isDeepStrictEqual(command.approval[key], action!.prepared[key])) fail();
        }
        if (action!.approved && !isDeepStrictEqual(command.approval, action!.approved)) fail();
        action!.approved = structuredClone(command.approval); await persist(j);
      }
      if (command.kind === 'execute') {
        if (!same(command.payer.account.address, c.payer)) fail();
        if (!action!.approved) fail();
        if (!action!.execution) {
          const nonce = BigInt(await clientFor(c).request({ method: 'eth_getTransactionCount', params: [c.payer, 'pending'] }));
          if (nonce !== BigInt(c.initialPayerNonce + index)) fail();
          action!.execution = await adapter.prepareExecution(action!.approved!, command.payer); await persist(j);
        }
      }
      return { report: report(c, j) };
    });
  } catch (error) {
    // Never echo caught RPC or journal payloads. Failed whole-journal validation does not retain flags.
    const status = error instanceof JournalLocked ? 'locked' : error instanceof Outcome ? error.status : error instanceof BaseError ? 'unknown' : 'conflict';
    return { report: report(c, verified, status) };
  }
}
