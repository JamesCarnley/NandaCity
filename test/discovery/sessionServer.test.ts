import assert from 'node:assert/strict';
import { request, Server } from 'node:http';
import test from 'node:test';
import type { DemoSession, SessionAction, SessionOperation, SessionView } from '../../src/demo/sessionController.js';
import type { DemoSessionPool } from '../../src/demo/sharedBrowserSessions.js';
import { eveningPlanInputSchema } from '../../src/a2a/input.js';

function state(): SessionView {
  return { mode: 'fixture', generation: 0, status: 'ready', lifecycleOperationId: 'life', operators: [], crossOperatorWrite: 'not-tested',
    invocations: [], discovery: null, selection: null, operations: [], feedback: [], freshConsumer: null, originComparison: null,
    indexControls: { A: 'online', B: 'online' }, indexRead: null, experiment: null,
    feedbackCapacity: { total: 16, used: 0, exhausted: false }, limitations: [] };
}
test('a full public demo gives a usable retry page without admitting another browser', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  let admitted = 0;
  const session = { view: state, readContent: () => undefined } as unknown as DemoSession;
  const pool: DemoSessionPool = { status: () => 'ready', open: () => { admitted++; return session; },
    drop: async () => {}, close: async () => {} };
  const server = await startSessionServer(pool, 0, { publicOrigin: 'https://city.example', maxSessions: 2, sessionTtlMs: 60_000 });
  const get = () => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(server.origin, { headers: { host: 'city.example' } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part) => body += part);
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }); req.on('error', reject); req.end();
  });
  try {
    assert.equal((await get()).status, 200); assert.equal((await get()).status, 200);
    const full = await get();
    assert.equal(full.status, 429); assert.equal(admitted, 2);
    assert.match(full.headers['content-type'] ?? '', /text\/html/);
    assert.ok(Number(full.headers['retry-after']) >= 1);
    assert.match(full.body, /demo browser slots are in use/i);
    assert.match(full.body, /<form method="get" action="\/">[^]*?<button[^>]*>Try again<\/button><\/form>/);
    assert.equal(full.body.includes('Action unavailable or precondition changed'), false);
  } finally { await server.close(); }
});

test('saturated shared mutation admission explains that no action was queued', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const session = { view: state, readContent: () => undefined,
    start: () => { throw new Error('Shared demo is busy; wait for a pending action to finish, then retry.'); } } as unknown as DemoSession;
  const pool: DemoSessionPool = { status: () => 'ready', open: () => session, drop: async () => {}, close: async () => {} };
  const server = await startSessionServer(pool, 0, { publicOrigin: 'https://city.example', maxSessions: 2, sessionTtlMs: 60_000 });
  const send = (method: string, body = '', cookie = '') => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(server.origin + (method === 'POST' ? '/action' : '/'), { method, headers: { host: 'city.example',
      ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin: 'https://city.example', 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (part) => text += part);
      res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  try {
    const page = await send('GET'), cookie = page.headers['set-cookie']![0]!.split(';', 1)[0]!;
    const token = /name="token" value="([^"]+)"/.exec(page.body)![1]!;
    const form = new URLSearchParams({ token, generation: '0', operationId: 'busy-action', action: 'refresh', city: 'Chicago' }).toString();
    const busy = await send('POST', form, cookie);
    assert.equal(busy.status, 409); assert.equal(busy.headers['retry-after'], '3');
    assert.match(busy.body, /shared demo is busy/i); assert.match(busy.body, /no action was queued/i);
    assert.equal(busy.body.includes('precondition changed'), false);
  } finally { await server.close(); }
});
test('loopback HTTP boundary rejects foreign requests and preserves one operation across duplicate POST and read refresh', async () => {
  const api = await import('../../src/demo/sessionServer.js').catch(() => undefined);
  assert.ok(api?.startSessionServer, 'loopback session server must exist');
  const view = state(); let starts = 0, resets = 0;
  const session: DemoSession = { view: () => structuredClone(view), ready: async () => {}, select: () => {},
    start: (action: SessionAction, id = 'id') => { starts++; const op = { id, generation: view.generation, kind: action.kind, state: 'running' as const };
      view.operations.push(op); return op; }, wait: async () => { throw new Error('HTTP must not wait on work'); },
    frozenInput: () => { throw new Error('HTTP must never read private input'); }, readContent: () => undefined,
    reset: async () => { resets++; view.generation++; }, close: async () => {} };
  const server = await api.startSessionServer(session);
  const send = (body: string, headers: Record<string, string> = {}, method = 'POST', path = '/action') => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(`${server.origin}${path}`, { method, headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (s) => text += s); res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  try {
    const page = await send('', {}, 'GET', '/'); assert.equal(page.status, 200);
    const token = /name="token" value="([^"]+)"/.exec(page.body)![1]!;
    const form = new URLSearchParams({ token, generation: '0', operationId: 'one', action: 'refresh', city: 'Chicago' }).toString();
    for (const headers of [{ host: 'localhost:9999' }, { origin: 'https://foreign.example' }, { origin: '' }, { origin: 'null' }]) {
      assert.equal((await send(form, headers)).status, 403);
    }
    assert.equal((await send(form.replace(token, 'wrong'))).status, 403);
    assert.equal((await send('action=refresh')).status, 403);
    assert.equal((await send(form + '&unknown=secret')).status, 400);
    assert.equal((await send(form.replace('action=refresh', 'action=unknown'))).status, 400);
    assert.equal((await send(form + '&padding=' + 'x'.repeat(20000))).status, 413);
    assert.equal(starts, 0);
    const posted = await send(form); assert.equal(posted.status, 303); assert.equal(starts, 1);
    assert.equal((await send(form)).status, 303); assert.equal(starts, 1);
    for (const path of ['/', '/status', posted.headers.location!]) assert.equal((await send('', {}, 'GET', path)).status, 200);
    assert.equal(starts, 1, 'GET never replays an operation');
    assert.equal((await send(form.replace('Chicago', 'Boston'))).status, 409);
    for (const path of ['/export.html', '/export.json']) {
      const saved = await send('', {}, 'GET', path); assert.equal(saved.status, 200);
      assert.equal(saved.body.includes(token), false); assert.equal(saved.body.includes('<form'), false);
    }
    const nativePanel = new URLSearchParams({ token, generation: '0', operationId: 'index-panel', action: 'index',
      index: 'A', state: 'stop', city: 'Chicago', panel: 'resilience' }).toString();
    const panelPost = await send(nativePanel);
    assert.equal(panelPost.status, 303);
    assert.equal(panelPost.headers.location, '/?operation=index-panel#resilience');
    assert.equal(starts, 2, 'native form queues the same compound action once');
    assert.equal((await send(nativePanel)).status, 303);
    assert.equal(starts, 2);
    const reset = new URLSearchParams({ token, generation: '0', operationId: 'reset', action: 'reset' }).toString();
    assert.equal((await send(reset)).status, 303); assert.equal(resets, 1);
    assert.equal((await send(form)).status, 403, 'old generation token is invalidated');
    assert.equal((await send('', { host: 'evil.example' }, 'GET', '/')).status, 403);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'same-origin', 'native same-origin forms must retain their literal Origin');
  } finally { await server.close(); }
});

test('explicit HTTPS origin grants one browser lease and keeps other visitors away from mutation controls', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const view = state(); let starts = 0, resets = 0;
  const session: DemoSession = { view: () => structuredClone(view), ready: async () => {}, select: () => {},
    start: (action, id = 'id') => { starts++; return { id, generation: 0, kind: action.kind, state: 'running' }; },
    wait: async () => { throw new Error(); }, frozenInput: () => { throw new Error(); }, readContent: () => undefined,
    reset: async () => { resets++; }, close: async () => {} };
  const publicOrigin = 'https://city.example';
  const server = await startSessionServer(session, 0, { publicOrigin, leaseMs: 60_000 });
  const send = (path: string, method = 'GET', body = '', headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(`${server.origin}${path}`, { method, headers: { host: 'city.example', ...headers } }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (part) => text += part);
        res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
      }); req.on('error', reject); req.end(body);
    });
  try {
    assert.equal(server.browserOrigin, publicOrigin);
    const health = await send('/healthz'); assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: 'ready' }); assert.equal(health.headers['set-cookie'], undefined);
    const first = await send('/'); assert.equal(first.status, 200);
    const setCookie = first.headers['set-cookie']?.[0];
    assert.match(setCookie ?? '', /^nanda_city_lease=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
    const cookie = setCookie!.split(';', 1)[0]!;
    assert.equal((await send('/')).status, 423, 'a second browser receives only the wait page');
    const owner = await send('/', 'GET', '', { cookie: cookie! }); assert.equal(owner.status, 200);
    const token = /name="token" value="([^"]+)"/.exec(owner.body)![1]!;
    const form = new URLSearchParams({ token, generation: '0', operationId: 'public', action: 'refresh', city: 'Chicago' }).toString();
    const postHeaders = { origin: publicOrigin, cookie: cookie!, 'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await send('/action', 'POST', form, postHeaders)).status, 303); assert.equal(starts, 1);
    assert.equal((await send('/action', 'POST', form, { ...postHeaders, cookie: '' })).status, 403);
    assert.equal((await send('/action', 'POST', form, { ...postHeaders, origin: 'https://foreign.example' })).status, 403);
    assert.equal(resets, 0);
  } finally { await server.close(); }
});

test('explicitly disabled public lease admits multiple browsers into the shared session', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const session = { view: state, readContent: () => undefined } as unknown as DemoSession;
  const server = await startSessionServer(session, 0, { publicOrigin: 'https://city.example', leaseMs: 0 });
  const get = () => new Promise<{ status: number; cookie: string[] | undefined }>((resolve, reject) => {
    const req = request(server.origin, { headers: { host: 'city.example' } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie'] }));
    }); req.on('error', reject); req.end();
  });
  try {
    const first = await get(), second = await get();
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(first.cookie, undefined); assert.equal(second.cookie, undefined);
  } finally { await server.close(); }
});

test('browser session pool isolates journeys and restores a real Index fault before the next user action', async () => {
  const { createSharedBrowserSessions } = await import('../../src/demo/sharedBrowserSessions.js');
  const view = state();
  const services = ['service-a', 'service-b'];
  const operations = new Map<string, { view: { id: string; generation: number; kind: SessionAction['kind']; state: 'running' | 'completed' }; done: Promise<void> }>();
  const selected: string[] = [], actions: string[] = []; let resets = 0;
  const discovery = (city: 'Chicago' | 'Boston') => ({ city, status: 'complete', eligibleCount: 2,
    selected: services.map((service, index) => ({ service, agent: { chainId: 31337, registry: '0x0000000000000000000000000000000000000001', agentId: String(index + 1) } })),
    candidates: [], origins: [], ranking: { snapshot: 'matched', policyResult: null },
    observation: { blockNumber: '1', blockHash: '0x00' } }) as unknown as NonNullable<SessionView['discovery']>;
  const base: DemoSession = {
    view: () => structuredClone(view), ready: async () => {}, readContent: () => undefined,
    frozenInput: () => { throw new Error('not needed'); }, close: async () => {},
    reset: async () => { resets++; },
    select: (service) => { view.selection = service; selected.push(service); },
    start: (action, id = 'id') => {
      const item = { id, generation: 0, kind: action.kind, state: 'running' as const };
      const done = new Promise<void>((resolve) => setImmediate(() => {
        actions.push(action.kind === 'index' ? `${action.index}:${action.state}` : action.kind);
        if (action.kind === 'refresh') view.discovery = discovery(action.city);
        if (action.kind === 'invoke') view.invocations.push({ id, service: view.selection!, reviewer: action.reviewer,
          requestDigest: '0x00', sent: true, accepted: true, taskId: id, outcome: 'completed', checkedResult: 'matched', answer: 'ok' });
        if (action.kind === 'index') {
          view.indexControls[action.index] = action.state === 'stop' ? 'offline' : action.state === 'tamper' ? 'altered' : 'online';
          view.experiment = action.city ? { target: action.index, action: action.state, city: action.city, phase: 'observed', before: null,
            after: { city: action.city, status: 'complete', indexes: { A: { status: action.index === 'A' && action.state === 'stop' ? 'unavailable' : 'complete', verified: 2, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
              B: { status: 'complete', verified: 2, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services }, note: 'observed' } : null;
        }
        (item as { state: 'running' | 'completed' }).state = 'completed'; resolve();
      }));
      operations.set(id, { view: item, done }); return structuredClone(item);
    },
    wait: async (id) => { const operation = operations.get(id)!; await operation.done; return structuredClone(operation.view); },
  };
  const pool = createSharedBrowserSessions(base);
  const first = pool.open('a'.repeat(64)), second = pool.open('b'.repeat(64));
  const run = async (session: DemoSession, action: SessionAction, id: string) => session.wait(session.start(action, id).id);
  try {
    await Promise.all([run(first, { kind: 'refresh', city: 'Chicago' }, 'discover-a'),
      run(second, { kind: 'refresh', city: 'Boston' }, 'discover-b')]);
    first.select('service-a'); second.select('service-b');
    await Promise.all([run(first, { kind: 'invoke', reviewer: 'accepted' }, 'ask-a'),
      run(second, { kind: 'invoke', reviewer: 'accepted' }, 'ask-b')]);
    assert.deepEqual(first.view().invocations.map((item) => [item.id, item.service]), [['ask-a', 'service-a']]);
    assert.deepEqual(second.view().invocations.map((item) => [item.id, item.service]), [['ask-b', 'service-b']]);
    await Promise.all([run(first, { kind: 'index', index: 'A', state: 'stop', city: 'Chicago' }, 'fault-a'),
      run(second, { kind: 'refresh', city: 'Boston' }, 'after-fault')]);
    assert.deepEqual(actions.slice(-3), ['A:stop', 'A:restart', 'refresh'], 'the shared Index is restored before another browser action runs');
    assert.equal(first.view().experiment?.action, 'stop'); assert.equal(second.view().experiment, null);
    await first.reset(); assert.equal(resets, 0, 'browser reset never resets shared infrastructure');
    assert.equal(first.view().invocations.length, 0); assert.equal(second.view().invocations.length, 1);
    assert.deepEqual(selected.slice(-2), ['service-a', 'service-b']);
  } finally { await pool.close(); }
});

test('public HTTP assigns secure browser sessions and keeps their discovery views separate', async () => {
  const { createSharedBrowserSessions } = await import('../../src/demo/sharedBrowserSessions.js');
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const view = state(); const operations = new Map<string, SessionOperation>();
  const base = { view: () => structuredClone(view), ready: async () => {}, select: () => {}, readContent: () => undefined,
    frozenInput: () => { throw new Error(); }, reset: async () => {}, close: async () => {},
    start: (action: SessionAction, id = 'id') => {
      const operation: SessionOperation = { id, generation: 0, kind: action.kind, state: 'completed' };
      if (action.kind === 'refresh') view.discovery = { city: action.city, status: 'complete', eligibleCount: 0, selected: [],
        candidates: [], origins: [], ranking: { snapshot: 'matched', policyResult: null }, observation: { blockNumber: '1', blockHash: '0x00' } } as unknown as SessionView['discovery'];
      operations.set(id, operation); return structuredClone(operation);
    }, wait: async (id: string) => structuredClone(operations.get(id)!),
  } as DemoSession;
  const pool = createSharedBrowserSessions(base), publicOrigin = 'https://city.example';
  const server = await startSessionServer(pool, 0, { publicOrigin, maxSessions: 4, sessionTtlMs: 60_000 });
  const send = (path: string, method = 'GET', body = '', headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(`${server.origin}${path}`, { method, headers: { host: 'city.example', ...headers } }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (part) => text += part);
        res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
      }); req.on('error', reject); req.end(body);
    });
  const ready = async (cookie: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await send('/status', 'GET', '', { cookie });
      if ((JSON.parse(status.body) as { operations: SessionOperation[] }).operations.every((item) => !['queued', 'running'].includes(item.state))) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('browser operation did not settle');
  };
  try {
    assert.equal((await send('/healthz')).status, 200);
    const first = await send('/'), second = await send('/');
    const firstCookie = first.headers['set-cookie']?.[0]?.split(';', 1)[0], secondCookie = second.headers['set-cookie']?.[0]?.split(';', 1)[0];
    assert.match(firstCookie ?? '', /^nanda_city_session=[0-9a-f]{64}$/); assert.match(secondCookie ?? '', /^nanda_city_session=[0-9a-f]{64}$/);
    assert.notEqual(firstCookie, secondCookie);
    const firstToken = /name="token" value="([^"]+)"/.exec(first.body)![1]!, secondToken = /name="token" value="([^"]+)"/.exec(second.body)![1]!;
    assert.notEqual(firstToken, secondToken);
    const post = (cookie: string, token: string, city: 'Chicago' | 'Boston', id: string) => send('/action', 'POST',
      new URLSearchParams({ token, generation: '0', operationId: id, action: 'refresh', city }).toString(),
      { cookie, origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal((await post(firstCookie!, firstToken, 'Chicago', 'first-city')).status, 303);
    assert.equal((await post(secondCookie!, secondToken, 'Boston', 'second-city')).status, 303);
    await Promise.all([ready(firstCookie!), ready(secondCookie!)]);
    assert.match((await send('/', 'GET', '', { cookie: firstCookie! })).body, /data-city="Chicago"/);
    assert.match((await send('/', 'GET', '', { cookie: secondCookie! })).body, /data-city="Boston"/);
    assert.equal((await post(secondCookie!, firstToken, 'Chicago', 'cross-user')).status, 403);
  } finally { await server.close(); await pool.close(); }
});

test('expired public lease resets the owned session before a new visitor is admitted', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  let resets = 0;
  const session = { view: state, readContent: () => undefined, reset: async () => { resets++; } } as unknown as DemoSession;
  const server = await startSessionServer(session, 0, { publicOrigin: 'https://city.example', leaseMs: 10 });
  const get = (cookie?: string) => new Promise<number>((resolve, reject) => {
    const req = request(server.origin, { headers: { host: 'city.example', ...(cookie ? { cookie } : {}) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    }); req.on('error', reject); req.end();
  });
  try {
    let cookie: string | undefined;
    const first = await new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = request(server.origin, { headers: { host: 'city.example' } }, (res) => {
        const found = res.headers['set-cookie']?.[0];
        res.resume(); res.on('end', () => resolve({ status: res.statusCode!, ...(found ? { cookie: found } : {}) }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(first.status, 200); cookie = first.cookie; assert.ok(cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await get(cookie), 503); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resets, 1); assert.equal(await get(), 200);
  } finally { await server.close(); }
});

test('licensed HTTP form preserves the allowlisted walking plus transit choice', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const view = state(); view.mode = 'licensed';
  view.licensedHint = { admittedReviewer: 'accepted', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  // Only the public fields consumed by this HTTP input boundary are needed.
  view.discovery = { city: 'Chicago', status: 'complete', eligibleCount: 0, selected: [],
    ranking: { policyResult: null, snapshot: 'matched' }, observation: { blockNumber: '1', blockHash: '0x00' } } as unknown as SessionView['discovery'];
  const actions: SessionAction[] = [];
  const session: DemoSession = { view: () => view, readContent: () => undefined, ready: async () => {}, select: () => {},
    wait: async () => { throw new Error('HTTP must not wait on work'); }, frozenInput: () => { throw new Error('HTTP must not read private input'); },
    reset: async () => {}, close: async () => {},
    start: (action, id = 'id') => { actions.push(action); return { id, generation: 0, kind: action.kind, state: 'queued' }; } };
  const server = await startSessionServer(session);
  try {
    const page = await (await fetch(server.origin)).text();
    const token = /name="token" value="([^"]+)"/.exec(page)![1]!;
    const year = new Date().getUTCFullYear() + 1;
    const form = new URLSearchParams({ token, generation: '0', operationId: 'licensed', action: 'invoke', reviewer: 'accepted',
      start: `${year}-01-15T18:00:00-06:00`, end: `${year}-01-15T22:00:00-06:00`, area: 'Loop', budget: '8500',
      transport: 'walk-and-public-transit', preferences: 'An evening activity' }).toString();
    const post = (body: string) => fetch(`${server.origin}/action`, { method: 'POST', redirect: 'manual',
      headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal((await post(form.replace('walk-and-public-transit', 'unknown'))).status, 400);
    assert.equal((await post(form + '&transport=walk')).status, 400, 'duplicate form fields remain rejected');
    assert.equal((await post(form + '&unknown=walk')).status, 400);
    assert.equal(actions.length, 0);
    assert.equal((await post(form)).status, 303);
    assert.equal(actions.length, 1);
    const action = actions[0]!; assert.equal(action.kind, 'invoke');
    assert.ok(action.kind === 'invoke' && action.input);
    assert.deepEqual(eveningPlanInputSchema.parse(action.input).transport, ['walk', 'public-transit']);
  } finally { await server.close(); }
});

test('OpenClaw form validates demo preferences and budget without accepting credentials or live configuration', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const view = state(); view.answerEngine = 'openclaw';
  view.discovery = { city: 'Boston', status: 'complete', eligibleCount: 0, selected: [],
    ranking: { policyResult: null, snapshot: 'matched' }, observation: { blockNumber: '1', blockHash: '0x00' } } as unknown as SessionView['discovery'];
  const actions: SessionAction[] = [];
  const session: DemoSession = { view: () => view, readContent: () => undefined, ready: async () => {}, select: () => {},
    wait: async () => { throw new Error(); }, frozenInput: () => { throw new Error(); }, reset: async () => {}, close: async () => {},
    start: (action, id = 'id') => { actions.push(action); return { id, generation: 0, kind: action.kind, state: 'queued' }; } };
  const server = await startSessionServer(session);
  try {
    const page = await (await fetch(server.origin)).text(), token = /name="token" value="([^"]+)"/.exec(page)![1]!;
    const form = new URLSearchParams({ token, generation: '0', operationId: 'model', action: 'invoke', reviewer: 'accepted',
      budget: '4000', transport: 'walk', preferences: 'Low cost\nAn activity' }).toString();
    const post = (body: string) => fetch(`${server.origin}/action`, { method: 'POST', redirect: 'manual',
      headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
    for (const body of [form + '&apiKey=secret', form + '&area=unexpected', form.replace('budget=4000', 'budget=-1'),
      form.replace('transport=walk', 'transport=fly'), form.replace('Low+cost', 'x'.repeat(257))]) assert.equal((await post(body)).status, 400);
    assert.equal(actions.length, 0); assert.equal((await post(form)).status, 303);
    const action = actions[0]!; assert.ok(action.kind === 'invoke' && action.input);
    assert.equal(action.input.city, 'Boston'); assert.equal(action.input.budget.minorUnits, '4000');
    assert.deepEqual(action.input.transport, ['walk']); assert.deepEqual(action.input.preferences, ['Low cost', 'An activity']);
  } finally { await server.close(); }
});

test('authenticated reset stays reachable and coalesces at the normal submission cap', async () => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  const view = state(), cleanup = Promise.withResolvers<void>(); let starts = 0, resets = 0;
  const session: DemoSession = { view: () => view, readContent: () => undefined, ready: async () => {}, select: () => {},
    wait: async () => { throw new Error('HTTP must not wait on work'); }, frozenInput: () => { throw new Error('HTTP must not read private input'); }, close: async () => {},
    start: (action, id = 'id') => { starts++; return { id, generation: 0, kind: action.kind, state: 'queued' }; },
    reset: async () => { resets++; view.status = 'resetting'; await cleanup.promise; view.generation++; view.status = 'starting'; } };
  const server = await startSessionServer(session);
  try {
    const page = await (await fetch(server.origin)).text();
    const token = /name="token" value="([^"]+)"/.exec(page)![1]!;
    const post = (operationId: string, action = 'refresh', fields: Record<string, string> = { city: 'Chicago' }) =>
      fetch(`${server.origin}/action`, { method: 'POST', redirect: 'manual', headers: { origin: server.origin,
        'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, generation: '0', operationId, action, ...fields }) });
    for (let i = 0; i < 512; i++) assert.equal((await post(`normal-${i}`)).status, 303);
    assert.equal((await post('overflow')).status, 429); assert.equal(starts, 512);
    assert.equal((await post('normal-0')).status, 303, 'accepted replay still deduplicates at capacity');
    assert.equal((await post('reset', 'reset', { token: 'wrong' })).status, 403);
    assert.equal((await post('normal-0', 'reset', {})).status, 409, 'reset cannot reuse a conflicting operation ID');
    const reset = await post('reset', 'reset', {}); assert.equal(reset.status, 303); assert.equal(resets, 1);
    assert.equal((await post('reset', 'reset', {})).status, 303); assert.equal(resets, 1);
    const coalesced = await post('another-reset', 'reset', {});
    assert.equal(coalesced.status, 303); assert.equal(coalesced.headers.get('location'), reset.headers.get('location'));
    assert.equal(resets, 1, 'only one reserved reset is dispatched while cleanup is pending');
    assert.equal((await post('reset')).status, 409, 'reserved reset ID also rejects conflicting normal actions');
    cleanup.resolve(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view.generation, 1); assert.equal(view.status, 'starting');
    assert.equal((await post('old-generation')).status, 403);
  } finally { cleanup.resolve(); await server.close(); }
});

test('literal loopback boundary uses the browser canonical origin for the HTTP default port', async (t) => {
  const { startSessionServer } = await import('../../src/demo/sessionServer.js');
  // Simulate the OS-reported port only: keep the real listener on an ephemeral
  // port, avoiding a privileged/global port dependency in this boundary test.
  const address = Server.prototype.address; let transportPort = 0;
  const replacement = t.mock.method(Server.prototype, 'address', function (this: Server) {
    const actual = address.call(this); assert.ok(actual && typeof actual !== 'string'); transportPort = actual.port;
    return { ...actual, port: 80 };
  });
  const server = await startSessionServer({ view: state, readContent: () => undefined } as unknown as DemoSession);
  replacement.mock.restore();
  try {
    const result = await new Promise<number>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${transportPort}/`, { headers: { host: '127.0.0.1' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(result, 200, 'browser default-port Host must match its canonical Origin');
    assert.equal(server.origin, 'http://127.0.0.1');
  } finally { await server.close(); }
});
