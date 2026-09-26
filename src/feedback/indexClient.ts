import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, toEventSelector, type Hex } from 'viem';
import { z } from 'zod';

function fail(field: string): never { throw new Error(`invalid Index feedback ${field}`); }
const uint = (bits = 256) => z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((s) => BigInt(s) < 1n << BigInt(bits));
const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)).transform((s) => s.toLowerCase() as Hex);
const hash = hex(32), address = hex(20), id = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().max(40).datetime({ offset: true });
const blockSchema = z.strictObject({ number: uint(), hash, timestamp: integer });
const sourceSchema = z.strictObject({ chainId: integer.positive(), genesisHash: hash, identityRegistry: address,
  reputationRegistry: address, startBlock: uint(), confirmations: integer });
export type FeedbackIndexSource = z.input<typeof sourceSchema>;
export function decodeFeedbackIndexSource(input: unknown): z.output<typeof sourceSchema> { return parse(sourceSchema, input, 'source'); }
const retentionSchema = z.strictObject({ retained: uint(), pending: uint(), blocked: uint() });
const coverageSchema = z.strictObject({ sourceId: id, source: sourceSchema, stateVersion: uint(), generation: uint(),
  availability: z.enum(['available', 'unavailable']), progress: z.enum(['initializing', 'lagging', 'synchronized', 'rebuilding']),
  checkpoint: blockSchema.nullable(), observedHead: blockSchema.nullable(), finalizedBlock: blockSchema.nullable(),
  rebuildingThrough: uint().nullable(), lastSuccessAt: timestamp.nullable(), lastAttemptAt: timestamp.nullable(), retention: retentionSchema });
const rawSchema = z.strictObject({ block: blockSchema, transactionHash: hash, transactionIndex: uint(64), logIndex: uint(64),
  address, topics: z.array(hash).length(4), data: z.string().max(131074).regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((s) => s.toLowerCase() as Hex) });
const key = { agentId: uint(), reviewer: address, feedbackIndex: uint(64).refine((s) => s !== '0') };
const text = z.string().max(65536).nullable();
const decodedSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...key, kind: z.literal('NewFeedback'), value: z.string().max(40).regex(/^(0|-?[1-9][0-9]*)$/),
    valueDecimals: integer.max(18), indexedTag1: hash, tag1: text, tag2: text, endpoint: text, feedbackURI: text,
    feedbackHash: hash, invalidTextFields: z.array(z.enum(['tag1', 'tag2', 'endpoint', 'feedbackURI'])).max(4) }),
  z.strictObject({ ...key, kind: z.literal('FeedbackRevoked') }),
  z.strictObject({ ...key, kind: z.literal('ResponseAppended'), responder: address, responseURI: text,
    responseHash: hash, invalidTextFields: z.array(z.literal('responseURI')).max(1) }),
]);
const jobSchema = z.strictObject({ eventId: id, sourceId: id, feedbackURI: text, feedbackHash: hash, jobVersion: uint(),
  attempts: uint(), nextAttemptAt: timestamp, leaseExpiresAt: timestamp.nullable(), lastAttemptAt: timestamp.nullable(),
  state: z.enum(['pending', 'retained', 'blocked']), reason: z.string().max(256).nullable(), actualHash: hash.nullable(), actualSize: uint().nullable() });
const eventSchema = z.strictObject({ eventId: id, sourceId: id, raw: rawSchema, decoded: decodedSchema,
  insertionSequence: uint(), observedAt: timestamp, canonicality: z.enum(['canonical', 'withdrawn', 'orphaned']),
  document: z.strictObject({ availability: z.enum(['retained', 'pending', 'blocked', 'not-requested']),
    hash: hash.nullable(), byteLength: uint().nullable(), retainedAt: timestamp.nullable(), job: jobSchema.nullable() }), semantics: z.literal('not-evaluated') });
export type IndexFeedbackEvent = z.output<typeof eventSchema>;
export type IndexFeedbackCoverage = z.output<typeof coverageSchema>;
const basisSchema = z.strictObject({ generation: uint(), through: blockSchema.nullable(), insertionSequence: uint() });
const cursorSchema = z.strictObject({ version: z.literal(1), sourceId: id, agentId: uint(), reviewer: address.nullable(),
  view: z.literal('all-retained'), pageSize: z.literal(100), order: z.literal('block-transaction-log-event'), generation: uint(),
  through: blockSchema.nullable(), sequence: uint(), after: z.tuple([uint(), uint(64), uint(64), id]) });
const sourceResponse = z.strictObject({ coverage: coverageSchema, retention: retentionSchema.extend({ scope: z.literal('canonical-prefix'),
  newFeedbackEvents: uint() }), semantics: z.literal('not-evaluated') });
const historyResponse = z.strictObject({ coverage: coverageSchema, basis: basisSchema.nullable(), view: z.literal('all-retained'),
  items: z.array(eventSchema).max(100), canonicalityBasis: z.literal('current-coverage'), nextCursor: z.string().max(4096).nullable(), semantics: z.literal('not-evaluated') });
const eventResponse = z.strictObject({ coverage: coverageSchema, item: eventSchema, semantics: z.literal('not-evaluated') });
function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value); if (!result.success) fail(field); return result.data;
}
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function feedbackSourceId(input: FeedbackIndexSource): string {
  const s = parse(sourceSchema, input, 'source');
  return digest(['erc8004-feedback-source-v1', s.chainId, s.genesisHash, s.identityRegistry, s.reputationRegistry]);
}
export function feedbackEventId(source: FeedbackIndexSource, input: unknown): string {
  const raw = parse(rawSchema, input, 'raw event');
  return digest(['erc8004-feedback-event-v1', feedbackSourceId(source), raw.block.hash, raw.transactionHash, raw.logIndex]);
}
const newData = [{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' }, { type: 'bytes' },
  { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }] as const;
const responseData = [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes32' }] as const;
const selectors = [
  toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'),
  toEventSelector('FeedbackRevoked(uint256,address,uint64)'),
  toEventSelector('ResponseAppended(uint256,address,uint64,address,string,bytes32)'),
];
/** Re-decode raw ABI locally. Index projections and IDs are assertions, not chain authority. */
export function decodeIndexFeedbackEvent(input: unknown, sourceInput: FeedbackIndexSource): IndexFeedbackEvent {
  const source = parse(sourceSchema, sourceInput, 'source');
  const e = parse(eventSchema, input, 'event'); const r = e.raw;
  if (e.sourceId !== feedbackSourceId(source) || e.eventId !== feedbackEventId(source, r) || r.address !== source.reputationRegistry ||
    BigInt(r.block.number) < BigInt(source.startBlock) || (r.data.length - 2) / 2 + 268 > 65536) fail('event source/identity');
  try {
    const [agentId] = decodeAbiParameters([{ type: 'uint256' }], r.topics[1]!);
    const [reviewer] = decodeAbiParameters([{ type: 'address' }], r.topics[2]!);
    const base = { agentId: agentId.toString(), reviewer: reviewer.toLowerCase() };
    const topics = [r.topics[0], encodeAbiParameters([{ type: 'uint256' }], [agentId]), encodeAbiParameters([{ type: 'address' }], [reviewer])];
    let decoded: unknown; let encoded: Hex; const invalidTextFields: string[] = [];
    const string = (value: Hex, field: string): string | null => {
      try { const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hexToBytes(value));
        if (s.includes('\0')) throw new Error(); return s;
      } catch { invalidTextFields.push(field); return null; }
    };
    if (r.topics[0] === selectors[0]) {
      const values = decodeAbiParameters(newData, r.data);
      const [index, value, valueDecimals, tag1, tag2, endpoint, uri, feedbackHash] = values;
      if (value < -(10n ** 38n) || value > 10n ** 38n || valueDecimals > 18) fail('event value');
      topics.push(keccak256(tag1)); encoded = encodeAbiParameters(newData, values);
      decoded = { ...base, kind: 'NewFeedback', feedbackIndex: index.toString(), value: value.toString(), valueDecimals,
        indexedTag1: keccak256(tag1), tag1: string(tag1, 'tag1'), tag2: string(tag2, 'tag2'), endpoint: string(endpoint, 'endpoint'),
        feedbackURI: string(uri, 'feedbackURI'), feedbackHash, invalidTextFields };
    } else if (r.topics[0] === selectors[1]) {
      const [index] = decodeAbiParameters([{ type: 'uint64' }], r.topics[3]!);
      topics.push(encodeAbiParameters([{ type: 'uint64' }], [index])); encoded = '0x';
      decoded = { ...base, kind: 'FeedbackRevoked', feedbackIndex: index.toString() };
    } else if (r.topics[0] === selectors[2]) {
      const values = decodeAbiParameters(responseData, r.data); const [index, uri, responseHash] = values;
      const [responder] = decodeAbiParameters([{ type: 'address' }], r.topics[3]!);
      topics.push(encodeAbiParameters([{ type: 'address' }], [responder])); encoded = encodeAbiParameters(responseData, values);
      decoded = { ...base, kind: 'ResponseAppended', feedbackIndex: index.toString(), responder: responder.toLowerCase(),
        responseURI: string(uri, 'responseURI'), responseHash, invalidTextFields };
    } else fail('event signature');
    if (encoded !== r.data || !same(topics, r.topics) || !same(parse(decodedSchema, decoded, 'decoded event'), e.decoded)) fail('event projection');
  } catch { fail('raw event/projection'); }
  const d = e.document; const j = d.job;
  if (e.decoded.kind === 'NewFeedback') {
    if (d.hash !== e.decoded.feedbackHash || (j && (j.eventId !== e.eventId || j.sourceId !== e.sourceId ||
      j.feedbackHash !== e.decoded.feedbackHash || j.feedbackURI !== e.decoded.feedbackURI))) fail('document reference');
  } else if (d.hash !== null || j !== null || d.availability !== 'not-requested') fail('non-feedback document');
  if (d.availability === 'retained' && (d.byteLength === null || BigInt(d.byteLength) > 6144n || d.retainedAt === null)) fail('retained document metadata');
  return e;
}

export function feedbackIndexOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) fail('origin');
  try { if (new URL(value).origin !== value) fail('origin'); } catch { fail('origin'); } return value;
}
type Selection = { origin: string; source: FeedbackIndexSource; agentId: string; reviewer: string; eventId: string;
  documentHash: string; signal?: AbortSignal };
export type IndexFeedbackRead = { coverage: IndexFeedbackCoverage; basis: z.output<typeof basisSchema> | null;
  history: IndexFeedbackEvent[];
  /** Membership is observed per page, not at the selected event's later coverage. */
  historyPages: Array<{ coverage: IndexFeedbackCoverage; eventIds: string[] }>;
  event: IndexFeedbackEvent; documentBytes: Uint8Array | null; completeness: 'index-reported-only' };

/** Direct literal-loopback HTTP: no proxy agent, redirect, event-URI fetch, or implicit source selection. */
export async function readIndexFeedback(input: Selection): Promise<IndexFeedbackRead> {
  const origin = feedbackIndexOrigin(input.origin), source = parse(sourceSchema, input.source, 'source');
  const agentId = parse(uint(), input.agentId, 'agentId'), reviewer = parse(address, input.reviewer, 'reviewer');
  const eventId = parse(id, input.eventId, 'eventId'), documentHash = parse(hash, input.documentHash, 'document hash');
  const sourceId = feedbackSourceId(source), deadline = performance.now() + 30000;
  let total = 0;
  async function body(path: string, limit: number, missing = false): Promise<Buffer | null> {
    if (input.signal?.aborted) fail('cancelled');
    return new Promise((resolve, reject) => {
      let settled = false; const chunks: Buffer[] = []; let size = 0;
      const finish = (error: Error | null, value: Buffer | null = null) => {
        if (settled) return; settled = true; clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
        if (error) { req.destroy(); reject(error); } else resolve(value);
      };
      const error = (code: string) => finish(new Error(`invalid Index feedback ${code}`));
      const abort = () => error('cancelled');
      const req = request(`${origin}${path}`, { method: 'GET', agent: false, headers: { Accept: '*/*', 'Accept-Encoding': 'identity' } }, (res) => {
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { error('content encoding'); return; }
        const declared = res.headers['content-length'];
        if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(Math.min(limit, 8388608 - total)))) { error('body budget'); return; }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length; total += chunk.length;
          if (size > limit || total > 8388608) { error('body budget'); res.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('error', () => error('truncated body'));
        res.on('end', () => {
          if (!res.complete || (declared !== undefined && BigInt(declared) !== BigInt(size))) { error('truncated body'); return; }
          if (missing && res.statusCode === 404) { finish(null); return; }
          if (res.statusCode !== 200) { error(res.statusCode === 409 ? 'stale generation' : 'HTTP status'); return; }
          finish(null, Buffer.concat(chunks, size));
        });
      });
      const timer = setTimeout(() => error('deadline'), Math.max(0, Math.min(5000, deadline - performance.now())));
      input.signal?.addEventListener('abort', abort, { once: true });
      req.on('error', () => error('transport')); req.end();
    });
  }
  async function json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const bytes = await body(path, 2097152);
    try { return parse(schema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes!)), 'response shape'); }
    catch { fail('response shape'); }
  }
  const root = `/api/ard/feedback/sources/${sourceId}`;
  const first = await json(root, sourceResponse);
  const generation = first.coverage.generation;
  const checkCoverage = (c: IndexFeedbackCoverage) => {
    if (!same(c.source, source) || c.sourceId !== sourceId) fail('source drift');
    if (c.generation !== generation) fail('generation drift');
  };
  checkCoverage(first.coverage);
  let coverage = first.coverage, basis: IndexFeedbackRead['basis'] = null, cursor: string | null = null;
  const historyPages: IndexFeedbackRead['historyPages'] = [];
  const seenCursors = new Set<string>(), seenEvents = new Set<string>(); const history: IndexFeedbackEvent[] = [];
  const position = (e: IndexFeedbackEvent) => [e.raw.block.number, e.raw.transactionIndex, e.raw.logIndex, e.eventId] as const;
  const compare = (a: IndexFeedbackEvent, b: IndexFeedbackEvent) => {
    const aa = position(a), bb = position(b);
    for (let i = 0; i < 3; i++) { if (BigInt(aa[i]!) < BigInt(bb[i]!)) return -1; if (BigInt(aa[i]!) > BigInt(bb[i]!)) return 1; }
    return aa[3].localeCompare(bb[3]);
  };
  for (let pages = 0; ; pages++) {
    if (pages >= 20) fail('page budget');
    const params = new URLSearchParams({ reviewer, view: 'all-retained', pageSize: '100' }); if (cursor) params.set('cursor', cursor);
    const page = await json(`${root}/agents/${agentId}?${params}`, historyResponse);
    checkCoverage(page.coverage); coverage = page.coverage;
    if (pages === 0) basis = page.basis; else if (!same(basis, page.basis)) fail('page basis drift');
    if (basis && basis.generation !== generation) fail('page generation');
    for (const value of page.items) {
      const e = decodeIndexFeedbackEvent(value, source);
      if (e.decoded.agentId !== agentId || e.decoded.reviewer !== reviewer) fail('subject/reviewer drift');
      if (!basis || BigInt(e.insertionSequence) > BigInt(basis.insertionSequence)) fail('page insertion fence');
      if (seenEvents.has(e.eventId) || (history.length && compare(history.at(-1)!, e) >= 0)) fail('event order/duplicate');
      seenEvents.add(e.eventId); history.push(e); if (history.length > 1000) fail('event budget');
    }
    historyPages.push({ coverage: page.coverage, eventIds: page.items.map((e) => e.eventId) });
    cursor = page.nextCursor; if (cursor === null) break;
    if (seenCursors.has(cursor)) fail('cursor cycle'); seenCursors.add(cursor);
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || !page.items.length || !basis) fail('cursor');
    let c: z.output<typeof cursorSchema>;
    try { const bytes = Buffer.from(cursor, 'base64url'); if (bytes.toString('base64url') !== cursor) fail('cursor');
      c = parse(cursorSchema, JSON.parse(bytes.toString('utf8')), 'cursor'); } catch { fail('cursor'); }
    if (c.sourceId !== sourceId || c.agentId !== agentId || c.reviewer !== reviewer || c.generation !== generation ||
      !same(c.through, basis.through) || c.sequence !== basis.insertionSequence || !same(c.after, position(history.at(-1)!))) fail('cursor scope/basis');
  }
  const found = history.find((e) => e.eventId === eventId); if (!found) fail('selected event unavailable in bounded history');
  const direct = await json(`/api/ard/feedback/events/${eventId}`, eventResponse); checkCoverage(direct.coverage);
  const event = decodeIndexFeedbackEvent(direct.item, source); coverage = direct.coverage;
  if (event.eventId !== eventId || !same(event.raw, found.raw) || !same(event.decoded, found.decoded) || event.insertionSequence !== found.insertionSequence) fail('event drift');
  if (event.decoded.kind !== 'NewFeedback' || event.decoded.feedbackHash !== documentHash) fail('selected document reference');
  const documentBytes = await body(`/api/ard/feedback/documents/${documentHash}`, 6144, true);
  if (documentBytes && keccak256(documentBytes) !== documentHash) fail('document digest');
  return { coverage, basis, history, historyPages, event, documentBytes, completeness: 'index-reported-only' };
}
