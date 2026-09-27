import SafeExport from '@safe-global/protocol-kit';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readBackupExport, writeBackupExport, type BackupBinding, type BackupMetadata } from '../safe/backup.js';
import { migrate, type MigrationConfig, type MigrationReport, type MigrationService } from '../safe/migration.js';
import type { JournalAccess } from '../safe/onboardingJournal.js';
import * as adapter from '../safe/adapter.js';
import * as onboarding from '../safe/onboarding.js';
import { protocolContractNetworks, type SafeNetworkConfig } from '../safe/contracts.js';
import { assertLocalWriteRpcUrl } from './anvil.js';
import { registryAbi } from './registryFixture.js';

const Safe = SafeExport as unknown as typeof SafeExport.default;
export type SessionWalletOperations = {
  onboard: { network: SafeNetworkConfig; domain: onboarding.OnboardingConfig['domain']; registryRuntimeCodeHash: Hex;
    primary: Hex; backup: Hex; payer: Hex; saltNonce: string; services: onboarding.OnboardingConfig['services'] };
  'cross-operator': { network: SafeNetworkConfig; registry: Address; safe: Address; primary: Hex; payer: Hex; victimId: string };
  'export-backup': { exportDirectory: string; backup: Hex; password: string; metadata: BackupMetadata;
    binding: BackupBinding; cardsBase64: string[] };
  recover: { exportDirectory: string; password: string; binding: BackupBinding; retiredPrimary: Hex;
    services: readonly [MigrationService, MigrationService] };
};
export type SessionWalletResults = {
  onboard: { config: onboarding.OnboardingConfig; report: onboarding.OnboardingReport };
  'cross-operator': { rejected: true };
  'export-backup': { exported: true };
  recover: { report: MigrationReport; replacementPrimary: Address; retiredOwnerRejected: true };
};
export type SessionWalletInput = { [K in keyof SessionWalletOperations]: SessionWalletOperations[K] & {
  kind: K; journal: Omit<JournalAccess, 'guard'>;
} }[keyof SessionWalletOperations];

async function run(input: SessionWalletInput): Promise<SessionWalletResults[keyof SessionWalletResults]> {
  const network = 'network' in input ? input.network : input.binding.network;
  assertLocalWriteRpcUrl(network.rpcUrl);
  const transport = http(network.rpcUrl, { retryCount: 0, timeout: 5000 });
  const access: JournalAccess = { ...input.journal, guard: () => undefined };
  if (input.kind === 'onboard') {
    const deployment = await adapter.prepareSafeDeployment(network, {
      owners: [privateKeyToAccount(input.primary).address, privateKeyToAccount(input.backup).address],
      threshold: 1, saltNonce: input.saltNonce, fallbackHandler: network.contracts.fallbackHandler.address });
    const payer = createWalletClient({ account: privateKeyToAccount(input.payer), transport });
    const config: onboarding.OnboardingConfig = { journalDirectory: access.root, network, domain: input.domain,
      registryRuntimeCodeHash: input.registryRuntimeCodeHash, account: deployment.account,
      payer: payer.account.address, services: input.services };
    await onboarding.prepareOnboarding(config, access);
    for (let i = 0; i < 5; i++) {
      const next = await onboarding.prepareNextAction(config, access);
      if (!next.action) throw new Error('onboarding action unavailable');
      if (next.action.kind !== 'deploy') {
        const kit = await Safe.init({ provider: network.rpcUrl, signer: input.primary, safeAddress: deployment.account.predictedAddress,
          isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
        await onboarding.recordApproval(config, access, await adapter.approveSingleCall(next.action.prepared, kit));
      }
      await onboarding.prepareExecution(config, access, payer); await onboarding.resumeOnboarding(config, access);
    }
    const report = await onboarding.inspectOnboarding(config, access);
    if (report.services.some((service) => service.status !== 'verified')) throw new Error('session onboarding not verified');
    return { config, report };
  }
  if (input.kind === 'cross-operator') {
    const badCall = await adapter.prepareSingleCall(network, input.safe, { to: input.registry, value: '0', operation: 0,
      data: encodeFunctionData({ abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(input.victimId), 'data:,unauthorized'] }) });
    const kit = await Safe.init({ provider: network.rpcUrl, signer: input.primary, safeAddress: input.safe,
      isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
    const payer = createWalletClient({ account: privateKeyToAccount(input.payer), transport });
    let rejected = false;
    try { await adapter.executePrepared(await adapter.prepareExecution(await adapter.approveSingleCall(badCall, kit), payer)); }
    catch { rejected = true; }
    if (!rejected) throw new Error('cross-operator write accepted');
    return { rejected: true };
  }
  if (input.kind === 'export-backup') {
    await writeBackupExport(input.exportDirectory, input.backup, input.password, input.metadata, input.binding,
      input.cardsBase64.map((card) => Buffer.from(card, 'base64')));
    return { exported: true };
  }
  const recovered = await readBackupExport(input.exportDirectory, input.password, input.binding);
  for (const [i, service] of input.services.entries()) {
    if (service.agentId !== recovered.metadata.services[i]!.agentId || service.city !== recovered.metadata.services[i]!.city ||
        service.previous.agentURI !== recovered.metadata.services[i]!.agentURI ||
        service.previous.cardBase64 !== Buffer.from(recovered.cards[i]!).toString('base64')) throw new Error('backup service mismatch');
  }
  const client = createPublicClient({ transport, pollingInterval: 25, cacheTime: 0 });
  const payer = privateKeyToAccount(generatePrivateKey()), replacement = privateKeyToAccount(generatePrivateKey());
  await createTestClient({ transport, mode: 'anvil' }).setBalance({ address: payer.address, value: parseEther('10') });
  const wallet = createWalletClient({ account: payer, transport });
  const basis = await client.getBlock(); const safe = input.binding.account.predictedAddress;
  const retired = privateKeyToAccount(input.retiredPrimary).address;
  const config: MigrationConfig = { journalDirectory: access.root, onboardingWritersStopped: true,
    network, domain: input.binding.domain, registryRuntimeCodeHash: input.binding.registryRuntimeCodeHash,
    account: input.binding.account, backup: input.binding.backupOwner, retiredPrimary: retired,
    replacementPrimary: replacement.address, payer: payer.address,
    initialSafeNonce: adapter.checkedNonce(await client.readContract({ address: safe,
      abi: parseAbi(['function nonce() view returns(uint256)']), functionName: 'nonce' })),
    initialPayerNonce: await client.getTransactionCount({ address: payer.address, blockTag: 'pending' }),
    basis: { blockNumber: String(basis.number), blockHash: basis.hash }, services: input.services };
  const kit = await Safe.init({ provider: network.rpcUrl, signer: recovered.privateKey, safeAddress: safe,
    isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
  const initialized = await migrate(config, access, { kind: 'initialize' });
  if (initialized.report.ownerStatus !== 'approval-required') throw new Error('migration not initialized');
  for (let i = 0; i < 3; i++) {
    const next = await migrate(config, access, { kind: 'next' }); if (!next.action) throw new Error('migration action unavailable');
    await migrate(config, access, { kind: 'approve', approval: await adapter.approveSingleCall(next.action, kit) });
    await migrate(config, access, { kind: 'execute', payer: wallet });
    await migrate(config, access, { kind: 'resume' });
  }
  const { report } = await migrate(config, access, { kind: 'inspect' });
  if (report.ownerStatus !== 'verified' || report.services.some((service) => service.status !== 'verified')) throw new Error('migration not verified');
  const ownerState = await adapter.readSafeAccount(network, safe, input.binding.account, undefined,
    [replacement.address, input.binding.backupOwner]);
  if (ownerState.owners.some((owner) => owner.toLowerCase() === retired.toLowerCase())) throw new Error('retired owner remains');
  const attempted = await adapter.prepareSingleCall(network, safe, { to: input.binding.domain.registry, value: '0', operation: 0,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'setAgentURI',
      args: [BigInt(input.services[0].agentId), input.services[0].next.agentURI] }) });
  const retiredKit = await Safe.init({ provider: network.rpcUrl, signer: input.retiredPrimary, safeAddress: safe,
    isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
  let denied = false;
  try { await adapter.approveSingleCall(attempted, retiredKit); } catch { denied = true; }
  if (!denied) throw new Error('retired owner accepted fresh approval');
  return { report, replacementPrimary: replacement.address, retiredOwnerRejected: true };
}

// One explicit owned operation per child. No secret argv/env/log output. Process
// termination closes even Safe SDK transports that do not accept caller signals.
if (process.send) process.once('message', (input: SessionWalletInput) => {
  void run(input).then((result) => {
    process.send!({ type: 'complete', kind: input.kind, result }, () => process.disconnect());
  }).catch(() => { process.send?.({ type: 'failed' }, () => process.disconnect()); process.exitCode = 1; });
});
