import assert from 'node:assert/strict';
import test from 'node:test';
import { owned, json } from './fixtures.js';
const modulePath = '../../src/live/transport.js';
async function api() {
  const m = await import(modulePath).catch(() => ({}));
  assert.equal(typeof m.LiveTransport, 'function', 'bounded transport must be implemented');
  return m as typeof import('../../src/live/transport.js');
}
test('streamed SSE preserves a matching response; explicit transient retry is global and metered', async (t) => {
  const { LiveTransport } = await api(); let count = 0;
  const f = await owned(t, (_req, res) => {
    if (++count === 1) return json(res, { error: { status: 'UNAVAILABLE' } }, 503);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of ['data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
      'data: {"jsonrpc":"2.', '0","id":3,"result":{"ok":true}}\n\n']) res.write(chunk);
    res.end();
  });
  const run = await f.ledger.begin('transport-1'); f.finishRuns.push(run);
  const transport = new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'owned-key', ticketmaster: 'owned-key' } });
  const result = await transport.request(run, 'places', 'places', { method: 'POST', body: {}, rpcId: 3 });
  assert.deepEqual(result.value, { ok: true }); assert.equal(count, 2); assert.equal(run.usage().physicalAttempts, 2);
  assert.equal(run.claimRetry(), false);
});
test('unsafe endpoint, redirects, oversized streams, wrong IDs and structured auth faults fail closed', async (t) => {
  const { LiveTransport } = await api(); let scenario = '', count = 0;
  const f = await owned(t, (_req, res) => {
    count++;
    if (scenario === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/secret' }); return res.end(); }
    if (scenario === 'oversize') { res.writeHead(200); res.write(' '.repeat(1024 * 1024)); return res.end('x'); }
    if (scenario === 'auth') return json(res, { fault: { faultstring: 'PRIVATE raw error', detail: { errorcode: 'oauth.v2.InvalidApiKey' } } }, 401);
    return json(res, { jsonrpc: '2.0', id: 4, result: {} });
  });
  assert.throws(() => new LiveTransport({ mode: 'local-test', endpoints: { ...f.endpoints, places: 'https://evil.example/mcp' }, credentials: { google: 'x', ticketmaster: 'x' } }));
  assert.throws(() => new LiveTransport({ mode: 'production', enabled: false, credentials: { google: 'x', ticketmaster: 'x' } }));
  for (const config of [
    { mode: 'unknown', credentials: { google: 'x', ticketmaster: 'x' } },
    { mode: 'production', enabled: true, credentials: {} },
    { mode: 'local-test', endpoints: {}, credentials: { google: 'x', ticketmaster: 'x' } },
    { mode: 'production', enabled: true, endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } },
  ]) assert.throws(() => new LiveTransport(config as any), /not-configured/);
  const transport = new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } });
  for (const [name, reason] of [['redirect', 'upstream'], ['oversize', 'oversize'], ['auth', 'auth'], ['id', 'invalid-response']]) {
    scenario = name!; const run = await f.ledger.begin(`transport-${name}`);
    await assert.rejects(transport.request(run, 'places', 'places', { method: 'POST', body: {}, rpcId: 3 }), new RegExp(reason!));
    await run.finish();
  }
  assert.equal(count, 4);
});

test('HTTP/body faults, ambiguous disconnects and protocol violations never retry; a second transient uses no new slot', async (t) => {
  const { LiveTransport } = await api(); let scenario = 'transient', count = 0;
  const f = await owned(t, (req, res) => {
    count++;
    if (scenario === 'disconnect') { req.socket.destroy(); return; }
    if (scenario === 'transient') return json(res, { error: { status: 'UNAVAILABLE' } }, 503);
    if (scenario === 'numeric-auth') return json(res, { error: { code: 403, message: 'SECRET' } });
    if (scenario === 'numeric-quota') return json(res, { error: { code: 429, message: 'SECRET' } });
    if (scenario === 'schema') return json(res, { error: { status: 'INVALID_ARGUMENT', message: 'SECRET' } }, 400);
    if (scenario === 'sampling') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"jsonrpc":"2.0","id":7,"method":"sampling/createMessage","params":{}}\n\n'); }
    if (scenario === 'trailing') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"jsonrpc":"2.0","id":3,"result":{}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'); }
    if (scenario === 'notification') { res.writeHead(200); return res.end(); }
  });
  const transport = new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } });
  const run = await f.ledger.begin('retry-global');
  await assert.rejects(transport.request(run, 'places', 'places', { method: 'POST', body: {}, rpcId: 3 }), /upstream/);
  assert.equal(count, 2);
  await assert.rejects(transport.request(run, 'transit', 'transit', { method: 'POST', body: {} }), /upstream/);
  assert.equal(count, 3); await run.finish();
  for (const [name, reason] of [['numeric-auth', 'auth'], ['numeric-quota', 'quota'], ['schema', 'invalid-response'], ['disconnect', 'ambiguous-dispatch'], ['sampling', 'invalid-response'], ['trailing', 'invalid-response'], ['notification', 'invalid-response']]) {
    scenario = name!; const before: number = count; const r = await f.ledger.begin(`fault-${name}`);
    await assert.rejects(transport.request(r, 'places', name === 'notification' ? 'initialized' : 'places', { method: 'POST', body: {}, ...(name === 'notification' ? { notification: true } : { rpcId: 3 }) }), new RegExp(reason!));
    assert.equal(count, before + 1); await r.finish();
  }
});

test('deadline aborts a stalled response without retry or extending on progress', async (t) => {
  const { LiveTransport } = await api(); let count = 0;
  let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const f = await owned(t, (_req, res) => { count++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'); entered(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = await f.ledger.begin('deadline', undefined, f.ledger.now() + 75);
  const transport = new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } });
  const pending = transport.request(run, 'places', 'places', { method: 'POST', body: {}, rpcId: 3 });
  await waiting; t.mock.timers.tick(75);
  await assert.rejects(pending, /deadline/);
  await assert.rejects(run.dispatch('delete', async () => assert.fail('expired overall timer cannot gain a cleanup extension')), /deadline/);
  assert.equal(count, 1); await run.finish();
});

test('four MiB aggregate cap counts actual decoded HTTP streams across requests', async (t) => {
  const { LiveTransport } = await api(); let count = 0;
  const f = await owned(t, (_req, res) => { count++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('"'); res.write('x'.repeat(1024 * 1024 - 2)); res.end('"'); });
  const run = await f.ledger.begin('aggregate'); f.finishRuns.push(run);
  const transport = new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } });
  for (let i = 0; i < 4; i++) await transport.request(run, 'transit', 'transit', { method: 'POST', body: {} });
  await assert.rejects(transport.request(run, 'transit', 'transit', { method: 'POST', body: {} }), /oversize/);
  assert.equal(count, 5); assert.equal(run.usage().physicalAttempts, 5);
});
