import assert from 'node:assert/strict';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { digestBytes } from '../../src/identity/profile.js';
import { signRequest } from '../../src/interaction/signatures.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { encodeOriginDocument, decodeOriginEnvelope } from '../../src/origin/bytes.js';
import { signOriginStatement, verifyOriginSignature } from '../../src/origin/signatures.js';
import type { OriginProfile, OriginRequest, OriginEnvelope } from '../../src/origin/schema.js';
import type { OriginDocument } from '../../src/origin/bytes.js';
import { CityTaskStore } from '../../src/a2a/store.js';
import { startLoopbackA2AService, type A2ATask } from '../../src/a2a/service.js';

const NOW = '2026-09-27T12:02:00Z';
async function modules() {
  const [tls, profile, strategy, service] = await Promise.all([
    import('../../src/demo/originTls.js').catch(() => null),
    import('../../src/origin/profile.js').catch(() => null),
    import('../../src/a2a/strategy.js').catch(() => null),
    import('../../src/a2a/service.js'),
  ]);
  assert.ok(tls && profile && strategy && 'startStrategyA2AService' in service,
    'explicit origin strategy, scoped TLS observation, and shared strategy runtime must exist');
  return { ...tls, ...profile, ...strategy, ...service };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    server.off('error', reject); resolve();
  }); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `https://127.0.0.1:${address.port}`;
}
async function rpc(url: string, ca: string, method: string, params: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', ca, agent: false,
      headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}
function send(envelope: unknown) {
  return { message: { kind: 'message', role: 'user', messageId: 'origin-client', parts: [{ kind: 'data',
    data: { type: 'org.nandacity.city-request', version: '0.1', envelope } }] } };
}
async function fixture(t: TestContext) {
  const api = await modules();
  const tls = await api.createOriginTlsFixture();
  t.after(() => tls.close());
  const directory = await mkdtemp(join(tmpdir(), 'city-origin-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = privateKeyToAccount(generatePrivateKey());
  const runtime = privateKeyToAccount(generatePrivateKey());
  const caller = privateKeyToAccount(generatePrivateKey());
  let bytes: Uint8Array = new Uint8Array();
  let cardBytes: Uint8Array = new Uint8Array();
  let behavior = 'normal';
  let reads = 0;
  const identity = createServer(tls.serverOptions, (req, res) => {
    reads++;
    if (behavior === 'redirect') { res.writeHead(302, { location: '/else' }).end(); return; }
    if (behavior === 'oversize') { res.end(Buffer.alloc(6145)); return; }
    if (behavior === 'unavailable') { res.writeHead(503).end(); return; }
    if (req.url !== '/identity') { res.writeHead(404).end(); return; }
    res.end(bytes);
  });
  const origin = await listen(identity);
  t.after(() => new Promise<void>((resolve) => identity.close(() => resolve())));
  const cards = createServer(tls.serverOptions, (req, res) => {
    if (req.url !== '/card') { res.writeHead(404).end(); return; }
    res.end(cardBytes);
  });
  const cardOrigin = await listen(cards);
  t.after(() => new Promise<void>((resolve) => cards.close(() => resolve())));
  const identityUrl = `${origin}/identity`;
  const key = (account: typeof caller) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
  let profile!: OriginProfile;
  let basis!: OriginDocument<OriginProfile>;
  const allowedUrls = [identityUrl, `${cardOrigin}/card`];
  const observe = () => api.observeOriginProfile({ identityUrl, allowedUrls, ca: tls.ca, now: () => now });
  let observations = 0;
  let onObserve: ((n: number) => void) | undefined;
  let execute: ((request: OriginRequest, context: { signal: AbortSignal }) => Promise<Uint8Array>) | undefined;
  let now = NOW;
  const start = (timeout = 5000, signer = runtime) => api.startStrategyA2AService({
    storeDirectory: directory, runtimeSigner: signer, now: () => now, executionTimeoutMs: timeout,
    strategy: api.createOriginRuntimeStrategy({ basisProfile: () => basis,
      observeAuthority: async () => { observations++; onObserve?.(observations); return observe(); } }),
    server: { protocol: 'https', create: (handler) => createServer(tls.serverOptions, handler) },
    execute: async (r, context) => execute ? execute(r, context) : new TextEncoder().encode('{"synthetic":true}'),
  });
  let runtimeService = await start();
  t.after(() => runtimeService.close());
  allowedUrls.push(runtimeService.url);
  profile = { profile: 'city-origin@0.1', kind: 'profile', service: { method: 'https-origin', identityUrl },
    revision: '1', active: true, controllerKey: key(controller), runtimeKey: key(runtime),
    cardURL: `${cardOrigin}/card`, cardDigest: `0x${'ab'.repeat(32)}`, endpoint: runtimeService.url,
    city: 'Chicago', capability: 'evening-plan' };
  cardBytes = new TextEncoder().encode(JSON.stringify({ protocolVersion: '0.3.0', name: 'Synthetic Chicago',
    description: 'Owned test fixture', url: runtimeService.url, preferredTransport: 'JSONRPC', version: '0.1',
    capabilities: {}, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'evening-plan', name: 'Evening plan', description: 'Synthetic Chicago only', tags: ['Chicago'] }] }));
  profile.cardDigest = digestBytes(cardBytes);
  basis = encodeOriginDocument(await signOriginStatement(profile, controller)) as OriginDocument<OriginProfile>;
  bytes = basis.bytes;
  const request: OriginRequest = { profile: 'city-origin@0.1', kind: 'request', service: profile.service,
    caller: key(caller), interactionId: `0x${'cd'.repeat(32)}`, profileBasis: { profileDigest: basis.documentDigest,
      cardDigest: profile.cardDigest }, createdAt: '2026-09-27T12:00:00Z', deadline: '2026-09-27T12:05:00Z',
    input: makeInteractionFixture().request.input };
  const envelope = await signOriginStatement(request, caller);
  const call = (method: string, params: unknown) => rpc(runtimeService.url, tls.ca, method, params);
  const terminal = async (id: string): Promise<A2ATask> => {
    for (let i = 0; i < 100; i++) {
      const response = await call('tasks/get', { id });
      assert.ok(response.result, JSON.stringify(response));
      if (['completed', 'failed'].includes(response.result.status.state)) return response.result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('terminal task not observed');
  };
  return { api, tls, directory, controller, runtime, caller, profile, basis, request, envelope, call, terminal, observe,
    identityUrl, allowedUrls, get reads() { return reads; },
    set behavior(value: string) { behavior = value; }, set bytes(value: Uint8Array) { bytes = value; },
    set execute(value: NonNullable<typeof execute>) { execute = value; },
    set onObserve(value: NonNullable<typeof onObserve>) { onObserve = value; },
    set now(value: string) { now = value; },
    restart: async (timeout = 5000, signer = runtime) => { await runtimeService.close(); runtimeService = await start(timeout, signer); },
  };
}

test('origin HTTPS service shares retry, digest conflict, terminal signing and restart persistence without chain access', async (t) => {
  let forbiddenTransportCalls = 0;
  // The existing viem HTTP/RPC path uses fetch. Origin uses only scoped node:https
  // to the owned listeners below, and must not dispatch through that chain path.
  t.mock.method(globalThis, 'fetch', async () => {
    forbiddenTransportCalls++;
    throw new Error('origin runtime attempted the fetch-backed chain transport');
  });
  const f = await fixture(t);
  let executions = 0;
  f.execute = async () => { executions++; return new TextEncoder().encode('{"synthetic":true}'); };
  const [left, right] = await Promise.all([f.call('message/send', send(f.envelope)), f.call('message/send', send(f.envelope))]);
  assert.ok(left.result, JSON.stringify(left));
  assert.equal(left.result.id, right.result.id);
  const task = await f.terminal(left.result.id);
  assert.equal(task.status.state, 'completed');
  const meta = task.metadata!['org.nandacity'] as Record<string, OriginEnvelope>;
  assert.equal((await verifyOriginSignature(meta.acceptance, f.identityUrl, 'acceptance')).status, 'valid');
  assert.equal((await verifyOriginSignature(meta.completion, f.identityUrl, 'completion')).status, 'valid');
  const accepted = decodeOriginEnvelope(meta.acceptance).statement;
  const completed = decodeOriginEnvelope(meta.completion).statement.value;
  assert.equal(accepted.value.kind, 'acceptance');
  assert.equal(completed.kind, 'completion');
  assert.ok(completed.kind === 'completion');
  assert.equal(completed.acceptanceDigest, accepted.digest);
  assert.equal(executions, 1);
  assert.equal(f.reads, 3, 'identity observed before acceptance, execution and completion; no chain observer exists');
  const conflict = await signOriginStatement({ ...f.request, input: { ...f.request.input, area: 'different' } }, f.caller);
  assert.equal((await f.call('message/send', send(conflict))).error.data.reason, 'interaction-key-conflict');
  await assert.rejects(CityTaskStore.open(f.directory), /./, 'Ethereum default store rejects origin records');
  await f.restart();
  assert.deepEqual((await f.call('message/send', send(f.envelope))).result, task);
  assert.equal(executions, 1);
  assert.equal(forbiddenTransportCalls, 0);
});

test('origin profile requires scoped TLS, exact allowlist, correct controller, card bytes and endpoint', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.observe()).current, 'observed');
  const wrongCA = await f.api.createOriginTlsFixture();
  t.after(() => wrongCA.close());
  assert.equal((await f.api.observeOriginProfile({ identityUrl: f.identityUrl, allowedUrls: f.allowedUrls,
    ca: wrongCA.ca, now: () => NOW })).current, 'unknown');
  const before = f.reads;
  assert.equal((await f.api.observeOriginProfile({ identityUrl: f.identityUrl, allowedUrls: [], ca: f.tls.ca,
    now: () => NOW })).current, 'unknown');
  assert.equal(f.reads, before, 'not allowlisted must not make a request');
  for (const behavior of ['redirect', 'oversize', 'unavailable']) {
    f.behavior = behavior;
    assert.equal((await f.observe()).current, 'unknown');
  }
  f.behavior = 'normal';
  f.bytes = encodeOriginDocument(await signOriginStatement({ ...f.profile,
    cardDigest: `0x${'12'.repeat(32)}` }, f.controller)).bytes;
  assert.equal((await f.observe()).current, 'unknown');
  f.bytes = encodeOriginDocument(await signOriginStatement({ ...f.profile,
    endpoint: 'https://outside.example/' }, f.controller)).bytes;
  assert.equal((await f.api.observeOriginProfile({ identityUrl: f.identityUrl, allowedUrls: f.allowedUrls, ca: f.tls.ca,
    now: () => NOW, includeCard: false })).current, 'unknown', 'identity-only observation still constrains declared endpoints');
  f.bytes = encodeOriginDocument({ ...f.basis.envelope, signer: { ...f.basis.envelope.signer, address: f.caller.address.toLowerCase() } }).bytes;
  assert.equal((await f.observe()).current, 'unknown');
});

test('scoped TLS rejects a trusted certificate whose literal IP SAN differs', async (t) => {
  const api = await modules();
  const tls = await api.createOriginTlsFixture('127.0.0.2');
  t.after(() => tls.close());
  const server = createServer(tls.serverOptions, (_req, res) => res.end('{}'));
  const url = `${await listen(server)}/identity`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const result = await api.observeOriginProfile({ identityUrl: url, allowedUrls: [url], ca: tls.ca, now: () => NOW });
  assert.equal(result.current, 'unknown');
});

for (const stage of [1, 2, 3]) for (const cause of ['unknown', 'changed']) {
  test(`origin ${cause} authority at check ${stage} cannot authorize execution or manufacture completion`, async (t) => {
    const f = await fixture(t);
    let executions = 0;
    f.execute = async () => { executions++; return new Uint8Array([1]); };
    const changed = encodeOriginDocument(await signOriginStatement({ ...f.profile, active: false }, f.controller));
    f.onObserve = (n) => { if (n >= stage) { if (cause === 'unknown') f.behavior = 'unavailable'; else f.bytes = changed.bytes; } };
    const response = await f.call('message/send', send(f.envelope));
    if (stage === 1) assert.equal(response.error.data.reason, cause === 'unknown' ? 'authority-unavailable' : 'authority-changed');
    else {
      const task = await f.terminal(response.result.id);
      assert.equal(task.status.state, 'failed');
      assert.equal((task.metadata!['org.nandacity'] as any).completion, undefined);
    }
    assert.equal(executions, stage === 3 ? 1 : 0);
  });
}

test('origin refuses wrong runtime, caller, profile-document digest and Ethereum requests', async (t) => {
  const f = await fixture(t);
  const ethereum = makeInteractionFixture();
  assert.equal((await f.call('message/send', send(await signRequest(ethereum.request, ethereum.caller)))).error.data.reason,
    'invalid-city-request-part');
  const wrongCaller = { ...f.envelope, signer: { ...f.envelope.signer, address: f.runtime.address.toLowerCase() } };
  assert.equal((await f.call('message/send', send(wrongCaller))).error.data.reason, 'request-signature-invalid');
  const payloadBasis = await signOriginStatement({ ...f.request, profileBasis: { ...f.request.profileBasis,
    profileDigest: f.basis.statement.digest } }, f.caller);
  assert.equal((await f.call('message/send', send(payloadBasis))).error.data.reason, 'profile-basis-mismatch');
  await f.restart(5000, f.controller);
  assert.equal((await f.call('message/send', send(f.envelope))).error.data.reason, 'runtime-signer-unauthorized');
  const defaultDirectory = await mkdtemp(join(tmpdir(), 'city-ethereum-default-'));
  t.after(() => rm(defaultDirectory, { recursive: true, force: true }));
  const defaultService = await startLoopbackA2AService({ storeDirectory: defaultDirectory, runtimeSigner: ethereum.runtime,
    now: () => NOW, observeAuthority: async () => { throw new Error('origin must fail before authority'); } });
  t.after(() => defaultService.close());
  const response = await fetch(defaultService.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: send(f.envelope) }) });
  assert.equal(((await response.json()) as any).error.data.reason, 'invalid-city-request-part');
});

test('origin deadline and execution cancellation preserve bounded runtime and signed expiry semantics', async (t) => {
  const f = await fixture(t);
  await f.restart(20);
  let aborted = false;
  f.execute = async (_request, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  const response = await f.call('message/send', send(f.envelope));
  const task = await f.terminal(response.result.id);
  assert.equal(task.status.state, 'failed');
  assert.equal(aborted, true);
  assert.equal((task.metadata!['org.nandacity'] as any).failureReason, 'execution-timeout');
  const next = await signOriginStatement({ ...f.request, interactionId: `0x${'aa'.repeat(32)}` }, f.caller);
  f.now = '2026-09-27T12:06:00Z';
  assert.equal((await f.call('message/send', send(next))).error.data.reason, 'acceptance-time-invalid');
});

test('origin record parser rejects cross-mode nested evidence on load and save', async (t) => {
  const f = await fixture(t);
  const params = send(f.envelope);
  const response = await f.call('message/send', { ...params, message: { ...params.message,
    metadata: { completion: 'opaque caller annotation, not a City envelope' } } });
  assert.ok(response.result, JSON.stringify(response));
  const task = await f.terminal(response.result.id);
  const store = await CityTaskStore.open(f.directory, f.api.parseOriginTaskRecord);
  const record = store.getByTask(task.id)!;
  const eth = makeInteractionFixture();
  const ethereumRequest = await signRequest(eth.request, eth.caller);
  assert.throws(() => f.api.parseOriginTaskRecord({ ...record, requestEnvelope: ethereumRequest }));
  const corrupt = { ...record, task: { ...task, metadata: { 'org.nandacity': {
    ...(task.metadata!['org.nandacity'] as Record<string, unknown>), completion: ethereumRequest } } } };
  assert.throws(() => f.api.parseOriginTaskRecord(corrupt));
  await assert.rejects(store.save(corrupt));
  assert.deepEqual(store.getByTask(task.id), record, 'failed validation must leave the stored task unchanged');
});

for (const keyKind of ['controllerKey', 'runtimeKey'] as const) {
  test(`origin current ${keyKind} rotation cannot authorize old-key completion`, async (t) => {
    const f = await fixture(t);
    const replacement = privateKeyToAccount(generatePrivateKey());
    const changedProfile = { ...f.profile, [keyKind]: { method: 'secp256k1-key' as const, address: replacement.address.toLowerCase() } };
    const changed = encodeOriginDocument(await signOriginStatement(changedProfile, keyKind === 'controllerKey' ? replacement : f.controller));
    f.execute = async () => { f.bytes = changed.bytes; return new Uint8Array([1]); };
    const response = await f.call('message/send', send(f.envelope));
    const task = await f.terminal(response.result.id);
    const meta = task.metadata!['org.nandacity'] as Record<string, unknown>;
    assert.equal(task.status.state, 'failed');
    assert.equal(meta.failureReason, 'authority-changed');
    assert.equal(meta.completion, undefined);
  });
}

test('origin late successful execution signs expiry, never a late answer', async (t) => {
  const f = await fixture(t);
  f.execute = async () => { f.now = '2026-09-27T12:06:00Z'; return new Uint8Array([1]); };
  const response = await f.call('message/send', send(f.envelope));
  const task = await f.terminal(response.result.id);
  const meta = task.metadata!['org.nandacity'] as Record<string, unknown>;
  assert.equal(task.status.state, 'failed');
  assert.equal(meta.failureReason, 'deadline-expired');
  assert.equal(task.artifacts, undefined);
  const statement = decodeOriginEnvelope(meta.completion).statement.value;
  assert.ok(statement.kind === 'completion');
  assert.equal(statement.outcome, 'expired');
  assert.equal((await verifyOriginSignature(meta.completion, f.identityUrl, 'completion')).status, 'valid');
});

test('origin reopened submitted records recheck authority before work', async (t) => {
  const f = await fixture(t);
  const response = await f.call('message/send', send(f.envelope));
  await f.terminal(response.result.id);
  const store = await CityTaskStore.open(f.directory, f.api.parseOriginTaskRecord);
  const record = store.getByTask(response.result.id)!;
  await store.save({ ...record, task: response.result });
  await f.restart();
  f.behavior = 'unavailable';
  let executions = 0;
  f.execute = async () => { executions++; return new Uint8Array([1]); };
  const failed = await f.terminal(response.result.id);
  assert.equal(failed.status.state, 'failed');
  assert.equal(executions, 0);
  assert.equal((failed.metadata!['org.nandacity'] as Record<string, unknown>).completion, undefined);
});
