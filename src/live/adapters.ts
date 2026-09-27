import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { eveningPlanInputSchema, type EveningPlanInput } from '../a2a/input.js';
import { isUtcSecond } from '../interaction/schema.js';
import { licensedRetentionSchema, type LicensedRetention } from './retention.js';
import { LiveError, type BudgetRun, type LiveFailure } from './budget.js';
import { LiveTransport } from './transport.js';

const text = z.string().min(1).max(32_768).refine((s) => s.isWellFormed());
const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const utc = z.string().refine(isUtcSecond);
const integer = z.number().int().nonnegative().safe();
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
export const sourceSchema = z.enum(['maps-grounding-lite', 'routes', 'ticketmaster']);
export type Source = z.infer<typeof sourceSchema>;
const HOSTS = ['maps.google.com', 'www.google.com', 'maps.app.goo.gl', 'www.ticketmaster.com', 'www.transitchicago.com', 'www.mbta.com'];
export function sourceLink(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new LiveError('invalid-response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[\x00-\x20\\]/.test(value) || !HOSTS.includes(url.hostname)) throw new LiveError('invalid-response');
  return value;
}
const link = z.string().max(4096).refine((s) => { try { sourceLink(s); return true; } catch { return false; } });
const attribution = z.strictObject({ title: text, url: link });
export const placeBundleSchema = z.strictObject({ summary: text, places: z.array(z.strictObject({
  id: identifier, resourceName: text, lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  placeUrl: link, attribution: attribution.optional(),
})).min(1).max(20) });
export type PlaceBundle = z.infer<typeof placeBundleSchema>;
export const eventFactSchema = z.strictObject({ id: identifier, name: text, url: link, start: utc, end: utc.optional(),
  timeZone: z.enum(['America/Chicago', 'America/New_York']), status: z.literal('onsale'), venueAddress: text,
  price: z.strictObject({ currency: z.literal('USD'), minMinor: decimal, maxMinor: decimal }).optional() });
export type EventFact = z.infer<typeof eventFactSchema>;
const transitStepSchema = z.strictObject({ mode: z.enum(['WALK', 'TRANSIT']), durationSeconds: z.number().nonnegative().max(86400).optional(),
  instruction: text.optional(), departureStop: text.optional(), arrivalStop: text.optional(), departureTime: utc.optional(), arrivalTime: utc.optional(),
  line: text.optional(), headsign: text.optional(), agencies: z.array(z.strictObject({ name: text, url: link.optional() })).max(10).optional() });
export const transitFactSchema = z.strictObject({ durationSeconds: z.number().positive().max(86400), distanceMeters: integer,
  steps: z.array(transitStepSchema).min(1).max(200), warnings: z.array(text).max(100), fareMinor: decimal.optional() });
export type TransitFact = z.infer<typeof transitFactSchema>;
export const sourceMetaSchema = z.strictObject({ source: sourceSchema, sourceId: identifier, retrievedAt: utc, policyId: text, expiresAt: utc,
  links: z.array(attribution).max(40), usage: z.strictObject({ physicalAttempts: integer.max(10), reservedCostMicros: decimal }),
  coverage: z.enum(['complete', 'truncated']).optional(), excludedCandidates: integer.max(10).optional() });
export type SourceMeta = z.infer<typeof sourceMetaSchema>;
export type SourceResult<T> = { status: 'ok'; data: T; meta: SourceMeta } | { status: 'empty'; meta: SourceMeta } |
  { status: 'unavailable'; source: Source; reason: LiveFailure };
const rawPlace = z.object({ summary: text, places: z.array(z.object({ id: identifier, place: text,
  location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  googleMapsLinks: z.object({ placeUrl: link }), attribution: attribution.optional() })).max(20) });
function decodePlaces(value: unknown): PlaceBundle | undefined {
  const raw = rawPlace.parse(value);
  if (!raw.places.length) return undefined;
  if (new Set(raw.places.map((p) => p.id)).size !== raw.places.length || raw.places.some((p) => p.place !== `places/${p.id}`) ||
    [...raw.summary.matchAll(/\[(\d+)\]/g)].some((match) => Number(match[1]) >= raw.places.length)) throw new LiveError('invalid-response');
  return placeBundleSchema.parse({ summary: raw.summary, places: raw.places.map((p) => ({ id: p.id, resourceName: p.place,
    ...(p.location ? { lat: p.location.latitude, lng: p.location.longitude } : {}), placeUrl: p.googleMapsLinks.placeUrl,
    ...(p.attribution ? { attribution: p.attribution } : {}) })) });
}
function dialect(value: unknown): 'snake' | 'camel' {
  const list = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })).max(100), nextCursor: z.string().optional() }).parse(value);
  if (list.nextCursor !== undefined) throw new LiveError('unsupported-contract');
  const found = list.tools.filter((tool) => tool.name === 'search_places');
  if (found.length !== 1) throw new LiveError('unsupported-contract');
  const schema = z.strictObject({ type: z.literal('object'), properties: z.record(z.string(), z.strictObject({ type: z.literal('string'), description: z.string().optional(), title: z.string().optional() })),
    required: z.array(z.string()).max(3), description: z.string().optional(), title: z.string().optional(),
    $schema: z.string().optional(), additionalProperties: z.boolean().optional() }).parse(found[0]!.inputSchema);
  for (const [name, keys] of [['snake', ['text_query', 'language_code', 'region_code']], ['camel', ['textQuery', 'languageCode', 'regionCode']]] as const) {
    if (Object.keys(schema.properties).length === 3 && keys.every((key) => key in schema.properties) && schema.required.includes(keys[0]) &&
      new Set(schema.required).size === schema.required.length && schema.required.every((key) => (keys as readonly string[]).includes(key))) return name;
  }
  throw new LiveError('unsupported-contract');
}
export function utcSecond(ms: number): string { return new Date(ms).toISOString().replace('.000Z', 'Z'); }
export function proposedDinnerInterval(input: EveningPlanInput): { start: number; end: number } {
  const start = Date.parse(input.timeWindow.start);
  return { start, end: Math.min(start + 3600_000, Date.parse(input.timeWindow.end)) };
}
function dinnerQuery(input: EveningPlanInput): string {
  const end = new Intl.DateTimeFormat('en-GB', { timeZone: input.timeWindow.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(proposedDinnerInterval(input).end));
  const cents = BigInt(input.budget.minorUnits);
  const dollars = `${cents / 100n}${cents % 100n ? `.${(cents % 100n).toString().padStart(2, '0')}` : ''}`;
  return `Dinner places in ${input.area}, ${input.city}, ${input.city === 'Chicago' ? 'IL' : 'MA'}, US; opening hours for ${input.timeWindow.start.slice(0, 10)} ${input.timeWindow.start.slice(11, 16)}-${end} ${input.timeWindow.timeZone}; USD budget ${dollars}`;
}
const rawEventSchema = z.object({ id: identifier, name: text, url: link, test: z.boolean(),
  dates: z.object({ start: z.object({ dateTime: z.string().optional(), localDate: z.string().optional(), localTime: z.string().optional(),
    dateTBD: z.boolean().optional(), dateTBA: z.boolean().optional(), timeTBA: z.boolean().optional(), noSpecificTime: z.boolean().optional() }),
    timezone: z.string(), status: z.object({ code: z.string() }), end: z.object({ dateTime: z.string().optional() }).optional() }),
  priceRanges: z.array(z.object({ currency: z.string(), min: z.number().finite().nonnegative(), max: z.number().finite().nonnegative() })).max(10).optional(),
  _embedded: z.object({ venues: z.array(z.object({ name: text, address: z.object({ line1: text, line2: text.optional() }),
    city: z.object({ name: text }), state: z.object({ stateCode: text }), country: z.object({ countryCode: text }) })).min(1).max(10) }) });
function localParts(utcTime: string, zone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(utcTime)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}
function minor(value: number): string {
  const scaled = value * 100;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-7) throw new LiveError('invalid-response');
  return Math.round(scaled).toString();
}
function eventFact(value: unknown, input: EveningPlanInput): EventFact | undefined {
  const event = rawEventSchema.parse(value), start = event.dates.start, venue = event._embedded.venues[0]!;
  if (event.test || event.dates.status.code !== 'onsale' || start.dateTBD || start.dateTBA || start.timeTBA || start.noSpecificTime ||
    !start.dateTime || !isUtcSecond(start.dateTime) || event.dates.timezone !== input.timeWindow.timeZone ||
    venue.city.name !== input.city || venue.state.stateCode !== (input.city === 'Chicago' ? 'IL' : 'MA') || venue.country.countryCode !== 'US' ||
    Date.parse(start.dateTime) < Date.parse(input.timeWindow.start) || Date.parse(start.dateTime) >= Date.parse(input.timeWindow.end)) return undefined;
  const local = localParts(start.dateTime, input.timeWindow.timeZone);
  if (local.date !== start.localDate || local.time !== start.localTime) return undefined;
  const end = event.dates.end?.dateTime;
  if (end && (!isUtcSecond(end) || Date.parse(end) <= Date.parse(start.dateTime))) throw new LiveError('invalid-response');
  let price: EventFact['price'];
  if (event.priceRanges?.length && event.priceRanges.every((p) => p.currency === 'USD')) {
    if (event.priceRanges.some((p) => p.max < p.min)) throw new LiveError('invalid-response');
    price = { currency: 'USD', minMinor: minor(Math.min(...event.priceRanges.map((p) => p.min))), maxMinor: minor(Math.max(...event.priceRanges.map((p) => p.max))) };
  }
  return eventFactSchema.parse({ id: event.id, name: event.name, url: event.url, start: start.dateTime,
    ...(end ? { end } : {}), timeZone: event.dates.timezone, status: 'onsale',
    venueAddress: [venue.address.line1, venue.address.line2, venue.city.name, venue.state.stateCode, venue.country.countryCode].filter(Boolean).join(', '), ...(price ? { price } : {}) });
}
const duration = z.string().regex(/^\d+(?:\.\d{1,9})?s$/).transform((s) => Number(s.slice(0, -1))).pipe(z.number().nonnegative().max(86400));
const rawStep = z.object({ travelMode: z.enum(['WALK', 'TRANSIT']), staticDuration: duration.optional(),
  navigationInstruction: z.object({ instructions: text }).optional(), transitDetails: z.object({
    stopDetails: z.object({ departureStop: z.object({ name: text }), arrivalStop: z.object({ name: text }), departureTime: utc, arrivalTime: utc }),
    headsign: text.optional(), transitLine: z.object({ name: text.optional(), nameShort: text.optional(),
      agencies: z.array(z.object({ name: text, uri: link.optional() })).max(10) }),
  }).optional() });
function transitFact(value: unknown, departure: string): TransitFact | undefined {
  const raw = z.object({ routes: z.array(z.object({ duration, distanceMeters: integer, warnings: z.array(text).max(100).optional(),
    legs: z.array(z.object({ steps: z.array(rawStep).min(1).max(200) })).min(1).max(10),
    travelAdvisory: z.object({ transitFare: z.object({ currencyCode: z.string(), units: z.string().regex(/^\d+$/), nanos: z.number().int().min(0).max(999999999).optional() }).optional() }).optional(),
  })).max(1).optional() }).parse(value);
  if (!raw.routes?.length) return undefined;
  const route = raw.routes[0]!, steps: TransitFact['steps'] = []; let cursor = Date.parse(departure), hasTransit = false;
  for (const step of route.legs.flatMap((leg) => leg.steps)) {
    const details = step.transitDetails;
    const base = { mode: step.travelMode, ...(step.staticDuration === undefined ? {} : { durationSeconds: step.staticDuration }),
      ...(step.navigationInstruction ? { instruction: step.navigationInstruction.instructions } : {}) };
    if (step.travelMode === 'WALK') {
      if (details || step.staticDuration === undefined) throw new LiveError('invalid-response');
      cursor += step.staticDuration * 1000; steps.push(base); continue;
    }
    if (!details) throw new LiveError('invalid-response');
    const stop = details.stopDetails, line = details.transitLine.nameShort ?? details.transitLine.name;
    if (!line || Date.parse(stop.departureTime) < cursor || Date.parse(stop.arrivalTime) <= Date.parse(stop.departureTime)) throw new LiveError('invalid-response');
    hasTransit = true; cursor = Date.parse(stop.arrivalTime);
    steps.push({ ...base, departureStop: stop.departureStop.name, arrivalStop: stop.arrivalStop.name,
      departureTime: stop.departureTime, arrivalTime: stop.arrivalTime, line,
      ...(details.headsign ? { headsign: details.headsign } : {}), agencies: details.transitLine.agencies.map((a) => ({ name: a.name, ...(a.uri ? { url: a.uri } : {}) })) });
  }
  if (!hasTransit || cursor > Date.parse(departure) + route.duration * 1000) throw new LiveError('invalid-response');
  let fareMinor: string | undefined;
  const fare = route.travelAdvisory?.transitFare;
  if (fare?.currencyCode === 'USD') {
    const nanos = fare.nanos ?? 0;
    if (fare.units.length > 12 || nanos % 10_000_000 !== 0) throw new LiveError('invalid-response');
    fareMinor = (BigInt(fare.units) * 100n + BigInt(nanos / 10_000_000)).toString();
  }
  return transitFactSchema.parse({ durationSeconds: route.duration, distanceMeters: route.distanceMeters, steps, warnings: route.warnings ?? [], ...(fareMinor === undefined ? {} : { fareMinor }) });
}

export class LiveAdapters {
  #session = new WeakMap<BudgetRun, string>();
  #attempted = new WeakSet<BudgetRun>();
  #pending = new WeakMap<BudgetRun, number>();
  readonly #retention: Readonly<LicensedRetention>;
  get retention(): Readonly<LicensedRetention> { return this.#retention; }
  constructor(readonly transport: LiveTransport, retention: LicensedRetention) { this.#retention = Object.freeze(licensedRetentionSchema.parse(retention)); }
  private meta(run: BudgetRun, source: Source, before: ReturnType<BudgetRun['usage']>, links: SourceMeta['links'] = []): SourceMeta {
    const after = run.usage();
    return sourceMetaSchema.parse({ source, sourceId: source, retrievedAt: utcSecond(Math.floor(run.now() / 1000) * 1000),
      policyId: this.retention.policyId, expiresAt: this.retention.expiresAt, links,
      usage: { physicalAttempts: after.physicalAttempts - before.physicalAttempts, reservedCostMicros: (BigInt(after.reservedCostMicros) - BigInt(before.reservedCostMicros)).toString() } });
  }
  private available(run: BudgetRun): void { if (run.now() >= Date.parse(this.retention.expiresAt)) throw new LiveError('policy-unapproved'); }
  async places(run: BudgetRun, supplied: EveningPlanInput): Promise<SourceResult<PlaceBundle>> {
    const before = run.usage();
    try {
      this.available(run); const input = eveningPlanInputSchema.parse(supplied);
      if (this.#attempted.has(run)) throw new LiveError('unsupported-contract');
      this.#attempted.add(run);
      this.#pending.set(run, 1);
      const init = await this.transport.request(run, 'places', 'initialize', { method: 'POST', rpcId: 1, body: {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nandacity-live', version: '0.1' } } } });
      this.#pending.delete(run);
      if (init.sessionId) this.#session.set(run, init.sessionId);
      const initialized = z.object({ protocolVersion: z.literal('2025-06-18'), capabilities: z.object({ tools: z.object({}) }) }).safeParse(init.value);
      if (!initialized.success) throw new LiveError('unsupported-contract');
      const headers = { 'MCP-Protocol-Version': '2025-06-18', ...(init.sessionId ? { 'Mcp-Session-Id': init.sessionId } : {}) };
      await this.transport.request(run, 'places', 'initialized', { method: 'POST', headers, notification: true, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
      this.#pending.set(run, 2);
      const list = await this.transport.request(run, 'places', 'list', { method: 'POST', headers, rpcId: 2, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
      this.#pending.delete(run);
      let selected: 'snake' | 'camel'; try { selected = dialect(list.value); } catch { throw new LiveError('unsupported-contract'); }
      const query = dinnerQuery(input);
      this.#pending.set(run, 3);
      const response = await this.transport.request(run, 'places', 'places', { method: 'POST', headers, rpcId: 3, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'search_places', arguments: selected === 'snake' ? { text_query: query, language_code: 'en', region_code: 'US' } : { textQuery: query, languageCode: 'en', regionCode: 'US' },
      } } });
      this.#pending.delete(run);
      const result = z.object({ structuredContent: z.unknown().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).max(1).optional() }).parse(response.value);
      const textContent: unknown = result.content?.[0] ? JSON.parse(result.content[0].text) : undefined;
      if (result.structuredContent !== undefined && textContent !== undefined && !isDeepStrictEqual(result.structuredContent, textContent)) throw new LiveError('invalid-response');
      const data = decodePlaces(result.structuredContent ?? textContent);
      const meta = this.meta(run, 'maps-grounding-lite', before, data?.places.flatMap((p) => [{ title: 'Google Maps', url: p.placeUrl }, ...(p.attribution ? [p.attribution] : [])]) ?? []);
      return data ? { status: 'ok', data, meta } : { status: 'empty', meta };
    } catch (error) {
      if (!(error instanceof LiveError) || !['cancelled', 'deadline', 'ambiguous-dispatch'].includes(error.reason)) this.#pending.delete(run);
      return { status: 'unavailable', source: 'maps-grounding-lite', reason: error instanceof LiveError ? error.reason : 'invalid-response' }; }
  }
  async events(run: BudgetRun, supplied: EveningPlanInput): Promise<SourceResult<EventFact[]>> {
    const before = run.usage();
    try {
      this.available(run); const input = eveningPlanInputSchema.parse(supplied);
      const response = await this.transport.request(run, 'events', 'events', { method: 'GET', query: { city: input.city, stateCode: input.city === 'Chicago' ? 'IL' : 'MA', countryCode: 'US',
        startDateTime: utcSecond(Date.parse(input.timeWindow.start)), endDateTime: utcSecond(Date.parse(input.timeWindow.end)), includeTBA: 'no', includeTBD: 'no', includeTest: 'no', size: '10', page: '0', sort: 'date,asc', locale: 'en-us' } });
      const raw = z.object({ _embedded: z.object({ events: z.array(z.unknown()).max(10).optional() }).optional(),
        page: z.object({ size: integer.min(1).max(10), totalElements: integer, totalPages: integer, number: z.literal(0) }) }).parse(response.value);
      const entries = raw._embedded?.events ?? [];
      if (raw.page.totalElements < entries.length || raw.page.totalPages !== Math.ceil(raw.page.totalElements / raw.page.size) || entries.length !== Math.min(raw.page.size, raw.page.totalElements)) throw new LiveError('invalid-response');
      const data = entries.map((event) => eventFact(event, input)).filter((event): event is EventFact => event !== undefined);
      if (new Set(data.map((e) => e.id)).size !== data.length) throw new LiveError('invalid-response');
      const meta = { ...this.meta(run, 'ticketmaster', before, data.map((event) => ({ title: event.name, url: event.url }))),
        coverage: raw.page.totalElements > entries.length ? 'truncated' as const : 'complete' as const, excludedCandidates: entries.length - data.length };
      return data.length ? { status: 'ok', data, meta } : { status: 'empty', meta };
    } catch (error) { return { status: 'unavailable', source: 'ticketmaster', reason: error instanceof LiveError ? error.reason : 'invalid-response' }; }
  }
  async transit(run: BudgetRun, input: { placeId: string; venueAddress: string; departure: string }): Promise<SourceResult<TransitFact>> {
    const before = run.usage();
    try {
      this.available(run); identifier.parse(input.placeId); text.parse(input.venueAddress); utc.parse(input.departure);
      const difference = Date.parse(input.departure) - run.now();
      if (difference < -7 * 86400_000 || difference > 100 * 86400_000) throw new LiveError('unsupported-contract');
      const response = await this.transport.request(run, 'transit', 'transit', { method: 'POST', headers: { 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.warnings,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare' },
        body: { origin: { placeId: input.placeId }, destination: { address: input.venueAddress }, travelMode: 'TRANSIT', departureTime: input.departure,
          computeAlternativeRoutes: false, languageCode: 'en-US', units: 'IMPERIAL' } });
      const data = transitFact(response.value, input.departure), meta = this.meta(run, 'routes', before, [{ title: 'Google Maps', url: 'https://maps.google.com/' }]);
      return data ? { status: 'ok', data, meta } : { status: 'empty', meta };
    } catch (error) { return { status: 'unavailable', source: 'routes', reason: error instanceof LiveError ? error.reason : 'invalid-response' }; }
  }
  async close(run: BudgetRun): Promise<'not-needed' | 'closed' | 'unsupported' | 'remote-cancellation-unconfirmed'> {
    const session = this.#session.get(run); this.#session.delete(run);
    const pending = this.#pending.get(run); this.#pending.delete(run);
    if (!session) return pending === undefined ? 'not-needed' : 'remote-cancellation-unconfirmed';
    try {
      const headers = { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': session };
      if (pending !== undefined) await this.transport.request(run, 'places', 'cancel', { method: 'POST', headers, notification: true,
        body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: pending, reason: 'cancelled' } } });
      // Never silently re-open a failed session. Cleanup has no hidden retry.
      const response = await this.transport.request(run, 'places', 'delete', { method: 'DELETE', cleanup: true,
        headers });
      return response.status === 405 ? 'unsupported' : 'closed';
    } catch { return 'remote-cancellation-unconfirmed'; }
  }
}
