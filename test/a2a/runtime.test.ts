import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decodeEnvelope, signProviderStatement, signRequest } from '../../src/interaction/signatures.js';
import { verifyInteraction } from '../../src/interaction/verify.js';
import { CityTaskStore } from '../../src/a2a/store.js';
import {
  CITY_REQUEST_DATA_TYPE,
  startLoopbackA2AService,
  type A2ATask,
  type JsonRpcResponse,
} from '../../src/a2a/service.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

const NOW = '2026-09-24T12:02:00Z';

type RpcId = string | number;

async function rpc(url: string, id: RpcId, method: string, params: unknown): Promise<JsonRpcResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  return response.json() as Promise<JsonRpcResponse>;
}

function sendParams(envelope: unknown, messageId = 'client-message-1') {
  return {
    message: {
      kind: 'message',
      role: 'user',
      messageId,
      parts: [{
        kind: 'data',
        data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope },
      }],
    },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
  };
}

function resultTask(response: JsonRpcResponse): A2ATask {
  assert.ok('result' in response, JSON.stringify(response));
  const task = response.result;
  assert.equal(typeof task, 'object');
  assert.ok(task !== null);
  return task as A2ATask;
}

function cityMetadata(task: A2ATask) {
  const metadata = task.metadata?.['org.nandacity'];
  assert.equal(typeof metadata, 'object');
  assert.ok(metadata !== null);
  return metadata as Record<string, unknown>;
}

function resultData(task: A2ATask) {
  const part = task.artifacts?.[0]?.parts[0];
  assert.equal(part?.kind, 'data');
  return (part as { kind: 'data'; data: Record<string, unknown> }).data;
}

async function pollTerminal(url: string, taskId: string): Promise<A2ATask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = resultTask(await rpc(url, `poll-${attempt}`, 'tasks/get', { id: taskId }));
    if (task.status.state === 'completed' || task.status.state === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task ${taskId} did not reach a terminal state`);
}

test('message/send persists acceptance before work and returns verifiable A2A 0.3 task evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const requestEnvelope = await signRequest(fixture.request, fixture.caller);
  const answerBytes = new TextEncoder().encode('{"version":"0.1","kind":"synthetic-evening-plan","city":"Chicago","liveDataChecked":false}');

  let serviceUrl = '';
  let observedSubmitted: A2ATask | undefined;
  const service = await startLoopbackA2AService({
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged',
      observedAt: NOW,
    }),
    now: () => NOW,
    execute: async (_request, context) => {
      const duringWork = await rpc(serviceUrl, 'poll-during-work', 'tasks/get', { id: context.taskId });
      observedSubmitted = resultTask(duringWork);
      return answerBytes;
    },
  });
  serviceUrl = service.url;
  t.after(() => service.close());

  const response = await rpc(service.url, 'rpc-request-7', 'message/send', sendParams(requestEnvelope));
  assert.deepEqual(response.id, 'rpc-request-7');
  const acceptedTask = resultTask(response);
  assert.equal(acceptedTask.kind, 'task');
  assert.equal(acceptedTask.status.state, 'submitted');
  assert.notEqual(acceptedTask.id, 'rpc-request-7');
  assert.notEqual(acceptedTask.id, 'client-message-1');
  assert.notEqual(acceptedTask.id, fixture.request.interactionId);
  const task = await pollTerminal(service.url, acceptedTask.id);
  assert.equal(observedSubmitted?.status.state, 'submitted');

  const metadata = cityMetadata(task);
  assert.equal(metadata.subset, 'a2a-0.3-jsonrpc-loopback');
  assert.equal(metadata.pollingAuthentication, 'none-loopback-only');
  const acceptance = metadata.acceptance;
  assert.ok(acceptance);
  const data = resultData(task);
  assert.equal(data.type, 'org.nandacity.city-result');
  assert.equal(data.answerBase64, Buffer.from(answerBytes).toString('base64'));
  assert.ok(data.completion);

  const finding = await verifyInteraction({
    request: requestEnvelope,
    acceptance,
    completion: data.completion,
    answerBytes,
    basisProfile: fixture.profile,
    currentProfile: fixture.profile,
    continuity: 'unchanged',
    observedAt: NOW,
  });
  assert.equal(finding.allPresentedEvidenceUsableAtObservation, true);
  assert.equal(finding.completion?.terminalOutcome, 'completed');

  const polled = await rpc(service.url, 8, 'tasks/get', { id: task.id });
  assert.deepEqual(resultTask(polled), task);
  const withoutHistory = resultTask(await rpc(service.url, 9, 'tasks/get', { id: task.id, historyLength: 0 }));
  assert.deepEqual(withoutHistory, { ...task, history: [] });
  assert.ok((await readdir(directory)).some((name) => name.endsWith('.json')));
});

test('exact concurrent replay accepts once, changed bytes conflict, and restart returns the same task', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const requestEnvelope = await signRequest(fixture.request, fixture.caller);
  let executions = 0;
  const options = {
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged' as const,
      observedAt: NOW,
    }),
    now: () => NOW,
    execute: async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new TextEncoder().encode('{"version":"0.1","kind":"synthetic-evening-plan","liveDataChecked":false}');
    },
  };
  const firstService = await startLoopbackA2AService(options);

  const [left, right] = await Promise.all([
    rpc(firstService.url, 1, 'message/send', sendParams(requestEnvelope, 'message-left')),
    rpc(firstService.url, 2, 'message/send', sendParams(requestEnvelope, 'message-right')),
  ]);
  const leftAccepted = resultTask(left);
  const rightAccepted = resultTask(right);
  assert.equal(leftAccepted.status.state, 'submitted');
  assert.deepEqual(leftAccepted, rightAccepted);
  const leftTask = await pollTerminal(firstService.url, leftAccepted.id);
  assert.equal(executions, 1);

  const changedRequest = structuredClone(fixture.request);
  changedRequest.input.preferences = ['Quiet table'];
  const changedEnvelope = await signRequest(changedRequest, fixture.caller);
  const conflict = await rpc(firstService.url, 3, 'message/send', sendParams(changedEnvelope));
  assert.ok('error' in conflict);
  assert.equal(conflict.error.code, -32009);
  assert.equal(conflict.error.data?.reason, 'interaction-key-conflict');

  await firstService.close();
  const reopened = await startLoopbackA2AService(options);
  t.after(() => reopened.close());
  const replayed = await rpc(reopened.url, 4, 'message/send', sendParams(requestEnvelope));
  assert.deepEqual(resultTask(replayed), leftTask);
  const polled = await rpc(reopened.url, 5, 'tasks/get', { id: leftTask.id });
  assert.deepEqual(resultTask(polled), leftTask);
  assert.equal(executions, 1);
});

test('post-acceptance execution fault retains a failed task and signed failure evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const requestEnvelope = await signRequest(fixture.request, fixture.caller);
  const service = await startLoopbackA2AService({
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged',
      observedAt: NOW,
    }),
    now: () => NOW,
    execute: async () => { throw new Error('synthetic post-acceptance fault'); },
  });
  t.after(() => service.close());

  const response = await rpc(service.url, 1, 'message/send', sendParams(requestEnvelope));
  const acceptedTask = resultTask(response);
  assert.equal(acceptedTask.status.state, 'submitted');
  const task = await pollTerminal(service.url, acceptedTask.id);
  assert.equal(task.status.state, 'failed');
  assert.equal(task.artifacts, undefined);
  const metadata = cityMetadata(task);
  assert.ok(metadata.acceptance);
  assert.ok(metadata.completion);
  assert.equal(metadata.failureReason, 'provider-error');

  const finding = await verifyInteraction({
    request: requestEnvelope,
    acceptance: metadata.acceptance,
    completion: metadata.completion,
    basisProfile: fixture.profile,
    currentProfile: fixture.profile,
    continuity: 'unchanged',
    observedAt: NOW,
  });
  assert.equal(finding.allPresentedEvidenceUsableAtObservation, true);
  assert.equal(finding.completion?.terminalOutcome, 'failed');
});

test('missing authority fails before acceptance and changed authority prevents completion', async (t) => {
  const missingDirectory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  const changedDirectory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => Promise.all([
    rm(missingDirectory, { recursive: true, force: true }),
    rm(changedDirectory, { recursive: true, force: true }),
  ]));
  const fixture = makeInteractionFixture();
  const requestEnvelope = await signRequest(fixture.request, fixture.caller);

  const missing = await startLoopbackA2AService({
    storeDirectory: missingDirectory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: null,
      currentProfile: null,
      continuity: 'unknown',
      observedAt: NOW,
    }),
    now: () => NOW,
  });
  t.after(() => missing.close());
  const rejected = await rpc(missing.url, 1, 'message/send', sendParams(requestEnvelope));
  assert.ok('error' in rejected);
  assert.equal(rejected.error.code, -32010);
  assert.equal(rejected.error.data?.reason, 'authority-unavailable');
  assert.deepEqual(await readdir(missingDirectory), []);

  let observations = 0;
  let changedExecutions = 0;
  const changed = await startLoopbackA2AService({
    storeDirectory: changedDirectory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: observations++ === 0 ? 'unchanged' : 'changed',
      observedAt: NOW,
    }),
    now: () => NOW,
    execute: async () => {
      changedExecutions += 1;
      return new TextEncoder().encode('{"should":"not-run"}');
    },
  });
  t.after(() => changed.close());
  const changedResult = await rpc(changed.url, 2, 'message/send', sendParams(requestEnvelope));
  const changedAccepted = resultTask(changedResult);
  assert.equal(changedAccepted.status.state, 'submitted');
  const changedTask = await pollTerminal(changed.url, changedAccepted.id);
  assert.equal(changedTask.status.state, 'failed');
  const changedMetadata = cityMetadata(changedTask);
  assert.ok(changedMetadata.acceptance);
  assert.equal(changedMetadata.completion, undefined);
  assert.equal(changedMetadata.failureReason, 'authority-changed');
  assert.equal(changedExecutions, 0);
});

test('A2A JSON-RPC rejects unknown methods, missing tasks, and malformed City request parts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const service = await startLoopbackA2AService({
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged',
      observedAt: NOW,
    }),
    now: () => NOW,
  });
  t.after(() => service.close());

  const missing = await rpc(service.url, 'missing', 'tasks/get', { id: 'not-a-task' });
  assert.ok('error' in missing);
  assert.equal(missing.error.code, -32001);
  const method = await rpc(service.url, 'method', 'tasks/cancel', { id: 'not-a-task' });
  assert.ok('error' in method);
  assert.equal(method.error.code, -32601);
  const params = await rpc(service.url, 'params', 'message/send', {
    message: { kind: 'message', role: 'user', messageId: 'bad', parts: [{ kind: 'text', text: 'not signed data' }] },
  });
  assert.ok('error' in params);
  assert.equal(params.error.code, -32602);
  const blockingEnvelope = await signRequest(fixture.request, fixture.caller);
  const blocking = await rpc(service.url, 'blocking', 'message/send', {
    ...sendParams(blockingEnvelope),
    configuration: { blocking: true, acceptedOutputModes: ['application/json'] },
  });
  assert.ok('error' in blocking);
  assert.equal(blocking.error.code, -32004);
  assert.equal(blocking.error.data?.reason, 'blocking-send-unsupported');
});

test('pre-acceptance rejection reports distinct signature, profile, signer, deadline, and continuity reasons', async (t) => {
  const fixture = makeInteractionFixture();

  async function rejectedReason(input: {
    envelope: unknown;
    runtimeSigner?: typeof fixture.runtime;
    observedAt?: string;
    now?: string;
    continuity?: 'unchanged' | 'changed' | 'unknown';
  }): Promise<{ reason: unknown; files: string[] }> {
    const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const service = await startLoopbackA2AService({
      storeDirectory: directory,
      runtimeSigner: input.runtimeSigner ?? fixture.runtime,
      observeAuthority: async () => ({
        basisProfile: fixture.profile,
        currentProfile: fixture.profile,
        continuity: input.continuity ?? 'unchanged',
        observedAt: input.observedAt ?? NOW,
      }),
      now: () => input.now ?? NOW,
    });
    t.after(() => service.close());
    const response = await rpc(service.url, randomRpcId(), 'message/send', sendParams(input.envelope));
    assert.ok('error' in response);
    return { reason: response.error.data?.reason, files: await readdir(directory) };
  }

  const valid = await signRequest(fixture.request, fixture.caller);
  const wrongCaller = structuredClone(valid);
  wrongCaller.signer.address = fixture.stranger.address.toLowerCase() as `0x${string}`;
  assert.deepEqual(await rejectedReason({ envelope: wrongCaller }), {
    reason: 'request-signature-invalid', files: [],
  });

  const wrongServiceRequest = structuredClone(fixture.request);
  wrongServiceRequest.service.agent.agentId = '8';
  const wrongService = await signRequest(wrongServiceRequest, fixture.caller);
  assert.deepEqual(await rejectedReason({ envelope: wrongService }), {
    reason: 'profile-basis-mismatch', files: [],
  });

  assert.deepEqual(await rejectedReason({ envelope: valid, runtimeSigner: fixture.stranger }), {
    reason: 'runtime-signer-unauthorized', files: [],
  });
  assert.deepEqual(await rejectedReason({ envelope: valid, observedAt: '2026-09-24T13:00:01Z', now: '2026-09-24T13:00:01Z' }), {
    reason: 'acceptance-time-invalid', files: [],
  });
  assert.deepEqual(await rejectedReason({ envelope: valid, continuity: 'changed' }), {
    reason: 'authority-changed', files: [],
  });
  assert.deepEqual(await rejectedReason({ envelope: valid, continuity: 'unknown' }), {
    reason: 'authority-unavailable', files: [],
  });
});

test('acceptance clock outside the signed request window fails before persistence', async (t) => {
  const fixture = makeInteractionFixture();
  const envelope = await signRequest(fixture.request, fixture.caller);
  for (const acceptedAt of ['2026-09-24T11:59:59Z', '2026-09-24T13:00:01Z']) {
    const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const service = await startLoopbackA2AService({
      storeDirectory: directory,
      runtimeSigner: fixture.runtime,
      observeAuthority: async () => ({
        basisProfile: fixture.profile,
        currentProfile: fixture.profile,
        continuity: 'unchanged',
        observedAt: NOW,
      }),
      now: () => acceptedAt,
    });
    t.after(() => service.close());
    const response = await rpc(service.url, acceptedAt, 'message/send', sendParams(envelope));
    assert.ok('error' in response);
    assert.equal(response.error.data?.reason, 'acceptance-time-invalid');
    assert.deepEqual(await readdir(directory), []);
  }
});

test('acceptance requires an independent observation at or after the chosen acceptance time', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const envelope = await signRequest(fixture.request, fixture.caller);
  const service = await startLoopbackA2AService({
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged',
      observedAt: NOW,
    }),
    now: () => '2026-09-24T12:59:00Z',
  });
  t.after(() => service.close());
  const response = await rpc(service.url, 1, 'message/send', sendParams(envelope));
  assert.ok('error' in response);
  assert.equal(response.error.data?.reason, 'authority-observation-stale');
  assert.deepEqual(await readdir(directory), []);
});

test('late terminal result signs expiry only with current authority and an observing clock at or after recordedAt', async (t) => {
  const fixture = makeInteractionFixture();
  const envelope = await signRequest(fixture.request, fixture.caller);

  async function runTerminal(secondObservation: string) {
    const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let timeCalls = 0;
    let observationCalls = 0;
    let executions = 0;
    const service = await startLoopbackA2AService({
      storeDirectory: directory,
      runtimeSigner: fixture.runtime,
      observeAuthority: async () => ({
        basisProfile: fixture.profile,
        currentProfile: fixture.profile,
        continuity: 'unchanged',
        observedAt: observationCalls++ === 0 ? NOW : secondObservation,
      }),
      now: () => timeCalls++ === 0 ? NOW : '2026-09-24T13:00:01Z',
      execute: async () => {
        executions += 1;
        return new TextEncoder().encode('{"should":"not-run-after-deadline"}');
      },
    });
    t.after(() => service.close());
    const accepted = resultTask(await rpc(service.url, randomRpcId(), 'message/send', sendParams(envelope)));
    assert.equal(accepted.status.state, 'submitted');
    return { task: await pollTerminal(service.url, accepted.id), executions };
  }

  const observedLateRun = await runTerminal('2026-09-24T13:00:01Z');
  const observedLate = observedLateRun.task;
  assert.equal(observedLateRun.executions, 0);
  assert.equal(observedLate.status.state, 'failed');
  const lateMetadata = cityMetadata(observedLate);
  assert.equal(lateMetadata.failureReason, 'deadline-expired');
  assert.ok(lateMetadata.completion);
  const expired = await verifyInteraction({
    request: envelope,
    acceptance: lateMetadata.acceptance,
    completion: lateMetadata.completion,
    basisProfile: fixture.profile,
    currentProfile: fixture.profile,
    continuity: 'unchanged',
    observedAt: '2026-09-24T13:00:01Z',
  });
  assert.equal(expired.completion?.terminalOutcome, 'expired');
  assert.equal(expired.completion?.cryptography, 'valid');
  assert.equal(expired.completion?.link, 'matched');

  const staleRun = await runTerminal(NOW);
  const staleObservation = staleRun.task;
  assert.equal(staleRun.executions, 0);
  assert.equal(staleObservation.status.state, 'failed');
  const staleMetadata = cityMetadata(staleObservation);
  assert.equal(staleMetadata.failureReason, 'authority-observation-stale');
  assert.equal(staleMetadata.completion, undefined);
});

test('post-execution observer failure is not signed or labeled as a provider execution error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const envelope = await signRequest(fixture.request, fixture.caller);
  let observations = 0;
  const service = await startLoopbackA2AService({
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => {
      observations += 1;
      if (observations === 3) throw new Error('synthetic observer outage');
      return {
        basisProfile: fixture.profile,
        currentProfile: fixture.profile,
        continuity: 'unchanged' as const,
        observedAt: NOW,
      };
    },
    now: () => NOW,
    execute: async () => new TextEncoder().encode('{"execution":"succeeded"}'),
  });
  t.after(() => service.close());

  const accepted = resultTask(await rpc(service.url, 1, 'message/send', sendParams(envelope)));
  const failed = await pollTerminal(service.url, accepted.id);
  assert.equal(failed.status.state, 'failed');
  const metadata = cityMetadata(failed);
  assert.equal(metadata.failureReason, 'authority-unavailable');
  assert.equal(metadata.completion, undefined);
  assert.equal(observations, 3);
});

test('reopened submitted tasks revalidate authority and deadline before invoking the executor', async (t) => {
  const fixture = makeInteractionFixture();
  const requestEnvelope = await signRequest(fixture.request, fixture.caller);
  const requestDigest = decodeEnvelope(requestEnvelope).statement.digest;
  const acceptance = await signProviderStatement({
    kind: 'acceptance',
    version: '0.1',
    requestDigest,
    acceptanceId: `0x${'34'.repeat(32)}`,
    acceptedAt: NOW,
    deadline: fixture.request.deadline,
  }, fixture.runtime, fixture.profile);

  for (const scenario of [
    {
      name: 'changed', continuity: 'changed' as const, observedAt: NOW, now: NOW,
      runtimeSigner: fixture.runtime, reason: 'authority-changed',
    },
    {
      name: 'expired', continuity: 'unchanged' as const,
      observedAt: '2026-09-24T13:00:01Z', now: '2026-09-24T13:00:01Z',
      runtimeSigner: fixture.runtime, reason: 'deadline-expired',
    },
    {
      name: 'wrong-runtime', continuity: 'unchanged' as const, observedAt: NOW, now: NOW,
      runtimeSigner: fixture.stranger, reason: 'runtime-signer-unauthorized',
    },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `nandacity-a2a-${scenario.name}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const task: A2ATask = {
      kind: 'task',
      id: `persisted-${scenario.name}`,
      contextId: `context-${scenario.name}`,
      status: { state: 'submitted', timestamp: NOW },
      metadata: {
        'org.nandacity': {
          subset: 'a2a-0.3-jsonrpc-loopback',
          pollingAuthentication: 'none-loopback-only',
          interactionId: fixture.request.interactionId,
          acceptance,
        },
      },
    };
    const store = await CityTaskStore.open(directory);
    await store.save({
      version: '0.1',
      interactionKey: `persisted:${scenario.name}`,
      requestDigest,
      requestEnvelope,
      acceptance,
      task,
    });
    let executions = 0;
    const service = await startLoopbackA2AService({
      storeDirectory: directory,
      runtimeSigner: scenario.runtimeSigner,
      observeAuthority: async () => ({
        basisProfile: fixture.profile,
        currentProfile: fixture.profile,
        continuity: scenario.continuity,
        observedAt: scenario.observedAt,
      }),
      now: () => scenario.now,
      execute: async () => {
        executions += 1;
        return new TextEncoder().encode('{"should":"not-run"}');
      },
    });
    t.after(() => service.close());
    const firstPoll = resultTask(await rpc(service.url, scenario.name, 'tasks/get', { id: task.id }));
    assert.equal(firstPoll.status.state, 'submitted');
    const terminal = await pollTerminal(service.url, task.id);
    assert.equal(terminal.status.state, 'failed');
    assert.equal(cityMetadata(terminal).failureReason, scenario.reason);
    assert.equal(executions, 0);
  }
});

test('execution timeout aborts cooperatively, does not block close, and cannot write a late success', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nandacity-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = makeInteractionFixture();
  const envelope = await signRequest(fixture.request, fixture.caller);
  let sawAbort = false;
  const options = {
    storeDirectory: directory,
    runtimeSigner: fixture.runtime,
    observeAuthority: async () => ({
      basisProfile: fixture.profile,
      currentProfile: fixture.profile,
      continuity: 'unchanged' as const,
      observedAt: NOW,
    }),
    now: () => NOW,
    executionTimeoutMs: 20,
    execute: async (_request: unknown, context: { signal: AbortSignal }) => new Promise<Uint8Array>((resolve) => {
      context.signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
      setTimeout(() => resolve(new TextEncoder().encode('{"late":"success"}')), 100);
    }),
  };
  const service = await startLoopbackA2AService(options);
  const accepted = resultTask(await rpc(service.url, 1, 'message/send', sendParams(envelope)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const closeStarted = Date.now();
  await service.close();
  assert.ok(Date.now() - closeStarted < 80, 'close waited on the timed-out executor');
  assert.equal(sawAbort, true);

  const reopened = await startLoopbackA2AService({
    ...options,
    execute: async () => { throw new Error('terminal task must not execute again'); },
  });
  t.after(() => reopened.close());
  const failed = resultTask(await rpc(reopened.url, 2, 'tasks/get', { id: accepted.id }));
  assert.equal(failed.status.state, 'failed');
  const failedMetadata = cityMetadata(failed);
  assert.equal(failedMetadata.failureReason, 'execution-timeout');
  assert.ok(failedMetadata.completion);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const persisted = resultTask(await rpc(reopened.url, 3, 'tasks/get', { id: accepted.id }));
  assert.deepEqual(persisted, failed);
});

let rpcSequence = 1000;
function randomRpcId(): number {
  rpcSequence += 1;
  return rpcSequence;
}
