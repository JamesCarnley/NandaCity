import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startLoopbackA2AService, startStrategyA2AService, type LoopbackServiceOptions } from '../../src/a2a/service.js';
import { CityTaskStore } from '../../src/a2a/store.js';
import { rpcTask, pollTerminalTask, type LicensedExternalClientResult } from '../../src/client/externalClient.js';
import { decodeEnvelope, signRequest } from '../../src/interaction/signatures.js';
import { verifyInteraction } from '../../src/interaction/verify.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { TransientByteHolder, contentFinding, projectReceiptTask, type LicensedRetention } from '../../src/live/retention.js';
import { parseEthereumTaskRecord, parseOriginTaskRecord, createOriginRuntimeStrategy } from '../../src/a2a/strategy.js';
import type { JourneyEvidence, JourneyReport } from '../../src/demo/journeyReport.js';
import { originalBasis } from '../identity/fixtures.js';
import { encodeSupportingBundle, commitSupportingBundle } from '../../src/feedback/supportingBundle.js';
import { signFeedback, decodeFeedbackEnvelope, verifyFeedbackSignature } from '../../src/feedback/signatures.js';
import { encodeOriginDocument, decodeOriginEnvelope, type OriginDocument } from '../../src/origin/bytes.js';
import { signOriginStatement, verifyOriginSignature } from '../../src/origin/signatures.js';
import type { OriginProfile, OriginRequest } from '../../src/origin/schema.js';

const NOW = '2026-09-24T12:02:00Z';
const EXPIRY = '2026-09-24T12:03:00Z';
const CONTENT = 'LICENSED-CONTENT-SENTINEL-37f281';
const PRIVATE = 'PRIVATE-REQUEST-SENTINEL-493aae';
const retention = { kind: 'licensed', policyId: 'test-license-1', expiresAt: EXPIRY,
  export: 'receipts-only', persistContent: false } as const;
for (const mode of ['ethereum', 'origin'] as const) test(`${mode} legacy unfinished tasks resume only with a fixture executor`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), `city-legacy-${mode}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture();
  const key = (account: typeof f.caller) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
  const profile: OriginProfile = { profile: 'city-origin@0.1', kind: 'profile', service: { method: 'https-origin', identityUrl: 'https://fixture.example/identity' },
    revision: '1', active: true, controllerKey: key(f.stranger), runtimeKey: key(f.runtime), cardURL: 'https://fixture.example/card',
    cardDigest: `0x${'aa'.repeat(32)}`, endpoint: 'https://fixture.example/a2a', city: 'Chicago', capability: 'evening-plan' };
  const basis = encodeOriginDocument(await signOriginStatement(profile, f.stranger)) as OriginDocument<OriginProfile>;
  const originRequest: OriginRequest = { profile: 'city-origin@0.1', kind: 'request', service: profile.service, caller: key(f.caller),
    interactionId: f.request.interactionId, profileBasis: { profileDigest: basis.documentDigest, cardDigest: profile.cardDigest },
    createdAt: f.request.createdAt, deadline: f.request.deadline, input: f.request.input };
  const envelope = mode === 'ethereum' ? await signRequest(f.request, f.caller) : await signOriginStatement(originRequest, f.caller);
  let executions = 0;
  const fixtureExecute = async () => { executions++; return Buffer.from(CONTENT); };
  const sourceExecute = Object.assign(fixtureExecute.bind(undefined), { retention });
  const start = (live: boolean) => mode === 'ethereum' ? startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime,
    now: () => NOW, execute: live ? sourceExecute : fixtureExecute,
    ...(live ? { retention, live: { caller: { ...f.request.caller, address: f.stranger.address.toLowerCase() as `0x${string}` } } } : {}),
    observeAuthority: async () => ({ basisProfile: f.profile, currentProfile: f.profile, continuity: 'unchanged', observedAt: NOW }) }) :
    startStrategyA2AService({ storeDirectory: directory, runtimeSigner: f.runtime, now: () => NOW, execute: live ? sourceExecute : fixtureExecute,
      ...(live ? { retention, live: { caller: key(f.stranger) } } : {}),
      strategy: createOriginRuntimeStrategy({ basisProfile: () => basis,
        observeAuthority: async () => ({ current: 'observed', observedAt: NOW, profile: basis, historicalAuthority: 'not-independently-proven' }) }) });
  let service = await start(false); t.after(() => service.close());
  const submitted = await rpcTask(service.url, 'message/send', send(envelope));
  await pollTerminalTask(service.url, submitted.id); await service.close();
  const store = await CityTaskStore.open<unknown>(directory, mode === 'ethereum' ? parseEthereumTaskRecord : parseOriginTaskRecord);
  const legacy = { ...store.getByTask(submitted.id)!, task: submitted };
  assert.equal(legacy.version, '0.1');
  await store.save(legacy);
  service = await start(false);
  assert.equal((await pollTerminalTask(service.url, submitted.id)).status.state, 'completed');
  assert.equal(executions, 2, 'unbound fixture callbacks retain legacy restart');
  await service.close(); await store.save(legacy);
  service = await start(true);
  await assert.rejects(rpcTask(service.url, 'message/send', send(envelope)), /rejected/, 'the stored caller is not admitted by the new live configuration');
  const unresolved = await pollTerminalTask(service.url, submitted.id);
  assert.equal(unresolved.status.state, 'failed');
  const metadata = unresolved.metadata!['org.nandacity'] as Record<string, unknown>;
  assert.equal(metadata.failureReason, 'interrupted-unresolved');
  assert.equal(metadata.completion, undefined);
  assert.deepEqual(metadata.acceptance, legacy.acceptance);
  assert.equal(executions, 2, 'polling cannot start licensed work for a legacy caller');
  const persisted = (await CityTaskStore.open<unknown>(directory, mode === 'ethereum' ? parseEthereumTaskRecord : parseOriginTaskRecord)).getByTask(submitted.id)!;
  assert.equal(persisted.version, '0.1', 'do not silently migrate a fixture record');
  assert.equal(JSON.stringify(persisted).includes('answerBase64'), false);
});
function send(envelope: unknown) {
  return { message: { kind: 'message', role: 'user', messageId: 'retention-test',
    metadata: { prose: CONTENT }, parts: [{ kind: 'data', metadata: { prose: CONTENT },
      data: { type: 'org.nandacity.city-request', version: '0.1', envelope } }] } };
}

test('caller retention is bounded by the real signed runtime response and local permission', async (t) => {
  const { retainLicensedJourney, projectExternalClientResult } = await import('../../src/client/externalClient.js');
  const { reportJourneyInteraction } = await import('../../src/demo/journeyReport.js');
  const directory = await mkdtemp(join(tmpdir(), 'city-caller-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture(); let now = NOW;
  const request = await signRequest(f.request, f.caller);
  const service = await startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime, now: () => now,
    retention, live: { caller: f.request.caller }, execute: Object.assign(async () => Buffer.from(CONTENT), { retention }),
    observeAuthority: async () => ({ basisProfile: f.profile, currentProfile: f.profile, continuity: 'unchanged', observedAt: now }) });
  t.after(() => service.close());
  const submitted = await rpcTask(service.url, 'message/send', send(request));
  const task = await pollTerminalTask(service.url, submitted.id);
  const metadata = task.metadata!['org.nandacity'] as any;
  const evidence: JourneyEvidence = { task, request, acceptance: metadata.acceptance, completion: metadata.completion,
    answerBase64: task.artifacts![0]!.parts[0]!.data.answerBase64 as string, cardBase64: Buffer.from(PRIVATE).toString('base64'),
    candidate: { observerOrigin: 'http://127.0.0.1', agent: f.profile.agent, agentURI: originalBasis.agentURI,
      declaration: { identifier: 'test', displayName: 'Fictional', description: 'Fictional', type: 'test', url: 'http://127.0.0.1/card', capabilityIds: [], areaServed: [], interfaces: [] },
      observationBlock: { number: originalBasis.blockNumber, hash: originalBasis.blockHash, timestamp: originalBasis.blockTimestamp } },
    basisObservation: originalBasis, currentObservation: originalBasis, observedAt: NOW };
  for (const [label, callerExpiry, effectiveExpiry] of [
    ['shorter', '2026-09-24T12:02:30Z', '2026-09-24T12:02:30Z'], ['later', '2026-09-24T12:10:00Z', EXPIRY],
  ] as const) await t.test(label, async () => {
    now = NOW;
    const seenPolicies: unknown[] = [];
    const retained = await retainLicensedJourney(evidence, { ...retention, expiresAt: callerExpiry },
      async (safe: JourneyEvidence, bytes?: Uint8Array, effective?: LicensedRetention): Promise<JourneyReport> => {
        seenPolicies.push(effective);
        const finding = await verifyInteraction({ request: safe.request, acceptance: safe.acceptance, completion: safe.completion,
          ...(bytes ? { answerBytes: bytes } : {}), basisProfile: f.profile, currentProfile: f.profile, continuity: 'unchanged', observedAt: now });
        return reportJourneyInteraction(safe, { status: 'verified', profile: f.profile, observerOrigin: 'http://127.0.0.1' }, finding, 'unchanged');
      }, () => now);
    try {
      assert.equal(retained.earlierByteCheck?.answerBinding, 'matched', 'use the actual signed answer bytes');
      now = effectiveExpiry;
      assert.deepEqual(retained.content(), { contentAvailability: 'expired', semanticReplay: 'unavailable' });
      assert.equal(retained.retention.expiresAt, effectiveExpiry);
      assert.deepEqual(seenPolicies, [{ ...retention, expiresAt: effectiveExpiry }, { ...retention, expiresAt: effectiveExpiry }]);
      const result: LicensedExternalClientResult = { ...retained, mode: 'licensed-receipts-only', childVerified: false, city: 'Chicago', selectedAgentId: '7',
        callerAddress: f.caller.address, selectionReason: 'configured', retry: { sameTask: true, taskId: task.id } };
      assert.equal(projectExternalClientResult(result, () => now).content.contentAvailability, 'expired');
      const runtimeAtBoundary = await rpcTask(service.url, 'tasks/get', { id: task.id });
      assert.equal((runtimeAtBoundary.metadata!['org.nandacity'] as any).content.contentAvailability, label === 'later' ? 'expired' : 'available');
      assert.deepEqual(runtimeAtBoundary.artifacts![0]!.parts[0]!.data.completion, metadata.completion);
      now = NOW;
      assert.equal(retained.content().contentAvailability, 'not-retained', 'caller bytes do not return after a clock rewind');
    } finally { retained.close(); }
  });
  for (const runtime of [undefined, { ...retention, policyId: 'other-policy' }, { ...retention, expiresAt: 'invalid' },
    { kind: 'authored-fixture', export: 'full' }, { ...retention, export: 'full' }]) await t.test(`invalid runtime policy ${JSON.stringify(runtime)}`, async () => {
    const invalid = structuredClone(evidence); (invalid.task.metadata!['org.nandacity'] as any).retention = runtime;
    let verified = false;
    await assert.rejects(retainLicensedJourney(invalid, retention, async () => { verified = true; throw new Error('verification must not run'); }, () => NOW), /runtime retention/);
    assert.equal(verified, false, 'reject before taking ownership or verifying bytes');
  });
});

test('licensed bytes never enter durable or cached tasks, expire exactly, and never regenerate on restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'city-live-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture();
  f.request.input.preferences = [PRIVATE];
  const request = await signRequest(f.request, f.caller);
  let now = NOW;
  let executions = 0;
  const options = { storeDirectory: directory, runtimeSigner: f.runtime, retention,
    now: () => now, observeAuthority: async () => ({ basisProfile: f.profile, currentProfile: f.profile,
      continuity: 'unchanged' as const, observedAt: now }),
    execute: async () => { executions++; return new TextEncoder().encode(CONTENT); },
  } satisfies LoopbackServiceOptions & { retention: typeof retention };
  let service = await startLoopbackA2AService(options);
  t.after(() => service.close());
  const submitted = await Promise.all(Array.from({ length: 5 }, () => rpcTask(service.url, 'message/send', send(request))));
  assert.equal(new Set(submitted.map((task) => task.id)).size, 1);
  const completed = await pollTerminalTask(service.url, submitted[0]!.id);
  const data = completed.artifacts![0]!.parts[0]!.data;
  assert.equal(data.answerBase64, Buffer.from(CONTENT).toString('base64'));
  const [file] = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  const disk = await readFile(join(directory, file!), 'utf8');
  assert.equal(disk.includes(Buffer.from(CONTENT).toString('base64')), false, 'licensed answer must not persist');
  assert.equal(disk.includes(CONTENT), false, 'caller annotations must not persist');
  const store = await CityTaskStore.open(directory);
  const cached = store.getByTask(completed.id)!;
  assert.equal(cached.version, '0.2');
  assert.equal(JSON.stringify(cached).includes('answerBase64'), false);
  const corruptDirectory = await mkdtemp(join(tmpdir(), 'city-corrupt-retention-'));
  t.after(() => rm(corruptDirectory, { recursive: true, force: true }));
  for (const mutate of [
    (v: any) => { v.sourcePayload = CONTENT; },
    (v: any) => { v.retention.extra = CONTENT; },
    (v: any) => { v.retention.expiresAt = '2026-02-30T12:00:00Z'; },
    (v: any) => { v.task.metadata.extra = CONTENT; },
    (v: any) => { v.task.artifacts[0].parts[0].data.answerBase64 = Buffer.from(CONTENT).toString('base64'); },
    (v: any) => { v.task.metadata['org.nandacity'].acceptance = request; },
    (v: any) => { v.task.artifacts[0].parts[0].data.completion = request; },
    (v: any) => { v.task.history[0].parts[0].data.envelope = cached.acceptance; },
    (v: any) => { v.task.status.state = 'failed'; },
  ]) {
    const corrupt = structuredClone(cached); mutate(corrupt);
    assert.throws(() => parseEthereumTaskRecord(corrupt));
    await assert.rejects(store.save(corrupt));
    assert.deepEqual(store.getByTask(completed.id), cached);
    assert.equal(await readFile(join(directory, file!), 'utf8'), disk);
    await writeFile(join(corruptDirectory, file!), JSON.stringify(corrupt));
    await assert.rejects(CityTaskStore.open(corruptDirectory));
  }
  const mutable = structuredClone(cached);
  const saving = store.save(mutable);
  (mutable.task.artifacts![0]!.parts[0]!.data.completion as any).payloadBase64 = CONTENT;
  await saving;
  assert.deepEqual(store.getByTask(completed.id), cached, 'in-flight save must own its validated snapshot');
  const returned = store.getByTask(completed.id)!;
  (returned.task.metadata!['org.nandacity'] as any).private = CONTENT;
  assert.deepEqual(store.getByTask(completed.id), cached, 'returned receipt copies cannot poison cached storage');
  const completion = data.completion;
  const acceptance = (completed.metadata!['org.nandacity'] as Record<string, unknown>).acceptance;
  const bundle = encodeSupportingBundle({ version: '0.1', request, acceptance, completion, cardBase64: 'AP+A' });
  const commitment = commitSupportingBundle(bundle.bytes);
  const feedback = await signFeedback({ kind: 'feedback', version: '0.2', service: f.request.service,
    reviewer: f.request.caller, interactionId: f.request.interactionId,
    requestDigest: decodeEnvelope(request).statement.digest, acceptanceDigest: decodeEnvelope(acceptance).statement.digest,
    reputationRegistry: { chainId: 11155111, address: '0x9999999999999999999999999999999999999999' },
    rubric: 'evening-plan-usefulness-v0.1', value: 1, createdAt: NOW,
    supportingBundleDigest: commitment.digest, result: { kind: 'completion', completionDigest: decodeEnvelope(completion).statement.digest } }, f.caller);
  const feedbackBytes = JSON.stringify(feedback);
  const verify = (answerBytes?: Uint8Array) => verifyInteraction({ request, acceptance, completion,
    ...(answerBytes ? { answerBytes } : {}), basisProfile: f.profile, currentProfile: f.profile,
    continuity: 'unchanged', observedAt: now });
  assert.equal((await verify(new TextEncoder().encode(CONTENT))).completion?.answerBinding, 'matched');
  assert.equal((await verify(new Uint8Array([0]))).completion?.answerBinding, 'mismatched');
  now = '2026-09-24T12:02:59Z';
  assert.equal((await rpcTask(service.url, 'message/send', send(request))).artifacts![0]!.parts[0]!.data.answerBase64, data.answerBase64);
  now = EXPIRY;
  const exactExpiry = await rpcTask(service.url, 'tasks/get', { id: completed.id });
  assert.equal(exactExpiry.artifacts![0]!.parts[0]!.data.answerBase64, undefined);
  now = '2026-09-24T12:02:59Z';
  assert.equal((await rpcTask(service.url, 'tasks/get', { id: completed.id })).artifacts![0]!.parts[0]!.data.answerBase64, undefined);
  await service.close();
  service = await startLoopbackA2AService(options);
  const reopened = await rpcTask(service.url, 'tasks/get', { id: completed.id });
  assert.equal(reopened.artifacts![0]!.parts[0]!.data.answerBase64, undefined);
  assert.deepEqual((reopened.metadata!['org.nandacity'] as any).content, { contentAvailability: 'not-retained', semanticReplay: 'unavailable' });
  now = EXPIRY;
  const expired = await rpcTask(service.url, 'message/send', send(request));
  assert.deepEqual((expired.metadata!['org.nandacity'] as any).content, { contentAvailability: 'expired', semanticReplay: 'unavailable' });
  assert.deepEqual(expired.artifacts![0]!.parts[0]!.data.completion, completion);
  assert.equal(expired.status.state, 'completed');
  assert.equal((await verify()).completion?.answerBinding, 'unavailable');
  const statement = decodeEnvelope(completion).statement.value;
  assert.ok(statement.kind === 'completion' && statement.outcome === 'completed');
  assert.equal(executions, 1);
  assert.equal(JSON.stringify(feedback), feedbackBytes);
  assert.equal(decodeFeedbackEnvelope(feedback).feedback.value.value, 1);
  assert.equal((await verifyFeedbackSignature(feedback, 11155111)).status, 'valid');
  assert.deepEqual(encodeSupportingBundle({ version: '0.1', request, acceptance,
    completion: expired.artifacts![0]!.parts[0]!.data.completion, cardBase64: 'AP+A' }).bytes, bundle.bytes);
  assert.equal(commitSupportingBundle(bundle.bytes).digest, commitment.digest);
  now = '2026-09-24T12:03:01Z';
  assert.equal((await rpcTask(service.url, 'tasks/get', { id: completed.id })).artifacts![0]!.parts[0]!.data.answerBase64, undefined);
});

test('runtime rejects malformed retention before opening storage or accepting a request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'city-invalid-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture();
  for (const invalid of [
    { ...retention, policyId: '' }, { ...retention, policyId: 'bad policy' },
    { ...retention, expiresAt: 'Infinity' }, { ...retention, expiresAt: '2026-02-30T00:00:00Z' },
    { ...retention, expiresAt: '2026-09-24T12:03:00.000Z' },
    { ...retention, export: 'full' }, { ...retention, persistContent: true }, { ...retention, payload: CONTENT },
  ]) await assert.rejects(startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime,
    now: () => NOW, retention: invalid as typeof retention, observeAuthority: async () => { throw new Error('must not observe'); } }));
  assert.deepEqual(await readdir(directory), []);
});

test('holder actively evicts at the exact boundary, by timer, on capacity and close', async () => {
  let now = NOW;
  const holder = new TransientByteHolder(() => now, 3);
  holder.put('one', new Uint8Array([1, 2]), retention);
  holder.put('two', new Uint8Array([3, 4]), retention);
  assert.equal(holder.read('one'), undefined);
  const copy = holder.read('two')!; copy[0] = 0;
  assert.deepEqual(holder.read('two'), new Uint8Array([3, 4]));
  now = EXPIRY;
  assert.equal(holder.read('two'), undefined);
  now = NOW;
  assert.equal(holder.read('two'), undefined, 'clock rewind cannot resurrect evicted content');
  holder.put('three', new Uint8Array([1]), { ...retention, expiresAt: '2026-09-24T12:02:01Z' });
  now = '2026-09-24T12:02:01Z';
  await new Promise((resolve) => setTimeout(resolve, 1050));
  now = NOW;
  assert.equal(holder.read('three'), undefined, 'timer must evict without a read');
  holder.put('four', new Uint8Array([1]), retention);
  holder.close();
  holder.put('five', new Uint8Array([1]), retention);
  assert.equal(holder.read('four'), undefined);
  assert.equal(holder.read('five'), undefined);
  assert.throws(() => contentFinding({ ...retention, policyId: '' }, NOW));
});

test('configured caller and report exports omit private requests, cards and both answer copies before expiry', async (t) => {
  const client = await import('../../src/client/externalClient.js');
  assert.ok('retainLicensedJourney' in client, 'configured caller needs a separate retention-safe result path');
  const directory = await mkdtemp(join(tmpdir(), 'city-retention-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture(); f.request.input.preferences = [PRIVATE];
  const request = await signRequest(f.request, f.caller);
  const service = await startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime,
    retention, now: () => NOW, observeAuthority: async () => ({ basisProfile: f.profile, currentProfile: f.profile,
      continuity: 'unchanged', observedAt: NOW }), execute: async () => new TextEncoder().encode(CONTENT) });
  t.after(() => service.close());
  const submitted = await rpcTask(service.url, 'message/send', send(request));
  const task = await pollTerminalTask(service.url, submitted.id);
  const metadata = task.metadata!['org.nandacity'] as any;
  const evidence = { task, request, acceptance: metadata.acceptance, completion: metadata.completion,
    answerBase64: Buffer.from(CONTENT).toString('base64'), cardBase64: Buffer.from(PRIVATE).toString('base64'),
    candidate: { observerOrigin: 'http://127.0.0.1', agent: f.profile.agent, agentURI: originalBasis.agentURI,
      declaration: { identifier: 'test', displayName: PRIVATE, description: PRIVATE, type: 'test',
        url: 'http://127.0.0.1/card', capabilityIds: [], areaServed: [], interfaces: [] },
      observationBlock: { number: originalBasis.blockNumber, hash: originalBasis.blockHash, timestamp: originalBasis.blockTimestamp } },
    basisObservation: originalBasis, currentObservation: originalBasis, observedAt: NOW } satisfies JourneyEvidence;
  let now = NOW;
  const verify = async (safe: JourneyEvidence, bytes?: Uint8Array): Promise<JourneyReport> => {
    const finding = await verifyInteraction({ request: safe.request, acceptance: safe.acceptance,
      completion: safe.completion, ...(bytes ? { answerBytes: bytes } : {}),
      basisProfile: f.profile, currentProfile: f.profile, continuity: 'unchanged', observedAt: NOW });
    const { reportJourneyInteraction } = await import('../../src/demo/journeyReport.js');
    return reportJourneyInteraction(safe, { status: 'verified', profile: f.profile, observerOrigin: 'http://127.0.0.1' }, finding, 'unchanged');
  };
  const retained = await client.retainLicensedJourney(evidence, retention, verify, () => now);
  t.after(() => retained.close());
  assert.equal(JSON.stringify(retained.evidence).includes('answerBase64'), false);
  assert.equal(retained.report.execution, 'completed');
  assert.equal(retained.report.completion?.answerBinding, 'unavailable');
  assert.equal(retained.report.evidenceUsable, false);
  assert.equal(retained.report.firstBrokenBoundary, 'answer');
  assert.equal(retained.earlierByteCheck?.answerBinding, 'matched');
  const poisoned = structuredClone(evidence);
  (poisoned.task.metadata!['org.nandacity'] as any).acceptance = { prose: CONTENT };
  await assert.rejects(client.retainLicensedJourney(poisoned, retention, verify, () => now),
    'private receipt projection must not preserve an unchecked nested evidence object');
  const result = { ...retained, mode: 'licensed-receipts-only' as const, city: 'Chicago' as const,
    selectedAgentId: '7', callerAddress: f.caller.address, selectionReason: PRIVATE,
    retry: { sameTask: true as const, taskId: task.id }, childVerified: false as const };
  const { projectExternalClientResult } = await import('../../src/client/externalClient.js');
  const { serializeExternalClientResult } = await import('../../src/client/externalClientCli.js');
  const { writeReceiptsOnlyReport } = await import('../../src/report/writeReport.js');
  const summary = projectExternalClientResult(result, () => now);
  assert.equal(summary.mode, 'licensed-receipts-only');
  const stdout = serializeExternalClientResult(result, () => now);
  const spoofed = { ...result, childVerified: true } as unknown as LicensedExternalClientResult;
  assert.equal(serializeExternalClientResult(spoofed, () => now).includes(request.payloadBase64), false,
    'a purported verification flag cannot upgrade configured licensed export');
  const htmlPath = join(directory, 'report.html'); const evidencePath = join(directory, 'report.json');
  await writeReceiptsOnlyReport(result, { htmlPath, evidencePath }, () => now);
  for (const output of [JSON.stringify(summary), stdout, await readFile(htmlPath, 'utf8'), await readFile(evidencePath, 'utf8')]) {
    for (const secret of [CONTENT, Buffer.from(CONTENT).toString('base64'), PRIVATE, Buffer.from(PRIVATE).toString('base64'), request.payloadBase64]) {
      assert.equal(output.includes(secret), false, 'public output leaked private content');
    }
    assert.equal(output.includes('answerBase64'), false);
  }
  for (const slot of ['acceptance', 'completion'] as const) {
    for (const field of ['scheme', 'signer.method', 'signature'] as const) {
      await t.test(`${slot} ${field} cannot export arbitrary envelope text or upgrade its finding`, async () => {
        const unsupported = structuredClone(evidence);
        const receipt = unsupported[slot]!;
        const sentinel = `PRIVATE-ENVELOPE-SENTINEL-${slot}-${field}`;
        if (field === 'signer.method') receipt.signer.method = sentinel;
        else receipt[field] = field === 'signature' ? `0x${'00'.repeat(65)}` : sentinel;
        (unsupported.task.metadata!['org.nandacity'] as Record<string, unknown>)[slot] = receipt;
        if (slot === 'completion') unsupported.task.artifacts![0]!.parts[0]!.data.completion = receipt;
        const privateResult = await client.retainLicensedJourney(unsupported, retention, verify, () => now);
        try {
          assert.deepEqual(privateResult.evidence[slot], receipt, 'private verification keeps the exact unsupported or invalid envelope');
          const expected = field === 'signature' ? 'invalid' : 'unsupported';
          assert.equal(privateResult.report[slot]?.cryptography, expected);
          const exportedResult = { ...result, ...privateResult };
          const publicSummary = projectExternalClientResult(exportedResult, () => now);
          const publicFields: Record<string, unknown> = publicSummary;
          assert.equal(publicSummary.findings[slot]?.cryptography, expected);
          assert.equal(publicSummary.findings.evidenceUsable, false);
          assert.equal(publicFields[`${slot}Digest`], decodeEnvelope(evidence[slot]).statement.digest,
            'the original statement digest remains available when its unsupported envelope is omitted');
          if (field === 'signature') assert.deepEqual(publicFields[slot], receipt);
          else {
            assert.equal(publicFields[slot], undefined);
            assert.equal(publicFields[`${slot}Omitted`], 'unsupported-envelope');
          }
          const negativeHtml = join(directory, `${slot}-${field}.html`);
          const negativeJson = join(directory, `${slot}-${field}.json`);
          await writeReceiptsOnlyReport(exportedResult, { htmlPath: negativeHtml, evidencePath: negativeJson }, () => now);
          for (const output of [JSON.stringify(publicSummary), serializeExternalClientResult(exportedResult, () => now),
            await readFile(negativeHtml, 'utf8'), await readFile(negativeJson, 'utf8')]) {
            assert.equal(output.includes(sentinel), false, 'public export must omit free-text receipt-envelope fields');
          }
        } finally { privateResult.close(); }
      });
    }
  }
  now = EXPIRY;
  assert.equal(projectExternalClientResult(result, () => now).content.contentAvailability, 'expired');
  now = NOW;
  assert.equal(projectExternalClientResult(result, () => now).content.contentAvailability, 'not-retained');
  const tampered = structuredClone(evidence);
  tampered.answerBase64 = Buffer.from('wrong').toString('base64');
  tampered.task.artifacts![0]!.parts[0]!.data.answerBase64 = tampered.answerBase64;
  const mismatch = await client.retainLicensedJourney(tampered, retention, verify, () => now);
  t.after(() => mismatch.close());
  assert.equal(mismatch.earlierByteCheck?.answerBinding, 'mismatched');
  assert.equal(mismatch.earlierByteCheck?.evidenceUsable, false);
  assert.equal(mismatch.report.completion?.answerBinding, 'unavailable');
});

for (const mode of ['ethereum', 'origin'] as const) test(`${mode} licensed receipts reject authority substitution and never resume unfinished or failed work`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), `city-${mode}-licensed-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = makeInteractionFixture();
  const key = (account: typeof f.caller) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
  const profile: OriginProfile = { profile: 'city-origin@0.1', kind: 'profile', service: { method: 'https-origin', identityUrl: 'https://fixture.example/identity' },
    revision: '1', active: true, controllerKey: key(f.stranger), runtimeKey: key(f.runtime), cardURL: 'https://fixture.example/card',
    cardDigest: `0x${'aa'.repeat(32)}`, endpoint: 'https://fixture.example/a2a', city: 'Chicago', capability: 'evening-plan' };
  const basis = encodeOriginDocument(await signOriginStatement(profile, f.stranger)) as OriginDocument<OriginProfile>;
  const originRequest: OriginRequest = { profile: 'city-origin@0.1', kind: 'request', service: profile.service, caller: key(f.caller),
    interactionId: f.request.interactionId, profileBasis: { profileDigest: basis.documentDigest, cardDigest: profile.cardDigest },
    createdAt: f.request.createdAt, deadline: f.request.deadline, input: f.request.input };
  const origin = await signOriginStatement(originRequest, f.caller);
  const ethereum = await signRequest(f.request, f.caller);
  const request = mode === 'ethereum' ? ethereum : origin;
  let executions = 0;
  let failure = false;
  let configured = true;
  const execute = async () => {
    executions++;
    const [filename] = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    assert.equal(JSON.parse(await readFile(join(directory, filename!), 'utf8')).retention.policyId, retention.policyId);
    if (failure) throw new Error(CONTENT);
    return new TextEncoder().encode(CONTENT);
  };
  const start = () => mode === 'ethereum' ? startLoopbackA2AService({ storeDirectory: directory, runtimeSigner: f.runtime,
    now: () => NOW, ...(configured ? { retention } : {}), execute,
    observeAuthority: async () => ({ basisProfile: f.profile, currentProfile: f.profile, continuity: 'unchanged', observedAt: NOW }) }) :
    startStrategyA2AService({ storeDirectory: directory, runtimeSigner: f.runtime, now: () => NOW, ...(configured ? { retention } : {}), execute,
      strategy: createOriginRuntimeStrategy({ basisProfile: () => basis,
        observeAuthority: async () => ({ current: 'observed', observedAt: NOW, profile: basis, historicalAuthority: 'not-independently-proven' }) }) });
  let service = await start(); t.after(() => service.close());
  const submitted = await rpcTask(service.url, 'message/send', send(request));
  const completed = await pollTerminalTask(service.url, submitted.id);
  assert.equal(executions, 1);
  const completion = completed.artifacts![0]!.parts[0]!.data.completion;
  if (mode === 'origin') {
    assert.equal((await verifyOriginSignature(completion, profile.service.identityUrl, 'completion')).status, 'valid');
    assert.equal(decodeOriginEnvelope(completion).statement.value.kind, 'completion');
  }
  await service.close();
  const parse = mode === 'ethereum' ? parseEthereumTaskRecord : parseOriginTaskRecord;
  const store = await CityTaskStore.open<unknown>(directory, parse);
  const record = store.getByTask(submitted.id)!;
  const corrupt = structuredClone(record);
  (corrupt.task.metadata!['org.nandacity'] as any).completion = mode === 'ethereum' ? origin : ethereum;
  await assert.rejects(store.save(corrupt));
  assert.deepEqual(store.getByTask(submitted.id), record);
  await assert.rejects(CityTaskStore.open<unknown>(directory, mode === 'ethereum' ? parseOriginTaskRecord : parseEthereumTaskRecord));
  await store.save({ ...record, task: projectReceiptTask(submitted) });
  configured = false;
  service = await start();
  const retries = await Promise.all(Array.from({ length: 5 }, () => rpcTask(service.url, 'message/send', send(request))));
  for (const task of retries) {
    assert.equal(task.status.state, 'failed');
    assert.equal((task.metadata!['org.nandacity'] as any).failureReason, 'interrupted-unresolved');
    assert.equal((task.metadata!['org.nandacity'] as any).completion, undefined);
    assert.deepEqual((task.metadata!['org.nandacity'] as any).acceptance, record.acceptance);
  }
  assert.equal(executions, 1);
  await service.close(); service = await start();
  assert.equal((await rpcTask(service.url, 'tasks/get', { id: submitted.id })).status.state, 'failed');
  assert.equal(executions, 1);
  // A separately accepted execution failure is terminal too, without exception text.
  failure = true; configured = true;
  await service.close(); service = await start();
  const secondRequest = mode === 'ethereum' ? await signRequest({ ...f.request, interactionId: `0x${'bc'.repeat(32)}` }, f.caller) :
    await signOriginStatement({ ...originRequest, interactionId: `0x${'bc'.repeat(32)}` }, f.caller);
  const accepted = await rpcTask(service.url, 'message/send', send(secondRequest));
  const failed = await pollTerminalTask(service.url, accepted.id);
  assert.equal(failed.status.state, 'failed');
  assert.equal(JSON.stringify(failed).includes(CONTENT), false);
  assert.equal(executions, 2);
  await service.close(); service = await start();
  await rpcTask(service.url, 'message/send', send(secondRequest));
  assert.equal(executions, 2);
});
