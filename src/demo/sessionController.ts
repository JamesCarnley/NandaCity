import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { discoverRanked, type RankedDiscoveryResult } from '../client/rankedDiscovery.js';
import { filterForCity, pollTerminalTask, rpcTask, retainLicensedJourney, type RetainedJourney, type City } from '../client/externalClient.js';
import { eveningPlanInputSchema, type EveningPlanInput } from '../a2a/input.js';
import { LiveBudget, type BudgetOptions } from '../live/budget.js';
import { LiveTransport, type TransportConfig } from '../live/transport.js';
import { LiveAdapters } from '../live/adapters.js';
import { LiveAnswerBackend, type Inference } from '../live/answer.js';
import { licensedRetentionSchema, projectReceiptSummary, type LicensedRetention, type ReceiptSummary } from '../live/retention.js';
import { searchIndexes } from '../discovery/indexClient.js';
import { fetchOwnedCard } from '../discovery/cardClient.js';
import { verifyDiscoveryAtCurrentChain, type DiscoveredCandidate } from '../discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { boundRpcFetch } from '../identity/rpcTransport.js';
import { decodeEnvelope, signRequest } from '../interaction/signatures.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../interaction/schema.js';
import { CITY_REQUEST_DATA_TYPE } from '../a2a/wire.js';
import type { RankingEvidenceInput } from '../reputation/evidence.js';
import { encodeSupportingBundle } from '../feedback/supportingBundle.js';
import { encodeFeedbackDocument } from '../feedback/document.js';
import { signFeedback } from '../feedback/signatures.js';
import { readFeedbackPublication } from '../feedback/publication.js';
import { feedbackEventId, readIndexFeedback } from '../feedback/indexClient.js';
import { prepareLocalFeedbackPublication, submitPreparedFeedback, type PreparedFeedbackPublication, type FeedbackSubmissionResult } from './feedbackPublication.js';
import { writePrivateFile } from '../safe/privateFile.js';
import { verifyJourneyEvidence, type JourneyEvidence } from './journeyReport.js';
import { withOwnedLifecycle, ownedFetch } from './ownedLifecycle.js';
import { SESSION_FEEDBACK_CAPACITY, sessionNow, withSessionFixture, type SessionFixture, type SessionFixtureOptions, type SessionRecovery } from './sessionFixture.js';
import { runOriginComparison } from './originComparison.js';
import { runFreshRankingConsumer } from '../client/rankingConsumerCli.js';

export type SessionAction = { kind: 'refresh'; city: City } | { kind: 'invoke'; reviewer: 'accepted' | 'new'; fail?: boolean; input?: EveningPlanInput } |
  { kind: 'retry'; invocationId: string } | { kind: 'feedback'; invocationId: string; value: number } |
  { kind: 'retry-feedback'; feedbackId: string } | { kind: 'index'; index: 'A' | 'B'; state: 'stop' | 'start' | 'restart' | 'tamper'; city?: City } |
  { kind: 'stop-providers' } | { kind: 'recover'; operatorId: string } | { kind: 'fresh-consumer' } | { kind: 'origin-comparison' };
export type SessionOperation = { id: string; generation: number; kind: SessionAction['kind'];
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string };
export type SessionInvocation = { id: string; service: string; reviewer: 'accepted' | 'new'; requestDigest: Hex;
  sent: boolean; accepted: boolean; taskId: string | null; outcome: 'prepared' | 'sent' | 'accepted' | 'completed' | 'failed' | 'unresolved';
  checkedResult: 'not-checked' | 'matched' | 'mismatched' | 'unavailable'; answer: string | null; receipt?: ReceiptSummary };
export type SessionFeedback = { id: string; invocationId: string; value: number; reviewer: 'accepted' | 'new'; slot: number;
  documentHash: Hex; signed: true; publication: 'not-prepared' | 'not-sent' | 'unresolved' | 'observed'; transactionHash: Hex | null;
  readBack: 'not-read' | 'matched' | 'mismatched' | 'orphaned' | 'unavailable'; retained: Record<'A' | 'B', boolean>;
  weighting: string; policyId: 'session-demo-reviewer-policy' };

export type IndexObservation = { status: 'complete' | 'partial' | 'unavailable'; verified: number; rejected: number;
  unavailable: number; alteredNames: string[]; reasons: string[] };
export type ExperimentObservation = { city: City; status: RankedDiscoveryResult['status']; indexes: Record<'A' | 'B', IndexObservation>;
  services: string[] };
export type IndexExperiment = { target: 'A' | 'B'; action: 'stop' | 'start' | 'restart' | 'tamper'; city: City;
  phase: 'applying' | 'discovering' | 'observed' | 'failed' | 'cancelled'; before: ExperimentObservation | null;
  after: ExperimentObservation | null; note: string };
export type RecoveryCheck = { operatorId: string; city: City | null; status: 'recovering' | 'checking' | 'observed' | 'unavailable' | 'cancelled';
  endpoint: string | null; reason: string };

export type SessionView = {
  mode: 'fixture' | 'licensed';
  browserIsolation?: 'shared-fixture';
  answerEngine?: 'openclaw';
  licensedHint?: { admittedReviewer: 'accepted' | 'new'; expiresAt: string };
  freshConsumer: { status: 'matched' | 'different' | 'unavailable'; reason: string; observation: { blockNumber: string; blockHash: Hex } } | null;
  originComparison: { phase: string; result?: { discovery: Record<'A' | 'B', number>; retained: Record<'A' | 'B', number>;
    freshMatched: boolean; limitations: string[] } } | null;
  generation: number; status: 'starting' | 'ready' | 'resetting' | 'closed' | 'failed';
  lifecycleOperationId: string;
  operators: { id: string; label: string; safe: string; services: { city: string; agentId: string; status: string }[]; recovery?: SessionRecovery }[];
  crossOperatorWrite: 'not-tested' | 'rejected'; invocations: SessionInvocation[];
  discovery: RankedDiscoveryResult | null; selection: string | null; operations: SessionOperation[];
  indexControls: Record<'A' | 'B', 'online' | 'offline' | 'altered' | 'unknown'>;
  indexRead: ExperimentObservation | null; experiment: IndexExperiment | null; recoveryCheck?: RecoveryCheck | null;
  feedback: SessionFeedback[]; feedbackCapacity: { total: number; used: number; exhausted: boolean };
  limitations: readonly string[];
};
export type DemoSession = { view(): SessionView; ready(): Promise<void>; select(service: string): void;
  start(action: SessionAction, operationId?: string): SessionOperation; wait(operationId: string): Promise<SessionOperation>;
  /** Last completed raw observation for private replay after Index controls invalidate current discovery; recovery/reset destroy it. */
  frozenInput(): RankingEvidenceInput;
  /** Server-only disposable copy; never put content in public view or saved exports. */
  readContent(invocationId: string, generation: number): Uint8Array | undefined;
  reset(): Promise<void>; close(): Promise<void> };

export type SessionOptions = Extract<SessionFixtureOptions, { mode?: 'fixture' }> | {
  mode: 'licensed'; retention: LicensedRetention; admittedReviewer: 'accepted' | 'new';
  transport: TransportConfig; inference: Inference; budget: BudgetOptions; budgetDirectory: string;
};
const callable = z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function');
const optionsSchema = z.union([
  z.strictObject({ mode: z.literal('fixture').optional(), executor: callable.optional(), answerEngine: z.literal('openclaw').optional(),
    feedbackCapacity: z.number().int().min(1).max(64).optional(),
    executionTimeoutMs: z.number().int().min(1000).max(60000).optional() }).refine((o) => !o.answerEngine || !!o.executor),
  z.strictObject({ mode: z.literal('licensed'), retention: licensedRetentionSchema, admittedReviewer: z.enum(['accepted', 'new']),
    transport: z.custom<TransportConfig>(), budgetDirectory: z.string().min(1),
    inference: z.strictObject({ mode: z.enum(['provider-accounted', 'owned-test']), maxOutputTokens: z.number().int().positive().max(2000),
      approvedGroundingPolicyId: z.string().optional(), countInputTokens: callable, generate: callable }),
    budget: z.strictObject({ sessionCapMicros: z.string(), runCapMicros: z.string(), prices: z.record(z.string(), z.string()),
      pricingExpiresAt: z.string(), now: callable.optional(), sleep: callable.optional() }) }),
]);
const operationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
function observeIndexes(discovery: RankedDiscoveryResult, origins: Record<'A' | 'B', string>): ExperimentObservation {
  const indexes = Object.fromEntries((['A', 'B'] as const).map((name) => {
    const origin = origins[name], observed = discovery.origins.find((item) => item.observerOrigin === origin);
    const candidates = discovery.candidates.filter((item) => item.observerOrigin === origin);
    return [name, { status: observed?.status ?? 'unavailable',
      verified: candidates.filter((item) => item.status === 'verified').length,
      rejected: candidates.filter((item) => item.status === 'rejected').length,
      unavailable: candidates.filter((item) => item.status === 'unavailable').length,
      alteredNames: [...new Set(candidates.filter((item) => item.status === 'rejected' && item.observedName)
        .map((item) => item.observedName!))],
      reasons: [...new Set(candidates.filter((item) => item.status !== 'verified').map((item) => item.reason))] }];
  })) as Record<'A' | 'B', IndexObservation>;
  return { city: discovery.city, status: discovery.status, indexes, services: discovery.selected.map((item) => item.service) };
}
const otherActions = [
  z.strictObject({ kind: z.literal('refresh'), city: z.enum(['Chicago', 'Boston']) }),
  z.strictObject({ kind: z.literal('retry'), invocationId: operationIdSchema }),
  z.strictObject({ kind: z.literal('feedback'), invocationId: operationIdSchema, value: z.number().int().min(1).max(5) }),
  z.strictObject({ kind: z.literal('retry-feedback'), feedbackId: operationIdSchema }),
  z.strictObject({ kind: z.literal('index'), index: z.enum(['A', 'B']), state: z.enum(['stop', 'start', 'restart', 'tamper']),
    city: z.enum(['Chicago', 'Boston']).optional() }),
  z.strictObject({ kind: z.literal('stop-providers') }),
  z.strictObject({ kind: z.literal('fresh-consumer') }),
  z.strictObject({ kind: z.literal('origin-comparison') }),
  z.strictObject({ kind: z.literal('recover'), operatorId: z.enum(['operator-1', 'operator-2', 'operator-3']) }),
] as const;
const fixtureActionSchema = z.discriminatedUnion('kind', [...otherActions,
  z.strictObject({ kind: z.literal('invoke'), reviewer: z.enum(['accepted', 'new']), fail: z.boolean().optional() })]);
const openclawActionSchema = z.discriminatedUnion('kind', [...otherActions,
  z.strictObject({ kind: z.literal('invoke'), reviewer: z.enum(['accepted', 'new']), fail: z.boolean().optional(), input: eveningPlanInputSchema.optional() })]);
const licensedActionSchema = z.discriminatedUnion('kind', [...otherActions,
  z.strictObject({ kind: z.literal('invoke'), reviewer: z.enum(['accepted', 'new']), input: eveningPlanInputSchema })]);

type PrivateInvocation = { view: SessionInvocation; request: SignedEnvelope; params: unknown; url: string; city: City;
  candidate: DiscoveredCandidate; cardBytes: Uint8Array; evidence?: JourneyEvidence; retained?: RetainedJourney };
type PrivateFeedback = { view: SessionFeedback; prepared?: PreparedFeedbackPublication; document: Uint8Array;
  invocation: PrivateInvocation; bundlePath: string; submitted?: FeedbackSubmissionResult };
function sameIdentity(a: { chainId: number; registry: string; agentId: string }, b: typeof a) {
  return a.chainId === b.chainId && a.registry.toLowerCase() === b.registry.toLowerCase() && a.agentId === b.agentId;
}

export function demoEveningInput(city: City): EveningPlanInput {
  return { version: '0.1', capability: 'evening-plan', city,
    timeWindow: { start: city === 'Chicago' ? '2026-10-02T18:00:00-05:00' : '2026-10-02T18:00:00-04:00',
      end: city === 'Chicago' ? '2026-10-02T22:00:00-05:00' : '2026-10-02T22:00:00-04:00', timeZone: city === 'Chicago' ? 'America/Chicago' : 'America/New_York' },
    area: city === 'Chicago' ? 'The Loop' : 'Back Bay', budget: { currency: 'USD', minorUnits: '15000' },
    transport: ['walk', 'public-transit'], preferences: ['Interactive fixture example', 'Plan for two people'] };
}

/** Callback receives a status reader immediately, before chain/Index acquisition. */
export async function withDemoSession<T>(indexCheckout: string, run: (session: DemoSession) => Promise<T>,
  supplied: SessionOptions = {}): Promise<T> {
  const options = optionsSchema.parse(supplied) as SessionOptions;
  const mode = options.mode ?? 'fixture';
  const feedbackCapacity = options.mode === 'licensed' ? SESSION_FEEDBACK_CAPACITY : options.feedbackCapacity ?? SESSION_FEEDBACK_CAPACITY;
  let ledger: LiveBudget | undefined; let fixtureOptions: SessionFixtureOptions;
  if (options.mode === 'licensed') {
    if (Date.parse(options.retention.expiresAt) <= Date.now()) throw new Error('licensed policy expired');
    const adapters = new LiveAdapters(new LiveTransport(options.transport), options.retention);
    ledger = await LiveBudget.open(options.budgetDirectory, options.budget);
    try {
      const backend = new LiveAnswerBackend({ ledger, adapters, inference: options.inference });
      fixtureOptions = { mode: 'licensed', retention: options.retention, admittedReviewer: options.admittedReviewer,
        executor: ({ city, emphasis }) => backend.forScope({ city, emphasis }) };
    } catch (error) { await ledger.close(); throw error; }
  } else fixtureOptions = options;
  let generation = 0; let fixture: SessionFixture | undefined; let abort: AbortController;
  let finished: Promise<void>; let acquired: Promise<void>; let release: () => void;
  let runInOwnedScope: ReturnType<typeof AsyncLocalStorage.snapshot>;
  const initial = (): SessionView => ({ mode, ...(options.mode !== 'licensed' && options.answerEngine ? { answerEngine: options.answerEngine } : {}), ...(options.mode === 'licensed' ? { licensedHint: { admittedReviewer: options.admittedReviewer, expiresAt: options.retention.expiresAt } } : {}),
    freshConsumer: null, originComparison: null, generation, status: 'starting', lifecycleOperationId: randomUUID(), operators: [], crossOperatorWrite: 'not-tested',
    invocations: [], discovery: null, selection: null, operations: [], feedback: [], indexControls: { A: 'online', B: 'online' },
    indexRead: null, experiment: null, recoveryCheck: null,
    feedbackCapacity: { total: feedbackCapacity, used: 0, exhausted: false }, limitations: [
      mode === 'fixture' ? 'Synthetic fixture answers, three simulated operators and generated 1-of-2 EOA Safes on one host; not independent custody or real city facts.' :
        'Source-backed licensed mode with three simulated operators and generated 1-of-2 EOA Safes on one host. Owned-test inference is not live utility, terms clearance or independent custody.',
      ...(options.mode !== 'licensed' && options.answerEngine === 'openclaw' ? [
        'Real subscription-backed OpenClaw reasoning selects from authored fictional options. Model text is opinion, not verified source data or service quality. Synthetic prompts/answers remain in the dedicated OpenClaw volume; City reset does not erase them.',
        'The model bridge bounds prompt/output bytes, run count and duration. Token usage is reported after dispatch, not an exact preflight or dollar spend guarantee. Failed inference has no canned-answer fallback.' ] : []),
      'The disclosed demo reviewer and curator are local policy inputs, not a public quality endorsement. New reviewers remain unweighted.',
      'RPC-derived canonical observations are not state proofs, finality, complete history, or atomic protection against changes after pre-send checks.',
      'Cancelling owned wallet work stops its process and reads, not an already submitted transaction. Interrupted chain effects remain unresolved without canonical read-back.',
      'Historical interaction checks remain observations at their recorded basis. Rotation qualifications come from fresh retained-evidence reads, not rewritten old results.',
      'No Town admission is supplied by this fixture; Town observations elsewhere retain their exact tested scope and are not quality badges.',
      'The resilience action stops A2A endpoints only. Fresh reconstruction after Index restart still requires the separate current AgentCard host and owned RPC; it is not offline verification or total provider disappearance.',
      'Private requests and supporting bundles stay in the owned server directory; reset destroys this ephemeral generation and awaits its cleanup.' ] });
  let state = initial(); let queue = Promise.resolve();
  let resetting: Promise<void> | undefined; let closing: Promise<void> | undefined;
  const operations = new Map<string, { action: string; view: SessionOperation; done: Promise<void> }>();
  const indexExperiments = new Map<string, IndexExperiment>();
  const recoveryChecks = new Map<string, RecoveryCheck>();
  const invocations = new Map<string, PrivateInvocation>();
  // Private historical checkpoint; state.discovery separately gates current selection and fresh-consumer actions.
  let raw: RankingEvidenceInput | undefined;
  const feedback = new Map<string, PrivateFeedback>();
  const retainedOrder = new Map<string, RetainedJourney>();
  const clearContent = () => { for (const holder of retainedOrder.values()) holder.close(); retainedOrder.clear(); };
  const licensedTerminal = (entry: PrivateInvocation): boolean => {
    const retained = entry.retained, report = retained?.report;
    if (!retained?.evidence.completion || !report?.completion) return false;
    const stages = [report.request, report.acceptance, report.completion];
    return stages.every((stage) => stage?.cryptography === 'valid' && stage.signerBinding === 'matched' && stage.profileBasis === 'matched' &&
      stage.claimedTime === 'observed' && stage.link !== 'mismatched') &&
      ((report.execution === 'completed' && report.completion.terminalOutcome === 'completed') ||
        (report.execution === 'failed' && ['failed', 'expired'].includes(report.completion.terminalOutcome ?? '')));
  };
  const launch = () => {
    abort = new AbortController(); let ready!: () => void; let failed!: (error: unknown) => void;
    acquired = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    void acquired.catch(() => undefined);
    const held = new Promise<void>((resolve) => { release = resolve; });
    finished = withSessionFixture(indexCheckout, abort.signal, async (owned) => {
      fixture = owned;
      // Actions are requested outside acquisition's continuation. Re-enter its
      // scope so nested reads and actions share the fixture's OS-signal owner.
      runInOwnedScope = AsyncLocalStorage.snapshot();
      state.operators = owned.operators.map((operator) => ({ id: operator.id, label: operator.label, safe: operator.report.safe,
        services: operator.report.services.map((service) => ({ city: service.city, agentId: service.agentId!, status: service.status })) }));
      const cancelled = () => {
        state.status = 'resetting'; clearContent();
        abort.abort(owned.indexes.lifecycle.signal.reason); release();
      };
      owned.indexes.lifecycle.signal.addEventListener('abort', cancelled, { once: true });
      state.crossOperatorWrite = owned.crossOperatorWrite; state.status = 'ready'; ready();
      try { await held; await queue; }
      finally { owned.indexes.lifecycle.signal.removeEventListener('abort', cancelled); }
    }, fixtureOptions).catch((error: unknown) => {
      failed(new Error('session acquisition unavailable'));
      if (error !== abort.signal.reason) { state.status = 'failed'; throw new Error('session resource acquisition or cleanup failed'); }
    });
    void finished.catch(() => undefined);
  };
  const requireFixture = () => { if (!fixture || state.status !== 'ready') throw new Error('session not ready'); return fixture; };
  const clients = (owned: SessionFixture) => createPublicClient({ cacheTime: 0, transport: http(owned.rpcOrigin,
    { retryCount: 0, timeout: 5000, fetchFn: boundRpcFetch(ownedFetch) }) });
  const refresh = async (city: City, signal: AbortSignal) => {
    const owned = requireFixture(); state.selection = null;
    const block = await owned.chain.getBlock();
    const reviewer = owned.callers.accepted.address.toLowerCase();
    const input: RankingEvidenceInput = { rpcOrigin: owned.rpcOrigin, cardOrigin: owned.cardOrigin, identityDomain: owned.domain,
      provenance: owned.feedback.provenance, observation: { blockNumber: block.number, blockHash: block.hash },
      indexes: [{ origin: owned.origins.A, source: owned.feedback.source }, { origin: owned.origins.B, source: owned.feedback.source }],
      policy: { id: 'session-demo-reviewer-policy', version: '0.1', reviewers: [reviewer],
        groups: [{ key: 'disclosed-demo-reviewer', reviewers: [reviewer] }], curators: ['session-demo-curator'], evaluators: [] },
      scope: { city, task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' }, services: [],
      privateBundleFiles: [...new Map([...feedback.values()].map((entry) => [entry.view.documentHash, { documentHash: entry.view.documentHash, path: entry.bundlePath }])).values()],
      curatorInclusions: owned.services.map(({ agent }) => ({ curator: 'session-demo-curator', agent })) };
    const { services: _services, ...discoveryInput } = input;
    const discovery = await discoverRanked({ ...discoveryInput, city, signal }); signal.throwIfAborted();
    raw = { ...input, services: discovery.selected.map(({ agent }) => ({ agent })),
      curatorInclusions: (input.curatorInclusions ?? []).filter(({ agent }) => discovery.selected.some((candidate) => sameIdentity(candidate.agent, agent))) };
    state.discovery = discovery;
    state.indexRead = observeIndexes(discovery, owned.origins);
    for (const entry of feedback.values()) {
      entry.view.weighting = entry.view.reviewer === 'new' ? 'reviewer-not-accepted' :
        discovery.ranking.policyResult?.candidates.flatMap((candidate) => candidate.reviews)
          .find((review) => review.documentDigest === entry.view.documentHash)?.reason ?? 'not-assessed-at-this-observation';
    }
    return discovery;
  };
  const submit = async (entry: PrivateInvocation, signal: AbortSignal) => {
    const owned = requireFixture(); signal.throwIfAborted();
    const decoded = decodeEnvelope(entry.request).statement.value;
    if (decoded.kind !== 'request') throw new Error('request kind changed');
    if (options.mode === 'licensed' && (Date.parse(decoded.input.timeWindow.start) <= Date.now() ||
        Date.parse(options.retention.expiresAt) <= Date.now())) throw new Error('licensed input or retention expired before send');
    entry.view.sent = true; entry.view.outcome = 'sent';
    try {
      let submitted: Awaited<ReturnType<typeof rpcTask>> | undefined = await rpcTask(entry.url, 'message/send', entry.params, 5000, signal);
      if (entry.view.taskId && entry.view.taskId !== submitted.id) throw new Error('replay changed task identity');
      entry.view.taskId = submitted.id;
      const acceptance = envelopeSchema.parse((submitted.metadata?.['org.nandacity'] as Record<string, unknown>)?.acceptance);
      submitted = undefined;
      entry.view.accepted = true; entry.view.outcome = 'accepted';
      const chain = clients(owned);
      const basisObservation = await readIdentitySnapshot(chain, entry.candidate.agent, BigInt(decoded.profileBasis.blockNumber));
      const currentObservation = await readIdentitySnapshot(chain, entry.candidate.agent);
      let task: Awaited<ReturnType<typeof rpcTask>> | undefined = await pollTerminalTask(entry.url, entry.view.taskId,
        options.mode === 'licensed' ? 65000 : options.executionTimeoutMs !== undefined ? options.executionTimeoutMs + 5000 : 20000,
        options.mode === 'licensed' || options.executionTimeoutMs !== undefined ? 'live' : 'fixture', signal);
      entry.view.outcome = task.status.state === 'completed' ? 'completed' : 'failed';
      let evidence: JourneyEvidence | undefined;
      try {
        const rawCompletion = (task.metadata?.['org.nandacity'] as Record<string, unknown>)?.completion;
        const completion = mode === 'licensed' && rawCompletion === undefined ? undefined : envelopeSchema.parse(rawCompletion);
        const answerBase64 = task.artifacts?.[0]?.parts[0]?.data.answerBase64;
        evidence = { candidate: entry.candidate, cardBase64: Buffer.from(entry.cardBytes).toString('base64'),
          request: entry.request, acceptance, ...(completion ? { completion } : {}), task,
          ...(typeof answerBase64 === 'string' ? { answerBase64 } : {}), basisObservation, currentObservation, observedAt: sessionNow() };
        if (options.mode === 'licensed') {
          // Never install the raw task/base64 response on the invocation, even temporarily.
          entry.retained?.close(); retainedOrder.delete(entry.view.id);
          while (retainedOrder.size >= 4) { const [id, oldest] = retainedOrder.entries().next().value!; oldest.close(); retainedOrder.delete(id); }
          const retained = await retainLicensedJourney(evidence, options.retention,
            (safe, bytes, retention) => verifyJourneyEvidence(safe, clients(owned), owned.domain, filterForCity(entry.city), owned.cardOrigin,
              { retention, ...(bytes ? { answerBytes: bytes } : {}) }, signal), sessionNow);
          try { signal.throwIfAborted(); }
          catch (error) { retained.close(); throw error; }
          entry.retained = retained; entry.evidence = retained.evidence;
          retainedOrder.set(entry.view.id, retained);
          entry.view.checkedResult = retained.earlierByteCheck?.answerBinding === 'mismatched' || retained.report.completion?.answerBinding === 'mismatched' ? 'mismatched' :
            retained.earlierByteCheck?.evidenceUsable || retained.report.evidenceUsable ? 'matched' : 'unavailable';
          if (!licensedTerminal(entry)) entry.view.outcome = 'unresolved';
        } else {
          entry.evidence = evidence;
          const checked = await verifyJourneyEvidence(evidence, clients(owned), owned.domain, filterForCity(entry.city), owned.cardOrigin, undefined, signal);
          signal.throwIfAborted(); entry.view.checkedResult = checked.evidenceUsable ? 'matched' : 'mismatched';
          if (typeof answerBase64 === 'string') entry.view.answer = Buffer.from(answerBase64, 'base64').toString('utf8');
        }
      } finally { evidence = undefined; task = undefined; }
      await writePrivateFile(owned.root, `${entry.view.id}.evidence.json`, Buffer.from(JSON.stringify(entry.evidence)), 1024 * 1024);
    } catch (error) {
      if (!['completed', 'failed'].includes(entry.view.outcome) || (mode === 'licensed' && !licensedTerminal(entry))) entry.view.outcome = 'unresolved';
      if (entry.view.checkedResult === 'not-checked') entry.view.checkedResult = 'unavailable'; throw error;
    }
  };
  const invoke = async (action: Extract<SessionAction, { kind: 'invoke' }>, id: string, signal: AbortSignal) => {
    const owned = requireFixture(); const discovery = state.discovery;
    const chosen = discovery?.selected.find(({ service }) => service === state.selection);
    if (!chosen || !discovery || discovery.ranking.snapshot !== 'matched') throw new Error('select a currently verified candidate');
    const chain = clients(owned); const block = await chain.getBlock();
    if (String(block.number) !== discovery.observation.blockNumber || block.hash !== discovery.observation.blockHash) {
      state.selection = null; throw new Error('selection basis changed; refresh required');
    }
    const search = await searchIndexes([owned.origins.A, owned.origins.B], filterForCity(discovery.city), { signal });
    let selected: { candidate: DiscoveredCandidate; cardBytes: Uint8Array; profile: import('../identity/verify.js').VerifiedProfile } | undefined;
    for (const candidate of search.candidates.filter((item) => sameIdentity(item.agent, chosen.agent))) {
      const cardBytes = await fetchOwnedCard(candidate.declaration.url, owned.cardOrigin, signal);
      const verdict = await verifyDiscoveryAtCurrentChain(candidate, chain, owned.domain, cardBytes, filterForCity(discovery.city));
      if (verdict.status === 'verified' && verdict.profile.source.blockHash === chosen.profile.blockHash &&
          verdict.profile.source.agentUriDigest === chosen.profile.agentUriDigest && verdict.profile.source.cardDigest === chosen.profile.cardDigest &&
          verdict.profile.card.url === chosen.profile.endpoint) { selected = { candidate, cardBytes, profile: verdict.profile }; break; }
    }
    if (!selected || !owned.services.some((service) => service.server.url === selected!.profile.card.url && sameIdentity(service.agent, chosen.agent))) {
      state.selection = null; throw new Error('selection no longer eligible');
    }
    signal.throwIfAborted(); const profile = selected.profile, source = profile.source, caller = owned.callers[action.reviewer];
    const city = discovery.city, createdAt = sessionNow();
    if (options.mode !== 'licensed' && options.answerEngine === 'openclaw' && action.input && action.input.city !== city) throw new Error('request city differs from discovery');
    if (options.mode === 'licensed' && (!action.input || action.input.city !== city || action.reviewer !== options.admittedReviewer ||
        Date.parse(action.input.timeWindow.start) <= Date.now() || Date.parse(options.retention.expiresAt) <= Date.now())) throw new Error('licensed invocation unavailable');
    const request = await signRequest({ kind: 'request', version: '0.1',
      service: { method: 'erc8004', agent: { ...chosen.agent, registry: chosen.agent.registry.toLowerCase() } },
      caller: { method: 'eip155-eoa', chainId: 31337, address: caller.address.toLowerCase() },
      interactionId: `0x${randomBytes(32).toString('hex')}`, createdAt,
      deadline: new Date(Math.min(Date.parse(createdAt) + 600000, options.mode === 'licensed' ? Date.parse(options.retention.expiresAt) : Infinity)).toISOString().replace('.000Z', 'Z'),
      profileBasis: { blockNumber: source.blockNumber, blockHash: source.blockHash.toLowerCase(), agentOwner: source.agentOwner.toLowerCase(),
        agentUriDigest: source.agentUriDigest.toLowerCase(), registrationDigest: source.registrationDigest.toLowerCase(),
        cardDigest: source.cardDigest.toLowerCase(), receiptSigner: profile.registration['x-nandacity'].receiptSigner.toLowerCase() },
      input: options.mode === 'licensed' ? action.input! : options.answerEngine === 'openclaw' && action.input && !action.fail ? action.input :
        { ...demoEveningInput(city), preferences: [...demoEveningInput(city).preferences,
          ...(action.fail ? ['Trigger provider fault'] : [])] } }, caller);
    const params = { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
      data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] }, configuration: { blocking: false, acceptedOutputModes: ['application/json'] } };
    const entry: PrivateInvocation = { view: { id, service: chosen.service, reviewer: action.reviewer,
      requestDigest: decodeEnvelope(request).statement.digest, sent: false, accepted: false, taskId: null, outcome: 'prepared', checkedResult: 'not-checked', answer: null },
      request, params, url: profile.card.url, city, candidate: selected.candidate, cardBytes: selected.cardBytes };
    await writePrivateFile(owned.root, `${id}.request.json`, Buffer.from(JSON.stringify({ id, request, params, url: entry.url })), 128 * 1024);
    invocations.set(id, entry); state.invocations.push(entry.view); await submit(entry, signal);
  };
  const act = async (action: SessionAction, id: string, signal: AbortSignal) => {
    if (action.kind === 'fresh-consumer') {
      const input = session.frozenInput(), observation = state.discovery!.observation;
      const result = await runFreshRankingConsumer(input, state.discovery!.ranking.policyResult, signal);
      signal.throwIfAborted(); state.freshConsumer = { ...result, observation }; return;
    }
    if (action.kind === 'origin-comparison') {
      state.originComparison = { phase: 'starting' };
      const result = await runOriginComparison({ indexCheckout, signal, onProgress: (phase) => {
        signal.throwIfAborted(); state.originComparison = { phase };
      } });
      signal.throwIfAborted(); state.originComparison = { phase: 'completed', result: { discovery: result.discovery, retained: result.retained,
        freshMatched: JSON.stringify(result.initial.policy) === JSON.stringify(result.fresh.policy), limitations: [...result.limitations,
          'Current TLS authority; selected signed snapshots are not independently proven history.', 'No native Town origin badge and no automatic Ethereum-failure fallback.'] } }; return;
    }
    if (action.kind === 'refresh') return refresh(action.city, signal);
    if (action.kind === 'invoke') return invoke(action, id, signal);
    if (action.kind === 'retry') {
      const entry = invocations.get(action.invocationId); if (!entry) throw new Error('unknown invocation');
      // A verified terminal observation is history, not a liveness probe. Only
      // unresolved work needs another physical replay of its persisted bytes.
      if (['completed', 'failed'].includes(entry.view.outcome) && (entry.view.checkedResult === 'matched' || licensedTerminal(entry))) return;
      return submit(entry, signal);
    }
    if (action.kind === 'feedback') return leaveFeedback(action, id, signal);
    if (action.kind === 'retry-feedback') {
      const entry = feedback.get(action.feedbackId); if (!entry) throw new Error('unknown feedback');
      return publishFeedback(entry, signal);
    }
    const owned = requireFixture(); state.selection = null;
    if (action.kind === 'index') {
      const experiment = indexExperiments.get(id);
      if (experiment) {
        const prior = state.discovery;
        if (!experiment.before && prior && prior.city === action.city) experiment.before = observeIndexes(prior, owned.origins);
        state.experiment = experiment;
      }
      state.discovery = null; state.indexRead = null; state.selection = null;
      // A stopped upstream cannot produce a forged record. Restore it explicitly
      // before routing its reply through the local alteration proxy.
      if (action.state === 'tamper' && state.indexControls.A === 'offline') {
        await owned.index('A', 'restart'); signal.throwIfAborted();
        if (experiment) experiment.note = 'Index A was restored before altering its reply.';
      }
      await owned.index(action.index, action.state); signal.throwIfAborted();
      state.indexControls[action.index] = action.state === 'stop' ? 'offline' : action.state === 'tamper' ? 'altered' : 'online';
      if (!action.city) return;
      if (experiment) experiment.phase = 'discovering';
      await refresh(action.city, signal);
      if (experiment) { experiment.after = state.indexRead; experiment.phase = 'observed'; }
      return;
    }
    if (action.kind === 'recover') {
      const check = recoveryChecks.get(id);
      if (check && !check.city) check.city = state.discovery?.city ?? null;
      if (check) state.recoveryCheck = check;
      // An earlier queued read may have republished its premigration view after
      // start() invalidated it. Clear again at the serialized mutation boundary.
      state.discovery = null; state.indexRead = null; state.selection = null; raw = undefined;
      const operator = state.operators.find((item) => item.id === action.operatorId);
      if (!operator) throw new Error('unknown operator');
      operator.recovery = await owned.recover(action.operatorId, signal); signal.throwIfAborted();
      if (!check?.city) {
        if (check) { check.status = 'unavailable'; check.reason = 'Recovery observed; choose a city for a fresh endpoint comparison.'; }
        return;
      }
      check.status = 'checking'; check.reason = 'Recovery observed; checking the migrated public endpoint.';
      try {
        const fresh = await refresh(check.city, signal);
        const cityId = operator.services.find((service) => service.city === check.city)?.agentId;
        const current = fresh.selected.find((candidate) => candidate.agent.agentId === cityId);
        if (current?.profile.endpoint) { check.status = 'observed'; check.endpoint = current.profile.endpoint;
          check.reason = 'Same city service ID was verified at a fresh local-chain observation with its current public endpoint.'; }
        else { check.status = 'unavailable'; check.reason = 'Recovery observed, but no current verified endpoint was returned for this service.'; }
      } catch (error) {
        signal.throwIfAborted(); state.discovery = null; state.indexRead = null; raw = undefined;
        check.status = 'unavailable'; check.reason = 'Recovery observed, but fresh endpoint verification was unavailable.';
      }
      return;
    }
    if (action.kind !== 'stop-providers') throw new Error('unknown action');
    for (const service of owned.services) { signal.throwIfAborted(); await owned.stopProvider(service.agent); }
  };
  const publishFeedback = async (entry: PrivateFeedback, signal: AbortSignal) => {
    const owned = requireFixture(), chain = clients(owned), source = owned.feedback.source;
    if (!entry.prepared) throw new Error('signed feedback has no prepared transaction; retry is unavailable');
    entry.view.publication = 'unresolved';
    const result = await submitPreparedFeedback({ publicClient: chain, walletClient: owned.feedback.wallets[entry.view.reviewer], prepared: entry.prepared });
    entry.submitted = result; entry.view.publication = 'observed'; entry.view.transactionHash = result.receipt.transactionHash;
    const observation = await chain.getBlock();
    const read = await readFeedbackPublication({ client: clients(owned), domain: { chainId: 31337, genesisHash: source.genesisHash as Hex,
      identityRegistry: source.identityRegistry as Hex, reputationRegistry: source.reputationRegistry as Hex },
      eventRef: { ...result.event, feedbackURI: entry.prepared.allowedDocumentURL }, documentBytes: entry.document, observationBlock: observation.number });
    signal.throwIfAborted(); entry.view.readBack = read.publication;
    const receipt = await chain.getTransactionReceipt({ hash: result.event.transactionHash });
    const block = await chain.getBlock({ blockNumber: BigInt(result.event.blockNumber) });
    const log = receipt.logs.find((item) => item.logIndex === result.event.logIndex);
    if (!log || log.logIndex === null || log.transactionIndex === null) throw new Error('feedback event absent');
    const eventId = feedbackEventId(source, { block: { number: String(block.number), hash: block.hash, timestamp: Number(block.timestamp) },
      transactionHash: log.transactionHash, transactionIndex: String(log.transactionIndex), logIndex: String(log.logIndex),
      address: log.address, topics: log.topics, data: log.data });
    for (const index of ['A', 'B'] as const) {
      const deadline = performance.now() + 30000;
      do {
        signal.throwIfAborted();
        try {
          const retained = await readIndexFeedback({ origin: owned.origins[index], source, agentId: result.event.agentId,
            reviewer: result.event.reviewer, eventId, documentHash: entry.view.documentHash, signal });
          entry.view.retained[index] = retained.documentBytes !== null && Buffer.from(retained.documentBytes).equals(Buffer.from(entry.document));
          if (entry.view.retained[index]) break;
        } catch { signal.throwIfAborted(); }
        await delay(100, undefined, { signal });
      } while (performance.now() < deadline);
    }
    await refresh(entry.invocation.city, signal);
  };
  const leaveFeedback = async (action: Extract<SessionAction, { kind: 'feedback' }>, id: string, signal: AbortSignal) => {
    const owned = requireFixture(), invocation = invocations.get(action.invocationId), evidence = invocation?.evidence;
    if (!invocation || !evidence?.completion || (mode === 'licensed' ? !licensedTerminal(invocation) || invocation.view.checkedResult === 'mismatched' : invocation.view.checkedResult !== 'matched') || !Number.isInteger(action.value) || action.value < 1 || action.value > 5) {
      throw new Error('feedback requires checked interaction and a 1 to 5 rating');
    }
    if (state.feedbackCapacity.exhausted) throw new Error('immutable feedback slot capacity exhausted');
    const slot = state.feedbackCapacity.used++;
    state.feedbackCapacity.exhausted = state.feedbackCapacity.used === feedbackCapacity;
    const bundle = encodeSupportingBundle({ version: '0.1', request: evidence.request, acceptance: evidence.acceptance,
      completion: evidence.completion, cardBase64: evidence.cardBase64 });
    const request = decodeEnvelope(evidence.request).statement, acceptance = decodeEnvelope(evidence.acceptance).statement,
      completion = decodeEnvelope(evidence.completion).statement;
    if (request.value.kind !== 'request') throw new Error('interaction request unavailable');
    const document = encodeFeedbackDocument(await signFeedback({ kind: 'feedback', version: '0.2',
      service: request.value.service, reviewer: request.value.caller, interactionId: request.value.interactionId,
      requestDigest: request.digest, acceptanceDigest: acceptance.digest, supportingBundleDigest: keccak256(bundle.bytes),
      reputationRegistry: { chainId: 31337, address: owned.feedback.source.reputationRegistry.toLowerCase() },
      rubric: 'evening-plan-usefulness-v0.1', value: action.value, createdAt: sessionNow(),
      result: { kind: 'completion', completionDigest: completion.digest } }, owned.callers[invocation.view.reviewer]));
    const url = owned.feedback.urls[slot]!; const path = new URL(url).pathname;
    if (owned.feedback.documents.has(path)) throw new Error('immutable feedback slot already occupied');
    const entry: PrivateFeedback = { view: { id, invocationId: action.invocationId, value: action.value, reviewer: invocation.view.reviewer, slot,
      documentHash: document.documentHash, signed: true, publication: 'not-prepared', transactionHash: null, readBack: 'not-read',
      retained: { A: false, B: false }, weighting: 'not-assessed-at-this-observation', policyId: 'session-demo-reviewer-policy' },
      document: document.bytes, invocation, bundlePath: join(owned.root, `${id}.bundle.json`) };
    feedback.set(id, entry); state.feedback.push(entry.view);
    await writePrivateFile(owned.root, `${id}.bundle.json`, bundle.bytes, 128 * 1024);
    await writePrivateFile(owned.root, `${id}.feedback.json`, document.bytes, 8192);
    owned.feedback.documents.set(path, document.bytes);
    const prepared = await prepareLocalFeedbackPublication({ publicClient: clients(owned), walletClient: owned.feedback.wallets[invocation.view.reviewer],
      identityRegistry: owned.domain.registry, reputationRegistry: owned.feedback.source.reputationRegistry as Hex,
      document: document.bytes, feedbackURI: url, allowedDocumentURL: url,
      originalProfile: { agent: evidence.candidate.agent, agentURI: evidence.candidate.agentURI, cardBytes: invocation.cardBytes },
      request: evidence.request, acceptance: evidence.acceptance, completion: evidence.completion });
    await writePrivateFile(owned.root, `${id}.publication.json`, Buffer.from(JSON.stringify(prepared)), 128 * 1024);
    entry.prepared = prepared; entry.view.publication = 'not-sent'; signal.throwIfAborted(); await publishFeedback(entry, signal);
  };
  const stop = async () => {
    abort.abort(new Error('session reset')); clearContent();
    try { await queue; release(); await finished; }
    finally { clearContent(); await ledger?.settled(); fixture = undefined; operations.clear(); invocations.clear(); feedback.clear();
      indexExperiments.clear(); recoveryChecks.clear(); raw = undefined; }
  };
  const session: DemoSession = {
    view: () => {
      const view = structuredClone(state);
      for (const item of view.invocations) {
        const retained = invocations.get(item.id)?.retained;
        if (retained) item.receipt = projectReceiptSummary(retained.evidence, retained.report, retained.retention, sessionNow(),
          state.status === 'ready' && retained.content().contentAvailability === 'available', retained.earlierByteCheck);
      }
      return view;
    }, ready: () => acquired,
    readContent: (id, requestedGeneration) => state.status === 'ready' && requestedGeneration === generation ? invocations.get(id)?.retained?.readContent() : undefined,
    select: (service) => {
      requireFixture();
      if (state.operations.some((operation) => ['running', 'queued'].includes(operation.state))) throw new Error('selection unavailable while a mutation is running');
      if (!state.discovery?.selected.some((candidate) => candidate.service === service)) throw new Error('identity not returned by discovery');
      state.selection = service;
    },
    start: (input, id = randomUUID()) => {
      requireFixture(); if (!operationIdSchema.safeParse(id).success) throw new Error('invalid operation identity');
      const action = (mode === 'licensed' ? licensedActionSchema : options.mode !== 'licensed' && options.answerEngine === 'openclaw' ? openclawActionSchema : fixtureActionSchema).parse(input) as SessionAction;
      if (action.kind === 'index' && action.index === 'B' && action.state === 'tamper') throw new Error('only Index A has an owned alteration proxy');
      const encoded = JSON.stringify(action), old = operations.get(id);
      if (old) { if (old.action !== encoded) throw new Error('operation identity conflict'); return structuredClone(old.view); }
      if (options.mode === 'licensed' && action.kind === 'invoke' && (action.reviewer !== options.admittedReviewer ||
          !state.selection || action.input?.city !== state.discovery?.city || Date.parse(action.input!.timeWindow.start) <= Date.now() ||
          Date.parse(options.retention.expiresAt) <= Date.now())) throw new Error('licensed invocation unavailable');
      if (action.kind === 'index') {
        const before = action.city && state.discovery?.city === action.city && fixture ? observeIndexes(state.discovery, fixture.origins) : null;
        state.discovery = null; state.indexRead = null; state.selection = null;
        state.experiment = action.city ? { target: action.index, action: action.state, city: action.city,
          phase: 'applying', before, after: null, note: before ? 'Comparing the same city before and after this control.' : 'No prior comparison for this city.' } : null;
        if (state.experiment) indexExperiments.set(id, state.experiment);
      }
      if (action.kind === 'recover') {
        const check: RecoveryCheck = { operatorId: action.operatorId, city: state.discovery?.city ?? null,
          status: 'recovering', endpoint: null, reason: 'Prior discovery invalidated; wallet recovery has not yet been observed.' };
        recoveryChecks.set(id, check); state.recoveryCheck = check;
        state.discovery = null; state.indexRead = null; state.selection = null; raw = undefined;
      }
      const view: SessionOperation = { id, generation, kind: action.kind, state: state.operations.some((item) => item.state === 'running') ? 'queued' : 'running' };
      const signal = abort.signal; state.operations.push(view);
      const done = queue.then(async () => {
        signal.throwIfAborted(); view.state = 'running';
        await runInOwnedScope(() => withOwnedLifecycle(() => act(action, id, signal), signal)); view.state = 'completed';
      }).catch(() => {
        view.state = signal.aborted ? 'cancelled' : 'failed';
        if (action.kind === 'index') {
          const experiment = indexExperiments.get(id), effectKnown = experiment?.phase === 'discovering';
          view.error = signal.aborted ? `Index ${action.index} ${action.state} cancelled; outcome may be unknown` :
            effectKnown ? `Index ${action.index} control changed, but fresh discovery was unavailable` :
              `Index ${action.index} ${action.state} did not complete; outcome unknown`;
          if (state.generation === view.generation) {
            if (!effectKnown) state.indexControls[action.index] = 'unknown';
            if (experiment) { experiment.phase = signal.aborted ? 'cancelled' : 'failed'; experiment.note = view.error; state.experiment = experiment; }
          }
        } else if (action.kind === 'recover') {
          const check = recoveryChecks.get(id);
          view.error = signal.aborted ? 'Recovery cancelled; wallet outcome may be unknown' : 'Recovery did not complete; wallet outcome unknown';
          if (check && state.generation === view.generation) { check.status = signal.aborted ? 'cancelled' : 'unavailable'; check.reason = view.error; state.recoveryCheck = check; }
        } else view.error = signal.aborted ? 'session cancelled' : 'action unavailable or precondition changed';
      });
      queue = done; operations.set(id, { action: encoded, view, done }); return structuredClone(view);
    },
    wait: async (id) => { const operation = operations.get(id); if (!operation) throw new Error('unknown operation'); await operation.done; return structuredClone(operation.view); },
    frozenInput: () => { const owned = requireFixture(); if (!raw) throw new Error('no frozen observation'); return structuredClone({ ...raw,
      indexes: [{ origin: owned.origins.A, source: owned.feedback.source }, { origin: owned.origins.B, source: owned.feedback.source }] }); },
    reset: () => {
      if (closing || state.status === 'closed') return Promise.reject(new Error('session is closing'));
      if (resetting) return resetting;
      state.status = 'resetting'; state.lifecycleOperationId = randomUUID();
      resetting = (async () => { await stop(); generation++; state = initial(); launch(); })()
        .finally(() => { resetting = undefined; });
      return resetting;
    },
    close: () => {
      if (closing) return closing;
      // Fence the synchronous read/start capabilities before the first await.
      if (state.status !== 'closed') { state.status = 'resetting'; state.lifecycleOperationId = randomUUID(); clearContent(); }
      closing = (async () => {
        try { await resetting; if (state.status === 'closed') return; state.status = 'resetting'; state.lifecycleOperationId = randomUUID(); await stop();
          state.invocations = []; state.feedback = []; state.operations = []; state.status = 'closed'; }
        finally { await ledger?.settled(); await ledger?.close(); }
      })();
      return closing;
    },
  };
  launch();
  try { return await run(session); } finally { await session.close(); }
}
