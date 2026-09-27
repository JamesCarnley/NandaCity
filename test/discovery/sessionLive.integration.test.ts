import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withDemoSession, type SessionOptions, type DemoSession } from '../../src/demo/sessionController.js';
import { liveAnswerSchema } from '../../src/live/answer.js';
import { LiveBudget } from '../../src/live/budget.js';
import { decodeEnvelope, signRequest } from '../../src/interaction/signatures.js';
import { rpcTask } from '../../src/client/externalClient.js';
import { withOwnedLifecycle } from '../../src/demo/ownedLifecycle.js';
import { eveningPlanInputSchema, type EveningPlanInput } from '../../src/a2a/input.js';
import { startSessionServer, renderSessionPage } from '../../src/demo/sessionServer.js';
import { json, prices, requestInput } from '../live/fixtures.js';

const CONTENT = 'OWNED-LICENSED-GROUNDING-SENTINEL-87571';
const utc = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function setup(t: import('node:test').TestContext) {
  const budgetDirectory = await mkdtemp(join(tmpdir(), 'city-session-ledger-'));
  t.after(() => rm(budgetDirectory, { recursive: true, force: true }));
  const calls = { generated: 0, fail: false, source: 0, generateGate: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
    sourceGate: undefined as (() => Promise<void>) | undefined, sourceClosed: undefined as (() => void) | undefined };
  const server = createServer((request, response) => { void (async () => {
    response.on('close', () => calls.sourceClosed?.());
    calls.source++; await calls.sourceGate?.();
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url?.startsWith('/events')) return json(response, { page: { size: 10, totalElements: 0, totalPages: 0, number: 0 } });
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value.method === 'initialize') return json(response, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (value.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
    if (value.method === 'tools/list') return json(response, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search_places', inputSchema: { type: 'object', properties: { text_query: { type: 'string' }, language_code: { type: 'string' }, region_code: { type: 'string' } }, required: ['text_query'] } }] } });
    return json(response, { jsonrpc: '2.0', id: 3, result: { structuredContent: { summary: CONTENT, places: [{ id: 'fictional-cafe', place: 'places/fictional-cafe', googleMapsLinks: { placeUrl: 'https://maps.google.com/?cid=1' }, attribution: { title: 'Google Maps', url: 'https://maps.google.com/?cid=1' } }] } } });
  })().catch(() => response.destroy()); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const options = { mode: 'licensed' as const, admittedReviewer: 'accepted' as const, budgetDirectory,
    retention: { kind: 'licensed' as const, policyId: 'owned-session', expiresAt: utc(Date.now() + 1200000), export: 'receipts-only' as const, persistContent: false as const },
    transport: { mode: 'local-test' as const, endpoints: { places: `${origin}/mcp`, events: `${origin}/events`, transit: `${origin}/routes` }, credentials: { google: 'OWNED-KEY-SENTINEL', ticketmaster: 'OWNED-KEY-SENTINEL' } },
    budget: { sessionCapMicros: '1000', runCapMicros: '10', prices, pricingExpiresAt: utc(Date.now() + 1200000) },
    inference: { mode: 'owned-test' as const, maxOutputTokens: 100, countInputTokens: () => 10,
      generate: async (input: import('../../src/live/answer.js').GenerateInput, context: { signal: AbortSignal }) => {
        calls.generated++; await calls.generateGate?.(context.signal); if (calls.fail) throw new Error(CONTENT);
        return { groundedBlock: input.places.summary, selectedPlaceId: 'fictional-cafe', inputTokens: 10, outputTokens: 1 };
      } } } satisfies SessionOptions;
  return { options, calls };
}
async function select(session: DemoSession, city: 'Chicago' | 'Boston', index = 0) {
  assert.equal((await session.wait(session.start({ kind: 'refresh', city }).id)).state, 'completed');
  session.select(session.view().discovery!.selected[index]!.service);
}
function inputFor(city: 'Chicago' | 'Boston', now = Date.now()): EveningPlanInput {
  const input = structuredClone(requestInput) as unknown as EveningPlanInput;
  const timeZone = city === 'Chicago' ? 'America/Chicago' : 'America/New_York';
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  const local = (epoch: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.timeZoneName!.replace('GMT', '')}`;
  };
  // Capture one clock per input; format both ends independently across DST.
  const start = now + 48 * 3600000;
  input.city = city; input.timeWindow = { start: local(start), end: local(start + 5 * 3600000), timeZone };
  return input;
}
async function sweep(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await sweep(path));
    else if (entry.isFile()) values.push((await readFile(path)).toString());
  }
  return values;
}
async function consumer(input: unknown) {
  return new Promise<{ policyResult: unknown }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/reputation/fixtures/rankingEvidenceWorker.ts'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH }, timeout: 60000 });
    const chunks: Buffer[] = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject); child.once('close', (code) => {
      if (code !== 0) reject(new Error('fresh receipt consumer failed')); else resolve(JSON.parse(Buffer.concat(chunks).toString()));
    }); child.stdin.end(JSON.stringify(input, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  });
}

for (const [clock, windows] of [
  ['2027-01-15T12:00:00Z', [['2027-01-17T06:00:00-06:00', '2027-01-17T11:00:00-06:00'], ['2027-01-17T07:00:00-05:00', '2027-01-17T12:00:00-05:00']]],
  ['2027-07-15T12:00:00Z', [['2027-07-17T07:00:00-05:00', '2027-07-17T12:00:00-05:00'], ['2027-07-17T08:00:00-04:00', '2027-07-17T13:00:00-04:00']]],
  ['2027-03-12T06:30:00Z', [['2027-03-14T00:30:00-06:00', '2027-03-14T06:30:00-05:00'], ['2027-03-14T01:30:00-05:00', '2027-03-14T07:30:00-04:00']]],
  ['2026-10-30T05:30:00Z', [['2026-11-01T00:30:00-05:00', '2026-11-01T04:30:00-06:00'], ['2026-11-01T01:30:00-04:00', '2026-11-01T05:30:00-05:00']]],
] as const) for (const [index, city] of (['Chicago', 'Boston'] as const).entries()) {
  test(`future licensed test windows: ${city} from ${clock}`, () => {
    const now = Date.parse(clock), input = inputFor(city, now);
    assert.ok(Date.parse(input.timeWindow.start) > now, 'licensed test start must remain in the future');
    assert.deepEqual([input.timeWindow.start, input.timeWindow.end], windows[index]);
    assert.equal(Date.parse(input.timeWindow.end) - Date.parse(input.timeWindow.start), 5 * 3600000);
    assert.equal(eveningPlanInputSchema.safeParse(input).success, true);
    const wrongOffset = { ...input, timeWindow: { ...input.timeWindow, start: input.timeWindow.start.replace(/[+-]\d{2}:\d{2}$/, '+00:00') } };
    assert.equal(eveningPlanInputSchema.safeParse(wrongOffset).success, false, 'UTC offset must stay invalid for either city in every season');
  });
}

test('owned licensed session keeps real source-backed answers transient and durable receipts answer-free', { timeout: 300000 }, async (t) => {
  const { options, calls } = await setup(t);
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready();
    await select(session, 'Chicago');
    assert.equal(calls.generated, 0); assert.equal(calls.source, 0);
    const input = inputFor('Chicago');
    const operations = session.view().operations.length;
    for (const action of [
      { kind: 'invoke', reviewer: 'accepted' }, { kind: 'invoke', reviewer: 'new', input },
      { kind: 'invoke', reviewer: 'accepted', input, fail: false }, { kind: 'invoke', reviewer: 'accepted', input: inputFor('Boston') },
      { kind: 'invoke', reviewer: 'accepted', input: { ...input, timeWindow: { ...input.timeWindow, start: input.timeWindow.start.replace(/[+-]\d{2}:\d{2}$/, '+00:00') } } },
      { kind: 'invoke', reviewer: 'accepted', input: { ...input, timeWindow: { ...input.timeWindow, start: '2020-10-03T18:00:00-05:00', end: '2020-10-03T20:00:00-05:00' } } },
      { kind: 'refresh', city: 'Chicago', secret: 'unknown' }, { kind: 'feedback', invocationId: '../outside', value: 3 },
      { kind: 'feedback', invocationId: 'absent', value: 6 }, { kind: 'unknown' },
    ]) assert.throws(() => session.start(action as any));
    assert.equal(session.view().operations.length, operations); assert.equal(session.view().invocations.length, 0);
    assert.equal(calls.source, 0);
    const operation = session.start({ kind: 'invoke', reviewer: 'accepted', input }, 'licensed-first');
    assert.equal((await session.wait(operation.id)).state, 'completed');
    const invocation = session.view().invocations[0]!;
    assert.equal(invocation.answer, null, 'licensed answer must never enter the public session state');
    assert.equal(session.view().mode, 'licensed');
    const bytes = session.readContent(invocation.id, session.view().generation)!;
    assert.ok(bytes); const answer = liveAnswerSchema.parse(JSON.parse(Buffer.from(bytes).toString())); bytes.fill(0);
    assert.equal(answer.grounding.block, CONTENT); assert.equal(answer.city, 'Chicago');
    assert.equal(calls.generated, 1);
    assert.equal(invocation.receipt?.earlierByteCheck?.answerBinding, 'matched');
    assert.equal(invocation.receipt?.findings.completion?.answerBinding, 'unavailable');
    assert.equal(invocation.receipt?.content.contentAvailability, 'available');
    assert.equal(invocation.receipt?.providerOutcome, 'completed');
    assert.equal(JSON.stringify(session.view()).includes(CONTENT), false);
    const web = await startSessionServer(session); t.after(() => web.close());
    const shown = await fetch(web.origin); const html = await shown.text();
    assert.equal(shown.headers.get('cache-control'), 'no-store'); assert.ok(html.includes(CONTENT));
    assert.ok(html.includes('Required source attribution')); assert.ok(html.includes('maps.google.com/?cid=1'));
    const copies: Uint8Array[] = [];
    renderSessionPage({ ...session, readContent: (...args) => { const copy = session.readContent(...args); if (copy) copies.push(copy); return copy; } }, { token: 'test', nonce: 'test' });
    assert.ok(copies.length); assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)), 'rendering disposes every returned copy');
    for (const path of ['/export.html', '/export.json']) {
      const saved = await (await fetch(`${web.origin}${path}`)).text();
      for (const secret of [CONTENT, Buffer.from(CONTENT).toString('base64'), 'OWNED-KEY-SENTINEL', 'payloadBase64\":\"eyJraW5kIjoicmVxdWVzdC']) assert.equal(saved.includes(secret), false);
      assert.equal(saved.includes('<form'), false); assert.equal(saved.includes('name="token"'), false);
    }
    session.start({ kind: 'invoke', reviewer: 'accepted', input }, 'licensed-first');
    await session.wait(session.start({ kind: 'retry', invocationId: 'licensed-first' }).id);
    assert.equal(calls.generated, 1); assert.equal(session.view().invocations[0]!.taskId, invocation.taskId);
    await t.test('all six actual scopes share the licensed backend and evict only content', async () => {
      const seen = new Set([`${answer.city}/${answer.emphasis}`]);
      for (const city of ['Chicago', 'Boston'] as const) for (let index = 0; index < 3; index++) {
        if (city === 'Chicago' && index === 0) continue;
        await select(session, city, index);
        const id = `${city}-${index}`;
        assert.equal((await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor(city) }, id).id)).state, 'completed');
        const copy = session.readContent(id, 0)!; const result = liveAnswerSchema.parse(JSON.parse(Buffer.from(copy).toString())); copy.fill(0);
        seen.add(`${result.city}/${result.emphasis}`); assert.equal(result.grounding.block, CONTENT);
        assert.equal(result.grounding.links[0]!.url, 'https://maps.google.com/?cid=1');
        assert.ok(result.gaps.includes('event-unavailable')); assert.equal(result.usage.physicalAttempts, 6);
      }
      assert.equal(calls.generated, 6); assert.equal(seen.size, 6);
      assert.equal(session.readContent('licensed-first', 0), undefined);
      assert.equal(session.view().invocations[0]!.receipt?.content.contentAvailability, 'not-retained');
      assert.equal(session.view().invocations[0]!.receipt?.earlierByteCheck?.answerBinding, 'matched');
    });
    await t.test('receipt-only feedback survives content eviction and a real signed failure supports negative review', async () => {
      assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: 'licensed-first', value: 5 }, 'licensed-review').id)).state, 'completed');
      const feedback = session.view().feedback[0]!;
      assert.equal(feedback.readBack, 'matched'); assert.deepEqual(feedback.retained, { A: true, B: true }); assert.equal(feedback.weighting, 'contributing');
      const root = dirname(session.frozenInput().privateBundleFiles[0]!.path!);
      for (const text of [...await sweep(root), ...await sweep(options.budgetDirectory), JSON.stringify(session.view())]) {
        assert.equal(text.includes(CONTENT), false); assert.equal(text.includes(Buffer.from(CONTENT).toString('base64')), false);
        assert.equal(text.includes('OWNED-KEY-SENTINEL'), false); assert.equal(text.includes('answerBase64'), false);
      }
      const saved = JSON.parse(await readFile(join(root, 'licensed-first.evidence.json'), 'utf8'));
      assert.ok(saved.completion); assert.equal(saved.answerBase64, undefined);
      await select(session, 'Chicago'); calls.fail = true;
      assert.equal((await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input }, 'signed-failure').id)).state, 'completed'); calls.fail = false;
      const failed = session.view().invocations.at(-1)!;
      assert.equal(failed.outcome, 'failed'); assert.equal(failed.receipt?.providerOutcome, 'failed'); assert.equal(session.readContent(failed.id, 0), undefined);
      assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: failed.id, value: 1 }, 'negative-review').id)).state, 'completed');
      assert.equal(session.view().feedback.at(-1)!.readBack, 'matched');
    });
    await t.test('missing signed completion remains unresolved and cannot receive completion feedback', async (subtest) => {
      await select(session, 'Chicago'); calls.fail = true;
      const fetcher = globalThis.fetch;
      const missing = subtest.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await fetcher(...args);
        const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
        if (body?.method !== 'tasks/get') return response;
        const message = await response.json() as any; const task = message.result;
        if (task?.status.state === 'failed') {
          delete task.metadata['org.nandacity'].completion; delete task.artifacts;
          for (const part of task.status.message?.parts ?? []) delete part.data?.completion;
        }
        return new Response(JSON.stringify(message), { status: response.status, headers: response.headers });
      });
      try { await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input }, 'missing-completion').id); }
      finally { missing.mock.restore(); calls.fail = false; }
      const unresolved = session.view().invocations.at(-1)!;
      assert.equal(unresolved.outcome, 'unresolved'); assert.equal(unresolved.receipt?.providerOutcome, 'unresolved');
      assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: unresolved.id, value: 1 }).id)).state, 'failed');
      assert.equal(session.view().feedback.length, 2);
    });
    await t.test('bad answer bytes and invalid signed completion cannot become eligible reviews', async (subtest) => {
      for (const fault of ['answer', 'signature'] as const) {
        await select(session, 'Chicago'); const fetcher = globalThis.fetch;
        const tampered = subtest.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
          const response = await fetcher(...args);
          const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
          if (body?.method !== 'tasks/get') return response;
          const message = await response.json() as any, task = message.result;
          if (task?.status.state === 'completed') {
            if (fault === 'answer') task.artifacts[0].parts[0].data.answerBase64 = Buffer.from('WRONG-ANSWER-SENTINEL').toString('base64');
            else {
              const completion = task.metadata['org.nandacity'].completion;
              completion.signature = `0x${'00'.repeat(65)}`;
              task.artifacts[0].parts[0].data.completion = completion;
            }
          }
          return new Response(JSON.stringify(message), { status: response.status, headers: response.headers });
        });
        const id = `tampered-${fault}`;
        try { await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input }, id).id); }
        finally { tampered.mock.restore(); }
        const result = session.view().invocations.at(-1)!;
        assert.equal(result.outcome, fault === 'answer' ? 'completed' : 'unresolved');
        if (fault === 'answer') assert.equal(result.receipt?.earlierByteCheck?.answerBinding, 'mismatched');
        else assert.equal(result.receipt?.findings.completion?.cryptography, 'invalid');
        assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: id, value: 5 }).id)).state, 'failed');
        assert.equal(session.view().feedback.length, 2);
      }
    });
    await t.test('a signed document remains visible when transaction preparation fails and cannot reuse its slot', async (subtest) => {
      const fetcher = globalThis.fetch, before = session.view().feedbackCapacity.used;
      const rejected = subtest.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : undefined;
        if (body?.method === 'eth_chainId') throw new Error('owned preparation barrier');
        return fetcher(...args);
      });
      try { assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: 'licensed-first', value: 3 }, 'unprepared-review').id)).state, 'failed'); }
      finally { rejected.mock.restore(); }
      const signed = session.view().feedback.at(-1)!;
      assert.equal(signed.id, 'unprepared-review'); assert.equal(signed.signed, true); assert.equal(signed.publication, 'not-prepared');
      assert.equal(signed.transactionHash, null); assert.equal(session.view().feedbackCapacity.used, before + 1);
      assert.equal((await session.wait(session.start({ kind: 'retry-feedback', feedbackId: signed.id }).id)).state, 'failed');
      assert.equal(session.view().feedbackCapacity.used, before + 1);
    });
    await t.test('recovery retains source ceiling and exact admitted caller on both services', async () => {
      const operator = session.view().operators[0]!;
      assert.equal((await session.wait(session.start({ kind: 'recover', operatorId: operator.id }).id)).state, 'completed');
      for (const city of ['Chicago', 'Boston'] as const) {
        await select(session, city);
        const service = session.view().discovery!.selected.find((candidate) => candidate.agent.agentId === operator.services.find((item) => item.city === city)!.agentId)!;
        session.select(service.service);
        assert.throws(() => session.start({ kind: 'invoke', reviewer: 'new', input: inputFor(city) }));
        const id = `recovered-${city}`;
        assert.equal((await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor(city) }, id).id)).state, 'completed');
        const copy = session.readContent(id, 0)!; assert.ok(copy); copy.fill(0);
        assert.equal(session.view().invocations.at(-1)!.receipt?.retention.policyId, 'owned-session');
        const root = dirname(session.frozenInput().privateBundleFiles[0]!.path!);
        const saved = JSON.parse(await readFile(join(root, `${id}.request.json`), 'utf8'));
        const request = decodeEnvelope(saved.request).statement.value; assert.equal(request.kind, 'request');
        if (request.kind !== 'request') throw new Error('request expected');
        const outsider = privateKeyToAccount(generatePrivateKey()), sourceCount = calls.source;
        const denied = await signRequest({ ...request, caller: { ...request.caller, address: outsider.address.toLowerCase() } }, outsider);
        saved.params.message.parts[0].data.envelope = denied;
        await assert.rejects(rpcTask(service.profile.endpoint, 'message/send', saved.params), /rejected/);
        assert.equal(calls.source, sourceCount, 'recovered runtime admission rejects a valid foreign signature before dispatch');
      }
    });
    await t.test('expiry is fresh in views and cannot regenerate signed terminal work', async () => {
      const id = 'recovered-Boston', count = calls.generated;
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(options.retention.expiresAt) });
      try {
        assert.equal(session.readContent(id, 0), undefined);
        assert.equal(renderSessionPage(session, { token: 'test', nonce: 'test' }).includes(CONTENT), false);
        assert.equal(session.view().invocations.at(-1)!.receipt?.content.contentAvailability, 'expired');
        assert.equal(session.view().invocations.at(-1)!.receipt?.providerOutcome, 'completed');
        await session.wait(session.start({ kind: 'retry', invocationId: id }).id); assert.equal(calls.generated, count);
        assert.throws(() => session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor('Boston') }));
        assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: id, value: 4 }, 'expired-review').id)).state, 'completed');
      } finally { t.mock.timers.reset(); }
      assert.equal(session.readContent(id, 0), undefined);
    });
    await t.test('fresh receipt-only ranking survives stopped providers and Index restart', async () => {
      await select(session, 'Boston');
      assert.equal((await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor('Boston') }, 'before-close').id)).state, 'completed');
      const expected = session.view().discovery!.ranking.policyResult;
      await session.wait(session.start({ kind: 'stop-providers' }).id);
      for (const index of ['A', 'B'] as const) assert.equal((await session.wait(session.start({ kind: 'index', index, state: 'restart' }).id)).state, 'completed');
      assert.deepEqual((await consumer(session.frozenInput())).policyResult, expected);
      const root = dirname(session.frozenInput().privateBundleFiles[0]!.path!);
      for (const text of [...await sweep(root), ...await sweep(options.budgetDirectory), JSON.stringify(session.view())]) {
        for (const prohibited of [CONTENT, 'WRONG-ANSWER-SENTINEL', 'OWNED-KEY-SENTINEL', 'answerBase64']) assert.equal(text.includes(prohibited), false);
      }
    });
    const last = session.readContent('before-close', 0)!; assert.ok(last); last.fill(0);
    const closing = session.close();
    assert.equal(session.readContent('before-close', 0), undefined, 'close fences reads synchronously');
    assert.equal(renderSessionPage(session, { token: 'test', nonce: 'test' }).includes(CONTENT), false);
    await closing;
  }, options);
  assert.equal((await readdir(options.budgetDirectory)).includes('writer.lock'), false);
  assert.ok(JSON.parse(await readFile(join(options.budgetDirectory, 'budget.json'), 'utf8')).runs.length >= 9);
});

test('source and non-cooperative inference resets fence generations and never renew the shared allowance', { timeout: 300000 }, async (t) => {
  const { options, calls } = await setup(t); options.budget.sessionCapMicros = '16';
  const reviewer = 'new' as const;
  const barrier = () => {
    let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release };
  };
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready(); await select(session, 'Chicago');
    const arrived = barrier(), held = barrier(), disconnected = barrier();
    calls.sourceGate = async () => { arrived.release(); await held.promise; }; calls.sourceClosed = disconnected.release;
    assert.throws(() => session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor('Chicago') }));
    session.start({ kind: 'invoke', reviewer, input: inputFor('Chicago') }, 'source-reset');
    await arrived.promise;
    const reset = session.reset();
    try { await disconnected.promise; assert.equal(session.readContent('source-reset', 0), undefined); }
    finally { held.release(); calls.sourceGate = undefined; calls.sourceClosed = undefined; await reset; }
    assert.equal(session.view().generation, 1); assert.deepEqual(session.view().invocations, []);
    assert.equal(calls.generated, 0);
    await session.ready(); await select(session, 'Chicago');
    const generating = barrier(), physical = barrier(), aborted = barrier(), observing = barrier();
    calls.generateGate = async (signal) => { signal.addEventListener('abort', aborted.release, { once: true }); generating.release(); await physical.promise; };
    session.start({ kind: 'invoke', reviewer, input: inputFor('Chicago') }, 'inference-reset');
    await generating.promise;
    const settled = LiveBudget.prototype.settled;
    const observation = t.mock.method(LiveBudget.prototype, 'settled', async function (this: LiveBudget) { observing.release(); return settled.call(this); });
    let complete = false; const second = session.reset().then(() => { complete = true; });
    try {
      await aborted.promise; await observing.promise;
      assert.equal(complete, false, 'logical cancellation cannot claim physical settlement');
      assert.equal(session.view().generation, 1); assert.equal(session.view().status, 'resetting');
      assert.equal(session.readContent('inference-reset', 1), undefined);
      await assert.rejects(LiveBudget.open(options.budgetDirectory, options.budget), /writer/);
    } finally { physical.release(); calls.generateGate = undefined; await second; observation.mock.restore(); }
    assert.equal(session.view().generation, 2); await session.ready(); await select(session, 'Boston');
    const sourceCount = calls.source;
    const invocation = session.start({ kind: 'invoke', reviewer, input: inputFor('Boston') }, 'budget-exhausted');
    assert.equal((await session.wait(invocation.id)).state, 'completed');
    assert.equal(session.view().invocations[0]!.receipt?.providerOutcome, 'failed');
    assert.equal(calls.generated, 1); assert.equal(calls.source, sourceCount);
    const ledger = JSON.parse(await readFile(join(options.budgetDirectory, 'budget.json'), 'utf8'));
    assert.equal(ledger.runs.length, 2); assert.equal(ledger.runs[1].diagnostic.failureReason, 'cancelled');
    assert.equal(session.readContent('inference-reset', 1), undefined);
    assert.equal((await session.wait(session.start({ kind: 'feedback', invocationId: invocation.id, value: 1 }).id)).state, 'completed');
    assert.equal(session.view().feedback[0]!.weighting, 'reviewer-not-accepted', 'caller admission is not reviewer-policy acceptance');
    await session.close(); assert.equal(session.view().status, 'closed'); assert.deepEqual(session.view().invocations, []);
  }, { ...options, admittedReviewer: reviewer });
  assert.equal((await readdir(options.budgetDirectory)).includes('writer.lock'), false);
  const persisted = await readFile(join(options.budgetDirectory, 'budget.json'), 'utf8');
  assert.equal(persisted.includes(CONTENT), false); assert.equal(JSON.parse(persisted).runs.length, 2);
});

test('expiry and reset during actual caller verification do not install late answer copies', { timeout: 180000 }, async (t) => {
  const { options, calls } = await setup(t);
  await withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    await session.ready(); await select(session, 'Chicago');
    for (const scenario of ['expiry', 'reset'] as const) {
      let enter!: () => void, release!: () => void;
      const arrived = new Promise<void>((resolve) => { enter = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
      const target = calls.generated + 1, fetcher = globalThis.fetch;
      let gated = false;
      const intercept = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
        if (!gated && calls.generated === target && String(args[0]).includes('/cards/')) {
          gated = true; enter(); await held;
        }
        return fetcher(...args);
      });
      const operation = session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor('Chicago') }, `${scenario}-verify`);
      try {
        await arrived;
        if (scenario === 'expiry') {
          t.mock.timers.enable({ apis: ['Date'], now: Date.parse(options.retention.expiresAt) }); release();
          assert.equal((await session.wait(operation.id)).state, 'completed');
          const invocation = session.view().invocations.at(-1)!;
          assert.equal(invocation.outcome, 'completed'); assert.equal(invocation.receipt?.content.contentAvailability, 'expired');
          assert.equal(session.readContent(operation.id, 0), undefined);
          t.mock.timers.reset();
          assert.equal(session.readContent(operation.id, 0), undefined, 'verification copy cannot revive after the clock returns');
        } else {
          const reset = session.reset();
          assert.equal(session.readContent(operation.id, 0), undefined); release(); await reset;
          assert.equal(session.view().generation, 1); assert.deepEqual(session.view().invocations, []);
          assert.equal(session.readContent(operation.id, 0), undefined);
        }
      } finally { release(); intercept.mock.restore(); t.mock.timers.reset(); }
    }
  }, options);
});

test('invalid, expired or conflicting licensed configuration rejects before any session callback', async (t) => {
  for (const options of [{ mode: 'unknown' }, { mode: 'fixture', retention: {} }, { mode: 'licensed', executor: () => undefined },
    { mode: 'fixture', secret: 'not-a-setting' }]) {
    let called = false;
    await assert.rejects(withDemoSession('not-used', async () => { called = true; }, options as any));
    assert.equal(called, false);
  }
  const { options, calls } = await setup(t); options.retention.expiresAt = utc(Date.now() - 1000);
  let called = false;
  await assert.rejects(withDemoSession('not-used', async () => { called = true; }, options), /expired/);
  assert.equal(called, false); assert.equal(calls.source, 0); assert.deepEqual(await readdir(options.budgetDirectory), []);
});

test('parent lifecycle cancellation immediately fences licensed reads and waits for cleanup', { timeout: 120000 }, async (t) => {
  const { options } = await setup(t), parent = new AbortController(), reason = new Error('owned parent cancellation');
  let endpoint: string | undefined, heldSession: DemoSession | undefined;
  await assert.rejects(withOwnedLifecycle(() => withDemoSession(process.env.NANDA_INDEX_CHECKOUT!, async (session) => {
    heldSession = session; await session.ready(); await select(session, 'Chicago');
    endpoint = session.view().discovery!.selected[0]!.profile.endpoint;
    assert.equal((await session.wait(session.start({ kind: 'invoke', reviewer: 'accepted', input: inputFor('Chicago') }, 'parent-cancel').id)).state, 'completed');
    const copy = session.readContent('parent-cancel', 0)!; assert.ok(copy); copy.fill(0);
    parent.abort(reason);
    const denied = session.readContent('parent-cancel', 0); const available = denied !== undefined; denied?.fill(0);
    assert.equal(available, false, 'parent cancellation must fence content before awaiting outer close');
    assert.equal(session.view().status, 'resetting');
    assert.throws(() => session.start({ kind: 'refresh', city: 'Chicago' }), /not ready/);
  }, options), parent.signal), (error) => error === reason);
  assert.equal(heldSession?.view().status, 'closed'); assert.equal(heldSession?.readContent('parent-cancel', 0), undefined);
  assert.equal((await readdir(options.budgetDirectory)).includes('writer.lock'), false);
  assert.ok(endpoint); await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(2000) }));
});
