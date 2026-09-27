import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SafeExport from '@safe-global/protocol-kit';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEther,
  type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { deploySafeSupportContracts } from '../../../src/demo/safeFixture.js';
import { deployRegistryWithDomain, deployReputationRegistry, published } from '../../../src/demo/registryFixture.js';
import { listenOwnedServer } from '../../../src/demo/twoIndexes.js';
import { protocolContractNetworks } from '../../../src/safe/contracts.js';
import * as adapter from '../../../src/safe/adapter.js';
import * as onboarding from '../../../src/safe/onboarding.js';
import { createJournalController } from '../../../src/safe/onboardingJournal.js';
import { readPrivateFile, writePrivateFile } from '../../../src/safe/privateFile.js';
import { writeBackupExport, readBackupExport, restoreBackup, type BackupBinding, type BackupMetadata } from '../../../src/safe/backup.js';
import { migrate, type MigrationConfig } from '../../../src/safe/migration.js';
import { decodeRegistration, digestBytes } from '../../../src/identity/profile.js';
import { readIdentitySnapshot } from '../../../src/identity/registry.js';
import { verifyProfile, type VerifiedProfile } from '../../../src/identity/verify.js';
import { observeRequestAuthority } from '../../../src/a2a/authority.js';
import { startLoopbackA2AService, CITY_REQUEST_DATA_TYPE } from '../../../src/a2a/service.js';
import { rpcTask, pollTerminalTask, filterForCity } from '../../../src/client/externalClient.js';
import { searchIndexes } from '../../../src/discovery/indexClient.js';
import { fetchOwnedCard } from '../../../src/discovery/cardClient.js';
import { verifyDiscoveryWithCard, type DiscoveredCandidate } from '../../../src/discovery/verifyDiscovery.js';
import { decodeEnvelope, signRequest, signProviderStatement } from '../../../src/interaction/signatures.js';
import { encodeStatement } from '../../../src/interaction/bytes.js';
import { verifyInteraction } from '../../../src/interaction/verify.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../../../src/interaction/schema.js';
import { encodeSupportingBundle, commitSupportingBundle } from '../../../src/feedback/supportingBundle.js';
import { encodeFeedbackDocument } from '../../../src/feedback/document.js';
import { signFeedback } from '../../../src/feedback/signatures.js';
import { prepareLocalFeedbackPublication, submitPreparedFeedback, type FeedbackEventReference } from '../../../src/demo/feedbackPublication.js';
import { readFeedbackCarryForward } from '../../../src/feedback/historicalRead.js';

const Safe = SafeExport as unknown as typeof SafeExport.default;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
let stage = 'start'; const cleanup: (() => Promise<void>)[] = [];
let closing = false;
async function close() { if (closing) return; closing = true; for (const run of cleanup.reverse()) await run().catch(() => undefined); }
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
process.on('disconnect', () => { void close().then(() => process.exit(0)); });
type Input = { role: 'original' | 'restore' | 'companion'; rpcUrl: string; exportDirectory: string; password: string;
  binding?: BackupBinding; indexOrigins?: [string, string] };
type Record = { city: 'Chicago' | 'Boston'; agentId: string; agentURI: string; cardBytes: Uint8Array; cardUrl: string; invocationUrl: string };
type History = { version: '0.1'; documentBase64: string; bundleBase64: string; answerBase64: string;
  reputationRegistry: Address; eventRef: FeedbackEventReference & { feedbackURI: string } };
async function privateRoot(prefix: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true })); return root;
}
const clients = (rpcUrl: string) => {
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5000 });
  return { transport, client: createPublicClient({ transport, pollingInterval: 25 }),
    control: createTestClient({ transport, mode: 'anvil' }) };
};
function requestFor(profile: VerifiedProfile, caller: PrivateKeyAccount, city: 'Chicago' | 'Boston'): CityRequest {
  const createdAt = now();
  return { kind: 'request', version: '0.1', service: { method: 'erc8004', agent: profile.agent },
    caller: { method: 'eip155-eoa', chainId: profile.agent.chainId, address: caller.address.toLowerCase() as Address },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: { blockNumber: profile.source.blockNumber, blockHash: profile.source.blockHash,
      agentOwner: profile.source.agentOwner.toLowerCase() as Address, agentUriDigest: profile.source.agentUriDigest,
      registrationDigest: profile.source.registrationDigest, cardDigest: profile.source.cardDigest,
      receiptSigner: profile.registration['x-nandacity'].receiptSigner.toLowerCase() as Address },
    createdAt, deadline: new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z'),
    input: { version: '0.1', capability: 'evening-plan', city, timeWindow: {
      start: city === 'Chicago' ? '2026-10-02T18:00:00-05:00' : '2026-10-02T18:00:00-04:00',
      end: city === 'Chicago' ? '2026-10-02T22:00:00-05:00' : '2026-10-02T22:00:00-04:00',
      timeZone: city === 'Chicago' ? 'America/Chicago' : 'America/New_York' },
    area: 'Downtown', budget: { currency: 'USD', minorUnits: '8500' }, transport: ['walk'], preferences: [] } };
}
async function profileFor(client: PublicClient, binding: BackupBinding, record: Record) {
  const agent = { chainId: binding.network.chainId, registry: binding.domain.registry, agentId: record.agentId };
  return verifyProfile({ agent, agentURI: record.agentURI, cardBytes: record.cardBytes }, await readIdentitySnapshot(client, agent));
}
async function services(client: PublicClient, binding: BackupBinding, runtime: PrivateKeyAccount, root: string,
  records: Record[]) {
  const server = createServer((request, response) => {
    const record = records.find((r) => new URL(r.cardUrl).pathname === request.url);
    response.statusCode = record ? 200 : 404; response.setHeader('content-type', 'application/json'); response.end(record?.cardBytes ?? '{}');
  });
  const origin = await listenOwnedServer(server);
  cleanup.push(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const result: { city: 'Chicago' | 'Boston'; cardUrl: string; invocationUrl: string }[] = [];
  for (const city of ['Chicago', 'Boston'] as const) {
    const directory = join(root, city); await mkdir(directory, { mode: 0o700 });
    const service = await startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: runtime, now,
      observeAuthority: async (request) => {
        const record = records.find((r) => r.city === city); assert.ok(record);
        return observeRequestAuthority(client, { domain: binding.domain, agent: { chainId: binding.network.chainId,
          registry: binding.domain.registry, agentId: record.agentId }, cardBytes: record.cardBytes, now }, request);
      } });
    cleanup.push(service.close);
    result.push({ city, cardUrl: `${origin}/cards/${result.length}.json`, invocationUrl: service.url });
  }
  return { specs: result, origin };
}
async function invoke(client: PublicClient, binding: BackupBinding, record: Record, caller: PrivateKeyAccount) {
  const profile = await profileFor(client, binding, record);
  const value = requestFor(profile, caller, record.city); const request = await signRequest(value, caller);
  const params = { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
    data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] } };
  const submitted = await rpcTask(record.invocationUrl, 'message/send', params);
  const task = await pollTerminalTask(record.invocationUrl, submitted.id); assert.equal(task.status.state, 'completed');
  const metadata = task.metadata!['org.nandacity'] as { acceptance: unknown; completion: unknown };
  const acceptance = envelopeSchema.parse(metadata.acceptance); const completion = envelopeSchema.parse(metadata.completion);
  const answerBase64 = task.artifacts![0]!.parts[0]!.data!['answerBase64'] as string;
  const authority = await observeRequestAuthority(client, { domain: binding.domain, agent: profile.agent, cardBytes: record.cardBytes, now }, value);
  const finding = await verifyInteraction({ request, acceptance, completion, ...authority, answerBytes: Buffer.from(answerBase64, 'base64') });
  assert.equal(finding.allPresentedEvidenceUsableAtObservation, true);
  // The exact same request is idempotently the same task, never fresh work.
  const replay = await rpcTask(record.invocationUrl, 'message/send', params); assert.equal(replay.id, task.id);
  return { request, acceptance, completion, answerBase64, profile };
}
async function original(input: Input) {
  const { client, control, transport } = clients(input.rpcUrl);
  // Every original secret lives only in this disposable child, never its supervisor.
  const primaryKey = generatePrivateKey(); const backupKey = generatePrivateKey();
  const primary = privateKeyToAccount(primaryKey); const backup = privateKeyToAccount(backupKey);
  const runtime = privateKeyToAccount(generatePrivateKey()); const payer = privateKeyToAccount(generatePrivateKey());
  const reviewer = privateKeyToAccount(generatePrivateKey());
  for (const account of [payer, reviewer]) await control.setBalance({ address: account.address, value: parseEther('100') });
  const wallet = createWalletClient({ account: payer, transport });
  stage = 'original-support'; const network = await deploySafeSupportContracts(client, wallet);
  const domain = await deployRegistryWithDomain(client, wallet);
  const reputationRegistry = await deployReputationRegistry(client, wallet, domain.registry);
  const prepared = await adapter.prepareSafeDeployment(network, { owners: [primary.address, backup.address], threshold: 1,
    saltNonce: '9', fallbackHandler: network.contracts.fallbackHandler.address });
  const binding: BackupBinding = { network, domain, registryRuntimeCodeHash: keccak256((await client.getCode({ address: domain.registry }))!),
    account: prepared.account, backupOwner: backup.address };
  const stateRoot = await privateRoot('city-exit-original-'); const journal = join(stateRoot, 'onboarding'); await mkdir(journal, { mode: 0o700 });
  const records: Record[] = []; const hosted = await services(client, binding, runtime, stateRoot, records);
  const config: onboarding.OnboardingConfig = { network, domain, registryRuntimeCodeHash: binding.registryRuntimeCodeHash,
    account: binding.account, journalDirectory: journal, payer: payer.address,
    services: hosted.specs.map((s) => ({ ...s, runtime: runtime.address, revision: 1, intentKey: s.city.toLowerCase() })) as unknown as onboarding.OnboardingConfig['services'] };
  const access = createJournalController(journal, () => undefined).local;
  stage = 'original-onboarding'; assert.notEqual((await onboarding.prepareOnboarding(config, access)).services[0]!.status, 'conflict');
  await onboarding.prepareExecution(config, access, wallet); await onboarding.resumeOnboarding(config, access);
  const kit = await Safe.init({ provider: input.rpcUrl, signer: primaryKey, safeAddress: prepared.predictedAddress,
    isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
  for (let i = 0; i < 4; i++) {
    const next = await onboarding.prepareNextAction(config, access); assert.ok(next.action && next.action.kind !== 'deploy');
    await onboarding.recordApproval(config, access, await adapter.approveSingleCall(next.action.prepared, kit));
    await onboarding.prepareExecution(config, access, wallet); await onboarding.resumeOnboarding(config, access);
  }
  const completed = await onboarding.inspectOnboarding(config, access);
  assert.deepEqual(completed.services.map((s) => s.status), ['verified', 'verified']);
  assert.equal((await onboarding.prepareNextAction(config, access)).action, undefined);
  for (const [index, spec] of config.services.entries()) {
    const record = published({ ...spec, agentId: completed.services[index]!.agentId!, owner: { address: prepared.predictedAddress },
      cardBytes: new Uint8Array(), agentURI: '' }, network.chainId, domain.registry, true, runtime.address);
    records.push(record);
  }
  const metadata: BackupMetadata = { version: '0.1', ...binding, services: [] as unknown as BackupMetadata['services'] };
  stage = 'original-interactions';
  for (const [index, record] of records.entries()) {
    const evidence = await invoke(client, binding, record, reviewer);
    const bundle = commitSupportingBundle(encodeSupportingBundle({ version: '0.1', request: evidence.request,
      acceptance: evidence.acceptance, completion: evidence.completion, cardBase64: Buffer.from(record.cardBytes).toString('base64') }).bytes);
    const request = decodeEnvelope(evidence.request).statement; const acceptance = decodeEnvelope(evidence.acceptance).statement;
    const completion = decodeEnvelope(evidence.completion).statement;
    assert.equal(request.value.kind, 'request'); if (request.value.kind !== 'request') throw new Error('request');
    const document = encodeFeedbackDocument(await signFeedback({ kind: 'feedback', version: '0.2',
      supportingBundleDigest: bundle.digest, service: request.value.service, reviewer: request.value.caller,
      interactionId: request.value.interactionId, requestDigest: request.digest, acceptanceDigest: acceptance.digest,
      reputationRegistry: { chainId: network.chainId, address: reputationRegistry.toLowerCase() as Address },
      rubric: 'evening-plan-usefulness-v0.1', value: 5, createdAt: now(), result: { kind: 'completion', completionDigest: completion.digest } }, reviewer));
    const feedbackURI = `${hosted.origin}/feedback/${index}.json`;
    const publication = { publicClient: client, walletClient: createWalletClient({ account: reviewer, transport }),
      identityRegistry: domain.registry, reputationRegistry, document: document.bytes, feedbackURI, allowedDocumentURL: feedbackURI,
      originalProfile: { agent: evidence.profile.agent, agentURI: record.agentURI, cardBytes: record.cardBytes },
      request: evidence.request, acceptance: evidence.acceptance, completion: evidence.completion };
    stage = `original-history-${index}`;
    const approved = await prepareLocalFeedbackPublication(publication);
    const head = await client.getBlock({ blockTag: 'latest' });
    const clock = BigInt(Math.floor(Date.now() / 1000));
    await control.setNextBlockTimestamp({ timestamp: clock > head.timestamp ? clock : head.timestamp + 1n });
    const anchored = await submitPreparedFeedback({ ...publication, prepared: approved });
    const history: History = { version: '0.1', documentBase64: Buffer.from(document.bytes).toString('base64'),
      bundleBase64: Buffer.from(bundle.bytes).toString('base64'), answerBase64: evidence.answerBase64,
      reputationRegistry, eventRef: { ...anchored.event, feedbackURI } };
    await writePrivateFile(input.exportDirectory, `history-${index}.json`, Buffer.from(JSON.stringify(history)), 512 * 1024);
    metadata.services.push({ city: record.city, agentId: record.agentId, agentURI: record.agentURI, cardUrl: record.cardUrl,
      invocationUrl: record.invocationUrl, cardDigest: digestBytes(record.cardBytes), profileDigest: digestBytes(new TextEncoder().encode(record.agentURI)),
      observation: { blockNumber: evidence.profile.source.blockNumber, blockHash: evidence.profile.source.blockHash } });
  }
  stage = 'original-export'; await writeBackupExport(input.exportDirectory, backupKey, input.password, metadata, binding, records.map((r) => r.cardBytes));
  return { binding, primaryKey, runtime, records };
}

async function restore(input: Input, attacker?: Awaited<ReturnType<typeof original>>) {
  const binding = input.binding!; const { client, control, transport } = clients(input.rpcUrl);
  const failures: { [name: string]: boolean } = {};
  stage = 'restore-backup';
  const recovered = await readBackupExport(input.exportDirectory, input.password, binding);
  const histories: History[] = [];
  stage = 'restore-evidence-preflight';
  for (let index = 0; index < 2; index++) {
    const file = await readPrivateFile(input.exportDirectory, `history-${index}.json`, 512 * 1024); assert.ok(file);
    const archived = JSON.parse(file.toString()) as History; histories.push(archived);
    const proof = await readFeedbackCarryForward({ client, domain: { chainId: binding.network.chainId,
      identityRegistry: binding.domain.registry, reputationRegistry: archived.reputationRegistry, genesisHash: binding.network.genesisHash },
      identityDomain: binding.domain, limits: { maxBlocks: 128, maxLogs: 64 }, observationBlock: await client.getBlockNumber({ cacheTime: 0 }),
      eventRef: archived.eventRef, documentBytes: Buffer.from(archived.documentBase64, 'base64'), bundleBytes: Buffer.from(archived.bundleBase64, 'base64') });
    assert.equal(proof.bundleCommitment, 'matched'); assert.equal(proof.historical.publication.publication, 'matched');
    assert.equal(proof.historical.originalAuthority.status, 'matched');
    assert.deepEqual(proof.carryForward.reasons, ['runtime-not-retired']);
  }
  const stale: DiscoveredCandidate[] = [];
  if (!attacker) {
    stage = 'original-index-candidates';
    for (const service of recovered.metadata.services) {
      const deadline = Date.now() + 30_000; let candidate: DiscoveredCandidate | undefined;
      while (!candidate && Date.now() < deadline) {
        candidate = (await searchIndexes([input.indexOrigins![0]], filterForCity(service.city))).candidates.find((c) =>
          c.agent.agentId === service.agentId && c.agentURI === service.agentURI);
        if (!candidate) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(candidate); stale.push(candidate);
    }
  }
  const backupKey = recovered.privateKey;
  const replacement = privateKeyToAccount(generatePrivateKey()); const runtime = privateKeyToAccount(generatePrivateKey());
  const payer = privateKeyToAccount(generatePrivateKey()); const caller = privateKeyToAccount(generatePrivateKey());
  assert.ok(![...binding.account.owners, binding.account.predictedAddress, runtime.address, replacement.address].includes(payer.address));
  assert.equal(await client.getBalance({ address: payer.address }), 0n);
  await control.setBalance({ address: payer.address, value: parseEther('10') });
  const wallet = createWalletClient({ account: payer, transport });
  const root = await privateRoot('city-exit-restored-'); const journal = join(root, 'migration'); await mkdir(journal, { mode: 0o700 });
  const records: Record[] = []; const hosted = await services(client, binding, runtime, root, records);
  const safe = binding.account.predictedAddress;
  const retired = binding.account.owners.find((a) => a.toLowerCase() !== binding.backupOwner.toLowerCase())!;
  const kit = await Safe.init({ provider: input.rpcUrl, signer: backupKey, safeAddress: safe,
    isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(binding.network) });
  // Separately funded ERC-721 operator: neither owner nor old/new runtime nor migration payer.
  const operator = privateKeyToAccount(generatePrivateKey());
  const operatorWallet = createWalletClient({ account: operator, transport });
  if (!attacker) {
    await control.setBalance({ address: operator.address, value: parseEther('1') });
    const call = await adapter.prepareSingleCall(binding.network, safe, { to: binding.domain.registry, value: '0', operation: 0,
      data: encodeFunctionData({ abi: parseAbi(['function setApprovalForAll(address,bool)']),
        functionName: 'setApprovalForAll', args: [operator.address, true] }) });
    await adapter.executePrepared(await adapter.prepareExecution(await adapter.approveSingleCall(call, kit), wallet));
  }
  for (const [index, spec] of hosted.specs.entries()) records.push(published({ ...spec, revision: 2,
    agentId: recovered.metadata.services[index]!.agentId, owner: { address: safe }, cardBytes: new Uint8Array(), agentURI: '' },
  binding.network.chainId, binding.domain.registry, true, runtime.address));
  const basis = await client.getBlock({ blockTag: 'latest' });
  const config: MigrationConfig = { journalDirectory: journal, onboardingWritersStopped: true, network: binding.network,
    domain: binding.domain, registryRuntimeCodeHash: binding.registryRuntimeCodeHash, account: binding.account,
    backup: binding.backupOwner, retiredPrimary: retired, replacementPrimary: replacement.address, payer: payer.address,
    initialSafeNonce: Number(await client.readContract({ address: safe, abi: parseAbi(['function nonce() view returns(uint256)']), functionName: 'nonce' })),
    initialPayerNonce: await client.getTransactionCount({ address: payer.address }), basis: { blockNumber: String(basis.number), blockHash: basis.hash },
    services: records.map((r, index) => ({ city: r.city, agentId: r.agentId,
      previous: { agentURI: recovered.metadata.services[index]!.agentURI, cardBase64: Buffer.from(recovered.cards[index]!).toString('base64') },
      next: { agentURI: r.agentURI, cardBase64: Buffer.from(r.cardBytes).toString('base64') } })) as unknown as MigrationConfig['services'] };
  const access = () => createJournalController(journal, () => undefined).local;
  const controlState = async () => ({
    owners: await client.readContract({ address: safe, abi: parseAbi(['function getOwners() view returns(address[])']), functionName: 'getOwners' }),
    safeNonce: await client.readContract({ address: safe, abi: parseAbi(['function nonce() view returns(uint256)']), functionName: 'nonce' }),
    payerNonce: await client.getTransactionCount({ address: payer.address, blockTag: 'pending' }),
    block: await client.getBlockNumber({ cacheTime: 0 }),
  });
  const assertConflict = (result: Awaited<ReturnType<typeof migrate>>) => {
    assert.equal(result.report.ownerStatus, 'conflict'); assert.equal(result.action, undefined);
    assert.ok(!/rawTransaction|ownerSignature|executionCalldata|privateKey|password/.test(JSON.stringify(result)));
  };
  if (!attacker) {
    stage = 'backup-refusals'; const originalBytes = (await readPrivateFile(input.exportDirectory, 'backup.json', 65536))!;
    const before = await client.getBlockNumber({ cacheTime: 0 });
    for (const mutate of [
      (v: any) => { v.Crypto.ciphertext = `${v.Crypto.ciphertext[0] === '0' ? '1' : '0'}${v.Crypto.ciphertext.slice(1)}`; },
      (v: any) => { v.address = replacement.address.slice(2); },
      (v: any) => { v.Crypto.kdfparams.n = 2 ** 30; },
    ]) {
      const changed = JSON.parse(originalBytes.toString()); mutate(changed);
      await assert.rejects(restoreBackup(JSON.stringify(changed), input.password, { owner: binding.backupOwner, network: binding.network, safe }));
    }
    await assert.rejects(readBackupExport(input.exportDirectory, `${input.password}x`, binding));
    await assert.rejects(restoreBackup(originalBytes.toString(), input.password, { owner: replacement.address, network: binding.network, safe }));
    await assert.rejects(readBackupExport(input.exportDirectory, input.password, { ...binding, network: { ...binding.network, genesisHash: `0x${'01'.repeat(32)}` } }));
    const metadataBytes = (await readPrivateFile(input.exportDirectory, 'metadata.json', 512 * 1024))!;
    const changedMetadata = JSON.parse(metadataBytes.toString()); changedMetadata.services[0].profileDigest = `0x${'00'.repeat(32)}`;
    await writePrivateFile(input.exportDirectory, 'metadata.json', Buffer.from(JSON.stringify(changedMetadata)), 512 * 1024);
    try { await assert.rejects(readBackupExport(input.exportDirectory, input.password, binding)); }
    finally { await writePrivateFile(input.exportDirectory, 'metadata.json', metadataBytes, 512 * 1024); }
    await rename(join(input.exportDirectory, 'card-0.json'), join(input.exportDirectory, 'held-card.json'));
    try { await assert.rejects(readBackupExport(input.exportDirectory, input.password, binding)); }
    finally { await rename(join(input.exportDirectory, 'held-card.json'), join(input.exportDirectory, 'card-0.json')); }
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before); failures['backup-mutations-no-signing'] = true;
    const snapshot = await control.snapshot();
    try {
      const swap = await kit.createSwapOwnerTx({ oldOwnerAddress: binding.backupOwner, newOwnerAddress: replacement.address });
      const prepared = await adapter.prepareSingleCall(binding.network, safe, { to: safe, data: swap.data.data as Hex, value: '0', operation: 0 });
      await adapter.executePrepared(await adapter.prepareExecution(await adapter.approveSingleCall(prepared, kit), wallet));
      await assert.rejects(restoreBackup(originalBytes.toString(), input.password, { owner: binding.backupOwner, network: binding.network, safe }));
      failures['removed-backup-no-recovery'] = true;
    } finally { await control.revert({ id: snapshot }); }
  }
  if (!attacker) {
    stage = 'migration-future-owner-runtime-refusal';
    const invalidRoot = join(root, 'invalid-migration'); await mkdir(invalidRoot, { mode: 0o700 });
    const overlap = published({ ...records[0]!, revision: 2, owner: { address: safe } }, binding.network.chainId,
      binding.domain.registry, true, replacement.address);
    const invalid = structuredClone(config); invalid.journalDirectory = invalidRoot;
    invalid.services[0].next = { agentURI: overlap.agentURI, cardBase64: Buffer.from(overlap.cardBytes).toString('base64') };
    const before = await client.getBlockNumber({ cacheTime: 0 });
    assert.equal((await migrate(invalid, createJournalController(invalidRoot, () => undefined).local,
      { kind: 'initialize' })).report.ownerStatus, 'conflict');
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
    failures['future-owner-runtime-refused'] = true;
    stage = 'migration-publication-binding-refusal';
    const mismatched = structuredClone(config); mismatched.journalDirectory = invalidRoot;
    mismatched.services[0].next.cardBase64 = config.services[1].next.cardBase64;
    assert.equal((await migrate(mismatched, createJournalController(invalidRoot, () => undefined).local,
      { kind: 'initialize' })).report.ownerStatus, 'conflict');
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
    failures['planned-publication-binding-refused'] = true;
    stage = 'migration-contract-owner-refusal';
    const contractRoot = join(root, 'contract-owner'); await mkdir(contractRoot, { mode: 0o700 });
    const contractOwner = { ...config, journalDirectory: contractRoot, replacementPrimary: binding.domain.registry };
    assert.ok((await client.getCode({ address: contractOwner.replacementPrimary }))!.length > 2);
    const beforeContract = await controlState();
    for (const kind of ['initialize', 'next', 'resume'] as const) {
      assertConflict(await migrate(contractOwner, createJournalController(contractRoot, () => undefined).local, { kind }));
    }
    assert.equal(await readPrivateFile(contractRoot, 'journal.json', 2 * 1024 * 1024), null);
    assert.deepEqual(await controlState(), beforeContract);
    failures['contract-owner-before-approval-refused'] = true;
  }
  stage = 'migration-initialize';
  assert.equal((await migrate(config, access(), { kind: 'initialize' })).report.ownerStatus, 'approval-required');
  let retiredRejected = false;
  for (let index = 0; index < 3; index++) {
    stage = `migration-next-${index}`;
    const next = await migrate(config, access(), { kind: 'next' }); assert.ok(next.action);
    const reopened = await migrate(config, access(), { kind: 'next' }); assert.ok(reopened.action);
    assert.equal(next.action.safeTxHash, reopened.action.safeTxHash);
    stage = `migration-approve-${index}`;
    const approved = await adapter.approveSingleCall(next.action, kit);
    if (!attacker && index === 0) {
      stage = 'migration-owner-code-before-approval';
      const saved = (await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!;
      const snapshot = await control.snapshot();
      try {
        // Local adversarial state injection, not a claim that an ordinary EOA can deploy over itself.
        await control.setCode({ address: replacement.address, bytecode: '0x60006000fd' }); await control.mine({ blocks: 1 });
        const beforeCode = await controlState();
        assertConflict(await migrate(config, access(), { kind: 'next' }));
        assertConflict(await migrate(config, access(), { kind: 'approve', approval: approved }));
        assert.deepEqual(await controlState(), beforeCode);
        assert.ok((await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!.equals(saved));
        failures['owner-code-before-approval-refused'] = true;
      } finally { await control.revert({ id: snapshot }); }
    }
    assert.notEqual((await migrate(config, access(), { kind: 'approve', approval: approved })).report.ownerStatus, 'conflict');
    stage = `migration-execute-${index}`;
    const signed = await migrate(config, access(), { kind: 'execute', payer: wallet }); assert.notEqual(signed.report.ownerStatus, 'conflict');
    if (!attacker && index === 0) {
      stage = 'migration-tamper-refusal';
      const saved = (await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!;
      const original = JSON.parse(saved.toString()); const before = await client.getBlockNumber({ cacheTime: 0 });
      for (const mutate of [
        (v: any) => { v.config.services[0].agentId = '99'; },
        (v: any) => { v.actions[0].prepared.nonce++; },
        (v: any) => { v.actions[0].execution.rawTransaction = '0x02'; },
        (v: any) => { v.actions[0].execution.payerNonce++; },
        (v: any) => { v.actions[0].approved.ownerSignature = '0x'; },
      ]) {
        const altered = structuredClone(original); mutate(altered);
        await writePrivateFile(journal, 'journal.json', Buffer.from(JSON.stringify(altered)), 2 * 1024 * 1024);
        const rejected = await migrate(config, access(), { kind: 'resume' }); assert.equal(rejected.report.ownerStatus, 'conflict');
        assert.ok(!/rawTransaction|ownerSignature|executionCalldata/.test(JSON.stringify(rejected.report)));
      }
      await writePrivateFile(journal, 'journal.json', saved, 2 * 1024 * 1024);
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before); failures['migration-tampering-no-signing'] = true;
      stage = 'migration-owner-code-before-broadcast';
      const snapshot = await control.snapshot();
      try {
        // Local adversarial state injection after exact signed bytes are durable, before first broadcast.
        await control.setCode({ address: replacement.address, bytecode: '0x60006000fd' }); await control.mine({ blocks: 1 });
        const beforeCode = await controlState();
        assertConflict(await migrate(config, access(), { kind: 'resume' }));
        assert.deepEqual(await controlState(), beforeCode);
        assert.ok((await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!.equals(saved));
        failures['owner-code-before-broadcast-refused'] = true;
      } finally { await control.revert({ id: snapshot }); }
    }
    if (!attacker && index === 1) {
      const file = (await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!;
      for (const mutation of ['runtime-approval', 'previous-uri'] as const) {
        stage = `migration-operator-${mutation}-before-send`;
        const snapshot = await control.snapshot();
        const fetcher = globalThis.fetch; let sends = 0;
        try {
          const beforeMutation = await controlState();
          const data = mutation === 'runtime-approval' ? encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']),
            functionName: 'approve', args: [runtime.address, BigInt(records[0]!.agentId)] }) :
            encodeFunctionData({ abi: parseAbi(['function setAgentURI(uint256,string)']), functionName: 'setAgentURI',
              args: [BigInt(records[0]!.agentId), 'https://operator.example/intervening-profile'] });
          const mutationReceipt = await client.waitForTransactionReceipt({ hash:
            await operatorWallet.sendTransaction({ to: binding.domain.registry, data, chain: null }) });
          assert.equal(mutationReceipt.status, 'success');
          if (mutation === 'runtime-approval') assert.equal((await client.readContract({ address: binding.domain.registry,
            abi: parseAbi(['function getApproved(uint256) view returns(address)']), functionName: 'getApproved',
            args: [BigInt(records[0]!.agentId)], blockNumber: mutationReceipt.blockNumber })).toLowerCase(), runtime.address.toLowerCase());
          else assert.equal((await readIdentitySnapshot(client, { chainId: binding.network.chainId,
            registry: binding.domain.registry, agentId: records[0]!.agentId }, mutationReceipt.blockNumber)).agentURI,
          'https://operator.example/intervening-profile');
          const beforeState = await controlState();
          assert.deepEqual(beforeState.owners, beforeMutation.owners);
          assert.equal(beforeState.safeNonce, beforeMutation.safeNonce); assert.equal(beforeState.payerNonce, beforeMutation.payerNonce);
          globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
            if (typeof args[1]?.body === 'string' && JSON.parse(args[1].body).method === 'eth_sendRawTransaction') sends++;
            return fetcher(...args);
          };
          const refused = await migrate(config, access(), { kind: 'resume' });
          assert.equal(sends, 0); assertConflict(refused);
          assert.deepEqual(await controlState(), beforeState);
          assert.ok((await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!.equals(file));
          failures[`operator-${mutation}-before-send-refused`] = true;
        } finally {
          globalThis.fetch = fetcher; await control.revert({ id: snapshot });
          await writePrivateFile(journal, 'journal.json', file, 2 * 1024 * 1024);
        }
      }
      stage = 'migration-lost-reply';
      const saved = (await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!;
      const fetcher = globalThis.fetch; let lostHash: string | undefined; let drops = 0;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        const body = args[1]?.body; const rpc = typeof body === 'string' ? JSON.parse(body) : undefined;
        if (rpc?.method === 'eth_getTransactionReceipt' && rpc.params[0] === lostHash) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: null }));
        }
        const response = await fetcher(...args);
        if (rpc?.method === 'eth_sendRawTransaction') { drops++; lostHash = keccak256(rpc.params[0]); await response.body?.cancel(); throw new Error('lost'); }
        return response;
      };
      try { const uncertain = await migrate(config, access(), { kind: 'resume' }); assert.equal(uncertain.report.services[0]!.status, 'unknown'); }
      finally { globalThis.fetch = fetcher; }
      assert.equal(drops, 1);
      assert.ok((await readPrivateFile(journal, 'journal.json', 2 * 1024 * 1024))!.equals(saved));
      failures['lost-reply-exact-bytes'] = true;
    }
    stage = `migration-resume-${index}`;
    const result = await migrate(config, access(), { kind: 'resume' });
    assert.equal(result.report.ownerStatus, 'verified');
    if (index === 0 && attacker) {
      const retiredKit = await Safe.init({ provider: input.rpcUrl, signer: attacker.primaryKey, safeAddress: safe,
        isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(binding.network) });
      const fresh = await adapter.prepareSingleCall(binding.network, safe, { to: safe, value: '0', data: '0x', operation: 0 });
      assert.equal(fresh.nonce, next.action.nonce + 1);
      await assert.rejects(adapter.approveSingleCall(fresh, retiredKit), /current owner/); retiredRejected = true;
    }
    if (index === 1) {
      assert.deepEqual(result.report.services.map((s) => s.status), ['verified', 'approval-required']);
      const again = await migrate(config, access(), { kind: 'inspect' });
      assert.deepEqual(again.report.services.map((s) => s.status), ['verified', 'approval-required']);
      failures['partial-existing-ids'] = true;
    }
  }
  stage = 'migration-complete';
  const final = (await migrate(config, access(), { kind: 'inspect' })).report;
  assert.deepEqual(final.services.map((s) => s.status), ['verified', 'verified']);
  const current = await adapter.readSafeAccount(binding.network, safe, binding.account, undefined, [replacement.address, binding.backupOwner]);
  assert.ok(!current.owners.some((a) => a.toLowerCase() === retired.toLowerCase()));
  for (const address of [...binding.account.owners, safe]) assert.equal(await client.getBalance({ address }), 0n);
  const history: string[] = [];
  for (const [index, record] of records.entries()) {
    stage = `restored-history-${index}`;
    const archived = histories[index]!;
    const historyInput = { client, domain: { chainId: binding.network.chainId, identityRegistry: binding.domain.registry,
      reputationRegistry: archived.reputationRegistry, genesisHash: binding.network.genesisHash }, identityDomain: binding.domain,
      limits: { maxBlocks: 128, maxLogs: 64 }, observationBlock: BigInt(current.blockNumber), eventRef: archived.eventRef,
      documentBytes: Buffer.from(archived.documentBase64, 'base64'), bundleBytes: Buffer.from(archived.bundleBase64, 'base64') };
    const retained = await readFeedbackCarryForward(historyInput);
    stage = `history-${retained.historical.publication.publication}-${retained.historical.publication.claimedFeedbackTime}`;
    assert.equal(retained.carryForward.status, 'qualified'); history.push(retained.carryForward.status);
    stage = 'history-missing';
    assert.equal((await readFeedbackCarryForward({ ...historyInput, bundleBytes: null })).carryForward.status, 'unknown');
    stage = 'history-mismatched'; const wrong = Buffer.from(historyInput.bundleBytes); wrong[wrong.length - 2] = wrong[wrong.length - 2]! ^ 1;
    assert.notEqual((await readFeedbackCarryForward({ ...historyInput, bundleBytes: wrong })).carryForward.status, 'qualified');
    stage = 'history-incomplete'; assert.equal((await readFeedbackCarryForward({ ...historyInput, limits: { maxBlocks: 1, maxLogs: 1 } })).carryForward.status, 'unknown');
    failures['history-missing-mismatched-incomplete'] = true;
    stage = `fresh-interaction-${index}`; await invoke(client, binding, record, caller);
  }
  for (const [index, candidate] of stale.entries()) {
    const verdict = await verifyDiscoveryWithCard(candidate, client, { chainId: binding.network.chainId, registry: binding.domain.registry },
      filterForCity(records[index]!.city), async () => recovered.cards[index]!);
    assert.equal(verdict.status, 'rejected');
  }
  if (!attacker) failures['stale-index-no-fresh-authority'] = true;
  if (attacker) {
    stage = 'adversarial-runtime'; const old = attacker.records[0]!;
    const agent = { chainId: binding.network.chainId, registry: binding.domain.registry, agentId: old.agentId };
    const oldSource = recovered.metadata.services[0]!.observation;
    const oldProfile = verifyProfile({ agent, agentURI: old.agentURI, cardBytes: old.cardBytes },
      await readIdentitySnapshot(client, agent, BigInt(oldSource.blockNumber)));
    const value = requestFor(oldProfile, caller, old.city); // unused, live interaction ID, not historical replay
    const request = await signRequest(value, caller);
    const acceptance = await signProviderStatement({ kind: 'acceptance', version: '0.1', requestDigest: encodeStatement(value).digest,
      acceptanceId: `0x${randomBytes(32).toString('hex')}`, acceptedAt: now(), deadline: value.deadline }, attacker.runtime, oldProfile);
    const finding = await verifyInteraction({ request, acceptance, basisProfile: oldProfile,
      currentProfile: await profileFor(client, binding, records[0]!), continuity: 'changed', observedAt: now() });
    assert.equal(finding.acceptance!.cryptography, 'valid'); assert.equal(finding.acceptance!.deadline, 'live');
    assert.equal(finding.acceptance!.currentAuthority, 'unauthorized'); assert.equal(finding.allPresentedEvidenceUsableAtObservation, false);
    // Also invoke the still-running old runtime's live authority path with that unused ID.
    await assert.rejects(rpcTask(old.invocationUrl, 'message/send', { message: { kind: 'message', role: 'user', messageId: randomUUID(),
      parts: [{ kind: 'data', data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
      configuration: { blocking: false, acceptedOutputModes: ['application/json'] } }));
    return { adversarial: { label: 'adversarial-revocation-companion' as const, freshRetiredPrimaryRejected: retiredRejected,
      freshRetiredRuntimeRejected: true }, failures };
  }
  stage = 'two-index-discovery'; let discoveriesVerified = 0;
  for (const origin of input.indexOrigins!) for (const record of records) {
    const deadline = Date.now() + 30_000; let accepted = false;
    while (Date.now() < deadline && !accepted) {
      const search = await searchIndexes([origin], filterForCity(record.city));
      const candidate = search.candidates.find((c) => c.agent.agentId === record.agentId && c.agentURI === record.agentURI);
      if (candidate) accepted = (await verifyDiscoveryWithCard(candidate, client, { chainId: binding.network.chainId,
        registry: binding.domain.registry }, filterForCity(record.city), (url) => fetchOwnedCard(url, hosted.origin))).status === 'verified';
      if (!accepted) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(accepted); discoveriesVerified++;
  }
  return { cleanExit: { label: 'same-account-clean-exit' as const, unchangedSafeAndIds: current.safe === safe &&
    final.services.every((s, i) => s.agentId === recovered.metadata.services[i]!.agentId), retiredPrimaryAbsent: true,
    replacementExecutorSelfFunded: true, services: final.services, discoveriesVerified, freshInteractionsVerified: 2,
    history, transactions: final.effects.length, gas: final.effects.map((e) => e.gasUsed) }, failures };
}

process.once('message', (message: Input) => {
  void (async () => {
    if (message.role === 'original') {
      const built = await original(message); process.send?.({ type: 'ready', binding: built.binding });
    } else if (message.role === 'companion') {
      const attacker = await original(message);
      const result = await restore({ ...message, binding: attacker.binding }, attacker);
      process.send?.({ type: 'complete', ...result });
    } else process.send?.({ type: 'complete', ...await restore(message) });
  })().catch(() => { process.send?.({ type: 'failed', stage }); });
});
