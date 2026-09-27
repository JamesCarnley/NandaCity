import assert from 'node:assert/strict';
import test from 'node:test';
import { owned, json, policy, requestInput } from './fixtures.js';
import { LiveTransport } from '../../src/live/transport.js';
const modulePath = '../../src/live/adapters.js';
async function api() {
  const m = await import(modulePath).catch(() => ({}));
  assert.equal(typeof m.LiveAdapters, 'function', 'known source adapters must be implemented');
  return m as typeof import('../../src/live/adapters.js');
}
export const placePayload = { summary: 'Fictional Example Cafe [0] has source-claimed hours.',
  places: [{ place: 'places/test-place', id: 'test-place', googleMapsLinks: { placeUrl: 'https://maps.google.com/?cid=1' },
    attribution: { title: 'Google Maps', url: 'https://maps.google.com/?cid=1' } }] };
export const eventPayload = { _embedded: { events: [{ id: 'fictional-event', name: 'Fictional Concert', url: 'https://www.ticketmaster.com/event/fictional', test: false,
  dates: { start: { dateTime: '2026-10-04T01:00:00Z', localDate: '2026-10-03', localTime: '20:00:00', dateTBD: false, dateTBA: false, timeTBA: false, noSpecificTime: false },
    timezone: 'America/Chicago', status: { code: 'onsale' } }, priceRanges: [{ currency: 'USD', min: 5, max: 10 }],
  _embedded: { venues: [{ name: 'Example Hall', address: { line1: '1 Example St' }, city: { name: 'Chicago' }, state: { stateCode: 'IL' }, country: { countryCode: 'US' } }] } }] },
  page: { size: 10, totalElements: 1, totalPages: 1, number: 0 } };
export const transitPayload = { routes: [{ duration: '600s', distanceMeters: 1000, warnings: ['Fictional service warning'], legs: [{ steps: [
  { travelMode: 'WALK', staticDuration: '60s', navigationInstruction: { instructions: 'Walk to Fictional Stop' } },
  { travelMode: 'TRANSIT', staticDuration: '540s', transitDetails: { stopDetails: { departureStop: { name: 'Fictional A' }, arrivalStop: { name: 'Fictional B' }, departureTime: '2026-10-04T00:01:00Z', arrivalTime: '2026-10-04T00:10:00Z' },
    headsign: 'Fictional North', transitLine: { nameShort: 'X', agencies: [{ name: 'Example Transit', uri: 'https://www.transitchicago.com/' }] } } },
] }], travelAdvisory: { transitFare: { currencyCode: 'USD', units: '2', nanos: 500000000 } } }] };
export function toolSchema(camel = false) {
  return { tools: [{ name: 'search_places', inputSchema: { type: 'object', properties: camel ?
    { textQuery: { type: 'string' }, languageCode: { type: 'string' }, regionCode: { type: 'string' } } :
    { text_query: { type: 'string' }, language_code: { type: 'string' }, region_code: { type: 'string' } }, required: [camel ? 'textQuery' : 'text_query'] } }] };
}

test('four exact MCP posts negotiate explicit dialects and preserve intact places with metered session cleanup', async (t) => {
  const { LiveAdapters } = await api();
  for (const camel of [false, true]) await t.test(camel ? 'camel no-session' : 'snake session', async (t) => {
    const seen: { method: string; headers: Record<string, unknown>; body: any }[] = [];
    const f = await owned(t, (req, res, body) => {
      const value = body ? JSON.parse(body) : undefined; seen.push({ method: req.method!, headers: req.headers, body: value });
      if (req.method === 'DELETE') { res.writeHead(405); return res.end(); }
      if (value.method === 'initialize') {
        if (!camel) res.setHeader('Mcp-Session-Id', 'owned-session');
        return json(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owned', version: '1' } } });
      }
      if (value.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (value.method === 'tools/list') return json(res, { jsonrpc: '2.0', id: 2, result: toolSchema(camel) });
      return json(res, { jsonrpc: '2.0', id: 3, result: { structuredContent: placePayload } });
    });
    const run = await f.ledger.begin(`mcp-${camel}`); f.finishRuns.push(run);
    const adapter = new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'owned-key', ticketmaster: 'owned-key' } }), policy);
    const result = await adapter.places(run, structuredClone(requestInput) as any);
    assert.equal(result.status, 'ok'); if (result.status !== 'ok') return;
    assert.equal(result.data.summary, placePayload.summary);
    assert.equal(result.data.places[0]!.id, 'test-place');
    assert.deepEqual(seen[0]!.body, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nandacity-live', version: '0.1' } } });
    assert.deepEqual(seen[1]!.body, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual(seen[2]!.body, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(seen[3]!.body, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_places', arguments: camel ? {
      textQuery: 'Dinner places in Loop, Chicago, IL, US; opening hours for 2026-10-03 18:00-19:00 America/Chicago; USD budget 30', languageCode: 'en', regionCode: 'US',
    } : { text_query: 'Dinner places in Loop, Chicago, IL, US; opening hours for 2026-10-03 18:00-19:00 America/Chicago; USD budget 30', language_code: 'en', region_code: 'US' } } });
    assert.equal(seen[0]!.headers['x-goog-api-key'], 'owned-key');
    assert.equal(seen[0]!.headers.accept, 'application/json, text/event-stream');
    assert.equal(seen[2]!.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(seen[2]!.headers['mcp-session-id'], camel ? undefined : 'owned-session');
    assert.equal(await adapter.close(run), camel ? 'not-needed' : 'unsupported');
    assert.equal(seen.length, camel ? 4 : 5);
  });
});

test('MCP unsupported negotiation/schema, bad citations, unsafe links and conflicting results never trigger extra work', async (t) => {
  const { LiveAdapters } = await api();
  for (const scenario of ['version', 'schema', 'constrained-schema', 'citations', 'url', 'dual', 'isError', 'rpcError', 'text']) await t.test(scenario, async (t) => {
    let count = 0;
    const f = await owned(t, (_req, res, body) => {
      const value = JSON.parse(body); count++;
      if (value.method === 'initialize') return json(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: scenario === 'version' ? 'unknown' : '2025-06-18', capabilities: { tools: {} } } });
      if (value.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (value.method === 'tools/list') { const schema = toolSchema(); if (scenario === 'schema') schema.tools[0]!.inputSchema.required.push('unknown');
        if (scenario === 'constrained-schema') (schema.tools[0]!.inputSchema as any).oneOf = [{ required: ['externalUrl'] }];
        return json(res, { jsonrpc: '2.0', id: 2, result: schema }); }
      const payload = structuredClone(placePayload);
      if (scenario === 'citations') payload.summary += ' [9]';
      if (scenario === 'url') payload.places[0]!.googleMapsLinks.placeUrl = 'https://maps.google.com@evil.example/';
      const result = scenario === 'text' ? { content: [{ type: 'text', text: JSON.stringify(payload) }] } :
        { structuredContent: payload, ...(scenario === 'dual' ? { content: [{ type: 'text', text: '{}' }] } : {}), ...(scenario === 'isError' ? { isError: true } : {}) };
      json(res, scenario === 'rpcError' ? { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'PRIVATE' } } : { jsonrpc: '2.0', id: 3, result });
    });
    const run = await f.ledger.begin(`mcp-${scenario}`); f.finishRuns.push(run);
    const adapter = new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } }), policy);
    const result = await adapter.places(run, structuredClone(requestInput) as any);
    assert.equal(result.status, scenario === 'text' ? 'ok' : 'unavailable'); assert.equal(count, scenario === 'version' ? 1 : scenario.endsWith('schema') ? 3 : 4);
  });
});

test('events use exact bounded query; dates/status/city ambiguity is excluded and coverage/unknowns stay explicit', async (t) => {
  const { LiveAdapters } = await api(); let payload: any = structuredClone(eventPayload); let query: URL | undefined;
  const f = await owned(t, (req, res) => { query = new URL(req.url!, 'http://localhost'); json(res, payload); });
  const adapter = new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'owned-key' } }), policy);
  let counter = 0;
  async function events() { const run = await f.ledger.begin(`event-${counter++}`); const result = await adapter.events(run, structuredClone(requestInput) as any); await run.finish(); return result; }
  const result = await events(); assert.equal(result.status, 'ok');
  assert.deepEqual(Object.fromEntries(query!.searchParams), { city: 'Chicago', stateCode: 'IL', countryCode: 'US', startDateTime: '2026-10-03T23:00:00Z', endDateTime: '2026-10-04T04:00:00Z', includeTBA: 'no', includeTBD: 'no', includeTest: 'no', size: '10', page: '0', sort: 'date,asc', locale: 'en-us', apikey: 'owned-key' });
  if (result.status === 'ok') { assert.equal(result.data[0]!.end, undefined); assert.deepEqual(result.data[0]!.price, { currency: 'USD', minMinor: '500', maxMinor: '1000' }); }
  for (const status of ['cancelled', 'postponed', 'rescheduled', 'offsale', 'unknown']) {
    payload = structuredClone(eventPayload); payload._embedded.events[0].dates.status.code = status;
    assert.equal((await events()).status, 'empty');
  }
  for (const mutate of [
    (e: any) => { e.test = true; }, (e: any) => { e.dates.start.timeTBA = true; },
    (e: any) => { e.dates.start.localDate = '2026-02-30'; }, (e: any) => { e.dates.timezone = 'America/New_York'; },
    (e: any) => { e._embedded.venues[0].city.name = 'Boston'; },
  ]) { payload = structuredClone(eventPayload); mutate(payload._embedded.events[0]); assert.equal((await events()).status, 'empty'); }
  payload = structuredClone(eventPayload); delete payload._embedded.events[0].priceRanges; payload.page.size = 1; payload.page.totalElements = 12; payload.page.totalPages = 12;
  const truncated = await events(); assert.equal(truncated.status, 'ok');
  if (truncated.status === 'ok') { assert.equal(truncated.data[0]!.price, undefined); assert.equal(truncated.meta.coverage, 'truncated'); }
  payload = { _embedded: {}, page: { size: 10, number: 0, totalElements: 0, totalPages: 0 } }; assert.equal((await events()).status, 'empty');
  payload = { _embedded: {} }; assert.equal((await events()).status, 'unavailable');
});

test('routes use selected place and explicit departure; walking/transit chronology, warnings and exact money survive', async (t) => {
  const { LiveAdapters } = await api(); let payload: any = structuredClone(transitPayload), body: any, mask: unknown;
  const f = await owned(t, (req, res, text) => { body = JSON.parse(text); mask = req.headers['x-goog-fieldmask']; json(res, payload); });
  const adapter = new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } }), policy);
  let counter = 0;
  async function transit() { const run = await f.ledger.begin(`transit-${counter++}`); const result = await adapter.transit(run, { placeId: 'test-place', venueAddress: '1 Example St, Chicago, IL, US', departure: '2026-10-04T00:00:00Z' }); await run.finish(); return result; }
  const result = await transit(); assert.equal(result.status, 'ok');
  assert.deepEqual(body, { origin: { placeId: 'test-place' }, destination: { address: '1 Example St, Chicago, IL, US' }, travelMode: 'TRANSIT', departureTime: '2026-10-04T00:00:00Z', computeAlternativeRoutes: false, languageCode: 'en-US', units: 'IMPERIAL' });
  assert.equal(mask, 'routes.duration,routes.distanceMeters,routes.warnings,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare');
  if (result.status === 'ok') { assert.equal(result.data.fareMinor, '250'); assert.deepEqual(result.data.warnings, ['Fictional service warning']); }
  delete payload.routes[0].travelAdvisory; const missingFare = await transit(); if (missingFare.status === 'ok') assert.equal(missingFare.data.fareMinor, undefined); else assert.fail();
  for (const mutate of [
    (p: any) => { p.routes[0].legs[0].steps[1].transitDetails.stopDetails.arrivalTime = '2026-10-03T23:59:00Z'; },
    (p: any) => { p.routes[0].legs[0].steps.pop(); },
    (p: any) => { p.routes[0].legs[0].steps[1].transitDetails.transitLine.agencies[0].uri = 'https://evil.example/'; },
  ]) { payload = structuredClone(transitPayload); mutate(payload); assert.equal((await transit()).status, 'unavailable'); }
  for (const empty of [{}, { routes: [] }]) { payload = empty; assert.equal((await transit()).status, 'empty'); }
  payload = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'SECRET' } }; const error = await transit(); assert.equal(error.status, 'unavailable'); if (error.status === 'unavailable') assert.equal(error.reason, 'quota');
});

test('cancellation meters the pending MCP notification and DELETE without reopening a failed session', async (t) => {
  const { LiveAdapters } = await api(); const messages: any[] = [];
  let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const f = await owned(t, (req, res, body) => {
    if (req.method === 'DELETE') { messages.push('DELETE'); res.writeHead(204); return res.end(); }
    const value = JSON.parse(body); messages.push(value);
    if (value.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'owned-session'); return json(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }); }
    if (value.method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
    if (value.method === 'tools/list') return json(res, { jsonrpc: '2.0', id: 2, result: toolSchema() });
    entered(); // Deliberately unresolved upstream request; cancellation must abort local fetch.
  });
  const run = await f.ledger.begin('cancelled-session'); f.finishRuns.push(run);
  const adapter = new LiveAdapters(new LiveTransport({ mode: 'local-test', endpoints: f.endpoints, credentials: { google: 'x', ticketmaster: 'x' } }), policy);
  const pending = adapter.places(run, structuredClone(requestInput) as any);
  await waiting; run.cancel(); const result = await pending;
  assert.deepEqual(result, { status: 'unavailable', source: 'maps-grounding-lite', reason: 'cancelled' });
  assert.equal(await adapter.close(run), 'closed');
  assert.deepEqual(messages[4], { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'cancelled' } });
  assert.equal(messages[5], 'DELETE'); assert.equal(run.usage().physicalAttempts, 6);
  assert.equal((await adapter.places(run, structuredClone(requestInput) as any)).status, 'unavailable'); assert.equal(messages.length, 6);
});
