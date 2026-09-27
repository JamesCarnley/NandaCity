import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { chmod, cp, link, mkdtemp, readFile, readdir, realpath, rm, stat, symlink,
  unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { signRequest } from '../../src/interaction/signatures.js';
import type { CityRequest, SignedEnvelope } from '../../src/interaction/schema.js';
import { qualifyTownTestAdmission, readTownEvidence,
  type TownEvidenceObservation } from '../../src/reputation/townEvidence.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { originalCandidate } from '../identity/fixtures.js';

const execFileAsync = promisify(execFile);
const checkout = process.env['NANDATOWN_CHECKOUT'];
const python = process.env['NANDATOWN_PYTHON'];
const townRuntime = () => {
  assert.ok(checkout, 'NANDATOWN_CHECKOUT must identify the pinned Town checkout');
  assert.ok(python, 'NANDATOWN_PYTHON must identify the pinned Python interpreter');
  return { checkout, python };
};

const wire = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const base64 = (value: Buffer): string => value.toString('base64');
const digest = (byte: string): `0x${string}` => `0x${byte.repeat(64)}`;
const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;

function envelope(kind: 'request' | 'acceptance' | 'completion'): Record<string, unknown> {
  const statement = {
    request: {
      kind: 'request', version: '0.1',
      service: { method: 'erc8004', agent: { chainId: 31_337, registry: address('1'), agentId: '7' } },
      caller: { method: 'eip155-eoa', chainId: 31_337, address: address('2') },
      interactionId: digest('a'),
      profileBasis: {
        blockNumber: '12', blockHash: digest('b'), agentOwner: address('3'),
        agentUriDigest: digest('c'), registrationDigest: digest('d'), cardDigest: digest('e'),
        receiptSigner: address('4'),
      },
      createdAt: '2026-09-26T12:00:00Z', deadline: '2026-09-26T13:00:00Z',
      input: {
        version: '0.1', capability: 'evening-plan', city: 'Chicago', area: 'The Loop',
        timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
          timeZone: 'America/Chicago' },
        budget: { currency: 'USD', minorUnits: '8500' }, transport: ['walk'], preferences: [],
      },
    },
    acceptance: {
      kind: 'acceptance', version: '0.1', requestDigest: digest('5'), acceptanceId: digest('6'),
      acceptedAt: '2026-09-26T12:01:00Z', deadline: '2026-09-26T13:00:00Z',
    },
    completion: {
      kind: 'completion', version: '0.1', acceptanceDigest: digest('7'),
      recordedAt: '2026-09-26T12:02:00Z', outcome: 'completed', answerDigest: digest('8'),
    },
  }[kind];
  return {
    version: '0.1', scheme: 'eip712-eoa',
    signer: { method: 'eip155-eoa', chainId: 31_337,
      address: kind === 'request' ? address('2') : address('4') },
    payloadBase64: base64(wire(statement)), signature: `0x${'11'.repeat(65)}`,
  };
}

type NativeFixture = {
  root: string; bundle: string; subjectUrl: string; cardUrl: string;
  cardBytes: Buffer; requestBytes: Buffer;
};

let fixture: NativeFixture;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createNativeFixture(): Promise<NativeFixture> {
  const runtime = townRuntime();
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-town-unit-'));
  await chmod(root, 0o700);
  let cardBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const requestEnvelope = envelope('request');
  const requestBytes = wire({
    jsonrpc: '2.0', id: 'city-unit-request', method: 'message/send',
    params: {
      message: { kind: 'message', role: 'user', messageId: 'city-unit-message', parts: [{
        kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope: requestEnvelope },
      }] },
      configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
    },
  });
  const requestMessage = (JSON.parse(requestBytes.toString('utf8')) as {
    params: { message: Record<string, unknown> };
  }).params.message;
  const acceptance = envelope('acceptance');
  const completion = envelope('completion');
  const task = (state: 'submitted' | 'completed') => {
    const value: Record<string, unknown> = {
      kind: 'task', id: 'town-unit-task', contextId: 'town-unit-context',
      status: { state, timestamp: '2026-09-26T12:01:00Z' }, history: [requestMessage],
      metadata: { 'org.nandacity': { subset: 'a2a-0.3-jsonrpc-loopback',
        pollingAuthentication: 'none-loopback-only', interactionId: digest('a'), acceptance } },
    };
    if (state === 'submitted') {
      value['status'] = { state, timestamp: '2026-09-26T12:01:00Z', message: {
        kind: 'message', role: 'agent', messageId: 'town-unit-status', parts: [{ kind: 'data',
          data: { type: 'org.nandacity.city-status', version: '0.1', state: 'accepted', acceptance } }],
      } };
    } else {
      (value['metadata'] as { 'org.nandacity': Record<string, unknown> })['org.nandacity']['completion'] = completion;
      value['artifacts'] = [{ artifactId: 'town-unit-artifact', parts: [{ kind: 'data', data: {
        type: 'org.nandacity.city-result', version: '0.1', answerBase64: 'e30=', completion,
      } }] }];
    }
    return value;
  };
  let posts = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': cardBytes.byteLength });
        response.end(cardBytes); return;
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string };
      posts++;
      const body = wire({ jsonrpc: '2.0', id: rpc.id, result: task(posts < 3 ? 'submitted' : 'completed') });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.byteLength });
      response.end(body);
    });
  });
  try {
    const port = await listen(server);
    const subjectUrl = `http://127.0.0.1:${port}/`;
    const cardUrl = `${subjectUrl}cards/7.json`;
    cardBytes = wire({
      protocolVersion: '0.3.0', name: 'Synthetic City', description: 'Synthetic test only',
      url: subjectUrl, preferredTransport: 'JSONRPC', version: '0.1.0',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
      skills: [{ id: 'evening-plan', name: 'Evening Plan', description: 'Synthetic', tags: ['city'] }],
    });
    const cardFile = join(root, 'card.json');
    const requestFile = join(root, 'request.json');
    await writeFile(cardFile, cardBytes, { mode: 0o600 });
    await writeFile(requestFile, requestBytes, { mode: 0o600 });
    const { stdout } = await execFileAsync(runtime.python, ['-I', '-B', '-m', 'nandatown.city_path',
      '--subject-url', subjectUrl, '--card-url', cardUrl, '--pinned-card', cardFile,
      '--request', requestFile, '--out-dir', join(root, 'bundles'),
      '--observer-key-dir', join(root, 'observer'), '--observer-name', 'city-unit-observer'], {
      cwd: runtime.checkout, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' },
      timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    const summary = JSON.parse(stdout) as { bundle: string; verdict: string };
    assert.equal(summary.verdict, 'passed');
    return { root, bundle: summary.bundle, subjectUrl, cardUrl, cardBytes, requestBytes };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await close(server);
  }
}

before(async () => { fixture = await createNativeFixture(); });
after(async () => { if (fixture) await rm(fixture.root, { recursive: true, force: true }); });

test('reads one immutable native Town receipt without exporting private or answer material', async () => {
  const observed = await readTownEvidence({ bundleDirectory: fixture.bundle, runtime: townRuntime() });
  assert.equal(observed.version, '0.1');
  assert.equal(observed.runtime.commit, 'bf8f226b4d7ae9543bd73995c000c64c7dcd7e09');
  assert.equal(observed.runtime.python, '3.12.13');
  assert.equal(observed.town.version, '0.2.0');
  assert.equal(observed.receipt.profile, 'city-a2a-protocol@0.1');
  assert.equal(observed.receipt.verdict, 'passed');
  assert.equal(observed.receipt.subject, fixture.subjectUrl);
  assert.equal(observed.observation.cardUrl, fixture.cardUrl);
  assert.equal(Buffer.from(observed.observation.cardBase64, 'base64').equals(fixture.cardBytes), true);
  assert.equal(Buffer.from(observed.observation.requestRpcBase64, 'base64').equals(fixture.requestBytes), true);
  assert.deepEqual(observed.result.stages.map((stage) => [stage.name, stage.status]), [
    ['pinned_card', 'passed'], ['structured_send', 'passed'], ['acceptance_task', 'passed'],
    ['exact_retry', 'passed'], ['terminal_task', 'passed'],
  ]);
  assert.ok(observed.adapterObservedAt >= observed.receipt.evaluated);
  const exported = JSON.stringify(observed);
  assert.equal(exported.includes(fixture.root), false);
  assert.equal(exported.includes('answerBase64'), false);
  assert.equal(exported.includes('controller_public'), false);
  assert.equal(exported.includes('private'), false);
  assert.equal((await readFile(join(fixture.bundle, 'receipt.json'))).byteLength > 0, true);
});

const sha = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function retainedRpc(signed: SignedEnvelope): Buffer {
  return wire({ jsonrpc: '2.0', id: 'qualified-request', method: 'message/send', params: {
    message: { kind: 'message', role: 'user', messageId: 'qualified-message', parts: [{ kind: 'data',
      data: { type: 'org.nandacity.city-request', version: '0.1', envelope: signed } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
  } });
}

async function admissionFixture() {
  const interaction = makeInteractionFixture();
  const signed = await signRequest(interaction.request, interaction.caller);
  const requestRpc = retainedRpc(signed);
  const cardBytes = originalCandidate.cardBytes;
  const observation: TownEvidenceObservation = {
    version: '0.1', adapterObservedAt: Date.parse('2026-09-24T12:30:00Z') / 1000,
    runtime: { commit: 'bf8f226b4d7ae9543bd73995c000c64c7dcd7e09', python: '3.12.13' },
    town: { version: '0.2.0', declaredPython: '3.12.13',
      inspectedBase: '17fbc7902be49683aee5f7610a0a1dcf8c803b3e',
      observerSourceFingerprint: sha(Buffer.from('sources')) },
    receipt: {
      observer: 'did:town:qualified-observer', capability: 'city-a2a-structured-task',
      subject: interaction.profile.card.url, profile: 'city-a2a-protocol@0.1', verdict: 'passed',
      profileFingerprint: 'sha256:e6a1cc01584de3547a76ddc3b2bbac6d366258bc8603a26a1dad2ebd5c5212cc',
      parsedCardSha256: sha(Buffer.from(JSON.stringify(interaction.profile.card))),
      started: Date.parse('2026-09-24T12:05:00Z') / 1000,
      evaluated: Date.parse('2026-09-24T12:10:00Z') / 1000,
      tested: ['pinned_card', 'structured_send', 'acceptance_task', 'exact_retry', 'terminal_task'],
      notTested: [],
      limitations: [
        'Synthetic same-host observer selected by demo policy; not independent operators or official Town accreditation.',
        'Protocol shape and one exact retry only; not Ethereum authorization, EIP-712 validity, or ownership verification.',
        'No certification of truthful venues, answer quality, or semantic task success.',
        'One observed retry is not global exactly-once execution.',
        'Replay evaluates retained observer records, not an independent rerun or proof the observer told the truth.',
      ],
      bundleFingerprint: sha(Buffer.from('bundle')), resultDigest: sha(Buffer.from('result')), runId: 'town-run-1',
    },
    observation: {
      subjectUrl: interaction.profile.card.url,
      cardUrl: interaction.profile.registration.services.find((service) => service.name === 'A2A')!.endpoint,
      cardBase64: Buffer.from(cardBytes).toString('base64'),
      requestRpcBase64: requestRpc.toString('base64'), cardBytesSha256: sha(cardBytes),
      parsedCardSha256: sha(Buffer.from(JSON.stringify(interaction.profile.card))),
    },
    result: { profileEvaluator: 'city-a2a-protocol-evaluator@0.1',
      evaluator: 'path-city-a2a-protocol-0.1', stages: [
        { name: 'pinned_card', status: 'passed' }, { name: 'structured_send', status: 'passed' },
        { name: 'acceptance_task', status: 'passed' }, { name: 'exact_retry', status: 'passed' },
        { name: 'terminal_task', status: 'passed' },
      ] },
  };
  const epoch = {
    epoch: 'same' as const, qualification: 'rpc-derived-not-state-proof' as const,
    basis: { blockNumber: interaction.profile.source.blockNumber, blockHash: interaction.profile.source.blockHash },
    observation: { blockNumber: interaction.profile.source.blockNumber, blockHash: interaction.profile.source.blockHash },
    diagnostics: [],
  };
  const input = { evidence: observation, service: 'service:7',
    acceptedEvaluators: [observation.receipt.observer], basisProfile: interaction.profile,
    currentProfile: interaction.profile, currentCardBytes: cardBytes, epoch };
  return { ...interaction, signed: signed as SignedEnvelope, cardBytes, observation, epoch, input };
}

test('qualifies a signed Town observation only after exact profile, card, endpoint and epoch binding', async () => {
  const value = await admissionFixture();
  const result = await qualifyTownTestAdmission(value.input);
  assert.deepEqual(result, { admission: {
    kind: 'test', id: `town-test:${value.observation.receipt.bundleFingerprint}`,
    service: 'service:7', issuer: value.observation.receipt.observer,
    city: 'Chicago', task: 'evening-plan', status: 'valid', provenance: 'adapter-observed',
    endpoint: value.profile.card.url, cardDigest: value.profile.source.cardDigest,
  }, diagnostics: [] });
});

async function copiedBundle(): Promise<{ root: string; bundle: string }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-town-copy-'));
  await chmod(root, 0o700);
  const bundle = join(root, 'bundle');
  await cp(fixture.bundle, bundle, { recursive: true });
  return { root, bundle };
}

async function rejectsBundle(change: (bundle: string) => Promise<void>): Promise<void> {
  const copy = await copiedBundle();
  try {
    await change(copy.bundle);
    await assert.rejects(readTownEvidence({ bundleDirectory: copy.bundle, runtime: townRuntime() }),
      (error: unknown) => error instanceof Error && error.message === 'Town evidence rejected' &&
        !error.message.includes(copy.root) && !error.message.includes('Traceback'),
      `expected mutated bundle rejection under ${copy.root}`);
  } finally { await rm(copy.root, { recursive: true, force: true }); }
}

test('rejects missing, symlinked, hard-linked and oversized snapshot inputs', async () => {
  await rejectsBundle(async (bundle) => rm(join(bundle, 'receipt.json')));
  await rejectsBundle(async (bundle) => {
    const path = join(bundle, 'profile.json'); const target = join(bundle, 'profile-target.json');
    await cp(path, target); await unlink(path); await symlink(target, path);
  });
  await rejectsBundle(async (bundle) => {
    const profile = join(bundle, 'profile.json'); const run = join(bundle, 'run.json');
    await unlink(run); await link(profile, run);
  });
  await rejectsBundle(async (bundle) => writeFile(join(bundle, 'events.jsonl'), Buffer.alloc(7_864_321)));
});

test('rejects ambiguous, nonfinite, deeply nested and over-node JSON before native replay', async () => {
  for (const raw of [
    '{"x":1,"x":2}', '{"x":NaN}', `${'['.repeat(33)}0${']'.repeat(33)}`,
  ]) await rejectsBundle(async (bundle) => writeFile(join(bundle, 'receipt.json'), raw));
  await rejectsBundle(async (bundle) => writeFile(join(bundle, 'events.jsonl'),
    `${JSON.stringify(Array.from({ length: 100_000 }, () => 0))}\n`));
});

test('native receipt, transcript and result mutations all fail behind one generic boundary', async (t) => {
  for (const name of ['receipt.json', 'events.jsonl', 'result.json'] as const) {
    await t.test(name, async () => rejectsBundle(async (bundle) => {
      const path = join(bundle, name); const bytes = await readFile(path);
      if (name === 'receipt.json') {
        const receipt = JSON.parse(bytes.toString('utf8')) as { signature: string };
        receipt.signature = `${receipt.signature.slice(0, -1)}${receipt.signature.endsWith('0') ? '1' : '0'}`;
        await writeFile(path, JSON.stringify(receipt));
      } else {
        await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
      }
    }));
  }
});

test('charges all copied bytes once against the caller aggregate budget', async () => {
  const names = ['profile.json', 'run.json', 'intents.jsonl', 'events.jsonl',
    'result.json', 'manifest.json', 'attestation.json', 'receipt.json'];
  const expected = (await Promise.all(names.map((name) => stat(join(fixture.bundle, name)))))
    .reduce((total, item) => total + item.size, 0);
  let checks = 0; let charged = 0;
  await readTownEvidence({ bundleDirectory: fixture.bundle, runtime: townRuntime(),
    work: { check: () => { checks++; }, chargeBundle: (length) => { charged += length; } } });
  assert.equal(charged, expected);
  assert.ok(checks > names.length);
});

test('an already-cancelled read rejects generically without leaking an owned snapshot', async () => {
  const temporary = await realpath(tmpdir());
  const before = new Set((await readdir(temporary)).filter((name) => name.startsWith('nandacity-town-evidence-')));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readTownEvidence({ bundleDirectory: fixture.bundle, runtime: townRuntime(),
    signal: controller.signal }), /Town evidence rejected/);
  const after = new Set((await readdir(temporary)).filter((name) => name.startsWith('nandacity-town-evidence-')));
  assert.deepEqual(after, before);
});

function processIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor<T>(read: () => T | undefined, timeout = 2_000): Promise<T | undefined> {
  const end = Date.now() + timeout;
  do {
    const value = read(); if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  return undefined;
}

test('deadline crossing during spawn setup kills and awaits the real child', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-town-deadline-'));
  const wrapper = join(root, 'python'); const pidFile = join(root, 'pid');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidFile)}\nexec /bin/sleep 60\n`,
    { mode: 0o700 });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  assert.ok(descriptor);
  let calls = 0; let pid: number | undefined;
  // deadline() plus the two Git children consume calls 1-7. Call 8 is the
  // wrapper's pre-spawn check; call 9 crosses the deadline after spawn returns.
  Object.defineProperty(globalThis, 'performance', { configurable: true,
    value: { now: () => {
      if (++calls < 9) return 0;
      const end = Date.now() + 2_000;
      while (Date.now() < end) {
        try { if (requireRead(pidFile).length > 0) break; } catch { /* child has not started yet */ }
      }
      return 10_001;
    } } });
  try {
    await assert.rejects(readTownEvidence({ bundleDirectory: fixture.bundle,
      runtime: { checkout: townRuntime().checkout, python: wrapper } }),
    (error: unknown) => error instanceof Error && error.message === 'Town evidence rejected');
  } finally {
    Object.defineProperty(globalThis, 'performance', descriptor);
  }
  try {
    const rawPid = await waitFor(() => {
      try { return Number((requireRead(pidFile)).trim()); } catch { return undefined; }
    });
    assert.ok(rawPid && Number.isSafeInteger(rawPid)); pid = rawPid;
    const stopped = await waitFor(() => processIsRunning(pid!) ? undefined : true);
    assert.equal(stopped, true, `spawned child ${pid} was still running after rejection`);
  } finally {
    if (pid && processIsRunning(pid)) process.kill(pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

function requireRead(path: string): string {
  return readFileSync(path, 'utf8');
}

test('signaled filesystem failure logs only a generic cleanup error and removes its snapshot', async () => {
  const copy = await copiedBundle();
  const runner = join(copy.root, 'signal-runner.mts');
  const temporary = await realpath(tmpdir());
  const before = new Set((await readdir(temporary)).filter((name) => name.startsWith('nandacity-town-evidence-')));
  const snapshotNames = ['profile.json', 'run.json', 'intents.jsonl', 'events.jsonl',
    'result.json', 'manifest.json', 'attestation.json', 'receipt.json'];
  const snapshotSizes = await Promise.all(snapshotNames.map((name) => stat(join(copy.bundle, name))));
  const firstPostCopyCheck = 8 + snapshotSizes.reduce((count, item) =>
    count + 1 + Math.ceil(item.size / 65_536), 0) + 1;
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/reputation/townEvidence.ts')).href;
  await writeFile(runner, `
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readTownEvidence } from ${JSON.stringify(moduleUrl)};
let checks = 0;
await readTownEvidence({
  bundleDirectory: ${JSON.stringify(copy.bundle)},
  runtime: { checkout: ${JSON.stringify(townRuntime().checkout)}, python: ${JSON.stringify(townRuntime().python)} },
  work: { chargeBundle() {}, check() {
    checks++;
    if (checks === ${firstPostCopyCheck}) {
      process.kill(process.pid, 'SIGTERM');
      unlinkSync(join(${JSON.stringify(copy.bundle)}, 'profile.json'));
    }
  } },
});
`, { mode: 0o600 });
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', runner], {
      cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const errorText = Buffer.concat(stderr).toString('utf8');
    assert.deepEqual(closed, { code: null, signal: 'SIGTERM' }, errorText);
    assert.equal(Buffer.concat(stdout).toString('utf8'), '');
    assert.equal(errorText, 'Owned demo cancellation/cleanup failed: Error: Town evidence rejected\n');
    assert.equal(errorText.includes(copy.root), false);
    const after = new Set((await readdir(temporary)).filter((name) => name.startsWith('nandacity-town-evidence-')));
    assert.deepEqual(after, before);
  } finally {
    await rm(copy.root, { recursive: true, force: true });
  }
});

type AdmissionInput = Parameters<typeof qualifyTownTestAdmission>[0];
async function withSignedRequest(value: Awaited<ReturnType<typeof admissionFixture>>,
  request: CityRequest): Promise<AdmissionInput> {
  const input = structuredClone(value.input) as AdmissionInput;
  input.evidence.observation.requestRpcBase64 = retainedRpc(await signRequest(request, value.caller)).toString('base64');
  return input;
}

test('rejects unaccepted observers, failed coverage, replay gaps and invalid request signatures', async () => {
  const value = await admissionFixture();
  const mutations: Array<[string, (input: AdmissionInput) => void]> = [
    ['observer-not-accepted', (input) => { input.acceptedEvaluators = []; }],
    ['town-verdict-not-passed', (input) => { input.evidence.receipt.verdict = 'failed'; }],
    ['town-stages-incomplete', (input) => { input.evidence.result.stages[4]!.status = 'failed'; }],
    ['town-coverage-incomplete', (input) => { input.evidence.receipt.notTested = ['terminal_task']; }],
    ['town-replay-unchecked', (input) => { input.evidence.receipt.limitations =
      [...input.evidence.receipt.limitations, 'evaluator replay not checked: synthetic']; }],
    ['request-signature-invalid', (input) => {
      const rpc = JSON.parse(Buffer.from(input.evidence.observation.requestRpcBase64, 'base64').toString()) as {
        params: { message: { parts: Array<{ data: { envelope: SignedEnvelope } }> } } };
      const envelope = rpc.params.message.parts[0]!.data.envelope;
      envelope.signature = `${envelope.signature.slice(0, -1)}2`;
      input.evidence.observation.requestRpcBase64 = Buffer.from(JSON.stringify(rpc)).toString('base64');
    }],
  ];
  for (const [diagnostic, mutate] of mutations) {
    const input = structuredClone(value.input) as AdmissionInput; mutate(input);
    const result = await qualifyTownTestAdmission(input);
    assert.equal(result.admission.status, 'invalid', diagnostic);
    assert.ok(result.diagnostics.includes(diagnostic), JSON.stringify(result.diagnostics));
  }
});

test('endpoint, card, historical basis and requested-city migration invalidate old evidence', async () => {
  const value = await admissionFixture();
  const endpoint = structuredClone(value.input) as AdmissionInput;
  endpoint.currentProfile.card.url = 'https://changed.example/a2a';
  assert.ok((await qualifyTownTestAdmission(endpoint)).diagnostics.includes('service-endpoint-mismatch'));

  const card = structuredClone(value.input) as AdmissionInput;
  card.currentCardBytes = new TextEncoder().encode('{}');
  assert.ok((await qualifyTownTestAdmission(card)).diagnostics.includes('current-card-bytes-mismatch'));

  const request = structuredClone(value.request);
  request.profileBasis.blockNumber = '1';
  const basis = await withSignedRequest(value, request);
  assert.ok((await qualifyTownTestAdmission(basis)).diagnostics.includes('historical-profile-mismatch'));

  const bostonRequest = structuredClone(value.request);
  bostonRequest.input.city = 'Boston';
  bostonRequest.input.timeWindow = { start: '2026-10-02T18:00:00-04:00',
    end: '2026-10-02T22:00:00-04:00', timeZone: 'America/New_York' };
  const city = await withSignedRequest(value, bostonRequest);
  assert.ok((await qualifyTownTestAdmission(city)).diagnostics.includes('city-mismatch'));
});

test('stale, future and reversed windows are invalid while unknown epoch stays unknown', async () => {
  const value = await admissionFixture();
  const stale = structuredClone(value.input) as AdmissionInput;
  stale.evidence = { ...stale.evidence,
    adapterObservedAt: stale.evidence.receipt.evaluated + 2_592_001 };
  assert.ok((await qualifyTownTestAdmission(stale)).diagnostics.includes('town-window-invalid'));
  const future = structuredClone(value.input) as AdmissionInput;
  future.evidence.receipt.evaluated = future.evidence.adapterObservedAt + 1;
  assert.ok((await qualifyTownTestAdmission(future)).diagnostics.includes('town-window-invalid'));
  const reversed = structuredClone(value.input) as AdmissionInput;
  reversed.evidence.receipt.started = reversed.evidence.receipt.evaluated + 1;
  assert.ok((await qualifyTownTestAdmission(reversed)).diagnostics.includes('town-window-invalid'));

  const retired = structuredClone(value.input) as AdmissionInput; retired.epoch.epoch = 'retired';
  assert.equal((await qualifyTownTestAdmission(retired)).admission.status, 'invalid');
  const unknown = structuredClone(value.input) as AdmissionInput; unknown.epoch.epoch = 'unknown';
  assert.deepEqual(await qualifyTownTestAdmission(unknown), { admission: {
    kind: 'test', id: `town-test:${value.observation.receipt.bundleFingerprint}`,
    service: 'service:7', issuer: value.observation.receipt.observer,
    city: 'Chicago', task: 'evening-plan', status: 'unknown', provenance: 'adapter-observed',
    endpoint: value.profile.card.url, cardDigest: value.profile.source.cardDigest,
  }, diagnostics: ['identity-epoch-unknown'] });
});
