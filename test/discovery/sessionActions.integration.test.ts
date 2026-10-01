import assert from 'node:assert/strict';
import test from 'node:test';
import { withDemoSession } from '../../src/demo/sessionController.js';
import { startSessionServer } from '../../src/demo/sessionServer.js';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('Index experiments invalidate old discovery and report fresh verified observations', { timeout: 360000 }, async () => {
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready();
    const run = async (action: Parameters<typeof session.start>[0], id: string) => session.wait(session.start(action, id).id);
    await run({ kind: 'refresh', city: 'Chicago' }, 'initial-chicago');
    const initial = session.view();
    assert.equal(initial.discovery?.selected.length, 3);
    session.select(initial.discovery!.selected[0]!.service);
    const stopping = session.start({ kind: 'index', index: 'A', state: 'stop', city: 'Chicago' }, 'stop-a');
    assert.equal(session.view().selection, null, 'an old candidate is invalid as soon as the fault is queued');
    assert.equal(session.view().discovery, null, 'the previous observation cannot remain current');
    assert.equal(session.view().experiment?.phase, 'applying');
    assert.equal((await session.wait(stopping.id)).state, 'completed');
    const stopped = session.view();
    assert.equal(stopped.indexControls.A, 'offline');
    assert.equal(stopped.experiment?.phase, 'observed');
    assert.equal(stopped.experiment?.before?.indexes.A.verified, 3);
    assert.equal(stopped.experiment?.after?.indexes.A.status, 'unavailable');
    assert.equal(stopped.experiment?.after?.indexes.B.verified, 3);
    assert.equal(stopped.experiment?.after?.services.length, 3);
    assert.equal(stopped.discovery?.selected.length, 3);
    assert.equal(stopped.invocations.length, 0, 'discovery-only fault does not invoke a service');
    assert.throws(() => session.start({ kind: 'index', index: 'B', state: 'tamper', city: 'Chicago' }, 'unsupported-b'), /only Index A/);
    assert.equal(session.view().indexControls.A, 'offline', 'unsupported B tamper must not restore A as a side effect');
    await run({ kind: 'index', index: 'B', state: 'stop', city: 'Chicago' }, 'stop-b');
    const down = session.view();
    assert.equal(down.experiment?.after?.indexes.A.status, 'unavailable');
    assert.equal(down.experiment?.after?.indexes.B.status, 'unavailable');
    assert.deepEqual(down.experiment?.after?.services, []);
    await run({ kind: 'index', index: 'B', state: 'restart', city: 'Chicago' }, 'restore-b');
    assert.equal(session.view().experiment?.after?.indexes.B.verified, 3);
    await run({ kind: 'index', index: 'A', state: 'tamper', city: 'Chicago' }, 'tamper-a');
    const tampered = session.view();
    assert.equal(tampered.indexControls.A, 'altered');
    assert.ok((tampered.experiment?.after?.indexes.A.rejected ?? 0) >= 1);
    assert.ok(tampered.experiment?.after?.indexes.A.alteredNames.includes('Tampered unverified name'));
    assert.equal(tampered.experiment?.after?.indexes.B.verified, 3);
    assert.equal(tampered.experiment?.after?.services.length, 3);
    assert.equal(tampered.selection, null);
    await run({ kind: 'index', index: 'A', state: 'restart', city: 'Chicago' }, 'restore-a');
    assert.equal(session.view().indexControls.A, 'online');
    assert.equal(session.view().experiment?.after?.indexes.A.verified, 3);
    await session.reset(); await session.ready();
    assert.equal(session.view().experiment, null);
    assert.equal(session.view().discovery, null);
    assert.throws(() => session.frozenInput(), /no frozen observation/, 'reset destroys the prior generation checkpoint');
    await run({ kind: 'index', index: 'A', state: 'restart' }, 'stop-a');
    assert.equal(session.view().experiment, null, 'a reused operation ID cannot revive a previous generation experiment');
    await run({ kind: 'index', index: 'A', state: 'stop', city: 'Boston' }, 'no-prior');
    assert.equal(session.view().experiment?.before, null, 'a city without a prior comparison has none');
    const frozenBeforeLegacy = session.frozenInput();
    const priorService = session.view().discovery!.selected[0]!.service;
    await run({ kind: 'index', index: 'B', state: 'stop' }, 'legacy-control-only');
    assert.equal(session.view().discovery, null, 'legacy control-only actions cannot retain stale discovery');
    assert.equal(session.view().selection, null);
    assert.throws(() => session.select(priorService), /identity not returned by discovery/, 'historical replay input cannot authorize a current selection');
    const historical = session.frozenInput();
    assert.deepEqual(historical.observation, frozenBeforeLegacy.observation, 'the fixed historical basis survives an Index control');
    assert.deepEqual(historical.services, frozenBeforeLegacy.services, 'historical service input remains available for private replay');
  });
});

test('queued Index action does not corrupt an in-flight discovery input', { timeout: 360000 }, async () => {
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready();
    await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }, 'queued-basis').id);
    const bOrigin = session.frozenInput().indexes[1]!.origin;
    const originalFetch = globalThis.fetch;
    let release!: () => void; let blocked = false;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    // Delay one real Index B request after the operation has built discovery input.
    // The response is still obtained from the owned Index, not replaced by a mock.
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!blocked && url.startsWith(bOrigin)) { blocked = true; await hold; }
      return originalFetch(input, init);
    };
    try {
      const first = session.start({ kind: 'index', index: 'A', state: 'stop', city: 'Chicago' }, 'queued-first');
      const deadline = Date.now() + 30000;
      while (!blocked) {
        assert.ok(Date.now() < deadline, 'fresh discovery should reach Index B');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const second = session.start({ kind: 'index', index: 'A', state: 'restart', city: 'Chicago' }, 'queued-second');
      release();
      assert.equal((await session.wait(first.id)).state, 'completed');
      assert.equal((await session.wait(second.id)).state, 'completed');
    } finally { release(); globalThis.fetch = originalFetch; }
    const after = session.view();
    assert.equal(after.experiment?.action, 'restart');
    assert.equal(after.experiment?.after?.indexes.A.verified, 3);
    assert.equal(after.experiment?.after?.indexes.B.verified, 3);
  });
});

test('operator recovery invalidates the old endpoint and reads the migrated endpoint for the same city', { timeout: 360000 }, async () => {
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready();
    await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }, 'before-recovery').id);
    const before = session.view();
    const operator = before.operators[0]!;
    const cityId = operator.services.find((service) => service.city === 'Chicago')!.agentId;
    const oldEndpoint = before.discovery!.selected.find((candidate) => candidate.agent.agentId === cityId)!.profile.endpoint;
    session.select(before.discovery!.selected[0]!.service);
    const priorRead = session.start({ kind: 'refresh', city: 'Boston' }, 'read-queued-before-recovery');
    const operation = session.start({ kind: 'recover', operatorId: operator.id }, 'recover-with-readback');
    assert.equal(session.view().selection, null);
    assert.equal(session.view().discovery, null, 'old pre-migration endpoint must not be current while recovery runs');
    assert.equal((await session.wait(priorRead.id)).state, 'completed');
    const deadline = Date.now() + 5000;
    while (session.view().operations.find((entry) => entry.id === operation.id)?.state === 'queued' || session.view().discovery) {
      assert.ok(Date.now() < deadline, 'recovery must clear an earlier queued read again at execution');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(session.view().discovery, null);
    assert.equal((await session.wait(operation.id)).state, 'completed');
    const after = session.view();
    assert.equal(after.recoveryCheck?.status, 'observed');
    assert.equal(after.recoveryCheck?.city, 'Chicago');
    assert.deepEqual(after.operators[0]!.services.map((service) => service.agentId), operator.services.map((service) => service.agentId));
    const current = after.discovery?.selected.find((candidate) => candidate.agent.agentId === cityId);
    assert.ok(current?.profile.endpoint);
    assert.notEqual(current.profile.endpoint, oldEndpoint);
    assert.equal(after.recoveryCheck?.endpoint, current.profile.endpoint);
  });
});

test('session exposes fresh raw-evidence reconstruction and owns cancellation of the real origin comparison', { timeout: 360000 }, async (t) => {
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    const server = await startSessionServer(session); t.after(() => server.close());
    const starting = await (await fetch(server.origin)).text();
    assert.match(starting, /The city is getting ready/);
    const refreshForm = starting.match(/<form\b[^]*?<\/form>/g)?.find((form) => form.includes('name="action" value="refresh"'));
    assert.ok(refreshForm, 'city comparison form should render during startup');
    assert.match(refreshForm, /<button[^>]*disabled/, 'comparison must remain disabled until local resources are ready');
    await session.ready();
    assert.doesNotThrow(() => session.start({ kind: 'fresh-consumer' }, 'before-discovery'));
    assert.equal((await session.wait('before-discovery')).state, 'failed');
    const post = async (action: Record<string, string>) => {
      const html = await (await fetch(server.origin)).text();
      const token = /name="token" value="([^"]+)"/.exec(html)![1]!;
      return fetch(`${server.origin}/action`, { method: 'POST', redirect: 'manual', headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, generation: String(session.view().generation), ...action }) });
    };
    assert.equal((await post({ action: 'refresh', city: 'Boston', operationId: 'boston' })).status, 303); await session.wait('boston');
    assert.match(await (await fetch(server.origin)).text(), /Boston · discovery complete/);
    const candidate = session.view().discovery!.selected[0]!;
    assert.equal((await post({ action: 'select', service: candidate.service, operationId: 'select' })).status, 303);
    assert.equal(session.view().invocations.length, 0);
    assert.equal((await post({ action: 'invoke', reviewer: 'accepted', operationId: 'ask' })).status, 303); await session.wait('ask');
    assert.match(await (await fetch(server.origin)).text(), /Boston Fixture/);
    assert.equal((await post({ action: 'feedback', invocationId: 'ask', value: '5', operationId: 'rating' })).status, 303); await session.wait('rating');
    assert.match(await (await fetch(server.origin)).text(), /This review counts toward your policy score/);
    const first = session.start({ kind: 'fresh-consumer' }, 'fresh'); await session.wait(first.id);
    assert.equal(session.view().freshConsumer?.status, 'matched');
    assert.equal(session.view().freshConsumer?.observation.blockHash, session.view().discovery?.observation.blockHash);
    const origin = session.start({ kind: 'origin-comparison' }, 'origin');
    const until = Date.now() + 90000;
    while (session.view().originComparison?.phase !== 'indexes-ready') {
      assert.ok(Date.now() < until, 'real comparison must acquire its owned Indexes');
      await new Promise((r) => setTimeout(r, 10));
    }
    const reset = session.reset(); const settled = await session.wait(origin.id); await reset;
    assert.equal(settled.state, 'cancelled'); assert.equal(session.view().generation, 1);
    assert.equal(session.view().originComparison, null); assert.equal(session.view().freshConsumer, null);
    await session.ready(); assert.equal(session.view().status, 'ready');
    await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
    let child: ChildProcess | undefined, spawned!: () => void;
    const started = new Promise<void>((resolve) => { spawned = resolve; });
    const original = childProcess.spawn;
    const spy = t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof childProcess.spawn>) => {
      const result = original(...args);
      if (Array.isArray(args[1]) && args[1].some((arg) => /rankingConsumerCli\.(?:js|ts)$/.test(arg))) { child = result; spawned(); }
      return result;
    }) as typeof childProcess.spawn); syncBuiltinESMExports();
    try {
      const pending = session.start({ kind: 'fresh-consumer' }, 'cancel-consumer'); await started;
      const wait = session.wait(pending.id), resetting = session.reset();
      assert.equal((await wait).state, 'cancelled'); await resetting;
      assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'reset must await physical consumer termination');
      assert.equal(session.view().freshConsumer, null);
    } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  });
});
