import { randomUUID } from 'node:crypto';
import type { SessionView } from '../demo/sessionController.js';
import type { LiveAnswer } from '../live/answer.js';
import { journey, currentMoment, requestMilestones, rankExplanation } from './sessionPresentation.js';
import { sessionStyles } from './sessionStyles.js';
import { sessionClient } from './sessionClient.js';

export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const e = escapeHtml;
const evidence = (title: string, value: unknown, key = title) => `<details data-disclosure-key="${e(key)}"><summary>${e(title)}</summary><pre>${e(JSON.stringify(value, null, 2))}</pre></details>`;
function link(url: string, label: string): string {
  try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return `<a href="${e(parsed.href)}" rel="noreferrer noopener" target="_blank">${e(label)}</a>`; } catch { /* text only */ }
  return `${e(label)} (link withheld)`;
}
function fields(value: unknown): string {
  if (value === null || typeof value !== 'object') return e(value === null ? 'unknown' : value);
  if (Array.isArray(value)) return `<ul>${value.map((v) => `<li>${fields(v)}</li>`).join('')}</ul>`;
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string' && typeof record.title === 'string') return link(record.url, record.title);
  return `<dl>${Object.entries(record).map(([k, v]) => `<dt>${e(k.replace(/([A-Z])/g, ' $1'))}</dt><dd>${fields(v)}</dd>`).join('')}</dl>`;
}
function licensedAnswer(answer: LiveAnswer, expiresAt: string): string {
  return `<section class="answer licensed" data-expires="${e(expiresAt)}"><h4>Source-backed proposal · gaps remain</h4>
    <p>Visible until ${e(expiresAt)}. Controlled demo retention cannot prevent someone copying visible content.</p>
    <h5>Dinner grounding — source-generated, not verified hours</h5><pre class="prose">${e(answer.grounding.block)}</pre>
    <div class="source"><h5>Required source attribution</h5>${fields(answer.grounding.places)}${fields(answer.grounding.links)}${fields(answer.grounding.meta)}</div>
    ${answer.synthesis ? `<h5>Provider synthesis — not a source fact</h5><p>${e(answer.synthesis.text)}</p>` : ''}
    <h5>Dinner proposal</h5>${fields(answer.dinner)}<h5>Activity and its sources</h5>${fields(answer.activity)}
    <h5>Travel and its sources</h5>${fields(answer.transit)}<h5>Costs and gaps</h5>${fields(answer.costs)}${fields(answer.gaps)}
    <h5>Calls and cost accounting</h5>${fields(answer.usage)}${fields(answer.cleanup)}</section>`;
}
function fixtureAnswer(raw: string, invocationId: string): string {
  try {
    // Public authored-fixture fields from syntheticEveningPlan; never a live answer.
    const answer = JSON.parse(raw) as {
      kind: string; rationale: string; schedule: { role: string; place: string; detail: string }[];
      route: { from: string; to: string; mode: string; detail: string };
      budget: { currency: string; requestedMinorUnits: string; allocations: { dinner: number; activity: number; transport: number }; estimatedTotalMinorUnits: number };
      sources: { label: string }[]; unmetConstraints: string[]; retrievalAsOf: string;
      modelSynthesis?: { text: string; tradeoffs: string[]; uncertainties: string[]; specialist: string; provider: string; model: string;
        usage: { input: number; output: number; cacheRead: number; total: number } };
    };
    if (answer.kind !== 'synthetic-evening-plan' || answer.budget.currency !== 'USD') throw new Error('not a USD fixture');
    const dinner = answer.schedule.find((stop) => stop.role === 'dinner')!, activity = answer.schedule.find((stop) => stop.role === 'activity')!;
    const usd = (minorUnits: string | number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(BigInt(minorUnits)) / 100);
    const modes: Record<string, string> = { walk: 'Walking', 'public-transit': 'Public transit', bicycle: 'Bicycle', car: 'Car', taxi: 'Taxi' };
    return `<section class="answer"><h4>Authored fixture · not real city facts</h4>
      ${answer.modelSynthesis ? `<h5>Model opinion · ${e(answer.modelSynthesis.specialist)} specialist</h5><p>${e(answer.modelSynthesis.text)}</p>
        <ul>${answer.modelSynthesis.tradeoffs.map((v) => `<li>${e(v)}</li>`).join('')}</ul>
        <p>Model uncertainties:</p><ul>${answer.modelSynthesis.uncertainties.map((v) => `<li>${e(v)}</li>`).join('')}</ul>
        <p class="small">${e(answer.modelSynthesis.provider)} / ${e(answer.modelSynthesis.model)} · ${e(answer.modelSynthesis.usage.total)} tokens reported after dispatch. These are model opinions over fictional options, not verified source facts.</p>` : `<p>${e(answer.rationale)}</p>`}
      <div class="itinerary"><article><span class="time">01 · Dinner</span><h5>Dinner · ${e(dinner.place)}</h5><p>${e(dinner.detail)}</p></article>
      <article><span class="time">02 · Activity</span><h5>Evening activity · ${e(activity.place)}</h5><p>${e(activity.detail)}</p></article>
      <article><span class="time">03 · Transport</span><h5>Getting there · ${e(modes[answer.route.mode] ?? answer.route.mode)}</h5><p>${e(answer.route.from)} → ${e(answer.route.to)}.</p><p>${e(answer.route.detail)}</p></article></div>
      <h5>Example budget · USD</h5><p>Dinner ${usd(answer.budget.allocations.dinner)} · activity ${usd(answer.budget.allocations.activity)} · travel ${usd(answer.budget.allocations.transport)}.</p>
      <p>Example total: ${usd(answer.budget.estimatedTotalMinorUnits)}. Requested budget: ${usd(answer.budget.requestedMinorUnits)}. Estimates only, not verified quotes.</p>
      <h5>Sources and gaps</h5><ul>${answer.sources.map((source) => `<li>${e(source.label)}</li>`).join('')}</ul>
      <ul>${answer.unmetConstraints.map((gap) => `<li>${e(gap)}</li>`).join('')}</ul><p>As of: ${e(answer.retrievalAsOf)}</p>
      ${evidence('Exact authored fixture evidence', answer, `authored:${invocationId}`)}</section>`;
  } catch { return '<p>Answer could not be displayed. Receipt evidence remains below.</p>'; }
}
export type SessionRenderOptions = { token: string; nonce: string;
  content?: ReadonlyMap<string, { answer: LiveAnswer; expiresAt: string }>; message?: string };
/** Accepts only the explicit public projection. No controller/private input can be serialized here. */
export function renderSessionView(view: SessionView, options?: SessionRenderOptions): string {
  const active = !!options, ready = view.status === 'ready';
  const busy = view.operations.some((op) => op.state === 'running' || op.state === 'queued');
  const panelFor = (action: string) => action === 'select' || action === 'invoke' || action === 'invoke-failure' || action === 'retry' ? 'ask' :
    action === 'feedback' || action === 'retry-feedback' ? 'review' : action === 'index' ? 'resilience' :
      action === 'recover' || action === 'fresh-consumer' || action === 'origin-comparison' || action === 'reset' || action === 'stop-providers' ? 'ownership' : 'discover';
  const form = (action: string, label: string, values: Record<string, string> = {}, body = '', disabled = !ready || busy): string => !options ? '' :
    `<form method="post" action="/action"${action === 'invoke' ? ' data-ask-form' : ''}><input type="hidden" name="token" value="${e(options.token)}"><input type="hidden" name="generation" value="${view.generation}">
    <input type="hidden" name="operationId" value="${randomUUID()}"><input type="hidden" name="action" value="${e(action)}"><input type="hidden" name="panel" value="${panelFor(action)}">
    ${Object.entries(values).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('')}${body}<button${disabled ? ' disabled' : ''}>${e(label)}</button></form>`;
  const discovery = view.discovery, policy = discovery?.ranking.policyResult;
  const rankingReady = discovery?.ranking.snapshot === 'matched' && !!policy;
  const rankingCondition = discovery?.ranking.snapshot === 'changed' ? 'Ranking observation changed' : 'Ranking unavailable';
  const rankingGuidance = `${rankingCondition}. Compare this city again before selecting or asking a specialist.`;
  const names: Record<string, string> = { 'operator-1': 'Food first', 'operator-2': 'Culture first', 'operator-3': 'Travel & value' };
  const descriptions: Record<string, string> = { 'operator-1': 'A complete evening with more attention on dinner.', 'operator-2': 'A complete evening built around an activity.', 'operator-3': 'A complete evening with simpler travel and lower example costs.' };
  const badges: Record<string, string> = { 'recommended-rated': 'Recommended · rated', 'recommended-newcomer': 'New · no accepted reviews',
    'recommended-unassessed': 'Unassessed', 'recommended-unresolved': 'Unresolved', explore: 'Explore', excluded: 'Excluded by policy' };
  const order = [...(policy?.selection.rated ?? []), ...(policy?.selection.newcomers ?? []), ...(policy?.selection.unassessed ?? []),
    ...(policy?.selection.unresolved ?? []), ...(policy?.selection.explore ?? []), ...(policy?.selection.excluded ?? [])];
  const operators = [...view.operators].sort((a, b) => {
    const key = (op: typeof a) => discovery?.selected.find((c) => op.services.some((s) => s.city === discovery.city && s.agentId === c.agent.agentId))?.service;
    const ai = order.indexOf(key(a) ?? ''), bi = order.indexOf(key(b) ?? ''); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  const cards = operators.map((operator) => {
    const service = operator.services.find((s) => s.city === discovery?.city);
    const candidate = discovery?.selected.find((c) => c.agent.agentId === service?.agentId);
    const ranked = policy?.candidates.find((c) => c.service === candidate?.service);
    const chosen = candidate?.service === view.selection;
    const position = !discovery ? { status: 'not-assessed', reason: 'Choose a city to compare.' } :
      !candidate ? { status: 'missing', reason: 'No verified candidate at this observation.' } :
      !rankingReady || !ranked ? { status: 'ranking-unresolved', snapshot: discovery.ranking.snapshot,
        reason: `Candidate present in verified discovery. ${rankingGuidance}`, diagnostics: discovery.ranking.diagnostics } : ranked;
    const explanation = rankingReady ? rankExplanation(ranked) : null;
    const score = ranked?.score && rankingReady ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(BigInt(ranked.score.numerator)) / Number(BigInt(ranked.score.denominator)))} / 5 policy score` : null;
    const groupNames = ranked?.groups.map((group) => group.key).join(', ') || 'none declared in contributing evidence';
    return `<article class="card${chosen ? ' selected' : ''}"><div class="card-top"><span class="eyebrow">${e(operator.label)}</span><span class="card-glyph" aria-hidden="true">${e(operator.id === 'operator-1' ? '✦' : operator.id === 'operator-2' ? '◈' : '↗')}</span></div>
      <h3>${e(names[operator.id] ?? operator.label)}</h3><p class="card-tagline">${e(descriptions[operator.id] ?? 'Complete evening service.')}</p>
      <span class="badge${!rankingReady || ranked?.view === 'recommended-unresolved' ? ' unresolved' : ''}">${chosen ? 'Selected · ' : ''}${!discovery ? 'Choose a city to compare' : !candidate ? 'Missing from verified discovery' : !rankingReady || !ranked ? e(rankingCondition) : e(badges[ranked.view])}</span>
      ${candidate && (!rankingReady || !ranked) ? `<p>Present in verified discovery. ${e(rankingGuidance)}</p>` : ''}
      ${rankingReady && ranked ? `<div class="metric"><strong>${score ? e(score) : 'No weighted score'}</strong><span>${ranked.interactionCount} weighted interactions · ${ranked.groupCount} reviewer groups</span></div>
        ${score && ranked.interactionCount <= 2 ? '<p class="small">Small sample: early scores lean toward 3/5. One 5/5 can display as 3.67/5.</p>' : ''}
        ${candidate ? form('select', chosen ? 'Selected' : 'Select this specialist', { service: candidate.service }, '', !ready || busy || chosen || !rankingReady || !ranked) : ''}
        <details class="evidence-details" data-disclosure-key="why:${e(operator.id)}"><summary>Why this position?</summary><ul class="reason-list"><li><b>Scope</b> ${e(policy?.scope.city)} · ${e(policy?.scope.task)}</li>
        <li><b>Policy</b> ${e(policy?.policy.id)} · ${e(policy?.policy.reviewers.join(', ') || 'no accepted reviewers')}</li>
        <li><b>Contributing</b> ${ranked.interactionCount === 0 ? 'zero accepted interactions' : `${ranked.interactionCount} accepted interactions`}; ${e(explanation?.contributing ?? 0)} contributing reviews; declared groups: ${e(groupNames)}</li>
        <li><b>Admission</b> Curator inclusion: ${explanation?.curator ? 'observed' : 'not observed'}; Town test admission: ${explanation?.town ? 'observed' : 'not observed'}.</li>
        <li><b>Excluded here</b> ${explanation?.exclusions.length ? e(explanation.exclusions.map((item) => item.reason).join(', ')) : 'none in this candidate evidence'}.</li></ul>${evidence('Exact ranking evidence (JSON)', position, `rank:${operator.id}`)}</details>` : ''}
      <div class="card-footer">${candidate && (!rankingReady || !ranked) ? form('select', chosen ? 'Selected' : 'Select this specialist', { service: candidate.service }, '', true) : ''}
      ${rankingReady && ranked ? '' : evidence('Why this position?', position, `position:${operator.id}`)}${evidence('Operator and both city identities', operator, `operator:${operator.id}`)}</div></article>`;
  }).join('');
  const selected = discovery?.selected.find((c) => c.service === view.selection);
  const licensed = view.mode === 'licensed';
  const inputFields = licensed ? `<p>Admitted reviewer: ${e(view.licensedHint?.admittedReviewer)}. Policy expires ${e(view.licensedHint?.expiresAt)}.</p>
    <p id="input-help">Use future local dates with seconds and the city’s UTC offset; both must agree with its timezone. End must be after start, within 24 hours. No credentials here.</p>
    <label>Starts <input name="start" placeholder="YYYY-MM-DDT18:00:00-05:00" required aria-describedby="input-help"></label>
    <label>Ends <input name="end" placeholder="YYYY-MM-DDT22:00:00-05:00" required></label><label>Area <input name="area" maxlength="120" required></label>
    <label data-budget-input><span data-budget-label>Budget for two · $150 default (enter cents without JavaScript)</span><input name="budget" type="number" min="0" max="10000000" value="15000" required></label>
    <label>Transport <select name="transport"><option value="walk">Walk</option><option value="walk-and-public-transit">Walking + public transit</option><option value="public-transit">Public transit</option><option value="bicycle">Bicycle</option><option value="car">Car</option><option value="taxi">Taxi</option></select></label>
    <label>Preferences (one per line, at most 16) <textarea name="preferences" maxlength="4096">Plan for two people</textarea></label>` :
    `<p>${view.answerEngine === 'openclaw' ? 'A real OpenClaw specialist chooses and explains a complete plan from fictional demo options. Only your request inputs and authored options reach the model.' : 'A fixed fictional evening request is sent only when you press Ask.'}</p>
    ${view.answerEngine === 'openclaw' ? '<label data-budget-input><span data-budget-label>Budget for two · $150 default (enter cents without JavaScript)</span><input name="budget" type="number" min="0" max="10000000" value="15000" required></label><label>Transport<select name="transport"><option value="walk-and-public-transit">Walking + public transit</option><option value="walk">Walking only</option></select></label><label>What matters to you? (one preference per line)<textarea name="preferences" maxlength="4096" placeholder="Great dinner\nKeep costs low\nA memorable activity">Plan for two people</textarea></label>' : ''}
    <label>Reviewer <select name="reviewer"><option value="accepted">Disclosed demo reviewer (weighted)</option><option value="new">New reviewer (unweighted)</option></select></label>`;
  const invocations = [...view.invocations].reverse().map((item) => {
    const content = options?.content?.get(item.id);
    const milestones = requestMilestones(item);
    const verdict = item.outcome === 'completed' && item.checkedResult === 'matched' ? 'Completed and byte-checked' :
      item.outcome === 'unresolved' ? 'Request unresolved' : item.outcome === 'failed' ? 'Provider failure observed' : 'Awaiting a checked result';
    return `<article class="result"><div class="result-head"><div><span class="eyebrow">Signed interaction</span><h3>Your ${licensed ? 'source-backed' : 'fixture'} request</h3></div><span class="status-pill${item.outcome === 'unresolved' || item.outcome === 'failed' ? ' warn' : ''}">${e(verdict)}</span></div>
      <ol class="timeline" aria-label="Observed request timeline">${milestones.map((stage) => `<li data-state="${e(stage.state)}"><b>${e(stage.label)}</b></li>`).join('')}</ol>
      <p class="small">Sent: ${item.sent ? 'yes' : 'no'} · Accepted: ${item.accepted ? 'observed' : 'not observed'} · Provider result: ${e(item.outcome)} · Byte check: ${e(item.checkedResult)}. A signature identifies a statement; it does not establish answer quality.</p>
      ${licensed ? content ? licensedAnswer(content.answer, content.expiresAt) : `<p>Content: ${e(item.receipt?.content.contentAvailability ?? 'unavailable')}. Semantic replay unavailable here; receipt/hash and earlier byte checks remain.</p>` : item.answer ? fixtureAnswer(item.answer, item.id) : '<p>No answer observed.</p>'}
      ${item.outcome === 'unresolved' ? form('retry', 'Retry the same signed request', { invocationId: item.id }) : ''}
      ${evidence('Receipt and observed checks', { ...item, answer: null }, `receipt:${item.id}`)}</article>`;
  }).join('');
  const askControls = `${selected ? `<div class="form-panel"><span class="eyebrow">Your evening brief</span>${(licensed || view.answerEngine === 'openclaw') ? '<p class="budget-note">Quick budgets for two: <span class="budget-presets"><button type="button" data-budget-minor="5000">$50</button><button type="button" data-budget-minor="8500">$85</button><button type="button" data-budget-minor="15000">$150</button></span>Or enter another dollar amount. Without JavaScript, the input remains in cents.</p>' : ''}${form('invoke', 'Ask this specialist', licensed ? { reviewer: view.licensedHint?.admittedReviewer ?? '' } : {}, inputFields, !ready || busy || !rankingReady)}</div>` : ''}
    ${selected && !licensed ? `<div class="secondary">${form('invoke-failure', 'Try a signed provider failure', { reviewer: 'accepted' }, '', !ready || busy || !rankingReady)}</div>` : ''}`;
  const reviewActions = [...view.invocations].reverse().map((item) => `<div class="review-action"><p><strong>Interaction ${e(item.id)}</strong> · ${e(item.outcome)} · byte check ${e(item.checkedResult)}. Your rating is an opinion about this interaction, not an owner-record update.</p>
    ${form('feedback', 'Publish demo feedback and refresh ranking', { invocationId: item.id }, '<label>Usefulness <select name="value"><option value="5">5 — very useful</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1 — not useful</option></select></label>', !ready || busy || view.feedbackCapacity.exhausted || !['completed', 'failed'].includes(item.outcome) || item.checkedResult === 'mismatched')}</div>`).join('');
  const feedback = [...view.feedback].reverse().map((f) => `<article class="feedback-card"><span class="eyebrow">Portable feedback</span><h3>Rating ${f.value}/5 · ${e(f.reviewer)} reviewer</h3><div class="feedback-meter" aria-hidden="true"><span style="width:${f.value * 20}%"></span></div><p>Signed: yes · Publication: ${e(f.publication)} · Read-back: ${e(f.readBack)} · Retained A/B: ${f.retained.A ? 'yes' : 'no'} / ${f.retained.B ? 'yes' : 'no'}</p><p>${f.weighting === 'contributing' ? 'This review counts toward your policy score.' : f.weighting === 'not-assessed-at-this-observation' ? 'Policy effect has not been assessed at this observation.' : f.publication === 'observed' ? 'Published, but this review is not weighted by your policy.' : 'Publication is not yet observed; policy effect remains unknown.'}</p>
    ${['not-sent', 'unresolved'].includes(f.publication) ? form('retry-feedback', 'Retry prepared publication', { feedbackId: f.id }) : ''}${evidence('Feedback evidence', f, `feedback:${f.id}`)}</article>`).join('');
  const operations = view.operations.map((op) => `<li data-state="${e(op.state)}"><b>${e(op.kind.replace(/-/g, ' '))}</b> — ${e(op.state)}${op.error ? `: ${e(op.error)}` : ''}</li>`).join('');
  const stages = journey(view), moment = currentMoment(view);
  const activeKind = view.operations.at(-1)?.state === 'running' || view.operations.at(-1)?.state === 'queued' ? view.operations.at(-1)?.kind : null;
  const activity = activeKind === 'refresh' || activeKind === 'index' || activeKind === 'fresh-consumer' ? 'discovery' :
    activeKind === 'invoke' || activeKind === 'retry' ? 'request' : activeKind === 'feedback' || activeKind === 'retry-feedback' || activeKind === 'recover' ? 'chain' : 'none';
  const indexStatus = (name: 'A' | 'B') => view.indexRead?.indexes[name].status ?? 'not compared';
  const experimentCity = discovery?.city ?? view.experiment?.city ?? 'Chicago';
  const experiment = view.experiment;
  const indexResult = (name: 'A' | 'B') => experiment?.after?.indexes[name];
  const remainingLabel = (service: string) => {
    const agentId = (discovery && discovery.city === experiment?.city ? discovery.selected.find((candidate) => candidate.service === service)?.agent.agentId : undefined) ??
      /^eip155:[0-9]+\/erc721:0x[0-9a-fA-F]{40}\/([0-9]+)$/.exec(service)?.[1];
    const operator = view.operators.find((item) => item.services.some((entry) => entry.city === experiment?.city && entry.agentId === agentId));
    return agentId ? `${operator ? names[operator.id] ?? operator.label : 'Verified service'} · ${experiment?.city} #${agentId}` : 'Verified service (ID in evidence)';
  };
  const experimentResult = experiment ? `<div class="experiment-result" role="status" tabindex="-1" data-focus-key="experiment-result" data-phase="${experiment.phase}">
    <span class="eyebrow">Latest experiment · ${e(experiment.city)}</span><h3>${e(experiment.action === 'stop' ? 'Take Index ' + experiment.target + ' offline' : experiment.action === 'tamper' ? 'Alter Index A’s reply' : 'Restore Index ' + experiment.target)} · ${e(experiment.phase)}</h3>
    <p>${experiment.before ? `Before: ${experiment.before.services.length} unique services.` : `No prior comparison for ${e(experiment.city)}.`} ${e(experiment.note)}</p>
    ${experiment.after ? `<p><strong>A: ${experiment.before?.indexes.A.verified ?? 'unknown'} verified → ${indexResult('A')?.verified} verified</strong> · ${e(indexResult('A')?.status)} · ${indexResult('A')?.rejected} rejected.</p>
    <p><strong>B: ${experiment.before?.indexes.B.verified ?? 'unknown'} verified → ${indexResult('B')?.verified} verified</strong> · ${e(indexResult('B')?.status)} · ${indexResult('B')?.rejected} rejected.</p>
    <p><strong>${experiment.after.services.length} remaining unique services.</strong> ${experiment.after.services.length === 0 ? (indexResult('A')?.status === 'unavailable' && indexResult('B')?.status === 'unavailable' ? 'Both Indexes were unavailable; no verified services were returned.' : 'No verified services were returned in this comparison.') : 'Parallel Index replies were checked against the local owner record.'}</p>
    ${experiment.after.services.length ? `<p class="remaining-ids">Remaining services: ${experiment.after.services.map((service) => e(remainingLabel(service))).join(' · ')}</p>` : ''}
    ${indexResult('A')?.alteredNames.length ? `<p>Altered Index A name: <strong>${e(indexResult('A')?.alteredNames.join(', '))}</strong>; ${indexResult('A')?.rejected} rejected observation. ${e(indexResult('A')?.reasons.join('; '))}. Authentic owner record remains separately checked; B returned ${indexResult('B')?.verified} verified.</p>` : ''}` : `<p>${experiment.phase === 'applying' ? 'Control is being applied; no new discovery has been observed.' : experiment.phase === 'discovering' ? 'Control applied; fresh discovery and verification are in progress.' : 'Fresh result unavailable; do not infer the mutation succeeded.'}</p>`}
    ${experiment.after?.services.length ? `<details class="advanced" data-disclosure-key="remaining-service-ids"><summary>Exact remaining service IDs</summary><p>${experiment.after.services.map((service) => `<code>${e(service)}</code>`).join(' · ')}</p></details>` : ''}
    <p class="small">No service was invoked by this discovery-only experiment.</p></div>` : '<p class="small">No Index experiment yet. Choose a city, then try one control.</p>';
  const policyTime = policy ? new Date(policy.observation.timestamp * 1000).toISOString() : null;
  const mapIndex = (name: 'A' | 'B') => {
    const read = view.indexRead?.indexes[name];
    return `<a class="map-node index-node" href="#resilience" data-panel-link="resilience" data-focus-key="index-${name}" data-state="${e(view.indexControls[name])}"><span class="node-type">NANDA Index ${name}</span><strong>Index ${name}</strong><small>${e(view.status === 'starting' ? 'preparing' : view.indexControls[name])} · ${e(indexStatus(name))}${read ? ` · ${read.verified} verified${read.rejected ? `, ${read.rejected} rejected` : ''}` : ''}</small></a>`;
  };
  const routeState = (name: 'A' | 'B') => {
    const read = view.indexRead?.indexes[name];
    return !read ? 'not-compared' : read.status === 'unavailable' ? 'unavailable' : read.rejected ? 'rejected' : read.verified ? 'verified' : 'empty';
  };
  const parallelRoutes = () => `<div class="parallel-routes" aria-hidden="true">${(['A', 'B'] as const).map((name) =>
    `<span class="route-line" data-route-index="${name}" data-route-state="${routeState(name)}"><i>${name}</i></span>`).join('')}</div>`;
  const mapOperators = (['operator-1', 'operator-2', 'operator-3'] as const).map((id) => {
    const operator = view.operators.find((item) => item.id === id);
    const service = operator?.services.find((item) => item.city === discovery?.city);
    const candidate = discovery?.selected.find((item) => item.agent.agentId === service?.agentId);
    return `<a class="map-node operator-node" href="#discover" data-panel-link="discover" data-focus-key="${id}" data-selected="${!!candidate && view.selection === candidate.service}"><span class="node-type">Alternative specialist</span><strong>${e(names[id])}</strong><small>Chicago + Boston · ${e(!operator ? 'preparing' : !discovery ? 'not compared' : candidate ? view.selection === candidate.service ? 'selected and verified' : 'verified' : 'not verified in this comparison')}</small></a>`;
  }).join('');
  const script = !options ? '' : `<script nonce="${e(options.nonce)}">window.__cityInitialStatus=${JSON.stringify({ generation: view.generation, status: view.status,
    operations: view.operations.map((op) => ({ id: op.id, state: op.state })) })};${sessionClient}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NANDA City — your agent, a city of expertise</title><style>${sessionStyles}</style></head><body>
    <main${active ? ' data-session-client' : ''} data-generation="${view.generation}" data-city="${e(discovery?.city ?? '')}" data-selection="${e(view.selection ?? '')}" data-panel="discover">
    <header class="hero"><div class="hero-top"><span class="brand">NANDA <span>CITY</span></span><span class="scope-chip">Local interactive prototype · ${e(view.status)}</span></div>
    <div class="hero-copy"><div><span class="eyebrow">An open network of specialist services</span><h1>Your agent. A city of expertise.</h1></div><p class="intro">Discover a specialist, ask directly, and inspect what the network actually observed.</p></div>
    <div class="scope-row"><span class="scope-chip">${licensed ? 'Licensed source-backed mode' : view.answerEngine === 'openclaw' ? 'Real OpenClaw reasoning · fictional demo data' : 'Synthetic fixture mode'}</span><span class="scope-chip">Local Ethereum</span><span class="scope-chip">Two real Index processes</span><span class="scope-chip">Three simulated operators</span>${!active ? '<span class="scope-chip">Saved snapshot — no active controls</span>' : ''}</div></header>
    ${options?.message ? `<p role="alert" class="notice">${e(options.message)}</p>` : ''}
    <div class="workspace-grid"><section class="network-stage" aria-label="Network map" data-activity="${activity}" data-experiment-phase="${e(experiment?.phase ?? 'none')}" data-experiment-target="${e(experiment?.target ?? '')}"><div class="stage-heading"><span class="eyebrow">The live local network</span><h2>Who does what</h2><p>Click a node to inspect it. A node click never runs an experiment.</p></div>
      <div class="map-canvas"><div class="map-route"><a class="map-node agent-node" href="#ask" data-panel-link="ask" data-focus-key="agent"><span class="node-type">Your personal agent</span><strong>City demo client</strong><small>${view.invocations.length ? `${view.invocations.length} signed request${view.invocations.length === 1 ? '' : 's'} recorded` : 'No request has been sent'}</small></a>${parallelRoutes()}<div class="map-indexes">${mapIndex('A')}${mapIndex('B')}</div>${parallelRoutes()}<div class="map-operators">${mapOperators}</div></div>
      <div class="owner-link" aria-hidden="true">↓ owner record check · feedback layer</div>
      <a class="map-node chain-node" href="#ownership" data-panel-link="ownership" data-focus-key="ethereum"><span class="node-type">Local Ethereum · owner and feedback layer</span><strong>Owner records + portable opinions</strong><small>Local Ethereum records ownership and feedback. Operator smart wallets control records; the client checks owner-published data. Ethereum does not judge answer quality.</small></a></div>
      <p class="map-caption"><strong>Indexes help find candidates;</strong> the client checks owner records. <strong>Direct signed request:</strong> City demo client → chosen operator.</p>
      <div class="stage-status ${e(moment.tone)}" role="status"><strong>${e(moment.title)}</strong><span>${e(moment.detail)}</span></div></section>
    <div class="inspector"><nav aria-label="Tasks" class="task-tabs"><a href="#discover" data-panel-link="discover" data-focus-key="tab:discover">Discover</a><a href="#ask" data-panel-link="ask" data-focus-key="tab:ask">Ask</a><a href="#review" data-panel-link="review" data-focus-key="tab:review">Reputation</a><a href="#resilience" data-panel-link="resilience" data-focus-key="tab:resilience">Experiments</a><a href="#ownership" data-panel-link="ownership" data-focus-key="tab:ownership">Ownership</a></nav><div class="panel-scroll">
    <section class="task-panel" id="discover"><div class="section-head"><div><span class="eyebrow">Discover</span><h2 tabindex="-1" data-focus-key="heading:discover">Find a specialist</h2></div></div>
    <div class="city-choice">${form('refresh', 'Chicago', { city: 'Chicago' }).replace('<button', `<button aria-current="${discovery?.city === 'Chicago'}"`)}${form('refresh', 'Boston', { city: 'Boston' }).replace('<button', `<button aria-current="${discovery?.city === 'Boston'}"`)}</div>
    <p class="discovery-count">${discovery ? `${e(discovery.city)} · discovery ${e(discovery.status)} · ${discovery.eligibleCount} verified candidates` : 'Choose Chicago or Boston to get a frozen comparison'}</p>
    <div class="section" id="choose"><div class="section-head"><div><span class="eyebrow">Choose</span><h2>Three alternatives</h2></div></div>
    <div class="grid">${cards}</div><details class="advanced" data-disclosure-key="discovery-basis"><summary>Frozen observation, coverage and policy</summary><p>${discovery ? `Frozen block ${e(discovery.observation.blockNumber)}; ${e(discovery.observation.blockHash)}.` : 'No frozen observation yet.'} Coverage is bounded and Index-reported, not global history. A changed or unavailable ranking prevents selection until a fresh comparison.</p>
    ${policy ? `<div class="observation-strip"><span>${e(policy.scope.city)} · ${e(policy.scope.task)}</span><span>Policy ${e(policy.policy.id)}</span><span>${e(Math.round(policy.algorithm.windowSeconds / 86400))}-day review window</span><span>Observed ${e(policyTime)}</span></div>` : '<p>Compare a city to see the policy, accepted reviewers and observed ranking.</p>'}
    ${discovery ? evidence('Discovery coverage, exact endpoints, policy and scoped Town evidence', discovery) : ''}</details>
    <details class="reviewer-callout" data-disclosure-key="reviewer-policy"><summary>Why doesn't every rating count?</summary><p>New reviewers can publish feedback, including negative ratings and free-service feedback, but this demo policy does not weight an unknown reviewer until its accepted-reviewer list admits them. Unknown does not mean malicious.</p>
    <p>Accepted reviewers: ${e(policy?.policy.reviewers.join(', ') || 'shown after comparison')}. Declared reviewer groups: ${e(policy?.policy.groups.map((group) => group.key).join(', ') || 'none')}. Curators: ${e(policy?.policy.curators.join(', ') || 'none')}. A curator inclusion can admit a newcomer; an actual scoped Town test admission is a separate kind of evidence, not a general quality badge.</p>
    <p>Signatures, a wallet or a payment can prove a statement or transaction, not that reviewers are independent or that an opinion is good. Excluded and unresolved reviews remain visible in each card's evidence.</p></details>${selected ? '<a class="next-link" href="#ask" data-panel-link="ask">Continue to Ask →</a>' : ''}</div></section>
    <section class="task-panel" id="ask"><div class="section-head"><div><span class="eyebrow">Ask</span><h2 tabindex="-1" data-focus-key="heading:ask">Ask one specialist</h2></div><p>Selection sends nothing. Your signed request goes directly to the selected operator, not through an Index.</p></div>
    <p>${selected ? 'Your specialist is selected.' : 'Select one of the verified specialists above.'} ${view.invocations.length === 0 ? 'No request has been sent.' : ''}</p>
    ${selected && !rankingReady ? `<p class="notice">${e(rankingGuidance)}</p>` : ''}
    ${view.invocations.length ? `<div class="results">${invocations}</div><a class="next-link" href="#review" data-panel-link="review">Continue to Reputation →</a>` : ''}
    ${view.invocations.length && selected ? `<details class="advanced ask-again" data-disclosure-key="ask-again"><summary>Ask again or change brief</summary>${askControls}</details>` : askControls}</section>
    <section class="task-panel" id="review"><div class="section-head"><div><span class="eyebrow">Reputation</span><h2 tabindex="-1" data-focus-key="heading:review">Let experience travel</h2></div><p>Feedback is an interaction-linked signed opinion. Publication, read-back and policy weight are separate observations.</p></div>
    ${feedback || '<p>No feedback published yet.</p>'}
    ${feedback ? `<details class="advanced" data-disclosure-key="review-actions"><summary>Rate another interaction</summary>${reviewActions}</details>` : reviewActions || '<p>No interaction yet. Ask a specialist, then rate the observed result.</p>'}
    ${feedback.length ? `<p class="small">${view.feedback.some((item) => item.publication === 'observed' && item.weighting !== 'not-assessed-at-this-observation') ? 'The ranking was refreshed after publication.' : 'A successful publication is followed by a fresh ranking check.'} A single 5/5 can become a 3.67/5 policy score because this policy starts small samples near 3/5.</p>` : ''}
    <p class="small">A useful plan or a negative review can both be published; neither becomes a quality certificate merely by being signed.</p><a class="next-link" href="#resilience" data-panel-link="resilience">Try an Index experiment →</a></section>
    <section class="task-panel" id="resilience"><div class="section-head"><div><span class="eyebrow">Experiments · Try resilience</span><h2 tabindex="-1" data-focus-key="heading:resilience">Change a route. See the result.</h2></div><p>Each control changes an owned local Index, then runs fresh ${e(experimentCity)} discovery and verification in the same operation. No service is asked.</p></div>
    ${experimentResult}
    <div class="experiment-controls"><div class="experiment-choice"><h3>Take A offline and test</h3><p>Stop A; check whether B still returns verified services.</p>${form('index', 'Take A offline and test', { index: 'A', state: 'stop', city: experimentCity })}</div>
    <div class="experiment-choice"><h3>Alter A’s reply and verify</h3><p>${view.indexControls.A === 'offline' ? 'Restores A, then alters one reply and tests it.' : 'Alters one reply and tests it.'} Verify against the owner record.</p>${form('index', 'Alter A’s reply and verify', { index: 'A', state: 'tamper', city: experimentCity })}</div>
    <div class="experiment-choice"><h3>Restore A and recheck</h3><p>Return A to its own Index process and compare both replies.</p>${form('index', 'Restore A and recheck', { index: 'A', state: 'restart', city: experimentCity })}</div></div>
    <details class="advanced" data-disclosure-key="index-b-controls"><summary>Test a both-down network or restore Index B</summary><p>These controls also run fresh ${e(experimentCity)} discovery. If both are unavailable, there are no verified services to select.</p><div class="bar">${form('index', 'Take B offline and test', { index: 'B', state: 'stop', city: experimentCity })}${form('index', 'Restore B and recheck', { index: 'B', state: 'restart', city: experimentCity })}</div></details>
    <p class="small">Configuration of a fault is not an observed failure. The result above distinguishes control phase from returned Index and verifier evidence.</p></section>
    <section class="task-panel" id="ownership"><div class="section-head"><div><span class="eyebrow">Ownership</span><h2 tabindex="-1" data-focus-key="heading:ownership">Records you can move</h2></div><p>The operator smart wallet can update service records. Indexes copy and search them; this client checks owner-published data against local Ethereum. The wallet does not judge an answer.</p></div>
    ${view.recoveryCheck ? `<div class="experiment-result" data-phase="${e(view.recoveryCheck.status)}" role="status"><h3>Recovery · ${e(view.recoveryCheck.status)}</h3><p>${e(view.recoveryCheck.reason)}</p><p>${view.recoveryCheck.city ? `Fresh ${e(view.recoveryCheck.city)} endpoint: ${view.recoveryCheck.endpoint ? e(view.recoveryCheck.endpoint) : 'not verified yet'}.` : 'No city was selected for endpoint verification.'}</p>${evidence('Recovery check', view.recoveryCheck, 'recovery-check')}</div>` : ''}
    <div class="owner-list">${view.operators.map((op) => {
      const current = op.services.find((service) => service.city === discovery?.city);
      const verified = discovery?.selected.find((candidate) => candidate.agent.agentId === current?.agentId);
      return `<article class="owner-card"><span class="eyebrow">${e(names[op.id] ?? op.label)}</span><h3>Operator smart wallet</h3><p class="mono">${e(op.safe)}</p><p>${op.services.map((service) => `${e(service.city)} service #${e(service.agentId)} · ${e(service.status)}`).join('<br>')}</p><p>Current ${e(discovery?.city ?? 'selected-city')} public endpoint: ${verified?.profile?.endpoint ? e(verified.profile.endpoint) : 'not currently verified in a fresh comparison'}.</p><p>${op.recovery ? `Recovery observed: ${e(op.recovery.qualification)}; fresh-process restoration ${op.recovery.restoredInFreshProcess ? 'observed' : 'not observed'}; old owner rejected ${op.recovery.retiredOwnerRejected ? 'yes' : 'unknown'}. Stable IDs remain, while owner keys, runtime signer and endpoints rotate.` : 'Recovery not run. Generated 1-of-2 backup can restore access in this same-host demonstration.'}</p>${form('recover', `Recover & migrate ${names[op.id] ?? op.label}`, { operatorId: op.id }, '', !ready || busy || !!op.recovery)}${op.recovery ? evidence('Recovery and migration observation', op.recovery, `recovery:${op.id}`) : ''}</article>`;
    }).join('') || '<p>Preparing generated local smart wallets and service IDs.</p>'}</div>
    <div class="control-block"><h3>Fresh consumer</h3><p>Rebuild the frozen ranking from raw evidence in a new process on this host. The card host and local RPC remain required; this is not offline proof or independent custody.</p>${form('fresh-consumer', 'Recompute frozen ranking', {}, '', !ready || busy || !discovery)}${view.freshConsumer ? `<p class="status-pill">${e(view.freshConsumer.status)} — ${e(view.freshConsumer.reason)}</p>${evidence('Reconstruction observation', view.freshConsumer)}` : '<p>Not run.</p>'}</div>
    <details class="advanced" data-disclosure-key="other-controls"><summary>Other local controls and authority comparison</summary><div class="control-block"><h3>Provider endpoints</h3><p>Stop the owned A2A endpoints. This does not remove current AgentCard hosting or prove total provider disappearance.</p><div class="danger">${form('stop-providers', 'Stop provider endpoints')}</div></div><div class="control-block"><h3>Chain-free comparison</h3><p>Separate synthetic HTTPS-origin exercise, never an automatic Ethereum-failure fallback.</p>${form('origin-comparison', 'Run origin comparison')}${view.originComparison ? `<p>Phase: ${e(view.originComparison.phase)}</p>${evidence('Origin comparison progress and result', view.originComparison)}` : '<p>Not run.</p>'}</div></details>
    <details class="advanced" data-disclosure-key="evidence-desk"><summary>Evidence desk, exports and session lifecycle</summary><p>Operations, acceptance, completion, publication and recovery are distinct observations.</p>
    <ul class="session-log" aria-live="polite">${operations || '<li>No operations yet.</li>'}</ul>
    ${active ? '<div class="compact-links"><a href="/export.html" download="city-session.html">Save read-only HTML</a><a href="/export.json" download="city-session.json">Save public evidence JSON</a></div>' : ''}
    <p class="small">Licensed exports contain receipts only, never answers or private request/card bytes. Authored fixture answers can be saved. A stopped ephemeral chain cannot be reread from an export alone.</p>
    ${form('reset', 'Reset this local session', {}, '', view.status === 'closed' || view.status === 'resetting')}<p class="small">Reset cancels work, waits for owned cleanup and starts a new generation. It does not replenish a licensed spend allowance.</p>${evidence('Limits and exact scope', view.limitations)}
    <div class="footer-note"><p><strong>Build on the route, not a badge.</strong> Bring a specialist service, try a different discovery or reviewer policy, and compare what the evidence actually changes. Town can add scoped workflow-test evidence; Fest Town is a possible future adversarial scenario source, not an integration here.</p>
    <p class="small">Local Ethereum, simulated operators/shared inference, fictional city options. Maps, events and transit feeds remain future connectors. This is a reference application, not an official NANDA release or a live booking service.</p></div></details>
    <details class="advanced" data-disclosure-key="journey"><summary>Five-step journey status</summary><nav aria-label="Journey" class="journey">${stages.map((step, index) => `<div data-state="${step.state}"><a href="#${step.target}" data-panel-link="${step.target === 'choose' ? 'discover' : step.target}"><span class="journey-top">${String(index + 1).padStart(2, '0')} · ${step.state}</span><strong>${e(step.label)}</strong><small>${e(step.note)}</small></a></div>`).join('')}</nav></details></section></div></div></div></main>${script}</body></html>`;
}
