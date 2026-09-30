import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { syntheticEveningPlan } from '../../src/a2a/answer.js';
import { BaseError, createPublicClient, createTestClient, http } from 'viem';
import { dirname } from 'node:path';
import { readPrivateFile } from '../../src/safe/privateFile.js';
import { rpcTask } from '../../src/client/externalClient.js';
import { filterForCity } from '../../src/client/externalClient.js';
import { verifyJourneyEvidence, type JourneyEvidence } from '../../src/demo/journeyReport.js';
import { startSessionServer } from '../../src/demo/sessionServer.js';

async function resetOverHttp(session: import('../../src/demo/sessionController.js').DemoSession) {
  let reset!: Promise<void>;
  const web = await startSessionServer({ ...session, reset: () => { reset = session.reset(); return reset; } });
  try {
    const page = await (await fetch(web.origin)).text(), token = /name="token" value="([^"]+)"/.exec(page)![1]!;
    const response = await fetch(`${web.origin}/action`, { method: 'POST', redirect: 'manual',
      headers: { origin: web.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, generation: String(session.view().generation), operationId: 'http-reset', action: 'reset' }) });
    assert.equal(response.status, 303); assert.ok(reset); return { reset };
  } finally { await web.close(); }
}

async function consumer(input: unknown) {
  return new Promise<{ policyResult: unknown; policyInput: unknown }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/reputation/fixtures/rankingEvidenceWorker.ts'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH }, timeout: 60000 });
    const chunks: Buffer[] = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject); child.once('close', (code) => {
      if (code !== 0) reject(new Error('fresh consumer failed')); else resolve(JSON.parse(Buffer.concat(chunks).toString()));
    }); child.stdin.end(JSON.stringify(input, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  });
}

test('OpenClaw-shaped execution preserves requested inputs, signed evidence, longer bounded execution and feedback', { timeout: 240000 }, async () => {
  const { withDemoSession, demoEveningInput } = await import('../../src/demo/sessionController.js');
  const { composeSpecialistAnswer } = await import('../../src/demo/openclaw.js');
  let received: unknown;
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready(); assert.equal(session.view().answerEngine, 'openclaw');
    assert.equal((await session.wait(session.start({ kind: 'refresh', city: 'Boston' }, 'ai-discovery').id)).state, 'completed');
    session.select(session.view().discovery!.selected[0]!.service);
    const input = { ...demoEveningInput('Boston'), budget: { currency: 'USD' as const, minorUnits: '4000' }, preferences: ['Low cost'] };
    const operation = await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input }, 'ai-evening').id);
    assert.equal(operation.state, 'completed'); assert.deepEqual(received, input);
    const invocation = session.view().invocations[0]!;
    assert.equal(invocation.outcome, 'completed'); assert.equal(invocation.checkedResult, 'matched');
    const answer = JSON.parse(invocation.answer!); assert.equal(answer.budget.estimatedTotalMinorUnits, 2200);
    assert.equal(answer.modelSynthesis.text, 'The lower-cost option leaves room in the example budget.');
    assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: 'ai-evening', value: 5 }, 'ai-rating').id)).state, 'completed');
    assert.equal(session.view().feedback[0]!.readBack, 'matched'); assert.equal(session.view().feedback[0]!.weighting, 'contributing');
  }, { answerEngine: 'openclaw', executionTimeoutMs: 60000, executor: ({ emphasis }) => async (request, context) => {
    received = request.input;
    await new Promise<void>((resolve, reject) => { const stop = () => { clearTimeout(timer); reject(new Error('aborted')); };
      const timer = setTimeout(() => { context.signal.removeEventListener('abort', stop); resolve(); }, 5500);
      context.signal.addEventListener('abort', stop, { once: true }); });
    return composeSpecialistAnswer(request.input, emphasis, JSON.stringify({ status: 'ok', summary: 'completed',
      result: { payloads: [{ text: JSON.stringify({ choice: 'travel-value', summary: 'The lower-cost option leaves room in the example budget.',
        tradeoffs: ['Self-guided activity.'], uncertainties: ['Not live checked.'] }) }], meta: { aborted: false, stopReason: 'stop',
        agentMeta: { provider: 'openai', model: 'gpt-6-luna', usage: { input: 7500, output: 120, cacheRead: 0, total: 7620 },
          terminalReceipt: { successfulToolNames: [], rerouted: false } } } } }));
  } });
});

test('owned interactive session initializes three separated Safe operators without sending work', { timeout: 240000 }, async (t) => {
  const module = await import('../../src/demo/sessionController.js').catch(() => undefined);
  assert.ok(module?.withDemoSession, 'owned headless session capability must exist');
  assert.ok(process.env.NANDA_INDEX_CHECKOUT);
  await module.withDemoSession(process.env.NANDA_INDEX_CHECKOUT, async (session) => {
    assert.equal(session.view().status, 'starting');
    await session.ready();
    const view = session.view();
    assert.equal(view.status, 'ready'); assert.equal(view.operators.length, 3);
    assert.equal(new Set(view.operators.map((operator) => operator.safe)).size, 3);
    for (const operator of view.operators) {
      assert.equal(operator.services.length, 2);
      assert.deepEqual(operator.services.map((service) => service.city), ['Chicago', 'Boston']);
      assert.equal(operator.services.every((service) => service.status === 'verified'), true);
    }
    assert.equal(view.crossOperatorWrite, 'rejected');
    assert.deepEqual(view.invocations, []);
    assert.equal(JSON.stringify(view).includes('privateKey'), false);
    assert.equal(JSON.stringify(view).includes('journalDirectory'), false);
    await t.test('discovery selects without sending; operation identity prevents duplicate work and refresh is read-only', async () => {
      assert.equal(typeof session.start, 'function', 'session exposes explicit operations');
      const refresh = session.start({ kind: 'refresh', city: 'Chicago' }, 'initial-refresh');
      assert.equal(refresh.state, 'running'); await session.wait(refresh.id);
      const discovered = session.view().discovery;
      assert.equal(discovered?.selected.length, 3); assert.equal(discovered?.ranking.snapshot, 'matched');
      assert.deepEqual(discovered.ranking.policyResult!.selection.rated, []);
      assert.equal(discovered.ranking.policyResult!.selection.newcomers.length, 3);
      const chosen = discovered.selected[0]!;
      session.select(chosen.service);
      assert.equal(session.view().invocations.length, 0);
      const operation = session.start({ kind: 'invoke', reviewer: 'accepted' }, 'first-invoke');
      assert.equal(operation.state, 'running'); await session.wait(operation.id);
      const invocation = session.view().invocations[0]!;
      assert.equal(invocation.sent, true); assert.equal(invocation.accepted, true);
      assert.equal(invocation.outcome, 'completed'); assert.equal(invocation.checkedResult, 'matched');
      session.start({ kind: 'invoke', reviewer: 'accepted' }, 'first-invoke'); await session.wait('first-invoke');
      const retry = session.start({ kind: 'retry', invocationId: 'first-invoke' }, 'retry-first'); await session.wait(retry.id);
      assert.equal(session.view().invocations.length, 1);
      assert.equal(session.view().invocations[0]!.taskId, invocation.taskId);
      assert.equal(session.view().invocations[0]!.requestDigest, invocation.requestDigest);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      assert.equal(session.view().invocations.length, 1);
      const serialized = JSON.stringify(session.view());
      assert.equal(serialized.includes('cardBase64'), false); assert.equal(serialized.includes('payloadBase64'), false);
      assert.equal(serialized.includes('/private/'), false);
      session.select(chosen.service);
      await createTestClient({ mode: 'anvil', transport: http(session.frozenInput().rpcOrigin) }).mine({ blocks: 1 });
      const stale = await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted' }).id);
      assert.equal(stale.state, 'failed'); assert.equal(session.view().selection, null);
      assert.equal(session.view().invocations.length, 1);
    });
    await t.test('feedback records independent stages, changes accepted ranking, and leaves new reviewers unweighted', async (subtest) => {
      assert.ok(session.view().feedback, 'session exposes feedback stages');
      const operation = session.start({ kind: 'feedback', invocationId: 'first-invoke', value: 5 }, 'first-feedback');
      assert.equal((await session.wait(operation.id)).state, 'completed');
      const feedback = session.view().feedback[0]!;
      assert.equal(feedback.signed, true); assert.equal(feedback.publication, 'observed');
      assert.equal(feedback.readBack, 'matched'); assert.deepEqual(feedback.retained, { A: true, B: true });
      assert.equal(feedback.weighting, 'contributing');
      assert.equal(session.view().discovery!.ranking.policyResult!.selection.rated.length, 1);
      session.select(session.view().discovery!.selected[0]!.service);
      const directory = dirname(session.frozenInput().privateBundleFiles[0]!.path!);
      const fetcher = globalThis.fetch; let taskId: string | undefined; let durableBeforeSend = false;
      const lostReply = subtest.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
        if (body?.method !== 'message/send') return fetcher(...args);
        const saved = JSON.parse((await readPrivateFile(directory, 'new-invoke.request.json', 128 * 1024))!.toString());
        assert.deepEqual(saved.params, body.params); durableBeforeSend = true;
        const response = await fetcher(...args); const result = await response.json() as { result: { id: string } };
        taskId = result.result.id; throw new Error('owned post-acceptance response loss');
      });
      try { await session.wait(session.start({ kind: 'invoke', reviewer: 'new', fail: true }, 'new-invoke').id); }
      finally { lostReply.mock.restore(); }
      assert.equal(durableBeforeSend, true); assert.equal(session.view().invocations[1]!.outcome, 'unresolved');
      const digest = session.view().invocations[1]!.requestDigest;
      await session.wait(session.start({ kind: 'retry', invocationId: 'new-invoke' }).id);
      assert.equal(session.view().invocations[1]!.taskId, taskId); assert.equal(session.view().invocations[1]!.requestDigest, digest);
      assert.equal(session.view().invocations[1]!.outcome, 'failed');
      await session.wait(session.start({ kind: 'feedback', invocationId: 'new-invoke', value: 1 }, 'new-feedback').id);
      const outsider = session.view().feedback[1]!;
      assert.equal(outsider.readBack, 'matched'); assert.deepEqual(outsider.retained, { A: true, B: true });
      assert.equal(outsider.weighting, 'reviewer-not-accepted');
      const count = session.view().feedback.length;
      await session.wait(session.start({ kind: 'retry-feedback', feedbackId: 'first-feedback' }).id);
      assert.equal(session.view().feedback.length, count);
    });
    await t.test('both independent verifier card reads receive physical cancellation', async (subtest) => {
      const raw = session.frozenInput();
      const evidence = JSON.parse((await readPrivateFile(dirname(raw.privateBundleFiles[0]!.path!), 'first-invoke.evidence.json', 1024 * 1024))!.toString()) as JourneyEvidence;
      for (const ordinal of [1, 2]) {
        let entered!: () => void; let closed!: () => void;
        const arrived = new Promise<void>((r) => { entered = r; }); const disconnected = new Promise<void>((r) => { closed = r; });
        const server = createServer((_request, response) => { response.on('close', closed); response.writeHead(200); response.write('{'); entered(); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const original = globalThis.fetch; let cards = 0;
        const intercept = subtest.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (String(input) === evidence.candidate.declaration.url && ++cards === ordinal) return original(`http://127.0.0.1:${address.port}`, init);
          return original(input, init);
        });
        const abort = new AbortController(); const timer = setTimeout(() => server.closeAllConnections(), 2000);
        const pending = verifyJourneyEvidence(evidence, createPublicClient({ transport: http(raw.rpcOrigin, { retryCount: 0 }) }), raw.identityDomain,
          filterForCity('Chicago'), raw.cardOrigin, undefined, abort.signal);
        try { await arrived; abort.abort(new Error('session reset')); assert.equal((await pending).evidenceUsable, false); await disconnected; }
        finally { clearTimeout(timer); intercept.mock.restore(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
      }
    });
    await t.test('real A faults preserve B and a new consumer rebuilds the frozen ranking after provider loss and Index restart', async () => {
      const stop = session.start({ kind: 'index', index: 'A', state: 'stop' }); await session.wait(stop.id);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      assert.equal(session.view().discovery!.selected.length, 3);
      assert.equal(session.view().discovery!.origins[0]!.status, 'unavailable');
      await session.wait(session.start({ kind: 'index', index: 'A', state: 'start' }).id);
      await session.wait(session.start({ kind: 'index', index: 'A', state: 'tamper' }).id);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      assert.equal(session.view().discovery!.selected.length, 3);
      assert.equal(session.view().discovery!.origins[0]!.status, 'partial');
      assert.ok(session.view().discovery!.origins[0]!.errors.length > 0);
      await session.wait(session.start({ kind: 'index', index: 'A', state: 'stop' }).id);
      await session.wait(session.start({ kind: 'index', index: 'B', state: 'stop' }).id);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      assert.equal(session.view().discovery!.status, 'unavailable'); assert.deepEqual(session.view().discovery!.selected, []);
      await session.wait(session.start({ kind: 'index', index: 'A', state: 'start' }).id);
      await session.wait(session.start({ kind: 'index', index: 'B', state: 'start' }).id);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      const expected = session.view().discovery!.ranking.policyResult;
      const originalResult = session.view().invocations[0];
      await session.wait(session.start({ kind: 'stop-providers' }).id);
      await session.wait(session.start({ kind: 'retry', invocationId: 'first-invoke' }).id);
      assert.deepEqual(session.view().invocations[0], originalResult, 'terminal historical observations must not be rewritten by replay after provider loss');
      await session.wait(session.start({ kind: 'index', index: 'A', state: 'restart' }).id);
      await session.wait(session.start({ kind: 'index', index: 'B', state: 'restart' }).id);
      const raw = session.frozenInput(); assert.equal(raw.privateBundleFiles.length, 2);
      assert.deepEqual((await consumer(raw)).policyResult, expected);
    });
    await t.test('immutable feedback slots exhaust without overwriting prior documents', async () => {
      const first = session.view().feedback[0]!.documentHash;
      while (!session.view().feedbackCapacity.exhausted) {
        const result = await session.wait(session.start({ kind: 'feedback', invocationId: 'first-invoke', value: 4 }).id);
        assert.equal(result.state, 'completed');
      }
      assert.equal(session.view().feedbackCapacity.used, 8);
      const denied = await session.wait(session.start({ kind: 'feedback', invocationId: 'first-invoke', value: 1 }).id);
      assert.equal(denied.state, 'failed'); assert.equal(session.view().feedbackCapacity.used, 8);
      assert.equal(session.view().feedback[0]!.documentHash, first);
    });
    await t.test('recovery preserves both IDs, invalidates selection, rejects retired owner and keeps old observations', async () => {
      const before = session.view(); const reviewedId = before.invocations[0]!.service.split('/').at(-1);
      const operator = before.operators.find((item) => item.services.some((service) => service.agentId === reviewedId))!;
      const oldResult = before.invocations[0];
      const operation = session.start({ kind: 'recover', operatorId: operator.id });
      const result = await session.wait(operation.id);
      assert.equal(result.state, 'completed');
      const recovered = session.view().operators.find((item) => item.id === operator.id)!;
      assert.equal(recovered.safe, operator.safe); assert.deepEqual(recovered.services.map((item) => item.agentId), operator.services.map((item) => item.agentId));
      assert.equal(recovered.recovery?.restoredInFreshProcess, true); assert.equal(recovered.recovery?.retiredOwnerRejected, true);
      assert.equal(recovered.recovery?.report.ownerStatus, 'verified');
      assert.equal(session.view().selection, null); assert.deepEqual(session.view().invocations[0], oldResult);
      await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
      const candidate = session.view().discovery!.selected.find((item) => item.agent.agentId === operator.services[0]!.agentId)!;
      const history = session.view().discovery!.ranking.policyResult!.candidates.find((item) => item.service === candidate.service)!;
      assert.ok(history.reviews.some((review) => review.epoch === 'retired' && review.historyQualification === 'committed-before-runtime-retirement'));
      const oldRequest = JSON.parse((await readPrivateFile(dirname(session.frozenInput().privateBundleFiles[0]!.path!), 'first-invoke.request.json', 128 * 1024))!.toString());
      await assert.rejects(rpcTask(candidate.profile.endpoint, 'message/send', oldRequest.params), /rejected/);
      session.select(candidate.service); await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted' }, 'recovered-invoke').id);
      assert.equal(session.view().invocations.at(-1)!.checkedResult, 'matched');
      await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', fail: true }, 'recovered-failure').id);
      assert.equal(session.view().invocations.at(-1)!.outcome, 'failed');
      assert.equal(session.view().invocations.at(-1)!.checkedResult, 'matched');
    });
  });
});

test('reset remains reachable during real execution, settles resources, and rejects the old generation', { timeout: 120000 }, async () => {
  const { withDemoSession } = await import('../../src/demo/sessionController.js');
  let entered!: () => void; let aborted!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const cancelled = new Promise<void>((r) => { aborted = r; });
  const held = new Promise<void>((r) => { release = r; });
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready(); await session.wait(session.start({ kind: 'refresh', city: 'Chicago' }).id);
    session.select(session.view().discovery!.selected[0]!.service);
    const signalOwners = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') };
    const operation = session.start({ kind: 'invoke', reviewer: 'accepted' }, 'cancel-me');
    await started; assert.equal(session.view().operations.find((item) => item.id === operation.id)!.state, 'running');
    assert.equal(process.listenerCount('SIGINT'), signalOwners.interrupt, 'queued action must share the fixture OS-signal owner');
    assert.equal(process.listenerCount('SIGTERM'), signalOwners.terminate, 'queued action must share the fixture OS-signal owner');
    assert.throws(() => session.select(session.view().discovery!.selected[1]!.service), /running/);
    const { reset } = await resetOverHttp(session);
    assert.equal(session.reset(), reset, 'overlapping reset calls share one cleanup and cannot launch orphan generations');
    assert.equal(session.view().status, 'resetting'); assert.ok(session.view().lifecycleOperationId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cancelled, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error('reset did not abort executor')), 1000); })]);
    } finally { clearTimeout(timer); release(); await reset; }
    assert.equal(session.view().generation, 1); assert.equal(session.view().status, 'starting');
    await assert.rejects(session.wait(operation.id), /unknown operation/);
  }, { executor: () => async (request, context) => {
    const stop = () => { aborted(); release(); };
    context.signal.addEventListener('abort', stop, { once: true }); entered();
    try { await held; context.signal.throwIfAborted(); return syntheticEveningPlan(request); }
    finally { context.signal.removeEventListener('abort', stop); }
  } });
});

test('fixture session refuses a licensed executor before it can run under fixture persistence', { timeout: 120000 }, async () => {
  const { withDemoSession } = await import('../../src/demo/sessionController.js'); let executed = false;
  await assert.rejects(withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await assert.rejects(session.ready(), /unavailable/);
  }, { executor: () => Object.assign(async () => { executed = true; return new Uint8Array([1]); }, {
    retention: { kind: 'licensed' as const, policyId: 'not-a-fixture', expiresAt: '2026-10-04T20:00:00Z',
      export: 'receipts-only' as const, persistContent: false as const } }) }), /acquisition or cleanup failed/);
  assert.equal(executed, false);
});

test('reset during physical chain acquisition unwinds before a new generation starts', { timeout: 30000 }, async (t) => {
  const { withDemoSession } = await import('../../src/demo/sessionController.js');
  let entered!: () => void; let disconnected!: () => void;
  const arrived = new Promise<void>((r) => { entered = r; }); const closed = new Promise<void>((r) => { disconnected = r; });
  const server = createServer((_req, res) => { res.on('close', disconnected); res.writeHead(200); res.write('{'); entered(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const original = globalThis.fetch; let intercepted = false; let parentFunded = false;
  const intercept = t.mock.method(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => {
    const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
    if (body?.method === 'anvil_setBalance') parentFunded = true;
    // Anvil readiness precedes funding. This later numbered genesis read is
    // performed by the support-deployment helper's injected owned parent client.
    if (!intercepted && parentFunded && body?.method === 'eth_getBlockByNumber' && body.params[0] === '0x0') {
      intercepted = true; return original(`http://127.0.0.1:${address.port}`, args[1]);
    }
    return original(...args);
  });
  try {
    await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
      await Promise.race([arrived, session.ready().then(() => { throw new Error('parent acquisition settled without the physical read barrier'); })]);
      assert.equal(session.view().status, 'starting');
      const { reset } = await resetOverHttp(session); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('parent chain read outlived cancellation')), 1000);
        })]);
        await reset; assert.equal(session.view().generation, 1);
      } finally { clearTimeout(timer); server.closeAllConnections(); await reset; }
    });
  } finally { intercept.mock.restore(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test('an unrelated viem failure is not hidden by concurrent session cancellation', { timeout: 30000 }, async (t) => {
  const { withSessionFixture } = await import('../../src/demo/sessionFixture.js');
  const cancellation = new AbortController(), reason = new Error('session reset'), unrelated = new Error('independent RPC failure');
  const original = globalThis.fetch; let parentFunded = false;
  const intercept = t.mock.method(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => {
    const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
    if (body?.method === 'anvil_setBalance') parentFunded = true;
    if (parentFunded && body?.method === 'eth_getBlockByNumber' && body.params[0] === '0x0') {
      cancellation.abort(reason); return Promise.reject(unrelated);
    }
    return original(...args);
  });
  try {
    await assert.rejects(withSessionFixture(process.env.NANDA_INDEX_CHECKOUT!, cancellation.signal,
      async () => { throw new Error('unexpected acquisition'); }),
    (error) => error instanceof BaseError && error.walk((cause) => cause === unrelated) === unrelated);
  } finally { intercept.mock.restore(); }
});

// Recovery first acquires all three real Safe operators and both Indexes, then
// exports the backup before reaching its RPC barrier. Keep that whole-test
// budget separate from the unchanged one-second physical cancellation check.
for (const phase of ['onboarding', 'recovery'] as const) test(`reset closes the actual ${phase} Safe RPC and owned wallet child`, { timeout: phase === 'recovery' ? 240000 : 120000 }, async (t) => {
  const started = performance.now();
  const checkpoint = (label: string) => t.diagnostic(`${phase}: ${label} at ${Math.round(performance.now() - started)}ms`);
  const { withDemoSession } = await import('../../src/demo/sessionController.js');
  let entered!: () => void; let disconnected!: () => void; let physicalClosed = false;
  const arrived = new Promise<void>((resolve) => { entered = resolve; });
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const server = createServer((_request, response) => {
    response.on('close', () => { physicalClosed = true; disconnected(); });
    response.writeHead(200); response.write('{'); entered();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const barrier = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch; const originalFork = childProcess.fork;
  let wallet: ChildProcess | undefined; let armed = phase === 'onboarding'; let parentSafeRead = false; let barrierFailure: unknown;
  const supportAddresses = new Set<string>();
  const fetchProbe = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
    if (armed && body?.method === 'eth_getCode' && supportAddresses.has(body.params[0].toLowerCase())) {
      parentSafeRead = true; return originalFetch(barrier, args[1]);
    }
    const response = await originalFetch(...args);
    if (body?.method === 'eth_getTransactionReceipt' && supportAddresses.size < 5) {
      const receipt = await response.clone().json() as { result?: { contractAddress?: string } };
      if (receipt.result?.contractAddress) supportAddresses.add(receipt.result.contractAddress.toLowerCase());
    }
    return response;
  });
  // Test-only transport fault below the unchanged real Safe APIs. The original
  // network binding, IPC credentials, wallet algorithms and journal stay intact.
  const forkProbe = t.mock.method(childProcess, 'fork', ((path: string | URL, args: readonly string[], options: childProcess.ForkOptions) => {
    if (!armed || !/session(?:Recovery|Wallet)Worker\.(?:ts|js)$/.test(String(path))) return originalFork(path, args, options);
    const preload = `let targets = new Set(); const once = process.once;
      process.once = function(event, listener) { return once.call(this, event, event !== 'message' ? listener : input => {
        const network = input.network ?? input.config?.network ?? input.binding?.network;
        if (${JSON.stringify(phase)} === 'onboarding' || input.kind === 'recover' || !input.kind)
          targets = new Set(Object.values(network?.contracts ?? {}).map(value => value.address.toLowerCase()));
        listener(input); }); };
      const original = globalThis.fetch; let held = false;
      globalThis.fetch = (input, init) => { const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (!held && body?.method === 'eth_getCode' && targets.has(body.params[0].toLowerCase())) {
          held = true; return original(${JSON.stringify(barrier)}, init); }
        return original(input, init); };`;
    wallet = originalFork(path, args, { ...options, execArgv: [...(options.execArgv ?? []), '--import', `data:text/javascript,${encodeURIComponent(preload)}`] });
    return wallet;
  }) as typeof childProcess.fork);
  syncBuiltinESMExports();
  try {
    await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
      checkpoint('fixture acquisition started');
      let work: Promise<unknown> = session.ready();
      if (phase === 'recovery') { await work; checkpoint('fixture ready; recovery starting'); armed = true;
        work = session.wait(session.start({ kind: 'recover', operatorId: session.view().operators[0]!.id }, 'held-recovery').id); }
      await Promise.race([arrived, work.then(() => { throw new Error('wallet work settled without the physical RPC barrier'); })]);
      checkpoint('Safe RPC barrier reached');
      const child = wallet; let timer: ReturnType<typeof setTimeout> | undefined;
      const reset = session.reset(); armed = false;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('actual Safe RPC outlived caller cancellation')), 1000);
        })]);
        checkpoint('Safe RPC physically closed');
        await reset; assert.equal(physicalClosed, true);
        checkpoint('reset cleanup completed');
        assert.ok(child?.pid, 'actual wallet child was running at the RPC barrier');
        assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
        assert.equal(parentSafeRead, false, 'Safe internals must not run in the parent');
        assert.equal(session.view().generation, 1);
      } catch (error) { barrierFailure = error; throw error; }
      finally { clearTimeout(timer); server.closeAllConnections(); await reset.catch((error) => { if (!barrierFailure) throw error; }); }
    });
    checkpoint('session close completed');
  } catch (error) { throw barrierFailure ?? error;
  } finally {
    fetchProbe.mock.restore(); forkProbe.mock.restore(); syncBuiltinESMExports();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
