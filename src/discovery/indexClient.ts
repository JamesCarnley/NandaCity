import { z } from 'zod';

import type { ReadRequestBudget, ReadRequestLease } from '../identity/rpcTransport.js';
import type { DiscoveredCandidate, ServiceFilter } from './verifyDiscovery.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 5_000;
class RejectedIndexResponse extends Error {}
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const agent = z.object({ chainId: z.number().int().positive().safe(), registry: address,
  agentId: decimal });
const block = z.object({ number: decimal, hash: hex32, timestamp: z.number().int().nonnegative().safe() });
const declaration = z.object({ identifier: z.string().min(1).max(512),
  displayName: z.string().min(1).max(255), type: z.string().min(1).max(512),
  url: z.string().url().max(2048), description: z.string().max(1000).nullable(),
  capabilityIds: z.array(z.string()), areaServed: z.array(z.string()),
  interfaces: z.array(z.string()) });
const coverageSource = z.object({ sourceId: z.string(), stateVersion: decimal,
  availability: z.enum(['available', 'unavailable']),
  progress: z.enum(['initializing', 'lagging', 'synchronized', 'rebuilding']),
  checkpoint: block.nullable(), observedHead: block.nullable(), finalizedBlock: block.nullable(),
  confirmations: z.number().int().nonnegative(), lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable() });
const coverage = z.object({ scope: z.literal('local-projection'),
  upstreamSearch: z.literal('not-attempted'), paginationConsistency: z.literal('live-keyset'),
  readAt: z.string(), identitySources: z.array(coverageSource) });
const projection = declaration.extend({ provenance: z.object({ sourceId: z.string(),
  sourceKind: z.string(), organizationId: z.string().nullable(), revision: z.string(),
  observedAt: z.string(), authority: z.object({ kind: z.string(), agent, block,
    observationId: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict().optional() }).strict() }).strict();
const searchResponse = z.object({ items: z.array(projection).max(100), pageToken: z.string().nullable(),
  observerOrigin: z.string(), coverage }).strict();
const observation = z.object({ agent, block, owner: address.nullable(), agentURI: z.string().nullable(),
  agentUriDigest: hex32.nullable(), agentUriByteLength: z.number().int().nonnegative().nullable(),
  qualification: z.enum(['eligible', 'inactive', 'owner-mismatch', 'unsupported', 'invalid', 'missing']),
  reason: z.string().nullable(), declaration: declaration.nullable() });
const observationResponse = z.object({ observationId: z.string(), observation,
  observationBytes: z.string() });

export type IndexCoverage = z.infer<typeof coverage>;
export type IndexOriginResult = { observerOrigin: string; coverage: IndexCoverage | null;
  errors: string[]; available: boolean; pages: number };
export type IndexSearchResult = { candidates: DiscoveredCandidate[]; origins: IndexOriginResult[] };
export type IndexSearchOptions = {
  signal?: AbortSignal;
  requestBudget?: (origin: string, kind: 'search' | 'observation') => ReadRequestBudget;
  filterDeclarations?: boolean;
  /** Optional further caller-domain rejection before spending an observation request. */
  rejectDeclaration?: (agent: DiscoveredCandidate['agent']) => string | null;
  onFiltered?: (origin: string, agent: DiscoveredCandidate['agent'], reason: string) => void;
  /** Awaited per origin: verification shares the origin's allocation with acquisition. */
  onCandidate?: (candidate: DiscoveredCandidate) => Promise<void>;
};

function configuredOrigin(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.hash || url.search || url.pathname !== '/' || url.origin !== raw.replace(/\/$/, '')) {
    throw new Error('Index origin must be an exact HTTP(S) origin without credentials or path');
  }
  return url.origin;
}

async function boundedJson(url: URL, init: RequestInit | undefined, options: IndexSearchOptions): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Index request cancelled/deadline'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  // A lease owns its deadline and exhaustion diagnostic; do not race it with
  // another default timer. Standalone callers retain the legacy timeout.
  const timer = options.requestBudget ? undefined : setTimeout(abort, REQUEST_TIMEOUT_MS);
  let lease: ReadRequestLease | undefined, response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    const kind = url.pathname.includes('/identity-observations/') ? 'observation' : 'search';
    lease = await options.requestBudget?.(url.origin, kind).open(controller.signal);
    lease?.signal.addEventListener('abort', abort, { once: true });
    if (lease?.signal.aborted) abort();
    controller.signal.throwIfAborted(); lease?.check();
    response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new RejectedIndexResponse('Index redirect refused');
    if (!response.ok) throw new Error(`Index HTTP ${response.status}`);
    reader = response.body?.getReader();
    if (!reader) throw new Error('Index response has no body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted(); lease?.check();
      if (done) break;
      lease?.bytes(value.byteLength);
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new RejectedIndexResponse('Index response exceeds 2 MiB'); }
      chunks.push(value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new RejectedIndexResponse('Index response is not JSON'); }
    return parsed;
  } finally {
    controller.abort(); clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    lease?.signal.removeEventListener('abort', abort);
    try { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {}); }
    finally { lease?.close(); }
  }
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

async function searchOne(rawOrigin: string, filter: ServiceFilter, options: IndexSearchOptions): Promise<{
  candidates: DiscoveredCandidate[]; origin: IndexOriginResult;
}> {
  const observerOrigin = configuredOrigin(rawOrigin);
  const origin: IndexOriginResult = { observerOrigin, coverage: null, errors: [], available: false, pages: 0 };
  const candidates: DiscoveredCandidate[] = [];
  let pageToken: string | null = null;
  const tokens = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    let response: z.infer<typeof searchResponse>;
    try {
      const body = await boundedJson(new URL('/api/ard/services/search', observerOrigin), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter, pageSize: 100, ...(pageToken ? { pageToken } : {}) }),
      }, options);
      const parsed = searchResponse.safeParse(body);
      if (!parsed.success) throw new RejectedIndexResponse('malformed Index search response');
      response = parsed.data;
      origin.available = true;
      origin.coverage = response.coverage;
      origin.pages += 1;
    } catch (error) {
      origin.errors.push(`${error instanceof RejectedIndexResponse ? 'rejected' : 'unavailable'}: ${
        error instanceof Error ? error.message : String(error)}`);
      break;
    }
    for (const item of response.items) {
      const authority = item.provenance.authority;
      if (authority?.kind !== 'erc8004-identity' || item.provenance.sourceKind !== 'erc8004-identity') {
        origin.errors.push('rejected: unknown or absent authority kind');
        continue;
      }
      const expectedSourceId = `erc8004-identity:${authority.agent.chainId}:${authority.agent.registry.toLowerCase()}`;
      if (item.provenance.sourceId !== expectedSourceId) {
        origin.errors.push('rejected: source reference mismatch');
        continue;
      }
      const filtered = options.filterDeclarations && !(['capabilityIds', 'areaServed', 'interfaces'] as const)
        .every((key) => filter[key] === undefined || filter[key]!.some((value) => item[key].includes(value)));
      const rejected = filtered ? 'declaration does not match requested filter' :
        options.rejectDeclaration?.(authority.agent as DiscoveredCandidate['agent']);
      if (rejected) {
        options.onFiltered?.(observerOrigin, authority.agent as DiscoveredCandidate['agent'], rejected);
        continue;
      }
      try {
        const path = `/api/ard/identity-observations/${authority.observationId}`;
        const parsed = observationResponse.safeParse(await boundedJson(new URL(path, observerOrigin), undefined, options));
        if (!parsed.success) throw new RejectedIndexResponse('malformed Index observation response');
        const direct = parsed.data;
        let parsedBytes: unknown;
        try { parsedBytes = JSON.parse(direct.observationBytes) as unknown; }
        catch { throw new RejectedIndexResponse('malformed exact observation bytes'); }
        if (direct.observationId !== authority.observationId || !same(parsedBytes, direct.observation) ||
          direct.observation.qualification !== 'eligible' || !direct.observation.agentURI ||
          !direct.observation.declaration || !same(direct.observation.agent, authority.agent) ||
          !same(direct.observation.block, authority.block) ||
          !same(direct.observation.declaration, Object.fromEntries(
            ['identifier', 'displayName', 'type', 'url', 'description', 'capabilityIds', 'areaServed', 'interfaces']
              .map((key) => [key, item[key as keyof typeof declaration.shape]])))) {
          origin.errors.push('rejected: observation and projection mismatch');
          continue;
        }
        const candidate = { observerOrigin, agent: authority.agent as DiscoveredCandidate['agent'],
          agentURI: direct.observation.agentURI, declaration: direct.observation.declaration,
          observationBlock: authority.block as DiscoveredCandidate['observationBlock'] };
        candidates.push(candidate);
        await options.onCandidate?.(candidate);
      } catch (error) {
        origin.errors.push(`${error instanceof RejectedIndexResponse ? 'rejected' : 'unavailable'}: observation read failed: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!response.pageToken) break;
    if (tokens.has(response.pageToken)) { origin.errors.push('rejected: repeated page token'); break; }
    tokens.add(response.pageToken);
    pageToken = response.pageToken;
    if (page === MAX_PAGES - 1) origin.errors.push('unavailable: search page limit reached');
  }
  return { candidates, origin };
}

/** Search only explicitly configured Index origins; never treat matching Index rows as authority. */
export async function searchIndexes(origins: readonly string[], filter: ServiceFilter,
  options: IndexSearchOptions = {}): Promise<IndexSearchResult> {
  if (origins.length === 0 || origins.length > 2) throw new Error('configure one or two Index origins');
  const unique = origins.map(configuredOrigin);
  if (new Set(unique).size !== unique.length) throw new Error('Index origins must be distinct');
  const results = await Promise.all(unique.map((origin) => searchOne(origin, filter, options)));
  return { candidates: results.flatMap((result) => result.candidates),
    origins: results.map((result) => result.origin) };
}
