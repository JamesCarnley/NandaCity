import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistryWithDomain, deployReputationRegistry, published, receipt, registryAbi } from '../../src/demo/registryFixture.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { verifyProfile } from '../../src/identity/verify.js';
import { startLoopbackA2AService, CITY_REQUEST_DATA_TYPE, type A2ATask } from '../../src/a2a/service.js';
import { signRequest } from '../../src/interaction/signatures.js';
import type { CityRequest } from '../../src/interaction/schema.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

test('request-scoped real-chain authority accepts a post-feedback caller basis and prevents completion after rotation',
  { timeout: 90_000 }, async () => {
    const module = await import('../../src/a2a/authority.js').catch(() => undefined);
    assert.ok(module, 'the request-scoped chain authority adapter must exist');
    await withOwnedAnvil(async (rpcUrl) => {
      const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
      const client = createPublicClient({ transport, pollingInterval: 25 });
      const control = createTestClient({ mode: 'anvil', transport });
      const owner = privateKeyToAccount(generatePrivateKey());
      const f = makeInteractionFixture();
      await control.setBalance({ address: owner.address, value: parseEther('100') });
      await control.setBalance({ address: f.caller.address, value: parseEther('100') });
      const wallet = createWalletClient({ account: owner, transport });
      const caller = createWalletClient({ account: f.caller, transport });
      const domain = await deployRegistryWithDomain(client, wallet);
      const agent = { chainId: domain.chainId, registry: domain.registry, agentId: '0' };
      await receipt(client, await wallet.writeContract({ address: domain.registry, abi: registryAbi,
        functionName: 'register', chain: null }));
      const record = published({ agentId: '0', owner, city: 'Chicago', revision: 1,
        cardUrl: 'http://127.0.0.1:8000/card.json', invocationUrl: 'http://127.0.0.1:8001/',
        cardBytes: new Uint8Array(), agentURI: '' }, domain.chainId, domain.registry, true, f.runtime.address);
      const publish = () => wallet.writeContract({ address: domain.registry, abi: registryAbi,
        functionName: 'setAgentURI', args: [0n, record.agentURI], chain: null }).then((hash) => receipt(client, hash));
      await publish();
      const startup = await readIdentitySnapshot(client, agent);
      const reputation = await deployReputationRegistry(client, wallet, domain.registry);
      await receipt(client, await caller.writeContract({ address: reputation,
        abi: parseAbi(['function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)']),
        functionName: 'giveFeedback', args: [0n, -1n, 0, 'service', '', '', 'https://fixture.example/review', `0x${'34'.repeat(32)}`], chain: null }));
      const basis = await readIdentitySnapshot(client, agent);
      assert.ok(BigInt(basis.blockNumber) > BigInt(startup.blockNumber));
      const profile = verifyProfile({ agent, agentURI: basis.agentURI, cardBytes: record.cardBytes }, basis);
      const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const { blockTimestamp: _timestamp, ...requestBasis } = profile.source;
      const request: CityRequest = { ...f.request, service: { method: 'erc8004' as const, agent },
        caller: { ...f.request.caller, chainId: domain.chainId }, createdAt: now(),
        deadline: new Date(Date.now() + 300_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        profileBasis: { ...f.request.profileBasis, ...requestBasis,
          agentOwner: profile.source.agentOwner.toLowerCase() as `0x${string}`,
          receiptSigner: f.runtime.address.toLowerCase() as `0x${string}` } };
      const observe = (value: typeof f.request) => module.observeRequestAuthority(client,
        { domain, agent, cardBytes: record.cardBytes, now }, value);
      assert.equal((await observe(request)).basisProfile?.source.blockNumber, basis.blockNumber);
      await control.mine({ blocks: 2 });
      assert.equal((await observe(request)).continuity, 'unchanged');
      await assert.rejects(observe({ ...request, profileBasis: { ...request.profileBasis,
        blockHash: `0x${'ab'.repeat(32)}` } }), /basis.*hash/i);
      let reads = 0;
      const noReads = new Proxy(client, { get() { reads++; throw new Error('must reject before RPC access'); } });
      await assert.rejects(module.observeRequestAuthority(noReads,
        { domain, agent, cardBytes: record.cardBytes, now },
        { ...request, service: { method: 'erc8004', agent: { ...agent, agentId: '2' } } }), /service/i);
      assert.equal(reads, 0);
      const directory = await mkdtemp(join(tmpdir(), 'city-authority-'));
      let rotate = false;
      const service = await startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime,
        observeAuthority: observe, now, execute: async () => {
          if (rotate) await publish();
          return new TextEncoder().encode('{"synthetic":true}');
        } });
      try {
        const call = async (method: string, params: unknown) => {
          const response = await fetch(service.url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          const body = await response.json() as { result?: A2ATask; error?: unknown };
          assert.ok(body.result, JSON.stringify(body.error));
          return body.result;
        };
        for (const change of [false, true]) {
          rotate = change;
          const envelope = await signRequest({ ...request,
            interactionId: `0x${(change ? '02' : '01').repeat(32)}` }, f.caller);
          let task = await call('message/send', { message: { kind: 'message', role: 'user', messageId: 'probe',
            parts: [{ kind: 'data', data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope } }] } });
          for (let count = 0; count < 100 && task.status.state === 'submitted'; count++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            task = await call('tasks/get', { id: task.id });
          }
          assert.equal(task.status.state, change ? 'failed' : 'completed');
          if (change) {
            assert.equal(task.artifacts, undefined);
            assert.equal((task.metadata?.['org.nandacity'] as Record<string, unknown>)['completion'], undefined);
          }
        }
      } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
    }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
  });
