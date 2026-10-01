import assert from 'node:assert/strict';
import test from 'node:test';
import { withDemoSession } from '../../src/demo/sessionController.js';
import { startSessionServer } from '../../src/demo/sessionServer.js';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

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
    assert.match(await (await fetch(server.origin)).text(), /Effect on next selection: contributing/);
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
