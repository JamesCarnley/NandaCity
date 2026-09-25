import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syntheticEveningPlan } from '../../src/a2a/answer.js';
import type { SixServiceJourneyResult } from '../../src/demo/sixServiceJourney.js';
import { encodeStatement } from '../../src/interaction/bytes.js';
import { buildReportViewModel } from '../../src/report/viewModel.js';
import { renderStaticReport } from '../../src/report/renderHtml.js';
import { writeStaticReport } from '../../src/report/writeReport.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

function fixtureResult(): SixServiceJourneyResult {
  const { request } = makeInteractionFixture();
  const alternatives = (['food', 'culture', 'travel-value'] as const).flatMap((emphasis, operatorIndex) =>
    (['Chicago', 'Boston'] as const).map((city, cityIndex) => {
      const agent = { ...request.service.agent, agentId: String(operatorIndex * 2 + cityIndex + 1) };
      const cityRequest = { ...request, service: { ...request.service, agent },
        input: { ...request.input, city,
          timeWindow: { ...request.input.timeWindow,
            timeZone: city === 'Chicago' ? 'America/Chicago' as const : 'America/New_York' as const,
            start: city === 'Chicago' ? '2026-10-02T18:00:00-05:00' : '2026-10-02T18:00:00-04:00',
            end: city === 'Chicago' ? '2026-10-02T22:00:00-05:00' : '2026-10-02T22:00:00-04:00' } } };
      const payloadBase64 = Buffer.from(encodeStatement(cityRequest).bytes).toString('base64');
      const answerBase64 = Buffer.from(syntheticEveningPlan(cityRequest, emphasis)).toString('base64');
      return { city, emphasis, operatorIndex, agent,
        ownerAddress: (`0x${String(operatorIndex + 1).repeat(40)}` as `0x${string}`),
        runtimeAddress: request.profileBasis.receiptSigner,
        success: { report: { evidenceUsable: true, execution: 'completed', contentValidation: 'not-tested',
          discovery: { status: 'verified' },
          request: { cryptography: 'valid' }, acceptance: { cryptography: 'valid' },
          completion: { cryptography: 'valid', answerBinding: 'matched', terminalOutcome: 'completed' } },
          evidence: { request: { version: '0.1', scheme: 'eip712-eoa', signer: request.caller,
            payloadBase64, signature: `0x${'11'.repeat(65)}` }, answerBase64,
            task: { id: `task-${agent.agentId}` },
            basisObservation: { blockNumber: '17', blockHash: `0x${'ab'.repeat(32)}` },
            observedAt: '2026-09-24T12:00:00Z' } } };
    }));
  return { mode: 'local-fixture', indexSourceCommit: '94dca70',
    indexOrigins: { A: 'http://127.0.0.1:1', B: 'http://127.0.0.1:2' },
    alternatives, retry: { agent: alternatives[0]!.agent, taskId: 'task-1', sameTask: true },
    fault: { agent: alternatives[0]!.agent,
      report: { evidenceUsable: true, execution: 'failed', discovery: { status: 'verified' },
        acceptance: { cryptography: 'valid' }, completion: { cryptography: 'valid', terminalOutcome: 'failed' } },
      evidence: { task: { id: 'fault-1' }, answerBase64: undefined } },
    executionOrder: [], calls: { messageSend: 8, tasksGet: 7, exactRetries: 1 },
    independentProcessVerified: true, tamperRejected: true,
    cleanup: { ownedResourcesStopped: true }, limitations: ['Synthetic fixture limitation.']
  } as unknown as SixServiceJourneyResult;
}

test('view model retains three equal complete plans per city and distinguishes signed from quality', () => {
  const model = buildReportViewModel(fixtureResult());
  assert.deepEqual(model.cities.map((city) => [city.name, city.choices.length]),
    [['Chicago', 3], ['Boston', 3]]);
  for (const city of model.cities) for (const choice of city.choices) {
    assert.equal(choice.schedule.length, 2);
    assert.ok(choice.route.detail);
    assert.equal(choice.sources.length, 3);
    assert.equal(choice.unmetConstraints.length, 3);
    assert.match(choice.budget.estimatedTotal, /^\$/);
    assert.equal(choice.verification, 'Signed completion and answer bytes checked; plan quality not tested');
  }
  assert.equal(model.fault.outcome, 'Accepted, then failed');
  assert.equal(model.calls.messageSend, 8);
  assert.equal(model.calls.exactRetries, 1);
});

test('renderer escapes answer-derived script-shaped text and needs no network', () => {
  const result = fixtureResult();
  const answer = JSON.parse(Buffer.from(result.alternatives[0]!.success.evidence.answerBase64!,
    'base64').toString('utf8')) as { sources: Array<{ label: string }>; unmetConstraints: string[] };
  answer.sources[0]!.label = '</script><img src=x onerror=alert(1)>';
  answer.unmetConstraints[0] = '<svg onload=alert(2)>';
  result.alternatives[0]!.success.evidence.answerBase64 = Buffer.from(JSON.stringify(answer)).toString('base64');
  const html = renderStaticReport(buildReportViewModel(result), 'evidence.json');
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(2\)&gt;/);
  assert.doesNotMatch(html, /<img src=x|<svg onload|<script|https?:\/\/|fetch\(/i);
  assert.match(html, /href="\.\/evidence\.json"/);
  assert.match(html, /Synthetic.*recorded.*stopped/i);
  assert.match(html, /No ranking or winner/i);
});

test('view model rejects mismatched answer, request, operator, or evidence status', () => {
  const wrongAnswer = fixtureResult();
  const answer = JSON.parse(Buffer.from(wrongAnswer.alternatives[0]!.success.evidence.answerBase64!,
    'base64').toString('utf8')) as { city: string };
  answer.city = 'Boston';
  wrongAnswer.alternatives[0]!.success.evidence.answerBase64 = Buffer.from(JSON.stringify(answer)).toString('base64');
  assert.throws(() => buildReportViewModel(wrongAnswer), /answer city/i);

  const wrongRequest = fixtureResult();
  wrongRequest.alternatives[0]!.success.evidence.request =
    wrongRequest.alternatives[1]!.success.evidence.request;
  assert.throws(() => buildReportViewModel(wrongRequest), /signed request/i);

  const duplicate = fixtureResult();
  duplicate.alternatives[2]!.operatorIndex = 0;
  assert.throws(() => buildReportViewModel(duplicate), /operator/i);

  const unusable = fixtureResult();
  unusable.alternatives[0]!.success.report.evidenceUsable = false;
  assert.throws(() => buildReportViewModel(unusable), /usable/i);

  const wrongOwnerPair = fixtureResult();
  wrongOwnerPair.alternatives[1]!.ownerAddress = '0x7777777777777777777777777777777777777777';
  assert.throws(() => buildReportViewModel(wrongOwnerPair), /operator.*owner/i);

  const wrongFault = fixtureResult();
  wrongFault.fault.agent = wrongFault.alternatives[2]!.agent;
  assert.throws(() => buildReportViewModel(wrongFault), /fault.*agent/i);
});

test('writer keeps exact result JSON beside HTML and refuses overwrite before running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-static-report-test-'));
  try {
    const htmlPath = join(directory, 'report.html');
    const evidencePath = join(directory, 'evidence.json');
    const result = fixtureResult();
    await writeStaticReport(async () => result, { htmlPath, evidencePath });
    const json = await readFile(evidencePath, 'utf8');
    assert.equal(json, `${JSON.stringify(result, null, 2)}\n`);
    assert.match(await readFile(htmlPath, 'utf8'), /href="\.\/evidence\.json"/);
    let ran = false;
    await assert.rejects(writeStaticReport(async () => { ran = true; return result; },
      { htmlPath, evidencePath }), /exists|EEXIST/i);
    assert.equal(ran, false);
    assert.equal(await readFile(evidencePath, 'utf8'), json);

    const otherHtml = join(directory, 'other.html');
    await assert.rejects(writeStaticReport(async () => { ran = true; return result; },
      { htmlPath: otherHtml, evidencePath }), /exists|EEXIST/i);
    assert.equal(ran, false);
    await assert.rejects(readFile(otherHtml), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('writer removes only its reserved files if production or presentation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-static-report-rollback-'));
  try {
    const htmlPath = join(directory, 'report.html');
    const evidencePath = join(directory, 'evidence.json');
    await assert.rejects(writeStaticReport(async () => { throw new Error('producer failed'); },
      { htmlPath, evidencePath }), /producer failed/);
    await assert.rejects(readFile(htmlPath), { code: 'ENOENT' });
    await assert.rejects(readFile(evidencePath), { code: 'ENOENT' });

    const bad = fixtureResult();
    bad.alternatives[0]!.success.report.evidenceUsable = false;
    await assert.rejects(writeStaticReport(async () => bad, { htmlPath, evidencePath }),
      /usable signed evidence/);
    await assert.rejects(readFile(htmlPath), { code: 'ENOENT' });
    await assert.rejects(readFile(evidencePath), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
