import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, custom, encodeFunctionData,
  http, keccak256, parseAbi, parseEther, toEventSelector, type Address, type Hex,
  type PublicClient, type TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { compileReferenceContracts } from '../../src/demo/contracts.js';
import * as deployment from '../../src/demo/registryFixture.js';
import { IMPLEMENTATION_SLOT } from '../../src/identity/continuity.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';

const adminAbi = parseAbi(['function initialize(address identityRegistry)',
  'function upgradeToAndCall(address implementation, bytes data) payable']);
const upgraded = toEventSelector('Upgraded(address)');
const initialized = toEventSelector('Initialized(uint64)');
const otherHash = `0x${'ab'.repeat(32)}` as Hex;
const otherAddress = '0x1111111111111111111111111111111111111111';
type Rpc = { method: string; params?: readonly unknown[] };
const execFileAsync = promisify(execFile);
const compilerReuseWorker = fileURLToPath(
  new URL('../identity/fixtures/compilerReuseWorker.ts', import.meta.url),
);

// Only malformed/unavailable responses are doubled; successful evidence comes
// from the real owned chain and all codecs/code hashes execute normally.
function boundary(client: PublicClient, alter: (request: Rpc, result: any) => any): PublicClient {
  return createPublicClient({ transport: custom({ async request(request: Rpc) {
    const result = await client.request(request as Parameters<PublicClient['request']>[0]);
    return await alter(request, result);
  } }, { retryCount: 0 }) });
}

test('authenticates the exact reference activation and rejects gaps or changed provenance', async (t) => {
  const deploy = (deployment as unknown as Record<string, unknown>)['deployReputationRegistryWithProvenance'];
  assert.equal(typeof deploy, 'function', 'the provenance-preserving deployment API must exist');
  const module = await import('../../src/feedback/reputationActivation.js');
  const read = module.readReputationActivation;
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
    const client = createPublicClient({ transport, pollingInterval: 25 });
    const chain = createTestClient({ mode: 'anvil', transport });
    const owner = privateKeyToAccount(generatePrivateKey());
    const reviewer = privateKeyToAccount(generatePrivateKey());
    await chain.setBalance({ address: owner.address, value: parseEther('100') });
    await chain.setBalance({ address: reviewer.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: owner, transport });
    const reviewerWallet = createWalletClient({ account: reviewer, transport });
    const identity = await deployment.deployRegistry(client, wallet);
    await deployment.receipt(client, await wallet.writeContract({ address: identity, abi: deployment.registryAbi,
      functionName: 'register', chain: null }));
    const fixture = await deployment.deployReputationRegistryWithProvenance(client, wallet, identity);
    const p = fixture.provenance;
    const artifacts = compileReferenceContracts();
    const observation = { blockNumber: BigInt(p.activation.blockNumber), blockHash: p.activation.blockHash };
    const input = { client, provenance: p, observation };

    await t.test('returns only independently qualified activation coordinates, with actual runtime pins', async () => {
      const bootstrapBases = new Set<string>();
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getCode' && String(request.params?.[0]).toLowerCase() === p.bootstrap.address.toLowerCase()) {
          bootstrapBases.add(String(request.params?.[1]));
        }
        return value;
      }) });
      assert.equal(result.activation, 'matched', result.diagnostics.join(','));
      assert.equal(result.qualification, 'rpc-derived-not-state-proof');
      assert.equal(result.knownDeployment?.activation.transactionHash, p.activation.transactionHash);
      assert.equal(result.knownDeployment?.activation.initializedLogIndex, p.activation.upgradedLogIndex + 1);
      assert.equal(result.knownDeployment?.implementation.address, p.implementation.address.toLowerCase());
      assert.notEqual(p.bootstrap.runtimeCodeHash, keccak256(artifacts.minimalUups.deployedBytecode));
      assert.notEqual(p.implementation.runtimeCodeHash, keccak256(artifacts.reputationRegistry.deployedBytecode));
      assert.equal(p.proxy.runtimeCodeHash, keccak256(artifacts.erc1967Proxy.deployedBytecode));
      assert.equal(fixture.address, p.domain.reputationRegistry);
      assert.equal(p.artifacts.referenceCommit, 'b9e466c250744a7e06b13dff9d3c2844ed64f825');
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      assert.equal('score' in result, false);
      assert.equal('coverage' in result, false);
      assert.equal('privateKey' in p, false);
      assert.ok(bootstrapBases.has(`0x${BigInt(p.proxy.blockNumber).toString(16)}`),
        'bootstrap runtime must also be checked at the proxy creation basis');
    });

    for (const [name, mutate, want] of [
      ['wrong deployer', (q: typeof p) => { q.deployer = otherAddress; }, 'mismatched'],
      ['wrong created address', (q: typeof p) => { q.bootstrap.address = otherAddress; }, 'mismatched'],
      ['wrong nonce', (q: typeof p) => { q.bootstrap.nonce = '999'; }, 'mismatched'],
      ['wrong activation log', (q: typeof p) => { q.activation.upgradedLogIndex += 1; }, 'mismatched'],
      ['wrong configured Identity', (q: typeof p) => { q.domain.identityRegistry = otherAddress; }, 'mismatched'],
      ['compiler template used as actual runtime', (q: typeof p) => {
        q.implementation.runtimeCodeHash = keccak256(artifacts.reputationRegistry.deployedBytecode); }, 'unsupported'],
      ['wrong artifact pin', (q: typeof p) => { q.artifacts.referenceCommit = 'wrong'; }, 'unsupported'],
    ] as const) {
      await t.test(name, async () => {
        const provenance = structuredClone(p); mutate(provenance);
        const result = await read({ ...input, provenance });
        assert.equal(result.activation, want, result.diagnostics.join(','));
        assert.equal(result.knownDeployment, undefined);
      });
    }

    await t.test('snapshots nested caller provenance and observation before the first await', async () => {
      const provenance = structuredClone(p), selected = { ...observation };
      const limits = { maxRpcCalls: 128 };
      const result = await read({ client: boundary(client, (request, value) => {
        if (request.method === 'eth_chainId') {
          provenance.domain.identityRegistry = otherAddress;
          provenance.bootstrap.nonce = '999';
          provenance.artifacts.artifactSha256['ERC1967Proxy'] = 'wrong';
          selected.blockHash = otherHash;
          limits.maxRpcCalls = 1;
        }
        return value;
      }), provenance, observation: selected, limits });
      assert.equal(result.activation, 'matched', result.diagnostics.join(','));
      assert.equal(result.domain.identityRegistry.toLowerCase(), identity.toLowerCase());
    });

    await t.test('rejects contradictory extra upgrade inside the exact activation receipt', async () => {
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getTransactionReceipt' && request.params?.[0] === p.activation.transactionHash) {
          const log = value.logs.find((entry: any) => entry.topics[0] === upgraded);
          value.logs.push({ ...log, logIndex: '0x2' });
        }
        return value;
      }) });
      assert.equal(result.activation, 'mismatched');
      assert.equal(result.knownDeployment, undefined);
    });
    await t.test('requires the subsequent Initialized(2) in the full activation receipt', async () => {
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getTransactionReceipt' && request.params?.[0] === p.activation.transactionHash) {
          value.logs = value.logs.filter((entry: any) => entry.topics[0] !== initialized);
        }
        return value;
      }) });
      assert.equal(result.activation, 'mismatched');
    });
    await t.test('feedback allegedly inside pinned activation is contradictory', async () => {
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getTransactionReceipt' && request.params?.[0] === p.activation.transactionHash) {
          value.logs.push({ ...value.logs[1], logIndex: '0x2',
            topics: [toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)')] });
        }
        return value;
      }) });
      assert.equal(result.activation, 'mismatched');
      assert.ok(result.diagnostics.includes('feedback-inside-activation'));
    });
    await t.test('does not accept an omitted constructor upgrade from the inclusive log scan', async () => {
      const result = await read({ ...input, client: boundary(client, (request, value) =>
        request.method === 'eth_getLogs' ? value.filter((entry: any) => entry.transactionHash !== p.proxy.transactionHash) : value) });
      assert.equal(result.activation, 'mismatched');
    });
    await t.test('archive failures remain unavailable instead of substituting latest', async () => {
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getCode') throw new Error('missing trie node');
        return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.equal(result.knownDeployment, undefined);
    });
    await t.test('per-request timeout cannot be rescued by a late successful response', async () => {
      const result = await read({ ...input, limits: { rpcTimeoutMs: 5 }, client: boundary(client, async (_request, value) => {
        await new Promise((resolve) => setTimeout(resolve, 25)); return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.ok(result.diagnostics.includes('rpc-timeout'));
    });
    await t.test('cold compilation and warm validation consume the deadline before RPC', async () => {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', compilerReuseWorker, 'deadlines', JSON.stringify({
          provenance: p,
          observation: {
            blockNumber: observation.blockNumber.toString(),
            blockHash: observation.blockHash,
          },
        })],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(stderr, '');
      assert.deepEqual(JSON.parse(stdout), {
        cold: { compileCalls: 1, rpcCalls: 0, diagnostic: 'total-timeout' },
        warm: { compileCalls: 1, rpcCalls: 0, diagnostic: 'total-timeout' },
        cancelled: { compileCalls: 1, rpcCalls: 0, diagnostic: 'cancelled' },
      });
    });
    await t.test('every numbered basis including genesis is rechecked at completion', async () => {
      const calls = new Map<string, number>();
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getBlockByNumber') {
          const number = String(request.params?.[0]);
          const count = (calls.get(number) ?? 0) + 1; calls.set(number, count);
          if (number === '0x0' && count === 2) return null;
        }
        return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.equal(result.knownDeployment, undefined);
      for (const number of ['0x0', ...[p.bootstrap, p.proxy, p.implementation, p.activation].map((r) => `0x${BigInt(r.blockNumber).toString(16)}`)]) {
        assert.ok((calls.get(number) ?? 0) >= 2, `${number} must be rechecked`);
      }
    });

    for (const limits of [{ maxRpcCalls: 1 }, { maxBlocks: 1 }, { maxCodeBytes: 1 },
      { maxInputBytes: 1 }, { maxReceiptLogs: 1 }, { maxReceiptBytes: 1 }, { maxTotalPayloadBytes: 1 }]) {
      await t.test(`bounded work ${JSON.stringify(limits)}`, async () => {
        const result = await read({ ...input, limits });
        assert.equal(result.activation, 'unavailable', result.diagnostics.join(','));
        assert.equal(result.knownDeployment, undefined);
      });
    }
    await t.test('cancellation stops further RPC work', async () => {
      const controller = new AbortController(); let calls = 0;
      const result = await read({ ...input, signal: controller.signal, client: boundary(client, (_request, value) => {
        calls++; controller.abort(); return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.ok(result.diagnostics.includes('cancelled'));
      assert.equal(calls, 1);
    });

    // Real writes below exercise history rejection, not forged successful reads.
    async function manual(options: { suffix?: boolean; wrongConstructor?: boolean; emptyActivation?: boolean;
      wrongInitializer?: boolean; detour?: boolean; feedbackInActivationBlock?: boolean;
      upgradesInActivationBlock?: 'noop' | 'away-back' } = {}) {
      const create = async (artifact: typeof artifacts.minimalUups, args: readonly unknown[] = [], suffix = false) => {
        const mined = await deployment.receipt(client, await wallet.deployContract({ abi: artifact.abi,
          bytecode: suffix ? `${artifact.bytecode}00` : artifact.bytecode, args, chain: null }));
        assert.ok(mined.contractAddress);
        const transaction = await client.getTransaction({ hash: mined.transactionHash });
        const code = await client.getCode({ address: mined.contractAddress, blockNumber: mined.blockNumber });
        assert.ok(code);
        return { address: mined.contractAddress, transactionHash: mined.transactionHash,
          blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash,
          transactionIndex: mined.transactionIndex, nonce: String(transaction.nonce), runtimeCodeHash: keccak256(code) };
      };
      const bootstrap = await create(artifacts.minimalUups);
      const proxy = await create(artifacts.erc1967Proxy, [bootstrap.address, encodeFunctionData({ abi: adminAbi,
        functionName: 'initialize', args: [options.wrongConstructor ? otherAddress : identity] })]);
      const implementation = await create(artifacts.reputationRegistry, [], options.suffix);
      if (options.detour) await deployment.receipt(client, await wallet.writeContract({ address: proxy.address,
        abi: adminAbi, functionName: 'upgradeToAndCall', args: [bootstrap.address, '0x'], chain: null }));
      const batched = !!(options.feedbackInActivationBlock || options.upgradesInActivationBlock);
      const nonce = await client.getTransactionCount({ address: owner.address });
      if (batched) await chain.setAutomine(false);
      let activationReceipt: TransactionReceipt;
      try {
        const hash = await wallet.writeContract({ address: proxy.address, abi: adminAbi, functionName: 'upgradeToAndCall',
          args: [implementation.address, options.emptyActivation ? '0x' : encodeFunctionData({ abi: adminAbi,
            functionName: 'initialize', args: [options.wrongInitializer ? otherAddress : identity] })], nonce, gas: 1_000_000n, chain: null });
        let feedback: Hex | undefined;
        if (options.feedbackInActivationBlock) {
          feedback = await reviewerWallet.writeContract({ address: proxy.address, abi: reputationRegistryAbi,
            functionName: 'giveFeedback', args: [0n, -2n, 0, '', '', '', '', otherHash], gas: 1_000_000n, chain: null });
        }
        const later: Hex[] = [];
        if (options.upgradesInActivationBlock) {
          later.push(await wallet.writeContract({ address: proxy.address, abi: adminAbi, functionName: 'upgradeToAndCall',
            args: [options.upgradesInActivationBlock === 'noop' ? implementation.address : bootstrap.address, '0x'],
            nonce: nonce + 1, gas: 1_000_000n, chain: null }));
          if (options.upgradesInActivationBlock === 'away-back') later.push(await wallet.writeContract({ address: proxy.address,
            abi: adminAbi, functionName: 'upgradeToAndCall', args: [implementation.address, '0x'],
            nonce: nonce + 2, gas: 1_000_000n, chain: null }));
        }
        if (batched) await chain.mine({ blocks: 1 });
        activationReceipt = await deployment.receipt(client, hash);
        for (const next of later) assert.equal((await deployment.receipt(client, next)).blockHash, activationReceipt.blockHash);
        if (feedback) {
          const feedbackReceipt = await deployment.receipt(client, feedback);
          assert.equal(feedbackReceipt.blockHash, activationReceipt.blockHash);
          assert.ok(feedbackReceipt.transactionIndex > activationReceipt.transactionIndex);
        }
      } finally { if (batched) await chain.setAutomine(true); }
      const log = activationReceipt.logs.find((entry) => entry.topics[0] === upgraded);
      assert.ok(log && log.logIndex !== null);
      return { ...structuredClone(p), bootstrap, proxy, implementation,
        domain: { ...p.domain, reputationRegistry: proxy.address },
        activation: { transactionHash: activationReceipt.transactionHash, blockNumber: activationReceipt.blockNumber.toString(),
          blockHash: activationReceipt.blockHash, transactionIndex: activationReceipt.transactionIndex, upgradedLogIndex: log.logIndex } };
    }
    for (const [name, options, want] of [
      ['creation suffix', { suffix: true }, 'mismatched'],
      ['wrong constructor Identity despite correct final link', { wrongConstructor: true }, 'mismatched'],
      ['activation without initializer', { emptyActivation: true }, 'mismatched'],
      ['wrong activation initializer Identity', { wrongInitializer: true }, 'mismatched'],
      ['preactivation no-op detour', { detour: true }, 'mismatched'],
      ['later feedback in activation block', { feedbackInActivationBlock: true }, 'matched'],
      ['same-activation-block no-op upgrade', { upgradesInActivationBlock: 'noop' }, 'mismatched'],
      ['same-activation-block away/back upgrade', { upgradesInActivationBlock: 'away-back' }, 'mismatched'],
    ] as const) {
      await t.test(name, async () => {
        const provenance = await manual(options);
        const result = await read({ client, provenance, observation: {
          blockNumber: BigInt(provenance.activation.blockNumber), blockHash: provenance.activation.blockHash } });
        assert.equal(result.activation, want, result.diagnostics.join(','));
      });
    }

    await t.test('rejects same-block away/back although final slot and code match', async () => {
      const nonce = await client.getTransactionCount({ address: owner.address });
      await chain.setAutomine(false);
      try {
        const away = await wallet.writeContract({ address: fixture.address, abi: adminAbi, functionName: 'upgradeToAndCall',
          args: [p.bootstrap.address, '0x'], nonce, gas: 1_000_000n, chain: null });
        const back = await wallet.writeContract({ address: fixture.address, abi: adminAbi, functionName: 'upgradeToAndCall',
          args: [p.implementation.address, '0x'], nonce: nonce + 1, gas: 1_000_000n, chain: null });
        await chain.mine({ blocks: 1 });
        const a = await deployment.receipt(client, away), b = await deployment.receipt(client, back);
        assert.equal(a.blockHash, b.blockHash);
        const result = await read({ ...input, observation: { blockNumber: b.blockNumber, blockHash: b.blockHash } });
        assert.equal(result.activation, 'mismatched', result.diagnostics.join(','));
        assert.ok(result.diagnostics.includes('unexpected-upgrade'));
      } finally { await chain.setAutomine(true); }
    });

    await t.test('actual slot mismatch makes code eligibility unsupported', async () => {
      const snapshot = await chain.snapshot();
      try {
        await chain.setStorageAt({ address: fixture.address, index: IMPLEMENTATION_SLOT,
          value: `0x${'00'.repeat(12)}${p.bootstrap.address.slice(2)}` });
        await chain.mine({ blocks: 1 });
        const block = await client.getBlock(); assert.ok(block.hash);
        const result = await read({ ...input, observation: { blockNumber: block.number, blockHash: block.hash } });
        assert.equal(result.activation, 'unsupported');
      } finally { await chain.revert({ id: snapshot }); }
    });
    await t.test('actual code mismatch makes code eligibility unsupported', async () => {
      const snapshot = await chain.snapshot();
      try {
        await chain.setCode({ address: p.implementation.address, bytecode: '0x00' });
        await chain.mine({ blocks: 1 });
        const block = await client.getBlock(); assert.ok(block.hash);
        const result = await read({ ...input, observation: { blockNumber: block.number, blockHash: block.hash } });
        assert.equal(result.activation, 'unsupported');
      } finally { await chain.revert({ id: snapshot }); }
    });
    await t.test('a genuine observation reorg during reads prevents a matched result', async () => {
      const provenance = await manual();
      const snapshot = await chain.snapshot();
      await chain.mine({ blocks: 1 });
      const block = await client.getBlock(); assert.ok(block.hash);
      let changed = false;
      const result = await read({ ...input, provenance, observation: { blockNumber: block.number, blockHash: block.hash },
        client: boundary(client, async (request, value) => {
          if (!changed && request.method === 'eth_getLogs') {
            changed = true; await chain.revert({ id: snapshot });
            await chain.setNextBlockTimestamp({ timestamp: block.timestamp + 3n });
            await chain.mine({ blocks: 1 });
          }
          return value;
        }) });
      assert.equal(result.activation, 'unavailable', result.diagnostics.join(','));
      assert.ok(result.diagnostics.includes('canonicality-changed'));
      assert.equal(result.knownDeployment, undefined);
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});

test('legacy address deployment still works at a nonzero initial block while provenance requires genesis', async () => {
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
    const client = createPublicClient({ transport, pollingInterval: 25 });
    const chain = createTestClient({ mode: 'anvil', transport });
    const owner = privateKeyToAccount(generatePrivateKey());
    await chain.setBalance({ address: owner.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: owner, transport });
    const identity = await deployment.deployRegistry(client, wallet);
    const address = await deployment.deployReputationRegistry(client, wallet, identity);
    assert.equal(await client.readContract({ address, abi: reputationRegistryAbi, functionName: 'getVersion' }), '2.0.0');
    const before = await client.getBlockNumber({ cacheTime: 0 });
    await assert.rejects(deployment.deployReputationRegistryWithProvenance(client, wallet, identity), /Block could not be found/);
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before, 'missing genesis must fail before deployment writes');
  }, { genesisMarker: { blockNumber: 100n, timestamp: 1_700_000_000n } });
});

test('activation review regressions bind observation metadata and preserve final gaps', async (t) => {
  const { readReputationActivation: read } = await import('../../src/feedback/reputationActivation.js');
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
    const client = createPublicClient({ transport, pollingInterval: 25 });
    const chain = createTestClient({ mode: 'anvil', transport });
    const owner = privateKeyToAccount(generatePrivateKey());
    await chain.setBalance({ address: owner.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: owner, transport });
    const identity = await deployment.deployRegistry(client, wallet);
    const { provenance } = await deployment.deployReputationRegistryWithProvenance(client, wallet, identity);
    const observation = { blockNumber: BigInt(provenance.activation.blockNumber), blockHash: provenance.activation.blockHash };
    const canonical = await client.getBlock({ blockNumber: observation.blockNumber });
    const observationNumber = `0x${observation.blockNumber.toString(16)}`;
    const input = { client, provenance, observation };

    await t.test('a changed second observation header cannot lend its timestamp to the configured hash', async () => {
      let observationReads = 0;
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getBlockByNumber' && request.params?.[0] === observationNumber && ++observationReads === 2) {
          return { ...value, hash: otherHash, timestamp: '0x1' };
        }
        return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.ok(result.diagnostics.includes('canonicality-changed'));
      assert.equal(result.knownDeployment, undefined);
      assert.equal(result.observation.blockTimestamp, canonical.timestamp.toString(),
        'timestamp must come from the same hash-checked header');
    });

    await t.test('a final archive gap stays unavailable when a later final header is also malformed', async () => {
      let genesisReads = 0, finalGapObserved = false;
      const result = await read({ ...input, client: boundary(client, (request, value) => {
        if (request.method === 'eth_getBlockByNumber') {
          if (request.params?.[0] === '0x0' && ++genesisReads === 2) {
            finalGapObserved = true; return null;
          }
          if (finalGapObserved && request.params?.[0] === observationNumber) return { ...value, number: '0x0' };
        }
        return value;
      }) });
      assert.equal(result.activation, 'unavailable');
      assert.ok(result.diagnostics.includes('numbered-block-unavailable'));
      assert.ok(result.diagnostics.includes('block-number-mismatch'));
      assert.equal(result.knownDeployment, undefined);
    });

    await t.test('the initial unavailable default is not an observed gap and cannot hide a plain mismatch', async () => {
      const result = await read({ ...input, provenance: { ...provenance, deployer: otherAddress } });
      assert.equal(result.activation, 'mismatched');
      assert.ok(result.diagnostics.includes('transaction-mismatch'));
      assert.equal(result.knownDeployment, undefined);
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});
