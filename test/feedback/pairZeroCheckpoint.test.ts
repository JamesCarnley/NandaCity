import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { checkpointFixture, SLOT, CALLS, I, R, PROXY, ZERO, ONE, TWO, TOPICS, h, log, publication,
  response, type Exchange } from './fixtures/pairZeroCheckpoint.js';
import { readFreshPairZeroCheckpoint as read, type FreshPairZeroInput } from '../../src/feedback/pairZeroCheckpoint.js';

const exchanges = (i: FreshPairZeroInput) => { assert.equal(i.source.kind, 'literal-fixture'); return i.source.exchanges as Exchange[]; };
const parsed = (e: Exchange) => JSON.parse(new TextDecoder().decode(e.responseUtf8)).result;
function change(i: FreshPairZeroInput, match: (e: Exchange) => boolean, update: (r: any) => unknown, last = false) {
  const es = exchanges(i), candidates = es.filter(match), e = last ? candidates.at(-1) : candidates[0]; assert.ok(e, 'fixture exchange exists');
  es[es.indexOf(e)] = { ...e, responseUtf8: response(e.requestId, update(parsed(e))) };
}
const method = (m: string) => (e: Exchange) => e.method === m;
const callAt = (data: string, number: string) => (e: Exchange) => e.method === 'eth_call' && (e.params[0] as any).data === data && e.params[1] === number;
const publications = (e: Exchange) => e.method === 'eth_getLogs' && (e.params[0] as any).topics[0] === TOPICS.feedback;
async function rejectsFinding(i: FreshPairZeroInput, status?: string) {
  const r = await read(i); assert.notEqual(r.finding.status, 'matched');
  if (status) assert.equal(r.finding.status, status, JSON.stringify(r.finding.diagnostics));
  assert.equal(Object.hasOwn(r.finding, 'qualifiedPairs'), false); return r;
}

test('derives the independently calculated padded nested-map slot, not packed or reversed keys', async () => {
  const module = await import('../../src/feedback/pairZeroCheckpoint.js').catch(() => undefined);
  assert.ok(module, 'checkpoint reader must exist');
  assert.equal(module.deriveLastIndexSlot('7', '0x1111111111111111111111111111111111111111'), SLOT);
});

test('profile publication after mint is authenticated at its separate fixed basis', async () => {
  const result = await read(checkpointFixture({ registration: 99 }));
  assert.equal(result.finding.status, 'matched', JSON.stringify(result.finding.diagnostics));
  assert.equal(result.finding.registrations[0]?.blockNumber, '99');
  assert.equal(result.finding.registrations[0]?.profileBasis.blockNumber, '100');
});

for (const [label, mutate] of [
  ['alternate compiler metadata one', (s: string) => s.replace('d25633e5', 'd35633e5')],
  ['alternate compiler metadata two', (s: string) => s.replace('d25633e5', 'd45633e5')],
  ['jump destination', (s: string) => s.slice(0, 2 + 67 * 2) + '4d' + s.slice(2 + 68 * 2)],
  ['slot immediate', (s: string) => s.replace('360894a1', '370894a1')],
  ['delegatecall opcode', (s: string) => s.replace('915af43d', '915af13d')],
] as const) test(`rejects proxy ${label} mutation despite its otherwise identical bytes`, async () => {
  const input = checkpointFixture(); change(input, method('eth_getCode'), () => mutate(PROXY));
  await rejectsFinding(input, 'unsupported');
});

for (const [name, mutate] of [
  ['publication inside C', (r: any[]) => [{ ...r[0], blockNumber: '0x64', blockHash: h(100) }, r[1]]],
  ['duplicate slot 1', (r: any[]) => [r[0], { ...r[1], data: r[0].data }]],
  ['missing slot 2', (r: any[]) => [r[0]]],
  ['slot 3 with N=2', (r: any[]) => [r[0], publication(3)]],
  ['unnamed reviewer', (r: any[]) => [{ ...r[0], topics: [r[0].topics[0], r[0].topics[1], `0x${'22'.repeat(32)}`, r[0].topics[3]] }, r[1]]],
] as const) test(`does not qualify ${name}`, async () => {
  const i = checkpointFixture(); change(i, publications, mutate); await rejectsFinding(i, 'mismatched');
});

test('getter/raw nonzero at C is unsupported; disagreement and high dirty bits mismatch', async () => {
  await rejectsFinding(checkpointFixture({ zero: 1 }), 'unsupported');
  for (const raw of [ONE, `0x01${ZERO.slice(4)}`]) {
    const i = checkpointFixture(); change(i, e => e.method === 'eth_getStorageAt' && e.params[1] === SLOT && e.params[2] === '0x64', () => raw);
    await rejectsFinding(i, 'mismatched');
  }
  const i = checkpointFixture(); change(i, callAt(CALLS.last, '0x66'), () => ONE);
  change(i, e => e.method === 'eth_getStorageAt' && e.params[1] === SLOT && e.params[2] === '0x66', () => ONE);
  await rejectsFinding(i, 'mismatched');
});

for (const registry of [I, R]) for (const topic of [TOPICS.upgraded, TOPICS.initialized]) {
  test(`rejects ${topic === TOPICS.upgraded ? 'away/back upgrades' : 'standalone initialization'} on ${registry === I ? 'Identity' : 'Reputation'}`, async () => {
    const i = checkpointFixture(); change(i, e => e.method === 'eth_getLogs' && (e.params[0] as any).address === registry, () =>
      [log(registry === I ? 100 : 101, 800, 0, 0, registry, [topic], TWO), log(registry === I ? 100 : 101, 800, 0, 1, registry, [topic], TWO)]);
    await rejectsFinding(i, 'unsupported');
  });
}

test('empty scope and duplicate pairs cannot claim coverage or inherit another reviewer qualification', async () => {
  for (const pairs of [[], [{ agentId: '7', reviewer: I }, { agentId: '7', reviewer: I }], [{ agentId: '8', reviewer: I }]]) {
    await rejectsFinding({ ...checkpointFixture(), pairs: pairs as FreshPairZeroInput['pairs'] }, 'mismatched');
  }
});

test('zero at both endpoints qualifies only the explicit empty post-C pair; no legacy response/client reads', async () => {
  const r = await read(checkpointFixture({ count: 0 })); assert.equal(r.finding.status, 'matched', JSON.stringify(r.finding.diagnostics));
  assert.ok(r.finding.status === 'matched'); assert.deepEqual(r.finding.qualifiedPairs[0]?.coveredIndices, []);
  assert.equal(r.finding.qualifiedPairs.length, 1);
});

test('4096 inclusive blocks fit; 4097 is unavailable before any acquisition', async () => {
  const accepted = await read(checkpointFixture({ count: 0, observation: 4194 }));
  assert.equal(accepted.finding.status, 'matched', JSON.stringify(accepted.finding.diagnostics));
  const rejected = await rejectsFinding(checkpointFixture({ count: 0, observation: 4195 }), 'unavailable');
  assert.equal(rejected.ledger.entries.length, 0);
});

for (const registry of [I, R]) test(`a missing middle ${registry === I ? 'Identity' : 'Reputation'} log chunk remains unavailable`, async () => {
  const i = checkpointFixture({ count: 0, observation: 250 });
  change(i, e => e.method === 'eth_getLogs' && (e.params[0] as any).address === registry && (e.params[0] as any).fromBlock === (registry === I ? '0xa4' : '0xa5'), () => null);
  await rejectsFinding(i, 'unavailable');
});

for (const [name, match, update, last] of [
  ['C reorg', (e: Exchange) => e.method === 'eth_getBlockByNumber' && e.params[0] === '0x64', (r: any) => ({ ...r, hash: h(999) }), true],
  ['publication reorg', (e: Exchange) => e.method === 'eth_getBlockByNumber' && e.params[0] === '0x65', (r: any) => ({ ...r, hash: h(999) }), true],
  ['genesis reorg', (e: Exchange) => e.method === 'eth_getBlockByNumber' && e.params[0] === '0x0', (r: any) => ({ ...r, hash: h(999) }), true],
  ['unavailable historical storage', method('eth_getStorageAt'), () => null, false],
  ['missing receipt', method('eth_getTransactionReceipt'), () => null, false],
  ['chain mismatch', method('eth_chainId'), () => '0x1', false],
  ['genesis mismatch', (e: Exchange) => e.method === 'eth_getBlockByNumber' && e.params[0] === '0x0', (r: any) => ({ ...r, hash: h(999) }), false],
  ['removed publication', publications, (r: any[]) => [{ ...r[0], removed: true }, r[1]], false],
  ['forged receipt index', method('eth_getTransactionReceipt'), (r: any) => ({ ...r, transactionIndex: '0x1' }), false],
  ['unselected receipt log coordinate', method('eth_getTransactionReceipt'), (r: any) => ({ ...r, logs: [...r.logs, { ...r.logs[1], logIndex: '0x2', transactionHash: h(999) }] }), false],
  ['transaction coordinate', method('eth_getTransactionByHash'), (r: any) => ({ ...r, blockHash: h(999) }), false],
  ['registry linkage', callAt(CALLS.link, '0x63'), () => `0x${'00'.repeat(12)}${R.slice(2)}`, false],
] as const) test(`no qualified pairs survive ${name}`, async () => {
  const i = checkpointFixture(); change(i, match, update, last); await rejectsFinding(i);
});

test('counter, call, response-wire, metadata, ledger and log caps fail closed', async () => {
  for (const limits of [{ maxPairCounter: 1 }, { maxTotalCounter: 1 }, { maxRpcCalls: 1 }, { maxTotalResponseBytes: 100 },
    { maxResponseBytes: 100 }, { maxRequestMetadataBytes: 10 }, { maxTotalRequestMetadataBytes: 100 },
    { maxLedgerBytes: 200 }, { maxReceiptLogs: 1 }, { maxLogs: 1 }, { maxReceiptBytes: 32 }, { maxCodeBytes: 64 }]) {
    await rejectsFinding({ ...checkpointFixture(), limits }, 'unavailable');
  }
});

test('fixture envelope errors, missing raw results and missing exchanges cannot invent raw-result hashes', async () => {
  for (const envelope of [{ jsonrpc: '2.0', id: 99, result: '0xaa36a7' }, { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no archive' } }]) {
    const i = checkpointFixture(); exchanges(i)[0] = { ...exchanges(i)[0]!, responseUtf8: new TextEncoder().encode(JSON.stringify(envelope)) };
    const r = await rejectsFinding(i, 'unavailable'); assert.equal(r.finding.rawEvidenceRefs.length, 0);
    assert.ok(['invalid-response', 'rpc-error'].includes(r.ledger.entries[0]!.disposition));
  }
  const i = checkpointFixture(); exchanges(i).splice(0);
  const r = await rejectsFinding(i, 'unavailable'); assert.equal(r.ledger.entries[0]?.disposition, 'transport-failed');
  assert.equal(r.ledger.entries[0]?.responseUtf8, undefined);
});

test('mutable fixture bytes, pair/domain pins and profile bytes are snapshotted before the first await', async () => {
  const i = checkpointFixture(); const pending = read(i);
  i.domain.chainId = 1; i.pins.identity.fullRuntimeHash = h(999); i.pairs[0]!.agentId = '8';
  i.registrations[0]!.cardBytes.fill(0); for (const e of exchanges(i)) e.responseUtf8.fill(0);
  const r = await pending; assert.equal(r.finding.status, 'matched', JSON.stringify(r.finding.diagnostics));
  assert.equal(r.finding.domain.chainId, 11155111);
});

test('parent leases charge every physical request once, compose bytes and close on parent failure', async () => {
  let opens = 0, charges = 0, closes = 0, bytes = 0;
  const i = checkpointFixture(); i.parentBudget = { async open() {
    opens++; let charged = false; return { signal: new AbortController().signal,
      check() { if (!charged) { charges++; charged = true; } }, bytes(n) { bytes += n; }, close() { closes++; } };
  } };
  const r = await read(i); assert.equal(r.finding.status, 'matched'); assert.equal(opens, r.ledger.entries.length);
  assert.equal(charges, opens); assert.equal(closes, opens);
  assert.equal(bytes, r.ledger.entries.reduce((n, e) => n + (e.responseUtf8?.length ?? 0), 0));
  const j = checkpointFixture(); let closed = 0;
  j.parentBudget = { async open() { return { signal: new AbortController().signal, check() {},
    bytes() { throw new Error('parent-byte-cap'); }, close() { closed++; } }; } };
  const rejected = await rejectsFinding(j, 'unavailable'); assert.equal(closed, 1);
  assert.ok(rejected.ledger.entries[0]?.responseUtf8, 'a dispatched fixture response remains in the failure ledger when a parent byte cap rejects it');
  assert.equal(rejected.finding.rawEvidenceRefs.length, 0);
});

test('pre-aborted and between-acquisition cancellation do not continue or retry', async () => {
  const controller = new AbortController(); controller.abort();
  const r = await rejectsFinding({ ...checkpointFixture(), signal: controller.signal }, 'unavailable'); assert.equal(r.ledger.entries.length, 0);
  const next = new AbortController(); let opened = 0, closed = 0;
  const i = checkpointFixture(); i.signal = next.signal;
  i.parentBudget = { async open() { opened++; return { signal: next.signal, check() { next.abort(); }, bytes() {}, close() { closed++; } }; } };
  await rejectsFinding(i, 'unavailable'); assert.equal(opened, 1); assert.equal(closed, 1);
});

async function withHttp(run: (url: string, seen: unknown[]) => Promise<void>, handler?: (res: import('node:http').ServerResponse, body: any) => void) {
  const es = exchanges(checkpointFixture()), seen: unknown[] = [];
  const remaining = [...es];
  const unexpected: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { unexpected.push('malformed JSON-RPC request'); res.writeHead(400).end(); return; }
    seen.push(body);
    if (handler) { handler(res, body); return; }
    const matchedAt = remaining.findIndex((exchange) => exchange.method === body.method && isDeepStrictEqual(exchange.params, body.params ?? []));
    const expected = matchedAt < 0 ? undefined : remaining.splice(matchedAt, 1)[0];
    res.setHeader('content-type', 'application/json');
    if (!expected) {
      unexpected.push(JSON.stringify([body.method, body.params ?? []]));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'unexpected test RPC request' } }));
      return;
    }
    res.end(response(body.id, parsed(expected)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const bound = server.address(); assert.ok(bound && typeof bound !== 'string');
  let failure: unknown;
  try { await run(`http://127.0.0.1:${bound.port}/private-provider-key`, seen); }
  catch (error) { failure = error; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual(unexpected, [], 'every HTTP request must match an exact method and params fixture');
  if (failure) throw failure;
}

test('owned HTTP yields the same qualified history, complete recheck ledger and no source configuration', async () => {
  let charged = 0, calls = 0, closed = 0;
  await withHttp(async (url, seen) => {
    const r = await read({ ...checkpointFixture(), source: { kind: 'bounded-http', url }, parentBudget: { async open() {
      let dispatched = false;
      return { signal: new AbortController().signal, check() { if (!dispatched) { dispatched = true; calls++; } },
        bytes(n) { charged += n; }, close() { closed++; } };
    } } });
    assert.equal(r.finding.status, 'matched', JSON.stringify(r.finding.diagnostics)); assert.equal(r.ledger.entries.length, seen.length);
    assert.equal(seen.length, exchanges(checkpointFixture()).length, 'every exact fixture request is consumed once');
    assert.equal(r.ledger.complete, true); assert.equal(r.finding.rawEvidenceRefs.length, seen.length);
    assert.equal(charged, r.ledger.entries.reduce((n, e) => n + (e.responseUtf8?.length ?? 0), 0), 'each successful physical wire byte is charged exactly once');
    assert.equal(calls, seen.length); assert.equal(closed, seen.length);
    assert.ok(!JSON.stringify(r).includes('private-provider-key'));
    const seenById = new Map(seen.map((body: any) => [body.id, body]));
    assert.equal(seenById.size, seen.length, 'every physical request has a distinct RPC ID');
    const ledgerIds = new Set(r.ledger.entries.map((entry) => entry.requestId));
    assert.equal(ledgerIds.size, r.ledger.entries.length, 'every ledger entry has a distinct RPC ID');
    assert.deepEqual(ledgerIds, new Set(seenById.keys()), 'ledger and physical requests cover the same exact RPC IDs');
    const expectedRefs: typeof r.finding.rawEvidenceRefs = [];
    for (const entry of r.ledger.entries) {
      const sent = seenById.get(entry.requestId) as any;
      assert.ok(sent, 'ledger RPC ID must correspond to one physical request');
      assert.equal(entry.method, sent.method); assert.deepEqual(entry.params, sent.params ?? []);
      const raw = JSON.parse(new TextDecoder().decode(entry.responseUtf8)); assert.equal(raw.id, entry.requestId);
      assert.equal(entry.disposition, 'result');
      expectedRefs.push({ method: entry.method,
        requestDigest: keccak256(stringToHex(JSON.stringify([entry.method, entry.params]))),
        responseDigest: keccak256(stringToHex(JSON.stringify(raw.result))) });
    }
    const order = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    assert.deepEqual([...r.finding.rawEvidenceRefs].sort(order), [...expectedRefs].sort(order),
      'every exact request/result digest appears once, regardless of concurrent completion order');
  });
});

test('owned HTTP accepts a tokenURI request arriving before its parallel ownerOf request', { timeout: 15000 }, async () => {
  const originalFetch = globalThis.fetch;
  const uriAnswered = Promise.withResolvers<void>();
  const releaseTimer = setTimeout(() => uriAnswered.resolve(), 3000);
  let ownerHeld = false, uriFirst = false;
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string; params?: [{ data?: string }] } : null;
    const data = body?.method === 'eth_call' ? body.params?.[0]?.data : null;
    if (data === CALLS.ownerOf) { ownerHeld = true; await uriAnswered.promise; return originalFetch(input, init); }
    if (data === CALLS.uri) { try { const response = await originalFetch(input, init); uriFirst = true; return response; }
      finally { uriAnswered.resolve(); } }
    return originalFetch(input, init);
  };
  try {
    await withHttp(async (url, seen) => {
      const result = await read({ ...checkpointFixture(), source: { kind: 'bounded-http', url } });
      assert.equal(ownerHeld, true); assert.equal(uriFirst, true);
      const callPosition = (data: string) => seen.findIndex((body: any) => body.method === 'eth_call' && body.params?.[0]?.data === data);
      assert.ok(callPosition(CALLS.uri) >= 0 && callPosition(CALLS.uri) < callPosition(CALLS.ownerOf),
        'the real HTTP server must receive tokenURI before ownerOf');
      assert.equal(result.finding.status, 'matched', JSON.stringify(result.finding.diagnostics));
      assert.equal(result.ledger.complete, true);
      assert.equal(result.ledger.entries.length, seen.length);
      assert.equal(seen.length, exchanges(checkpointFixture()).length, 'every exact fixture request is consumed once');
    });
  } finally { clearTimeout(releaseTimer); uriAnswered.resolve(); globalThis.fetch = originalFetch; }
});

test('HTTP ledger exhaustion stops dispatch without an oversized or successful incomplete ledger', async () => {
  await withHttp(async (url, seen) => {
    const r = await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url }, limits: { maxLedgerBytes: 200 } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(r.ledger.complete, false);
    assert.ok(Buffer.byteLength(JSON.stringify(r.ledger)) <= 200);
    assert.equal(r.finding.rawEvidenceRefs.length, 0);
  });
});

test('a partial transport failure retains its bytes and transport-failed disposition, not an invented JSON result', async () => {
  await withHttp(async (url, seen) => {
    const r = await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(r.ledger.entries[0]?.disposition, 'transport-failed');
    assert.ok(r.ledger.entries[0]?.responseUtf8?.byteLength); assert.equal(r.finding.rawEvidenceRefs.length, 0);
  }, res => { res.write('{"jsonrpc":"2.0",'); setTimeout(() => res.destroy(), 10); });
});

test('complete HTTP RPC errors retain rpc-error; malformed/absent envelopes retain invalid-response', async () => {
  for (const mode of ['rpc-error', 'absent', 'wrong-id', 'malformed']) await withHttp(async (url, seen) => {
    const r = await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(r.finding.rawEvidenceRefs.length, 0);
    assert.equal(r.ledger.entries[0]?.disposition, mode === 'rpc-error' ? 'rpc-error' : 'invalid-response');
    assert.ok(r.ledger.entries[0]?.responseUtf8);
  }, (res, body) => res.end(mode === 'malformed' ? '{bad' : JSON.stringify(mode === 'rpc-error' ?
    { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'synthetic unavailable state' } } :
    mode === 'wrong-id' ? { jsonrpc: '2.0', id: body.id + 1, result: '0xaa36a7' } : { jsonrpc: '2.0', id: body.id })));
});

test('HTTP cancellation aborts and drains the owned body before the parent lease closes', async () => {
  const controller = new AbortController(); let parentClosed = 0, serverClosed = false;
  const closed = Promise.withResolvers<void>();
  await withHttp(async (url, seen) => {
    const r = await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url }, signal: controller.signal,
      parentBudget: { async open() { return { signal: controller.signal, check() {}, bytes() {}, close() { parentClosed++; } }; } } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(parentClosed, 1); assert.equal(r.ledger.entries[0]?.disposition, 'aborted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned socket not closed')), 500); })]); }
    finally { clearTimeout(timer); }
  }, res => { res.on('close', () => { serverClosed = true; closed.resolve(); }); res.write('{"jsonrpc":'); setTimeout(() => controller.abort(), 10); });
  assert.equal(serverClosed, true);
});

test('per-call and total deadlines stop a stalled HTTP body, close leases, and never retry', { timeout: 15000 }, async () => {
  for (const limits of [{ rpcTimeoutMs: 1000 }, { totalTimeoutMs: 1000 }]) {
    let closed = 0, bodyStarted = false;
    await withHttp(async (url, seen) => {
      const started = performance.now(); const r = await rejectsFinding({ ...checkpointFixture(), limits, source: { kind: 'bounded-http', url },
        parentBudget: { async open() { return { signal: new AbortController().signal, check() {}, bytes() {}, close() { closed++; } }; } } }, 'unavailable');
      assert.equal(seen.length, 1, 'one physical RPC must reach the server before the deadline');
      assert.equal(bodyStarted, true, 'the server must begin the deliberately stalled response');
      assert.equal(closed, 1); assert.ok(performance.now() - started < 2500, 'the deadline must beat the five-second HTTP fallback');
      assert.equal(r.ledger.entries.length, 1, 'the stalled RPC must be recorded once without retry');
      assert.equal(r.ledger.entries[0]?.disposition, 'aborted');
    }, res => { res.write('{"jsonrpc":'); bodyStarted = true; });
  }
});

test('the HTTP transport timeout cannot return before the bounded fetch closes its parent lease', async () => {
  let closed = 0;
  await withHttp(async (url, seen) => {
    await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url },
      parentBudget: { async open() { return { signal: new AbortController().signal, check() {}, bytes() {}, close() { closed++; } }; } } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(closed, 1, 'owned body must drain and close its parent lease before returning');
  }, res => res.write('{"jsonrpc":'));
});

test('source discriminant is snapshotted with its literal response bytes', async () => {
  const i = checkpointFixture(), pending = read(i);
  Object.assign(i.source, { kind: 'bounded-http', url: 'http://unreachable.invalid' });
  const r = await pending; assert.equal(r.finding.status, 'matched', JSON.stringify(r.finding.diagnostics));
  assert.equal(r.finding.rawEvidenceRefs.length, r.ledger.entries.length);
});

test('a log budget includes topics, not just the data payload', async () => {
  await rejectsFinding({ ...checkpointFixture(), limits: { maxLogBytes: 400 } }, 'unavailable');
});

test('two different transactions cannot authenticate the same numbered transaction position', async () => {
  const i = checkpointFixture();
  change(i, publications, (logs: any[]) => [logs[0], { ...logs[1], transactionIndex: '0x0' }]);
  change(i, e => e.method === 'eth_getTransactionByHash' && e.params[0] === h(202), r => ({ ...r, transactionIndex: '0x0' }));
  change(i, e => e.method === 'eth_getTransactionReceipt' && e.params[0] === h(202), r => ({ ...r, transactionIndex: '0x0', logs: r.logs.map((l: any) => ({ ...l, transactionIndex: '0x0' })) }));
  await rejectsFinding(i, 'mismatched');
});

test('HTTP partial oversized JSON is charged before parsing, drained, and never retried', async () => {
  let charged = 0, closed = 0;
  const firstCharged = Promise.withResolvers<void>();
  await withHttp(async (url, seen) => {
    const i = checkpointFixture(); i.source = { kind: 'bounded-http', url }; i.limits = { maxResponseBytes: 128 };
    i.parentBudget = { async open() { return { signal: new AbortController().signal, check() {},
      bytes(n) { charged += n; firstCharged.resolve(); }, close() { closed++; } }; } };
    const r = await rejectsFinding(i, 'unavailable'); assert.equal(seen.length, 1); assert.equal(closed, 1);
    assert.equal(charged, 320, 'the 64-byte prefix and crossing 256-byte chunk must both charge the parent exactly once');
    assert.equal(r.ledger.entries[0]?.responseUtf8?.length, 64);
    assert.equal(r.ledger.complete, false, 'omitted acquired bytes make retention incomplete');
    assert.ok(r.ledger.entries[0]); assert.notEqual(r.ledger.entries[0]?.disposition, 'result');
  }, res => { res.setHeader('content-type', 'application/json'); res.write(' '.repeat(64));
    void firstCharged.promise.then(() => res.end(' '.repeat(256))); });
});

for (const [label, limits, parentCap, retained] of [
  ['first oversized response chunk', { maxResponseBytes: 128 }, undefined, 0],
  ['first aggregate-crossing chunk', { maxTotalResponseBytes: 128 }, undefined, 0],
  ['ledger rejection before capture', { maxLedgerBytes: 200 }, undefined, 0],
  ['parent cap with locally retainable bytes', {}, 128, 256],
  ['simultaneous parent and local cap crossing', { maxResponseBytes: 128 }, 128, 0],
] as const) test(`I1 accounts acquired wire exactly once for ${label}`, async () => {
  let charged = 0, closed = 0, calls = 0;
  await withHttp(async (url, seen) => {
    const r = await rejectsFinding({ ...checkpointFixture(), source: { kind: 'bounded-http', url }, limits,
      parentBudget: { async open() {
        let dispatched = false;
        return { signal: new AbortController().signal, check() { if (!dispatched) { dispatched = true; calls++; } },
          bytes(n) { charged += n; if (parentCap !== undefined && charged > parentCap) throw new Error('parent-byte-cap'); },
          close() { closed++; } };
      } } }, 'unavailable');
    assert.equal(seen.length, 1); assert.equal(calls, 1); assert.equal(closed, 1);
    assert.equal(charged, 256, 'the acquired crossing chunk must reach the parent even when local accounting or capture rejects it');
    assert.equal(r.ledger.entries[0]?.responseUtf8?.length ?? 0, retained);
    assert.equal(r.ledger.complete, retained === 256, 'retention completeness must describe all acquired bytes');
    assert.notEqual(r.ledger.entries[0]?.disposition, 'result');
    assert.equal(r.finding.rawEvidenceRefs.length, 0);
    if ('maxLedgerBytes' in limits) assert.ok(Buffer.byteLength(JSON.stringify(r.ledger)) <= limits.maxLedgerBytes!);
  }, res => res.end(' '.repeat(256)));
});

test('qualifies both literal publications including revoked/non-City/missing-document slots and reconstructible private wire ledger', async () => {
  const module = await import('../../src/feedback/pairZeroCheckpoint.js').catch(() => undefined);
  assert.ok(module, 'checkpoint reader must exist');
  const input = checkpointFixture();
  const { finding, ledger } = await module.readFreshPairZeroCheckpoint(input);
  assert.equal(finding.status, 'matched', JSON.stringify(finding.diagnostics));
  assert.equal(finding.proxyFullBuildMatch, false);
  assert.equal(finding.qualification, 'rpc-derived-not-state-proof');
  assert.ok(finding.status === 'matched');
  assert.deepEqual(finding.qualifiedPairs.map(p => ({ slot: p.zeroSlot, zero: p.zeroValue, last: p.lastIndex,
    covered: p.coveredIndices, revoked: p.slots.map(s => s.revocation) })),
  [{ slot: SLOT, zero: '0', last: '2', covered: ['1', '2'], revoked: ['active', 'revoked'] }]);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.entries.length, input.source.kind === 'literal-fixture' ? input.source.exchanges.length : 0);
  assert.deepEqual(finding.rawEvidenceRefs, ledger.entries.map(e => ({ method: e.method,
    requestDigest: keccak256(stringToHex(JSON.stringify([e.method, e.params]))),
    responseDigest: keccak256(stringToHex(JSON.stringify(JSON.parse(new TextDecoder().decode(e.responseUtf8)).result))) })));
  assert.doesNotThrow(() => JSON.stringify(finding));
  assert.ok(!JSON.stringify(finding).includes('cardBytes'));
});
