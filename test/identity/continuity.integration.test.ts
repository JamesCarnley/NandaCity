import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi,
  parseEther, pad, type Abi, type Address, type PublicClient, type RpcLog } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import * as deployments from '../../src/demo/registryFixture.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';

const abi = parseAbi([
  'function register() returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)',
  'function approve(address to, uint256 tokenId)',
  'function upgradeToAndCall(address implementation, bytes data) payable',
]);

test('known reference continuity distinguishes unrelated blocks from no-op and away-back authority events',
  { timeout: 90_000 }, async (t) => {
    const module = await import('../../src/identity/continuity.js').catch(() => undefined);
    assert.ok(module, 'the bounded reference continuity reader must exist');
    await withOwnedAnvil(async (rpcUrl) => {
      const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
      const client = createPublicClient({ transport, pollingInterval: 25 });
      const control = createTestClient({ mode: 'anvil', transport });
      const owner = privateKeyToAccount(generatePrivateKey());
      const other = privateKeyToAccount(generatePrivateKey());
      for (const account of [owner, other]) await control.setBalance({ address: account.address, value: parseEther('100') });
      const wallet = createWalletClient({ account: owner, transport });
      const otherWallet = createWalletClient({ account: other, transport });
      const domain = await deployments.deployRegistryWithDomain(client, wallet);
      const agent = { chainId: domain.chainId, registry: domain.registry, agentId: '0' };
      const write = async (functionName: string, args: readonly unknown[] = []) =>
        deployments.receipt(client, await wallet.writeContract({ address: domain.registry,
          abi: abi as Abi, functionName, args, chain: null }));
      await write('register');
      await write('setAgentURI', [0n, 'data:,original']);
      await write('register');
      const basis = await readIdentitySnapshot(client, agent);
      const read = async (overrides: Record<string, unknown> = {}, rpc: PublicClient = client) =>
        module.readIdentityContinuity(rpc, { domain, agent, basis,
          current: await readIdentitySnapshot(client, agent), limits: { maxBlocks: 128, maxLogs: 64 }, ...overrides });

      await t.test('same block, unrelated mining, other subject, metadata and approval do not retire authority', async () => {
        assert.equal((await read()).status, 'unchanged');
        await control.mine({ blocks: 2 });
        await write('setAgentURI', [1n, 'data:,other']);
        await write('setMetadata', [0n, 'note', '0x1234']);
        await write('approve', [privateKeyToAccount(generatePrivateKey()).address, 0n]);
        assert.equal((await read()).status, 'unchanged');
        // A real publication on the linked Reputation contract is unrelated to runtime authority.
        const reputation = await deployments.deployReputationRegistry(client, wallet, domain.registry);
        await deployments.receipt(client, await otherWallet.writeContract({ address: reputation,
          abi: parseAbi(['function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)']),
          functionName: 'giveFeedback', args: [0n, -1n, 0, 'service', '', '', 'https://fixture.example/review', `0x${'12'.repeat(32)}`], chain: null }));
        assert.equal((await read()).status, 'unchanged');
      });
      for (const scenario of ['same-uri', 'self-transfer', 'transfer-away-back', 'implementation-away-back'] as const) {
        await t.test(scenario, async () => {
          const stable = await control.snapshot();
          if (scenario === 'same-uri') await write('setAgentURI', [0n, basis.agentURI]);
          if (scenario === 'self-transfer') await write('transferFrom', [owner.address, owner.address, 0n]);
          if (scenario === 'transfer-away-back') {
            await write('transferFrom', [owner.address, other.address, 0n]);
            await deployments.receipt(client, await otherWallet.writeContract({ address: domain.registry,
              abi, functionName: 'transferFrom', args: [other.address, owner.address, 0n], chain: null }));
          }
          if (scenario === 'implementation-away-back') {
            const second = await deployments.deployRegistryWithDomain(client, wallet);
            await write('upgradeToAndCall', [second.knownImplementation.address, '0x']);
            assert.equal((await read()).status, 'changed', 'canonical upgrade wins over unexpected current implementation');
            await write('upgradeToAndCall', [domain.knownImplementation.address, '0x']);
          }
          assert.equal((await read()).status, 'changed');
          await control.revert({ id: stable });
        });
      }
      await t.test('wrong genesis, subject, hash, bounds, or unknown implementation fail closed', async () => {
        for (const overrides of [
          { domain: { ...domain, genesisHash: `0x${'ab'.repeat(32)}` } },
          { agent: { ...agent, agentId: '2' } },
          { basis: { ...basis, blockHash: `0x${'ab'.repeat(32)}` } },
          { basis: { ...basis, blockNumber: '999999' } },
          { domain: { ...domain, knownImplementation: { ...domain.knownImplementation, address: other.address as Address } } },
          { domain: { ...domain, knownImplementation: { ...domain.knownImplementation, codeHash: `0x${'ab'.repeat(32)}` } } },
          { limits: { maxBlocks: 0, maxLogs: 1 } },
          { limits: { maxBlocks: 1, maxLogs: 64 } },
        ]) assert.equal((await read(overrides)).status, 'unknown');
      });
      await t.test('unexpected current implementation without an upgrade log is unknown', async () => {
        const stable = await control.snapshot();
        await control.setStorageAt({ address: domain.registry, index: module.IMPLEMENTATION_SLOT,
          value: pad(other.address) });
        await control.mine({ blocks: 1 });
        const previous = await readIdentitySnapshot(client, agent, BigInt(basis.blockNumber));
        const head = await client.getBlock({ blockTag: 'latest' });
        assert.equal((await module.readIdentityContinuity(client, { domain, agent, basis,
          current: { ...previous, blockNumber: head.number.toString(), blockHash: head.hash },
          limits: { maxBlocks: 128, maxLogs: 64 } })).status, 'unknown');
        await control.revert({ id: stable });
      });
      await t.test('malformed logs, missing chunk, overflow and changed numbered hashes fail closed', async () => {
        await control.mine({ blocks: 65 });
        await write('setAgentURI', [0n, basis.agentURI]);
        for (const damage of ['removed', 'address', 'hash', 'topic', 'coordinates', 'large-coordinate', 'missing', 'overflow', 'reorg'] as const) {
          let boundsReads = 0;
          let chunkReads = 0;
          const damaged = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string }) => {
              if (args.method !== 'eth_getLogs') return client.request(args as never);
              if (damage === 'missing' && ++chunkReads === 4) throw new Error('second chunk unavailable');
              const logs = await client.request(args as never) as RpcLog[];
              if (!logs.length) return logs;
              const first = logs[0]!;
              if (damage === 'overflow') return Array.from({ length: 65 }, () => first);
              return logs.map((log) => ({ ...log,
                ...(damage === 'removed' ? { removed: true } : {}),
                ...(damage === 'address' ? { address: other.address } : {}),
                ...(damage === 'hash' ? { blockHash: `0x${'ab'.repeat(32)}` } : {}),
                ...(damage === 'topic' ? { topics: ['0x00'] } : {}),
                ...(damage === 'coordinates' ? { logIndex: null } : {}),
                ...(damage === 'large-coordinate' ? { transactionIndex: '0xffffffffffffffffffff' } : {}),
              }));
            };
            if (key === 'getBlock' && damage === 'reorg') return async (args: Parameters<typeof client.getBlock>[0]) => {
              const block = await client.getBlock(args);
              if (args?.blockNumber === BigInt(basis.blockNumber) && ++boundsReads > 1) return { ...block, hash: `0x${'ab'.repeat(32)}` };
              return block;
            };
            return Reflect.get(target, key);
          } });
          assert.equal((await read({}, damaged)).status, 'unknown', damage);
        }
      });
    }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
  });
