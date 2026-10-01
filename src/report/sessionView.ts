import { randomUUID } from 'node:crypto';
import type { SessionView } from '../demo/sessionController.js';
import type { LiveAnswer } from '../live/answer.js';
import { journey, currentMoment, requestMilestones, rankExplanation } from './sessionPresentation.js';
import { sessionStyles } from './sessionStyles.js';
import { sessionClient } from './sessionClient.js';

export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const e = escapeHtml;
const evidence = (title: string, value: unknown) => `<details><summary>${e(title)}</summary><pre>${e(JSON.stringify(value, null, 2))}</pre></details>`;
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
function fixtureAnswer(raw: string): string {
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
      ${evidence('Exact authored fixture evidence', answer)}</section>`;
  } catch { return '<p>Answer could not be displayed. Receipt evidence remains below.</p>'; }
}
export type SessionRenderOptions = { token: string; nonce: string;
  content?: ReadonlyMap<string, { answer: LiveAnswer; expiresAt: string }>; message?: string };
/** Accepts only the explicit public projection. No controller/private input can be serialized here. */
export function renderSessionView(view: SessionView, options?: SessionRenderOptions): string {
  const active = !!options, ready = view.status === 'ready';
  const busy = view.operations.some((op) => op.state === 'running' || op.state === 'queued');
  const form = (action: string, label: string, values: Record<string, string> = {}, body = '', disabled = !ready || busy): string => !options ? '' :
    `<form method="post" action="/action"${action === 'invoke' ? ' data-ask-form' : ''}><input type="hidden" name="token" value="${e(options.token)}"><input type="hidden" name="generation" value="${view.generation}">
    <input type="hidden" name="operationId" value="${randomUUID()}"><input type="hidden" name="action" value="${e(action)}">
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
        <details class="evidence-details"><summary>Why this position?</summary><ul class="reason-list"><li><b>Scope</b> ${e(policy?.scope.city)} · ${e(policy?.scope.task)}</li>
        <li><b>Policy</b> ${e(policy?.policy.id)} · ${e(policy?.policy.reviewers.join(', ') || 'no accepted reviewers')}</li>
        <li><b>Contributing</b> ${ranked.interactionCount === 0 ? 'zero accepted interactions' : `${ranked.interactionCount} accepted interactions`}; ${e(explanation?.contributing ?? 0)} contributing reviews; declared groups: ${e(groupNames)}</li>
        <li><b>Admission</b> Curator inclusion: ${explanation?.curator ? 'observed' : 'not observed'}; Town test admission: ${explanation?.town ? 'observed' : 'not observed'}.</li>
        <li><b>Excluded here</b> ${explanation?.exclusions.length ? e(explanation.exclusions.map((item) => item.reason).join(', ')) : 'none in this candidate evidence'}.</li></ul>${evidence('Exact ranking evidence (JSON)', position)}</details>` : ''}
      <div class="card-footer">${candidate ? form('select', chosen ? 'Selected' : 'Select this specialist', { service: candidate.service }, '', !ready || busy || chosen || !rankingReady || !ranked) : ''}
      ${rankingReady && ranked ? '' : evidence('Why this position?', position)}${evidence('Operator and both city identities', operator)}</div></article>`;
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
      ${licensed ? content ? licensedAnswer(content.answer, content.expiresAt) : `<p>Content: ${e(item.receipt?.content.contentAvailability ?? 'unavailable')}. Semantic replay unavailable here; receipt/hash and earlier byte checks remain.</p>` : item.answer ? fixtureAnswer(item.answer) : '<p>No answer observed.</p>'}
      ${form('feedback', 'Publish demo feedback & compare again', { invocationId: item.id }, '<label>Usefulness <select name="value"><option value="5">5 — very useful</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1 — not useful</option></select></label>', !ready || busy || view.feedbackCapacity.exhausted || !['completed', 'failed'].includes(item.outcome) || item.checkedResult === 'mismatched')}
      ${item.outcome === 'unresolved' ? form('retry', 'Retry the same signed request', { invocationId: item.id }) : ''}
      ${evidence('Receipt and observed checks', { ...item, answer: null })}</article>`;
  }).join('');
  const feedback = view.feedback.map((f) => `<article class="feedback-card"><span class="eyebrow">Portable feedback</span><h3>Rating ${f.value}/5 · ${e(f.reviewer)} reviewer</h3><div class="feedback-meter" aria-hidden="true"><span style="width:${f.value * 20}%"></span></div><p>Signed: yes · Publication: ${e(f.publication)} · Read-back: ${e(f.readBack)} · Retained A/B: ${f.retained.A ? 'yes' : 'no'} / ${f.retained.B ? 'yes' : 'no'}</p><p>Effect on next selection: ${e(f.weighting)}.</p>
    ${['not-sent', 'unresolved'].includes(f.publication) ? form('retry-feedback', 'Retry prepared publication', { feedbackId: f.id }) : ''}${evidence('Feedback evidence', f)}</article>`).join('');
  const operations = view.operations.map((op) => `<li data-state="${e(op.state)}"><b>${e(op.kind.replace(/-/g, ' '))}</b> — ${e(op.state)}${op.error ? `: ${e(op.error)}` : ''}</li>`).join('');
  const stages = journey(view), moment = currentMoment(view);
  const activeKind = view.operations.at(-1)?.state === 'running' || view.operations.at(-1)?.state === 'queued' ? view.operations.at(-1)?.kind : null;
  const activity = activeKind === 'refresh' || activeKind === 'index' || activeKind === 'fresh-consumer' ? 'discovery' :
    activeKind === 'invoke' || activeKind === 'retry' ? 'request' : activeKind === 'feedback' || activeKind === 'retry-feedback' || activeKind === 'recover' ? 'chain' : 'none';
  const indexStatus = (i: number) => discovery?.origins?.[i]?.status ?? 'not compared';
  const policyTime = policy ? new Date(policy.observation.timestamp * 1000).toISOString() : null;
  const script = !options ? '' : `<script nonce="${e(options.nonce)}">window.__cityInitialStatus=${JSON.stringify({ generation: view.generation, status: view.status,
    operations: view.operations.map((op) => ({ id: op.id, state: op.state })) })};${sessionClient}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NANDA City — your agent, a city of expertise</title><style>${sessionStyles}</style></head><body>
    <main${active ? ' data-session-client' : ''} data-generation="${view.generation}" data-city="${e(discovery?.city ?? '')}" data-selection="${e(view.selection ?? '')}">
    <header class="hero"><div class="hero-top"><span class="brand">NANDA <span style="color:var(--teal)">CITY</span></span><span class="scope-chip">Local interactive prototype</span></div>
    <div class="hero-copy"><span class="eyebrow">An open network of specialist services</span><h1>Your agent. A city of expertise.</h1>
    <div class="hero-side"><p class="intro">Find a complete evening plan, choose whose evidence you value, ask directly, and leave feedback another client can inspect.</p><a class="hero-cta" href="#discover">Explore Chicago &amp; Boston <span aria-hidden="true">↘</span></a></div>
    <div class="scope-row"><span class="scope-chip">${licensed ? 'Licensed source-backed mode' : view.answerEngine === 'openclaw' ? 'Real OpenClaw reasoning · fictional demo data' : 'Synthetic fixture mode'}</span>
    <span class="scope-chip">Local Ethereum</span><span class="scope-chip">Two real Index processes</span><span class="scope-chip">Three simulated operators</span>${!active ? '<span class="scope-chip">Saved snapshot — no active controls</span>' : ''}</div></div>
    <div class="hero-stage" data-activity="${activity}"><svg class="skyline" viewBox="0 0 1200 180" preserveAspectRatio="none" aria-hidden="true"><path fill="#b4d5c1" d="M0 180V100h36V69h28v111h30V93h22V57h19v123h35V80h27v100h54V111h30V53h16v127h52V91h43v89h31V119h29V72h21v108h45V98h15V30h24v150h39V112h18v68h42V73h32v107h40V121h24V81h17v99h43V63h24v117h26V100h29v80h31V50h15v130h52V88h31v92h40V104h34v76h47V68h29v112h39V117h28v63z"/></svg>
    <div class="hero-stage-inner"><div class="scene-head"><div><span class="kicker">The working route</span><h2>Many services. Your choice.</h2></div><p>Arrows describe how this prototype works; only the status below reports an observed action.</p></div>
    <div class="scene" aria-label="Your agent searches two Indexes, checks owner records, then asks the chosen specialist directly"><div class="actor primary"><div class="actor-label">01 · Your side</div><svg class="actor-glyph" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="12" r="6" stroke="currentColor" stroke-width="2"/><path d="M8 34c1-10 7-14 12-14s11 4 12 14" stroke="currentColor" stroke-width="2"/></svg><strong>You → City demo client</strong><small>Your personal agent in this local demonstration. It compares choices and sends one signed request only when you press Ask.</small></div>
    <div class="flow discovery"><em>searches for services</em><span class="flow-line"></span></div>
    <div class="actor indexes"><div class="actor-label">02 · Discovery</div><strong>Two NANDA Indexes</strong><div class="index-pair"><div class="index-unit${indexStatus(0) !== 'complete' && discovery ? ' is-warning' : ''}"><b>Index A</b><span>${e(indexStatus(0))}</span></div><div class="index-unit${indexStatus(1) !== 'complete' && discovery ? ' is-warning' : ''}"><b>Index B</b><span>${e(indexStatus(1))}</span></div></div></div>
    <div class="flow direct"><em>candidate hints, then client checks records</em><span class="flow-line"></span></div>
    <div class="actor operators"><div class="actor-label">03 · Competing services</div><strong>Specialist operators</strong><div class="operator-lines"><div class="operator-line"><span class="operator-mark">✦</span>Food first · complete plan</div><div class="operator-line"><span class="operator-mark">◈</span>Culture first · complete plan</div><div class="operator-line"><span class="operator-mark">↗</span>Travel & value · complete plan</div></div></div></div>
    <div class="scene-under"><div class="fact request-route"><strong>Direct signed request:</strong> City demo client → chosen operator. Indexes help find candidates; they do not broker the A2A call or run the model.</div>
    <div class="fact chain-route"><strong>Local Ethereum records ownership</strong> and portable feedback commitments. The client checks those records; Ethereum does not choose the plan or judge quality.</div></div>
    <p class="legend">This is a local, same-host demonstration. The Indexes are replaceable; operator identity and feedback are checked against a frozen local-chain observation.</p></div></div>
    <div class="moment ${e(moment.tone)}" role="status"><div><strong>${e(moment.title)}</strong><p>${e(moment.detail)}</p></div><span class="moment-meta">${e(view.status)} · generation ${view.generation}</span></div>
    <nav aria-label="Journey" class="journey"><!-- five stages, never timer-driven -->${stages.map((step, index) => `<div data-state="${step.state}"><a href="#${step.target}"><span class="journey-top">${String(index + 1).padStart(2, '0')} · ${step.state}</span><strong>${e(step.label)}</strong><small>${e(step.note)}</small></a></div>`).join('')}</nav></header>
    ${options?.message ? `<p role="alert" class="notice">${e(options.message)}</p>` : ''}
    <section class="section" id="discover"><div class="section-head"><div><span class="eyebrow">01 · Discover</span><h2>Start with a city</h2></div><p>Each specialist can deliver dinner, an activity and transport. Index results are search hints; owner and card checks decide which candidates enter this comparison.</p></div>
    <div class="city-choice">${form('refresh', 'Chicago', { city: 'Chicago' }).replace('<button', `<button aria-current="${discovery?.city === 'Chicago'}"`)}${form('refresh', 'Boston', { city: 'Boston' }).replace('<button', `<button aria-current="${discovery?.city === 'Boston'}"`)}</div>
    <div class="observation-strip"><span>${discovery ? `${e(discovery.city)} · discovery ${e(discovery.status)} · ${discovery.eligibleCount} verified candidates` : 'Choose Chicago or Boston to get a frozen comparison'}</span>
    <span>${discovery ? `Frozen block ${e(discovery.observation.blockNumber)}; ${e(discovery.observation.blockHash)}.` : 'No frozen observation yet.'}</span></div>
    <p class="small">Coverage is bounded and Index-reported, not a guarantee of global history. A changed or unavailable ranking prevents new selection until you compare again.</p>
    ${discovery ? evidence('Discovery coverage, exact endpoints, policy and scoped Town evidence', discovery) : ''}</section>
    <section class="section" id="choose"><div class="section-head"><div><span class="eyebrow">02 · Choose</span><h2>Three full evenings, three emphases</h2></div><p>The order is this policy's result at one observed city and time, not a universal trust or safety ranking.</p></div>
    ${policy ? `<div class="observation-strip"><span>${e(policy.scope.city)} · ${e(policy.scope.task)}</span><span>Policy ${e(policy.policy.id)}</span><span>${e(Math.round(policy.algorithm.windowSeconds / 86400))}-day review window</span><span>Observed ${e(policyTime)}</span></div>` : '<p class="small">Compare a city to see the policy, accepted reviewers and observed ranking.</p>'}
    <div class="grid">${cards}</div><details class="reviewer-callout"><summary>Why doesn't every rating count?</summary><p>New reviewers can publish feedback, including negative ratings and free-service feedback, but this demo policy does not weight an unknown reviewer until its accepted-reviewer list admits them. Unknown does not mean malicious.</p>
    <p>Accepted reviewers: ${e(policy?.policy.reviewers.join(', ') || 'shown after comparison')}. Declared reviewer groups: ${e(policy?.policy.groups.map((group) => group.key).join(', ') || 'none')}. Curators: ${e(policy?.policy.curators.join(', ') || 'none')}. A curator inclusion can admit a newcomer; an actual scoped Town test admission is a separate kind of evidence, not a general quality badge.</p>
    <p>Signatures, a wallet or a payment can prove a statement or transaction, not that reviewers are independent or that an opinion is good. Excluded and unresolved reviews remain visible in each card's evidence.</p></details></section>
    <section class="section" id="ask"><div class="section-head"><div><span class="eyebrow">03 · Ask</span><h2>Ask one specialist directly</h2></div><p>Selection alone sends nothing. Your signed request goes to the selected operator, not through an Index.</p></div>
    <p>${selected ? 'Your specialist is selected.' : 'Select one of the verified specialists above.'} ${view.invocations.length === 0 ? 'No request has been sent.' : ''}</p>
    ${selected && !rankingReady ? `<p class="notice">${e(rankingGuidance)}</p>` : ''}
    ${selected ? `<div class="form-panel"><span class="eyebrow">Your evening brief</span>${(licensed || view.answerEngine === 'openclaw') ? '<p class="budget-note">Quick budgets for two: <span class="budget-presets"><button type="button" data-budget-minor="5000">$50</button><button type="button" data-budget-minor="8500">$85</button><button type="button" data-budget-minor="15000">$150</button></span>Or enter another dollar amount. Without JavaScript, the input remains in cents.</p>' : ''}${form('invoke', 'Ask this specialist', licensed ? { reviewer: view.licensedHint?.admittedReviewer ?? '' } : {}, inputFields, !ready || busy || !rankingReady)}</div>` : ''}
    ${selected && !licensed ? `<div class="secondary">${form('invoke-failure', 'Try a signed provider failure', { reviewer: 'accepted' }, '', !ready || busy || !rankingReady)}</div>` : ''}<div class="results">${invocations}</div></section>
    <section class="section" id="review"><div class="section-head"><div><span class="eyebrow">04 · Review</span><h2>Let experience travel</h2></div><p>Feedback is an opinion attached to a checked interaction. Publication, read-back and policy weight are separate observations.</p></div>
    ${feedback || '<p>No feedback yet. Ask a specialist, then rate the observed result.</p>'}
    ${feedback.length ? '<p class="small">Compare the city again to see whether the new review contributes. A single 5/5 can become a 3.67/5 policy score because this policy starts small samples near 3/5.</p>' : ''}
    <p class="small">A useful plan or a negative review can both be published; neither becomes a quality certificate merely by being signed.</p></section>
    <section class="section" id="resilience"><div class="section-head"><div><span class="eyebrow">05 · Try resilience</span><h2>What survives a broken route?</h2></div><p>These are real controls on owned local resources. Run a control, then compare the city again to observe the effect. Nothing below runs automatically.</p></div>
    <div class="resilience-grid"><div class="control-block"><h3>Lose an Index. Keep discovery.</h3><p>Stop A and compare. B can still return candidates. Tampering with A's records is rejected during verification; neither Index owns the service identity.</p><div class="bar">${form('index', 'Stop Index A', { index: 'A', state: 'stop' })}${form('index', 'Tamper with Index A', { index: 'A', state: 'tamper' })}${form('index', 'Stop Index B', { index: 'B', state: 'stop' })}${form('index', 'Recover Index A', { index: 'A', state: 'restart' })}${form('index', 'Recover Index B', { index: 'B', state: 'restart' })}</div>
      <p class="small">Latest comparison: A ${e(indexStatus(0))}; B ${e(indexStatus(1))}. Recover the Indexes before continuing. This is not a global availability claim.</p></div>
    <div class="control-block"><h3>Lose a signing key. Keep your identity.</h3><p>The specialist restores access and keeps its Chicago and Boston IDs, even as owner, signer and endpoints change.</p><p class="small">This uses a generated backup and fresh process on one host, not independent custody.</p>
      ${view.operators.map((op) => `<div class="bar"><span class="badge">${e(names[op.id] ?? op.label)}${op.recovery ? ' · recovered' : ''}</span>${form('recover', `Recover & migrate ${names[op.id] ?? op.label}`, { operatorId: op.id })}</div>${op.recovery ? `<p class="small">Retained identities: ${op.services.map((service) => `${e(service.city)} #${e(service.agentId)}`).join(' · ')}. Fresh-process restoration observed; old owner rejected.</p>` : ''}`).join('')}
      <div class="danger">${form('stop-providers', 'Stop provider endpoints')}</div></div>
    <div class="control-block"><h3>Recompute, don't take our word for it.</h3><p>A fresh consumer uses the same verifier and frozen raw evidence on this host. The separate card host and local RPC are still required; this is not offline proof or independent operation.</p>
      ${form('fresh-consumer', 'Recompute frozen ranking', {}, '', !ready || busy || !discovery)}${view.freshConsumer ? `<p class="status-pill">${e(view.freshConsumer.status)} — ${e(view.freshConsumer.reason)}</p>${evidence('Reconstruction observation', view.freshConsumer)}` : ''}</div>
    <div class="control-block"><h3>Compare another authority model.</h3><p>A separate synthetic HTTPS-origin exercise uses current TLS and finite signed snapshots. It has different continuity assumptions and is never an automatic fallback if Ethereum is unavailable.</p>
      ${form('origin-comparison', 'Run origin comparison')}${view.originComparison ? `<p>Phase: ${e(view.originComparison.phase)}</p>${evidence('Origin comparison progress and result', view.originComparison)}` : ''}</div></div></section>
    <section class="section"><div class="section-head"><div><span class="eyebrow">The evidence desk</span><h2>What the session actually observed</h2></div><p>Operations, acceptance, completion, publication and recovery are distinct. Open the exact record when you want to inspect a claim.</p></div>
    <ul class="session-log" aria-live="polite">${operations || '<li>No operations yet.</li>'}</ul>
    ${active ? '<div class="compact-links"><a href="/export.html" download="city-session.html">Save read-only HTML</a><a href="/export.json" download="city-session.json">Save public evidence JSON</a></div>' : ''}
    <p class="small">Licensed exports contain receipts only, never answers or private request/card bytes. Authored fixture answers can be saved. A stopped ephemeral chain cannot be reread from an export alone.</p>
    ${form('reset', 'Reset this local session', {}, '', view.status === 'closed' || view.status === 'resetting')}<p class="small">Reset cancels work, waits for owned cleanup and starts a new generation. It does not replenish a licensed spend allowance.</p>${evidence('Limits and exact scope', view.limitations)}
    <div class="footer-note"><p><strong>Build on the route, not a badge.</strong> Bring a specialist service, try a different discovery or reviewer policy, and compare what the evidence actually changes. Town can add scoped workflow-test evidence; Fest Town is a possible future adversarial scenario source, not an integration here.</p>
    <p class="small">Local Ethereum, simulated operators/shared inference, fictional city options. Maps, events and transit feeds remain future connectors. This is a reference application, not an official NANDA release or a live booking service.</p></div></section></main>${script}</body></html>`;
}
