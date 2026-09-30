import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionView } from '../../src/demo/sessionController.js';
import { renderSessionView } from '../../src/report/sessionView.js';
import { syntheticEveningPlan } from '../../src/a2a/answer.js';

test('OpenClaw rehearsal clearly separates real model choice from authored city facts and escapes opinions', () => {
  const view = emptyView(); view.answerEngine = 'openclaw';
  view.invocations = [{ id: 'ai', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'completed', checkedResult: 'matched', answer: JSON.stringify({
      kind: 'synthetic-evening-plan', rationale: 'Authored option', schedule: [{ role: 'dinner', place: 'Fictional dinner', detail: 'Demo' }, { role: 'activity', place: 'Fictional activity', detail: 'Demo' }],
      route: { from: 'Dinner', to: 'Activity', mode: 'walk', detail: 'Conceptual route' },
      budget: { currency: 'USD', requestedMinorUnits: '8500', allocations: { dinner: 2100, activity: 0, transport: 0 }, estimatedTotalMinorUnits: 2100 },
      sources: [], unmetConstraints: ['Not live checked'], retrievalAsOf: 'fixture',
      modelSynthesis: { text: '<script>bad()</script>', tradeoffs: ['Simple dinner'], uncertainties: ['Hours unknown'], specialist: 'food',
        provider: 'openai', model: 'gpt-6-luna', usage: { input: 7500, output: 120, cacheRead: 0, total: 7620 } } }) }];
  const html = renderSessionView(view, active);
  assert.match(html, /Real OpenClaw reasoning/); assert.match(html, /Model opinion/);
  assert.match(html, /Authored fixture/); assert.match(html, /reported after dispatch/);
  assert.match(html, /&lt;script&gt;bad/); assert.equal(html.includes('<script>bad'), false);
});

export function emptyView(): SessionView {
  return { mode: 'fixture', generation: 0, status: 'ready', lifecycleOperationId: 'life', operators: [],
    crossOperatorWrite: 'not-tested', invocations: [], discovery: null, selection: null, operations: [], feedback: [],
    freshConsumer: null, originComparison: null, feedbackCapacity: { total: 16, used: 0, exhausted: false }, limitations: [] };
}
test('session page tells a safe story and saved exports omit active forms and tokens', async () => {
  const api = await import('../../src/report/sessionView.js').catch(() => undefined);
  assert.ok(api?.renderSessionView, 'SSR session view must exist');
  const view = emptyView(); view.operators = [{ id: 'operator-1', label: '<img src=x onerror=alert(1)>', safe: '0x123', services: [] }];
  const html = api.renderSessionView(view, { token: 'ACTION-SECRET', nonce: 'nonce' });
  assert.ok(html.includes('Chicago') && html.includes('Boston')); assert.ok(html.includes('&lt;img'));
  assert.equal(html.includes('<img'), false); assert.ok(html.includes('ACTION-SECRET'));
  const saved = api.renderSessionView(view);
  assert.equal(saved.includes('ACTION-SECRET'), false); assert.equal(saved.includes('<form'), false);
  assert.equal(saved.includes('<script'), false); assert.ok(saved.includes('Saved snapshot'));
});

function discoveredView(snapshot: 'unavailable' | 'changed'): SessionView {
  const view = emptyView();
  view.operators = [{ id: 'operator-1', label: 'Operator 1', safe: '0x123', services: [{ city: 'Chicago', agentId: '7', status: 'ready' }] }];
  // The renderer consumes this public shortlist and snapshot condition; no reader or provider is mocked.
  view.discovery = { city: 'Chicago', status: 'complete', observation: { blockNumber: '4', blockHash: '0x00' },
    selected: [{ agent: { agentId: '7' }, service: 'service-7' }], eligibleCount: 1,
    ranking: { snapshot, policyResult: null, diagnostics: [`snapshot-${snapshot}`] } } as unknown as SessionView['discovery'];
  return view;
}
const active = { token: 'test-token', nonce: 'test-nonce' };
const actionForm = (html: string, action: string) => html.match(/<form\b[^]*?<\/form>/g)?.find((form) => form.includes(`name="action" value="${action}"`));

for (const snapshot of ['unavailable', 'changed'] as const) test(`verified discovery with ${snapshot} ranking is not absent and cannot invite invocation`, () => {
  const view = discoveredView(snapshot);
  let html = renderSessionView(view, active);
  assert.ok(html.includes(snapshot === 'changed' ? 'Ranking observation changed' : 'Ranking unavailable'));
  assert.ok(html.includes('Compare this city again'));
  assert.equal(html.includes('Missing from verified discovery'), false);
  assert.equal(html.includes('No verified candidate at this observation.'), false);
  assert.match(actionForm(html, 'select')!, /<button disabled>/);
  assert.equal(actionForm(html, 'invoke'), undefined);
  view.selection = 'service-7'; html = renderSessionView(view, active);
  assert.match(actionForm(html, 'invoke')!, /<button disabled>/);
  assert.match(actionForm(html, 'invoke-failure')!, /<button disabled>/);
});

test('no discovery and a genuinely absent candidate remain distinct', () => {
  const view = discoveredView('unavailable'); view.discovery = { ...view.discovery!, selected: [], eligibleCount: 0 };
  let html = renderSessionView(view, active);
  assert.ok(html.includes('Missing from verified discovery'));
  assert.ok(html.includes('No verified candidate at this observation.'));
  assert.equal(actionForm(html, 'select'), undefined); assert.equal(actionForm(html, 'invoke'), undefined);
  view.discovery = null; html = renderSessionView(view, active);
  assert.ok(html.includes('Choose a city to compare'));
  assert.equal(html.includes('No verified candidate at this observation.'), false);
});

test('licensed transport offers the explicit combined walking and transit option', () => {
  const view = discoveredView('unavailable'); view.mode = 'licensed'; view.selection = 'service-7';
  const html = renderSessionView(view, active);
  assert.match(html, /<option value="walk-and-public-transit">Walking \+ public transit<\/option>/);
});

test('rendered page preserves long frozen identifiers with inherited mobile wrapping', () => {
  const view = discoveredView('unavailable'), hash = `0x${'ab'.repeat(32)}` as const;
  view.discovery = { ...view.discovery!, observation: { blockNumber: '4', blockHash: hash } };
  const html = renderSessionView(view, active);
  assert.ok(html.includes(`Frozen block 4; ${hash}.`), 'do not shorten away the frozen basis');
  // Check the emitted page-level layout contract, not just preformatted evidence.
  // Root owns actual 390px browser scroll-width acceptance.
  const bodyStyle = /(?:^|\})body\{([^}]+)\}/.exec(/<style>([^]*?)<\/style>/.exec(html)![1]!)![1]!;
  assert.match(bodyStyle, /(?:^|;)overflow-wrap:anywhere(?:;|$)/);
});

test('policy score display is bounded to two decimals while evidence preserves the exact fraction', () => {
  const view = discoveredView('unavailable');
  const policyResult: NonNullable<NonNullable<SessionView['discovery']>['ranking']['policyResult']> = {
    algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator',
    policy: { id: 'test-policy', version: '1', reviewers: ['reviewer'], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'test-rubric' },
    observation: { id: 'observation', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
    candidates: [{ service: 'service-7', admitted: true, profileEligible: true, view: 'recommended-rated', qualification: 'qualified',
      profile: { id: 'profile', status: 'valid', endpoint: 'endpoint', cardDigest: null, provenance: 'supplied' },
      history: { id: 'history', status: 'complete', startBlock: '1', start: 'registry-start-confirmed', observation: 'observation', provenance: 'supplied' },
      score: { numerator: '11', denominator: '3' }, provisionalScore: null, groupCount: 1, interactionCount: 1,
      groups: [], warnings: [], historicalOrdering: 'unknown', reviews: [], admissions: [] }], evidence: [],
    selection: { rated: ['service-7'], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] },
  };
  view.discovery = { ...view.discovery!, ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult } };
  const html = renderSessionView(view, active);
  assert.ok(html.includes('3.67 / 5 policy score'));
  assert.equal(html.includes('3.6666666666666665'), false);
  assert.match(html, /<summary>Why this position\?<\/summary><pre>[^]*?&quot;numerator&quot;: &quot;11&quot;[^]*?&quot;denominator&quot;: &quot;3&quot;/);
  assert.deepEqual(policyResult.candidates[0]!.score, { numerator: '11', denominator: '3' }, 'rendering must not mutate scoring evidence');
});

for (const [city, emphasis, dinner, activity, travel, total] of [
  ['Chicago', 'culture', '$24.00', '$33.00', '$5.00', '$62.00'],
  ['Boston', 'travel-value', '$22.00', '$0.00', '$0.00', '$22.00'],
] as const) test(`${city} fixture reads as an evening story with USD costs and disclosed exact evidence`, () => {
  const offset = city === 'Chicago' ? '-05:00' : '-04:00';
  const bytes = syntheticEveningPlan({ input: { version: '0.1', capability: 'evening-plan', city,
    area: city === 'Chicago' ? 'The Loop' : 'Back Bay', budget: { currency: 'USD', minorUnits: '8500' },
    timeWindow: { start: `2026-10-02T18:00:00${offset}`, end: `2026-10-02T22:00:00${offset}`, timeZone: city === 'Chicago' ? 'America/Chicago' : 'America/New_York' },
    transport: ['walk', 'public-transit'], preferences: [] } }, emphasis);
  const raw = new TextDecoder().decode(bytes), view = emptyView();
  view.invocations = [{ id: 'invocation', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'completed', checkedResult: 'matched', answer: raw }];
  const html = renderSessionView(view, active), section = /<section class="answer">([^]*?)<\/section>/.exec(html)![1]!;
  const visible = section.replace(/<details>[^]*?<\/details>/g, '');
  assert.ok(visible.includes('<h5>Dinner · ')); assert.ok(visible.includes('<h5>Evening activity · '));
  assert.ok(visible.includes('<h5>Getting there · ')); assert.ok(visible.includes('<h5>Example budget · USD</h5>'));
  assert.ok(visible.includes(`Dinner ${dinner} · activity ${activity} · travel ${travel}`));
  assert.ok(visible.includes(`Example total: ${total}. Requested budget: $85.00.`));
  assert.ok(visible.includes('Authored fixture · not real city facts'));
  assert.ok(visible.includes('No live opening hours, event inventory, booking availability, or travel time was checked.'));
  assert.ok(visible.includes(`${city} authored conceptual route notes`));
  assert.equal(visible.includes('<dt>'), false, 'raw schema fields are not the primary answer');
  assert.match(section, /<summary>Exact authored fixture evidence<\/summary><pre>[^]*?&quot;requestedMinorUnits&quot;: &quot;8500&quot;/);
  assert.equal(view.invocations[0]!.answer, raw, 'presentation must preserve the original fixture answer');
});
