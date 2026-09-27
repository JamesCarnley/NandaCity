import { createHash } from 'node:crypto';
import { createPublicClient, http, isAddress, zeroAddress, type Hex, type PublicClient } from 'viem';

import { searchIndexes, type IndexCoverage, type IndexOriginResult } from '../discovery/indexClient.js';
import { DiscoveryReadBudget, type DiscoveryBudgetSnapshot, type DiscoveryLimits } from '../discovery/readBudget.js';
import { verifyDiscovery, type DiscoveredCandidate } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import type { AgentRef, VerifiedProfile } from '../identity/verify.js';
import { readRankingEvidence, type RankingEvidenceInput, type RankingEvidenceRead } from '../reputation/evidence.js';
import { exactLoopbackOrigin, filterForCity, type City } from './externalClient.js';

export type RankedDiscoveryInput = Omit<Extract<RankingEvidenceInput, { checkpoint?: never }>, 'services'> & Readonly<{
  city: City;
  townBundles?: readonly Readonly<{ agent: AgentRef; directory: string }>[];
}>;
export type RankedDiscoveryOptions = Readonly<{ limits?: DiscoveryLimits }>;
export type DiscoveryProfile = Readonly<{
  blockNumber: string; blockHash: Hex; cardDigest: Hex; agentUriDigest: Hex; endpoint: string;
}>;
export type RankedDiscoveryCandidate = Readonly<{
  observerOrigin: string; agent: AgentRef; service: string;
}> & (
  | Readonly<{ status: 'verified'; profile: DiscoveryProfile; reason?: never }>
  | Readonly<{ status: 'rejected' | 'unavailable'; reason: string; profile?: never }>
);
export type RankedDiscoveryResult = Readonly<{
  city: City; status: 'complete' | 'partial' | 'unavailable';
  observation: Readonly<{ blockNumber: string; blockHash: Hex }>;
  origins: readonly Readonly<{ observerOrigin: string; status: 'complete' | 'partial' | 'unavailable';
    coverage: IndexCoverage | null; pages: number; errors: readonly string[]; budget: DiscoveryBudgetSnapshot }>[];
  candidates: readonly RankedDiscoveryCandidate[];
  selected: readonly Readonly<{ agent: AgentRef; service: string; origins: readonly string[]; profile: DiscoveryProfile }>[];
  eligibleCount: number; shortlist: 'complete' | 'partial'; diagnostics: readonly string[];
  ranking: RankingEvidenceRead;
}>;

const serviceKey = (agent: AgentRef): string => `eip155:${agent.chainId}/erc721:${agent.registry.toLowerCase()}/${agent.agentId}`;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
class RejectedDiscovery extends Error {}

function copyInput(input: RankedDiscoveryInput): RankedDiscoveryInput {
  const { signal, ...raw } = input;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('invalid discovery signal');
  const config = structuredClone(raw);
  if (!['Chicago', 'Boston'].includes(config.city) || config.city !== config.scope.city ||
    config.scope.task !== 'evening-plan') throw new Error('discovery city/task must match ranking scope');
  if (Object.keys(config).some((key) => !['city', 'townBundles', 'rpcOrigin', 'provenance', 'identityDomain', 'cardOrigin',
    'observation', 'indexes', 'policy', 'scope', 'privateBundleFiles', 'curatorInclusions', 'townRuntime'].includes(key))) throw new Error('invalid discovery configuration');
  for (const origin of [config.rpcOrigin, config.cardOrigin, ...config.indexes.map((index) => index.origin)]) {
    if (exactLoopbackOrigin(origin) !== origin) throw new Error('discovery origins must be exact');
  }
  if (config.indexes.length !== 2 || config.indexes[0].origin === config.indexes[1].origin) throw new Error('two distinct discovery origins required');
  const domain = config.identityDomain, publication = config.provenance.domain;
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId < 1 || !isAddress(domain.registry, { strict: true }) ||
    same(domain.registry, zeroAddress) || domain.chainId !== publication.chainId || !same(domain.registry, publication.identityRegistry) ||
    !same(domain.genesisHash, publication.genesisHash) || config.indexes.some(({ source }) =>
      source.chainId !== domain.chainId || !same(source.identityRegistry, domain.registry) ||
      !same(source.genesisHash, domain.genesisHash) || !same(source.reputationRegistry, publication.reputationRegistry))) throw new Error('inconsistent discovery identity domain');
  if (typeof config.observation.blockNumber !== 'bigint' || config.observation.blockNumber < 0n ||
    config.observation.blockNumber >= 1n << 256n || !/^0x[0-9a-f]{64}$/i.test(config.observation.blockHash)) throw new Error('invalid frozen observation');
  const refs = config.townBundles ?? [];
  if (!Array.isArray(refs) || refs.length > 64 || new Set(refs.map(({ agent }) => serviceKey(agent))).size !== refs.length ||
    refs.some(({ agent, directory }) => agent.chainId !== domain.chainId || !same(agent.registry, domain.registry) ||
      !/^(0|[1-9][0-9]{0,77})$/.test(agent.agentId) || BigInt(agent.agentId) >= 1n << 256n || typeof directory !== 'string') ||
    (refs.length && !config.townRuntime)) throw new Error('invalid trusted Town references');
  return { ...config, ...(signal ? { signal } : {}) };
}

function summary(profile: VerifiedProfile): DiscoveryProfile {
  return { blockNumber: profile.source.blockNumber, blockHash: profile.source.blockHash,
    cardDigest: profile.source.cardDigest, agentUriDigest: profile.source.agentUriDigest, endpoint: profile.card.url };
}

async function cardBytes(candidate: DiscoveredCandidate, config: RankedDiscoveryInput,
  work: DiscoveryReadBudget): Promise<Uint8Array> {
  // The exact path is derived from the independently selected domain's agent ID, not a model/Index destination.
  const expected = `${config.cardOrigin}/cards/${candidate.agent.agentId}.json`;
  if (candidate.declaration.url !== expected) throw new RejectedDiscovery('card URL outside exact configured origin/path');
  const lease = await work.requestBudget(candidate.observerOrigin, 'card').open(work.signal);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    lease.check();
    response = await fetch(expected, { redirect: 'manual', signal: lease.signal, headers: { 'accept-encoding': 'identity' } });
    if (response.status !== 200 || response.redirected) throw new Error('card HTTP unavailable');
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') throw new RejectedDiscovery('card content encoding refused');
    reader = response.body?.getReader(); if (!reader) throw new Error('card body unavailable');
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); lease.check();
      if (done) break;
      lease.bytes(value.byteLength); length += value.byteLength;
      if (length > 64 * 1024) throw new RejectedDiscovery('card exceeds 64 KiB');
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks, length));
  } finally {
    try { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {}); }
    finally { lease.close(); }
  }
}

async function scopedRpc<T>(config: RankedDiscoveryInput, work: DiscoveryReadBudget, origin: string,
  run: (client: PublicClient) => Promise<T>): Promise<T> {
  const controller = new AbortController(), pending = new Set<Promise<Response>>();
  const abort = () => controller.abort(work.signal.reason);
  work.signal.addEventListener('abort', abort, { once: true }); if (work.signal.aborted) abort();
  const bounded = boundRpcFetch(fetch, { budget: work.requestBudget(origin, 'rpc'), signal: controller.signal });
  const fetchFn: typeof fetch = (input, init) => {
    const result = bounded(input, init); pending.add(result);
    result.then(() => pending.delete(result), () => pending.delete(result)); return result;
  };
  const client = createPublicClient({ cacheTime: 0, batch: { multicall: false },
    transport: http(config.rpcOrigin, { retryCount: 0, batch: false, timeout: 5_000, fetchFn }) });
  try { work.check(origin); const value = await run(client); work.check(); return value; }
  finally { controller.abort(); work.signal.removeEventListener('abort', abort); await Promise.allSettled([...pending]); }
}

async function canonical(client: PublicClient, number: bigint, hash: Hex, timestamp?: number): Promise<void> {
  const block = await client.getBlock({ blockNumber: number });
  if (block.number !== number || !block.hash || !same(block.hash, hash) ||
    (timestamp !== undefined && block.timestamp !== BigInt(timestamp))) throw new RejectedDiscovery('observation differs from canonical chain');
}

/** Search hints from both origins, verify at one frozen basis, then read explained ranking. Never invokes A2A. */
export async function discoverRanked(input: RankedDiscoveryInput, options: RankedDiscoveryOptions = {}): Promise<RankedDiscoveryResult> {
  const config = copyInput(input), origins = [config.indexes[0].origin, config.indexes[1].origin] as const;
  if (Object.keys(options).some((key) => key !== 'limits')) throw new Error('invalid discovery options');
  const work = new DiscoveryReadBudget({ origins, ...(config.signal ? { signal: config.signal } : {}),
    ...(options.limits ? { limits: options.limits } : {}) });
  const candidates: RankedDiscoveryCandidate[] = [], filter = filterForCity(config.city);
  let search: Awaited<ReturnType<typeof searchIndexes>>;
  try {
    search = await searchIndexes(origins, filter, { signal: work.signal, filterDeclarations: true,
      requestBudget: (origin, kind) => work.requestBudget(origin, kind),
      rejectDeclaration: (agent) => agent.chainId !== config.identityDomain.chainId || !same(agent.registry, config.identityDomain.registry)
        ? 'candidate outside client-selected identity domain' : null,
      onFiltered: (observerOrigin, agent, reason) => candidates.push({ observerOrigin, agent, service: serviceKey(agent), status: 'rejected', reason }),
      onCandidate: async (candidate) => {
        const base = { observerOrigin: candidate.observerOrigin, agent: candidate.agent, service: serviceKey(candidate.agent) };
        try {
          if (candidate.declaration.url !== `${config.cardOrigin}/cards/${candidate.agent.agentId}.json`) {
            throw new RejectedDiscovery('card URL outside exact configured origin/path');
          }
          if (BigInt(candidate.observationBlock.number) > config.observation.blockNumber) throw new RejectedDiscovery('observation later than frozen basis');
          const basis = await scopedRpc(config, work, candidate.observerOrigin, async (client) => {
            await canonical(client, BigInt(candidate.observationBlock.number), candidate.observationBlock.hash, candidate.observationBlock.timestamp);
            // readIdentitySnapshot includes canonical read-back at exactly this numbered basis.
            try {
              const basis = await readIdentitySnapshot(client, candidate.agent, config.observation.blockNumber);
              if (!same(basis.blockHash, config.observation.blockHash)) throw new RejectedDiscovery('frozen basis differs from canonical chain');
              return basis;
            } catch (error) {
              // The shared reader adds an own cause when fetching read-back
              // failed; only its cause-free wrapper reports an observed mismatch.
              if (error instanceof Error && error.message === 'reorganization detected while reading identity snapshot' &&
                !Object.hasOwn(error, 'cause')) throw new RejectedDiscovery('reorganization during canonical profile read');
              throw error;
            }
          });
          const bytes = await cardBytes(candidate, config, work);
          const verdict = verifyDiscovery(candidate, basis, bytes, filter);
          if (verdict.status === 'verified') await scopedRpc(config, work, candidate.observerOrigin,
            (client) => canonical(client, config.observation.blockNumber, config.observation.blockHash));
          work.check();
          candidates.push(verdict.status === 'verified' ? { ...base, status: 'verified', profile: summary(verdict.profile) } :
            { ...base, status: verdict.status, reason: verdict.reason });
        } catch (error) {
          candidates.push({ ...base, status: error instanceof RejectedDiscovery ? 'rejected' : 'unavailable',
            reason: error instanceof RejectedDiscovery ? error.message : 'independent verification unavailable' });
        }
      },
    });
  } finally { await work.dispose(); }
  candidates.sort((a, b) => origins.indexOf(a.observerOrigin as typeof origins[number]) - origins.indexOf(b.observerOrigin as typeof origins[number]) ||
    a.service.localeCompare(b.service) || a.status.localeCompare(b.status));
  const byIdentity = new Map<string, { agent: AgentRef; service: string; origins: string[]; profile: DiscoveryProfile }>();
  if (!config.signal?.aborted) for (const candidate of candidates) if (candidate.status === 'verified') {
    const previous = byIdentity.get(candidate.service);
    if (previous) { if (!previous.origins.includes(candidate.observerOrigin)) previous.origins.push(candidate.observerOrigin); }
    else byIdentity.set(candidate.service, { agent: candidate.agent, service: candidate.service, origins: [candidate.observerOrigin], profile: candidate.profile });
  }
  const order = (service: string) => createHash('sha256').update(JSON.stringify([
    config.observation.blockNumber.toString(), config.observation.blockHash.toLowerCase(), service])).digest('hex');
  const selected = [...byIdentity.values()].sort((a, b) => order(a.service).localeCompare(order(b.service)) || a.service.localeCompare(b.service)).slice(0, 6);
  const statusFor = (origin: IndexOriginResult): RankedDiscoveryResult['origins'][number] => {
    const budget = work.snapshot(origin.observerOrigin), rows = candidates.filter((candidate) => candidate.observerOrigin === origin.observerOrigin);
    const incomplete = origin.errors.length > 0 || budget.exhausted.length > 0 || rows.some((candidate) => candidate.status !== 'verified' && candidate.reason !== 'declaration does not match requested filter');
    return { observerOrigin: origin.observerOrigin, status: !origin.available || config.signal?.aborted ? 'unavailable' : incomplete ? 'partial' : 'complete',
      coverage: origin.coverage, pages: origin.pages, errors: origin.errors, budget };
  };
  const acquisition = search.origins.map(statusFor);
  const shortlist = byIdentity.size > 6 ? 'partial' : 'complete';
  const { city: _city, townBundles: _townBundles, ...rankingConfig } = config;
  const refs = new Map(config.townBundles?.map(({ agent, directory }) => [serviceKey(agent), directory]));
  const ranking = await readRankingEvidence({ ...rankingConfig,
    curatorInclusions: (config.curatorInclusions ?? []).filter(({ agent }) => selected.some((candidate) => candidate.service === serviceKey(agent))),
    services: selected.map(({ agent, service }) => ({ agent, ...(refs.has(service) ? { townBundleDirectory: refs.get(service)! } : {}) })) });
  const cancelled = config.signal?.aborted;
  return { city: config.city, observation: { blockNumber: config.observation.blockNumber.toString(), blockHash: config.observation.blockHash },
    status: cancelled || acquisition.every((origin) => origin.status === 'unavailable') ? 'unavailable' :
      shortlist === 'partial' || acquisition.some((origin) => origin.status !== 'complete') ? 'partial' : 'complete',
    origins: cancelled ? acquisition.map((origin) => ({ ...origin, status: 'unavailable' as const })) : acquisition,
    candidates: cancelled ? candidates.map((candidate) => candidate.status === 'verified' ? {
      observerOrigin: candidate.observerOrigin, agent: candidate.agent, service: candidate.service,
      status: 'unavailable' as const, reason: 'caller cancelled discovery' } : candidate) : candidates,
    selected: cancelled ? [] : selected, eligibleCount: cancelled ? 0 : byIdentity.size,
    shortlist, diagnostics: [...(shortlist === 'partial' ? ['partial-shortlist'] : []), ...(cancelled ? ['cancelled'] : [])], ranking };
}
