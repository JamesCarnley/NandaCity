import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoEveningInput, withDemoSession, type DemoSession, type SessionAction, type SessionView } from './sessionController.js';
import { prepareOpenClawExecutorFactory } from './openclaw.js';
import { renderSessionView } from '../report/sessionView.js';

/** An explicit local rehearsal, never part of an automatic test or CI run.
 * --openclaw spends the already configured model allowance; no source APIs,
 * public-chain writes or operator credentials are acquired here. */
export async function rehearseCity(indexCheckout: string, openclaw = false) {
  const options = openclaw ? { answerEngine: 'openclaw' as const, executionTimeoutMs: 60000,
    executor: await prepareOpenClawExecutorFactory() } : {};
  const steps: { step: string; outcome: string; detail?: unknown }[] = [];
  let snapshot!: SessionView;
  await withDemoSession(indexCheckout, async (session: DemoSession) => {
    await session.ready();
    const action = async (value: SessionAction, id: string) => {
      const result = await session.wait(session.start(value, id).id);
      assert.equal(result.state, 'completed', `rehearsal action ${id}`); return session.view();
    };
    for (const city of ['Chicago', 'Boston'] as const) {
      for (const [index, emphasis] of ['food', 'culture', 'travel-value'].entries()) {
        await action({ kind: 'refresh', city }, `find-${city}-${index}`);
        assert.equal(session.view().discovery!.selected.length, 3);
        const agentId = session.view().operators[index]!.services.find((s) => s.city === city)!.agentId;
        const candidate = session.view().discovery!.selected.find((c) => c.agent.agentId === agentId)!;
        session.select(candidate.service);
        const id = `ask-${city}-${index}`;
        const view = await action({ kind: 'invoke', reviewer: 'accepted', ...(openclaw ? { input: {
          ...demoEveningInput(city), preferences: [emphasis === 'travel-value' ? 'Keep costs low and travel simple.' : emphasis === 'culture' ? 'A memorable activity matters most.' : 'Dinner is the highlight.'] } } : {}) }, id);
        const invocation = view.invocations.find((v) => v.id === id)!;
        assert.equal(invocation.outcome, 'completed'); assert.equal(invocation.checkedResult, 'matched');
        const answer = JSON.parse(invocation.answer!);
        if (openclaw) assert.equal(answer.modelSynthesis.model, 'gpt-6-luna');
        steps.push({ step: `${city}: ${emphasis} service`, outcome: 'signed-completion-and-byte-check-matched', detail: {
          choice: answer.emphasis, ...(openclaw ? { model: answer.modelSynthesis.model, usage: answer.modelSynthesis.usage } : {}) } });
        const rated = await action({ kind: 'feedback', invocationId: id, value: 5 - index }, `review-${city}-${index}`);
        const feedback = rated.feedback.find((f) => f.invocationId === id)!;
        assert.equal(feedback.readBack, 'matched'); assert.equal(feedback.publication, 'observed');
        assert.deepEqual(feedback.retained, { A: true, B: true }); assert.equal(feedback.weighting, 'contributing');
      }
    }
    await action({ kind: 'refresh', city: 'Chicago' }, 'ranking');
    assert.equal(session.view().discovery!.ranking.policyResult!.selection.rated.length, 3);
    steps.push({ step: 'Scoped signed feedback changes selection', outcome: 'three-rated-alternatives' });
    await action({ kind: 'fresh-consumer' }, 'fresh-before-fault'); assert.equal(session.view().freshConsumer!.status, 'matched');
    await action({ kind: 'index', index: 'A', state: 'stop' }, 'stop-A');
    await action({ kind: 'refresh', city: 'Chicago' }, 'find-with-B'); assert.equal(session.view().discovery!.selected.length, 3);
    steps.push({ step: 'Index A stopped', outcome: 'three-authentic-services-discovered-through-B' });
    await action({ kind: 'index', index: 'A', state: 'restart' }, 'restore-A');
    await action({ kind: 'index', index: 'A', state: 'tamper' }, 'tamper-A');
    await action({ kind: 'index', index: 'B', state: 'stop' }, 'stop-B');
    await action({ kind: 'refresh', city: 'Chicago' }, 'find-tampered-only'); assert.equal(session.view().discovery!.selected.length, 0);
    steps.push({ step: 'Only altered Index A available', outcome: 'no-altered-candidate-accepted' });
    await action({ kind: 'index', index: 'A', state: 'restart' }, 'restore-real-A');
    await action({ kind: 'index', index: 'B', state: 'restart' }, 'restore-B');
    const oldIds = session.view().operators[0]!.services.map((s) => s.agentId);
    await action({ kind: 'recover', operatorId: 'operator-1' }, 'recover-food');
    assert.deepEqual(session.view().operators[0]!.services.map((s) => s.agentId), oldIds);
    assert.equal(session.view().operators[0]!.recovery!.retiredOwnerRejected, true);
    await action({ kind: 'refresh', city: 'Chicago' }, 'find-migrated');
    const chosen = session.view().discovery!.selected.find((c) => c.agent.agentId === oldIds[0])!; session.select(chosen.service);
    await action({ kind: 'invoke', reviewer: 'accepted' }, 'ask-migrated');
    assert.equal(session.view().invocations.at(-1)!.outcome, 'completed'); assert.equal(session.view().invocations.at(-1)!.checkedResult, 'matched');
    steps.push({ step: 'Backup recovery and endpoint migration', outcome: 'same-two-identities-new-owner-runtime-endpoints-and-completed-invocation' });
    await action({ kind: 'refresh', city: 'Chicago' }, 'freeze-after-migration');
    await action({ kind: 'stop-providers' }, 'stop-service-endpoints');
    await action({ kind: 'fresh-consumer' }, 'fresh-after-provider-loss'); assert.equal(session.view().freshConsumer!.status, 'matched');
    steps.push({ step: 'Provider endpoints stopped', outcome: 'retained-evidence-recomputed-with-live-card-host-and-local-RPC' });
    await action({ kind: 'origin-comparison' }, 'origin-alternative');
    assert.equal(session.view().originComparison!.result!.freshMatched, true);
    steps.push({ step: 'Explicit chain-free comparison', outcome: 'separate-origin-authority-profile-reconstructed' });
    snapshot = session.view();
  }, options);
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-rehearsal-'));
  await writeFile(join(directory, 'session.html'), renderSessionView(snapshot), { mode: 0o600 });
  await writeFile(join(directory, 'session.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  const result = { mode: openclaw ? 'real-openclaw-over-authored-fictional-data' : 'authored-fixture',
    finishedAt: new Date().toISOString(), steps, artifacts: directory,
    qualification: 'One host, simulated custody, local Anvil, no live source facts. Saved snapshots do not replace the stopped chain/card authority source.' };
  await writeFile(join(directory, 'rehearsal.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== '--index-checkout' || !args[1] || !isAbsolute(args[1]) ||
      (args.length !== 2 && !(args.length === 3 && args[2] === '--openclaw'))) {
    process.stderr.write('Usage: npm run demo:rehearse -- --index-checkout /absolute/path [--openclaw]\n'); process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await rehearseCity(args[1], args[2] === '--openclaw'), null, 2) + '\n'); }
    catch { process.stderr.write('City rehearsal failed. No complete-demo claim; owned cleanup was awaited.\n'); process.exitCode = 1; }
  }
}
