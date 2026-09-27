import assert from 'node:assert/strict';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { owned, json, policy, prices, requestInput } from './fixtures.js';
import { LiveBudget, LiveError } from '../../src/live/budget.js';
import { LiveTransport } from '../../src/live/transport.js';
import { LiveAdapters } from '../../src/live/adapters.js';
import type { EveningPlanInput } from '../../src/a2a/input.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { signRequest, decodeEnvelope } from '../../src/interaction/signatures.js';
import { verifyInteraction } from '../../src/interaction/verify.js';
import { startLoopbackA2AService } from '../../src/a2a/service.js';
import { rpcTask, pollTerminalTask } from '../../src/client/externalClient.js';
import { createOriginRuntimeStrategy } from '../../src/a2a/strategy.js';
import { startStrategyA2AService } from '../../src/a2a/service.js';
import { encodeOriginDocument, decodeOriginEnvelope, type OriginDocument } from '../../src/origin/bytes.js';
import { signOriginStatement, verifyOriginSignature } from '../../src/origin/signatures.js';
import type { OriginProfile, OriginRequest } from '../../src/origin/schema.js';
const modulePath = '../../src/live/answer.js';
async function api() {
  const m = await import(modulePath).catch(() => ({}));
  assert.equal(typeof m.LiveAnswerBackend, 'function', 'source-separated answer backend must be implemented');
  return m as typeof import('../../src/live/answer.js');
}
const summary = 'Fictional Cafe [0] is a source suggestion, not confirmed open.';
async function fixture(t: Parameters<typeof owned>[0], session = false) {
  const seen: string[] = [], queries: string[] = []; let city = 'Chicago';
  const f = await owned(t, (req, res, body) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/events') {
      city = url.searchParams.get('city')!; seen.push('events');
      return json(res, { _embedded: { events: [{ id: 'fictional-event', name: 'EVENT-PRIVATE-SENTINEL', url: 'https://www.ticketmaster.com/event/example', test: false,
        dates: { start: { dateTime: city === 'Chicago' ? '2026-10-04T01:00:00Z' : '2026-10-04T00:00:00Z', localDate: '2026-10-03', localTime: '20:00:00' }, timezone: city === 'Chicago' ? 'America/Chicago' : 'America/New_York', status: { code: 'onsale' } },
        _embedded: { venues: [{ name: 'Fictional Hall', address: { line1: '1 Fictional St' }, city: { name: city }, state: { stateCode: city === 'Chicago' ? 'IL' : 'MA' }, country: { countryCode: 'US' } }] } }] }, page: { size: 10, totalElements: 1, totalPages: 1, number: 0 } });
    }
    const value = body ? JSON.parse(body) : undefined;
    if (url.pathname === '/routes') {
      seen.push('transit'); const departure = Date.parse(value.departureTime);
      return json(res, { routes: [{ duration: '600s', distanceMeters: 1000, warnings: ['ROUTE-PRIVATE-SENTINEL'], legs: [{ steps: [
        { travelMode: 'WALK', staticDuration: '60s' }, { travelMode: 'TRANSIT', transitDetails: { stopDetails: { departureStop: { name: 'A' }, arrivalStop: { name: 'B' },
          departureTime: new Date(departure + 60_000).toISOString().replace('.000Z', 'Z'), arrivalTime: new Date(departure + 600_000).toISOString().replace('.000Z', 'Z') }, transitLine: { name: 'X', agencies: [{ name: 'Fictional Transit' }] } } },
      ] }] }] });
    }
    seen.push(value.method);
    if (value.method === 'initialize') {
      if (session) res.setHeader('Mcp-Session-Id', 'owned-session');
      return json(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    }
    if (value.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (value.method === 'tools/list') return json(res, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search_places', inputSchema: { type: 'object', properties: { text_query: { type: 'string' }, language_code: { type: 'string' }, region_code: { type: 'string' } }, required: ['text_query'] } }] } });
    queries.push(value.params.arguments.text_query);
    json(res, { jsonrpc: '2.0', id: 3, result: { structuredContent: { summary, places: [{ id: 'fictional-cafe', place: 'places/fictional-cafe', googleMapsLinks: { placeUrl: 'https://maps.google.com/?cid=1' }, attribution: { title: 'Google Maps', url: 'https://maps.google.com/?cid=1' } }] } } });
  });
  return { ...f, seen, queries, adapters: new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'KEY-PRIVATE-SENTINEL', ticketmaster: 'KEY-PRIVATE-SENTINEL' } }), policy) };
}

test('six scoped executions share one backend; only intact grounding reaches generation and complete panels preserve unknowns', async (t) => {
  const { LiveAnswerBackend, liveAnswerSchema } = await api(); const f = await fixture(t);
  const prompts: unknown[] = [];
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: {
    mode: 'owned-test', countInputTokens: () => 50, maxOutputTokens: 100,
    generate: async (input) => { prompts.push(input); return { groundedBlock: input.places.summary, selectedPlaceId: 'fictional-cafe', synthesis: 'Provider preference suggestion', inputTokens: 50, outputTokens: 10 }; },
  } });
  for (const city of ['Chicago', 'Boston'] as const) for (const emphasis of ['food', 'culture', 'travel-value'] as const) {
    const input: EveningPlanInput = structuredClone(requestInput) as any;
    if (city === 'Boston') { input.city = city; input.timeWindow = { start: '2026-10-03T18:00:00-04:00', end: '2026-10-03T23:00:00-04:00', timeZone: 'America/New_York' }; }
    const bytes = await backend.execute(input, { city, emphasis }, { taskId: `${city}-${emphasis}`, signal: new AbortController().signal });
    const answer = liveAnswerSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
    assert.equal(answer.city, city); assert.equal(answer.grounding.block, summary);
    assert.equal(answer.grounding.links[0]!.url, 'https://maps.google.com/?cid=1');
    assert.equal(answer.activity.fact?.name, 'EVENT-PRIVATE-SENTINEL');
    assert.deepEqual(answer.transit.fact?.warnings, ['ROUTE-PRIVATE-SENTINEL']);
    assert.equal(answer.costs.dinnerMinor, null); assert.equal(answer.costs.activityMinor, null); assert.equal(answer.costs.transitMinor, null); assert.equal(answer.costs.totalMinor, null);
    assert.ok(answer.gaps.includes('dated-dinner-hours-unverified')); assert.ok(answer.gaps.includes('event-end-unknown')); assert.ok(answer.gaps.includes('budget-fit-unknown'));
    assert.equal(answer.dinner.placeId, 'fictional-cafe'); assert.equal(answer.usage.physicalAttempts, 7);
    assert.equal(answer.grounding.meta.usage.physicalAttempts, 4);
    assert.equal(answer.activity.meta?.usage.physicalAttempts, 1);
    assert.equal(answer.transit.meta?.usage.physicalAttempts, 1);
  }
  assert.equal(prompts.length, 6);
  const captured = JSON.stringify(prompts); for (const prohibited of ['EVENT-PRIVATE-SENTINEL', 'ROUTE-PRIVATE-SENTINEL', 'KEY-PRIVATE-SENTINEL', 'taskId', 'caller', 'signer']) assert.equal(captured.includes(prohibited), false);
  const disk = await readFile(join(f.directory, 'budget.json'), 'utf8');
  for (const prohibited of [summary, 'PRIVATE-SENTINEL', 'https://', 'grounding']) assert.equal(disk.includes(prohibited), false);
});

test('unconfigured inference, unsupported place selection, changed grounded output and token excess fail without fallback', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t);
  assert.throws(() => new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters } as any), /not-configured/);
  for (const scenario of ['place', 'block', 'input', 'output', 'usage']) {
    let generated = 0;
    const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: {
      mode: 'owned-test', countInputTokens: () => scenario === 'input' ? 8001 : 50, maxOutputTokens: scenario === 'output' ? 2001 : 100,
      generate: async () => { generated++; return { groundedBlock: scenario === 'block' ? 'Modified grounded output' : summary,
        selectedPlaceId: scenario === 'place' ? 'invented' : 'fictional-cafe', inputTokens: 50, outputTokens: scenario === 'usage' ? 101 : 10 }; },
    } });
    await assert.rejects(backend.execute(structuredClone(requestInput) as any, { city: 'Chicago', emphasis: 'food' }, { taskId: `bad-${scenario}`, signal: new AbortController().signal }));
    assert.equal(generated, ['input', 'output'].includes(scenario) ? 0 : 1);
  }
});

test('unsupported transport and a short window are explicit gaps, never invented viable transit', async (t) => {
  const { LiveAnswerBackend, liveAnswerSchema } = await api(); const f = await fixture(t);
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => ({ groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }) } });
  const input: EveningPlanInput = structuredClone(requestInput) as any; input.transport = ['car'];
  input.timeWindow.end = '2026-10-03T18:30:00-05:00';
  const bytes = await backend.execute(input, { city: 'Chicago', emphasis: 'food' }, { taskId: 'car', signal: new AbortController().signal });
  const answer = liveAnswerSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
  assert.equal(answer.transit.fact, undefined); assert.ok(answer.gaps.includes('transport-constraint-unsatisfied')); assert.equal(f.seen.includes('transit'), false);
  assert.ok(answer.gaps.includes('window-too-short'));
  assert.equal(answer.dinner.proposedStart, '2026-10-03T23:00:00Z');
  assert.equal(answer.dinner.proposedEnd, '2026-10-03T23:30:00Z');
  assert.deepEqual(f.queries, ['Dinner places in Loop, Chicago, IL, US; opening hours for 2026-10-03 18:00-18:30 America/Chicago; USD budget 30']);
});

test('signed live runtime refuses a non-configured caller and enforces an earlier matching policy with unchanged receipts after expiry', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t), signed = makeInteractionFixture();
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => ({ groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }) } });
  let now = '2026-10-03T20:00:00Z';
  const runtimePolicy = { ...policy, expiresAt: '2026-10-03T20:10:00Z' };
  signed.request.createdAt = now; signed.request.deadline = '2026-10-03T21:00:00Z'; signed.request.input = structuredClone(requestInput) as any;
  const store = join(f.directory, 'tasks'); await mkdir(store);
  const options = { storeDirectory: store, now: () => now, runtimeSigner: signed.runtime, retention: runtimePolicy,
    live: { caller: signed.request.caller }, execute: backend.forScope({ city: 'Chicago', emphasis: 'food' }),
    observeAuthority: async () => ({ basisProfile: signed.profile, currentProfile: signed.profile, continuity: 'unchanged' as const, observedAt: now }) };
  const { live: _admission, ...withoutAdmission } = options;
  let unadmitted: Awaited<ReturnType<typeof startLoopbackA2AService>> | undefined;
  try {
    await assert.rejects(async () => { unadmitted = await startLoopbackA2AService({ ...withoutAdmission, storeDirectory: join(store, 'without-admission') }); }, /live admission/);
  } finally { await unadmitted?.close(); }
  await assert.rejects(readdir(join(store, 'without-admission')), /ENOENT/);
  assert.equal(f.seen.length, 0);
  const service = await startLoopbackA2AService(options);
  t.after(() => service.close());
  const params = (envelope: unknown) => ({ message: { kind: 'message', role: 'user', messageId: 'owned', parts: [{ kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope } }] } });
  const wrong = { ...signed.request, caller: { ...signed.request.caller, address: signed.stranger.address.toLowerCase() as `0x${string}` } };
  await assert.rejects(rpcTask(service.url, 'message/send', params(await signRequest(wrong, signed.stranger))), /rejected/);
  assert.deepEqual(await readdir(store), []); assert.equal(f.seen.length, 0);
  const request = await signRequest(signed.request, signed.caller);
  const accepted = await rpcTask(service.url, 'message/send', params(request));
  await assert.rejects(pollTerminalTask(service.url, accepted.id, 65_000), /invalid task deadline/);
  const completed = await pollTerminalTask(service.url, accepted.id, 65_000, 'live');
  assert.equal(completed.status.state, 'completed');
  const data = completed.artifacts![0]!.parts[0]!.data;
  const acceptance = (completed.metadata!['org.nandacity'] as any).acceptance;
  const evidence = { request, acceptance, completion: data.completion, basisProfile: signed.profile, currentProfile: signed.profile, continuity: 'unchanged' as const, observedAt: now };
  assert.equal((await verifyInteraction({ ...evidence, answerBytes: Buffer.from(data.answerBase64 as string, 'base64') })).completion?.answerBinding, 'matched');
  const disk = await readFile(join(store, (await readdir(store))[0]!), 'utf8');
  for (const raw of [summary, 'PRIVATE-SENTINEL', 'answerBase64']) assert.equal(disk.includes(raw), false);
  now = runtimePolicy.expiresAt;
  const expired = await rpcTask(service.url, 'tasks/get', { id: accepted.id });
  assert.equal(expired.artifacts![0]!.parts[0]!.data.answerBase64, undefined);
  assert.deepEqual(expired.artifacts![0]!.parts[0]!.data.completion, data.completion);
  assert.equal((await verifyInteraction(evidence)).completion?.answerBinding, 'unavailable');
  assert.equal(decodeEnvelope(data.completion).statement.value.kind, 'completion');
});

test('explicit origin live admission uses its own caller method and signed completion, without Ethereum fallback', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t), keys = makeInteractionFixture();
  const key = (account: typeof keys.caller) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
  const profile: OriginProfile = { profile: 'city-origin@0.1', kind: 'profile', service: { method: 'https-origin', identityUrl: 'https://fixture.example/identity' },
    revision: '1', active: true, controllerKey: key(keys.stranger), runtimeKey: key(keys.runtime), cardURL: 'https://fixture.example/card',
    cardDigest: `0x${'aa'.repeat(32)}`, endpoint: 'https://fixture.example/a2a', city: 'Chicago', capability: 'evening-plan' };
  const basis = encodeOriginDocument(await signOriginStatement(profile, keys.stranger)) as OriginDocument<OriginProfile>;
  const request: OriginRequest = { profile: 'city-origin@0.1', kind: 'request', service: profile.service, caller: key(keys.caller),
    interactionId: `0x${'ab'.repeat(32)}`, profileBasis: { profileDigest: basis.documentDigest, cardDigest: profile.cardDigest },
    createdAt: '2026-10-03T20:00:00Z', deadline: '2026-10-03T21:00:00Z', input: structuredClone(requestInput) as any };
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => ({ groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }) } });
  const strategy = createOriginRuntimeStrategy({ basisProfile: () => basis, observeAuthority: async () => ({ current: 'observed', profile: basis, observedAt: request.createdAt, historicalAuthority: 'not-independently-proven' }) });
  const withoutAdmission = { storeDirectory: join(f.directory, 'origin-without-admission'), runtimeSigner: keys.runtime,
    now: () => request.createdAt, retention: policy, strategy, execute: backend.forScope({ city: 'Chicago', emphasis: 'food' }) };
  let unadmitted: Awaited<ReturnType<typeof startStrategyA2AService>> | undefined;
  try {
    await assert.rejects(async () => { unadmitted = await startStrategyA2AService(withoutAdmission); }, /live admission/);
  } finally { await unadmitted?.close(); }
  await assert.rejects(readdir(withoutAdmission.storeDirectory), /ENOENT/);
  assert.equal(f.seen.length, 0);
  const service = await startStrategyA2AService({ storeDirectory: join(f.directory, 'origin-tasks'), runtimeSigner: keys.runtime,
    now: () => request.createdAt, retention: policy, live: { caller: request.caller }, strategy, execute: backend.forScope({ city: 'Chicago', emphasis: 'food' }) });
  t.after(() => service.close());
  const params = (envelope: unknown) => ({ message: { kind: 'message', role: 'user', messageId: 'owned-origin', parts: [{ kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope } }] } });
  const wrong = { ...request, caller: key(keys.stranger) };
  await assert.rejects(rpcTask(service.url, 'message/send', params(await signOriginStatement(wrong, keys.stranger))), /rejected/);
  const submitted = await rpcTask(service.url, 'message/send', params(await signOriginStatement(request, keys.caller)));
  const completed = await pollTerminalTask(service.url, submitted.id, 65_000, 'live');
  assert.equal(completed.status.state, 'completed');
  const completion = completed.artifacts![0]!.parts[0]!.data.completion;
  assert.equal(decodeOriginEnvelope(completion).statement.value.kind, 'completion');
  assert.equal((await verifyOriginSignature(completion, profile.service.identityUrl, 'completion')).status, 'valid');
  assert.equal(f.seen.length, 6);
});

test('source expiry cannot authorize inference even when the overall deadline remains', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t); let generated = 0;
  const adapters = new LiveAdapters(f.adapters.transport, { ...policy, expiresAt: '2026-10-03T20:00:01Z' });
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters, inference: { mode: 'owned-test', maxOutputTokens: 100,
    countInputTokens: () => { void f.ledger.sleep(2000, new AbortController().signal); return 1; },
    generate: async () => { generated++; return { groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }; } } });
  await assert.rejects(backend.execute(structuredClone(requestInput) as any, { city: 'Chicago', emphasis: 'food' }, { taskId: 'expired-source', signal: new AbortController().signal }));
  assert.equal(generated, 0, 'expired licensed material must not reach inference');
});

test('failed composed deadline records cleanup uncertainty without another dispatch or changing the original reason', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t, true); let generated = 0;
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100,
    countInputTokens: () => { void f.ledger.sleep(60_000, new AbortController().signal); return 1; },
    generate: async () => { generated++; return { groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }; } } });
  await assert.rejects(backend.execute(structuredClone(requestInput) as any, { city: 'Chicago', emphasis: 'food' },
    { taskId: 'failed-cleanup', signal: new AbortController().signal }), (error: unknown) => error instanceof LiveError && error.reason === 'deadline');
  assert.equal(generated, 0);
  assert.deepEqual(f.seen, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'events']);
  const record = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8')).runs[0];
  assert.deepEqual(record.diagnostic, { failureReason: 'deadline', cleanup: 'remote-cancellation-unconfirmed' });
  assert.equal(record.closed, true); assert.equal(record.attempts.length, 5);
  assert.equal(f.ledger.snapshot().reservedCostMicros, '5');
  const disk = JSON.stringify(record);
  for (const prohibited of [summary, 'PRIVATE-SENTINEL', 'owned-session', 'http']) assert.equal(disk.includes(prohibited), false);
  await f.ledger.close();
  const reopened = await LiveBudget.open(f.directory, { prices, sessionCapMicros: '10000', runCapMicros: '10', pricingExpiresAt: '2026-10-05T00:00:00Z' });
  try { assert.deepEqual(reopened.snapshot().runs[0]!.diagnostic, record.diagnostic); }
  finally { await reopened.close(); }
});

test('production construction requires explicit matching model-use policy approval, not merely a retention TTL', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t);
  const adapters = new LiveAdapters(new LiveTransport({ mode: 'production', enabled: true, credentials: { google: 'owned-not-used', ticketmaster: 'owned-not-used' } }), policy);
  const inference = { mode: 'provider-accounted' as const, maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => { assert.fail('no real provider call'); } };
  assert.throws(() => new LiveAnswerBackend({ ledger: f.ledger, adapters, inference }), /policy-unapproved/);
  assert.throws(() => new LiveAnswerBackend({ ledger: f.ledger, adapters, inference: { ...inference, approvedGroundingPolicyId: 'different-policy' } }), /policy-unapproved/);
  assert.equal(f.seen.length, 0);
});

test('injected inference response bytes are metered before normalized decoding', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t);
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => ({ groundedBlock: 'x'.repeat(1024 * 1024), inputTokens: 1, outputTokens: 1 }) } });
  await assert.rejects(backend.execute(structuredClone(requestInput) as any, { city: 'Chicago', emphasis: 'food' }, { taskId: 'inference-bytes', signal: new AbortController().signal }), /oversize/);
  assert.equal(f.ledger.snapshot().runs[0]!.attempts.at(-1)!.outcome, 'oversize');
});

test('live runtime rejects a backend policy mismatch or longer expiry before accepting source-backed work', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t), signed = makeInteractionFixture();
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters: f.adapters, inference: { mode: 'owned-test', maxOutputTokens: 100, countInputTokens: () => 1,
    generate: async () => ({ groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }) } });
  const execute = backend.forScope({ city: 'Chicago', emphasis: 'food' });
  assert.deepEqual(execute.retention, policy);
  assert.equal(Object.isFrozen(execute), true); assert.equal(Object.isFrozen(execute.retention), true);
  const base = { storeDirectory: join(f.directory, 'policy-mismatch'), now: () => '2026-10-03T20:00:00Z', runtimeSigner: signed.runtime,
    live: { caller: signed.request.caller }, execute,
    observeAuthority: async () => ({ basisProfile: signed.profile, currentProfile: signed.profile, continuity: 'unchanged' as const, observedAt: '2026-10-03T20:00:00Z' }) };
  for (const retention of [{ ...policy, policyId: 'different-policy' }, { ...policy, expiresAt: '2026-10-05T20:00:00Z' }]) {
    let opened: Awaited<ReturnType<typeof startLoopbackA2AService>> | undefined;
    try {
      await assert.rejects(async () => { opened = await startLoopbackA2AService({ ...base, retention }); }, /executor retention/);
    } finally { await opened?.close(); }
  }
  await assert.rejects(startLoopbackA2AService({ ...base, retention: policy, execute: (request, context) => execute(request, context) }), /executor retention/);
  assert.equal(f.seen.length, 0);
  await assert.rejects(readdir(join(f.directory, 'policy-mismatch')), /ENOENT/);
});

test('queued inference never receives source material that expired while waiting for account slots', async (t) => {
  const { LiveAnswerBackend } = await api(); const f = await fixture(t);
  const blockers = await Promise.all(['blocker-one', 'blocker-two'].map((id) => f.ledger.begin(id)));
  let release!: () => void, queued!: () => void, generated = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const atQueue = new Promise<void>((resolve) => { queued = resolve; });
  let held: Promise<unknown>[] = [];
  const shortPolicy = { ...policy, expiresAt: '2026-10-03T20:00:01Z' };
  const adapters = new LiveAdapters(f.adapters.transport, shortPolicy);
  const acquire = f.ledger.acquire.bind(f.ledger); let admissions = 0;
  const backend = new LiveAnswerBackend({ ledger: f.ledger, adapters, inference: { mode: 'owned-test', maxOutputTokens: 100,
    countInputTokens: () => {
      // Source retrieval has finished. Occupy both real account slots before inference queues.
      held = blockers.map((run) => run.dispatch('places', async () => barrier));
      t.mock.method(f.ledger, 'acquire', async (signal: AbortSignal) => { admissions++; if (admissions === 1) queued(); return acquire(signal); });
      return 1;
    },
    generate: async () => { generated++; return { groundedBlock: summary, selectedPlaceId: 'fictional-cafe', inputTokens: 1, outputTokens: 1 }; } } });
  const pending = backend.execute(structuredClone(requestInput) as any, { city: 'Chicago', emphasis: 'food' }, { taskId: 'queued-expiry', signal: new AbortController().signal });
  await atQueue; await f.ledger.sleep(2000, new AbortController().signal); release();
  await assert.rejects(pending, /deadline|policy-unapproved/);
  await Promise.all(held); for (const blocker of blockers) await blocker.finish();
  assert.equal(generated, 0, 'expired grounding must never cross the injected generation boundary');
});
