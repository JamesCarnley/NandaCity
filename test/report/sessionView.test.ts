import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { SessionView } from '../../src/demo/sessionController.js';
import { renderSessionView } from '../../src/report/sessionView.js';
import { sessionClient } from '../../src/report/sessionClient.js';
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
    freshConsumer: null, originComparison: null, indexControls: { A: 'online', B: 'online' }, indexRead: null, experiment: null,
    feedbackCapacity: { total: 16, used: 0, exhausted: false }, limitations: [] };
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

test('shared restored Index map separates current state from the last outage observation', () => {
  const view = emptyView(); view.browserIsolation = 'shared-fixture';
  view.indexRead = { city: 'Chicago', status: 'partial', indexes: {
    A: { status: 'unavailable', verified: 0, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
    B: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services: ['a', 'b', 'c'] };
  const html = renderSessionView(view, active);
  const node = /<a class="map-node index-node"[^>]*data-focus-key="index-A"[^>]*>([^]*?)<\/a>/.exec(html)?.[1];
  assert.ok(node);
  assert.match(node, /Current: online/);
  assert.match(node, /Last comparison: unavailable · 0 verified/);
  assert.equal(node.includes('online · unavailable'), false);
  assert.match(html, /data-route-index="A" data-route-state="not-compared"/);
});

test('shared fixture brief and finite feedback and recovery limits are visible beside controls', () => {
  const view = discoveredView('unavailable'); view.browserIsolation = 'shared-fixture';
  view.feedbackCapacity = { total: 8, used: 7, exhausted: false };
  view.operators[0]!.recovery = { qualification: 'same-host-generated-EOA-demo', restoredInFreshProcess: true,
    retiredOwnerRejected: true, report: {} } as unknown as NonNullable<SessionView['operators'][number]['recovery']>;
  const html = renderSessionView(view, active);
  const ask = html.slice(html.indexOf('<section class="task-panel" id="ask"'), html.indexOf('<section class="task-panel" id="review"'));
  const review = html.slice(html.indexOf('<section class="task-panel" id="review"'), html.indexOf('<section class="task-panel" id="resilience"'));
  const ownership = html.slice(html.indexOf('<section class="task-panel" id="ownership"'));
  assert.match(ask, /Fixed authored fixture brief[^]*?two people[^]*?\$150[^]*?not live city data/i);
  assert.match(review, /Shared feedback slots: 1 of 8 remaining/);
  assert.match(review, /Resetting your browser journey does not replenish/);
  assert.match(ownership, /one recovery per operator[^]*?shared across browsers/i);
  assert.match(ownership, /Recovery used for this operator/);
});

test('shared recovery requires this browser to choose a city before its one-shot control is enabled', () => {
  const view = emptyView(); view.browserIsolation = 'shared-fixture';
  view.operators = [{ id: 'operator-1', label: 'Operator 1', safe: '0x123', services: [] }];
  const before = renderSessionView(view, active);
  assert.match(before, /Choose a city in this browser before shared operator recovery/);
  assert.match(actionForm(before, 'recover') ?? '', /<button disabled>Recover &amp; migrate Food first<\/button>/);
  view.discovery = discoveredView('unavailable').discovery;
  const after = renderSessionView(view, active);
  assert.doesNotMatch(actionForm(after, 'recover') ?? '', /<button disabled>/);
});

test('overview is an accessible read-only entry point in the app and saved snapshots', () => {
  for (const options of [active, undefined]) {
    const html = renderSessionView(emptyView(), options);
    assert.match(html, /<main[^>]*data-panel="overview"/);
    const overview = /<section class="task-panel" id="overview"[^>]*>([^]*?)<\/section>/.exec(html)?.[1];
    assert.ok(overview, 'the overview must exist in both the live app and inert exports');
    assert.match(html, /href="#overview" data-panel-link="overview"/);
    assert.match(overview, /<h2[^>]*id="overview-title"/);
    assert.match(overview, /href="#discover" data-panel-link="discover"/);
    assert.equal(overview.includes('<form'), false, 'reading or leaving the introduction cannot queue an operation');
  }
});

for (const hash of ['', '#overview', '#discover', '#review', '#choose']) test(`overview navigation preserves task deep links (${hash || 'first visit'})`, () => {
  const current = { dataset: { panel: 'server-default' }, querySelectorAll: () => [] };
  const listeners = new Map<string, () => void>();
  const location = { href: `http://127.0.0.1:3000/${hash}`, hash };
  let networkCalls = 0;
  const document = { querySelector: () => current, querySelectorAll: () => [], addEventListener() {} };
  const window = { __cityInitialStatus: { generation: 0, status: 'ready', operations: [] },
    addEventListener: (event: string, listener: () => void) => listeners.set(event, listener) };
  runInNewContext(sessionClient, { document, window, location, setInterval() {},
    fetch: () => { networkCalls++; }, Date, Number, String, Event, Map });
  assert.equal(current.dataset.panel, hash === '#choose' ? 'discover' : hash.slice(1) || 'overview');
  location.hash = '#overview'; listeners.get('hashchange')!();
  assert.equal(current.dataset.panel, 'overview');
  location.hash = '#discover'; listeners.get('hashchange')!();
  assert.equal(current.dataset.panel, 'discover');
  assert.equal(networkCalls, 0, 'navigation is local and never starts discovery or a service request');
});

test('completed request leads with the answer and keeps the editable brief behind Ask again', () => {
  const view = discoveredView('unavailable'); view.selection = 'service-7';
  view.invocations = [{ id: 'reply-one', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'failed', checkedResult: 'matched', answer: null }];
  const html = renderSessionView(view, active);
  const ask = html.slice(html.indexOf('<section class="task-panel" id="ask"'), html.indexOf('<section class="task-panel" id="review"'));
  assert.ok(ask.indexOf('Your fixture request') < ask.indexOf('Your evening brief'));
  assert.match(ask, /data-disclosure-key="ask-again"><summary>Ask again or change brief<\/summary>/);
  assert.match(actionForm(ask, 'invoke')!, /name="panel" value="ask"/);
});

test('published review leads with its observed effect and keeps another rating available', () => {
  const view = emptyView();
  view.invocations = [{ id: 'reply-one', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'completed', checkedResult: 'matched', answer: null }];
  view.feedback = [{ id: 'feedback-one', invocationId: 'reply-one', value: 5, reviewer: 'accepted', slot: 0,
    documentHash: `0x${'b'.repeat(64)}`, signed: true, publication: 'observed', transactionHash: null,
    readBack: 'matched', retained: { A: true, B: true }, weighting: 'contributing', policyId: 'session-demo-reviewer-policy' }];
  const html = renderSessionView(view, active);
  const review = html.slice(html.indexOf('<section class="task-panel" id="review"'), html.indexOf('<section class="task-panel" id="resilience"'));
  assert.ok(review.indexOf('feedback-card') < review.indexOf('review-action'));
  assert.match(review, /This review counts toward your policy score/);
  assert.match(review, /data-disclosure-key="review-actions"><summary>Rate another interaction<\/summary>/);
});

test('pending feedback does not claim the ranking refresh has already happened', () => {
  const view = emptyView();
  view.feedback = [{ id: 'pending', invocationId: 'reply-one', value: 5, reviewer: 'accepted', slot: 0,
    documentHash: `0x${'c'.repeat(64)}`, signed: true, publication: 'not-prepared', transactionHash: null,
    readBack: 'not-read', retained: { A: false, B: false }, weighting: 'not-assessed-at-this-observation', policyId: 'session-demo-reviewer-policy' }];
  const html = renderSessionView(view, active);
  assert.equal(html.includes('The ranking was refreshed after publication.'), false);
  assert.match(html, /A successful publication is followed by a fresh ranking check/);
});

test('recovery check tells the actual observed endpoint and stable city IDs', () => {
  const view = discoveredView('unavailable');
  view.operators[0]!.services.push({ city: 'Boston', agentId: '8', status: 'ready' });
  view.recoveryCheck = { operatorId: 'operator-1', city: 'Chicago', status: 'observed',
    endpoint: 'http://127.0.0.1:8123/migrated', reason: 'Fresh endpoint checked.' };
  const html = renderSessionView(view, active);
  const ownership = html.slice(html.indexOf('<section class="task-panel" id="ownership"'));
  assert.match(ownership, /Fresh endpoint checked/);
  assert.match(ownership, /http:\/\/127\.0\.0\.1:8123\/migrated/);
  assert.match(ownership, /Chicago service #7[^]*?Boston service #8/);
  view.operations = [{ id: 'recover', generation: 0, kind: 'recover', state: 'completed' }];
  assert.match(renderSessionView(view, active), /Recovery checked[^]*?Chicago service #7, Boston service #8/);
});

test('network workspace keeps node state and experiment result adjacent to native controls', () => {
  const view = discoveredView('unavailable');
  view.indexControls.A = 'offline';
  view.indexRead = { city: 'Chicago', status: 'partial', indexes: {
    A: { status: 'unavailable', verified: 0, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
    B: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services: ['s1', 's2', 's3'] };
  view.operations = [{ id: 'stop-a', generation: 0, kind: 'index', state: 'completed' }];
  view.discovery = { ...view.discovery!, status: 'partial', selected: [{ ...view.discovery!.selected[0]!, origins: ['http://b.test'] }] };
  view.experiment = { target: 'A', action: 'stop', city: 'Chicago', phase: 'observed', note: 'Compared the same city.',
    before: { city: 'Chicago', status: 'complete', indexes: {
      A: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
      B: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services: ['s1', 's2', 's3'] },
    after: { city: 'Chicago', status: 'partial', indexes: {
      A: { status: 'unavailable', verified: 0, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
      B: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services: ['s1', 's2', 's3'] } };
  const html = renderSessionView(view, active);
  assert.match(html, /class="network-stage"/);
  assert.match(html, /class="inspector"/);
  assert.match(html, /href="#resilience"[^>]*>Experiments/);
  assert.match(html, /href="#ownership"[^>]*>Ownership/);
  assert.match(html, /Index A[^]*?offline[^]*?Index B/);
  assert.match(html, /data-route-index="A" data-route-state="unavailable"/);
  assert.match(html, /data-route-index="B" data-route-state="verified"/);
  assert.match(html, /A: 3 verified → 0 verified/);
  assert.match(html, /B: 3 verified → 3 verified/);
  assert.match(html, /3 remaining unique services/);
  assert.match(html, /Exact remaining service IDs[^]*?<code>s1<\/code> · <code>s2<\/code> · <code>s3<\/code>/);
  assert.match(html, /class="stage-status[^>]*" role="status"><strong>[^<]*<\/strong><span>[^<]*3 remaining unique services/);
  assert.match(html, /No service was invoked by this discovery-only experiment/);
  assert.match(actionForm(html, 'index')!, /name="city" value="Chicago"/);
  assert.match(actionForm(html, 'index')!, /name="panel" value="resilience"/);
});

test('experiment names a retained operator compactly and keeps its full service key in evidence', () => {
  const view = discoveredView('unavailable');
  const full = `eip155:31337/erc721:0x${'1'.repeat(40)}/7`;
  view.discovery = { ...view.discovery!, selected: [{ ...view.discovery!.selected[0]!, service: full }] };
  view.experiment = { target: 'A', action: 'stop', city: 'Chicago', phase: 'observed', before: null, note: 'Observed.',
    after: { city: 'Chicago', status: 'partial', services: [full], indexes: {
      A: { status: 'unavailable', verified: 0, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] },
      B: { status: 'complete', verified: 1, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } } } };
  const html = renderSessionView(view, active);
  const result = html.slice(html.indexOf('class="experiment-result"'), html.indexOf('class="experiment-controls"'));
  assert.match(result, /Remaining services: Food first · Chicago #7/);
  assert.match(result, /<summary>Exact remaining service IDs<\/summary>[^]*?eip155:31337\/erc721:/);
  assert.equal(result.includes(`<p class="remaining-ids">Remaining service IDs: <code>${full}</code>`), false);
});

test('zero verified services does not claim both Indexes are down when one answered', () => {
  const view = emptyView();
  view.experiment = { target: 'A', action: 'tamper', city: 'Chicago', phase: 'observed', before: null, note: 'Observed.',
    after: { city: 'Chicago', status: 'partial', services: [], indexes: {
      A: { status: 'partial', verified: 0, rejected: 1, unavailable: 0, alteredNames: [], reasons: ['owner mismatch'] },
      B: { status: 'complete', verified: 0, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } } } };
  const html = renderSessionView(view, active);
  assert.match(html, /No verified services were returned in this comparison/);
  assert.equal(html.includes('Both Indexes were unavailable; no verified services were returned.'), false);
});

test('tamper and no-prior experiments state only observed rejection and unknown comparison', () => {
  const view = emptyView(); view.indexControls.A = 'altered';
  view.experiment = { target: 'A', action: 'tamper', city: 'Boston', phase: 'observed', before: null,
    note: 'No prior comparison for this city.', after: { city: 'Boston', status: 'partial', indexes: {
      A: { status: 'partial', verified: 2, rejected: 1, unavailable: 0, alteredNames: ['Tampered unverified name'], reasons: ['declaration differs from owner record'] },
      B: { status: 'complete', verified: 3, rejected: 0, unavailable: 0, alteredNames: [], reasons: [] } }, services: ['s1', 's2', 's3'] } };
  const html = renderSessionView(view, active);
  assert.match(html, /No prior comparison for Boston/);
  assert.match(html, /Tampered unverified name/);
  assert.match(html, /1 rejected/);
  assert.match(html, /declaration differs from owner record/);
  assert.match(html, /B[^]*?3 verified/);
  assert.match(html, /Authentic owner record/);
});

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

test('actor scene explains discovery, direct asking, and Ethereum without claiming an operation ran', () => {
  const html = renderSessionView(emptyView(), active);
  assert.match(html, /Your agent\. A city of expertise\./);
  assert.match(html, /City demo client/);
  assert.match(html, /Index A/); assert.match(html, /Index B/);
  assert.match(html, /Indexes help find candidates/);
  assert.match(html, /[Dd]irect signed request/);
  assert.match(html, /Local Ethereum records ownership/);
  assert.match(html, /No request has been sent/);
  assert.match(html, /Discover/); assert.match(html, /Choose/); assert.match(html, /Ask/); assert.match(html, /Review/);
  assert.match(html, /Try resilience/);
});

test('journey and request timeline distinguish pending, unresolved and checked completion', () => {
  const view = emptyView(); view.invocations = [{ id: 'pending', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: false, taskId: null, outcome: 'unresolved', checkedResult: 'not-checked', answer: null }];
  view.operations = [{ id: 'op-1', generation: 0, kind: 'invoke', state: 'running' }];
  let html = renderSessionView(view, active);
  assert.match(html, /Request unresolved/);
  assert.match(html, /Acceptance not observed/);
  assert.match(html, /Result not checked/);
  assert.equal(html.includes('Completed and byte-checked'), false);
  view.operations[0]!.state = 'failed'; view.operations[0]!.error = 'provider unavailable';
  html = renderSessionView(view, active);
  assert.match(html, /provider unavailable/);
  view.invocations[0]!.accepted = true; view.invocations[0]!.outcome = 'completed'; view.invocations[0]!.checkedResult = 'matched';
  html = renderSessionView(view, active);
  assert.match(html, /Completed and byte-checked/);
});

test('ranking explanation surfaces accepted reviewer policy, observation, and unknown-reviewer rationale', () => {
  const view = discoveredView('unavailable');
  view.discovery = { ...view.discovery!, ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult: {
    algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator',
    policy: { id: 'test-policy', version: '1', reviewers: ['disclosed-reviewer'], groups: [], curators: ['curator'], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'test-rubric' },
    observation: { id: 'observation', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
    candidates: [{ service: 'service-7', admitted: true, profileEligible: true, view: 'recommended-newcomer', qualification: 'qualified',
      profile: { id: 'profile', status: 'valid', endpoint: 'endpoint', cardDigest: null, provenance: 'supplied' },
      history: { id: 'history', status: 'complete', startBlock: '1', start: 'registry-start-confirmed', observation: 'observation', provenance: 'supplied' },
      score: null, provisionalScore: null, groupCount: 0, interactionCount: 0, groups: [], warnings: [], historicalOrdering: 'unknown', reviews: [],
      admissions: [{ id: 'admission', kind: 'curator', issuer: 'curator', provenance: 'supplied', reason: 'accepted' }] }], evidence: [],
    selection: { rated: [], newcomers: ['service-7'], unassessed: [], unresolved: [], explore: [], excluded: [] },
  } } };
  const html = renderSessionView(view, active);
  assert.match(html, /Chicago · evening-plan/);
  assert.match(html, /disclosed-reviewer/);
  assert.match(html, /90-day review window/);
  assert.match(html, /Curator inclusion/);
  assert.match(html, /Why doesn.t every rating count\?/);
  assert.match(html, /New reviewers can publish feedback/);
  assert.match(html, /zero accepted interactions/);
});

test('active enhancement honors reduced motion and saved export stays inert', () => {
  const activeHtml = renderSessionView(emptyView(), active);
  assert.match(activeHtml, /prefers-reduced-motion:\s*reduce/);
  assert.match(activeHtml, /data-session-client/);
  const saved = renderSessionView(emptyView());
  assert.equal(saved.includes('<script'), false);
  assert.equal(saved.includes('data-session-client'), false);
  assert.equal(saved.includes('<form'), false);
});

test('OpenClaw request defaults to $150 for two while native form still posts minor units', () => {
  const view = discoveredView('unavailable'); view.answerEngine = 'openclaw'; view.selection = 'service-7';
  const html = renderSessionView(view, active);
  assert.match(html, /Budget for two/);
  assert.match(html, /data-budget-input/);
  assert.match(html, /name="budget"[^>]*value="15000"/);
  assert.match(html, /data-budget-minor="15000">\$150/);
  assert.match(html, /<textarea name="preferences"[^>]*>Plan for two people<\/textarea>/);
  assert.equal(html.includes('name="budgetDollars"'), false, 'server receives only existing minor-unit field');
});

test('journey does not carry an earlier service success into a newly chosen service', () => {
  const view = discoveredView('unavailable');
  view.discovery = { ...view.discovery!, ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult: {
    algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator', policy: { id: 'policy', version: '1', reviewers: [], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'rubric' }, observation: { id: 'obs', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
    candidates: [], evidence: [], selection: { rated: [], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] },
  } } };
  view.selection = 'service-7'; view.invocations = [{ id: 'old', service: 'different-service', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'completed', checkedResult: 'matched', answer: null }];
  const html = renderSessionView(view, active);
  assert.match(html, /data-state="current"><a href="#ask"/);
  assert.equal(html.includes('data-state="done"><a href="#ask"'), false);
});

test('newer unresolved request to same specialist supersedes earlier completed milestone', () => {
  const view = discoveredView('unavailable');
  view.discovery = { ...view.discovery!, ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult: {
    algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator', policy: { id: 'policy', version: '1', reviewers: [], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'rubric' }, observation: { id: 'obs', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
    candidates: [], evidence: [], selection: { rated: [], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] },
  } } };
  view.selection = 'service-7';
  view.invocations = [
    { id: 'old', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`, sent: true, accepted: true, taskId: 'old', outcome: 'completed', checkedResult: 'matched', answer: null },
    { id: 'new', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'b'.repeat(64)}`, sent: true, accepted: false, taskId: null, outcome: 'unresolved', checkedResult: 'not-checked', answer: null },
  ];
  const html = renderSessionView(view, active);
  assert.match(html, /data-state="current"><a href="#ask"/);
  assert.equal(html.includes('data-state="done"><a href="#ask"'), false);
});

test('post-feedback city refresh retains the observed journey without carrying it to another city', () => {
  const view = discoveredView('unavailable');
  view.discovery = { ...view.discovery!, ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult: {
    algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
    qualification: 'input-findings-not-verified-by-calculator', policy: { id: 'policy', version: '1', reviewers: [], groups: [], curators: [], evaluators: [] },
    scope: { city: 'Chicago', task: 'evening-plan', rubric: 'rubric' }, observation: { id: 'obs', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
    candidates: [], evidence: [], selection: { rated: [], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] },
  } } };
  view.selection = null; // Controller refresh() after feedback clears selection.
  view.invocations = [{ id: 'asked', service: 'service-7', reviewer: 'accepted', requestDigest: `0x${'a'.repeat(64)}`,
    sent: true, accepted: true, taskId: 'task', outcome: 'completed', checkedResult: 'matched', answer: null }];
  view.feedback = [{ id: 'review', invocationId: 'asked', value: 5, reviewer: 'accepted', slot: 0,
    documentHash: `0x${'b'.repeat(64)}`, signed: true, publication: 'observed', transactionHash: null,
    readBack: 'matched', retained: { A: true, B: true }, weighting: 'contributing', policyId: 'session-demo-reviewer-policy' }];
  let html = renderSessionView(view, active);
  assert.match(html, /data-state="done"><a href="#ask"/);
  assert.match(html, /data-state="done"><a href="#review"/);
  assert.match(html, /Now: try resilience/);
  view.discovery = { ...view.discovery!, city: 'Boston', selected: [{ agent: { agentId: '8' }, service: 'service-8' }] } as unknown as SessionView['discovery'];
  html = renderSessionView(view, active);
  assert.equal(html.includes('data-state="done"><a href="#ask"'), false);
  assert.equal(html.includes('data-state="done"><a href="#review"'), false);
});

test('one surviving Index with matched ranking keeps discovery usable but names partial coverage', () => {
  const view = discoveredView('unavailable');
  view.discovery = { ...view.discovery!, status: 'partial',
    origins: [{ status: 'unavailable' }, { status: 'complete' }],
    ranking: { ...view.discovery!.ranking, snapshot: 'matched', policyResult: {
      algorithm: { id: 'city-usefulness', version: '0.2', windowSeconds: 7776000, interactionsPerReviewer: 3, priorWeight: 2, priorMean: 3 },
      qualification: 'input-findings-not-verified-by-calculator', policy: { id: 'policy', version: '1', reviewers: [], groups: [], curators: [], evaluators: [] },
      scope: { city: 'Chicago', task: 'evening-plan', rubric: 'rubric' }, observation: { id: 'obs', domain: 'test', block: '4', timestamp: 1, timeBasis: 'declared-fixture', provenance: 'supplied' },
      candidates: [], evidence: [], selection: { rated: [], newcomers: [], unassessed: [], unresolved: [], explore: [], excluded: [] },
    } } } as unknown as SessionView['discovery'];
  const html = renderSessionView(view, active);
  assert.match(html, /data-state="done"><a href="#discover"/);
  assert.match(html, /partial Index coverage/);
  assert.match(html, /data-state="current"><a href="#choose"/);
});

test('hostile operation error is escaped and cannot enter inline script', () => {
  const view = emptyView();
  view.operations = [{ id: 'bad', generation: 0, kind: 'invoke', state: 'failed', error: '</script><script>alert(1)</script>' }];
  const html = renderSessionView(view, active);
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert/);
  const scripts = [...html.matchAll(/<script\b[^>]*>([^]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]![1]!.includes('alert(1)'), false);
});

test('a status poll begun before selection cannot replace the submitted selection with an older page', async () => {
  type FakeMain = { dataset: { generation: string; city: string; selection: string; panel?: string }; panelScroll: { scrollTop: number };
    querySelectorAll(selector: string): unknown[]; querySelector(selector: string): unknown; replaceWith(next: FakeMain): void };
  let current: FakeMain;
  const main = (selection: string): FakeMain => ({ dataset: { generation: '0', city: 'Chicago', selection },
    panelScroll: { scrollTop: 360 }, querySelectorAll: () => [], querySelector(selector) { return selector === '.panel-scroll' ? this.panelScroll : null; },
    replaceWith(next) { current = next; } });
  current = main('');
  let resolveStatus!: (response: unknown) => void;
  const delayedStatus = new Promise((resolve) => { resolveStatus = resolve; });
  const listeners = new Map<string, (event: unknown) => Promise<void>>();
  const intervals: (() => Promise<void>)[] = [];
  let pageFetches = 0;
  class FakeForm { getAttribute(name: string) { return name === 'action' ? '/action' : null; }
    querySelectorAll() { return []; } querySelector() { return { value: 'discover' }; } }
  class FakeFormData { constructor(_form: FakeForm) {} *[Symbol.iterator](): Generator<[string, string]> {} }
  const document = { hidden: false, activeElement: null, querySelector: (selector: string) => selector === 'main' ? current : null,
    querySelectorAll: () => [], addEventListener: (event: string, handler: (event: unknown) => Promise<void>) => { listeners.set(event, handler); } };
  const window = { __cityInitialStatus: { generation: 0, status: 'ready', operations: [] }, scrollY: 0,
    fetch: true, addEventListener() {}, scrollTo() {}, history: { replaceState() {} } };
  const fetch = async (path: string) => {
    if (path === '/status') return delayedStatus;
    if (path === '/') { pageFetches++; return { ok: true, text: async () => 'stale' }; }
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => 'selected' };
  };
  runInNewContext(sessionClient, { document, window, fetch, URL, URLSearchParams, FormData: FakeFormData,
    HTMLFormElement: FakeForm, DOMParser: class { parseFromString(html: string) { return { querySelector: () => main(html === 'selected' ? 'service-7' : '') }; } },
    location: { href: 'http://127.0.0.1:3000/' }, setInterval: (callback: () => Promise<void>) => { intervals.push(callback); },
    Date, Number, String, Event, Map });
  const pendingPoll = intervals[0]!();
  await listeners.get('submit')!({ target: new FakeForm(), submitter: { disabled: false }, preventDefault() {} });
  assert.equal(current.dataset.selection, 'service-7');
  assert.equal(current.panelScroll.scrollTop, 0, 'an explicit same-panel action should reveal its result above the control');
  resolveStatus({ ok: true, json: async () => ({ generation: 0, status: 'ready', operations: [{ id: 'older', state: 'completed' }] }) });
  await pendingPoll;
  assert.equal(current.dataset.selection, 'service-7', 'a response begun before submit must not overwrite the newer selection');
  assert.equal(pageFetches, 0, 'stale status must not trigger a page fetch or acknowledge its revision');
});

for (const focused of ['tab', 'summary'] as const) test(`polling preserves keyboard focus on a ${focused}`, async () => {
  let current: any;
  const document: any = { hidden: false, activeElement: null, querySelectorAll: () => [], addEventListener() {} };
  const makeMain = () => {
    const panel = { id: 'discover' };
    const details: any = { dataset: { disclosureKey: 'discovery-basis' }, open: true, querySelector: () => summary };
    const tab: any = { dataset: { panelLink: 'discover', focusKey: 'tab:discover' },
      setAttribute() {}, removeAttribute() {}, closest: () => null, focus: () => { document.activeElement = tab; } };
    const summary: any = { dataset: {}, matches: (selector: string) => selector === 'summary',
      closest: (selector: string) => selector.startsWith('details') ? details : selector === '.task-panel' ? panel : null,
      focus: () => { document.activeElement = summary; } };
    const main: any = { dataset: { generation: '0', city: 'Chicago', selection: '', panel: 'discover' }, tab, summary, details,
      querySelectorAll: (selector: string) => selector === '.task-tabs [data-panel-link]' || selector === '[data-focus-key]' ? [tab] :
        selector === 'details[data-disclosure-key]' ? [details] : [],
      querySelector: () => null, replaceWith(next: any) { current = next; } };
    return main;
  };
  current = makeMain(); document.activeElement = current[focused];
  document.querySelector = (selector: string) => selector === 'main' ? current : null;
  const intervals: (() => Promise<void>)[] = [];
  const window = { __cityInitialStatus: { generation: 0, status: 'ready', operations: [] }, scrollY: 0,
    addEventListener() {}, scrollTo() {} };
  const fetch = async (path: string) => path === '/status'
    ? { ok: true, json: async () => ({ generation: 0, status: 'ready', operations: [{ id: 'changed', state: 'completed' }] }) }
    : { ok: true, text: async () => 'fresh page' };
  runInNewContext(sessionClient, { document, window, fetch, URL,
    DOMParser: class { parseFromString() { return { querySelector: () => makeMain() }; } },
    location: { href: 'http://127.0.0.1:3000/#discover', hash: '#discover' },
    setInterval: (callback: () => Promise<void>) => { intervals.push(callback); }, Date, Number, String, Event, Map });
  await intervals[0]!();
  assert.equal(document.activeElement, current[focused]);
  if (focused === 'summary') assert.equal(current.details.open, true);
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
  assert.match(html, /<summary>Why this position\?<\/summary>[^]*?<summary>Exact ranking evidence \(JSON\)<\/summary><pre>[^]*?&quot;numerator&quot;: &quot;11&quot;[^]*?&quot;denominator&quot;: &quot;3&quot;/);
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
  assert.match(section, /data-disclosure-key="authored:invocation"/);
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
