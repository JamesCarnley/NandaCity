import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { boundRpcFetch } from '../../src/identity/rpcTransport.js';
import { readIndexFeedbackDocument } from '../../src/feedback/indexClient.js';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { readRegistryFeedbackObservation } from '../../src/feedback/registryObservation.js';

const origins = ['http://127.0.0.1:31001', 'http://127.0.0.1:31002'] as const;
async function budget(options: Record<string, unknown> = {}) {
  const api = await import('../../src/reputation/readBudget.js').catch(() => undefined);
  assert.ok(api, 'shared ranking ledger must exist');
  return api.createRankingReadBudget({ origins, ...options });
}

test('one ledger enforces literal total and reserved call boundaries without borrowing', async () => {
  const b = await budget();
  try {
    for (const [lane, count] of [['shared', 4096], ['index-a', 2048], ['index-b', 2048]] as const) {
      for (let i = 0; i < count; i++) { const lease = await b.requestBudget(lane, 'rpc').open(); lease.check(); lease.close(); }
    }
    assert.equal(b.snapshot().calls, 8192);
    assert.equal(b.snapshot().inFlight, 0);
    for (const lane of ['index-a', 'index-b', 'shared'] as const) await assert.rejects(b.requestBudget(lane, 'rpc').open(), /call/);
  } finally { await b.dispose(); }
});

test('byte/history reservations stop A without closing B or A retained-prefix RPC', async () => {
  const b = await budget();
  try {
    const a = await b.requestBudget('index-a', 'index').open();
    a.check();
    a.bytes(8 * 1024 * 1024); assert.throws(() => a.bytes(1), /byte/); a.close();
    const ar = await b.requestBudget('index-a', 'rpc').open(); ar.bytes(4 * 1024 * 1024); ar.close();
    const br = await b.requestBudget('index-b', 'rpc').open(); br.bytes(4 * 1024 * 1024); br.close();
    const bi = await b.requestBudget('index-b', 'index').open(); bi.bytes(8 * 1024 * 1024); bi.close();
    b.chargeBundle(8 * 1024 * 1024);
    assert.equal(b.snapshot().bytes, 32 * 1024 * 1024);
    assert.throws(() => b.chargeBundle(1), /byte/);
  } finally { await b.dispose(); }
  const pages = await budget();
  try {
    for (let pair = 0; pair < 12; pair++) for (let page = 0; page < 8; page++) pages.chargeHistory('index-a', String(pair), { pages: 1 });
    assert.throws(() => pages.chargeHistory('index-a', '12', { pages: 1 }), /page/);
    pages.chargeHistory('index-b', '0', { pages: 1, rows: 100 });
    (await pages.requestBudget('index-a', 'rpc').open()).close();
    pages.check();
  } finally { await pages.dispose(); }
});

test('one origin cannot occupy both permits and canceled queued work does not spend a call', async () => {
  const b = await budget();
  const a = await b.requestBudget('index-a', 'index').open();
  let other: Awaited<ReturnType<ReturnType<typeof b.requestBudget>['open']>> | undefined;
  try {
    a.check();
    const canceled = new AbortController();
    const queued = b.requestBudget('index-a', 'rpc').open(canceled.signal);
    const rejected = assert.rejects(queued, /cancel/);
    other = await b.requestBudget('index-b', 'rpc').open();
    other.check();
    assert.equal(b.snapshot().inFlight, 2); assert.equal(b.snapshot().calls, 2);
    canceled.abort(); await rejected;
    assert.equal(getEventListeners(canceled.signal, 'abort').length, 0);
    other.close(); a.close();
  } finally { a.close(); other?.close(); await b.dispose(); }
});

test('RPC lease charges actual streamed error bytes and physically cancels stalled bodies', async () => {
  const api = await import('../../src/reputation/readBudget.js').catch(() => undefined);
  assert.ok(api, 'shared ranking ledger must exist');
  let closed!: () => void;
  const close = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/error') { res.statusCode = 500; res.end('error'); }
    else { res.on('close', closed); res.write('abc'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const b = await budget({ limits: { requestTimeoutMs: 100 } });
  try {
    const f = (boundRpcFetch as any)(fetch, { budget: b.requestBudget('index-a', 'rpc') });
    assert.equal((await f(`${origin}/error`)).status, 500);
    assert.equal(b.snapshot().bytes, 5);
    await assert.rejects(f(`${origin}/stall`), /deadline|abort|timeout/i);
    await close;
    assert.equal(b.snapshot().calls, 2); assert.equal(b.snapshot().bytes, 8);
    assert.equal(b.snapshot().inFlight, 0);
  } finally { await b.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('per-pair pages, origin rows and input bounds fail at their literal next charge', async () => {
  const b = await budget();
  try {
    b.chargeHistory('index-a', '0', { pages: 8, rows: 1024 });
    assert.throws(() => b.chargeHistory('index-a', '0', { pages: 1 }), /page/);
    assert.throws(() => b.chargeHistory('index-a', '1', { rows: 1 }), /row/);
    b.chargeHistory('index-b', '0', { rows: 1024 });
    assert.equal(b.snapshot().rows, 2048);
    assert.throws(() => b.chargeHistory('index-b', '1', { rows: 1 }), /row/);
    for (const invalid of [-1, Infinity, 0.5]) assert.throws(() => b.chargeBundle(invalid), /invalid/);
    assert.throws(() => b.requestBudget('shared', 'index'), /invalid/);
  } finally { await b.dispose(); }
});

test('global cancellation drains queued work and a late synchronous result cannot renew the deadline', async () => {
  const input = new AbortController(), b = await budget({ signal: input.signal, limits: { totalTimeoutMs: 30 } });
  const a = await b.requestBudget('index-a', 'rpc').open();
  const queued = assert.rejects(b.requestBudget('index-a', 'rpc').open(), /cancel|deadline/);
  const until = performance.now() + 40; while (performance.now() < until) { /* deliberately block the timer */ }
  assert.throws(() => a.check(), /deadline/); a.close(); await queued;
  await b.dispose();
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
});

test('canceling an admitted lease before transport dispatch spends no physical call', async () => {
  const controller = new AbortController(), b = await budget();
  try {
    const lease = await b.requestBudget('index-a', 'rpc').open(controller.signal);
    controller.abort(); assert.throws(() => lease.check(), /cancel/); lease.close();
    assert.equal(b.snapshot().calls, 0);
  } finally { await b.dispose(); }
});

test('actual HTTP and RPC share two physical permits and one combined permit per origin', async () => {
  let active = 0, maximum = 0;
  const laneActive = { a: 0, b: 0 }, laneMaximum = { a: 0, b: 0 };
  const payload = Buffer.from('opaque'), hash = keccak256(payload);
  const servers = (['a', 'b'] as const).map((lane) => createServer((_req, res) => {
    maximum = Math.max(maximum, ++active); laneMaximum[lane] = Math.max(laneMaximum[lane], ++laneActive[lane]);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active--; laneActive[lane]--; } };
    res.on('close', finish);
    const timer = setTimeout(() => { finish(); res.end(payload); }, 30); res.on('close', () => clearTimeout(timer));
  }));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))));
  const origins = servers.map((server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`) as [string, string];
  const b = await budget({ origins });
  try {
    const aRpc = boundRpcFetch(fetch, { budget: b.requestBudget('index-a', 'rpc') });
    const bRpc = boundRpcFetch(fetch, { budget: b.requestBudget('index-b', 'rpc') });
    await Promise.all([
      readIndexFeedbackDocument({ origin: origins[0], documentHash: hash, work: { requests: b.requestBudget('index-a', 'index') } }),
      aRpc(origins[0]), bRpc(origins[1]),
    ]);
    assert.equal(maximum, 2); assert.deepEqual(laneMaximum, { a: 1, b: 1 });
    assert.equal(b.snapshot().calls, 3); assert.equal(b.snapshot().bytes, 18);
  } finally { await b.dispose(); await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  }))); }
});

test('raw reader logical timeout finally-aborts its actual transport before another origin request can dispatch', async () => {
  let closed!: () => void;
  const closedBody = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_req, res) => { res.on('close', closed); res.write('{'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, b = await budget();
  const controller = new AbortController(), pending = new Set<Promise<Response>>();
  const fetcher = boundRpcFetch(fetch, { budget: b.requestBudget('index-a', 'rpc'), signal: controller.signal });
  const fetchFn: typeof fetch = (input, init) => { const p = fetcher(input, init); pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p)); return p; };
  const client = createPublicClient({ transport: http(origin, { fetchFn, retryCount: 0, batch: false }), cacheTime: 0 });
  const h = `0x${'11'.repeat(32)}` as Hex;
  try {
    const result = await readRegistryFeedbackObservation({ client, signal: controller.signal,
      domain: { chainId: 31337, genesisHash: h, identityRegistry: '0x1111111111111111111111111111111111111111',
        reputationRegistry: '0x2222222222222222222222222222222222222222' },
      eventRef: { blockNumber: '1', blockHash: h, transactionHash: h, transactionIndex: 0, logIndex: 0 },
      observation: { blockNumber: 1n, blockHash: h }, limits: { rpcTimeoutMs: 50 } });
    assert.equal(result.authenticity, 'unavailable'); assert.ok(result.diagnostics.includes('rpc-timeout'));
    assert.equal(b.snapshot().inFlight, 1, 'a logical return is not physical transport completion');
  } finally {
    controller.abort(); await Promise.allSettled([...pending]); await closedBody;
    assert.equal(b.snapshot().inFlight, 0); assert.equal(b.snapshot().calls, 1);
    await b.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('actual Index 404 bytes and chunked oversized RPC bodies spend the shared ledger before decoding', async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes('/documents/')) { res.statusCode = 404; res.end('missing'); }
    else { res.write(' '.repeat(300000)); res.end(' '.repeat(300000)); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, b = await budget();
  try {
    assert.equal(await readIndexFeedbackDocument({ origin, documentHash: `0x${'a'.repeat(64)}`,
      work: { requests: b.requestBudget('index-a', 'index') } }), null);
    assert.equal(b.snapshot().bytes, 7);
    await assert.rejects(boundRpcFetch(fetch, { budget: b.requestBudget('index-a', 'rpc') })(origin), /512 KiB/);
    assert.ok(b.snapshot().bytes > 512 * 1024);
    assert.equal(b.snapshot().calls, 2);
  } finally { await b.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('synchronous dispatch failure charges once, repeated checks never recharge, and close releases the permit', async () => {
  const b = await budget();
  try {
    const lease = await b.requestBudget('index-a', 'rpc').open();
    assert.equal(b.snapshot().calls, 0); lease.check(); lease.check();
    assert.equal(b.snapshot().calls, 1); assert.equal(b.snapshot().inFlight, 1); lease.close(); lease.close();
    const fails: typeof fetch = () => { throw new Error('dispatch failed'); };
    await assert.rejects(boundRpcFetch(fails, { budget: b.requestBudget('index-a', 'rpc') })(origins[0]), /dispatch failed/);
    assert.equal(b.snapshot().calls, 2); assert.equal(b.snapshot().inFlight, 0);
  } finally { await b.dispose(); }
});

test('required shared byte exhaustion remains visible after a nested reader catches transport errors', async () => {
  const b = await budget();
  try {
    b.chargeBundle(8 * 1024 * 1024);
    const lease = await b.requestBudget('shared', 'rpc').open();
    try { assert.throws(() => lease.bytes(1), /byte-budget/); } finally { lease.close(); }
    assert.throws(() => b.check(), /shared:rpc/);
  } finally { await b.dispose(); }
});

test('individual call reservations fail at 2049 and 4097 even before the combined pool is full', async () => {
  for (const [lane, limit] of [['index-a', 2048], ['shared', 4096]] as const) {
    const b = await budget();
    try {
      for (let i = 0; i < limit; i++) { const lease = await b.requestBudget(lane, 'rpc').open(); lease.check(); lease.close(); }
      await assert.rejects(b.requestBudget(lane, 'rpc').open(), /call/);
      assert.equal(b.snapshot().calls, limit);
      if (lane === 'index-a') { const other = await b.requestBudget('index-b', 'rpc').open(); other.check(); other.close();
        assert.equal(b.snapshot().calls, 2049); }
    } finally { await b.dispose(); }
  }
});

test('candidate RPC byte overflow stays local and shared calls still have their full reservation', async () => {
  const b = await budget();
  try {
    const a = await b.requestBudget('index-a', 'rpc').open();
    a.bytes(4 * 1024 * 1024); assert.throws(() => a.bytes(1), /byte/); a.close();
    const shared = await b.requestBudget('shared', 'rpc').open(); shared.check(); shared.close();
    const other = await b.requestBudget('index-b', 'rpc').open(); other.bytes(1); other.close();
    b.check(); assert.equal(b.snapshot().bytes, 4194305); assert.equal(b.snapshot().lanes.shared.calls, 1);
  } finally { await b.dispose(); }
});
