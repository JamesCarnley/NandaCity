import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData,
  http, numberToHex, pad, parseAbi, parseAbiParameters, parseEther,
  type Abi, type PublicClient, type RpcLog } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistryWithDomain, published, receipt } from '../../src/demo/registryFixture.js';
import { readIdentityFeedbackEpoch } from '../../src/identity/continuity.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { boundRpcFetch } from '../../src/identity/rpcTransport.js';
import { verifyProfile } from '../../src/identity/verify.js';
import { createRankingReadBudget } from '../../src/reputation/readBudget.js';

const abi = parseAbi([
  'function register() returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function approve(address to, uint256 tokenId)',
  'function upgradeToAndCall(address implementation, bytes data) payable',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);
const stringParameters = parseAbiParameters('string');
const tokenUriSelector = encodeFunctionData({ abi, functionName: 'tokenURI', args: [0n] }).slice(0, 10);

test('reference registry feedback authority epoch projects complete declaration histories',
  { timeout: 90_000 }, async (t) => {
    await withOwnedAnvil(async (rpcUrl) => {
      const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
      const client = createPublicClient({ transport, pollingInterval: 25 });
      const control = createTestClient({ mode: 'anvil', transport });
      const owner = privateKeyToAccount(generatePrivateKey());
      const runtime = privateKeyToAccount(generatePrivateKey());
      await control.setBalance({ address: owner.address, value: parseEther('100') });
      const wallet = createWalletClient({ account: owner, transport });
      const domain = await deployRegistryWithDomain(client, wallet);
      const agent = { chainId: domain.chainId, registry: domain.registry, agentId: '0' };
      const write = async (functionName: string, args: readonly unknown[] = []) => receipt(client,
        await wallet.writeContract({ address: domain.registry, abi: abi as Abi, functionName, args, chain: null }));
      await write('register');
      const record = published({ agentId: '0', owner, city: 'Chicago',
        cardUrl: 'http://127.0.0.1:39001/card', invocationUrl: 'http://127.0.0.1:39001/a2a',
        revision: 1, cardBytes: new Uint8Array(), agentURI: '' }, domain.chainId, domain.registry, true, runtime.address);
      const publication = await write('setAgentURI', [0n, record.agentURI]);
      const basisSnapshot = await readIdentitySnapshot(client, agent, publication.blockNumber);
      assert.equal(basisSnapshot.agentURI, record.agentURI);
      const coordinate = { blockNumber: publication.blockNumber, blockHash: publication.blockHash };
      const isolated = async (run: () => Promise<void>) => {
        const snapshot = await control.snapshot();
        try { await run(); } finally { await control.revert({ id: snapshot }); }
      };
      const profile = (revision: number, signer = runtime.address, active = true, publisher = owner) => published({
        agentId: '0', owner: publisher, city: 'Chicago', cardUrl: `http://127.0.0.1:${39000 + revision}/card`,
        invocationUrl: `http://127.0.0.1:${39000 + revision}/a2a`, revision,
        cardBytes: new Uint8Array(), agentURI: '',
      }, domain.chainId, domain.registry, active, signer);
      const readThrough = async (blockNumber: bigint, blockHash: `0x${string}`) => readIdentityFeedbackEpoch(client, {
        domain, agent, basis: coordinate, observation: { blockNumber, blockHash }, limits: { maxBlocks: 128, maxLogs: 64 },
      });
      const readWith = async (rpc: PublicClient, blockNumber: bigint, blockHash: `0x${string}`) =>
        readIdentityFeedbackEpoch(rpc, { domain, agent, basis: coordinate,
          observation: { blockNumber, blockHash }, limits: { maxBlocks: 128, maxLogs: 64 } });

      await t.test('basis equal to observation has the same epoch without fetching a card', async () => {
        const result = await readIdentityFeedbackEpoch(client, { domain, agent,
          basis: coordinate, observation: coordinate, limits: { maxBlocks: 128, maxLogs: 64 } });
        assert.deepEqual(result, {
          epoch: 'same', qualification: 'rpc-derived-not-state-proof',
          ownerEpoch: 'uninterrupted', deauthorization: 'absent',
          basis: { blockNumber: publication.blockNumber.toString(), blockHash: publication.blockHash },
          observation: { blockNumber: publication.blockNumber.toString(), blockHash: publication.blockHash },
          diagnostics: [],
        });
      });

      await t.test('basis boundary preserves a leading BOM and rejects it before declaration decoding', async () => {
        await isolated(async () => {
          await write('register');
          const secondAgent = { ...agent, agentId: '1' };
          const second = published({ agentId: '1', owner, city: 'Chicago',
            cardUrl: 'http://127.0.0.1:39101/card', invocationUrl: 'http://127.0.0.1:39101/a2a',
            revision: 1, cardBytes: new Uint8Array(), agentURI: '' }, domain.chainId, domain.registry, true, runtime.address);
          const publication = await write('setAgentURI', [1n, `\uFEFF${second.agentURI}`]);
          const point = { blockNumber: publication.blockNumber, blockHash: publication.blockHash };
          const result = await readIdentityFeedbackEpoch(client, { domain, agent: secondAgent,
            basis: point, observation: point, limits: { maxBlocks: 128, maxLogs: 64 } });
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /boundary tokenURI|registration/);
        });
      });

      await t.test('current boundary raw bytes cannot be normalized by decoded event or contract strings', async () => {
        await isolated(async () => {
          const changed = profile(2);
          const update = await write('setAgentURI', [0n, `\uFEFF${changed.agentURI}`]);
          let normalizedEvent = false;
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string; params?: readonly unknown[] }) => {
              const response: unknown = await client.request(args as never);
              if (args.method !== 'eth_getLogs' || normalizedEvent || !Array.isArray(response) || !response.length) return response;
              normalizedEvent = true;
              const logs = response as RpcLog[];
              return [{ ...logs[0]!, data: encodeAbiParameters(stringParameters, [changed.agentURI]) }, ...logs.slice(1)];
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /boundary tokenURI|registration/);
        });

        await isolated(async () => {
          const changed = profile(2);
          const update = await write('setAgentURI', [0n, changed.agentURI]);
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string; params?: readonly unknown[] }) => {
              const response = await client.request(args as never);
              const call = args.params?.[0] as { data?: string } | undefined;
              if (args.method === 'eth_call' && call?.data?.slice(0, 10) === tokenUriSelector &&
                  args.params?.[1] === numberToHex(update.blockNumber) && typeof response === 'string') {
                return `${response}${'00'.repeat(32)}`;
              }
              return response;
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /boundary tokenURI.*ABI|canonical/i);
        });
      });

      await t.test('complete empty interval is same', async () => {
        await isolated(async () => {
          await control.mine({ blocks: 2 });
          const head = await client.getBlock({ blockTag: 'latest' });
          const result = await readThrough(head.number, head.hash);
          assert.equal(result.epoch, 'same');
          assert.deepEqual(result.diagnostics, []);
        });
      });

      await t.test('endpoint and card-only publication preserves epoch but not the old current binding', async () => {
        await isolated(async () => {
          const changed = profile(2);
          const update = await write('setAgentURI', [0n, changed.agentURI]);
          const result = await readThrough(update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'same');
          assert.deepEqual(result.diagnostics, []);
          const current = await readIdentitySnapshot(client, agent, update.blockNumber);
          assert.throws(() => verifyProfile({ agent, agentURI: record.agentURI, cardBytes: record.cardBytes }, current), /agentURI/);
          assert.doesNotThrow(() => verifyProfile({ agent, agentURI: changed.agentURI, cardBytes: changed.cardBytes }, current));
        });
      });

      await t.test('runtime replacement remains retired after restoration across blocks', async () => {
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const away = await write('setAgentURI', [0n, profile(2, replacement.address).agentURI]);
          const back = await write('setAgentURI', [0n, profile(3).agentURI]);
          const result = await readThrough(back.blockNumber, back.blockHash);
          assert.equal(result.epoch, 'retired');
          assert.equal(result.ownerEpoch, 'uninterrupted');
          assert.equal(result.deauthorization, 'absent');
          assert.deepEqual(result.firstRuntimeRetirement, { blockNumber: away.blockNumber.toString(),
            blockHash: away.blockHash, transactionIndex: away.transactionIndex, logIndex: 1 });
          assert.deepEqual(result.firstBreak, { blockNumber: away.blockNumber.toString(),
            transactionIndex: away.transactionIndex, logIndex: 1, kind: 'runtime-replaced' });
        });
      });

      await t.test('runtime replacement and restoration in one block remains retired', async () => {
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const nonce = await client.getTransactionCount({ address: owner.address });
          await control.setAutomine(false);
          try {
            const awayHash = await wallet.writeContract({ address: domain.registry, abi: abi as Abi,
              functionName: 'setAgentURI', args: [0n, profile(2, replacement.address).agentURI], nonce, chain: null });
            const backHash = await wallet.writeContract({ address: domain.registry, abi: abi as Abi,
              functionName: 'setAgentURI', args: [0n, profile(3).agentURI], nonce: nonce + 1, chain: null });
            await control.mine({ blocks: 1 });
            const away = await receipt(client, awayHash);
            const back = await receipt(client, backHash);
            assert.equal(away.blockNumber, back.blockNumber);
            const result = await readThrough(back.blockNumber, back.blockHash);
            assert.equal(result.epoch, 'retired');
            assert.equal(result.firstBreak?.kind, 'runtime-replaced');
            assert.equal(result.firstBreak?.blockNumber, away.blockNumber.toString());
          } finally { await control.setAutomine(true); }
        });
      });

      await t.test('transfer away and back plus self-transfer permanently retire their intervals', async () => {
        for (const scenario of ['away-back', 'self'] as const) await isolated(async () => {
          const other = privateKeyToAccount(generatePrivateKey());
          await control.setBalance({ address: other.address, value: parseEther('100') });
          const otherWallet = createWalletClient({ account: other, transport });
          let first;
          if (scenario === 'away-back') {
            first = await write('transferFrom', [owner.address, other.address, 0n]);
            await receipt(client, await otherWallet.writeContract({ address: domain.registry, abi: abi as Abi,
              functionName: 'transferFrom', args: [other.address, owner.address, 0n], chain: null }));
          } else first = await write('transferFrom', [owner.address, owner.address, 0n]);
          const head = await client.getBlock({ blockTag: 'latest' });
          const result = await readThrough(head.number, head.hash);
          assert.equal(result.epoch, 'retired', scenario);
          assert.equal(result.ownerEpoch, 'transferred');
          assert.deepEqual(result.firstBreak, { blockNumber: first.blockNumber.toString(),
            transactionIndex: first.transactionIndex, logIndex: 1, kind: 'transfer' });
        });
      });

      await t.test('active false remains retired after active restoration', async () => {
        await isolated(async () => {
          const off = await write('setAgentURI', [0n, profile(2, runtime.address, false).agentURI]);
          const on = await write('setAgentURI', [0n, profile(3).agentURI]);
          const result = await readThrough(on.blockNumber, on.blockHash);
          assert.equal(result.epoch, 'retired');
          assert.deepEqual(result.firstBreak, { blockNumber: off.blockNumber.toString(),
            transactionIndex: off.transactionIndex, logIndex: 1, kind: 'deauthorized' });
          assert.equal(result.deauthorization, 'observed');
        });
      });

      await t.test('whole interval retains transfers and deauthorization after the first runtime break', async () => {
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const away = await write('setAgentURI', [0n, profile(2, replacement.address).agentURI]);
          await write('transferFrom', [owner.address, owner.address, 0n]);
          await write('setAgentURI', [0n, profile(3, replacement.address, false).agentURI]);
          const back = await write('setAgentURI', [0n, profile(4).agentURI]);
          const result = await readThrough(back.blockNumber, back.blockHash);
          assert.equal(result.firstBreak?.kind, 'runtime-replaced');
          assert.equal(result.firstRuntimeRetirement?.blockHash, away.blockHash);
          assert.equal(result.ownerEpoch, 'transferred');
          assert.equal(result.deauthorization, 'observed');
        });
      });

      await t.test('an approved operator may publish a neutral endpoint update', async () => {
        await isolated(async () => {
          const operator = privateKeyToAccount(generatePrivateKey());
          await control.setBalance({ address: operator.address, value: parseEther('100') });
          await write('approve', [operator.address, 0n]);
          const operatorWallet = createWalletClient({ account: operator, transport });
          const changed = profile(2);
          const update = await receipt(client, await operatorWallet.writeContract({ address: domain.registry,
            abi: abi as Abi, functionName: 'setAgentURI', args: [0n, changed.agentURI], chain: null }));
          const result = await readThrough(update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'same');
          assert.deepEqual(result.diagnostics, []);
        });
      });

      await t.test('stale-owner intermediate declaration stays unknown after a valid final declaration', async () => {
        await isolated(async () => {
          const other = privateKeyToAccount(generatePrivateKey());
          await control.setBalance({ address: other.address, value: parseEther('100') });
          const otherWallet = createWalletClient({ account: other, transport });
          const transfer = await write('transferFrom', [owner.address, other.address, 0n]);
          await receipt(client, await otherWallet.writeContract({ address: domain.registry, abi: abi as Abi,
            functionName: 'setAgentURI', args: [0n, profile(2).agentURI], chain: null }));
          const final = await receipt(client, await otherWallet.writeContract({ address: domain.registry, abi: abi as Abi,
            functionName: 'setAgentURI', args: [0n, profile(3, runtime.address, true, other).agentURI], chain: null }));
          const result = await readThrough(final.blockNumber, final.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /ownerAtPublication/);
          assert.deepEqual(result.firstBreak, { blockNumber: transfer.blockNumber.toString(),
            transactionIndex: transfer.transactionIndex, logIndex: 1, kind: 'transfer' });
        });
      });

      await t.test('malformed intermediate declaration stays unknown after a valid final declaration', async () => {
        await isolated(async () => {
          await write('setAgentURI', [0n, 'data:application/json;base64,!!!!']);
          const final = await write('setAgentURI', [0n, profile(2).agentURI]);
          const result = await readThrough(final.blockNumber, final.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /registration|base64/);
          assert.equal(result.firstBreak, undefined);
        });
      });

      await t.test('upgrade away and back is unknown even when the final runtime matches', async () => {
        await isolated(async () => {
          const second = await deployRegistryWithDomain(client, wallet);
          await write('upgradeToAndCall', [second.knownImplementation.address, '0x']);
          const back = await write('upgradeToAndCall', [domain.knownImplementation.address, '0x']);
          const result = await readThrough(back.blockNumber, back.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.deepEqual(result.diagnostics, ['identity implementation upgrade observed']);
        });
      });

      await t.test('event-count exhaustion is unknown, never a partial retirement finding', async () => {
        await isolated(async () => {
          await write('setAgentURI', [0n, profile(2).agentURI]);
          const final = await write('setAgentURI', [0n, profile(3).agentURI]);
          const result = await readIdentityFeedbackEpoch(client, { domain, agent, basis: coordinate,
            observation: { blockNumber: final.blockNumber, blockHash: final.blockHash },
            limits: { maxBlocks: 128, maxLogs: 1 } });
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /log limit/);
        });
      });

      await t.test('opaque UTF-8, BOM, ABI suffix and raw-size failures are unknown', async () => {
        for (const damage of ['invalid-utf8', 'bom', 'suffix', 'oversize'] as const) await isolated(async () => {
          const changed = profile(2);
          const update = await write('setAgentURI', [0n, damage === 'bom' ? `\uFEFF${changed.agentURI}` : changed.agentURI]);
          let damaged = false;
          const rpc = damage === 'bom' ? client : new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string }) => {
              const logs = await client.request(args as never) as RpcLog[];
              if (args.method !== 'eth_getLogs' || damaged || !logs.length) return logs;
              damaged = true;
              const first = logs[0]!;
              const word = (value: bigint) => value.toString(16).padStart(64, '0');
              const invalid = `0x${word(32n)}${word(1n)}ff${'00'.repeat(31)}` as `0x${string}`;
              const suffix = `${first.data}${'00'.repeat(32)}` as `0x${string}`;
              const oversize = `${first.data}${'00'.repeat(65_537 - (first.data.length - 2) / 2)}` as `0x${string}`;
              return [{ ...first, data: damage === 'invalid-utf8' ? invalid : damage === 'suffix' ? suffix : oversize }, ...logs.slice(1)];
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'unknown', damage);
          assert.match(result.diagnostics[0]!, /UTF-8|registration|ABI|64 KiB/i, damage);
        });
      });

      await t.test('omitted and missing log chunks stay unknown', async () => {
        for (const damage of ['omitted', 'missing'] as const) await isolated(async () => {
          const update = await write('setAgentURI', [0n, profile(2).agentURI]);
          let requests = 0;
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string }) => {
              if (args.method !== 'eth_getLogs') return client.request(args as never);
              requests += 1;
              if (damage === 'missing' && requests === 2) throw new Error('controlled missing chunk');
              const logs = await client.request(args as never) as RpcLog[];
              return damage === 'omitted' && logs.length ? [] : logs;
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, update.blockNumber, update.blockHash);
          assert.equal(result.epoch, 'unknown', damage);
          assert.match(result.diagnostics[0]!, damage === 'missing' ? /missing chunk/ : /final state/, damage);
        });
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const changed = await write('setAgentURI', [0n, profile(2, replacement.address).agentURI]);
          await control.mine({ blocks: 65 });
          const head = await client.getBlock({ blockTag: 'latest' });
          let requests = 0;
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string }) => {
              if (args.method === 'eth_getLogs' && ++requests === 4) throw new Error('controlled later missing chunk');
              return client.request(args as never);
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, head.number, head.hash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /later missing chunk/);
          assert.deepEqual(result.firstBreak, { blockNumber: changed.blockNumber.toString(),
            transactionIndex: changed.transactionIndex, logIndex: 1, kind: 'runtime-replaced' });
        });
      });

      await t.test('unsupported implementation and event or boundary reorg stay unknown', async () => {
        await isolated(async () => {
          const other = privateKeyToAccount(generatePrivateKey());
          await control.mine({ blocks: 1 });
          const head = await client.getBlock({ blockTag: 'latest' });
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'getStorageAt') return async (args: Parameters<typeof client.getStorageAt>[0]) =>
              args.blockNumber === head.number ? pad(other.address) : client.getStorageAt(args);
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, head.number, head.hash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /unsupported identity implementation at observation/);
        });
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const changed = await write('setAgentURI', [0n, profile(2, replacement.address).agentURI]);
          const other = privateKeyToAccount(generatePrivateKey());
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'getStorageAt') return async (args: Parameters<typeof client.getStorageAt>[0]) =>
              args.blockNumber === changed.blockNumber ? pad(other.address) : client.getStorageAt(args);
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, changed.blockNumber, changed.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /unsupported identity implementation at observation/);
          assert.deepEqual(result.firstBreak, { blockNumber: changed.blockNumber.toString(),
            transactionIndex: changed.transactionIndex, logIndex: 1, kind: 'runtime-replaced' });
        });
        await isolated(async () => {
          const replacement = privateKeyToAccount(generatePrivateKey());
          const changed = await write('setAgentURI', [0n, profile(2, replacement.address).agentURI]);
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'request') return async (args: { method: string; params?: readonly unknown[] }) => {
              if (args.method === 'eth_call' && args.params?.[1] === numberToHex(changed.blockNumber)) {
                throw new Error('controlled current snapshot unavailable');
              }
              return client.request(args as never);
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, changed.blockNumber, changed.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, /controlled current snapshot unavailable/);
          assert.deepEqual(result.firstBreak, { blockNumber: changed.blockNumber.toString(),
            transactionIndex: changed.transactionIndex, logIndex: 1, kind: 'runtime-replaced' });
        });
        for (const targetBlock of ['event', 'boundary'] as const) await isolated(async () => {
          const update = await write('setAgentURI', [0n, profile(2).agentURI]);
          await control.mine({ blocks: 1 });
          const head = await client.getBlock({ blockTag: 'latest' });
          const watched = targetBlock === 'event' ? update.blockNumber : coordinate.blockNumber;
          let reads = 0;
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'getBlock') return async (args: Parameters<typeof client.getBlock>[0]) => {
              const block = await client.getBlock(args);
              if (args?.blockNumber === watched && ++reads === (targetBlock === 'event' ? 2 : 4)) {
                return { ...block, hash: `0x${'ab'.repeat(32)}` };
              }
              return block;
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, head.number, head.hash);
          assert.equal(result.epoch, 'unknown', targetBlock);
          assert.match(result.diagnostics[0]!, /reorganization/, targetBlock);
        });
      });

      await t.test('boundary snapshot may not follow an RPC-selected wrong numbered state basis', async () => {
        await isolated(async () => {
          const update = await write('setAgentURI', [0n, profile(2).agentURI]);
          await control.mine({ blocks: 1 });
          const head = await client.getBlock({ blockTag: 'latest' });
          assert.equal(head.number, update.blockNumber + 1n);
          let observationReads = 0;
          let forgePriorOnce = false;
          const redirectedStateReads: Array<{ kind: string; blockNumber: string }> = [];
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'getBlock') return async (args: Parameters<typeof client.getBlock>[0]) => {
              const block = await client.getBlock(args);
              if (args?.blockNumber === head.number && ++observationReads === 2) {
                forgePriorOnce = true;
                return { ...block, number: update.blockNumber, hash: head.hash };
              }
              if (args?.blockNumber === update.blockNumber && forgePriorOnce) {
                forgePriorOnce = false;
                return { ...block, hash: head.hash };
              }
              return block;
            };
            if (key === 'readContract') return async (args: Parameters<typeof client.readContract>[0]) => {
              redirectedStateReads.push({ kind: String(args.functionName), blockNumber: String(args.blockNumber) });
              return client.readContract(args as never);
            };
            if (key === 'request') return async (args: { method: string; params?: readonly unknown[] }) => {
              if (args.method === 'eth_call') redirectedStateReads.push({ kind: 'eth_call', blockNumber: String(args.params?.[1]) });
              return client.request(args as never);
            };
            return Reflect.get(target, key);
          } });
          const result = await readWith(rpc, head.number, head.hash);
          assert.equal(result.epoch, 'unknown');
          assert.deepEqual(result.diagnostics, ['feedback epoch boundary snapshot mismatch']);
          assert.deepEqual(redirectedStateReads.filter((read) => read.blockNumber === update.blockNumber.toString() ||
            read.blockNumber === numberToHex(update.blockNumber)), [], 'wrong header must not redirect state reads');
        });
      });

      await t.test('cancellation or deadline return cannot start later snapshot RPC work', async () => {
        for (const mode of ['cancel', 'deadline'] as const) await isolated(async () => {
          const canonical = await client.getBlock({ blockNumber: coordinate.blockNumber });
          let release!: () => void;
          const held = new Promise<typeof canonical>((resolve) => { release = () => resolve(canonical); });
          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => { markStarted = resolve; });
          let basisReads = 0;
          let returned = false;
          const postReturn: string[] = [];
          const track = (label: string) => { if (returned) postReturn.push(label); };
          const rpc = new Proxy(client, { get(target, key) {
            if (key === 'getChainId') return async () => { track('getChainId'); return client.getChainId(); };
            if (key === 'getBlock') return async (args: Parameters<typeof client.getBlock>[0]) => {
              track(`getBlock:${String(args?.blockNumber)}`);
              if (args?.blockNumber === coordinate.blockNumber && ++basisReads === 2) {
                markStarted();
                return held;
              }
              return client.getBlock(args);
            };
            if (key === 'getStorageAt') return async (args: Parameters<typeof client.getStorageAt>[0]) => {
              track('getStorageAt'); return client.getStorageAt(args);
            };
            if (key === 'getCode') return async (args: Parameters<typeof client.getCode>[0]) => {
              track('getCode'); return client.getCode(args);
            };
            if (key === 'readContract') return async (args: Parameters<typeof client.readContract>[0]) => {
              track(`readContract:${String(args.functionName)}`); return client.readContract(args as never);
            };
            if (key === 'request') return async (args: { method: string }) => {
              track(`request:${args.method}`); return client.request(args as never);
            };
            return Reflect.get(target, key);
          } });
          const controller = new AbortController();
          const pending = readIdentityFeedbackEpoch(rpc, { domain, agent, basis: coordinate, observation: coordinate,
            limits: { maxBlocks: 128, maxLogs: 64 }, ...(mode === 'cancel' ? { signal: controller.signal } : {}) });
          await started;
          if (mode === 'cancel') controller.abort();
          const result = await pending;
          returned = true;
          assert.equal(result.epoch, 'unknown');
          assert.match(result.diagnostics[0]!, mode === 'cancel' ? /cancel|abort/i : /deadline/i);
          release();
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.deepEqual(postReturn, [], `${mode} returned before internal work stopped`);
        });
      });

      await t.test('two consumers borrow one shared ledger without resetting prior allowance', async () => {
        const budget = createRankingReadBudget({ origins: ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'] });
        try {
          budget.chargeBundle(17);
          const prior = await budget.requestBudget('shared', 'rpc').open();
          prior.check(); prior.close();
          const boundedClient = createPublicClient({ cacheTime: 0, batch: { multicall: false },
            transport: http(rpcUrl, { retryCount: 0, batch: false, timeout: 5_000,
              fetchFn: boundRpcFetch(fetch, { budget: budget.requestBudget('shared', 'rpc') }) }) });
          const first = await readWith(boundedClient, coordinate.blockNumber, coordinate.blockHash);
          const second = await readWith(boundedClient, coordinate.blockNumber, coordinate.blockHash);
          assert.deepEqual(first, second);
          assert.equal(first.epoch, 'same');
          const spent = budget.snapshot();
          assert.equal(spent.bundleBytes, 17);
          assert.ok(spent.lanes.shared.calls > 1, 'reader must spend the already-borrowed shared lane');
          assert.ok(spent.lanes.shared.rpcBytes > 17);
          assert.equal(spent.inFlight, 0);
        } finally { await budget.dispose(); }
      });

      await t.test('shared RPC byte exhaustion is unknown and remains visible on the borrowed ledger', async () => {
        const budget = createRankingReadBudget({ origins: ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'] });
        try {
          budget.chargeBundle(8 * 1024 * 1024);
          const boundedClient = createPublicClient({ cacheTime: 0, batch: { multicall: false },
            transport: http(rpcUrl, { retryCount: 0, batch: false, timeout: 5_000,
              fetchFn: boundRpcFetch(fetch, { budget: budget.requestBudget('shared', 'rpc') }) }) });
          const result = await readWith(boundedClient, coordinate.blockNumber, coordinate.blockHash);
          assert.equal(result.epoch, 'unknown');
          assert.ok(budget.snapshot().diagnostics.includes('shared:rpc:byte-budget'));
          assert.equal(budget.snapshot().inFlight, 0);
        } finally { await budget.dispose(); }
      });
    }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
  });
