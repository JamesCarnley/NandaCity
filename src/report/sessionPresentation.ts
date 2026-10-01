import type { SessionView, SessionInvocation } from '../demo/sessionController.js';
import type { CandidateResult } from '../reputation/policy.js';

export type JourneyStep = { label: string; state: 'done' | 'current' | 'waiting' | 'unresolved'; note: string; target: string };

/** Presentation state is derived only from observations already exposed by the controller. */
export function journey(view: SessionView): JourneyStep[] {
  const ranking = view.discovery?.ranking;
  const compared = !!view.discovery && ranking?.snapshot === 'matched' && !!ranking.policyResult &&
    (view.discovery.status === 'complete' || (view.discovery.status === 'partial' && view.discovery.selected.length > 0));
  const selectedNow = compared && !!view.selection && view.discovery!.selected.some((item) => item.service === view.selection);
  const currentServices = new Set(view.discovery?.selected.map((item) => item.service) ?? []);
  const latestRequest = compared ? [...view.invocations].reverse().find((item) => selectedNow ? item.service === view.selection :
    !view.selection && currentServices.has(item.service)) : undefined;
  const chosen = selectedNow || (!!latestRequest && !view.selection);
  const asked = !!latestRequest && latestRequest.outcome === 'completed' && latestRequest.checkedResult === 'matched';
  const reviewed = asked && view.feedback.some((item) => item.invocationId === latestRequest.id &&
    item.publication === 'observed' && item.readBack === 'matched');
  const resilience = view.operators.some((item) => !!item.recovery) || view.freshConsumer?.status === 'matched' ||
    view.operations.some((item) => item.kind === 'index' && item.state === 'completed');
  const unresolved = !!view.discovery && !compared;
  return [
    { label: 'Discover', state: compared ? 'done' : unresolved ? 'unresolved' : 'current', note: compared ? `${view.discovery!.eligibleCount} verified candidates${view.discovery!.status === 'partial' ? ' with partial Index coverage' : ''} at a frozen observation` : unresolved ? 'Comparison incomplete or ranking changed' : 'Choose Chicago or Boston', target: 'discover' },
    { label: 'Choose', state: chosen ? 'done' : compared ? 'current' : 'waiting', note: selectedNow ? 'Specialist selected; no request sent by selection' : latestRequest ? 'You chose a specialist in this city' : 'Compare the complete plans', target: 'choose' },
    { label: 'Ask', state: asked ? 'done' : chosen ? 'current' : 'waiting', note: asked ? 'A completed answer passed the byte check' : 'Send a signed request directly to one operator', target: 'ask' },
    { label: 'Review', state: reviewed ? 'done' : asked ? 'current' : 'waiting', note: reviewed ? 'Feedback publication and read-back observed' : 'Rate an observed result', target: 'review' },
    { label: 'Try resilience', state: resilience ? 'done' : reviewed ? 'current' : 'waiting', note: resilience ? 'At least one local control completed; compare again for its effect' : 'Test Index loss or operator recovery', target: 'resilience' },
  ];
}

export function currentMoment(view: SessionView): { title: string; detail: string; tone: 'pending' | 'warning' | 'calm' } {
  const latest = view.operations.at(-1);
  if (view.status === 'starting') return { title: 'The city is getting ready', detail: 'Preparing the local chain, three simulated operators and two real Index processes. No request has been sent.', tone: 'pending' };
  if (view.status === 'resetting') return { title: 'Resetting this session', detail: 'Owned work is being cancelled and cleaned up before the next generation starts.', tone: 'pending' };
  if (view.status === 'failed' || latest?.state === 'failed') return { title: 'An action could not complete', detail: latest?.error ?? 'The session is unavailable. The operation list below preserves what was observed.', tone: 'warning' };
  if (latest?.state === 'queued' || latest?.state === 'running') return { title: `${latest.kind.replace(/-/g, ' ')} in progress`, detail: 'This is still pending. The diagram is explanatory; completion appears only after an observed result.', tone: 'pending' };
  if (view.discovery && view.discovery.ranking.snapshot !== 'matched') return { title: 'Comparison needs a fresh look', detail: 'Candidates may be present, but the ranking basis is unavailable or changed. Compare this city again before choosing or asking.', tone: 'warning' };
  const steps = journey(view), current = steps.find((step) => step.state === 'current' || step.state === 'unresolved');
  return { title: current ? `Now: ${current.label.toLowerCase()}` : 'Your local journey is ready', detail: current?.note ?? 'You can explore resilience controls or compare another city. No action runs until you choose it.', tone: 'calm' };
}

export function requestMilestones(item: SessionInvocation): { label: string; state: 'observed' | 'pending' | 'unresolved' | 'failed' }[] {
  return [
    { label: 'Signed request', state: item.sent ? 'observed' : 'pending' },
    { label: item.accepted ? 'Acceptance observed' : 'Acceptance not observed', state: item.accepted ? 'observed' : item.outcome === 'unresolved' ? 'unresolved' : 'pending' },
    { label: item.outcome === 'completed' ? 'Provider completed' : item.outcome === 'failed' ? 'Provider reported failure' : item.outcome === 'unresolved' ? 'Request unresolved' : 'Provider result pending', state: item.outcome === 'completed' ? 'observed' : item.outcome === 'failed' ? 'failed' : item.outcome === 'unresolved' ? 'unresolved' : 'pending' },
    { label: item.checkedResult === 'matched' ? 'Result byte-checked' : item.checkedResult === 'mismatched' ? 'Result bytes mismatched' : 'Result not checked', state: item.checkedResult === 'matched' ? 'observed' : item.checkedResult === 'mismatched' ? 'failed' : item.checkedResult === 'unavailable' ? 'unresolved' : 'pending' },
  ];
}

export function rankExplanation(candidate: CandidateResult | undefined) {
  if (!candidate) return null;
  const exclusions = candidate.reviews.filter((review) => review.reason !== 'contributing');
  const curator = candidate.admissions.filter((item) => item.kind === 'curator' && item.reason === 'accepted').length;
  const town = candidate.admissions.filter((item) => item.kind === 'test' && item.reason === 'accepted').length;
  return { curator, town, exclusions, contributing: candidate.reviews.filter((review) => review.reason === 'contributing').length };
}
