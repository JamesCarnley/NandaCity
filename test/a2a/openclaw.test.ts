import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeInteractionFixture } from '../interaction/fixtures.js';

const request = () => structuredClone(makeInteractionFixture().request);
const decision = { choice: 'culture', summary: 'A simpler dinner leaves room for the exhibition.', tradeoffs: ['Less attention on dinner.'], uncertainties: ['Hours and accessibility are not checked.'] };
function response(value: unknown = decision) {
  return JSON.stringify({ status: 'ok', summary: 'completed', result: { payloads: [{ text: JSON.stringify(value) }], meta: {
    aborted: false, stopReason: 'stop', agentMeta: { provider: 'openai', model: 'gpt-6-luna',
      usage: { input: 7500, output: 120, cacheRead: 0, total: 7620 }, terminalReceipt: { successfulToolNames: [], rerouted: false } } } } });
}

test('OpenClaw choice uses supplied fictional options without receiving signing or authority material', async () => {
  const api = await import('../../src/demo/openclaw.js').catch(() => undefined);
  assert.ok(api?.buildSpecialistPrompt, 'bounded OpenClaw adapter must exist');
  const prompt = api.buildSpecialistPrompt(request().input, 'food');
  assert.match(prompt, /fictional/); assert.match(prompt, /Chicago Fixture Kitchen/); assert.match(prompt, /Chicago Fixture Gallery/);
  assert.equal(prompt.includes('Boston'), false);
  for (const key of ['profileBasis', 'receiptSigner', 'interactionId', 'requestDigest', 'privateKey']) assert.equal(prompt.includes(key), false);
  const answer = JSON.parse(new TextDecoder().decode(api.composeSpecialistAnswer(request().input, 'food', response())));
  assert.equal(answer.liveDataChecked, false); assert.equal(answer.emphasis, 'culture');
  assert.equal(answer.modelSynthesis.specialist, 'food'); assert.equal(answer.modelSynthesis.text, decision.summary);
  assert.deepEqual(answer.schedule.map((s: { place: string }) => s.place), ['Chicago Fixture Counter', 'Chicago Fixture Gallery']);
  assert.equal(answer.budget.estimatedTotalMinorUnits, 6200);
  assert.deepEqual(answer.modelSynthesis.usage, { input: 7500, output: 120, cacheRead: 0, total: 7620 });
});

test('malformed, unaccounted, tool-using or invented choices cannot become a signed success answer', async () => {
  const api = await import('../../src/demo/openclaw.js').catch(() => undefined); assert.ok(api?.composeSpecialistAnswer);
  const corruptions = [response({ ...decision, choice: 'invented-restaurant' }), response({ ...decision, verified: true }),
    response({ ...decision, summary: 'x'.repeat(1001) }), 'not JSON',
    response().replace('"aborted":false', '"aborted":true'), response().replace('"successfulToolNames":[]', '"successfulToolNames":["browser"]'),
    response().replace('"input":7500', '"input":75000'), response().replace('"output":120', '"output":-1'),
    response().replace('"status":"ok"', '"status":"error"')];
  for (const value of corruptions) assert.throws(() => api.composeSpecialistAnswer(request().input, 'food', value));
});

test('OpenClaw preflight refuses personal mounts, unpinned images, host networking and public gateway ports', async () => {
  const api = await import('../../src/demo/openclaw.js');
  const container = { Config: { Image: 'ghcr.io/openclaw/openclaw:2026.9.6' }, State: { Running: true },
    HostConfig: { Privileged: false, Binds: null, NetworkMode: 'bridge', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      PortBindings: { '18789/tcp': [{ HostIp: '127.0.0.1', HostPort: '18790' }] } },
    Mounts: [{ Type: 'volume', Name: 'nanda-city-openclaw-state', Destination: '/home/node/.openclaw' }] };
  api.verifyOpenClawContainer(container);
  for (const patch of [ { ...container, Config: { Image: 'openclaw:latest' } },
    { ...container, Mounts: [...container.Mounts, { Type: 'bind', Name: 'personal', Destination: '/personal' }] },
    { ...container, State: { Running: false } },
    { ...container, HostConfig: { ...container.HostConfig, NetworkMode: 'host' } },
    { ...container, HostConfig: { ...container.HostConfig, PortBindings: { '18789/tcp': [{ HostIp: '0.0.0.0', HostPort: '18790' }] } } } ])
    assert.throws(() => api.verifyOpenClawContainer(patch), /dedicated isolated/);
});

const fixture = fileURLToPath(new URL('./fixtures/openclaw-process.mjs', import.meta.url));
test('bounded remote supervisor returns exact stdout and terminates its real child on cancellation', async () => {
  const api = await import('../../src/demo/openclawProcess.js').catch(() => undefined); assert.ok(api?.runSupervisedProcess);
  const launch = (mode: string, signal: AbortSignal) => api.runSupervisedProcess({ executable: process.execPath,
    args: ['--input-type=module', '-e', api.OPENCLAW_SUPERVISOR, '--', process.execPath, fixture, mode],
    signal, prompt: 'test prompt', deadlineMs: 3000 });
  assert.equal(await launch('success', new AbortController().signal), 'synthetic-provider-output');
  await assert.rejects(launch('overflow', new AbortController().signal), /unavailable/);
  await assert.rejects(launch('fail', new AbortController().signal), /unavailable/);
  const directory = await mkdtemp(join(tmpdir(), 'city-openclaw-process-')), marker = join(directory, 'owned-child.pid');
  try {
    const controller = new AbortController();
    const pending = api.runSupervisedProcess({ executable: process.execPath,
      args: ['--input-type=module', '-e', api.OPENCLAW_SUPERVISOR, '--', process.execPath, fixture, 'wait', marker],
      signal: controller.signal, prompt: 'test prompt', deadlineMs: 3000 });
    // Register rejection immediately; wait on the child's actual readiness marker.
    const rejected = assert.rejects(pending, /cancelled|unavailable/);
    const deadline = Date.now() + 2000; let pid: number | undefined;
    while (Date.now() < deadline && !pid) { try { pid = Number(await readFile(marker, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 10)); } }
    assert.ok(pid, 'owned child actually launched'); controller.abort(new Error('test cancellation')); await rejected;
    assert.throws(() => process.kill(pid!, 0), /ESRCH/, 'remote child is gone before cancellation settles');
  } finally { await rm(directory, { recursive: true, force: true }); }
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(launch('success', preAborted.signal));
});
