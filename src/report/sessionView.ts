import { randomUUID } from 'node:crypto';
import type { SessionView } from '../demo/sessionController.js';
import type { LiveAnswer } from '../live/answer.js';

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
    };
    if (answer.kind !== 'synthetic-evening-plan' || answer.budget.currency !== 'USD') throw new Error('not a USD fixture');
    const dinner = answer.schedule.find((stop) => stop.role === 'dinner')!, activity = answer.schedule.find((stop) => stop.role === 'activity')!;
    const usd = (minorUnits: string | number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(BigInt(minorUnits)) / 100);
    const modes: Record<string, string> = { walk: 'Walking', 'public-transit': 'Public transit', bicycle: 'Bicycle', car: 'Car', taxi: 'Taxi' };
    return `<section class="answer"><h4>Authored fixture · not real city facts</h4><p>${e(answer.rationale)}</p>
      <h5>Dinner · ${e(dinner.place)}</h5><p>${e(dinner.detail)}</p>
      <h5>Evening activity · ${e(activity.place)}</h5><p>${e(activity.detail)}</p>
      <h5>Getting there · ${e(modes[answer.route.mode] ?? answer.route.mode)}</h5><p>${e(answer.route.from)} → ${e(answer.route.to)}.</p><p>${e(answer.route.detail)}</p>
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
    `<form method="post" action="/action"><input type="hidden" name="token" value="${e(options.token)}"><input type="hidden" name="generation" value="${view.generation}">
    <input type="hidden" name="operationId" value="${randomUUID()}"><input type="hidden" name="action" value="${e(action)}">
    ${Object.entries(values).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('')}${body}<button${disabled ? ' disabled' : ''}>${e(label)}</button></form>`;
  const discovery = view.discovery, policy = discovery?.ranking.policyResult;
  const rankingReady = discovery?.ranking.snapshot === 'matched' && !!policy;
  const rankingCondition = discovery?.ranking.snapshot === 'changed' ? 'Ranking observation changed' : 'Ranking unavailable';
  const rankingGuidance = `${rankingCondition}. Compare this city again before selecting or asking a specialist.`;
  const names: Record<string, string> = { 'operator-1': 'Food first', 'operator-2': 'Culture first', 'operator-3': 'Travel & value' };
  const descriptions: Record<string, string> = { 'operator-1': 'A complete evening with more attention on dinner.', 'operator-2': 'A complete evening built around an activity.', 'operator-3': 'A complete evening with simpler travel and lower example costs.' };
  const badges: Record<string, string> = { 'recommended-rated': 'Recommended · rated', 'recommended-newcomer': 'New · no accepted reviews',
    'recommended-unassessed': 'Unassessed', 'recommended-unresolved': 'Unresolved', explore: 'Explore', excluded: 'Disqualified' };
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
    return `<article class="card${chosen ? ' selected' : ''}"><span class="eyebrow">${e(operator.label)}</span><h3>${e(names[operator.id] ?? operator.label)}</h3>
      <p>${e(descriptions[operator.id] ?? 'Complete evening service.')}</p><p class="badge">${chosen ? 'Selected · ' : ''}${!discovery ? 'Choose a city to compare' : !candidate ? 'Missing from verified discovery' : !rankingReady || !ranked ? e(rankingCondition) : e(badges[ranked.view])}</p>
      ${candidate && (!rankingReady || !ranked) ? `<p>Present in verified discovery. ${e(rankingGuidance)}</p>` : ''}
      ${ranked ? `<p>${ranked.score ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(BigInt(ranked.score.numerator)) / Number(BigInt(ranked.score.denominator)))} / 5 policy score · ` : ''}${ranked.interactionCount} weighted interactions · ${ranked.groupCount} reviewer groups</p>` : ''}
      ${candidate ? form('select', chosen ? 'Selected' : 'Select this specialist', { service: candidate.service }, '', !ready || busy || chosen || !rankingReady || !ranked) : ''}
      ${evidence('Why this position?', position)}
      ${evidence('Operator and both city identities', operator)}</article>`;
  }).join('');
  const selected = discovery?.selected.find((c) => c.service === view.selection);
  const licensed = view.mode === 'licensed';
  const inputFields = licensed ? `<p>Admitted reviewer: ${e(view.licensedHint?.admittedReviewer)}. Policy expires ${e(view.licensedHint?.expiresAt)}.</p>
    <p id="input-help">Use future local dates with seconds and the city’s UTC offset; both must agree with its timezone. End must be after start, within 24 hours. No credentials here.</p>
    <label>Starts <input name="start" placeholder="YYYY-MM-DDT18:00:00-05:00" required aria-describedby="input-help"></label>
    <label>Ends <input name="end" placeholder="YYYY-MM-DDT22:00:00-05:00" required></label><label>Area <input name="area" maxlength="120" required></label>
    <label>Budget in cents (USD) <input name="budget" type="number" min="0" max="10000000" value="8500" required></label>
    <label>Transport <select name="transport"><option value="walk">Walk</option><option value="walk-and-public-transit">Walking + public transit</option><option value="public-transit">Public transit</option><option value="bicycle">Bicycle</option><option value="car">Car</option><option value="taxi">Taxi</option></select></label>
    <label>Preferences (one per line, at most 16) <textarea name="preferences" maxlength="4096"></textarea></label>` :
    `<p>A fixed fictional evening request is sent only when you press Ask.</p><label>Reviewer <select name="reviewer"><option value="accepted">Disclosed demo reviewer (weighted)</option><option value="new">New reviewer (unweighted)</option></select></label>`;
  const invocations = [...view.invocations].reverse().map((item) => {
    const content = options?.content?.get(item.id);
    return `<article class="result"><h3>Your ${licensed ? 'source-backed' : 'fixture'} request</h3><p>Sent: ${item.sent ? 'yes' : 'no'} · Accepted: ${item.accepted ? 'observed' : 'not observed'} · Provider result: ${e(item.outcome)} · Byte check: ${e(item.checkedResult)}</p>
      ${licensed ? content ? licensedAnswer(content.answer, content.expiresAt) : `<p>Content: ${e(item.receipt?.content.contentAvailability ?? 'unavailable')}. Semantic replay unavailable here; receipt/hash and earlier byte checks remain.</p>` : item.answer ? fixtureAnswer(item.answer) : '<p>No answer observed.</p>'}
      ${form('feedback', 'Publish demo feedback & compare again', { invocationId: item.id }, '<label>Usefulness <select name="value"><option value="5">5 — very useful</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1 — not useful</option></select></label>', !ready || busy || view.feedbackCapacity.exhausted || !['completed', 'failed'].includes(item.outcome) || item.checkedResult === 'mismatched')}
      ${item.outcome === 'unresolved' ? form('retry', 'Retry the same signed request', { invocationId: item.id }) : ''}
      ${evidence('Receipt and observed checks', { ...item, answer: null })}</article>`;
  }).join('');
  const feedback = view.feedback.map((f) => `<article><h3>Rating ${f.value}/5 · ${e(f.reviewer)} reviewer</h3><p>Signed: yes · Publication: ${e(f.publication)} · Read-back: ${e(f.readBack)} · Retained A/B: ${f.retained.A ? 'yes' : 'no'} / ${f.retained.B ? 'yes' : 'no'}</p><p>Effect on next selection: ${e(f.weighting)}.</p>
    ${['not-sent', 'unresolved'].includes(f.publication) ? form('retry-feedback', 'Retry prepared publication', { feedbackId: f.id }) : ''}${evidence('Feedback evidence', f)}</article>`).join('');
  const operations = view.operations.map((op) => `<li>${e(op.kind)} — ${e(op.state)}${op.error ? `: ${e(op.error)}` : ''}</li>`).join('');
  const script = !options ? '' : `<script nonce="${e(options.nonce)}">
    const clearExpired=()=>document.querySelectorAll('[data-expires]').forEach(el=>{if(Date.now()>=Date.parse(el.dataset.expires))el.replaceChildren(Object.assign(document.createElement('p'),{textContent:'Content expired. Receipt evidence remains; semantic replay is unavailable.'}));});
    clearExpired();setInterval(clearExpired,250);document.addEventListener('visibilitychange',clearExpired);window.addEventListener('pageshow',clearExpired);
    const initial=${JSON.stringify([view.generation, view.status, view.operations.map((o) => [o.id, o.state])])};
    setInterval(async()=>{try{const r=await fetch('/status',{cache:'no-store'});if(!r.ok)return;const s=await r.json();if(JSON.stringify([s.generation,s.status,s.operations.map(o=>[o.id,o.state])])!==JSON.stringify(initial))location.reload();}catch{}},1500);
    </script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NANDA City — choose your evening</title><style>body{overflow-wrap:anywhere}
    :root{color-scheme:light;--ink:#142b37;--muted:#46606b;--accent:#00665b;--line:#c6d3d6;--paper:#f6f5ef}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:32px 24px 80px}h1{font:600 clamp(2.2rem,5vw,4rem)/1.12 Georgia,serif;max-width:850px;margin:16px 0}h2{font:600 1.8rem/1.25 Georgia,serif;margin:0 0 16px}h3{line-height:1.25}h4,h5{font-size:1rem}p{max-width:80ch}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.78rem;color:var(--muted)}.intro{font-size:1.15rem;color:var(--muted)}.bar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.badge{font-size:.85rem;color:var(--accent);font-weight:700}.section{border-top:1px solid var(--line);margin-top:32px;padding-top:26px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card,.result{background:white;border:1px solid var(--line);border-radius:12px;padding:22px;min-width:0}.selected{border:2px solid var(--accent)}button{background:var(--accent);color:white;border:0;border-radius:6px;padding:12px 16px;font:600 .95rem system-ui;cursor:pointer}button:disabled{background:#d4dfdc;color:#425653;cursor:default}a{color:var(--accent)}:focus-visible{outline:3px solid #bd5a00;outline-offset:4px}label{display:block;margin:12px 0}input,select,textarea{display:block;width:100%;max-width:460px;padding:10px;border:1px solid #73858b;border-radius:5px;font:inherit}input[type=hidden]{display:none}form{margin:10px 0}summary{cursor:pointer;padding:12px 0;font-weight:600}details{border-top:1px solid #e0e6e4;margin-top:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;max-height:32rem;overflow:auto}.prose{font:inherit;max-height:none}.answer{background:#f1f6f3;padding:20px;margin:20px 0;border-radius:8px}.source{border-left:3px solid var(--accent);padding-left:14px}dt{font-size:.85rem;color:var(--muted)}dd{margin-left:12px;overflow-wrap:anywhere}.notice{background:#fff1ce;padding:14px;border-radius:6px}.results{display:grid;gap:18px}.small{font-size:.88rem;color:var(--muted)}@media(max-width:800px){.grid{grid-template-columns:1fr}main{padding:24px 16px}.card{padding:18px}}
    </style></head><body><main><header><span class="eyebrow">NANDA City · local service marketplace</span><h1>One evening. Three ways to make it yours.</h1>
    <p class="intro">Choose a city, compare complete-service specialists, ask one, and see how your feedback changes the next choice.</p>
    <div class="bar"><span class="badge">${licensed ? 'Licensed source-backed mode' : 'Synthetic fixture mode'}</span><span>${e(view.status)} · generation ${view.generation}</span>${!active ? '<strong>Saved snapshot — no active controls</strong>' : ''}</div>
    <p class="small">Three simulated operators, each owning both city identities. These are competing services, not three mandatory roles. Same-host generated custody; no independent-customer or safety claim.</p></header>
    ${options?.message ? `<p role="alert" class="notice">${e(options.message)}</p>` : ''}
    ${view.status === 'starting' ? '<p role="status" class="notice">Preparing local chain, operators and two Indexes. This can take about a minute. No request has been sent.</p>' : ''}
    <section class="section" aria-labelledby="choose"><h2 id="choose">1. Choose your city</h2><div class="bar">${form('refresh', 'Compare Chicago', { city: 'Chicago' })}${form('refresh', 'Compare Boston', { city: 'Boston' })}</div>
    <p>${discovery ? `${e(discovery.city)} · discovery ${e(discovery.status)} · ${discovery.eligibleCount} verified candidates. Coverage is bounded and Index-reported, not global history.` : 'Chicago and Boston are ready to explore. Select a city to get a frozen comparison.'}</p>
    <p class="small">Policy: ${e(policy?.policy.id ?? 'session-demo-reviewer-policy')} · disclosed demo reviewer and curator. ${discovery ? `Frozen block ${e(discovery.observation.blockNumber)}; ${e(discovery.observation.blockHash)}.` : 'No frozen observation yet.'}</p>
    <div class="grid">${cards}</div>${discovery ? evidence('Discovery coverage, exact endpoints, policy and scoped Town evidence', discovery) : ''}</section>
    <section class="section"><h2>2. Ask your selected specialist</h2><p>Selection alone sends nothing. ${selected ? 'Your specialist is selected.' : 'Select one of the verified specialists above.'}</p>
    ${selected && !rankingReady ? `<p>${e(rankingGuidance)}</p>` : ''}
    ${selected ? form('invoke', 'Ask this specialist', licensed ? { reviewer: view.licensedHint?.admittedReviewer ?? '' } : {}, inputFields, !ready || busy || !rankingReady) : ''}
    ${selected && !licensed ? form('invoke-failure', 'Try a signed provider failure', { reviewer: 'accepted' }, '', !ready || busy || !rankingReady) : ''}<div class="results">${invocations}</div></section>
    <section class="section"><h2>3. See what feedback changes</h2><p>A rating is an opinion, not a quality certificate. Only admitted reviewers with qualified evidence affect this policy. Missing, new, unassessed, unresolved and disqualified stay distinct.</p>${feedback || '<p>No feedback yet. Ask a specialist, then rate the observed result.</p>'}</section>
    <section class="section"><h2>Explore resilience</h2><p>These controls change owned local resources. After a fault or recovery, compare your city again to observe its effect.</p><details><summary>Index failures, migration and recovery</summary>
    <div class="bar">${form('index', 'Stop Index A', { index: 'A', state: 'stop' })}${form('index', 'Tamper with Index A', { index: 'A', state: 'tamper' })}${form('index', 'Stop Index B', { index: 'B', state: 'stop' })}${form('index', 'Recover Index A', { index: 'A', state: 'restart' })}${form('index', 'Recover Index B', { index: 'B', state: 'restart' })}${form('stop-providers', 'Stop provider endpoints')}</div>
    <p>Stop A, then B to observe both unavailable. Recovery restores the actual Index process; it does not make its rows authoritative.</p>${view.operators.map((op) => form('recover', `Recover & migrate ${names[op.id] ?? op.label}`, { operatorId: op.id })).join('')}<p>Recovery uses a generated backup in a fresh process, retires the old owner/runtime and changes endpoints while retaining both service IDs.</p></details>
    <details><summary>Recheck with a fresh consumer</summary><p>A fresh process using the same verifier on the same host reads frozen raw evidence. It is not an independent implementation, independent custody or an offline proof: the separate card host and local RPC remain required.</p>${form('fresh-consumer', 'Recompute the frozen ranking', {}, '', !ready || busy || !discovery)}${view.freshConsumer ? `<p>${e(view.freshConsumer.status)} — ${e(view.freshConsumer.reason)}</p>${evidence('Reconstruction observation', view.freshConsumer)}` : ''}</details>
    <details><summary>Compare explicit HTTPS-origin authority</summary><p>Separate synthetic Chicago comparison; current TLS and finite signed snapshots, not independently proven history. No native Town badge. Never an automatic fallback when Ethereum fails.</p>${form('origin-comparison', 'Run the origin comparison')}${view.originComparison ? evidence('Origin comparison progress and result', view.originComparison) : ''}</details></section>
    <section class="section"><h2>Session & evidence</h2><p>Operations report execution of a command separately from provider acceptance, completion and publication observations.</p><ul aria-live="polite">${operations || '<li>No operations yet.</li>'}</ul>
    ${active ? '<p><a href="/export.html" download="city-session.html">Save read-only HTML</a> · <a href="/export.json" download="city-session.json">Save public evidence JSON</a></p>' : ''}<p class="small">Licensed exports contain receipts only, never answers or private request/card bytes. Authored fixture answers can be saved. A stopped ephemeral chain cannot be reread from an export alone.</p>
    ${form('reset', 'Reset this local session', {}, '', view.status === 'closed' || view.status === 'resetting')}<p class="small">Reset cancels work, waits for owned cleanup, clears retained content and starts a new generation. It does not replenish a licensed spend allowance.</p>${evidence('Limits and exact scope', view.limitations)}<p class="small">Town observations, when supplied, name interface, endpoint/card and evaluator. No general safety or quality badge is inferred.</p></section></main>${script}</body></html>`;
}
