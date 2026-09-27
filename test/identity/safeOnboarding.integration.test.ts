import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import SafeExport from '@safe-global/protocol-kit';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEther,
  toHex, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deploySafeSupportContracts } from '../../src/demo/safeFixture.js';
import { deployRegistryWithDomain } from '../../src/demo/registryFixture.js';
import { protocolContractNetworks } from '../../src/safe/contracts.js';
import * as adapter from '../../src/safe/adapter.js';
import { createJournalController } from '../../src/safe/onboardingJournal.js';
import type { OnboardingReport } from '../../src/safe/onboarding.js';

const Safe = SafeExport as unknown as typeof SafeExport.default;
const tokenAbi = parseAbi(['function ownerOf(uint256) view returns(address)', 'function tokenURI(uint256) view returns(string)']);

// All 25 fresh callers independently compile the pinned reference contracts.
// Linux CI reached the final authority checks at 420s; keep those checks and
// fresh-process isolation, with headroom only in this aggregate test deadline.
test('one Safe resumes exact persisted actions across two city publications without fresh signatures', { timeout: 600_000 }, async (t) => {
  const onboarding = await import('../../src/safe/onboarding.js').catch(() => undefined);
  assert.ok(onboarding, 'bounded shared onboarding operations must exist');
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0 });
    const client = createPublicClient({ transport, pollingInterval: 20 });
    const control = createTestClient({ mode: 'anvil', transport });
    const keys = [generatePrivateKey(), generatePrivateKey()] as const;
    const owners = keys.map((key) => privateKeyToAccount(key));
    const payer = privateKeyToAccount(generatePrivateKey());
    const runtime = privateKeyToAccount(generatePrivateKey());
    await control.setBalance({ address: payer.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: payer, transport });
    const network = await deploySafeSupportContracts(client, wallet);
    const domain = await deployRegistryWithDomain(client, wallet);
    const deployment = await adapter.prepareSafeDeployment(network, {
      owners: [owners[0]!.address, owners[1]!.address] as [Address, Address], threshold: 1,
      saltNonce: '7', fallbackHandler: network.contracts.fallbackHandler.address,
    });
    const root = await mkdtemp(join(await realpath(tmpdir()), 'city-onboarding-integration-'));
    try {
      const config = { journalDirectory: root, network, domain,
        registryRuntimeCodeHash: keccak256((await client.getCode({ address: domain.registry }))!),
        account: deployment.account, payer: payer.address,
        services: [
          { intentKey: 'operator-chicago', city: 'Chicago' as const, cardUrl: 'https://city.example/chicago/card',
            invocationUrl: 'https://city.example/chicago/a2a', revision: 1, operatorLabel: 'Synthetic', runtime: runtime.address },
          { intentKey: 'operator-boston', city: 'Boston' as const, cardUrl: 'https://city.example/boston/card',
            invocationUrl: 'https://city.example/boston/a2a', revision: 1, operatorLabel: 'Synthetic', runtime: runtime.address },
        ] as const };
      let access = createJournalController(root, () => undefined).local;
      let childCount = 0;
      const childOperation = async (operation: 'reopen' | 'next' | 'approve' | 'resume', approval?: adapter.ApprovedSafeCall,
        fault?: 'drop-request') => {
        childCount++;
        const controller = createJournalController(root, () => undefined);
        const child = fork(new URL('./fixtures/safeOnboardingWorker.ts', import.meta.url), [], {
          execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const childAccess = controller.trackCaller(child);
        const result = new Promise<{ report: OnboardingReport; safeTxHash?: string }>((resolve, reject) => {
          let returned = false;
          child.on('message', (message) => {
            if (message && typeof message === 'object' && 'type' in message && message.type === 'result') {
              returned = true; resolve(message as unknown as { report: OnboardingReport; safeTxHash?: string });
            }
          });
          child.once('exit', () => { if (!returned) reject(new Error('owned onboarding caller exited without a result')); });
        });
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.send({ ...childAccess, guard: undefined, mode: 'onboarding', config, operation, approval, fault });
        try { const value = await result; await exited; return value; }
        finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
      };
      const restart = async () => {
        access = createJournalController(root, () => undefined).local;
        return (await childOperation('reopen')).report;
      };
      assert.equal((await onboarding.prepareOnboarding(config, access)).services[0]!.status, 'prepared');
      await restart();
      const unsigned = await onboarding.prepareNextAction(config, access);
      assert.equal(unsigned.action?.kind, 'deploy');
      await onboarding.prepareExecution(config, access, wallet);
      await restart();
      const deployed = await onboarding.resumeOnboarding(config, access);
      assert.equal(deployed.services[0]!.status, 'approval-required');
      const kit = await Safe.init({ provider: rpcUrl, signer: keys[0], safeAddress: deployment.predictedAddress,
        isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
      await t.test('changed current registry pin refuses before preparing another action', async () => {
        const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
        try {
          const original = (await client.getCode({ address: config.domain.knownImplementation.address }))!;
          const altered = `${original.slice(0, -2)}${(Number.parseInt(original.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')}` as `0x${string}`;
          await control.setCode({ address: config.domain.knownImplementation.address, bytecode: altered });
          const result = await onboarding.prepareNextAction(config, access);
          assert.equal(result.report.services[0]!.status, 'conflict'); assert.equal(result.action, undefined);
        } finally { await control.revert({ id: snapshot }); await writeFile(file, retained); }
      });
      let approvals = 0;
      let beforeFinalPublication: `0x${string}` | undefined;
      for (const kind of ['register', 'publish', 'register', 'publish'] as const) {
        if (approvals === 0) {
          const race = await Promise.all([childOperation('next'), childOperation('next')]);
          assert.equal(race.filter((value) => value.report.services[0]!.status === 'locked').length, 1);
          assert.equal(race.filter((value) => value.safeTxHash !== undefined).length, 1);
        }
        const next = await onboarding.prepareNextAction(config, access);
        assert.equal(next.action?.kind, kind);
        assert.ok(next.action);
        const hash = next.action.prepared.safeTxHash;
        await restart();
        const same = await onboarding.prepareNextAction(config, access);
        assert.ok(same.action && same.action.kind !== 'deploy');
        assert.equal(same.action.prepared.safeTxHash, hash);
        const approval = await adapter.approveSingleCall(next.action.prepared, kit); approvals++;
        if (approvals === 1) {
          const race = await Promise.all([childOperation('approve', approval), childOperation('approve', approval)]);
          assert.equal(race.filter((value) => value.report.services[0]!.status === 'locked').length, 1);
        } else await onboarding.recordApproval(config, access, approval);
        await restart();
        if (approvals === 1) await t.test('external payer use before preparation refuses instead of silently signing a new nonce', async () => {
          const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
          try {
            await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: payer.address, value: 0n, chain: null }) });
            assert.equal((await onboarding.prepareExecution(config, access, wallet)).services[0]!.status, 'conflict');
          } finally { await control.revert({ id: snapshot }); await writeFile(file, retained); }
        });
        await onboarding.prepareExecution(config, access, wallet);
        await restart();
        if (kind === 'register' && approvals === 1) {
          await t.test('untrusted journal/config mutations refuse without a signature, send or fresh reservation', async () => {
            const file = join(root, 'journal.json'); const retained = await readFile(file); const saved = JSON.parse(retained.toString());
            const mutations: ((value: typeof saved) => void)[] = [
              (value) => { value.config.network.genesisHash = toHex(1n, { size: 32 }); },
              (value) => { value.config.services[0].invocationUrl += '/altered'; },
              (value) => { value.services[0].specDigest = toHex(1n, { size: 32 }); },
              (value) => { value.services[0].registration.prepared.nonce++; },
              (value) => { value.services[0].registration.approved.ownerSignature = '0x'; },
              (value) => { value.services[0].registration.execution.rawTransaction = '0x02'; },
              (value) => { value.services[0].registration.execution.payerNonce++; },
              (value) => { value.services[0].registration.prepared.call.data = '0x'; },
              (value) => { value.services[0].registration.execution.extra = 'untrusted'; },
              (value) => { value.services[0].registration.execution = 0; },
              (value) => { value.services[0].registration.execution = null; value.services[0].registration.approved = false; },
            ];
            const before = await client.getBlockNumber({ cacheTime: 0 });
            try {
              for (const mutate of mutations) {
                const changed = structuredClone(saved); mutate(changed); await writeFile(file, JSON.stringify(changed));
                assert.equal((await onboarding.prepareExecution(config, access, wallet)).services[0]!.status, 'conflict');
              }
            } finally { await writeFile(file, retained); }
            assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
          });
          await t.test('a substituted pending and mined payer nonce stays unknown, preserving original signed bytes', async () => {
            const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
            try {
              await control.setAutomine(false);
              await wallet.sendTransaction({ to: payer.address, value: 0n, chain: null, gas: 21000n });
              assert.equal((await onboarding.resumeOnboarding(config, access)).services[0]!.status, 'unknown');
              await control.mine({ blocks: 1 });
              assert.equal((await onboarding.resumeOnboarding(config, access)).services[0]!.status, 'unknown');
              assert.ok((await readFile(file)).equals(retained), 'unresolved nonce must not replace durable signed bytes');
            } finally { await control.setAutomine(true); await control.revert({ id: snapshot }); }
          });
          await t.test('durability failure prohibits broadcast and retains original signed bytes', async () => {
            const file = join(root, 'journal.json'); const retained = await readFile(file);
            const handle = await open(file, 'r'); const prototype = Object.getPrototypeOf(handle); const sync = prototype.sync;
            const failed = t.mock.method(prototype, 'sync', async function(this: import('node:fs/promises').FileHandle) {
              const stat = await this.stat();
              if (stat.isFile() && stat.size > 1000) throw new Error('synthetic durability failure');
              return sync.call(this);
            });
            const fetcher = globalThis.fetch; let sends = 0;
            const dispatch = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
              if (typeof args[1]?.body === 'string' && JSON.parse(args[1].body).method === 'eth_sendRawTransaction') sends++;
              return fetcher(...args);
            });
            try {
              assert.equal((await onboarding.resumeOnboarding(config, access)).services[0]!.status, 'conflict');
              assert.equal(sends, 0); assert.ok((await readFile(file)).equals(retained));
            } finally { dispatch.mock.restore(); failed.mock.restore(); await handle.close(); }
          });
          await t.test('failed inner registry call never becomes a registered effect or a new action', async () => {
            const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
            try {
              const execution = JSON.parse(retained.toString()).services[0].registration.execution as adapter.PreparedSafeExecution;
              await control.setCode({ address: config.domain.knownImplementation.address, bytecode: '0x60006000fd' });
              const hash = await client.sendRawTransaction({ serializedTransaction: execution.rawTransaction });
              assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'reverted');
              await assert.rejects(adapter.readRegisteredAgentEffect(client, execution, { domain,
                registryRuntimeCodeHash: config.registryRuntimeCodeHash,
                call: { to: domain.registry, value: '0', operation: 0, data: '0x1aa3a008' } }), /inner/);
              assert.equal((await onboarding.resumeOnboarding(config, access)).services[0]!.status, 'conflict');
              assert.ok((await readFile(file)).equals(retained));
            } finally { await control.revert({ id: snapshot }); await writeFile(file, retained); }
          });
          await t.test('actual uint256 ID beyond codec range remains registered-unpublished without rounding or registration retry', async () => {
            const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
            try {
              const execution = JSON.parse(retained.toString()).services[0].registration.execution as adapter.PreparedSafeExecution;
              await control.setStorageAt({ address: domain.registry,
                index: '0xa040f782729de4970518741823ec1276cbcd41a0c7493f62d173341566a04e00', value: toHex(9007199254740992n, { size: 32 }) });
              await client.waitForTransactionReceipt({ hash: await client.sendRawTransaction({ serializedTransaction: execution.rawTransaction }) });
              const large = await onboarding.resumeOnboarding(config, access);
              assert.equal(large.services[0]!.status, 'registered-unpublished');
              assert.equal(large.services[0]!.agentId, '9007199254740992');
              const next = await onboarding.prepareNextAction(config, access);
              assert.equal(next.action, undefined); assert.equal(next.report.services[0]!.agentId, '9007199254740992');
              assert.equal(await client.readContract({ address: domain.registry, abi: tokenAbi, functionName: 'ownerOf',
                args: [9007199254740992n] }), deployment.predictedAddress);
            } finally { await control.revert({ id: snapshot }); await writeFile(file, retained); }
          });
          await t.test('lost request can only resubmit the identical durable bytes from a fresh keyless caller', async () => {
            const snapshot = await control.snapshot(); const file = join(root, 'journal.json'); const retained = await readFile(file);
            try {
              const original = JSON.parse(retained.toString()).services[0].registration.execution as adapter.PreparedSafeExecution;
              assert.equal((await childOperation('resume', undefined, 'drop-request')).report.services[0]!.status, 'unknown');
              const resumed = (await childOperation('resume')).report;
              assert.equal(resumed.services[0]!.agentId, '0');
              assert.equal(resumed.services[0]!.registration!.transactionHash, original.transactionHash);
              const recovered = JSON.parse((await readFile(file)).toString()).services[0].registration.execution as adapter.PreparedSafeExecution;
              assert.ok(recovered.rawTransaction === original.rawTransaction, 'recovery must retain identical executable bytes');
            } finally { await control.revert({ id: snapshot }); await writeFile(file, retained); }
          });
        }
        // Interpose only the transport reply: the real owned Anvil accepts/mines
        // the exact persisted raw bytes, then the response is lost.
        const fetcher = globalThis.fetch; let dropped = 0; let lostHash: string | undefined;
        const loss = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
          const body = args[1]?.body;
          const request = typeof body === 'string' ? JSON.parse(body) : undefined;
          if (request?.method === 'eth_getTransactionReceipt' && request.params[0] === lostHash) {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
          }
          const response = await fetcher(...args);
          if (request?.method === 'eth_sendRawTransaction') {
            dropped++; lostHash = keccak256(request.params[0]); await response.body?.cancel(); throw new Error('synthetic reply loss');
          }
          return response;
        });
        let result;
        if (approvals === 4) beforeFinalPublication = await control.snapshot();
        try { result = await onboarding.resumeOnboarding(config, access); } finally { loss.mock.restore(); }
        assert.equal(dropped, 1);
        assert.equal(result.services[approvals <= 2 ? 0 : 1]!.status, 'unknown');
        result = await restart();
        if (kind === 'publish' && result.services[1]!.agentId === undefined) {
          assert.equal(result.services[0]!.status, 'verified');
          assert.equal(result.services[1]!.status, 'approval-required');
          const partial = await restart(); assert.equal(partial.services[0]!.status, 'verified');
        }
      }
      const result = await onboarding.resumeOnboarding(config, access);
      assert.deepEqual(result.services.map((service) => service.status), ['verified', 'verified']);
      assert.deepEqual(result.services.map((service) => service.agentId), ['0', '1']);
      assert.equal(approvals, 4);
      for (const id of [0n, 1n]) assert.equal(await client.readContract({ address: domain.registry,
        abi: tokenAbi, functionName: 'ownerOf', args: [id] }), deployment.predictedAddress);
      await assert.rejects(client.readContract({ address: domain.registry, abi: tokenAbi, functionName: 'ownerOf', args: [2n] }));
      const serialized = JSON.stringify(result);
      assert.ok(!/rawTransaction|ownerSignature|executionCalldata|journalDirectory/.test(serialized));
      const hashes = [result.deployment!.transactionHash, ...result.services.flatMap((service) =>
        [service.registration!.transactionHash, service.publication!.transactionHash])];
      const gas = await Promise.all(hashes.map(async (hash) => (await client.getTransactionReceipt({ hash })).gasUsed));
      t.diagnostic(`local generated-account normal path: ${hashes.length} transactions; gas ${gas.join(',')}; total ${gas.reduce((a, b) => a + b, 0n)}`);
      t.diagnostic(`fresh owned callers: ${childCount} (checkpoint reopen plus preparation/approval races)`);
      await t.test('rollback of one completed intent cannot prepare a new registration at the next Safe nonce', async () => {
        const file = join(root, 'journal.json'); const retained = await readFile(file);
        try {
          const changed = JSON.parse(retained.toString());
          changed.services[1].registration = null; changed.services[1].publication = null; changed.services[1].profile = null;
          await writeFile(file, JSON.stringify(changed));
          const next = await onboarding.prepareNextAction(config, access);
          assert.equal(next.report.services[1]!.status, 'conflict'); assert.equal(next.action, undefined);
        } finally { await writeFile(file, retained); }
      });
      await t.test('altered event and card fields cannot surface private bytes through a conflict report', async () => {
        const file = join(root, 'journal.json'); const retained = await readFile(file);
        try {
          for (const field of ['agentURI', 'safeTxHash', 'cardBase64'] as const) {
            const changed = JSON.parse(retained.toString());
            if (field === 'cardBase64') changed.services[0].profile.cardBase64 = 'private-capability-marker';
            else changed.services[0].registration.effect[field] = 'private-capability-marker';
            await writeFile(file, JSON.stringify(changed));
            const report = await onboarding.resumeOnboarding(config, access);
            assert.equal(report.services[0]!.status, 'conflict');
            assert.equal(JSON.stringify(report).includes('private-capability-marker'), false);
          }
        } finally { await writeFile(file, retained); }
      });
      await t.test('unavailable live account evidence remains unknown', async () => {
        const fetcher = globalThis.fetch;
        const unavailable = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
          const body = args[1]?.body;
          if (typeof body === 'string') {
            const request = JSON.parse(body);
            if (request.method === 'eth_getCode') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
              error: { code: -32000, message: 'synthetic unavailable evidence' } }));
          }
          return fetcher(...args);
        });
        try { assert.equal((await onboarding.inspectOnboarding(config, access)).services[0]!.status, 'unknown'); }
        finally { unavailable.mock.restore(); }
      });
      await t.test('missing/orphaned receipt is unknown and stored verified flags never replace live evidence', async () => {
        const fetcher = globalThis.fetch;
        const unavailable = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
          const body = args[1]?.body;
          if (typeof body === 'string') {
            const request = JSON.parse(body);
            if (request.method === 'eth_getTransactionReceipt' && request.params[0] === hashes[4]) {
              return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
            }
          }
          return fetcher(...args);
        });
        try { assert.equal((await onboarding.resumeOnboarding(config, access)).services[1]!.status, 'unknown'); }
        finally { unavailable.mock.restore(); }
      });
      await t.test('changed token URI, runtime approval and Safe configuration block current verification', async () => {
        const snapshot = await control.snapshot();
        const execute = async (data: `0x${string}`) => adapter.executePrepared(await adapter.prepareExecution(
          await adapter.approveSingleCall(await adapter.prepareSingleCall(network, deployment.predictedAddress,
            { to: domain.registry, value: '0', data, operation: 0 }), kit), wallet));
        try {
          await execute(encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']),
            functionName: 'approve', args: [runtime.address, 0n] }));
          assert.equal((await onboarding.inspectOnboarding(config, access)).services[0]!.status, 'conflict');
        } finally { await control.revert({ id: snapshot }); }
        const second = await control.snapshot();
        try {
          await execute(encodeFunctionData({ abi: parseAbi(['function setAgentURI(uint256,string)']),
            functionName: 'setAgentURI', args: [0n, 'data:application/json;base64,e30='] }));
          assert.equal((await onboarding.inspectOnboarding(config, access)).services[0]!.status, 'conflict');
        } finally { await control.revert({ id: second }); }
        const third = await control.snapshot();
        try {
          await control.setStorageAt({ address: deployment.predictedAddress, index: toHex(4n, { size: 32 }), value: toHex(2n, { size: 32 }) });
          assert.equal((await onboarding.inspectOnboarding(config, access)).services[0]!.status, 'conflict');
        } finally { await control.revert({ id: third }); }
        const invalid = { ...config, services: [{ ...config.services[0], runtime: owners[0]!.address }, config.services[1]] as const };
        assert.equal((await onboarding.prepareOnboarding(invalid, access)).services[0]!.status, 'conflict');
      });
      await t.test('orphaned publication remains unknown and does not rebroadcast or allocate another ID', async () => {
        assert.ok(beforeFinalPublication);
        const retained = await readFile(join(root, 'journal.json'));
        await control.revert({ id: beforeFinalPublication });
        const before = await client.getBlockNumber({ cacheTime: 0 });
        assert.equal((await onboarding.resumeOnboarding(config, access)).services[1]!.status, 'unknown');
        assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
        assert.ok((await readFile(join(root, 'journal.json'))).equals(retained));
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_800_000_007n } });
});
