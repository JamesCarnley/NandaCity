import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, encodeFunctionData, encodeFunctionResult,
  http, parseAbi, parseAbiParameters, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { receipt } from '../../src/demo/registryFixture.js';
import { readFeedbackPublication } from '../../src/feedback/publication.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';
import { publicationFixture } from './fixtures.js';

const otherHash = `0x${'12'.repeat(32)}` as Hex;
const rawParameters = parseAbiParameters('uint256, int128, uint8, bytes, bytes, bytes, bytes, bytes32');
const storedParameters = parseAbiParameters('int128, uint8, bytes, bytes, bool');
const readSelector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'readFeedback',
  args: [0n, '0x1111111111111111111111111111111111111111', 1n] }).slice(0, 10);
const lastSelector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getLastIndex',
  args: [0n, '0x1111111111111111111111111111111111111111'] }).slice(0, 10);
type RpcMessage = { method: string; params: unknown[]; id: number };
type RpcReply = { result?: any; error?: unknown; id: number; jsonrpc: string };
const selector = (request: RpcMessage) => request.method === 'eth_call'
  ? (request.params[0] as { data: string }).data.slice(0, 10) : '';

/** Doubles only alter malformed/unavailable RPC responses from our real owned chain. */
async function withReadProxy(rpcUrl: string, alter: (request: RpcMessage, reply: RpcReply) => void,
  use: (client: PublicClient) => Promise<void>) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += (chunk as Buffer).length;
        if (length > 100_000) throw new Error('oversized test request');
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(body) as RpcMessage;
      assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call'].includes(parsed.method));
      const forwarded = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(2_000) });
      const reply = await forwarded.json() as RpcReply;
      alter(parsed, reply);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply));
    } catch { response.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await use(createPublicClient({ transport: http(`http://127.0.0.1:${address.port}`, { retryCount: 0, timeout: 2_000 }) }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function reference(mined: TransactionReceipt, registry: string) {
  const log = mined.logs.find((entry) => entry.address.toLowerCase() === registry.toLowerCase());
  assert.ok(log && log.logIndex !== null);
  return { blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash,
    transactionHash: mined.transactionHash, transactionIndex: mined.transactionIndex, logIndex: log.logIndex };
}

test('opaque registry observation authenticates real direct and routed slots at a fixed basis', async (t) => {
  const module = await import('../../src/feedback/registryObservation.js');
  assert.equal(typeof module.readRegistryFeedbackObservation, 'function', 'raw observation reader must exist');
  const read = module.readRegistryFeedbackObservation;
  await withOwnedAnvil(async (rpcUrl) => {
    const f = await publicationFixture(rpcUrl);
    const giveSelector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'giveFeedback',
      args: [0n, 0n, 0, '', '', '', '', otherHash] }).slice(0, 10);
    // A Solidity string may contain any bytes; send the canonical ABI without a text codec.
    const rawCall = `${giveSelector}${encodeAbiParameters(rawParameters,
      [0n, -100000000000000000000000000000000000000n, 18, '0xff', '0xefbbbf61', '0x610062', '0xc080', otherHash]).slice(2)}` as Hex;
    const mined = await receipt(f.publicClient, await f.walletClient.sendTransaction({ to: f.reputationRegistry,
      data: rawCall, chain: null }));
    const genesis = await f.publicClient.getBlock({ blockNumber: 0n });
    assert.ok(genesis.hash);
    const domain = { chainId: 31337, genesisHash: genesis.hash,
      identityRegistry: f.identityRegistry, reputationRegistry: f.reputationRegistry };
    const eventRef = reference(mined, f.reputationRegistry);
    const observation = { blockNumber: mined.blockNumber, blockHash: mined.blockHash };
    const input = { client: f.publicClient, domain, eventRef, observation };

    await t.test('opaque feedback is authentic without a City document or UTF-8 projection', async () => {
      const result = await read(input);
      assert.equal(result.authenticity, 'matched');
      assert.equal(result.revocation, 'active');
      assert.deepEqual(result.event, { address: f.reputationRegistry.toLowerCase(), agentId: '0',
        reviewer: f.caller.address.toLowerCase(), feedbackIndex: '1', value: '-100000000000000000000000000000000000000',
        valueDecimals: 18, tag1Bytes: '0xff', tag2Bytes: '0xefbbbf61', endpointBytes: '0x610062',
        feedbackURIBytes: '0xc080', feedbackHash: otherHash });
      assert.deepEqual(result.storage, { value: '-100000000000000000000000000000000000000', valueDecimals: 18,
        tag1Bytes: '0xff', tag2Bytes: '0xefbbbf61', isRevoked: false, lastIndex: '1' });
      assert.equal(result.source?.transactionHash, mined.transactionHash);
      assert.equal(result.qualification, 'rpc-derived-not-state-proof');
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      assert.equal('document' in result, false);
      assert.equal('score' in result, false);
    });

    await t.test('ordinary text and empty slots retain their exact bytes without requiring the document', async () => {
      const ordinary = await receipt(f.publicClient, await f.walletClient.writeContract({ address: f.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback',
        args: [0n, 5n, 0, 'rubric', '', '', 'https://example.invalid/review', otherHash], chain: null }));
      const result = await read({ ...input, eventRef: reference(ordinary, f.reputationRegistry),
        observation: { blockNumber: ordinary.blockNumber, blockHash: ordinary.blockHash } });
      assert.equal(result.authenticity, 'matched');
      assert.equal(result.event?.feedbackIndex, '2');
      assert.equal(result.event?.tag1Bytes, '0x727562726963');
      assert.equal(result.event?.tag2Bytes, '0x');
      assert.equal(result.event?.endpointBytes, '0x');
      assert.equal(result.event?.feedbackURIBytes, '0x68747470733a2f2f6578616d706c652e696e76616c69642f726576696577');
    });

    await t.test('caller mutation after the first await cannot replace the captured authority basis or budgets', async () => {
      const mutable = { ...input, domain: { ...domain }, eventRef: { ...eventRef }, observation: { ...observation },
        limits: { maxRpcCalls: 16 } };
      await withReadProxy(rpcUrl, (request) => {
        if (request.method === 'eth_chainId') {
          mutable.domain.chainId = 1;
          mutable.domain.genesisHash = otherHash;
          mutable.eventRef.blockHash = otherHash;
          mutable.eventRef.logIndex = 999;
          mutable.observation.blockHash = otherHash;
          mutable.limits.maxRpcCalls = 1;
        }
      }, async (client) => {
        const result = await read({ ...mutable, client });
        assert.equal(result.authenticity, 'matched');
        assert.equal(result.domain.chainId, 31337);
        assert.equal(result.eventRef.logIndex, eventRef.logIndex);
        assert.equal(result.observation.blockHash, observation.blockHash);
      });
    });

    await t.test('actual routed writes use the emitting event client for storage, never the outer sender', async () => {
      const require = createRequire(import.meta.url);
      const solc = require('solc') as { compile(input: string): string };
      const source = 'pragma solidity ^0.8.24; contract Router { function forward(address target, bytes calldata data) external { (bool ok,) = target.call(data); require(ok); } }';
      const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Router.sol': { content: source } },
        settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
      const artifact = compiled.contracts['Router.sol'].Router;
      const deployed = await receipt(f.publicClient, await f.walletClient.deployContract({ abi: artifact.abi,
        bytecode: `0x${artifact.evm.bytecode.object}`, chain: null }));
      assert.ok(deployed.contractAddress);
      const router = deployed.contractAddress;
      const routerAbi = parseAbi(['function forward(address target, bytes data)']);
      const routed = await receipt(f.publicClient, await f.walletClient.writeContract({ address: router, abi: routerAbi,
        functionName: 'forward', args: [f.reputationRegistry, rawCall], chain: null }));
      const routedInput = { ...input, eventRef: reference(routed, f.reputationRegistry),
        observation: { blockNumber: routed.blockNumber, blockHash: routed.blockHash } };
      const result = await read(routedInput);
      assert.equal(result.authenticity, 'matched');
      assert.equal(result.event?.reviewer, router.toLowerCase());
      assert.equal(result.event?.feedbackIndex, '1');
      assert.equal(result.revocation, 'active');
      const city = await readFeedbackPublication({ client: f.publicClient, domain, eventRef: {
        ...routedInput.eventRef, feedbackURI: f.feedbackURI }, observationBlock: routed.blockNumber, documentBytes: f.document });
      assert.equal(city.publication, 'mismatched', 'raw routed support must not weaken City direct-to-registry rules');
      assert.ok(city.diagnostics.includes('receipt-mismatch'));
      const revoked = await receipt(f.publicClient, await f.walletClient.writeContract({ address: router, abi: routerAbi,
        functionName: 'forward', args: [f.reputationRegistry, encodeFunctionData({ abi: reputationRegistryAbi,
          functionName: 'revokeFeedback', args: [0n, 1n] })], chain: null }));
      assert.equal((await read({ ...routedInput, observation: { blockNumber: revoked.blockNumber,
        blockHash: revoked.blockHash } })).revocation, 'revoked');
      assert.equal((await read(routedInput)).revocation, 'active');
    });

    await t.test('chain, genesis and registry domain contradictions cannot match', async () => {
      for (const patch of [{ chainId: 1 }, { genesisHash: otherHash }, { reputationRegistry: f.identityRegistry },
        { identityRegistry: f.stranger.address }]) {
        const result = await read({ ...input, domain: { ...domain, ...patch } });
        assert.equal(result.authenticity, 'mismatched');
        assert.equal(result.revocation, 'unknown');
      }
      const wrongObservationOnly = await read({ ...input, observation: { ...observation, blockHash: otherHash } });
      assert.equal(wrongObservationOnly.authenticity, 'unavailable');
      assert.equal(wrongObservationOnly.revocation, 'unknown');
      assert.ok(wrongObservationOnly.diagnostics.includes('observation-basis-changed'));
      assert.equal(wrongObservationOnly.diagnostics.includes('source-block-orphaned'), false,
        'different supplied hashes at one height cannot orphan a source that still matches the canonical hash');
      assert.equal((await read({ ...input, observation: { blockNumber: 0n, blockHash: genesis.hash } })).authenticity, 'mismatched');
    });

    await t.test('all receipt and selected-log coordinates plus uniqueness are authenticated', async () => {
      const faults: Array<(reply: RpcReply) => void> = [
        (r) => { r.result.status = '0x0'; },
        (r) => { r.result.blockNumber = '0x0'; },
        (r) => { r.result.blockHash = otherHash; },
        (r) => { r.result.transactionHash = otherHash; },
        (r) => { r.result.transactionIndex = '0x1'; },
        (r) => { r.result.logs[0].address = f.identityRegistry; },
        (r) => { r.result.logs[0].blockNumber = '0x0'; },
        (r) => { r.result.logs[0].blockHash = otherHash; },
        (r) => { r.result.logs[0].transactionHash = otherHash; },
        (r) => { r.result.logs[0].transactionIndex = '0x1'; },
        (r) => { r.result.logs[0].logIndex = '0x100'; },
        (r) => { r.result.logs[0].removed = true; },
        (r) => { r.result.logs.push({ ...r.result.logs[0] }); },
        (r) => { r.result.logs[0].topics[0] = otherHash; },
        (r) => { r.result.logs[0].topics[3] = otherHash; },
        (r) => { r.result.logs[0].data += '00'; },
        (r) => { r.result.logs[0].logIndex = '0x20000000000000'; },
        (r) => { r.result.transactionIndex = '0x20000000000000'; },
      ];
      for (const fault of faults) await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getTransactionReceipt') fault(reply);
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.authenticity, 'mismatched');
        assert.equal(result.revocation, 'unknown');
      });
    });

    await t.test('wrong storage tuple, range, noncanonical boolean or missing slot never yields active', async () => {
      const stored = encodeAbiParameters(storedParameters,
        [-100000000000000000000000000000000000000n, 18, '0xff', '0xefbbbf61', false]);
      for (const output of [
        encodeAbiParameters(storedParameters, [1n, 18, '0xff', '0xefbbbf61', false]),
        encodeAbiParameters(storedParameters, [-100000000000000000000000000000000000000n, 17, '0xff', '0xefbbbf61', false]),
        encodeAbiParameters(storedParameters, [-100000000000000000000000000000000000000n, 18, '0xfe', '0xefbbbf61', false]),
        encodeAbiParameters(storedParameters, [-100000000000000000000000000000000000000n, 18, '0xff', '0x61', false]),
        `${stored.slice(0, 258)}${'0'.repeat(63)}2${stored.slice(322)}`,
        `${stored}00`,
      ]) await withReadProxy(rpcUrl, (request, reply) => { if (selector(request) === readSelector) reply.result = output; }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.authenticity, 'mismatched');
        assert.equal(result.revocation, 'unknown');
      });
      await withReadProxy(rpcUrl, (request, reply) => {
        if (selector(request) === lastSelector) reply.result = encodeFunctionResult({ abi: reputationRegistryAbi,
          functionName: 'getLastIndex', result: 0n });
      }, async (client) => {
        assert.equal((await read({ ...input, client })).authenticity, 'mismatched');
      });
    });

    await t.test('version and interface claims are checked descriptively, never promoted to code provenance', async () => {
      const versionSelector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getVersion' }).slice(0, 10);
      for (const target of [f.reputationRegistry, f.identityRegistry]) await withReadProxy(rpcUrl, (request, reply) => {
        if (selector(request) === versionSelector && (request.params[0] as { to: string }).to.toLowerCase() === target.toLowerCase()) {
          reply.result = encodeFunctionResult({ abi: reputationRegistryAbi, functionName: 'getVersion', result: '3.0.0' });
        }
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.authenticity, 'mismatched');
        assert.equal(result.revocation, 'unknown');
        assert.equal('knownCode' in result, false);
      });
      await withReadProxy(rpcUrl, (request, reply) => {
        if (selector(request) === '0x01ffc9a7') reply.result = encodeAbiParameters(parseAbiParameters('bool'), [false]);
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.authenticity, 'mismatched');
        assert.equal(result.revocation, 'unknown');
        assert.ok(result.diagnostics.includes('identity-interface-mismatch'));
      });
    });

    await t.test('numbered storage reads and post-read source/observation rechecks bracket the result', async () => {
      const latest = await f.publicClient.getBlock({ blockTag: 'latest' });
      assert.ok(latest.number && latest.hash);
      const later = { blockNumber: latest.number, blockHash: latest.hash };
      await withReadProxy(rpcUrl, (request) => {
        if (request.method === 'eth_call') assert.equal(request.params[1], `0x${later.blockNumber.toString(16)}`);
        if (request.method === 'eth_getBlockByNumber') assert.notEqual(request.params[0], 'latest');
      }, async (client) => {
        assert.equal((await read({ ...input, client, observation: later })).authenticity, 'matched');
      });
      for (const [basis, want] of [[eventRef.blockNumber, 'orphaned'], [later.blockNumber.toString(), 'unavailable']] as const) {
        let reads = 0;
        await withReadProxy(rpcUrl, (request, reply) => {
          if (request.method === 'eth_getBlockByNumber' && reply.result?.number === `0x${BigInt(basis).toString(16)}` && ++reads === 2) {
            reply.result.hash = otherHash;
          }
        }, async (client) => {
          const result = await read({ ...input, client, observation: later });
          assert.equal(result.authenticity, want);
          assert.equal(result.revocation, 'unknown');
        });
      }
    });

    await t.test('unavailable historical state and receipt remain unavailable, not an empty or active slot', async () => {
      for (const method of ['eth_getTransactionReceipt', 'eth_call']) await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === method) { delete reply.result; reply.error = { code: -32000, message: 'archive unavailable' }; }
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.authenticity, 'unavailable');
        assert.equal(result.revocation, 'unknown');
      });
    });

    await t.test('receipt work and ABI payload budgets reject before decoding', async () => {
      for (const limits of [{ maxReceiptLogs: 1 }, { maxLogBytes: 32 }, { maxReceiptBytes: 128 }, { maxRpcCalls: 1 }]) {
        await withReadProxy(rpcUrl, (request, reply) => {
          if (request.method === 'eth_getTransactionReceipt' && limits.maxReceiptLogs) {
            reply.result.logs.push({ ...reply.result.logs[0], logIndex: '0x100' });
          }
        }, async (client) => {
          const result = await read({ ...input, client, limits });
          assert.equal(result.authenticity, 'unavailable');
          assert.equal(result.revocation, 'unknown');
          assert.ok(result.diagnostics.some((code) => code.includes('budget')));
        });
      }
    });

    await t.test('unsafe input coordinates and unbounded limit overrides are rejected explicitly', async () => {
      for (const patch of [{ transactionIndex: Number.MAX_SAFE_INTEGER + 1 }, { logIndex: -1 }]) {
        await assert.rejects(read({ ...input, eventRef: { ...eventRef, ...patch } }), /coordinate|reference/);
      }
      for (const limits of [{ totalTimeoutMs: Infinity }, { rpcTimeoutMs: 0 }, { maxRpcCalls: 999999 }, { maxReceiptLogs: NaN }]) {
        await assert.rejects(read({ ...input, limits }), /limit/);
      }
    });

    await t.test('per-RPC and total deadlines return unknown without leaked abort listeners', async () => {
      const controller = new AbortController();
      const client = createPublicClient({ transport: custom({ request: () => new Promise(() => {}) }, { retryCount: 0 }) });
      for (const limits of [{ rpcTimeoutMs: 5, totalTimeoutMs: 100 }, { rpcTimeoutMs: 100, totalTimeoutMs: 5 }]) {
        const result = await read({ ...input, client, signal: controller.signal, limits });
        assert.equal(result.authenticity, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.ok(result.diagnostics.some((code) => code.includes('timeout')));
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      }
      const pending = read({ ...input, client, signal: controller.signal });
      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.authenticity, 'unavailable');
      assert.ok(cancelled.diagnostics.includes('cancelled'));
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.ok((await read({ ...input, client, signal: controller.signal })).diagnostics.includes('cancelled'));
    });

    await t.test('fulfilled real RPC replies cannot bypass the per-call elapsed deadline by blocking timers', async () => {
      const chainId = await f.publicClient.request({ method: 'eth_chainId' });
      for (const microtask of [false, true]) {
        const controller = new AbortController();
        let calls = 0;
        const client = createPublicClient({ transport: custom({ request: async (request) => {
          calls++;
          if (request.method === 'eth_chainId') {
            if (microtask) await Promise.resolve();
            const until = performance.now() + 150;
            while (performance.now() < until) { /* Reproduce an overdue timer followed by immediate fulfillment. */ }
            return chainId;
          }
          return f.publicClient.request(request);
        } }, { retryCount: 0 }) });
        const result = await read({ ...input, client, signal: controller.signal,
          limits: { rpcTimeoutMs: 75, totalTimeoutMs: 5_000 } });
        assert.equal(result.authenticity, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.deepEqual(result.diagnostics, ['rpc-timeout']);
        assert.equal(calls, 1, 'late fulfillment must not permit any subsequent RPC');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      }
    });

    await t.test('late fulfilled replies preserve cancellation then total-timeout precedence', async () => {
      const chainId = await f.publicClient.request({ method: 'eth_chainId' });
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        let calls = 0;
        const client = createPublicClient({ transport: custom({ request: async () => {
          calls++;
          const until = performance.now() + 150;
          while (performance.now() < until) { /* Both elapsed deadlines expire before the timer can fire. */ }
          if (cancel) controller.abort();
          return chainId;
        } }, { retryCount: 0 }) });
        const result = await read({ ...input, client, signal: controller.signal,
          limits: { rpcTimeoutMs: 75, totalTimeoutMs: 100 } });
        assert.equal(result.authenticity, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.deepEqual(result.diagnostics, [cancel ? 'cancelled' : 'total-timeout']);
        assert.equal(calls, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      }
    });

    await t.test('actual local reorg orphans the source even when its original observation hash is retained', async () => {
      const snapshot = await f.testClient.snapshot();
      const publication = await receipt(f.publicClient, await f.walletClient.sendTransaction({ to: f.reputationRegistry,
        data: rawCall, chain: null }));
      await f.testClient.revert({ id: snapshot });
      await f.testClient.setNextBlockTimestamp({ timestamp: 1_800_000_000n });
      await f.testClient.mine({ blocks: 1 });
      const replaced = await f.publicClient.getBlock({ blockNumber: publication.blockNumber });
      assert.ok(replaced.hash);
      const original = { ...input, eventRef: reference(publication, f.reputationRegistry),
        observation: { blockNumber: publication.blockNumber, blockHash: publication.blockHash } };
      const replay = await read(original);
      assert.equal(replay.authenticity, 'orphaned');
      assert.equal(replay.revocation, 'unknown');
      assert.ok(replay.diagnostics.includes('source-block-orphaned'));
      const result = await read({ ...input, eventRef: reference(publication, f.reputationRegistry),
        observation: { blockNumber: publication.blockNumber, blockHash: replaced.hash } });
      assert.equal(result.authenticity, 'orphaned');
      assert.equal(result.revocation, 'unknown');
    });

    await t.test('an observation-only real reorg or an unreadable source remains unavailable, not orphaned', async () => {
      const snapshot = await f.testClient.snapshot();
      await f.testClient.mine({ blocks: 1 });
      const originalObservation = await f.publicClient.getBlock({ blockTag: 'latest' });
      assert.ok(originalObservation.number && originalObservation.hash);
      await f.testClient.revert({ id: snapshot });
      await f.testClient.setNextBlockTimestamp({ timestamp: 1_800_000_100n });
      await f.testClient.mine({ blocks: 1 });
      const changed = { blockNumber: originalObservation.number, blockHash: originalObservation.hash };
      const result = await read({ ...input, observation: changed });
      assert.equal(result.authenticity, 'unavailable');
      assert.equal(result.revocation, 'unknown');
      assert.ok(result.diagnostics.includes('observation-basis-changed'));
      assert.equal(result.diagnostics.includes('source-block-orphaned'), false);
      await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getBlockByNumber' && request.params[0] === `0x${mined.blockNumber.toString(16)}`) reply.result = null;
      }, async (client) => {
        const unreadable = await read({ ...input, client, observation: changed });
        assert.equal(unreadable.authenticity, 'unavailable');
        assert.equal(unreadable.revocation, 'unknown');
        assert.equal(unreadable.diagnostics.includes('source-block-orphaned'), false);
      });
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});
