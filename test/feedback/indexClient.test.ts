import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { encodeAbiParameters, keccak256, stringToHex, toEventSelector } from 'viem';
import { feedbackEventId, feedbackSourceId, readIndexFeedback, decodeIndexFeedbackEvent } from '../../src/feedback/indexClient.js';

const source = { chainId: 31337, genesisHash: `0x${'1'.repeat(64)}`, identityRegistry: `0x${'2'.repeat(40)}`,
  reputationRegistry: `0x${'3'.repeat(40)}`, startBlock: '10', confirmations: 0 };
const sourceId = 'sha256:cbffdc16ae66f4d90e73654349d17345a87ed6e5ab8c5f29776d7e069bd71be1';
const reviewer = `0x${'6'.repeat(40)}`;
const block = { number: '11', hash: `0x${'4'.repeat(64)}`, timestamp: 1700000000 };
const blob = Buffer.from('opaque public document');
const hash = keccak256(blob);
const raw = { block, transactionHash: `0x${'5'.repeat(64)}`, transactionIndex: '0', logIndex: '18446744073709551615',
  address: source.reputationRegistry, topics: [toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'),
    encodeAbiParameters([{ type: 'uint256' }], [1n]), encodeAbiParameters([{ type: 'address' }], [reviewer as `0x${string}`]), keccak256(stringToHex('quality'))],
  data: encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' }, { type: 'string' }, { type: 'string' },
    { type: 'string' }, { type: 'string' }, { type: 'bytes32' }], [1n, 1n, 0, 'quality', '', '', 'http://127.0.0.1:34567/review', hash]) };
const eventId = 'sha256:369a31d0a35145acabb607315d02c0e8b7a3348f5f880b740ae0bd6809b02057';
const event = { eventId, sourceId, raw, decoded: { kind: 'NewFeedback', agentId: '1', reviewer, feedbackIndex: '1',
  value: '1', valueDecimals: 0, indexedTag1: raw.topics[3], tag1: 'quality', tag2: '', endpoint: '',
  feedbackURI: 'http://127.0.0.1:34567/review', feedbackHash: hash, invalidTextFields: [] },
  insertionSequence: '1', observedAt: '2026-09-26T00:00:00.000Z', canonicality: 'canonical',
  document: { availability: 'retained', hash, byteLength: '22', retainedAt: '2026-09-26T00:00:00.000Z', job: null }, semantics: 'not-evaluated' };
const coverage = { sourceId, source, stateVersion: '1', generation: '0', availability: 'available', progress: 'synchronized',
  checkpoint: block, observedHead: block, finalizedBlock: block, rebuildingThrough: null, lastSuccessAt: null, lastAttemptAt: null,
  retention: { retained: '1', pending: '0', blocked: '0' } };
const history = { coverage, basis: { generation: '0', through: block, insertionSequence: '1' }, view: 'all-retained',
  items: [event], canonicalityBasis: 'current-coverage', nextCursor: null, semantics: 'not-evaluated' };
const selected = { source, agentId: '1', reviewer, eventId, documentHash: hash };

async function server(run: (origin: string) => Promise<void>, change?: (path: string, res: ServerResponse) => boolean) {
  const http = createServer((req, res) => {
    const path = req.url!;
    if (change?.(path, res)) return;
    if (path.includes('/documents/')) { res.setHeader('Content-Type', 'application/octet-stream'); res.end(blob); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(path.includes('/agents/') ? history : path.includes('/events/') ? { coverage, item: event, semantics: 'not-evaluated' } :
      { coverage, retention: { scope: 'canonical-prefix', newFeedbackEvents: '1', retained: '1', pending: '0', blocked: '0' }, semantics: 'not-evaluated' }));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(http.address() as { port: number }).port}`); }
  finally { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((e) => e ? reject(e) : resolve())); }
}

test('source and event IDs match independent Index literal vectors without rounding uint64 coordinates', () => {
  assert.equal(feedbackSourceId(source), sourceId);
  assert.equal(feedbackSourceId({ ...source, startBlock: '0', confirmations: 2 }), sourceId);
  assert.equal(feedbackSourceId({ ...source, chainId: 1 }), 'sha256:aa106d00dd501c15007eb080d7d4c4f62e0af2f5236f8370281e3f610fb54a04');
  assert.equal(feedbackEventId(source, raw), eventId);
  assert.equal(decodeIndexFeedbackEvent(event, source).raw.logIndex, '18446744073709551615');
});

test('selected Index supplies exact opaque bytes and separately qualified retained history', async () => {
  await server(async (origin) => {
    const result = await readIndexFeedback({ origin, ...selected });
    assert.deepEqual(Buffer.from(result.documentBytes!), blob);
    assert.equal(result.event.eventId, eventId);
    assert.equal(result.history.length, 1);
    assert.equal(result.coverage.progress, 'synchronized');
    assert.equal(result.completeness, 'index-reported-only');
  });
});

for (const [name, mutate] of [
  ['source domain', (e: any) => { e.sourceId = 'sha256:' + 'f'.repeat(64); }],
  ['raw attribution', (e: any) => { e.raw.address = reviewer; }],
  ['decoded agent', (e: any) => { e.decoded.agentId = '2'; }],
  ['decoded value', (e: any) => { e.decoded.value = '5'; }],
  ['event identity', (e: any) => { e.eventId = 'sha256:' + 'a'.repeat(64); }],
  ['document reference', (e: any) => { e.document.hash = '0x' + 'b'.repeat(64); }],
] as const) test(`rejects altered ${name}`, () => {
  const changed = structuredClone(event); mutate(changed);
  assert.throws(() => decodeIndexFeedbackEvent(changed, source), /invalid Index feedback/);
});

for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000/', 'http://user@127.0.0.1:3000', 'https://127.0.0.1:3000', 'http://127.1:3000']) {
  test(`rejects nonliteral selected origin ${origin}`, async () => assert.rejects(readIndexFeedback({ origin, ...selected }), /invalid Index feedback origin/));
}

test('rejects altered exact document bytes', async () => server(async (origin) => {
  await assert.rejects(readIndexFeedback({ origin, ...selected }), /document digest/);
}, (path, res) => { if (!path.includes('/documents/')) return false; res.end('wrong'); return true; }));

test('missing document stays unavailable, never fetched from the event URI', async () => server(async (origin) => {
  assert.equal((await readIndexFeedback({ origin, ...selected })).documentBytes, null);
}, (path, res) => { if (!path.includes('/documents/')) return false; res.statusCode = 404; res.end(); return true; }));

test('does not follow redirect responses', async () => server(async (origin) => {
  await assert.rejects(readIndexFeedback({ origin, ...selected }), /HTTP status/);
}, (_path, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); res.end(); return true; }));

test('rejects source drift and stale generations across requests', async () => {
  for (const field of ['source', 'generation']) await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /source|generation/);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const changed = structuredClone(history);
    if (field === 'source') changed.coverage.source.chainId = 1; else changed.coverage.generation = '1';
    res.end(JSON.stringify(changed)); return true;
  });
});

test('bounds declared and streaming bodies before parsing', async () => {
  for (const declared of [true, false]) await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /body budget/);
  }, (_path, res) => { if (declared) res.setHeader('Content-Length', 2097153); res.end(' '.repeat(2097153)); return true; });
});

test('aborted acquisition cancels an unfinished body', async () => server(async (origin) => {
  const controller = new AbortController();
  const pending = readIndexFeedback({ origin, ...selected, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /cancelled/);
}, (_path, res) => { res.write(' '); return true; }));

test('body deadline bounds a stalled response', { timeout: 8000 }, async () => server(async (origin) => {
  await assert.rejects(readIndexFeedback({ origin, ...selected }), /deadline/);
}, (_path, res) => { res.write(' '); return true; }));

test('historical child explicitly preserves unsupported uint64 coordinates instead of coercing them', async () => {
  const module = await import('../../src/demo/verifyFeedbackCli.js').catch(() => undefined);
  assert.ok(module, 'selected-Index historical verifier must be implemented');
  await server(async (origin) => {
    const result = await module.verifyFeedbackFromIndex({ indexOrigin: origin, rpcOrigin: 'http://127.0.0.1:1', ...selected,
      observationBlock: '11', observationHash: block.hash }, null);
    assert.equal(result.status, 'unsupported-event-reference');
    assert.equal(result.index.event.logIndex, '18446744073709551615');
    assert.equal(result.historical, undefined);
  });
});

function nextEvent(number: number) {
  const next = structuredClone(event);
  next.raw.block.number = String(11 + number);
  next.raw.block.hash = `0x${String(number + 10).padStart(64, '0')}`;
  next.insertionSequence = String(number + 1);
  next.eventId = `sha256:${createHash('sha256').update(JSON.stringify(['erc8004-feedback-event-v1', sourceId,
    next.raw.block.hash, next.raw.transactionHash, next.raw.logIndex])).digest('hex')}`;
  return next;
}
const cursorFor = (e: typeof event, sequence = '1001') => Buffer.from(JSON.stringify({ version: 1, sourceId, agentId: '1', reviewer,
  view: 'all-retained', pageSize: 100, order: 'block-transaction-log-event', generation: '0', through: block, sequence,
  after: [e.raw.block.number, e.raw.transactionIndex, e.raw.logIndex, e.eventId] })).toString('base64url');

for (const mode of ['cycle', 'scope', 'basis', 'stale', 'order'] as const) test(`rejects ${mode} pagination without claiming complete history`, async () => {
  let calls = 0;
  await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /cursor|basis|generation|order/);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const e = calls++ === 0 ? structuredClone(event) : nextEvent(1);
    const page = { ...structuredClone(history), basis: { generation: '0', through: block, insertionSequence: '1001' },
      items: [e], nextCursor: cursorFor(e) as string | null };
    if (mode === 'scope') page.nextCursor = cursorFor(e).replace(/^./, 'A');
    else if (calls > 1) {
      if (mode === 'cycle') page.nextCursor = cursorFor(event);
      if (mode === 'basis') page.basis.insertionSequence = '1002';
      if (mode === 'stale') { res.statusCode = 409; res.end('{}'); return true; }
      if (mode === 'order') page.items = [structuredClone(event)];
    }
    res.end(JSON.stringify(page)); return true;
  });
});

test('valid multi-page history preserves the frozen basis while current coverage advances', async () => {
  let calls = 0;
  await server(async (origin) => {
    const result = await readIndexFeedback({ origin, ...selected });
    assert.equal(result.history.length, 2);
    assert.equal(result.basis?.through?.number, '11');
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const first = calls++ === 0;
    res.end(JSON.stringify({ ...history, coverage: { ...coverage, stateVersion: first ? '1' : '2' },
      basis: { generation: '0', through: block, insertionSequence: '2' }, items: [first ? event : nextEvent(1)],
      nextCursor: first ? cursorFor(event, '2') : null })); return true;
  });
});

test('history memberships retain their page coverage when the selected event is later re-adopted', async () => {
  const rebuilding = { ...coverage, generation: '1', stateVersion: '2', progress: 'rebuilding',
    checkpoint: { ...block, number: '10' }, rebuildingThrough: '11' };
  const replayed = { ...coverage, generation: '1', stateVersion: '3' };
  await server(async (origin) => {
    const result = await readIndexFeedback({ origin, ...selected });
    assert.equal(result.history[0]?.canonicality, 'withdrawn');
    assert.equal(result.event.canonicality, 'canonical');
    assert.equal(result.coverage.checkpoint?.number, '11');
    assert.deepEqual(result.historyPages, [{ coverage: rebuilding, eventIds: [eventId] }]);
    const { verifyFeedbackFromIndex } = await import('../../src/demo/verifyFeedbackCli.js');
    const report = await verifyFeedbackFromIndex({ indexOrigin: origin, rpcOrigin: 'http://127.0.0.1:1',
      ...selected, observationBlock: '11', observationHash: block.hash }, null);
    // The selected uint64 coordinate is unsupported: no RPC/secret file needed.
    assert.equal(report.status, 'unsupported-event-reference');
    assert.deepEqual(report.index.historyPages, [{ coverage: rebuilding, eventIds: [eventId] }]);
  }, (path, res) => {
    if (path.includes('/agents/')) res.end(JSON.stringify({ ...history, coverage: rebuilding,
      basis: { ...history.basis, generation: '1' }, items: [{ ...event, canonicality: 'withdrawn' }] }));
    else if (path.includes('/events/')) res.end(JSON.stringify({ coverage: replayed, item: event, semantics: 'not-evaluated' }));
    else if (!path.includes('/documents/')) res.end(JSON.stringify({ coverage: rebuilding,
      retention: { scope: 'canonical-prefix', newFeedbackEvents: '1', retained: '1', pending: '0', blocked: '0' }, semantics: 'not-evaluated' }));
    else return false;
    return true;
  });
});

test('more than twenty pages is explicitly over budget', async () => {
  let calls = 0;
  await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /page budget/);
    assert.equal(calls, 20);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const e = calls++ === 0 ? event : nextEvent(calls);
    res.end(JSON.stringify({ ...history, basis: { generation: '0', through: block, insertionSequence: '1001' },
      items: [e], nextCursor: cursorFor(e) })); return true;
  });
});

test('one thousand event limit stops before claiming an unbounded history', async () => {
  let pageNumber = 0;
  await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /event budget/);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const rows = Array.from({ length: 100 }, (_, i) => nextEvent(pageNumber * 100 + i)); pageNumber++;
    res.end(JSON.stringify({ ...history, basis: { generation: '0', through: block, insertionSequence: '2000' },
      items: rows, nextCursor: cursorFor(rows.at(-1)!, '2000') })); return true;
  });
});

test('truncated HTTP and oversized document bodies are rejected', async () => {
  await server(async (origin) => assert.rejects(readIndexFeedback({ origin, ...selected }), /truncated|transport/),
    (_path, res) => { res.setHeader('Content-Length', 100); res.flushHeaders(); res.write('a'); setTimeout(() => res.destroy(), 5); return true; });
  await server(async (origin) => assert.rejects(readIndexFeedback({ origin, ...selected }), /body budget/),
    (path, res) => { if (!path.includes('/documents/')) return false; res.end(Buffer.alloc(6145)); return true; });
});

test('eight MiB total payload budget includes otherwise valid padded JSON across pages', async () => {
  let calls = 0;
  await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /body budget/);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const e = calls++ === 0 ? event : nextEvent(calls);
    const page = JSON.stringify({ ...history, basis: { generation: '0', through: block, insertionSequence: '1001' },
      items: [e], nextCursor: cursorFor(e) });
    res.end(page.padEnd(2097152)); return true;
  });
});

test('whole acquisition deadline survives a succession of individually timely bodies', { timeout: 35000 }, async () => {
  let calls = 0;
  await server(async (origin) => {
    await assert.rejects(readIndexFeedback({ origin, ...selected }), /deadline/);
  }, (path, res) => {
    if (!path.includes('/agents/')) return false;
    const e = calls++ === 0 ? event : nextEvent(calls);
    const timer = setTimeout(() => res.end(JSON.stringify({ ...history,
      basis: { generation: '0', through: block, insertionSequence: '1001' }, items: [e], nextCursor: cursorFor(e) })), 4200);
    res.once('close', () => clearTimeout(timer)); return true;
  });
});

test('proxy environment does not redirect the explicitly selected loopback transport', async () => {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = key === 'NODE_USE_ENV_PROXY' ? '1' : 'http://127.0.0.1:1';
    await server(async (origin) => assert.deepEqual(Buffer.from((await readIndexFeedback({ origin, ...selected })).documentBytes!), blob));
  } finally { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
});
