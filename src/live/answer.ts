import { z } from 'zod';
import { eveningPlanInputSchema, type EveningPlanInput } from '../a2a/input.js';
import type { ExecutionContext, RuntimeExecutor } from '../a2a/service.js';
import type { RuntimeRequest } from '../a2a/strategy.js';
import { isUtcSecond } from '../interaction/schema.js';
import { LIVE_LIMITS, LiveBudget, LiveError, failureSchema, safeFailure, cleanupFindingSchema, type LiveFailure } from './budget.js';
import { LiveAdapters, eventFactSchema, transitFactSchema, sourceMetaSchema, placeBundleSchema, utcSecond, proposedDinnerInterval,
  type PlaceBundle, type EventFact, type TransitFact, type SourceResult } from './adapters.js';

const emphasisSchema = z.enum(['food', 'culture', 'travel-value']);
export const liveScopeSchema = z.strictObject({ city: z.enum(['Chicago', 'Boston']), emphasis: emphasisSchema });
export type LiveScope = z.infer<typeof liveScopeSchema>;
export type GenerateInput = { request: EveningPlanInput; emphasis: LiveScope['emphasis']; places: PlaceBundle };
export type Generate = (input: GenerateInput, context: { signal: AbortSignal; maxInputTokens: number; maxOutputTokens: number }) => Promise<{
  groundedBlock: string; selectedPlaceId?: string; synthesis?: string; inputTokens: number; outputTokens: number;
}>;
/** This trusted injection must count the complete model request, including provider wrappers,
 * with the selected provider's tokenizer. Character estimates are not exact token accounting.
 * No concrete provider, tokenizer, credential, or network implementation is supplied here. */
export type Inference = { mode: 'provider-accounted' | 'owned-test'; maxOutputTokens: number;
  /** Owner-approved source/model handling policy, separate from an engineering expiry. */
  approvedGroundingPolicyId?: string;
  countInputTokens: (input: GenerateInput) => number; generate: Generate };
const utc = z.string().refine(isUtcSecond);
const minor = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
const generatedSchema = z.strictObject({ groundedBlock: z.string().max(32_768), selectedPlaceId: z.string().max(256).optional(),
  synthesis: z.string().max(8192).refine((s) => s.isWellFormed()).optional(), inputTokens: z.number().int().nonnegative().max(8000), outputTokens: z.number().int().nonnegative().max(2000) });
export const gapSchema = z.enum(['dated-dinner-hours-unverified', 'dinner-cost-unknown', 'event-unavailable', 'event-end-unknown',
  'event-cost-unknown', 'event-outside-window', 'event-coverage-truncated', 'transit-unavailable', 'transit-fare-unknown',
  'transit-arrives-after-event', 'transport-constraint-unsatisfied', 'budget-fit-unknown', 'known-cost-exceeds-budget',
  'preferences-unverified', 'window-too-short', 'remote-cancellation-unconfirmed']);
const panelStatus = z.enum(['sourced', 'empty', 'unavailable', 'not-requested']);
export const liveAnswerSchema = z.strictObject({ version: z.literal('0.1'), mode: z.literal('source-backed'),
  city: z.enum(['Chicago', 'Boston']), timeWindow: eveningPlanInputSchema.shape.timeWindow,
  emphasis: emphasisSchema, planStatus: z.literal('proposal-with-gaps'),
  grounding: z.strictObject({ block: z.string().max(32_768), places: placeBundleSchema.shape.places,
    links: sourceMetaSchema.shape.links, meta: sourceMetaSchema,
    claim: z.literal('source-generated-grounding-not-verified-hours') }),
  synthesis: z.strictObject({ text: z.string().max(8192), claim: z.literal('provider-synthesis-not-source-fact') }).optional(),
  dinner: z.strictObject({ placeId: z.string(), proposedStart: utc, proposedEnd: utc, hoursConfirmed: z.literal(false) }),
  activity: z.strictObject({ status: panelStatus, fact: eventFactSchema.optional(), meta: sourceMetaSchema.optional(), reason: failureSchema.optional() }),
  transit: z.strictObject({ status: panelStatus, departure: utc, fact: transitFactSchema.optional(), meta: sourceMetaSchema.optional(), reason: failureSchema.optional() }),
  costs: z.strictObject({ currency: z.literal('USD'), dinnerMinor: z.null(), activityMinor: minor.nullable(), transitMinor: minor.nullable(), totalMinor: z.null(),
    budgetFit: z.literal('unknown') }), gaps: z.array(gapSchema).max(30),
  usage: z.strictObject({ physicalAttempts: z.number().int().min(0).max(10), reservedCostMicros: minor,
    inputTokens: z.number().int().max(8000).nonnegative(), outputTokens: z.number().int().max(2000).nonnegative(),
    accounting: z.literal('local-conservative-reservations-not-invoice') }),
  cleanup: cleanupFindingSchema,
});
export type LiveAnswer = z.infer<typeof liveAnswerSchema>;
function stopOnError<T>(result: SourceResult<T>): void {
  if (result.status === 'unavailable' && ['auth', 'quota', 'deadline', 'cancelled', 'budget', 'oversize', 'ambiguous-dispatch'].includes(result.reason)) throw new LiveError(result.reason);
}

/** Shared account configuration; scope changes emphasis only, never the budget, authority or URLs. */
export class LiveAnswerBackend {
  #inference: Inference;
  constructor(private options: { ledger: LiveBudget; adapters: LiveAdapters; inference: Inference }) {
    const inference = options.inference;
    if (!inference || !['provider-accounted', 'owned-test'].includes(inference.mode) || typeof inference.generate !== 'function' || typeof inference.countInputTokens !== 'function' ||
      (options.adapters.transport.mode === 'production' && inference.mode !== 'provider-accounted')) throw new LiveError('not-configured');
    if (options.adapters.transport.mode === 'production' && inference.approvedGroundingPolicyId !== options.adapters.retention.policyId) throw new LiveError('policy-unapproved');
    this.options = { ...options };
    this.#inference = { ...inference };
  }
  forScope(scope: LiveScope): RuntimeExecutor<RuntimeRequest> {
    const validated = liveScopeSchema.parse(scope);
    const execute = (request: RuntimeRequest, context: ExecutionContext) => this.execute(request.input, validated, context, Date.parse(request.deadline));
    return Object.freeze(Object.assign(execute, { retention: this.options.adapters.retention }));
  }
  async execute(supplied: EveningPlanInput, suppliedScope: LiveScope, context: Pick<ExecutionContext, 'taskId' | 'signal'>, deadline?: number): Promise<Uint8Array> {
    const input = eveningPlanInputSchema.parse(supplied), scope = liveScopeSchema.parse(suppliedScope);
    if (input.city !== scope.city || !Number.isSafeInteger(this.#inference.maxOutputTokens) || this.#inference.maxOutputTokens < 1 || this.#inference.maxOutputTokens > LIVE_LIMITS.outputTokens) throw new LiveError('not-configured');
    const sourceExpiry = Date.parse(this.options.adapters.retention.expiresAt);
    const run = await this.options.ledger.begin(context.taskId, context.signal, Math.min(deadline ?? Infinity, sourceExpiry));
    let cleanup: LiveAnswer['cleanup'] | undefined, failureReason: LiveFailure | undefined;
    try {
      const adapters = this.options.adapters;
      const places = await adapters.places(run, input);
      if (places.status !== 'ok') throw new LiveError(places.status === 'unavailable' ? places.reason : 'invalid-response');
      const events = await adapters.events(run, input); stopOnError(events);
      const prompt: GenerateInput = { request: structuredClone(input), emphasis: scope.emphasis, places: structuredClone(places.data) };
      const count = this.#inference.countInputTokens(structuredClone(prompt));
      if (!Number.isSafeInteger(count) || count < 0 || count > LIVE_LIMITS.inputTokens) throw new LiveError('budget');
      if (run.now() >= Date.parse(adapters.retention.expiresAt)) throw new LiveError('policy-unapproved');
      const generated = generatedSchema.parse(await run.dispatch('generate', async (signal) => {
        if (signal.aborted || run.now() >= sourceExpiry) throw new LiveError('policy-unapproved');
        const response = await this.#inference.generate(prompt,
          { signal, maxInputTokens: LIVE_LIMITS.inputTokens, maxOutputTokens: this.#inference.maxOutputTokens });
        const size = Buffer.byteLength(JSON.stringify(response)); run.consumeBytes(size);
        if (size > LIVE_LIMITS.responseBytes) throw new LiveError('oversize');
        return response;
      }));
      if (generated.groundedBlock !== places.data.summary || generated.inputTokens > count || generated.outputTokens > this.#inference.maxOutputTokens ||
        !generated.selectedPlaceId || !places.data.places.some((place) => place.id === generated.selectedPlaceId)) throw new LiveError('invalid-response');
      const { start, end: dinnerEnd } = proposedDinnerInterval(input), end = Date.parse(input.timeWindow.end);
      const gaps: LiveAnswer['gaps'] = ['dated-dinner-hours-unverified', 'dinner-cost-unknown', 'budget-fit-unknown'];
      if (end - start < 3600_000) gaps.push('window-too-short');
      if (input.preferences.length) gaps.push('preferences-unverified');
      const event = events.status === 'ok' ? events.data.find((candidate) => Date.parse(candidate.start) >= dinnerEnd) : undefined;
      if (!event) gaps.push('event-unavailable');
      if (events.status !== 'unavailable' && events.meta.coverage === 'truncated') gaps.push('event-coverage-truncated');
      if (event && !event.end) gaps.push('event-end-unknown');
      if (event?.end && Date.parse(event.end) > end) gaps.push('event-outside-window');
      if (!event?.price) gaps.push('event-cost-unknown');
      let transit: SourceResult<TransitFact> | undefined;
      if (event && input.transport.includes('public-transit') && input.transport.includes('walk')) {
        transit = await adapters.transit(run, { placeId: generated.selectedPlaceId, venueAddress: event.venueAddress, departure: utcSecond(dinnerEnd) });
        stopOnError(transit);
      } else if (!input.transport.includes('public-transit') || !input.transport.includes('walk')) gaps.push('transport-constraint-unsatisfied');
      if (transit?.status !== 'ok') gaps.push('transit-unavailable');
      if (transit?.status === 'ok' && event && dinnerEnd + transit.data.durationSeconds * 1000 > Date.parse(event.start)) gaps.push('transit-arrives-after-event');
      if (transit?.status !== 'ok' || transit.data.fareMinor === undefined) gaps.push('transit-fare-unknown');
      const fare = transit?.status === 'ok' ? transit.data.fareMinor : undefined;
      if (BigInt(event?.price?.minMinor ?? '0') + BigInt(fare ?? '0') > BigInt(input.budget.minorUnits)) gaps.push('known-cost-exceeds-budget');
      cleanup = await adapters.close(run);
      if (cleanup === 'remote-cancellation-unconfirmed') gaps.push('remote-cancellation-unconfirmed');
      const answer = liveAnswerSchema.parse({ version: '0.1', mode: 'source-backed', city: input.city, timeWindow: input.timeWindow, emphasis: scope.emphasis,
        planStatus: 'proposal-with-gaps', grounding: { block: generated.groundedBlock, places: places.data.places, links: places.meta.links, meta: places.meta,
          claim: 'source-generated-grounding-not-verified-hours' },
        ...(generated.synthesis ? { synthesis: { text: generated.synthesis, claim: 'provider-synthesis-not-source-fact' } } : {}),
        dinner: { placeId: generated.selectedPlaceId, proposedStart: utcSecond(start), proposedEnd: utcSecond(dinnerEnd), hoursConfirmed: false },
        activity: panel(events, event), transit: { ...panel(transit, transit?.status === 'ok' ? transit.data : undefined), departure: utcSecond(dinnerEnd) },
        costs: { currency: 'USD', dinnerMinor: null, activityMinor: event?.price?.minMinor ?? null, transitMinor: fare ?? null, totalMinor: null, budgetFit: 'unknown' },
        gaps, usage: { ...run.usage(), inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, accounting: 'local-conservative-reservations-not-invoice' }, cleanup });
      if (run.remaining() <= 0 || run.now() >= Date.parse(adapters.retention.expiresAt)) throw new LiveError('deadline');
      const bytes = Buffer.from(JSON.stringify(answer));
      if (bytes.byteLength > 256 * 1024) throw new LiveError('oversize');
      return bytes;
    } catch (error) {
      failureReason = safeFailure(error);
      throw error;
    } finally {
      cleanup ??= await this.options.adapters.close(run);
      await run.finish(failureReason === undefined ? undefined : { failureReason, cleanup });
    }
  }
}
function panel<T>(result: SourceResult<unknown> | undefined, fact: T | undefined) {
  if (!result) return { status: 'not-requested' as const };
  if (result.status === 'unavailable') return { status: 'unavailable' as const, reason: result.reason };
  return { status: fact ? 'sourced' as const : 'empty' as const, ...(fact ? { fact } : {}), meta: result.meta };
}
