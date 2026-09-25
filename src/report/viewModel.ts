import { z } from 'zod';

import type { SixServiceJourneyResult } from '../demo/sixServiceJourney.js';
import { decodeEnvelope } from '../interaction/signatures.js';

const text = z.string().max(4096);
const money = z.number().int().safe().nonnegative();
const answerSchema = z.object({
  kind: z.literal('synthetic-evening-plan'), city: z.enum(['Chicago', 'Boston']),
  emphasis: z.enum(['food', 'culture', 'travel-value']), liveDataChecked: z.literal(false),
  area: text, rationale: text, retrievalAsOf: text,
  schedule: z.tuple([
    z.object({ role: z.literal('dinner'), place: text, detail: text }),
    z.object({ role: z.literal('activity'), place: text, detail: text }),
  ]),
  route: z.object({ from: text, to: text, mode: text, detail: text, estimate: text }),
  budget: z.object({ currency: z.literal('USD'), requestedMinorUnits: z.string(),
    estimateOnly: z.literal(true), allocations: z.object({ dinner: money, activity: money,
      transport: money }), estimatedTotalMinorUnits: money }),
  sources: z.array(z.object({ label: text, kind: z.literal('authored-fixture'),
    live: z.literal(false), supports: z.array(text) })).min(1),
  unmetConstraints: z.array(text).min(1),
});

export type ReportChoice = {
  operator: string;
  emphasis: string;
  agentId: string;
  area: string;
  rationale: string;
  schedule: Array<{ role: string; place: string; detail: string }>;
  route: { from: string; to: string; mode: string; detail: string; estimate: string };
  budget: { requested: string; estimatedTotal: string; dinner: string; activity: string;
    transport: string };
  sources: Array<{ label: string; supports: string }>;
  retrievalAsOf: string;
  unmetConstraints: string[];
  verification: string;
  observation: { blockNumber: string; blockHash: string; observedAt: string };
};

export type ReportViewModel = {
  cities: Array<{ name: 'Chicago' | 'Boston'; choices: ReportChoice[] }>;
  fault: { outcome: 'Accepted, then failed'; agentId: string; taskId: string };
  calls: SixServiceJourneyResult['calls'];
  retry: { taskId: string; sameTask: true };
  indexSourceCommit: string;
  limitations: string[];
};

function dollars(minorUnits: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minorUnits / 100);
}

function answerBytes(encoded: string): Buffer {
  if (encoded.length > Math.ceil((256 * 1024) / 3) * 4 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('answer bytes must be bounded canonical Base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 256 * 1024 || bytes.toString('base64') !== encoded) {
    throw new Error('answer bytes must be bounded canonical Base64');
  }
  return bytes;
}

/** Presentation only: consumes the journey's recorded verifier verdicts, never re-verifies offline. */
export function buildReportViewModel(result: SixServiceJourneyResult): ReportViewModel {
  if (result.mode !== 'local-fixture' || !result.independentProcessVerified ||
      !result.tamperRejected || result.cleanup.ownedResourcesStopped !== true) {
    throw new Error('report requires a completed, cleaned-up local fixture journey');
  }
  if (result.alternatives.length !== 6) throw new Error('report requires exactly six alternatives');
  for (const operatorIndex of [0, 1, 2]) {
    const pair = result.alternatives.filter((item) => item.operatorIndex === operatorIndex);
    if (pair.length !== 2 || pair[0]?.ownerAddress.toLowerCase() !== pair[1]?.ownerAddress.toLowerCase()) {
      throw new Error('operator owner must match across the two city services');
    }
  }
  if (new Set(result.alternatives.map((item) => item.ownerAddress.toLowerCase())).size !== 3) {
    throw new Error('report requires three distinct operator owners');
  }
  if (result.retry.sameTask !== true || result.calls.exactRetries !== 1 ||
      result.calls.messageSend !== 8 || result.calls.tasksGet < 7) {
    throw new Error('report call and exact retry counts do not match the six-service journey');
  }
  const seenAgents = new Set<string>();
  const cities = (['Chicago', 'Boston'] as const).map((city) => {
    const items = result.alternatives.filter((item) => item.city === city);
    if (items.length !== 3 || new Set(items.map((item) => item.operatorIndex)).size !== 3 ||
        items.some((item) => ![0, 1, 2].includes(item.operatorIndex))) {
      throw new Error(`${city} requires one choice from each of three operators`);
    }
    const choices = items.sort((a, b) => a.operatorIndex - b.operatorIndex).map((item): ReportChoice => {
      const { evidence, report } = item.success;
      if (seenAgents.has(item.agent.agentId)) throw new Error('agent identity repeats across choices');
      seenAgents.add(item.agent.agentId);
      if (!report.evidenceUsable || report.discovery.status !== 'verified' ||
          report.execution !== 'completed' || report.contentValidation !== 'not-tested' ||
          report.request?.cryptography !== 'valid' || report.acceptance?.cryptography !== 'valid' ||
          report.completion?.cryptography !== 'valid' || report.completion.answerBinding !== 'matched' ||
          report.completion.terminalOutcome !== 'completed') {
        throw new Error('completed alternative lacks usable signed evidence');
      }
      const request = decodeEnvelope(evidence.request).statement.value;
      if (request.kind !== 'request' || request.input.city !== city ||
          request.service.agent.agentId !== item.agent.agentId ||
          request.service.agent.chainId !== item.agent.chainId ||
          request.service.agent.registry.toLowerCase() !== item.agent.registry.toLowerCase()) {
        throw new Error('signed request does not match presented city or agent');
      }
      if (!evidence.answerBase64) throw new Error('completed alternative has no answer bytes');
      const answer = answerSchema.parse(JSON.parse(answerBytes(evidence.answerBase64).toString('utf8')));
      if (answer.city !== city) throw new Error('answer city does not match choice');
      if (answer.emphasis !== item.emphasis) throw new Error('answer emphasis does not match choice');
      if (answer.area !== request.input.area ||
          answer.budget.requestedMinorUnits !== request.input.budget.minorUnits ||
          answer.route.from !== answer.schedule[0].place ||
          answer.route.to !== answer.schedule[1].place ||
          answer.budget.estimatedTotalMinorUnits !== Object.values(answer.budget.allocations)
            .reduce((sum, value) => sum + value, 0)) {
        throw new Error('answer plan does not match signed request, schedule, or cost allocation');
      }
      const labels = { food: 'Food focus', culture: 'Culture focus',
        'travel-value': 'Travel/value focus' } as const;
      return {
        operator: `Fixture operator ${item.operatorIndex + 1}`, emphasis: labels[item.emphasis],
        agentId: item.agent.agentId, area: answer.area, rationale: answer.rationale,
        schedule: answer.schedule.map((stop) => ({ role: stop.role, place: stop.place,
          detail: stop.detail })), route: answer.route,
        budget: { requested: dollars(Number(request.input.budget.minorUnits)),
          estimatedTotal: dollars(answer.budget.estimatedTotalMinorUnits),
          dinner: dollars(answer.budget.allocations.dinner),
          activity: dollars(answer.budget.allocations.activity),
          transport: dollars(answer.budget.allocations.transport) },
        sources: answer.sources.map((source) => ({ label: source.label,
          supports: source.supports.join(', ') })), retrievalAsOf: answer.retrievalAsOf,
        unmetConstraints: answer.unmetConstraints,
        verification: 'Signed completion and answer bytes checked; plan quality not tested',
        observation: { blockNumber: evidence.basisObservation.blockNumber,
          blockHash: evidence.basisObservation.blockHash, observedAt: evidence.observedAt },
      };
    });
    return { name: city, choices };
  });
  if (result.retry.taskId !== result.alternatives[0]?.success.evidence.task.id ||
      result.retry.agent.agentId !== result.alternatives[0]?.agent.agentId) {
    throw new Error('exact retry does not identify the first completed task');
  }
  if (!result.fault.report.evidenceUsable || result.fault.report.execution !== 'failed' ||
      result.fault.report.acceptance?.cryptography !== 'valid' ||
      result.fault.report.completion?.cryptography !== 'valid' ||
      result.fault.report.completion.terminalOutcome !== 'failed' ||
      result.fault.evidence.answerBase64 !== undefined ||
      result.fault.evidence.task.id === result.retry.taskId ||
      result.fault.agent.agentId !== result.alternatives[0]?.agent.agentId ||
      result.fault.agent.chainId !== result.alternatives[0]?.agent.chainId ||
      result.fault.agent.registry.toLowerCase() !== result.alternatives[0]?.agent.registry.toLowerCase()) {
    throw new Error('separate accepted fault agent or evidence does not match');
  }
  return { cities, fault: { outcome: 'Accepted, then failed', agentId: result.fault.agent.agentId,
    taskId: result.fault.evidence.task.id }, calls: result.calls,
    retry: { taskId: result.retry.taskId, sameTask: true },
    indexSourceCommit: result.indexSourceCommit, limitations: result.limitations };
}
