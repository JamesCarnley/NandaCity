import { isDeepStrictEqual } from 'node:util';
import { createPublicClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http,
  numberToHex, parseAbiParameters, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { decodeFeedbackIndexSource, feedbackIndexOrigin, readIndexFeedbackDocument, readIndexFeedbackHistory,
  type FeedbackIndexSource, type IndexFeedbackEvent, type IndexFeedbackHistoryRead } from '../feedback/indexClient.js';
import { readReputationActivation, type ReputationActivationObservation, type ReputationDeploymentProvenance } from '../feedback/reputationActivation.js';
import { decodeRawRegistryFeedbackEvent, readRegistryFeedbackObservation, type RegistryFeedbackObservation } from '../feedback/registryObservation.js';
import type { FeedbackPublicationDomain } from '../feedback/publication.js';
import { reputationRegistryAbi } from '../feedback/registry.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import { ownedFetch } from '../demo/ownedLifecycle.js';
import { createRankingReadBudget, RankingReadBudget, type RankingReadBudgetSnapshot, type RankingReadLane } from './readBudget.js';

export type AcceptedReviewerCoverageInput = {
  rpcOrigin: string; provenance: ReputationDeploymentProvenance;
  observation: { blockNumber: bigint; blockHash: Hex };
  agentIds: readonly string[]; reviewers: readonly Address[];
  indexes: readonly [{ origin: string; source: FeedbackIndexSource }, { origin: string; source: FeedbackIndexSource }];
  signal?: AbortSignal;
};
export type AuthenticatedCoverageSlot = { observation: RegistryFeedbackObservation; sources: number[] };
export type CoveragePair = { agentId: string; reviewer: Address; status: 'complete' | 'unknown'; lastIndex: string | null;
  slots: AuthenticatedCoverageSlot[]; missingSlots: string[]; diagnostics: string[] };
export type AcceptedReviewerCoverage = {
  status: 'complete' | 'unknown'; qualification: 'rpc-derived-not-state-proof'; domain: FeedbackPublicationDomain;
  observation: { blockNumber: string; blockHash: Hex; blockTimestamp?: string };
  activation: ReputationActivationObservation | null;
  batchBasis: 'matched' | 'changed' | 'unavailable'; pairs: CoveragePair[];
  acquisitions: Array<Omit<IndexFeedbackHistoryRead, 'history'> & { origin: 0 | 1; pair: number }>;
  rows: Array<{ origin: 0 | 1; pair: number; event: IndexFeedbackEvent;
    disposition: 'matched' | 'rejected' | 'unsupported' | 'unexamined' | 'non-publication'; diagnostics: string[] }>;
  documents: Array<{ hash: Hex; availability: 'available' | 'unavailable'; bytes: Uint8Array | null;
    sources: Array<0 | 1>; diagnostics: string[] }>;
  diagnostics: string[]; budget: RankingReadBudgetSnapshot;
};

const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((s) => BigInt(s) < 1n << 256n);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i).transform((s) => s.toLowerCase() as Hex);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i).transform((s) => s.toLowerCase() as Address).refine((s) => s !== zeroAddress);
const coordinate = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const domainSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), genesisHash: hash,
  identityRegistry: address, reputationRegistry: address });
const transactionSchema = z.strictObject({ transactionHash: hash, blockNumber: uint, blockHash: hash, transactionIndex: coordinate });
const creationSchema = transactionSchema.extend({ address, nonce: uint, runtimeCodeHash: hash });
const boundedMap = z.unknown().refine((v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length <= 16)
  .pipe(z.record(z.string().max(256), z.string().max(256)));
const provenanceSchema = z.strictObject({ domain: domainSchema, deployer: address,
  artifacts: z.strictObject({ referenceCommit: z.string().max(256), solcVersion: z.string().max(256), solcTmpVersion: z.string().max(256),
    openZeppelinVersion: z.string().max(256), sourceSha256: boundedMap, artifactSha256: boundedMap,
    compilerSettings: z.strictObject({ evmVersion: z.literal('shanghai'), viaIR: z.literal(true),
      optimizer: z.strictObject({ enabled: z.literal(true), runs: z.literal(200) }) }) }),
  bootstrap: creationSchema, proxy: creationSchema, implementation: creationSchema,
  activation: transactionSchema.extend({ upgradedLogIndex: coordinate }) });
const inputSchema = z.strictObject({ rpcOrigin: z.string().transform(feedbackIndexOrigin), provenance: provenanceSchema,
  observation: z.strictObject({ blockNumber: z.bigint().min(0n).max((1n << 256n) - 1n), blockHash: hash }),
  agentIds: z.array(uint).max(6), reviewers: z.array(address).max(8),
  indexes: z.tuple([z.strictObject({ origin: z.string().transform(feedbackIndexOrigin), source: z.unknown().transform(decodeFeedbackIndexSource) }),
    z.strictObject({ origin: z.string().transform(feedbackIndexOrigin), source: z.unknown().transform(decodeFeedbackIndexSource) })]) });
const counterParameters = parseAbiParameters('uint64');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || v.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v)) throw new Error('malformed quantity');
  return BigInt(v);
};

/** Counter-qualified accepted-reviewer slots only. No City eligibility, scoring or log follower. */
export async function readAcceptedReviewerCoverage(input: AcceptedReviewerCoverageInput, borrowed?: RankingReadBudget): Promise<AcceptedReviewerCoverage> {
  let config: z.output<typeof inputSchema>;
  const signal = input.signal;
  try {
    if (!Array.isArray(input.agentIds) || input.agentIds.length > 6 || !Array.isArray(input.reviewers) || input.reviewers.length > 8 ||
      !Array.isArray(input.indexes) || input.indexes.length !== 2) throw new Error();
    // Schema parsing copies the bounded authority graph before any await.
    const { signal: _signal, ...configuration } = input;
    config = inputSchema.parse(configuration);
    if (new Set(config.agentIds).size !== config.agentIds.length || new Set(config.reviewers).size !== config.reviewers.length ||
      config.indexes[0].origin === config.indexes[1].origin) throw new Error();
    const d = config.provenance.domain;
    for (const { source } of config.indexes) if (source.chainId !== d.chainId || !same(source.genesisHash, d.genesisHash) ||
      !same(source.identityRegistry, d.identityRegistry) || !same(source.reputationRegistry, d.reputationRegistry)) throw new Error();
    if (borrowed && (!(borrowed instanceof RankingReadBudget) || borrowed.origins.some((o, i) => o !== config.indexes[i]!.origin))) throw new Error();
  } catch { throw new Error('invalid coverage configuration'); }
  const domain = config.provenance.domain, observation = config.observation;
  const work = borrowed ?? createRankingReadBudget({ origins: [config.indexes[0].origin, config.indexes[1].origin], ...(signal ? { signal } : {}) });
  const pairs: CoveragePair[] = config.agentIds.flatMap((agentId) => config.reviewers.map((reviewer) => ({ agentId, reviewer,
    status: 'unknown', lastIndex: null, slots: [], missingSlots: [], diagnostics: [] })));
  const result: AcceptedReviewerCoverage = { status: 'unknown', qualification: 'rpc-derived-not-state-proof', domain,
    observation: { blockNumber: observation.blockNumber.toString(), blockHash: observation.blockHash },
    activation: null, batchBasis: 'unavailable', pairs, acquisitions: [], rows: [], documents: [], diagnostics: [], budget: work.snapshot() };
  const check = () => { signal?.throwIfAborted(); work.check(); };
  async function scoped<T>(lane: RankingReadLane, run: (client: PublicClient, signal: AbortSignal) => Promise<T>, invocationSignal?: AbortSignal): Promise<T> {
    check();
    const controller = new AbortController(), pending = new Set<Promise<Response>>();
    const abort = () => controller.abort();
    const signals = [signal, invocationSignal].filter((s): s is AbortSignal => !!s);
    for (const s of signals) { s.addEventListener('abort', abort, { once: true }); if (s.aborted) abort(); }
    const fetcher = boundRpcFetch(ownedFetch, { budget: work.requestBudget(lane, 'rpc'), signal: controller.signal });
    const fetchFn: typeof fetch = (input, init) => {
      const p = fetcher(input, init); pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p;
    };
    const client = createPublicClient({ cacheTime: 0, batch: { multicall: false },
      transport: http(config.rpcOrigin, { retryCount: 0, batch: false, timeout: 5_000, fetchFn }) });
    try { const value = await run(client, controller.signal); check(); controller.signal.throwIfAborted(); return value; }
    finally { controller.abort(); for (const s of signals) s.removeEventListener('abort', abort); await Promise.allSettled([...pending]); }
  }
  async function bracket(): Promise<void> {
    await scoped('shared', async (client) => {
      const block = await client.request({ method: 'eth_getBlockByNumber', params: [numberToHex(observation.blockNumber), false] }, { retryCount: 0 });
      if (!block || quantity(block.number) !== observation.blockNumber || !hash.safeParse(block.hash).success) throw new Error('observation-unavailable');
      if (!same(block.hash!, observation.blockHash)) { result.batchBasis = 'changed'; throw new Error('observation-changed'); }
      result.observation.blockTimestamp = quantity(block.timestamp).toString();
    });
  }
  const canonical = new Map<string, AuthenticatedCoverageSlot>();
  const coordinateKey = (e: IndexFeedbackEvent) => JSON.stringify([e.raw.block.number, e.raw.block.hash, e.raw.transactionHash,
    e.raw.transactionIndex, e.raw.logIndex]);
  const covered = (pair: CoveragePair) => pair.lastIndex !== null && !pair.diagnostics.length && pair.slots.length === Number(pair.lastIndex);
  const activePairs: Array<{ pair: number; controller: AbortController } | undefined> = [undefined, undefined];
  function compareAssertion(e: IndexFeedbackEvent, found: RegistryFeedbackObservation): boolean {
    const expected = decodeRawRegistryFeedbackEvent(e.raw);
    const actual = found.event;
    if (!actual || !found.source) return false;
    const { address, ...actualEvent } = actual;
    return same(address, e.raw.address) && isDeepStrictEqual(expected, actualEvent) &&
      found.source.blockNumber === e.raw.block.number && same(found.source.blockHash, e.raw.block.hash) &&
      found.source.blockTimestamp === String(e.raw.block.timestamp) && same(found.source.transactionHash, e.raw.transactionHash) &&
      String(found.source.transactionIndex) === e.raw.transactionIndex && String(found.source.logIndex) === e.raw.logIndex;
  }
  async function originWorker(origin: 0 | 1): Promise<void> {
    const selected = config.indexes[origin], lane = origin === 0 ? 'index-a' : 'index-b';
    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi]!;
      if (pair.lastIndex === null || pair.lastIndex === '0' || pair.diagnostics.length || covered(pair)) continue;
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      activePairs[origin] = { pair: pi, controller };
      try {
        check();
        const acquisition = await readIndexFeedbackHistory({ ...selected, agentId: pair.agentId, reviewer: pair.reviewer,
          signal: controller.signal, work: { requests: work.requestBudget(lane, 'index'),
            page: () => work.chargeHistory(lane, String(pi), { pages: 1 }), rows: (rows) => work.chargeHistory(lane, String(pi), { rows }) } });
        const { history, ...summary } = acquisition;
        result.acquisitions.push({ ...summary, origin, pair: pi });
        const entries = history.map((event) => ({ origin, pair: pi, event, disposition: 'unexamined' as const, diagnostics: [] as string[] }));
        const offset = result.rows.length; result.rows.push(...entries);
        for (let i = 0; i < entries.length; i++) {
          const row = result.rows[offset + i]!, e = row.event, r = e.raw;
          if (e.decoded.kind !== 'NewFeedback') { row.disposition = 'non-publication'; continue; }
          const reject = (code: string) => { row.disposition = 'rejected'; row.diagnostics.push(code); };
          const cached = canonical.get(coordinateKey(e));
          if (cached) {
            if (compareAssertion(e, cached.observation)) { row.disposition = 'matched'; cached.sources.push(offset + i); }
            else reject('raw-assertion-mismatch');
            continue;
          }
          if (covered(pair)) continue;
          if (BigInt(r.transactionIndex) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(r.logIndex) > BigInt(Number.MAX_SAFE_INTEGER)) {
            row.disposition = 'unsupported'; row.diagnostics.push('unsafe-event-coordinate'); continue;
          }
          const activation = result.activation!.knownDeployment!.activation;
          if (BigInt(r.block.number) > observation.blockNumber || BigInt(r.block.number) < BigInt(activation.blockNumber) ||
            (r.block.number === activation.blockNumber && BigInt(r.transactionIndex) <= BigInt(activation.transactionIndex)) ||
            BigInt(e.decoded.feedbackIndex) > BigInt(pair.lastIndex!)) { reject('outside-counter-activation-observation'); continue; }
          try {
            const found = await scoped(lane, (client, signal) => readRegistryFeedbackObservation({ client, signal, domain, observation,
              eventRef: { blockNumber: r.block.number, blockHash: r.block.hash, transactionHash: r.transactionHash,
                transactionIndex: Number(r.transactionIndex), logIndex: Number(r.logIndex) } }), controller.signal);
            if (found.authenticity !== 'matched' || !found.event || !found.storage || !compareAssertion(e, found)) {
              reject(found.authenticity === 'matched' ? 'raw-assertion-mismatch' : `registry-${found.authenticity}`); continue;
            }
            if (found.event.agentId !== pair.agentId || found.event.reviewer !== pair.reviewer) { reject('wrong-pair'); continue; }
            if (found.storage.lastIndex !== pair.lastIndex) { pair.diagnostics.push('canonical-counter-conflict'); reject('canonical-counter-conflict'); continue; }
            // Another source may have authenticated this exact coordinate while this read awaited RPC.
            const raced = canonical.get(coordinateKey(e));
            if (raced) {
              if (isDeepStrictEqual(raced.observation, found)) { raced.sources.push(offset + i); row.disposition = 'matched'; }
              else { pair.diagnostics.push('canonical-coordinate-conflict'); reject('canonical-coordinate-conflict'); }
              continue;
            }
            const collision = pair.slots.find((slot) => slot.observation.event!.feedbackIndex === found.event!.feedbackIndex);
            if (collision) { pair.diagnostics.push('canonical-slot-conflict'); reject('canonical-slot-conflict'); continue; }
            const slot = { observation: found, sources: [offset + i] };
            canonical.set(coordinateKey(e), slot); pair.slots.push(slot); row.disposition = 'matched';
            if (covered(pair)) {
              const other = activePairs[1 - origin]; if (other?.pair === pi) other.controller.abort();
            }
          } catch {
            const completed = canonical.get(coordinateKey(e));
            if (completed && compareAssertion(e, completed.observation)) { completed.sources.push(offset + i); row.disposition = 'matched'; }
            else if (controller.signal.aborted && covered(pair)) row.diagnostics.push('redundant-work-cancelled');
            else reject('candidate-read-unavailable');
          }
        }
      } catch { result.acquisitions.push({ origin, pair: pi, status: 'unavailable', coverage: null, basis: null,
        historyPages: [], diagnostics: ['origin-work-unavailable'], completeness: 'index-reported-only' }); }
      finally { controller.abort(); signal?.removeEventListener('abort', abort); activePairs[origin] = undefined; }
    }
  }
  let before = false;
  try {
    result.activation = await scoped('shared', (client, signal) => readReputationActivation({ client, signal,
      provenance: config.provenance, observation, limits: { totalTimeoutMs: 60_000 } }));
    if (result.activation.activation !== 'matched' || !result.activation.knownDeployment) {
      result.diagnostics.push('known-deployment-unavailable'); return result;
    }
    await bracket(); before = true;
    let total = 0n;
    for (const pair of pairs) {
      try {
        const value = await scoped('shared', async (client) => {
          const data = await client.request({ method: 'eth_call', params: [{ to: domain.reputationRegistry,
            data: encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getLastIndex', args: [BigInt(pair.agentId), pair.reviewer] }) },
          numberToHex(observation.blockNumber)] }, { retryCount: 0 });
          if (typeof data !== 'string' || data.length !== 66) throw new Error();
          const [n] = decodeAbiParameters(counterParameters, data);
          if (!same(encodeAbiParameters(counterParameters, [n]), data)) throw new Error(); return n;
        });
        pair.lastIndex = value.toString(); total += value;
        if (value > 32n) pair.diagnostics.push('pair-counter-over-limit');
      } catch { pair.diagnostics.push('counter-unavailable'); }
    }
    if (total > 512n) {
      result.diagnostics.push('total-counter-over-limit'); for (const pair of pairs) pair.diagnostics.push('total-counter-over-limit');
    } else await Promise.all([originWorker(0), originWorker(1)]);
    for (const pair of pairs) {
      pair.slots.sort((a, b) => Number(BigInt(a.observation.event!.feedbackIndex) - BigInt(b.observation.event!.feedbackIndex)));
      if (pair.lastIndex !== null && BigInt(pair.lastIndex) <= 32n) {
        for (let n = 1n; n <= BigInt(pair.lastIndex); n++) if (!pair.slots.some((s) => s.observation.event!.feedbackIndex === n.toString())) pair.missingSlots.push(n.toString());
      }
    }
    const hashes = [...new Set(pairs.flatMap((pair) => pair.slots.map((slot) => slot.observation.event!.feedbackHash)))];
    if (hashes.length > 512) throw new Error('document-bound');
    result.documents = hashes.map((hash) => ({ hash, availability: 'unavailable', bytes: null, sources: [], diagnostics: [] }));
    const documentControllers = [new AbortController(), new AbortController()];
    const abortDocuments = () => documentControllers.forEach((c) => c.abort());
    signal?.addEventListener('abort', abortDocuments, { once: true }); if (signal?.aborted) abortDocuments();
    try { await Promise.all(([0, 1] as const).map(async (origin) => {
      for (const doc of result.documents) {
        if (doc.bytes !== null) continue;
        try {
          check(); const bytes = await readIndexFeedbackDocument({ origin: config.indexes[origin].origin, documentHash: doc.hash,
            signal: documentControllers[origin]!.signal, work: { requests: work.requestBudget(origin === 0 ? 'index-a' : 'index-b', 'index') } });
          check();
          if (bytes !== null) {
            if (doc.bytes === null) doc.bytes = bytes;
            doc.availability = 'available'; doc.sources.push(origin);
            if (result.documents.every((d) => d.bytes !== null)) documentControllers[1 - origin]!.abort();
          } else doc.diagnostics.push(`index-${origin}:missing`);
        } catch { doc.diagnostics.push(`index-${origin}:unavailable`); }
      }
    })); } finally { abortDocuments(); signal?.removeEventListener('abort', abortDocuments); }
  } catch { result.diagnostics.push('required-work-unavailable'); }
  finally {
    if (before) {
      try { await bracket(); result.batchBasis = 'matched'; }
      catch { if (result.batchBasis !== 'changed') result.batchBasis = 'unavailable'; result.diagnostics.push('batch-observation-unavailable'); }
    }
    try { check(); } catch { result.diagnostics.push('batch-work-expired'); result.batchBasis = 'unavailable'; }
    for (const pair of pairs) pair.status = result.batchBasis === 'matched' && !result.diagnostics.length && covered(pair) ? 'complete' : 'unknown';
    result.status = result.batchBasis === 'matched' && !result.diagnostics.length && pairs.every((p) => p.status === 'complete') ? 'complete' : 'unknown';
    result.acquisitions.sort((a, b) => a.origin - b.origin || a.pair - b.pair);
    result.budget = work.snapshot();
    if (!borrowed) await work.dispose();
  }
  return result;
}
