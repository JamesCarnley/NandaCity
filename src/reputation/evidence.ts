import { isAbsolute, resolve } from 'node:path';

import { createPublicClient, hexToBytes, http, isAddress, keccak256, numberToHex, toBytes, zeroAddress,
  type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';

import type { FeedbackIndexSource } from '../feedback/indexClient.js';
import { readFeedbackCarryForward, readHistoricalFeedback, type FeedbackCarryForwardObservation,
  type HistoricalFeedbackObservation } from '../feedback/historicalRead.js';
import type { CheckpointRpcLedger, FreshPairZeroObservation } from '../feedback/pairZeroCheckpoint.js';
import { decodeSupportingBundle, type SupportingBundle } from '../feedback/supportingBundle.js';
import { continuityLimits, readIdentityFeedbackEpoch, type IdentityContinuityDomain } from '../identity/continuity.js';
import { decodeRegistration } from '../identity/profile.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import { verifyProfile, type AgentRef, type VerifiedProfile } from '../identity/verify.js';
import { ownedFetch } from '../demo/ownedLifecycle.js';
import { readPrivateBundleFile } from '../demo/privateBundleFile.js';
import { cityRequestEnvelopeFromParams, sendParamsSchema } from '../a2a/wire.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { checkpointConfigurationSchema, readAcceptedReviewerCoverage, type AcceptedReviewerCoverage, type CoverageStart } from './coverage.js';
import { calculatePolicy, type PolicyInput, type PolicyResult } from './policy.js';
import { createRankingReadBudget, type RankingReadBudget, type RankingReadBudgetSnapshot } from './readBudget.js';
import { qualifyTownTestAdmission, readTownEvidence, type TownEvidenceRuntime,
  type TownEvidenceObservation } from './townEvidence.js';

export type RankingEvidenceInput = Readonly<CoverageStart & {
  rpcOrigin: string;
  identityDomain: IdentityContinuityDomain;
  cardOrigin: string;
  observation: Readonly<{ blockNumber: bigint; blockHash: Hex }>;
  indexes: readonly [{ origin: string; source: FeedbackIndexSource }, { origin: string; source: FeedbackIndexSource }];
  policy: PolicyInput['policy'];
  scope: PolicyInput['scope'];
  services: readonly Readonly<{ agent: AgentRef; townBundleDirectory?: string }>[];
  privateBundleFiles: readonly Readonly<{ documentHash: Hex; path: string | null }>[];
  curatorInclusions?: readonly Readonly<{ curator: string; agent: AgentRef }>[];
  townRuntime?: TownEvidenceRuntime;
  signal?: AbortSignal;
}>;

export type RankingEvidenceSidecar = Readonly<{
  coverage: Readonly<{
    status: 'complete' | 'unknown';
    activation: 'matched' | 'mismatched' | 'unsupported' | 'unavailable' | null;
    checkpoint: FreshPairZeroObservation | null;
    pairs: readonly Readonly<{ service: string; reviewer: Address; status: 'complete' | 'unknown';
      lastIndex: string | null; missingSlots: readonly string[]; codes: readonly string[] }>[];
    acquisitions: readonly Readonly<{ origin: 0 | 1; pair: number;
      status: 'complete' | 'partial' | 'unavailable'; codes: readonly string[] }>[];
    rows: readonly Readonly<{ origin: 0 | 1; pair: number; eventId: string;
      disposition: 'matched' | 'rejected' | 'unsupported' | 'unexamined' | 'non-publication';
      codes: readonly string[] }>[];
    documents: readonly Readonly<{ hash: Hex; availability: 'available' | 'unavailable';
      sourceIndexes: readonly (0 | 1)[]; codes: readonly string[] }>[];
    codes: readonly string[];
  }>;
  services: readonly Readonly<{
    service: string;
    profile: Readonly<{ status: 'valid' | 'invalid' | 'inactive' | 'unknown';
      basis: Readonly<{ blockNumber: string; blockHash: Hex }> | null;
      endpoint: string | null; cardDigest: Hex | null; codes: readonly string[] }>;
    slots: readonly Readonly<{ reviewer: Address; feedbackIndex: string; documentHash: Hex;
      document: 'available' | 'unavailable' | 'incompatible';
      bundle: 'available' | 'absent' | 'rejected';
      historical: 'evaluated' | 'not-evaluated' | 'unavailable';
      epoch: 'same' | 'retired' | 'unknown'; policyReviewId: string | null;
      bundleCommitment: FeedbackCarryForwardObservation['bundleCommitment'];
      carryForward: FeedbackCarryForwardObservation['carryForward'] | null;
      source: Readonly<{ blockNumber: string; blockHash: Hex; transactionHash: Hex;
        transactionIndex: number; logIndex: number }> | null;
      sourceIndexes: readonly (0 | 1)[]; codes: readonly string[] }>[];
  }>[];
  town: readonly Readonly<{ service: string; observer: string | null;
    bundleDigest: string | null; resultDigest: string | null;
    window: Readonly<{ started: number; evaluated: number }> | null;
    stages: readonly Readonly<{ name: string; status: string }>[];
    admission: 'valid' | 'invalid' | 'unknown' | 'unavailable'; codes: readonly string[] }>[];
  budget: RankingReadBudgetSnapshot;
  codes: readonly string[];
}>;

export type RankingEvidenceRead = Readonly<{
  qualification: 'rpc-derived-not-state-proof';
  snapshot: 'matched' | 'changed' | 'unavailable';
  policyInput: PolicyInput | null;
  policyResult: PolicyResult | null;
  sidecar: RankingEvidenceSidecar;
  /** Explicit private raw acquisition; do not export with the public sidecar. */
  privateCheckpointLedger: CheckpointRpcLedger | null;
  diagnostics: readonly string[];
  budget: RankingReadBudgetSnapshot;
}>;

const hash = z.string().regex(/^0x[0-9a-f]{64}$/i).transform((value) => value.toLowerCase() as Hex);
const address = z.string().refine((value) => isAddress(value, { strict: true }) && value.toLowerCase() !== zeroAddress)
  .transform((value) => value.toLowerCase() as Address);
const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) < 1n << 256n);
const coordinate = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && resolve(value) === value);
const loopbackOrigin = z.string().refine((value) => {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(value)) return false;
  try { return new URL(value).origin === value; } catch { return false; }
});
const rpcOrigin = z.string().refine((value) => {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return false;
  try { return new URL(value).origin === value; } catch { return false; }
});
const agentSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  registry: address, agentId: uint });
const publicationDomainSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  genesisHash: hash, identityRegistry: address, reputationRegistry: address });
const transactionSchema = z.strictObject({ transactionHash: hash, blockNumber: uint, blockHash: hash,
  transactionIndex: coordinate });
const creationSchema = transactionSchema.extend({ address, nonce: uint, runtimeCodeHash: hash });
const boundedMap = z.record(z.string().max(256), z.string().max(256)).refine((value) => Object.keys(value).length <= 16);
const provenanceSchema = z.strictObject({
  domain: publicationDomainSchema, deployer: address,
  artifacts: z.strictObject({ referenceCommit: z.string().max(256), solcVersion: z.string().max(256),
    solcTmpVersion: z.string().max(256), openZeppelinVersion: z.string().max(256),
    sourceSha256: boundedMap, artifactSha256: boundedMap,
    compilerSettings: z.strictObject({ evmVersion: z.literal('shanghai'), viaIR: z.literal(true),
      optimizer: z.strictObject({ enabled: z.literal(true), runs: z.literal(200) }) }),
  }),
  bootstrap: creationSchema, proxy: creationSchema, implementation: creationSchema,
  activation: transactionSchema.extend({ upgradedLogIndex: coordinate }),
});
const identityDomainSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  registry: address, genesisHash: hash,
  knownImplementation: z.strictObject({ address, codeHash: hash }) });
const indexSourceSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  genesisHash: hash, identityRegistry: address, reputationRegistry: address,
  startBlock: uint, confirmations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const policySchema = z.strictObject({ id: key, version: key,
  reviewers: z.array(address).max(8),
  groups: z.array(z.strictObject({ key, reviewers: z.array(address).min(1).max(8) })).max(8),
  curators: z.array(key).max(256), evaluators: z.array(key).max(256) });
const inputBase = z.strictObject({
  rpcOrigin, identityDomain: identityDomainSchema, cardOrigin: loopbackOrigin,
  observation: z.strictObject({ blockNumber: z.bigint().min(0n).max((1n << 256n) - 1n), blockHash: hash }),
  indexes: z.tuple([z.strictObject({ origin: rpcOrigin, source: indexSourceSchema }),
    z.strictObject({ origin: rpcOrigin, source: indexSourceSchema })]),
  policy: policySchema,
  scope: z.strictObject({ city: key, task: key, rubric: key }),
  services: z.array(z.strictObject({ agent: agentSchema, townBundleDirectory: absolutePath.optional() })).max(6),
  privateBundleFiles: z.array(z.strictObject({ documentHash: hash, path: absolutePath.nullable() })).max(512),
  curatorInclusions: z.array(z.strictObject({ curator: key, agent: agentSchema })).max(512).optional(),
  townRuntime: z.strictObject({ checkout: absolutePath, python: absolutePath }).optional(),
});
const inputSchema = z.union([
  inputBase.extend({ provenance: provenanceSchema, checkpoint: z.never().optional() }),
  inputBase.extend({ checkpoint: checkpointConfigurationSchema, provenance: z.never().optional() }),
]);

type Config = z.output<typeof inputSchema> & { signal?: AbortSignal };
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const serviceKey = (agent: AgentRef): string =>
  `eip155:${agent.chainId}/erc721:${agent.registry.toLowerCase()}/${agent.agentId}`;

function copyConfiguration(input: RankingEvidenceInput): Config {
  try {
    if (!input || typeof input !== 'object') throw new Error();
    const { signal, ...raw } = input;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error();
    const config = inputSchema.parse(raw);
    const domain = (config.checkpoint ?? config.provenance).domain;
    if (config.indexes[0].origin === config.indexes[1].origin ||
      config.identityDomain.chainId !== domain.chainId ||
      !same(config.identityDomain.registry, domain.identityRegistry) ||
      !same(config.identityDomain.genesisHash, domain.genesisHash)) throw new Error();
    for (const index of config.indexes) if (index.source.chainId !== domain.chainId ||
      !same(index.source.genesisHash, domain.genesisHash) ||
      !same(index.source.identityRegistry, domain.identityRegistry) ||
      !same(index.source.reputationRegistry, domain.reputationRegistry)) throw new Error();
    const services = config.services.map(({ agent }) => serviceKey(agent));
    if (new Set(services).size !== services.length || config.services.some(({ agent }) =>
      agent.chainId !== config.identityDomain.chainId || !same(agent.registry, config.identityDomain.registry))) throw new Error();
    if (config.checkpoint) {
      const c = config.checkpoint;
      const expected = new Set(config.services.flatMap(({ agent }) => config.policy.reviewers.map((reviewer) => `${agent.agentId}:${reviewer}`)));
      if (c.observation.blockNumber !== config.observation.blockNumber || !same(c.observation.blockHash, config.observation.blockHash) ||
        !same(c.pins.identity.implementation, config.identityDomain.knownImplementation.address) ||
        !same(c.pins.identity.fullRuntimeHash, config.identityDomain.knownImplementation.codeHash) ||
        c.pairs.length !== expected.size || new Set(c.pairs.map((p) => `${p.agentId}:${p.reviewer}`)).size !== expected.size ||
        c.pairs.some((p) => !expected.has(`${p.agentId}:${p.reviewer}`))) throw new Error();
    }
    if (new Set(config.policy.reviewers).size !== config.policy.reviewers.length ||
      new Set(config.policy.curators).size !== config.policy.curators.length ||
      new Set(config.policy.evaluators).size !== config.policy.evaluators.length ||
      new Set(config.policy.groups.map((group) => group.key)).size !== config.policy.groups.length) throw new Error();
    const members = config.policy.groups.flatMap((group) => group.reviewers);
    if (new Set(members).size !== members.length || members.length !== config.policy.reviewers.length ||
      members.some((reviewer) => !config.policy.reviewers.includes(reviewer))) throw new Error();
    if (new Set(config.privateBundleFiles.map(({ documentHash }) => documentHash)).size !== config.privateBundleFiles.length) throw new Error();
    const curators = config.curatorInclusions ?? [];
    if (curators.some(({ agent }) => !services.includes(serviceKey(agent))) ||
      new Set(curators.map(({ curator, agent }) => `${curator}\0${serviceKey(agent)}`)).size !== curators.length ||
      curators.length + config.services.filter(({ townBundleDirectory }) => townBundleDirectory !== undefined).length > 512 ||
      (config.services.some(({ townBundleDirectory }) => townBundleDirectory !== undefined) && !config.townRuntime)) throw new Error();
    return { ...config, ...(signal ? { signal } : {}) };
  } catch {
    throw new Error('invalid ranking evidence configuration');
  }
}

function diagnosticCode(value: string): string {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 96) return value;
  if (value.startsWith('invalid Index feedback ')) return 'index-feedback-invalid';
  return 'evidence-unavailable';
}

function sanitizeCoverage(coverage: AcceptedReviewerCoverage): RankingEvidenceSidecar['coverage'] {
  const service = (agentId: string) => serviceKey({ chainId: coverage.domain.chainId,
    registry: coverage.domain.identityRegistry, agentId });
  return {
    status: coverage.status,
    activation: coverage.activation?.activation ?? null,
    checkpoint: coverage.checkpoint ? structuredClone(coverage.checkpoint) : null,
    pairs: coverage.pairs.map((pair) => ({ service: service(pair.agentId), reviewer: pair.reviewer,
      status: pair.status, lastIndex: pair.lastIndex, missingSlots: [...pair.missingSlots],
      codes: pair.diagnostics.map(diagnosticCode) })),
    acquisitions: coverage.acquisitions.map((entry) => ({ origin: entry.origin, pair: entry.pair,
      status: entry.status, codes: entry.diagnostics.map(diagnosticCode) })),
    rows: coverage.rows.map((row) => ({ origin: row.origin, pair: row.pair, eventId: row.event.eventId,
      disposition: row.disposition, codes: row.diagnostics.map(diagnosticCode) })),
    documents: coverage.documents.map((document) => ({ hash: document.hash,
      availability: document.availability, sourceIndexes: [...document.sources],
      codes: document.diagnostics.map(diagnosticCode) })),
    codes: coverage.diagnostics.map(diagnosticCode),
  };
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) throw new Error();
  return BigInt(value);
}

function rawText(value: Hex, limit: number): string {
  const bytes = hexToBytes(value);
  if (bytes.byteLength > limit || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw new Error();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function createClient(config: Config, work: RankingReadBudget): PublicClient {
  const fetcher = boundRpcFetch(ownedFetch, { budget: work.requestBudget('shared', 'rpc'),
    ...(config.signal ? { signal: config.signal } : {}) });
  return createPublicClient({ cacheTime: 0, batch: { multicall: false },
    transport: http(config.rpcOrigin, { retryCount: 0, batch: false, timeout: 5_000, fetchFn: fetcher }) });
}

async function frozenBlock(client: PublicClient, observation: Config['observation']): Promise<{ timestamp: number }> {
  const block = await client.getBlock({ blockNumber: observation.blockNumber });
  if (block.number !== observation.blockNumber || !block.hash || !same(block.hash, observation.blockHash) ||
    block.timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('numbered observation mismatch');
  return { timestamp: Number(block.timestamp) };
}

function guardedClient(client: PublicClient, observation: Config['observation']): PublicClient {
  return { ...client, getBlock: (async (parameters) => {
    const block = await client.getBlock(parameters);
    if (parameters && 'blockNumber' in parameters && parameters.blockNumber === observation.blockNumber &&
      (block.number !== observation.blockNumber || !block.hash || !same(block.hash, observation.blockHash))) {
      throw new Error('numbered observation mismatch');
    }
    return block;
  }) as PublicClient['getBlock'] };
}

async function fetchCard(url: string, config: Config, work: RankingReadBudget): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.origin !== config.cardOrigin || parsed.protocol !== 'http:' || parsed.username || parsed.password ||
    parsed.hash || parsed.search || !/^\/cards\/[0-9]+\.json$/.test(parsed.pathname)) throw new Error('card URL rejected');
  const controller = new AbortController();
  const abort = () => controller.abort();
  config.signal?.addEventListener('abort', abort, { once: true });
  let lease: Awaited<ReturnType<ReturnType<RankingReadBudget['requestBudget']>['open']>> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (config.signal?.aborted) abort();
    lease = await work.requestBudget('shared', 'rpc').open(controller.signal);
    const leaseAbort = () => controller.abort();
    lease.signal.addEventListener('abort', leaseAbort, { once: true });
    try {
      lease.check();
      response = await ownedFetch(parsed, { redirect: 'manual', signal: controller.signal,
        headers: { 'accept-encoding': 'identity' } });
      if (response.status !== 200 || response.redirected) throw new Error('card HTTP rejected');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw new Error('card encoding rejected');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > 65_536n)) {
        throw new Error('card length rejected');
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('card body unavailable');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted(); lease.check();
        if (done) break;
        length += value.byteLength; lease.bytes(value.byteLength);
        if (length > 65_536) throw new Error('card length rejected');
        chunks.push(value);
      }
      if (declared !== null && BigInt(declared) !== BigInt(length)) throw new Error('card length mismatch');
      return new Uint8Array(Buffer.concat(chunks, length));
    } finally { lease.signal.removeEventListener('abort', leaseAbort); }
  } finally {
    controller.abort(); config.signal?.removeEventListener('abort', abort);
    try { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {}); }
    finally { lease?.close(); }
  }
}

type ServiceState = { agent: AgentRef; service: string; profile: VerifiedProfile | null;
  profileStatus: 'valid' | 'invalid' | 'inactive' | 'unknown'; cardBytes: Uint8Array | null;
  codes: string[]; implementationKnown: boolean };

async function readCurrentService(config: Config, work: RankingReadBudget,
  selected: Config['services'][number]): Promise<ServiceState> {
  const agent = selected.agent, service = serviceKey(agent);
  const state: ServiceState = { agent, service, profile: null, profileStatus: 'unknown',
    cardBytes: null, codes: [], implementationKnown: false };
  const client = createClient(config, work);
  let phase = 'current-basis';
  try {
    await frozenBlock(client, config.observation);
    const guarded = guardedClient(client, config.observation);
    phase = 'current-snapshot';
    const snapshot = await readIdentitySnapshot(guarded, agent, config.observation.blockNumber);
    phase = 'current-registration';
    const registration = decodeRegistration(snapshot.agentURI);
    const expected = `${config.cardOrigin}/cards/${agent.agentId}.json`;
    const cards = registration.services.filter((entry) => entry.name === 'A2A');
    if (cards.length !== 1 || cards[0]!.endpoint !== expected) throw new Error('published card URL mismatch');
    phase = 'current-card';
    const cardBytes = await fetchCard(expected, config, work);
    phase = 'current-profile';
    const profile = verifyProfile({ agent, agentURI: snapshot.agentURI, cardBytes }, snapshot);
    phase = 'current-implementation';
    const epoch = await readIdentityFeedbackEpoch(guarded, { domain: config.identityDomain, agent,
      basis: { blockNumber: config.observation.blockNumber, blockHash: config.observation.blockHash },
      observation: config.observation, limits: continuityLimits, ...(config.signal ? { signal: config.signal } : {}) });
    state.implementationKnown = epoch.epoch !== 'unknown';
    state.profile = profile; state.cardBytes = cardBytes;
    state.profileStatus = !profile.registration.active ? 'inactive' : epoch.epoch === 'unknown' ? 'unknown' : 'valid';
    if (epoch.epoch === 'unknown') state.codes.push('identity-implementation-unavailable');
  } catch {
    state.codes.push(`${phase}-unavailable`);
  }
  return state;
}

const evidenceId = (prefix: string, parts: readonly string[]): string =>
  `${prefix}:${keccak256(toBytes(JSON.stringify(parts)))}`;

function policyProfile(state: ServiceState): PolicyInput['candidates'][number]['profile'] {
  const profile = state.profile;
  const representable = profile && key.safeParse(profile.card.url).success;
  if (profile && !representable && !state.codes.includes('policy-profile-unrepresentable')) {
    state.codes.push('policy-profile-unrepresentable');
  }
  return {
    id: evidenceId('profile', [state.service, profile?.source.blockHash ?? 'unavailable']),
    status: representable ? state.profileStatus : state.profileStatus === 'inactive' ? 'inactive' : 'unknown',
    endpoint: representable && state.profileStatus === 'valid' ? profile.card.url : null,
    cardDigest: representable && state.profileStatus === 'valid' ? profile.source.cardDigest as Hex : null,
    provenance: 'adapter-observed',
  };
}

function historyFor(state: ServiceState, coverage: AcceptedReviewerCoverage,
  observationId: string, acceptedReviewerCount: number,
  qualificationGap: boolean): PolicyInput['candidates'][number]['history'] {
  const activation = coverage.activation?.activation === 'matched' ? coverage.activation.knownDeployment?.activation : undefined;
  const pairs = coverage.pairs.filter((pair) => pair.agentId === state.agent.agentId);
  const checkpoint = coverage.checkpoint?.status === 'matched' ? coverage.checkpoint : undefined;
  const complete = (!!activation || !!checkpoint) && coverage.status === 'complete' &&
    pairs.length === acceptedReviewerCount && pairs.every((pair) => pair.status === 'complete') && !qualificationGap;
  if (checkpoint) return {
    id: evidenceId('history', [state.service, observationId]),
    status: complete ? 'complete' : coverage.batchBasis === 'matched' ? 'partial' : 'unavailable',
    startBlock: checkpoint.zeroBasis.blockNumber, start: 'pair-zero-checkpoint-confirmed',
    observation: observationId, provenance: 'adapter-observed',
    checkpoint: { domain: { ...checkpoint.domain }, zeroBasis: { ...checkpoint.zeroBasis },
      pairs: pairs.map(({ agentId, reviewer }) => ({ agentId, reviewer })) },
  };
  return {
    id: evidenceId('history', [state.service, observationId]),
    status: complete ? 'complete' : coverage.batchBasis === 'matched' ? 'partial' : 'unavailable',
    startBlock: activation?.blockNumber ?? '0',
    start: activation ? 'registry-start-confirmed' : 'unproven',
    observation: observationId,
    provenance: 'adapter-observed',
  };
}

function profileSidecar(state: ServiceState): RankingEvidenceSidecar['services'][number] {
  return { service: state.service, profile: { status: state.profileStatus,
    basis: state.profile ? { blockNumber: state.profile.source.blockNumber,
      blockHash: state.profile.source.blockHash as Hex } : null,
    endpoint: state.profile?.card.url ?? null,
    cardDigest: state.profile?.source.cardDigest as Hex | undefined ?? null,
    codes: [...state.codes] }, slots: [] };
}

type SlotSidecar = RankingEvidenceSidecar['services'][number]['slots'][number];
type PolicyReview = PolicyInput['reviews'][number];

function crypto(value: string): 'valid' | 'invalid' | 'unknown' {
  return value === 'valid' ? 'valid' : value === 'invalid' ? 'invalid' : 'unknown';
}

function match(values: readonly string[]): 'matched' | 'mismatched' | 'unknown' {
  return values.includes('mismatched') ? 'mismatched' : values.every((value) => value === 'matched') ? 'matched' : 'unknown';
}

function reviewFromObservation(state: ServiceState, slot: AcceptedReviewerCoverage['pairs'][number]['slots'][number],
  historical: HistoricalFeedbackObservation | null, bundle: SupportingBundle | null,
  epoch: 'same' | 'retired' | 'unknown', observationDomain: string,
  bundleCommitment: FeedbackCarryForwardObservation['bundleCommitment']): PolicyReview {
  const observed = slot.observation;
  const source = observed.source!;
  const event = observed.event!;
  const document = historical?.publication.document.feedback;
  // A substituted private bundle is not evidence that the public review itself
  // is invalid. Ignore its private projections so it cannot erase negative history
  // through a forged scope, invalid link or apparent newcomer classification.
  const privateMatched = document?.version !== '0.2' || bundleCommitment === 'matched';
  const findings = privateMatched && historical?.historical.status === 'evaluated' ? historical.historical.findings : null;
  const request = privateMatched ? bundle?.request.statement.value : undefined;
  const result = findings?.resultEvidence === 'matched'
    ? findings.completionClaimedOutcome === 'completed' ? 'signed-completion' : 'signed-failure'
    : findings?.resultEvidence === 'post-deadline-reviewer-claim' ? 'post-deadline-reviewer-claim'
    : findings?.resultEvidence === 'mismatched' || findings?.resultEvidence === 'too-early-claim' ? 'invalid' : 'unknown';
  const publication = historical?.publication;
  const canonical = publication?.publication === 'orphaned' ? 'noncanonical'
    : publication?.source && (publication.publication === 'matched' || publication.publication === 'mismatched') ? 'canonical' : 'unknown';
  const projection = publication?.publication === 'matched' ? 'matched'
    : publication?.publication === 'mismatched' ? 'mismatched' : 'unknown';
  const original = privateMatched ? match([historical?.originalAuthority.status ?? 'unknown',
    findings?.originalProfileBasis ?? 'unknown', findings?.acceptanceSignerBinding ?? 'unknown']) : 'unknown';
  const links = findings ? match([findings.reviewerBinding, findings.requestCallerBinding, findings.serviceLink,
    findings.registryDomain, findings.requestLink, findings.acceptanceLink,
    findings.completionLink === 'not-present' ? 'matched' : findings.completionLink,
    findings.completionSignerBinding === 'not-present' ? 'matched' : findings.completionSignerBinding]) : 'unknown';
  const timestamp = Number(source.blockTimestamp);
  return {
    id: evidenceId('review', [state.service, source.transactionHash, String(source.logIndex)]),
    documentDigest: event.feedbackHash as Hex, service: state.service,
    reviewer: document?.reviewer.address.toLowerCase() ?? null,
    interaction: document?.interactionId ?? null,
    city: request?.kind === 'request' ? request.input.city : null,
    task: request?.kind === 'request' ? request.input.capability : null,
    rubric: document?.rubric ?? null,
    rating: document?.value ?? null,
    checks: {
      feedbackSignature: crypto(findings?.feedbackSignature ??
        (document?.version === '0.2' ? publication?.document.signature ?? 'unknown' : 'unknown')),
      requestSignature: crypto(findings?.requestSignature ?? 'unknown'),
      acceptanceSignature: crypto(findings?.acceptanceSignature ?? 'unknown'),
      links, originalAuthority: original,
      chronology: findings?.claimedTime === 'inconsistent' || publication?.claimedFeedbackTime === 'after-publication'
        ? 'inconsistent' : findings?.claimedTime === 'consistent' &&
          publication?.claimedFeedbackTime === 'not-after-publication' ? 'consistent' : 'unknown',
      result,
    },
    epoch: privateMatched ? epoch : 'unknown', provenance: 'adapter-observed',
    publication: { domain: observationDomain, block: source.blockNumber,
      transaction: source.transactionIndex, log: source.logIndex,
      timestamp: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0,
      canonical, projection,
      revocation: publication?.revocation ?? 'unknown' },
  };
}

function explicitCityIncompatibility(event: NonNullable<AcceptedReviewerCoverage['pairs'][number]['slots'][number]['observation']['event']>,
  rubric: string): boolean {
  if (event.valueDecimals !== 0) return true;
  try {
    return rawText(event.tag1Bytes, 2_048) !== rubric || rawText(event.tag2Bytes, 2_048) !== '' ||
      rawText(event.endpointBytes, 2_048) !== '';
  } catch { return true; }
}

function documentDescriptor(review: PolicyReview): string {
  const { id: _id, publication: _publication, provenance: _provenance, ...document } = review;
  return JSON.stringify(document);
}

function reconcilePolicyReviews(reviews: PolicyReview[], sidecars: Map<string, SlotSidecar[]>,
  qualificationGaps: Set<string>): PolicyReview[] {
  const conflicts = new Map<string, Set<string>>();
  const note = (review: PolicyReview, code: string): void => {
    const codes = conflicts.get(review.id) ?? new Set<string>(); codes.add(code); conflicts.set(review.id, codes);
    qualificationGaps.add(review.service);
  };
  const documents = new Map<string, PolicyReview[]>();
  const publications = new Map<string, PolicyReview[]>();
  for (const review of reviews) {
    const documentGroup = documents.get(review.documentDigest) ?? [];
    documentGroup.push(review); documents.set(review.documentDigest, documentGroup);
    const publicationKey = JSON.stringify([review.documentDigest, review.publication.domain,
      review.publication.block, review.publication.transaction, review.publication.log]);
    const publicationGroup = publications.get(publicationKey) ?? [];
    publicationGroup.push(review); publications.set(publicationKey, publicationGroup);
  }
  for (const group of documents.values()) if (new Set(group.map(documentDescriptor)).size > 1) {
    for (const review of group) note(review, 'policy-document-conflict');
  }
  for (const group of publications.values()) if (new Set(group.map((review) => JSON.stringify(review.publication))).size > 1) {
    for (const review of group) note(review, 'policy-publication-conflict');
  }
  if (!conflicts.size) return reviews;
  for (const [service, slots] of sidecars) sidecars.set(service, slots.map((slot) => {
    const codes = slot.policyReviewId ? conflicts.get(slot.policyReviewId) : undefined;
    return codes ? { ...slot, policyReviewId: null, codes: [...slot.codes, ...codes] } : slot;
  }));
  return reviews.filter((review) => !conflicts.has(review.id));
}

async function readReviews(config: Config, work: RankingReadBudget, coverage: AcceptedReviewerCoverage,
  states: readonly ServiceState[], observationDomain: string): Promise<{ reviews: PolicyReview[];
    slots: Map<string, SlotSidecar[]>; qualificationGaps: Set<string> }> {
  const reviews: PolicyReview[] = [];
  const qualificationGaps = new Set<string>();
  const sidecars = new Map(states.map((state) => [state.service, [] as SlotSidecar[]]));
  const documents = new Map(coverage.documents.map((document) => [document.hash, document]));
  const files = new Map(config.privateBundleFiles.map((file) => [file.documentHash, file.path]));
  const privateBytes = new Map<string, Uint8Array>();
  // The earliest independently matched canonical document anchor owns the history
  // qualification. Later duplicates cannot refresh it (or its age/revocation).
  const anchors = new Map<string, FeedbackCarryForwardObservation>();
  const observations = new Map<string, FeedbackCarryForwardObservation>();
  const stateByAgent = new Map(states.map((state) => [state.agent.agentId, state]));
  const ordered = coverage.pairs.flatMap((pair) => pair.slots.map((slot) => ({ pair, slot }))).sort((a, b) => {
    const left = a.slot.observation.source, right = b.slot.observation.source;
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    return (BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1 : 0) ||
      left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex;
  });
  for (const { pair, slot } of ordered) {
    const state = stateByAgent.get(pair.agentId);
    if (!state || !slot.observation.event || !slot.observation.source) continue;
    const event = slot.observation.event, source = slot.observation.source;
    const codes: string[] = [];
    const document = documents.get(event.feedbackHash as Hex);
    let documentState: SlotSidecar['document'] = document?.bytes ? 'available' : 'unavailable';
    let bundleState: SlotSidecar['bundle'] = 'absent';
    let historicalState: SlotSidecar['historical'] = 'not-evaluated';
    let epoch: SlotSidecar['epoch'] = 'unknown';
    let policyReviewId: string | null = null;
    let historical: HistoricalFeedbackObservation | null = null;
    let composed: FeedbackCarryForwardObservation | null = null;
    let bundle: SupportingBundle | null = null;
    let bytes: Uint8Array | null = null;
    const preserveSlot = (): void => {
      sidecars.get(state.service)!.push({ reviewer: pair.reviewer,
        feedbackIndex: event.feedbackIndex, documentHash: event.feedbackHash as Hex,
        document: documentState, bundle: bundleState, historical: historicalState, epoch,
        bundleCommitment: composed?.bundleCommitment ?? 'unavailable', carryForward: composed?.carryForward ?? null,
        policyReviewId, source: { blockNumber: source.blockNumber, blockHash: source.blockHash,
          transactionHash: source.transactionHash, transactionIndex: source.transactionIndex, logIndex: source.logIndex },
        sourceIndexes: [...new Set(slot.sources.map((index) => coverage.rows[index]?.origin)
          .filter((origin): origin is 0 | 1 => origin === 0 || origin === 1))], codes });
    };
    if (explicitCityIncompatibility(event, config.scope.rubric)) {
      documentState = 'incompatible'; codes.push('city-publication-incompatible'); preserveSlot(); continue;
    }
    const path = files.get(event.feedbackHash as Hex) ?? null;
    try {
      const cached = privateBytes.get(event.feedbackHash);
      bytes = cached ?? await readPrivateBundleFile(path);
      if (bytes) {
        if (!cached) { work.chargeBundle(bytes.byteLength); privateBytes.set(event.feedbackHash, bytes); }
        bundleState = 'available';
        try { bundle = decodeSupportingBundle(bytes); } catch { bundleState = 'rejected'; codes.push('private-bundle-rejected'); }
      }
    } catch { bytes = null; bundleState = 'rejected'; codes.push('private-bundle-rejected'); }
    try {
      const readInput = { client: guardedClient(createClient(config, work), config.observation),
        domain: (config.checkpoint ?? config.provenance).domain,
        eventRef: { blockNumber: source.blockNumber, blockHash: source.blockHash,
          transactionHash: source.transactionHash, transactionIndex: source.transactionIndex,
          logIndex: source.logIndex, feedbackURI: rawText(event.feedbackURIBytes, 2_048) },
        observationBlock: config.observation.blockNumber,
        documentBytes: document?.bytes ?? null, bundleBytes: bytes };
      composed = anchors.get(event.feedbackHash) ?? null;
      if (composed) historical = await readHistoricalFeedback(readInput);
      else {
        composed = await readFeedbackCarryForward({ ...readInput, identityDomain: config.identityDomain,
          limits: continuityLimits, ...(config.signal ? { signal: config.signal } : {}) });
        historical = composed.historical;
        if (historical.publication.publication === 'matched') anchors.set(event.feedbackHash, composed);
      }
      observations.set(event.feedbackHash, composed);
      epoch = composed.epoch?.epoch ?? 'unknown';
      codes.push(...composed.carryForward.reasons, ...(composed.epoch?.diagnostics.map(diagnosticCode) ?? []));
      historicalState = historical.historical.status;
      if (historical.historical.status === 'not-evaluated' && historical.historical.reason === 'document-malformed') {
        documentState = 'incompatible';
      }
      codes.push(...historical.bundle.diagnostics.map(diagnosticCode),
        ...historical.originalAuthority.diagnostics.map(diagnosticCode),
        ...historical.publication.diagnostics.map(diagnosticCode));
    } catch { historicalState = 'unavailable'; codes.push('historical-read-unavailable'); }
    const review = reviewFromObservation(state, slot, historical, bundle, epoch, observationDomain,
      composed?.bundleCommitment ?? 'unavailable');
    try {
      // Use the calculator's public validation as the last representability fence.
      calculatePolicy({ policy: config.policy, scope: config.scope,
        observation: { id: `observation:${config.observation.blockHash}`, domain: observationDomain,
          block: config.observation.blockNumber.toString(), timestamp: 0,
          timeBasis: 'adapter-observed-publication-time', provenance: 'adapter-observed' },
        candidates: [], reviews: [review], admissions: [] });
      reviews.push(review); policyReviewId = review.id;
    } catch { codes.push('policy-review-unrepresentable'); qualificationGaps.add(state.service); }
    preserveSlot();
  }
  for (const review of reviews) {
    const finding = anchors.get(review.documentDigest) ?? observations.get(review.documentDigest);
    const privateMatched = finding?.bundleCommitment === 'matched' || finding?.bundleCommitment === 'uncommitted';
    review.historyQualification = !privateMatched ? 'unknown'
      : finding?.carryForward.status === 'qualified' ? 'committed-before-runtime-retirement'
      : finding?.carryForward.status === 'unknown' ? 'unknown' : 'unqualified';
    if (finding?.carryForward.basis) review.historyBasis = { version: '0.1', ...finding.carryForward.basis };
    if (finding?.epoch && privateMatched) review.epoch = finding.epoch.epoch;
  }
  for (const [service, slots] of sidecars) sidecars.set(service, slots.map((slot) => {
    const finding = anchors.get(slot.documentHash) ?? observations.get(slot.documentHash);
    return finding ? { ...slot, epoch: finding.epoch?.epoch ?? 'unknown',
      bundleCommitment: finding.bundleCommitment, carryForward: finding.carryForward } : slot;
  }));
  return { reviews: reconcilePolicyReviews(reviews, sidecars, qualificationGaps),
    slots: sidecars, qualificationGaps };
}

function retainedTownRequest(evidence: TownEvidenceObservation): { request: ReturnType<typeof decodeEnvelope>['statement']['value'];
  cardBytes: Uint8Array } {
  const decode = (value: string): Buffer => {
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) throw new Error(); return bytes;
  };
  const rpcBytes = decode(evidence.observation.requestRpcBase64);
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rpcBytes)) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
  const record = raw as Record<string, unknown>;
  const params = sendParamsSchema.parse(record['params']);
  const request = decodeEnvelope(cityRequestEnvelopeFromParams(params)).statement.value;
  if (request.kind !== 'request') throw new Error();
  return { request, cardBytes: decode(evidence.observation.cardBase64) };
}

function townAdmissionRepresentable(
  admission: Extract<PolicyInput['admissions'][number], { kind: 'test' }>,
): boolean {
  return [admission.id, admission.service, admission.issuer, admission.city,
    admission.task, admission.endpoint].every((value) => key.safeParse(value).success) &&
    hash.safeParse(admission.cardDigest).success;
}

async function readTownAdmissions(config: Config, work: RankingReadBudget,
  states: readonly ServiceState[]): Promise<{ admissions: PolicyInput['admissions']; town: RankingEvidenceSidecar['town'] }> {
  const admissions: PolicyInput['admissions'] = [];
  const town: Array<RankingEvidenceSidecar['town'][number]> = [];
  for (const selected of config.services) {
    if (!selected.townBundleDirectory) continue;
    const service = serviceKey(selected.agent);
    const state = states.find((entry) => entry.service === service)!;
    let evidence: TownEvidenceObservation | undefined;
    const codes: string[] = [];
    let status: RankingEvidenceSidecar['town'][number]['admission'] = 'unavailable';
    try {
      evidence = await readTownEvidence({ bundleDirectory: selected.townBundleDirectory,
        runtime: config.townRuntime!, ...(config.signal ? { signal: config.signal } : {}), work });
      if (!state.profile || !state.cardBytes) throw new Error();
      const retained = retainedTownRequest(evidence);
      if (retained.request.kind !== 'request') throw new Error();
      const basis = retained.request.profileBasis;
      const client = createClient(config, work);
      const basisSnapshot = await readIdentitySnapshot(guardedClient(client,
        { blockNumber: BigInt(basis.blockNumber), blockHash: basis.blockHash as Hex }),
      selected.agent, BigInt(basis.blockNumber));
      const basisProfile = verifyProfile({ agent: selected.agent, agentURI: basisSnapshot.agentURI,
        cardBytes: retained.cardBytes }, basisSnapshot);
      const epoch = await readIdentityFeedbackEpoch(guardedClient(createClient(config, work), config.observation), {
        domain: config.identityDomain, agent: selected.agent,
        basis: { blockNumber: BigInt(basis.blockNumber), blockHash: basis.blockHash as Hex },
        observation: config.observation, limits: continuityLimits,
        ...(config.signal ? { signal: config.signal } : {}) });
      const qualified = await qualifyTownTestAdmission({ evidence, service,
        acceptedEvaluators: config.policy.evaluators, basisProfile,
        currentProfile: state.profile, currentCardBytes: state.cardBytes, epoch });
      codes.push(...qualified.diagnostics.map(diagnosticCode));
      if (townAdmissionRepresentable(qualified.admission)) {
        admissions.push(qualified.admission); status = qualified.admission.status;
      } else {
        codes.push('policy-admission-unrepresentable'); status = 'invalid';
      }
    } catch { codes.push(evidence ? 'town-admission-invalid' : 'town-evidence-unavailable');
      status = evidence ? 'invalid' : 'unavailable'; }
    town.push({ service, observer: evidence?.receipt.observer ?? null,
      bundleDigest: evidence?.receipt.bundleFingerprint ?? null,
      resultDigest: evidence?.receipt.resultDigest ?? null,
      window: evidence ? { started: evidence.receipt.started, evaluated: evidence.receipt.evaluated } : null,
      stages: evidence?.result.stages.map((stage) => ({ name: stage.name, status: stage.status })) ?? [],
      admission: status, codes });
  }
  return { admissions, town };
}

/** Independent bounded composition over raw configured evidence. */
export async function readRankingEvidence(input: RankingEvidenceInput): Promise<RankingEvidenceRead> {
  const copied = copyConfiguration(input);
  const controller = new AbortController();
  const cancel = () => controller.abort(copied.signal?.reason ?? new Error('ranking evidence cancelled'));
  copied.signal?.addEventListener('abort', cancel, { once: true });
  if (copied.signal?.aborted) cancel();
  const deadline = setTimeout(() => controller.abort(new Error('ranking evidence deadline')), 120_000);
  deadline.unref?.();
  const aggregateSignal = controller.signal;
  const config: Config = { ...copied, signal: aggregateSignal };
  const work = createRankingReadBudget({ origins: [config.indexes[0].origin, config.indexes[1].origin],
    signal: aggregateSignal });
  let coverage: AcceptedReviewerCoverage | undefined;
  try {
    coverage = await readAcceptedReviewerCoverage({ rpcOrigin: config.rpcOrigin,
      ...(config.checkpoint ? { checkpoint: config.checkpoint } : { provenance: config.provenance }), observation: config.observation,
      agentIds: config.services.map(({ agent }) => agent.agentId), reviewers: config.policy.reviewers,
      indexes: config.indexes, ...(config.signal ? { signal: config.signal } : {}) }, work);
    const states: ServiceState[] = [];
    for (const selected of config.services) states.push(await readCurrentService(config, work, selected));
    const observationId = `observation:${config.observation.blockHash}`;
    const domain = (config.checkpoint ?? config.provenance).domain;
    const observationDomain = `eip155:${domain.chainId}/erc8004:${domain.reputationRegistry}`;
    const observedTimestamp = coverage.observation.blockTimestamp;
    const observationTimestamp = observedTimestamp && /^(0|[1-9][0-9]*)$/.test(observedTimestamp) &&
      BigInt(observedTimestamp) <= 253_402_300_799n ? Number(observedTimestamp) : 0;
    const derivedReviews = await readReviews(config, work, coverage, states, observationDomain);
    const derivedTown = await readTownAdmissions(config, work, states);
    const policyInput: PolicyInput = {
      policy: config.policy, scope: config.scope,
      observation: { id: observationId, domain: observationDomain,
        block: config.observation.blockNumber.toString(),
        timestamp: observationTimestamp,
        timeBasis: 'adapter-observed-publication-time', provenance: 'adapter-observed' },
      candidates: states.map((state) => {
        const extension = state.profile?.registration['x-nandacity'];
        const cities = extension?.areaServed.map((area) => area.name) ?? [];
        const selectedCity = cities.includes(config.scope.city as 'Chicago' | 'Boston') ? config.scope.city : cities[0];
        const city = selectedCity && key.safeParse(selectedCity).success ? selectedCity : config.scope.city;
        const task = extension && key.safeParse(extension.capability).success ? extension.capability : config.scope.task;
        return { service: state.service, city, task, profile: policyProfile(state),
          history: historyFor(state, coverage!, observationId, config.policy.reviewers.length,
            derivedReviews.qualificationGaps.has(state.service)) };
      }), reviews: derivedReviews.reviews,
      admissions: [...(config.curatorInclusions ?? []).map(({ curator, agent }) => ({ kind: 'curator' as const,
        id: evidenceId('curator', [curator, serviceKey(agent)]), service: serviceKey(agent), issuer: curator,
        city: config.scope.city, task: config.scope.task, status: 'valid' as const, provenance: 'supplied' as const })),
      ...derivedTown.admissions],
    };
    const policyResult = calculatePolicy(policyInput);

    let snapshot: RankingEvidenceRead['snapshot'] = 'unavailable';
    try {
      const fetcher = boundRpcFetch(ownedFetch, { budget: work.requestBudget('shared', 'rpc'),
        ...(config.signal ? { signal: config.signal } : {}) });
      const client = createPublicClient({ cacheTime: 0, batch: { multicall: false },
        transport: http(config.rpcOrigin, { retryCount: 0, batch: false, timeout: 5_000, fetchFn: fetcher }) });
      const block = await client.request({ method: 'eth_getBlockByNumber',
        params: [numberToHex(config.observation.blockNumber), false] }, { retryCount: 0 });
      if (!block || quantity(block.number) !== config.observation.blockNumber ||
        typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error();
      snapshot = same(block.hash, config.observation.blockHash) ? 'matched' : 'changed';
    } catch { snapshot = 'unavailable'; }

    const budget = work.snapshot();
    const diagnostics = snapshot === 'matched' ? [] :
      [snapshot === 'changed' ? 'final-observation-changed' : 'final-observation-unavailable'];
    const sidecar: RankingEvidenceSidecar = { coverage: sanitizeCoverage(coverage),
      services: states.map((state) => ({ ...profileSidecar(state), slots: derivedReviews.slots.get(state.service) ?? [] })),
      town: derivedTown.town,
      budget, codes: diagnostics };
    return { qualification: 'rpc-derived-not-state-proof', snapshot,
      policyInput: snapshot === 'matched' ? policyInput : null,
      policyResult: snapshot === 'matched' ? policyResult : null,
      sidecar, privateCheckpointLedger: coverage.privateCheckpointLedger, diagnostics, budget };
  } finally {
    clearTimeout(deadline); copied.signal?.removeEventListener('abort', cancel); await work.dispose();
  }
}
