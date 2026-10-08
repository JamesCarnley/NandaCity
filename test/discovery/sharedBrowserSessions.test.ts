import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharedBrowserSessions } from '../../src/demo/sharedBrowserSessions.js';
import type { DemoSession, SessionAction, SessionOperation, SessionView } from '../../src/demo/sessionController.js';

type City = 'Chicago' | 'Boston';

function discovery(city: City): NonNullable<SessionView['discovery']> {
  return { city, status: 'complete', eligibleCount: 1,
    selected: [{ service: `${city}-service`, agent: { chainId: 31337,
      registry: '0x0000000000000000000000000000000000000001', agentId: city === 'Chicago' ? '1' : '2' } }],
    candidates: [], origins: [], ranking: { snapshot: 'matched', policyResult: null },
    observation: { blockNumber: '1', blockHash: '0x00' } } as unknown as NonNullable<SessionView['discovery']>;
}

function view(): SessionView {
  return { mode: 'fixture', generation: 0, status: 'ready', lifecycleOperationId: 'life', operators: [],
    crossOperatorWrite: 'not-tested', invocations: [], discovery: null, selection: null, operations: [], feedback: [],
    freshConsumer: null, originComparison: null, indexControls: { A: 'online', B: 'online' }, indexRead: null,
    experiment: null, recoveryCheck: null, feedbackCapacity: { total: 8, used: 0, exhausted: false }, limitations: [] };
}

function baseFixture(onWait?: (action: SessionAction, id: string, state: SessionView) => Promise<'failed' | void> | 'failed' | void) {
  const state = view(), actions: SessionAction[] = [];
  const operations = new Map<string, { action: SessionAction; operation: SessionOperation }>();
  const base: DemoSession = {
    view: () => structuredClone(state), ready: async () => {}, select: (service) => { state.selection = service; },
    start: (action, id = 'base-operation') => {
      actions.push(action);
      const operation: SessionOperation = { id, generation: 0, kind: action.kind, state: 'running' };
      state.operations.push(operation);
      // The real base invalidates discovery synchronously, but retains its city in the recovery check.
      if (action.kind === 'recover') {
        state.recoveryCheck = { operatorId: action.operatorId, city: state.discovery?.city ?? null,
          status: 'recovering', endpoint: null, reason: 'Recovery started.' };
        state.discovery = null; state.selection = null;
      }
      if (action.kind === 'index') {
        state.discovery = null; state.selection = null;
        state.experiment = action.city ? { target: action.index, action: action.state, city: action.city,
          phase: 'applying', before: null, after: null, note: 'Index control started.' } : null;
      }
      operations.set(id, { action, operation }); return structuredClone(operation);
    },
    wait: async (id) => {
      const entry = operations.get(id); assert.ok(entry);
      const result = await onWait?.(entry.action, id, state);
      if (entry.action.kind === 'refresh') state.discovery = discovery(entry.action.city);
      if (entry.action.kind === 'recover' && result !== 'failed') {
        state.discovery = state.recoveryCheck?.city ? discovery(state.recoveryCheck.city) : null;
        if (state.recoveryCheck) state.recoveryCheck.status = state.recoveryCheck.city ? 'observed' : 'unavailable';
      }
      entry.operation.state = result === 'failed' ? 'failed' : 'completed';
      if (result === 'failed') entry.operation.error = 'controlled base failure';
      return structuredClone(entry.operation);
    },
    readContent: () => undefined, frozenInput: () => { throw new Error('no frozen input'); },
    reset: async () => {}, close: async () => {},
  };
  return { base, state, actions };
}

const run = async (session: DemoSession, action: SessionAction, id: string) => session.wait(session.start(action, id).id);

test('recovery checks the requesting browser city after another browser used the shared base', async () => {
  const fixture = baseFixture(), pool = createSharedBrowserSessions(fixture.base);
  const chicago = pool.open('a'.repeat(64)), boston = pool.open('b'.repeat(64));
  try {
    await run(chicago, { kind: 'refresh', city: 'Chicago' }, 'chicago-discovery');
    const competing = boston.start({ kind: 'refresh', city: 'Boston' }, 'boston-discovery');
    const pending = chicago.start({ kind: 'recover', operatorId: 'operator-1' }, 'chicago-recovery');
    assert.equal(chicago.view().discovery, null, 'old discovery is invalidated while recovery is queued');
    assert.equal((await boston.wait(competing.id)).state, 'completed');
    assert.equal((await chicago.wait(pending.id)).state, 'completed');
    assert.equal(chicago.view().recoveryCheck?.city, 'Chicago');
    assert.equal(chicago.view().discovery?.city, 'Chicago');
    assert.equal(boston.view().discovery?.city, 'Boston');
    assert.deepEqual(fixture.actions.slice(-2), [{ kind: 'refresh', city: 'Chicago' }, { kind: 'recover', operatorId: 'operator-1' }]);
  } finally { await pool.close(); }
});

test('failed temporary Index restore fences queued and future browser mutations', async () => {
  const fixture = baseFixture((action, _id, state) => {
    if (action.kind !== 'index') return;
    if (action.state === 'stop') {
      state.indexControls.A = 'offline'; state.discovery = null;
      state.experiment = { target: 'A', action: 'stop', city: 'Chicago', phase: 'failed', before: null, after: null,
        note: 'Index stop changed the control, but fresh discovery failed.' };
      return 'failed';
    }
    if (action.state === 'restart') {
      state.indexControls.A = 'unknown';
      return 'failed';
    }
  });
  const pool = createSharedBrowserSessions(fixture.base);
  const first = pool.open('a'.repeat(64)), second = pool.open('b'.repeat(64));
  try {
    const fault = first.start({ kind: 'index', index: 'A', state: 'stop', city: 'Chicago' }, 'temporary-fault');
    const queued = second.start({ kind: 'refresh', city: 'Boston' }, 'queued-behind-fault');
    assert.equal((await first.wait(fault.id)).state, 'failed');
    assert.equal((await second.wait(queued.id)).state, 'failed');
    assert.deepEqual(fixture.actions.map((action) => action.kind === 'index' ? `${action.index}:${action.state}` : action.kind),
      ['A:stop', 'A:restart'], 'the queued read must not run against an unrepaired Index');
    assert.equal(pool.status(), 'failed');
    assert.equal(first.view().indexControls.A, 'unknown');
    assert.equal(first.view().experiment?.phase, 'failed');
    assert.match(first.view().experiment?.note ?? '', /fresh discovery failed/);
    assert.match(first.view().experiment?.note ?? '', /restore failed/i);
    assert.equal(pool.open('c'.repeat(64)).view().indexControls.A, 'unknown',
      'a new browser must not see the failed Index as online');
    assert.match(first.view().operations[0]!.error ?? '', /restore failed/i);
    assert.throws(() => second.start({ kind: 'refresh', city: 'Boston' }, 'after-failure'), /repair or restart/i);
  } finally { await pool.close(); }
});

test('failed invocation exposes only its persisted entry and permits retry by browser ID', async () => {
  const fixture = baseFixture((action, id, state) => {
    if (action.kind === 'invoke') {
      state.invocations.push({ id, service: state.selection!, reviewer: action.reviewer, requestDigest: '0x00',
        sent: true, accepted: false, taskId: null, outcome: 'unresolved', checkedResult: 'unavailable', answer: null });
      return 'failed';
    }
    if (action.kind === 'retry') {
      const entry = state.invocations.find((item) => item.id === action.invocationId)!;
      entry.outcome = 'completed'; entry.checkedResult = 'matched';
    }
  });
  const pool = createSharedBrowserSessions(fixture.base), browser = pool.open('a'.repeat(64));
  try {
    await run(browser, { kind: 'refresh', city: 'Chicago' }, 'discover');
    browser.select('Chicago-service');
    assert.equal((await run(browser, { kind: 'invoke', reviewer: 'accepted' }, 'ask')).state, 'failed');
    assert.deepEqual(browser.view().invocations.map((item) => [item.id, item.outcome]), [['ask', 'unresolved']]);
    const global = fixture.state.invocations[0]!.id;
    assert.notEqual(global, 'ask');
    assert.equal((await run(browser, { kind: 'retry', invocationId: 'ask' }, 'retry-ask')).state, 'completed');
    assert.equal((fixture.actions.at(-1) as Extract<SessionAction, { kind: 'retry' }>).invocationId, global);
    assert.deepEqual(browser.view().invocations.map((item) => [item.id, item.outcome]), [['ask', 'completed']]);
  } finally { await pool.close(); }
});

test('failed feedback exposes only its persisted entry and permits retry by browser ID', async () => {
  const fixture = baseFixture((action, id, state) => {
    if (action.kind === 'invoke') state.invocations.push({ id, service: state.selection!, reviewer: action.reviewer,
      requestDigest: '0x00', sent: true, accepted: true, taskId: id, outcome: 'completed', checkedResult: 'matched', answer: 'ok' });
    if (action.kind === 'feedback') {
      state.feedback.push({ id, invocationId: action.invocationId, value: action.value, reviewer: 'accepted', slot: 0,
        documentHash: '0x00', signed: true, publication: 'unresolved', transactionHash: null, readBack: 'not-read',
        retained: { A: false, B: false }, weighting: 'not-assessed-at-this-observation', policyId: 'session-demo-reviewer-policy' });
      state.feedbackCapacity.used = 1;
      return 'failed';
    }
    if (action.kind === 'retry-feedback') state.feedback.find((item) => item.id === action.feedbackId)!.publication = 'observed';
  });
  const pool = createSharedBrowserSessions(fixture.base), browser = pool.open('a'.repeat(64));
  try {
    await run(browser, { kind: 'refresh', city: 'Chicago' }, 'discover');
    browser.select('Chicago-service');
    assert.equal((await run(browser, { kind: 'invoke', reviewer: 'accepted' }, 'ask')).state, 'completed');
    assert.equal((await run(browser, { kind: 'feedback', invocationId: 'ask', value: 5 }, 'review')).state, 'failed');
    assert.deepEqual(browser.view().feedback.map((item) => [item.id, item.invocationId, item.publication]),
      [['review', 'ask', 'unresolved']]);
    const global = fixture.state.feedback[0]!.id;
    assert.notEqual(global, 'review');
    assert.equal((await run(browser, { kind: 'retry-feedback', feedbackId: 'review' }, 'retry-review')).state, 'completed');
    assert.equal((fixture.actions.findLast((action) => action.kind === 'retry-feedback') as Extract<SessionAction, { kind: 'retry-feedback' }>).feedbackId, global);
    assert.deepEqual(browser.view().feedback.map((item) => [item.id, item.invocationId, item.publication]),
      [['review', 'ask', 'observed']]);
  } finally { await pool.close(); }
});

test('a failed invocation without a matching persisted entry does not claim unrelated shared work', async () => {
  const fixture = baseFixture((action) => action.kind === 'invoke' ? 'failed' : undefined);
  fixture.state.invocations.push({ id: 'unrelated-global', service: 'Boston-service', reviewer: 'new',
    requestDigest: '0x00', sent: true, accepted: true, taskId: 'elsewhere', outcome: 'completed', checkedResult: 'matched', answer: 'elsewhere' });
  const pool = createSharedBrowserSessions(fixture.base), browser = pool.open('a'.repeat(64));
  try {
    await run(browser, { kind: 'refresh', city: 'Chicago' }, 'discover');
    browser.select('Chicago-service');
    assert.equal((await run(browser, { kind: 'invoke', reviewer: 'accepted' }, 'ask')).state, 'failed');
    assert.deepEqual(browser.view().invocations, []);
    assert.equal((await run(browser, { kind: 'retry', invocationId: 'ask' }, 'retry')).state, 'failed');
    assert.match(browser.view().operations.at(-1)?.error ?? '', /unknown browser invocation/);
  } finally { await pool.close(); }
});

test('pending admission allows one action per browser and at most twelve across the shared fixture', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fixture = baseFixture(async (action) => { if (action.kind === 'refresh') await held; });
  const pool = createSharedBrowserSessions(fixture.base);
  const browsers = Array.from({ length: 13 }, (_, index) => pool.open(index.toString(16).padStart(64, '0')));
  try {
    const pending = browsers.slice(0, 12).map((browser, index) => browser.start({ kind: 'refresh', city: 'Chicago' }, `read-${index}`));
    assert.deepEqual(browsers[0]!.start({ kind: 'refresh', city: 'Chicago' }, 'read-0'), pending[0],
      'replaying the same operation ID must not consume another queue slot');
    assert.throws(() => browsers[0]!.start({ kind: 'refresh', city: 'Boston' }, 'second-read'), /pending action.*retry/i);
    assert.throws(() => browsers[12]!.start({ kind: 'refresh', city: 'Chicago' }, 'thirteenth-read'), /busy.*retry/i);
    assert.equal(browsers[12]!.view().operations.length, 0, 'rejected work must not be queued');
    release();
    assert.deepEqual((await Promise.all(browsers.slice(0, 12).map((browser, index) => browser.wait(pending[index]!.id))))
      .map((item) => item.state), Array(12).fill('completed'));
    assert.equal((await run(browsers[12]!, { kind: 'refresh', city: 'Boston' }, 'after-drain')).state, 'completed');
  } finally { release(); await pool.close(); }
});

test('failed Index observation keeps its own terminal experiment after successful restoration', async () => {
  const fixture = baseFixture((action, _id, state) => {
    if (action.kind !== 'index') return;
    if (action.state === 'stop') {
      state.indexControls.A = 'offline';
      state.experiment = { target: 'A', action: 'stop', city: 'Chicago', phase: 'failed', before: null, after: null,
        note: 'Index control changed, but fresh discovery was unavailable.' };
      return 'failed';
    }
    if (action.state === 'restart') state.indexControls.A = 'online';
  });
  const pool = createSharedBrowserSessions(fixture.base);
  const first = pool.open('a'.repeat(64)), second = pool.open('b'.repeat(64));
  try {
    await run(second, { kind: 'refresh', city: 'Boston' }, 'other-city');
    const operation = await run(first, { kind: 'index', index: 'A', state: 'stop', city: 'Chicago' }, 'failed-observation');
    assert.equal(operation.state, 'failed');
    assert.deepEqual(fixture.actions.slice(-2).map((action) => action.kind === 'index' ? action.state : action.kind), ['stop', 'restart']);
    assert.equal(pool.status(), 'ready', 'successful restore leaves the shared pool usable');
    assert.equal(first.view().experiment?.phase, 'failed');
    assert.equal(first.view().experiment?.city, 'Chicago');
    assert.match(first.view().experiment?.note ?? '', /fresh discovery was unavailable/);
    assert.equal(first.view().indexControls.A, 'online');
    assert.equal(second.view().experiment, null, 'the other browser must not inherit this failed experiment');
  } finally { await pool.close(); }
});

test('failed recovery projects only its own unavailable check and requester city', async () => {
  const fixture = baseFixture((action, _id, state) => {
    if (action.kind === 'recover') {
      assert.ok(state.recoveryCheck);
      state.recoveryCheck.status = 'unavailable';
      state.recoveryCheck.reason = 'Recovery did not complete; wallet outcome unknown.';
      return 'failed';
    }
  });
  const pool = createSharedBrowserSessions(fixture.base);
  const first = pool.open('a'.repeat(64)), second = pool.open('b'.repeat(64));
  try {
    await run(first, { kind: 'refresh', city: 'Chicago' }, 'first-city');
    await run(second, { kind: 'refresh', city: 'Boston' }, 'second-city');
    assert.equal((await run(first, { kind: 'recover', operatorId: 'operator-1' }, 'failed-recovery')).state, 'failed');
    assert.equal(first.view().recoveryCheck?.status, 'unavailable');
    assert.equal(first.view().recoveryCheck?.city, 'Chicago');
    assert.match(first.view().recoveryCheck?.reason ?? '', /wallet outcome unknown/);
    assert.equal(second.view().recoveryCheck, null);
    assert.equal(second.view().discovery?.city, 'Boston');
  } finally { await pool.close(); }
});

test('recovery preflight failure does not copy another browser check', async () => {
  const fixture = baseFixture(), pool = createSharedBrowserSessions(fixture.base);
  const first = pool.open('a'.repeat(64)), second = pool.open('b'.repeat(64));
  try {
    await run(first, { kind: 'refresh', city: 'Chicago' }, 'first-city');
    await run(second, { kind: 'refresh', city: 'Boston' }, 'second-city');
    fixture.state.recoveryCheck = { operatorId: 'operator-2', city: 'Boston', status: 'observed',
      endpoint: 'http://127.0.0.1:9999/foreign', reason: 'Other browser recovery.' };
    fixture.base.ready = async () => { throw new Error('base unavailable before action start'); };
    assert.equal((await run(first, { kind: 'recover', operatorId: 'operator-1' }, 'failed-preflight')).state, 'failed');
    assert.equal(first.view().recoveryCheck?.status, 'unavailable');
    assert.equal(first.view().recoveryCheck?.city, 'Chicago');
    assert.equal(first.view().recoveryCheck?.operatorId, 'operator-1');
    assert.equal(first.view().recoveryCheck?.endpoint, null);
    assert.match(first.view().recoveryCheck?.reason ?? '', /base unavailable/);
  } finally { await pool.close(); }
});
