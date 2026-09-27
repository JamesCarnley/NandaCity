import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, decodeAbiParameters, encodeAbiParameters,
  encodeFunctionData, http, keccak256, parseAbi, parseAbiParameters, parseEther, type Hex, type TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistry, deployReputationRegistryWithProvenance, receipt, registryAbi } from '../../src/demo/registryFixture.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';
import { feedbackEventId, feedbackSourceId, type FeedbackIndexSource, type IndexFeedbackEvent } from '../../src/feedback/indexClient.js';
import { createRankingReadBudget } from '../../src/reputation/readBudget.js';
import { withOwnedIndexes } from '../../src/demo/indexProcesses.js';
import { readIndexFeedbackHistory } from '../../src/feedback/indexClient.js';
import { readHistoricalFeedback } from '../../src/feedback/historicalRead.js';
import { boundRpcFetch } from '../../src/identity/rpcTransport.js';

async function listener(handler: (path: string, response: ServerResponse) => void) {
  const server = createServer((req, res) => handler(req.url!, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function rpcProxy(rpcOrigin: string, alter: (request: any, reply: any) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 262144) throw new Error(); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString('utf8'), request = JSON.parse(body);
      assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
        'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getLogs'].includes(request.method));
      const forwarded = await fetch(rpcOrigin, { method: 'POST', body, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
      const reply = await forwarded.json(); await alter(request, reply);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
    } catch { res.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('accepted-reviewer coverage uses real activation, counters and opaque slots with isolated two-source acquisition', { timeout: 600000 }, async (t) => {
  const api = await import('../../src/reputation/coverage.js').catch(() => undefined);
  assert.ok(api, 'accepted-reviewer coverage must exist');
  await withOwnedAnvil(async (rpcOrigin) => {
    const transport = http(rpcOrigin, { retryCount: 0 });
    const client = createPublicClient({ transport, pollingInterval: 25, cacheTime: 0 });
    const chain = createTestClient({ mode: 'anvil', transport });
    const owner = privateKeyToAccount(generatePrivateKey()), reviewer = privateKeyToAccount(generatePrivateKey());
    for (const account of [owner, reviewer]) await chain.setBalance({ address: account.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: owner, transport }), writer = createWalletClient({ account: reviewer, transport });
    const identity = await deployRegistry(client, wallet);
    await receipt(client, await wallet.writeContract({ address: identity, abi: registryAbi, functionName: 'register', chain: null }));
    const { provenance } = await deployReputationRegistryWithProvenance(client, wallet, identity);
    const source: FeedbackIndexSource = { ...provenance.domain, startBlock: provenance.proxy.blockNumber, confirmations: 0 };
    const sourceId = feedbackSourceId(source), document = Buffer.from('opaque non-City publication'), hash = keccak256(document);
    const rows: [IndexFeedbackEvent[], IndexFeedbackEvent[]] = [[], []];
    let malformedCursor = false, unavailableA = false, badDocumentA = false, stalledA = false, firstStallAt = 0, documentCallsA = 0, documentCallsB = 0;
    let floodA = false, floodPages = 0;
    let observation = { blockNumber: BigInt(provenance.activation.blockNumber), blockHash: provenance.activation.blockHash };
    function handler(index: 0 | 1) { return (path: string, res: ServerResponse) => {
      if (index === 0 && stalledA) { firstStallAt ||= performance.now(); res.write(' '); return; }
      if (index === 0 && unavailableA) { res.statusCode = 503; res.end('{}'); return; }
      if (path.includes('/documents/')) {
        if (index === 0) documentCallsA++; else documentCallsB++;
        res.end(index === 0 && badDocumentA ? 'forged' : document); return;
      }
      const block = { number: observation.blockNumber.toString(), hash: observation.blockHash, timestamp: 1700000000 };
      const coverage = { sourceId, source, stateVersion: '1', generation: '0', availability: 'available', progress: 'lagging',
        checkpoint: block, observedHead: block, finalizedBlock: block, rebuildingThrough: null, lastSuccessAt: null, lastAttemptAt: null,
        retention: { retained: '0', pending: '0', blocked: '0' } };
      res.setHeader('content-type', 'application/json');
      const url = new URL(path, 'http://127.0.0.1');
      let selectedRows = rows[index].filter((e) => e.decoded.reviewer === url.searchParams.get('reviewer') &&
        e.decoded.agentId === url.pathname.split('/').at(-1));
      let nextCursor: string | number | null = index === 0 && malformedCursor ? 7 : null;
      if (index === 0 && floodA && path.includes('/agents/')) {
        const entry = selectedRows[floodPages++]; selectedRows = entry ? [entry] : [];
        if (entry) nextCursor = Buffer.from(JSON.stringify({ version: 1, sourceId, agentId: '0', reviewer: reviewer.address.toLowerCase(),
          view: 'all-retained', pageSize: 100, order: 'block-transaction-log-event', generation: '0', through: block,
          sequence: '100', after: [entry.raw.block.number, entry.raw.transactionIndex, entry.raw.logIndex, entry.eventId] })).toString('base64url');
      }
      const body = JSON.stringify(path.includes('/agents/') ? { coverage, basis: { generation: '0', through: block, insertionSequence: '100' },
        view: 'all-retained', items: selectedRows, canonicalityBasis: 'current-coverage', nextCursor,
        semantics: 'not-evaluated' } : { coverage, retention: { ...coverage.retention, scope: 'canonical-prefix', newFeedbackEvents: '0' }, semantics: 'not-evaluated' });
      res.end(index === 0 && floodA ? body.padEnd(2097152) : body);
    }; }
    const a = await listener(handler(0)), b = await listener(handler(1));
    const config = () => ({ rpcOrigin, provenance, observation, agentIds: ['0'], reviewers: [reviewer.address],
      indexes: [{ origin: a.origin, source }, { origin: b.origin, source }] as const });
    const makeEvent = async (mined: TransactionReceipt): Promise<IndexFeedbackEvent> => {
      const block = await client.getBlock({ blockNumber: mined.blockNumber });
      const log = mined.logs.find((entry) => entry.address.toLowerCase() === source.reputationRegistry)!;
      const data = decodeAbiParameters(parseAbiParameters('uint64,int128,uint8,bytes,bytes,bytes,bytes,bytes32'), log.data);
      const [agentId] = decodeAbiParameters(parseAbiParameters('uint256'), log.topics[1]!);
      const [clientAddress] = decodeAbiParameters(parseAbiParameters('address'), log.topics[2]!);
      const invalidTextFields: Array<'tag1' | 'tag2' | 'endpoint' | 'feedbackURI'> = [];
      const text = (data: Hex, field: typeof invalidTextFields[number]) => {
        try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(data.slice(2), 'hex'));
          if (value.includes('\0')) throw new Error(); return value;
        } catch { invalidTextFields.push(field); return null; }
      };
      const raw = { block: { number: mined.blockNumber.toString(), hash: mined.blockHash, timestamp: Number(block.timestamp) },
        transactionHash: mined.transactionHash, transactionIndex: String(mined.transactionIndex), logIndex: String(log.logIndex),
        address: source.reputationRegistry as Hex, topics: log.topics as [Hex, Hex, Hex, Hex], data: log.data };
      return { eventId: feedbackEventId(source, raw), sourceId, raw,
        decoded: { kind: 'NewFeedback', agentId: agentId.toString(), reviewer: clientAddress.toLowerCase() as Hex, feedbackIndex: data[0].toString(),
          value: data[1].toString(), valueDecimals: data[2], indexedTag1: log.topics[3]!, tag1: text(data[3], 'tag1'), tag2: text(data[4], 'tag2'), endpoint: text(data[5], 'endpoint'),
          feedbackURI: text(data[6], 'feedbackURI'), feedbackHash: data[7], invalidTextFields }, insertionSequence: data[0].toString(),
        observedAt: '2026-09-26T00:00:00.000Z', canonicality: 'withdrawn', document: { availability: 'pending', hash,
          byteLength: null, retainedAt: null, job: null }, semantics: 'not-evaluated' };
    };
    const publish = async (value: bigint, uri = '') => {
      const mined = await receipt(client, await writer.writeContract({ address: provenance.domain.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback', args: [0n, value, 0, 'opaque', '', '', uri, hash], chain: null }));
      observation = { blockNumber: mined.blockNumber, blockHash: mined.blockHash }; return makeEvent(mined);
    };
    try {
      await t.test('independently qualified zero needs neither Index nor a selected event', async () => {
        const result = await api.readAcceptedReviewerCoverage({ ...config(), indexes: [
          { origin: 'http://127.0.0.1:1', source }, { origin: 'http://127.0.0.1:2', source }] });
        assert.equal(result.status, 'complete', result.diagnostics.join(','));
        assert.equal(result.pairs[0]!.lastIndex, '0'); assert.deepEqual(result.pairs[0]!.slots, []);
        assert.equal(result.budget.lanes['index-a'].calls + result.budget.lanes['index-b'].calls, 0);
      });
      const old = await publish(-1n), newest = await publish(5n);
      await t.test('an omitted oldest negative is unknown, never a favorable complete subset', async () => {
        rows[0] = [newest]; rows[1] = [newest];
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'unknown'); assert.deepEqual(result.pairs[0]!.missingSlots, ['1']);
      });
      await t.test('partial prefix plus other Index covers both exact slots and a bad document cannot poison B', async () => {
        rows[0] = [old]; rows[1] = [newest]; malformedCursor = true; badDocumentA = true;
        const callsA = documentCallsA, callsB = documentCallsB;
        const work = createRankingReadBudget({ origins: [a.origin, b.origin] });
        try {
          const result = await api.readAcceptedReviewerCoverage(config(), work);
          assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
          assert.deepEqual(result.pairs[0]!.slots.map((s) => s.observation.event!.value), ['-1', '5']);
          assert.equal(result.acquisitions[0]!.status, 'partial');
          assert.equal(result.documents[0]!.availability, 'available');
          assert.deepEqual(Buffer.from(result.documents[0]!.bytes!), document);
          assert.equal(documentCallsA - callsA, 1); assert.equal(documentCallsB - callsB, 1);
          assert.ok(work.snapshot().lanes.shared.calls > 0); work.check();
          const before = work.snapshot().calls, beforeShared = work.snapshot().lanes.shared.calls;
          const controller = new AbortController();
          const client = createPublicClient({ cacheTime: 0, batch: { multicall: false }, transport: http(rpcOrigin,
            { retryCount: 0, batch: false, fetchFn: boundRpcFetch(fetch, { budget: work.requestBudget('shared', 'rpc'), signal: controller.signal }) }) });
          const raw = old.raw, bundleBytes = Buffer.from('{}');
          work.chargeBundle(bundleBytes.length);
          try {
            const historical = await readHistoricalFeedback({ client, domain: provenance.domain,
              eventRef: { blockNumber: raw.block.number, blockHash: raw.block.hash, transactionHash: raw.transactionHash,
                transactionIndex: Number(raw.transactionIndex), logIndex: Number(raw.logIndex), feedbackURI: '' },
              observationBlock: observation.blockNumber, documentBytes: result.documents[0]!.bytes, bundleBytes });
            assert.equal(historical.historical.status, 'not-evaluated', 'opaque bytes do not become City evidence');
            work.check();
            assert.ok(work.snapshot().calls > before); assert.ok(work.snapshot().lanes.shared.calls > beforeShared);
            const beforeFinal = work.snapshot().calls;
            assert.equal((await client.getBlock({ blockNumber: observation.blockNumber })).hash, observation.blockHash);
            assert.equal((await client.getBlock({ blockNumber: observation.blockNumber })).hash, observation.blockHash);
            assert.equal(work.snapshot().calls, beforeFinal + 2, 'final numbered rechecks are fresh, not cached');
            assert.equal(work.snapshot().bundleBytes, 2);
          } finally { controller.abort(); }
        } finally { await work.dispose(); }
      });
      await t.test('all slots on a page survive its malformed next cursor', async () => {
        rows[0] = [old, newest]; rows[1] = []; badDocumentA = false;
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'complete'); assert.equal(result.acquisitions[0]!.status, 'partial');
      });
      await t.test('forged bytes at a real coordinate cannot poison the good complete source', async () => {
        malformedCursor = false;
        const forged = structuredClone(old);
        const values = decodeAbiParameters(parseAbiParameters('uint64,int128,uint8,string,string,string,string,bytes32'), forged.raw.data);
        forged.raw.data = encodeAbiParameters(parseAbiParameters('uint64,int128,uint8,string,string,string,string,bytes32'), [values[0], 99n, ...values.slice(2)] as any);
        if (forged.decoded.kind === 'NewFeedback') forged.decoded.value = '99';
        rows[0] = [forged]; rows[1] = [old, newest];
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'complete'); assert.ok(result.rows.some((r) => r.disposition === 'rejected'));
        assert.deepEqual(result.pairs[0]!.slots.map((s) => s.observation.event!.value), ['-1', '5']);
      });
      await t.test('current revocation retains the immutable slot even with A unavailable', async () => {
        unavailableA = true; rows[1] = [old, newest];
        const mined = await receipt(client, await writer.writeContract({ address: provenance.domain.reputationRegistry,
          abi: reputationRegistryAbi, functionName: 'revokeFeedback', args: [0n, 1n], chain: null }));
        observation = { blockNumber: mined.blockNumber, blockHash: mined.blockHash };
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'complete'); assert.equal(result.pairs[0]!.slots[0]!.observation.revocation, 'revoked');
      });
      await t.test('concurrent identical authentic copies deduplicate instead of becoming contradictory slots', async () => {
        unavailableA = false; rows[0] = [old, newest]; rows[1] = [old, newest];
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'complete', JSON.stringify(result.pairs));
        assert.equal(result.pairs[0]!.slots.length, 2);
      });
      await t.test('a stalled bad origin cannot delay complete good-origin coverage until the batch expires', async () => {
        stalledA = true; rows[1] = [old, newest];
        // The activation compiler is synchronous; bound the network phase by observing a short request ceiling.
        const work = createRankingReadBudget({ origins: [a.origin, b.origin], limits: { requestTimeoutMs: 4000 } });
        const started = performance.now();
        try {
          const result = await api.readAcceptedReviewerCoverage(config(), work);
          assert.equal(result.status, 'complete');
          assert.equal(result.documents[0]!.availability, 'available');
          assert.ok(result.budget.lanes['index-a'].calls <= 2);
          assert.ok(performance.now() - started < 30000);
          assert.ok(performance.now() - firstStallAt < 1500, 'good origin must finish without waiting out redundant bad-origin requests');
        } finally { await work.dispose(); stalledA = false; }
      });
      await t.test('A exhausts its actual streamed HTTP pool while B completes and retained-prefix RPC stays isolated', async () => {
        const forged = [old, newest].map((original, i) => {
          const e = structuredClone(original);
          const parameters = parseAbiParameters('uint64,int128,uint8,bytes,bytes,bytes,bytes,bytes32');
          const d = decodeAbiParameters(parameters, e.raw.data);
          e.raw.data = encodeAbiParameters(parameters, [d[0], BigInt(90 + i), ...d.slice(2)] as any);
          if (e.decoded.kind === 'NewFeedback') e.decoded.value = String(90 + i); return e;
        });
        const future = structuredClone(old); future.raw.block.number = (observation.blockNumber + 1n).toString();
        future.raw.block.hash = `0x${'ef'.repeat(32)}`; future.eventId = feedbackEventId(source, future.raw);
        rows[0] = [...forged, future]; rows[1] = [old, newest]; floodA = true; floodPages = 0;
        const proxy = await rpcProxy(rpcOrigin, async (request) => {
          if (request.method === 'eth_getTransactionReceipt') await new Promise((resolve) => setTimeout(resolve, 75));
        });
        try {
          const result = await api.readAcceptedReviewerCoverage({ ...config(), rpcOrigin: proxy.origin });
          assert.equal(result.status, 'complete', JSON.stringify(result.pairs));
          assert.equal(result.budget.lanes['index-a'].indexBytes, 8388608);
          assert.ok(result.budget.lanes['index-a'].rpcBytes > 0, 'HTTP exhaustion must not erase prefix authentication allowance');
          assert.ok(result.budget.lanes['index-b'].rpcBytes > 0);
          assert.equal(result.documents[0]!.availability, 'available');
          assert.equal(result.acquisitions[0]!.status, 'partial');
        } finally { await proxy.stop(); floodA = false; }
      });
      await t.test('unsafe source coordinates stay raw while B supplies authentic coverage', async () => {
        const unsafe = structuredClone(old); unsafe.raw.logIndex = '18446744073709551615'; unsafe.eventId = feedbackEventId(source, unsafe.raw);
        rows[0] = [unsafe]; rows[1] = [old, newest];
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'complete');
        const row = result.rows.find((r) => r.event.raw.logIndex === '18446744073709551615');
        assert.equal(row?.disposition, 'unsupported');
        assert.ok(row?.diagnostics.includes('unsafe-event-coordinate'));
      });
      await t.test('contradictory canonical slot replies are unknown, not an Index tie break', async () => {
        const changed = structuredClone(newest); changed.raw.data = old.raw.data; changed.decoded = structuredClone(old.decoded);
        rows[0] = [old, changed]; rows[1] = [];
        const proxy = await rpcProxy(rpcOrigin, (request, reply) => {
          if (request.method === 'eth_getTransactionReceipt' && request.params[0] === newest.raw.transactionHash && reply.result) {
            const log = reply.result.logs.find((entry: any) => entry.address.toLowerCase() === source.reputationRegistry);
            log.data = old.raw.data;
          }
        });
        try {
          const result = await api.readAcceptedReviewerCoverage({ ...config(), rpcOrigin: proxy.origin });
          assert.equal(result.status, 'unknown'); assert.ok(result.pairs[0]!.diagnostics.includes('canonical-slot-conflict'));
          assert.deepEqual(result.pairs[0]!.missingSlots, ['2']);
        } finally { await proxy.stop(); }
      });
      await t.test('invalid UTF-8/BOM and a genuine routed reviewer remain opaque authenticated slots', async () => {
        const selector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'giveFeedback',
          args: [0n, 0n, 0, '', '', '', '', hash] }).slice(0, 10);
        const rawCall = `${selector}${encodeAbiParameters(parseAbiParameters('uint256,int128,uint8,bytes,bytes,bytes,bytes,bytes32'),
          [0n, -7n, 0, '0xff', '0xefbbbf61', '0x610062', '0xc080', hash]).slice(2)}` as Hex;
        const rawReceipt = await receipt(client, await writer.sendTransaction({ to: provenance.domain.reputationRegistry, data: rawCall, chain: null }));
        const opaque = await makeEvent(rawReceipt);
        const require = createRequire(import.meta.url);
        const solc = require('solc') as { compile(input: string): string };
        const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Router.sol': {
          content: 'pragma solidity ^0.8.24; contract Router { function forward(address target, bytes calldata data) external { (bool ok,) = target.call(data); require(ok); } }' } },
          settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
        const artifact = compiled.contracts['Router.sol'].Router;
        const deployed = await receipt(client, await wallet.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, chain: null }));
        const router = deployed.contractAddress!;
        const routed = await receipt(client, await writer.writeContract({ address: router, abi: parseAbi(['function forward(address target, bytes data)']),
          functionName: 'forward', args: [provenance.domain.reputationRegistry, rawCall], chain: null }));
        const routedRow = await makeEvent(routed);
        observation = { blockNumber: routed.blockNumber, blockHash: routed.blockHash };
        rows[0] = []; rows[1] = [old, newest, opaque, routedRow];
        const result = await api.readAcceptedReviewerCoverage({ ...config(), reviewers: [reviewer.address, router] });
        assert.equal(result.status, 'complete', JSON.stringify(result.pairs.map((p) => p.diagnostics)));
        assert.equal(result.pairs[0]!.slots[2]!.observation.event!.tag1Bytes, '0xff');
        assert.equal(result.pairs[0]!.slots[2]!.observation.event!.tag2Bytes, '0xefbbbf61');
        assert.equal(result.pairs[1]!.slots[0]!.observation.event!.reviewer, router.toLowerCase());
        assert.equal(result.pairs[0]!.lastIndex, '3'); assert.equal(result.pairs[1]!.lastIndex, '1');
      });
      await t.test('two actual pinned Indexes independently retain bytes and supply counter-complete histories', { timeout: 240000 }, async () => {
        assert.ok(process.env['NANDA_INDEX_CHECKOUT']);
        const provider = await listener((_path, res) => { res.end(document); });
        try {
          const retained = await publish(2n, `${provider.origin}/review`);
          await withOwnedIndexes(process.env['NANDA_INDEX_CHECKOUT']!, { chainId: 31337, registry: identity, genesisHash: source.genesisHash as Hex,
            startBlock: '0', adapter: 'nandacity-0.1', confirmations: 0 }, { A: rpcOrigin, B: rpcOrigin }, async (indexes) => {
            const configured = [indexes.indexes.A.origin, indexes.indexes.B.origin].map((origin) => ({ origin, source })) as
              [{ origin: string; source: FeedbackIndexSource }, { origin: string; source: FeedbackIndexSource }];
            const deadline = performance.now() + 30000;
            for (const index of configured) {
              for (;;) {
                const acquired = await readIndexFeedbackHistory({ ...index, agentId: '0', reviewer: reviewer.address });
                if (acquired.status === 'complete' && acquired.history.some((e) => e.eventId === retained.eventId && e.document.availability === 'retained')) break;
                assert.ok(performance.now() < deadline, 'both real Indexes must retain the literal document');
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
            await provider.stop();
            const result = await api.readAcceptedReviewerCoverage({ ...config(), indexes: configured });
            assert.equal(result.status, 'complete', result.diagnostics.join(','));
            assert.equal(result.pairs[0]!.lastIndex, '4');
            assert.deepEqual(result.pairs[0]!.slots.map((s) => s.observation.event!.value), ['-1', '5', '-7', '2']);
            assert.equal(result.documents[0]!.availability, 'available');
            assert.deepEqual(Buffer.from(result.documents[0]!.bytes!), document);
          }, { feedback: { A: { ...source, documentUrls: [`${provider.origin}/review`] }, B: { ...source, documentUrls: [`${provider.origin}/review`] } } });
        } finally { await provider.stop(); }
      });
      await t.test('whole-batch final observation changes invalidate even independently read zero counters', async () => {
        const selector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getLastIndex', args: [0n, owner.address] }).slice(0, 10);
        let counterRead = false;
        const proxy = await rpcProxy(rpcOrigin, (request, reply) => {
          if (request.method === 'eth_call' && request.params[0].data.startsWith(selector)) counterRead = true;
          if (counterRead && request.method === 'eth_getBlockByNumber' && request.params[0] === `0x${observation.blockNumber.toString(16)}` && reply.result) {
            reply.result.hash = `0x${'cd'.repeat(32)}`;
          }
        });
        try {
          const result = await api.readAcceptedReviewerCoverage({ ...config(), rpcOrigin: proxy.origin, reviewers: [owner.address] });
          assert.equal(result.pairs[0]!.lastIndex, '0'); assert.equal(result.status, 'unknown');
          assert.equal(result.batchBasis, 'changed'); assert.equal(result.pairs[0]!.status, 'unknown');
        } finally { await proxy.stop(); }
      });
      await t.test('unavailable numbered archive data and a total counter of 513 cannot become a truncated sample', async () => {
        const selector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getLastIndex', args: [0n, reviewer.address] }).slice(0, 10);
        let counters = 0;
        const proxy = await rpcProxy(rpcOrigin, (request, reply) => {
          if (request.method === 'eth_call' && request.params[0].data.startsWith(selector)) {
            // Adversarially enlarged replies are negative-bound tests, never positive verifier stand-ins.
            reply.result = encodeAbiParameters(parseAbiParameters('uint64'), [counters++ < 16 ? 32n : counters === 17 ? 1n : 0n]);
          }
        });
        try {
          const result = await api.readAcceptedReviewerCoverage({ ...config(), rpcOrigin: proxy.origin, agentIds: ['0', '1', '2'],
            reviewers: Array.from({ length: 6 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}` as Hex) });
          assert.equal(counters, 18); assert.equal(result.status, 'unknown');
          assert.ok(result.diagnostics.includes('total-counter-over-limit')); assert.equal(result.acquisitions.length, 0);
        } finally { await proxy.stop(); }
        const unavailable = await rpcProxy(rpcOrigin, (request, reply) => {
          if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0') reply.result = null;
        });
        try {
          const result = await api.readAcceptedReviewerCoverage({ ...config(), rpcOrigin: unavailable.origin });
          assert.equal(result.status, 'unknown'); assert.equal(result.activation?.activation, 'unavailable');
        } finally { await unavailable.stop(); }
      });
      await t.test('a real counter of 33 is unknown before any Index acquisition', async () => {
        let last: IndexFeedbackEvent | undefined;
        const current = await client.readContract({ address: provenance.domain.reputationRegistry, abi: reputationRegistryAbi,
          functionName: 'getLastIndex', args: [0n, reviewer.address] });
        for (let n = current; n < 33n; n++) last = await publish(1n);
        assert.ok(last);
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'unknown'); assert.equal(result.pairs[0]!.lastIndex, '33');
        assert.ok(result.pairs[0]!.diagnostics.includes('pair-counter-over-limit')); assert.equal(result.acquisitions.length, 0);
      });
      await t.test('real upgrade away/back invalidates known deployment instead of trusting final implementation text', async () => {
        const adminAbi = parseAbi(['function upgradeToAndCall(address implementation, bytes data) payable']);
        await receipt(client, await wallet.writeContract({ address: provenance.domain.reputationRegistry, abi: adminAbi,
          functionName: 'upgradeToAndCall', args: [provenance.bootstrap.address, '0x'], chain: null }));
        const back = await receipt(client, await wallet.writeContract({ address: provenance.domain.reputationRegistry, abi: adminAbi,
          functionName: 'upgradeToAndCall', args: [provenance.implementation.address, '0x'], chain: null }));
        observation = { blockNumber: back.blockNumber, blockHash: back.blockHash };
        const result = await api.readAcceptedReviewerCoverage(config());
        assert.equal(result.status, 'unknown'); assert.equal(result.activation?.activation, 'mismatched');
        assert.ok(result.activation?.diagnostics.includes('unexpected-upgrade')); assert.equal(result.acquisitions.length, 0);
      });
    } finally { await a.stop(); await b.stop(); }
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});
