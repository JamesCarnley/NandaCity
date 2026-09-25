import type { ReportChoice, ReportViewModel } from './viewModel.js';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function e(value: string | number): string { return escapeHtml(String(value)); }

function choiceHtml(choice: ReportChoice, city: string, index: number): string {
  const schedule = choice.schedule.map((stop) => `<li><span class="step-kind">${e(stop.role)}</span>
    <h4>${e(stop.place)}</h4><p>${e(stop.detail)}</p></li>`).join('');
  const sources = choice.sources.map((source) => `<li>${e(source.label)} <span class="source-use">Supports: ${e(source.supports)}</span></li>`).join('');
  const unmet = choice.unmetConstraints.map((constraint) => `<li>${e(constraint)}</li>`).join('');
  return `<article class="choice" aria-labelledby="${e(city.toLowerCase())}-choice-${index}">
    <div class="choice-top"><span class="choice-number">Choice ${index}</span><span class="status">Recorded signed completion</span></div>
    <h3 id="${e(city.toLowerCase())}-choice-${index}">${e(choice.emphasis)}</h3>
    <p class="operator">${e(choice.operator)} · Agent ${e(choice.agentId)} · ${e(choice.area)}</p>
    <p class="rationale">${e(choice.rationale)}</p>
    <section aria-label="Evening plan"><h4 class="section-label">Dinner & activity</h4><ol class="schedule">${schedule}</ol></section>
    <section aria-label="Route"><h4 class="section-label">Route</h4><p><strong>${e(choice.route.from)} → ${e(choice.route.to)}</strong> · ${e(choice.route.mode)}</p>
      <p>${e(choice.route.detail)}</p><p class="small">Estimate: ${e(choice.route.estimate)}</p></section>
    <section aria-label="Example budget"><h4 class="section-label">Example budget</h4>
      <p class="budget-total">${e(choice.budget.estimatedTotal)} <span>of ${e(choice.budget.requested)} requested</span></p>
      <dl class="costs"><div><dt>Dinner</dt><dd>${e(choice.budget.dinner)}</dd></div>
        <div><dt>Activity</dt><dd>${e(choice.budget.activity)}</dd></div>
        <div><dt>Transport</dt><dd>${e(choice.budget.transport)}</dd></div></dl>
      <p class="small">Authored example, not a verified price or quote.</p></section>
    <section aria-label="Sources"><h4 class="section-label">Authored sources</h4><ul class="detail-list">${sources}</ul>
      <p class="small">Fixture reference: ${e(choice.retrievalAsOf)}. No live retrieval occurred.</p></section>
    <section aria-label="Unmet constraints"><h4 class="section-label">Unmet constraints</h4><ul class="detail-list">${unmet}</ul></section>
    <footer class="choice-proof"><strong>${e(choice.verification)}</strong>
      <span>Observed ${e(choice.observation.observedAt)} · local basis block ${e(choice.observation.blockNumber)}</span>
      <span class="hash">Block hash ${e(choice.observation.blockHash)}</span></footer>
  </article>`;
}

/** A complete static document: no scripts, remote assets, fetches, or runtime dependencies. */
export function renderStaticReport(model: ReportViewModel, evidenceFileName: string): string {
  if (!evidenceFileName || evidenceFileName === '.' || evidenceFileName === '..' ||
      evidenceFileName.includes('/') || evidenceFileName.includes('\\')) {
    throw new Error('evidence link must be a sibling file name');
  }
  const evidenceHref = `./${encodeURIComponent(evidenceFileName)}`;
  const cities = model.cities.map((city) => `<section class="city" aria-labelledby="${e(city.name.toLowerCase())}">
    <div class="city-heading"><div><p class="eyebrow">Three equal choices</p><h2 id="${e(city.name.toLowerCase())}">${e(city.name)}</h2></div>
      <p>All three answer the complete evening-plan request. Emphasis is configuration, not a measured quality score.</p></div>
    <div class="choice-grid">${city.choices.map((choice, index) => choiceHtml(choice, city.name, index + 1)).join('')}</div>
  </section>`).join('');
  const limitations = model.limitations.map((limit) => `<li>${e(limit)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>NANDA City · recorded comparison</title>
<style>
:root{color-scheme:light;--ink:#152929;--muted:#506463;--paper:#f3f1e9;--card:#fffefa;--line:#cad5cc;--accent:#0b645d;--warm:#ebc885}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.banner{position:sticky;top:0;z-index:2;background:#173e3c;color:#fff;padding:.65rem max(1rem,calc((100vw - 78rem)/2));font-size:.9rem;font-weight:700;letter-spacing:.02em;box-shadow:0 2px 8px #0002}
main{max-width:80rem;margin:auto;padding:1.5rem 1rem 4rem}.hero{padding:1.5rem 0 2rem;border-bottom:2px solid var(--ink)}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:.75rem;font-weight:800;color:var(--accent);margin:0 0 .3rem}
h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(2.3rem,7vw,4.5rem);line-height:1.04;letter-spacing:-.045em;max-width:15ch;margin-bottom:1rem}h2{font-size:clamp(1.8rem,4vw,2.7rem);line-height:1.1;margin-bottom:.25rem}h3{font-size:1.45rem;line-height:1.2;margin:.65rem 0 .3rem}h4{font-size:1rem}
.lede{font-size:1.12rem;max-width:62ch;color:#304d4a}.hero-tags{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.3rem 0}.hero-tags span{border:1px solid #8aa79b;border-radius:2rem;padding:.25rem .7rem;background:#e5eee5;font-size:.83rem;font-weight:650}
.evidence-link{display:inline-block;padding:.65rem 1rem;border-radius:.5rem;background:var(--accent);color:white;text-decoration:none;font-weight:750}.evidence-link:hover,.evidence-link:focus-visible{background:#073f3a;outline:3px solid var(--warm);outline-offset:2px}
.caveat{margin-top:1rem;padding:1rem;border-left:4px solid #a66a26;background:#fff7e8;max-width:70ch}.city{padding-top:2.5rem}.city-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin-bottom:1rem}.city-heading>p{max-width:35ch;color:var(--muted);margin-bottom:.2rem}
.choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}.choice{min-width:0;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1.2rem;box-shadow:0 3px 12px #163a2910}.choice-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.4rem;align-items:center}.choice-number{font-size:.76rem;text-transform:uppercase;letter-spacing:.11em;font-weight:800;color:var(--accent)}.status{font-size:.72rem;border:1px solid #b2c9b7;background:#e6f1e8;border-radius:1rem;padding:.13rem .45rem;color:#24543c}.operator,.small{color:var(--muted);font-size:.84rem}.rationale{min-height:5.5em}.section-label{text-transform:uppercase;letter-spacing:.09em;font-size:.75rem;color:var(--accent);border-top:1px solid var(--line);padding-top:.9rem;margin-bottom:.6rem}.choice section{margin-top:.35rem}.schedule{list-style:none;padding:0;margin:0}.schedule li{border-left:2px solid #bbd3c2;padding:0 0 .8rem .85rem;margin-left:.3rem}.schedule li:last-child{padding-bottom:0}.step-kind{text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-size:.72rem;font-weight:800}.schedule h4{margin:.1rem 0}.schedule p,.choice section p{margin-bottom:.5rem}.budget-total{font-size:1.5rem;font-weight:800}.budget-total span{display:block;font-size:.8rem;font-weight:500;color:var(--muted)}.costs{margin:.5rem 0}.costs div{display:flex;justify-content:space-between;border-bottom:1px dotted var(--line)}.costs dd{margin:0;font-variant-numeric:tabular-nums}.detail-list{padding-left:1.15rem;margin:.3rem 0}.detail-list li{margin:.3rem 0}.source-use{display:block;font-size:.78rem;color:var(--muted)}.choice-proof{margin-top:auto;padding-top:1rem;border-top:2px solid var(--line);display:grid;gap:.25rem;font-size:.75rem;color:var(--muted)}.choice-proof strong{color:#24543c}.hash{overflow-wrap:anywhere}
.audit{margin-top:2.5rem;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.audit article{background:#e5ede5;border-radius:.65rem;padding:1.1rem}.audit h2{font-size:1.25rem}.audit p{margin-bottom:.4rem}.audit .fault{background:#f5e8df}.limits{margin-top:2.5rem;padding:1.3rem;background:#e9e8de;border-radius:.65rem}.limits ul{padding-left:1.2rem}.limits li{margin:.45rem 0}.provenance{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere;margin-top:1.2rem}
@media(max-width:980px){.choice-grid{grid-template-columns:1fr 1fr}.rationale{min-height:0}}@media(max-width:650px){main{padding:1rem .8rem 3rem}.city-heading{display:block}.choice-grid,.audit{grid-template-columns:1fr}.choice{padding:1rem}.banner{font-size:.78rem;line-height:1.3}h1{max-width:none}.hero{padding-top:.7rem}}
</style></head><body>
<div class="banner" role="note">SYNTHETIC FIXTURE · RECORDED RESULT · LOCAL CHAIN & INDEXES STOPPED</div>
<main><header class="hero"><p class="eyebrow">NANDA City / local demonstration</p><h1>Six complete plans. No invented winner.</h1>
<p class="lede">Chicago and Boston each have three equal-weight, fictional evening-plan choices. Signed requests, acceptances and completions were checked while the owned local services were running. This saved page is a presentation of that recorded result, not live verification.</p>
<div class="hero-tags"><span>6 signed completions</span><span>2 cities × 3 choices</span><span>1 separate accepted fault</span><span>No ranking or winner</span></div>
<a class="evidence-link" href="${e(evidenceHref)}" download>Download original evidence JSON</a>
<p class="caveat"><strong>What verification means:</strong> signatures and answer-byte binding were checked against observed local authority and exact cards. Content quality, real availability, actual prices, travel time, accessibility and reputation were not checked. The stopped local chain cannot be independently re-read from this export alone.</p></header>
${cities}
<section class="audit" aria-label="Execution and fault"><article><h2>Retry & call cost</h2>
<p>Six plan calls plus one separate fault call; one exact retry returned the same task.</p>
<p><strong>${e(model.calls.messageSend)} message/send attempts</strong> · ${e(model.calls.tasksGet)} tasks/get polls · ${e(model.calls.exactRetries)} exact retry</p>
<p class="small">Retried task ${e(model.retry.taskId)} · same task: ${e(String(model.retry.sameTask))}. Comparing three choices costs three service calls per city.</p></article>
<article class="fault"><h2>Separate accepted failure</h2><p><strong>${e(model.fault.outcome)}</strong> for agent ${e(model.fault.agentId)}.</p>
<p class="small">Task ${e(model.fault.taskId)} has a signed failed completion and no successful answer. It is not one of the six plan choices.</p></article></section>
<section class="limits"><h2>Scope & limitations</h2><ul>${limitations}</ul>
<p>No ranking, endorsement, independent operator custody or live service claim follows from this fixture.</p></section>
<footer class="provenance">Pinned NANDA Index source commit: ${e(model.indexSourceCommit)}. The sibling JSON contains the unabridged recorded envelopes and exact signed answer bytes.</footer>
</main></body></html>\n`;
}
