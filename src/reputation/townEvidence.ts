import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { withOwnedLifecycle } from '../demo/ownedLifecycle.js';
import { cityRequestEnvelopeFromParams, sendParamsSchema } from '../a2a/wire.js';
import { readIdentityFeedbackEpoch } from '../identity/continuity.js';
import { digestBytes } from '../identity/profile.js';
import type { VerifiedProfile } from '../identity/verify.js';
import { decodeEnvelope, verifyEnvelopeSignature } from '../interaction/signatures.js';
import type { PolicyInput } from './policy.js';
import type { RankingReadBudget } from './readBudget.js';

export const TOWN_EVIDENCE_COMMIT =
  'bf8f226b4d7ae9543bd73995c000c64c7dcd7e09' as const;
export const TOWN_EVIDENCE_PYTHON = '3.12.13' as const;

const TOWN_VECTOR = 'sha256:2d16426c2bd13fc15ea6b8dbd19772f8e6a2adfff0d73b19d7448c0b319bb6b6';
const TOTAL_LIMIT = 8 * 1024 * 1024;
const FILES = ['profile.json', 'run.json', 'intents.jsonl', 'events.jsonl',
  'result.json', 'manifest.json', 'attestation.json', 'receipt.json'] as const;
const limits: Record<(typeof FILES)[number], number> = {
  'profile.json': 65_536, 'run.json': 65_536, 'intents.jsonl': 65_536,
  'events.jsonl': 7_864_320, 'result.json': 65_536, 'manifest.json': 65_536,
  'attestation.json': 65_536, 'receipt.json': 65_536,
};
const rejected = () => new Error('Town evidence rejected');

export type TownEvidenceRuntime = Readonly<{
  checkout: string;
  python: string;
}>;

export type TownEvidenceObservation = Readonly<{
  version: '0.1';
  adapterObservedAt: number;
  runtime: { commit: typeof TOWN_EVIDENCE_COMMIT; python: typeof TOWN_EVIDENCE_PYTHON };
  town: { version: '0.2.0'; declaredPython: '3.12.13';
    inspectedBase: '17fbc7902be49683aee5f7610a0a1dcf8c803b3e';
    observerSourceFingerprint: `sha256:${string}` };
  receipt: {
    observer: string; capability: 'city-a2a-structured-task'; subject: string;
    profile: 'city-a2a-protocol@0.1';
    verdict: 'passed' | 'failed' | 'incomplete' | 'error';
    profileFingerprint: 'sha256:e6a1cc01584de3547a76ddc3b2bbac6d366258bc8603a26a1dad2ebd5c5212cc';
    parsedCardSha256: `sha256:${string}`;
    started: number; evaluated: number;
    tested: string[]; notTested: string[]; limitations: string[];
    bundleFingerprint: `sha256:${string}`; resultDigest: `sha256:${string}`; runId: string;
  };
  observation: {
    subjectUrl: string; cardUrl: string; cardBase64: string; requestRpcBase64: string;
    cardBytesSha256: `sha256:${string}`; parsedCardSha256: `sha256:${string}`;
  };
  result: { profileEvaluator: 'city-a2a-protocol-evaluator@0.1';
    evaluator: 'path-city-a2a-protocol-0.1';
    stages: Array<{ name: string; status:
      'passed' | 'failed' | 'not_enough_evidence' | 'not_tested' | 'error' }> };
}>;

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const finite = z.number().finite();
const nativeSchema = z.strictObject({
  town: z.strictObject({ version: z.literal('0.2.0'), declaredPython: z.literal('3.12.13'),
    inspectedBase: z.literal('17fbc7902be49683aee5f7610a0a1dcf8c803b3e'),
    observerSourceFingerprint: sha256 }),
  receipt: z.strictObject({
    observer: z.string().min(1), capability: z.literal('city-a2a-structured-task'),
    subject: z.string().min(1), profile: z.literal('city-a2a-protocol@0.1'),
    verdict: z.enum(['passed', 'failed', 'incomplete', 'error']),
    profileFingerprint: z.literal('sha256:e6a1cc01584de3547a76ddc3b2bbac6d366258bc8603a26a1dad2ebd5c5212cc'),
    parsedCardSha256: sha256, started: finite, evaluated: finite,
    tested: z.array(z.string().min(1)).max(32), notTested: z.array(z.string().min(1)).max(32),
    limitations: z.array(z.string().min(1)).length(5), bundleFingerprint: sha256,
    resultDigest: sha256, runId: z.string().min(1),
  }),
  observation: z.strictObject({
    subjectUrl: z.string().min(1), cardUrl: z.string().min(1),
    cardBase64: z.string(), requestRpcBase64: z.string(), cardBytesSha256: sha256,
    parsedCardSha256: sha256,
  }),
  result: z.strictObject({ profileEvaluator: z.literal('city-a2a-protocol-evaluator@0.1'),
    evaluator: z.literal('path-city-a2a-protocol-0.1'), stages: z.array(z.strictObject({
      name: z.string().min(1), status: z.enum(['passed', 'failed', 'not_enough_evidence', 'not_tested', 'error']),
    })).max(32) }),
});

type Deadline = { check: () => void; remaining: () => number };
function deadline(signal: AbortSignal): Deadline {
  const end = performance.now() + 10_000;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= end) throw rejected();
  };
  return { check, remaining: () => { check(); return Math.max(1, end - performance.now()); } };
}

function equalStat(left: BigIntStats, right: BigIntStats): boolean {
  return (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const)
    .every((key) => left[key] === right[key]);
}

type Opened = { name: (typeof FILES)[number]; descriptor: FileHandle;
  before: BigIntStats };

async function snapshotBundle(source: string, signal: AbortSignal, clock: Deadline,
  work?: Pick<RankingReadBudget, 'check' | 'chargeBundle'>): Promise<string> {
  if (!process.getuid || !isAbsolute(source) || resolve(source) !== source || await realpath(source) !== source) throw rejected();
  const directoryBefore = await lstat(source, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.uid !== BigInt(process.getuid())) throw rejected();
  const opened: Opened[] = [];
  let temporary: string | undefined;
  try {
    const identities = new Set<string>();
    let total = 0;
    for (const name of FILES) {
      clock.check(); work?.check();
      const path = join(source, name);
      const named = await lstat(path, { bigint: true });
      if (!named.isFile() || named.uid !== BigInt(process.getuid()) || named.nlink !== 1n ||
          named.size > BigInt(limits[name])) throw rejected();
      const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await descriptor.stat({ bigint: true });
      if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
          !equalStat(before, named) || before.size > BigInt(limits[name])) {
        await descriptor.close(); throw rejected();
      }
      const identity = `${before.dev}:${before.ino}`;
      if (identities.has(identity)) { await descriptor.close(); throw rejected(); }
      identities.add(identity); total += Number(before.size);
      if (total > TOTAL_LIMIT) { await descriptor.close(); throw rejected(); }
      opened.push({ name, descriptor, before });
    }
    temporary = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-town-evidence-'));
    await chmod(temporary, 0o700);
    for (const item of opened) {
      clock.check(); work?.check();
      const length = Number(item.before.size);
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        clock.check(); work?.check();
        const size = Math.min(65_536, length - offset);
        const result = await item.descriptor.read(bytes, offset, size, offset);
        if (result.bytesRead === 0) throw rejected();
        offset += result.bytesRead;
        work?.chargeBundle(result.bytesRead);
      }
      const extra = Buffer.alloc(1);
      if ((await item.descriptor.read(extra, 0, 1, offset)).bytesRead !== 0) throw rejected();
      const target = await open(join(temporary, item.name), 'wx', 0o600);
      try { await target.writeFile(bytes); await target.sync(); } finally { await target.close(); }
    }
    for (const item of opened) {
      clock.check(); work?.check();
      const after = await item.descriptor.stat({ bigint: true });
      const named = await lstat(join(source, item.name), { bigint: true });
      if (!equalStat(item.before, after) || !equalStat(item.before, named)) throw rejected();
    }
    const directoryAfter = await lstat(source, { bigint: true });
    if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino ||
        directoryBefore.uid !== directoryAfter.uid || await realpath(source) !== source) throw rejected();
    signal.throwIfAborted();
    return temporary;
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled(opened.map((item) => item.descriptor.close()));
  }
}

async function run(binary: string, args: string[], options: { cwd?: string; cap: number;
  signal: AbortSignal; clock: Deadline; env?: NodeJS.ProcessEnv }): Promise<string> {
  options.clock.check();
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutLength = 0; let stderrLength = 0; let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined; let abortListening = false;
    const fail = () => {
      failed = true;
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* close/error still owns settlement */ }
      }
    };
    const abort = () => fail();
    child.once('close', (code, childSignal) => {
      if (timer) clearTimeout(timer);
      if (abortListening) options.signal.removeEventListener('abort', abort);
      if (failed || code !== 0 || childSignal !== null) { rejectPromise(rejected()); return; }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
    const output = (target: Buffer[], stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (stream === 'stdout') stdoutLength += chunk.byteLength; else stderrLength += chunk.byteLength;
      if ((stream === 'stdout' ? stdoutLength : stderrLength) > options.cap) { fail(); return; }
      target.push(chunk);
    };
    try {
      child.once('error', fail);
      child.stdout.on('data', output(stdout, 'stdout'));
      child.stderr.on('data', output(stderr, 'stderr'));
      options.signal.addEventListener('abort', abort, { once: true });
      abortListening = true;
      if (options.signal.aborted) fail();
      const remaining = options.clock.remaining();
      if (!failed) timer = setTimeout(fail, remaining);
    } catch { fail(); }
  });
}

function parseJson(text: string): unknown {
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw rejected();
  try { return JSON.parse(text) as unknown; } catch { throw rejected(); }
}

async function checkedRuntime(runtime: TownEvidenceRuntime, signal: AbortSignal,
  clock: Deadline): Promise<{ checkout: string; python: string; townSource: string }> {
  if (!runtime || !isAbsolute(runtime.checkout) || resolve(runtime.checkout) !== runtime.checkout ||
      await realpath(runtime.checkout) !== runtime.checkout || !isAbsolute(runtime.python)) throw rejected();
  const checkout = runtime.checkout;
  if (await realpath(dirname(runtime.python)) !== dirname(runtime.python)) throw rejected();
  const pythonTarget = await realpath(runtime.python);
  const target = await lstat(pythonTarget, { bigint: true });
  if (!target.isFile() || (target.mode & 0o111n) === 0n) throw rejected();
  const python = runtime.python;
  const git = '/usr/bin/git';
  const head = (await run(git, ['rev-parse', '--verify', 'HEAD^{commit}'],
    { cwd: checkout, cap: 4096, signal, clock })).trim();
  if (head !== TOWN_EVIDENCE_COMMIT) throw rejected();
  if ((await run(git, ['status', '--porcelain=v1', '--untracked-files=normal'],
    { cwd: checkout, cap: 4096, signal, clock })).trim()) throw rejected();
  if ((await run(python, ['--version'], { cap: 2 * 1024 * 1024, signal, clock })).trim() !==
      `Python ${TOWN_EVIDENCE_PYTHON}`) throw rejected();
  const townSource = join(checkout, 'src');
  if (await realpath(townSource) !== townSource) throw rejected();
  return { checkout, python, townSource };
}

export async function readTownEvidence(input: {
  bundleDirectory: string;
  runtime: TownEvidenceRuntime;
  signal?: AbortSignal;
  work?: Pick<RankingReadBudget, 'check' | 'chargeBundle'>;
}): Promise<TownEvidenceObservation> {
  try {
    return await withOwnedLifecycle(async (lifecycle) => {
      try {
        const signal = input.signal ? AbortSignal.any([input.signal, lifecycle.signal]) : lifecycle.signal;
        const clock = deadline(signal);
        const runtime = await checkedRuntime({ ...input.runtime }, signal, clock);
        const snapshot = await snapshotBundle(input.bundleDirectory, signal, clock, input.work);
        try {
          const script = fileURLToPath(new URL('../../scripts/town_receipt_bridge.py', import.meta.url));
          const vector = parseJson(await run(runtime.python,
            ['-I', '-B', script, 'fingerprint-vector', '--town-src', runtime.townSource],
            { cwd: runtime.checkout, cap: 2 * 1024 * 1024, signal, clock })) as { fingerprint?: unknown };
          if (!vector || typeof vector !== 'object' || vector.fingerprint !== TOWN_VECTOR) throw rejected();
          const native = nativeSchema.parse(parseJson(await run(runtime.python,
            ['-I', '-B', script, 'verify', '--town-src', runtime.townSource, '--bundle', snapshot],
            { cwd: runtime.checkout, cap: 2 * 1024 * 1024, signal, clock })));
          const adapterObservedAt = Date.now() / 1000;
          if (!Number.isFinite(adapterObservedAt) || adapterObservedAt < native.receipt.evaluated) throw rejected();
          return {
            version: '0.1', adapterObservedAt,
            runtime: { commit: TOWN_EVIDENCE_COMMIT, python: TOWN_EVIDENCE_PYTHON },
            town: native.town, receipt: native.receipt,
            observation: native.observation, result: native.result,
          } as TownEvidenceObservation;
        } finally {
          await rm(snapshot, { recursive: true, force: true });
        }
      } catch (error) {
        if (lifecycle.signal.aborted && error === lifecycle.signal.reason) throw error;
        throw rejected();
      }
    });
  } catch { throw rejected(); }
}

const retainedRpcSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().min(1), z.number().safe()]),
  method: z.literal('message/send'),
  params: sendParamsSchema,
});
const requiredStages = ['pinned_card', 'structured_send', 'acceptance_task',
  'exact_retry', 'terminal_task'] as const;
const replayPrefix = 'evaluator replay not checked: ';
const equalHex = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const sameAgent = (left: { chainId: number; registry: string; agentId: string },
  right: { chainId: number; registry: string; agentId: string }): boolean =>
  left.chainId === right.chainId && equalHex(left.registry, right.registry) && left.agentId === right.agentId;

function decodedBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid retained Base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical retained Base64');
  return bytes;
}

function a2aCardUrl(profile: VerifiedProfile): string | null {
  const services = profile.registration.services.filter((service) => service.name === 'A2A');
  return services.length === 1 ? services[0]!.endpoint : null;
}

/**
 * @internal Composer-only projection over adapter output and independently read
 * profiles/epoch. This is not a raw-input CLI, HTTP API, or consumer trust boundary.
 */
export async function qualifyTownTestAdmission(input: {
  evidence: TownEvidenceObservation;
  service: string;
  acceptedEvaluators: readonly string[];
  basisProfile: VerifiedProfile;
  currentProfile: VerifiedProfile;
  currentCardBytes: Uint8Array;
  epoch: Awaited<ReturnType<typeof readIdentityFeedbackEpoch>>;
}): Promise<{
  admission: Extract<PolicyInput['admissions'][number], { kind: 'test' }>;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const invalid = (condition: boolean, code: string): void => { if (!condition) diagnostics.push(code); };
  const evidence = input.evidence;
  let requestEnvelope: unknown;
  let request: ReturnType<typeof decodeEnvelope>['statement']['value'];
  let retainedCard: Buffer;
  try {
    retainedCard = decodedBase64(evidence.observation.cardBase64);
    const requestBytes = decodedBase64(evidence.observation.requestRpcBase64);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(requestBytes);
    const rpc = retainedRpcSchema.parse(JSON.parse(text) as unknown);
    requestEnvelope = cityRequestEnvelopeFromParams(rpc.params);
    const decoded = decodeEnvelope(requestEnvelope);
    request = decoded.statement.value;
    if (request.kind !== 'request') throw new Error('wrong retained statement');
  } catch {
    throw new Error('verified Town request projection rejected');
  }

  const statement = request;
  const profileBasis = statement.profileBasis;
  const basis = input.basisProfile;
  const current = input.currentProfile;
  const sameRequestAgent = (profile: VerifiedProfile) => sameAgent(profile.agent, statement.service.agent);
  invalid(sameRequestAgent(basis) && sameRequestAgent(current) && sameAgent(basis.agent, current.agent),
    'service-agent-mismatch');
  invalid(basis.source.blockNumber === profileBasis.blockNumber &&
    equalHex(basis.source.blockHash, profileBasis.blockHash) &&
    equalHex(basis.source.agentOwner, profileBasis.agentOwner) &&
    equalHex(basis.source.agentUriDigest, profileBasis.agentUriDigest) &&
    equalHex(basis.source.registrationDigest, profileBasis.registrationDigest) &&
    equalHex(basis.source.cardDigest, profileBasis.cardDigest) &&
    equalHex(basis.registration['x-nandacity'].receiptSigner, profileBasis.receiptSigner),
  'historical-profile-mismatch');
  invalid(current.registration.active, 'current-profile-inactive');

  const townCardDigest = digestBytes(retainedCard);
  invalid(input.currentCardBytes instanceof Uint8Array && retainedCard.equals(input.currentCardBytes),
    'current-card-bytes-mismatch');
  invalid(equalHex(townCardDigest, basis.source.cardDigest) &&
    equalHex(digestBytes(input.currentCardBytes), current.source.cardDigest) &&
    equalHex(townCardDigest, current.source.cardDigest), 'profile-card-digest-mismatch');
  const townSha256 = `sha256:${createHash('sha256').update(retainedCard).digest('hex')}`;
  invalid(townSha256 === evidence.observation.cardBytesSha256 &&
    evidence.observation.parsedCardSha256 === evidence.receipt.parsedCardSha256,
  'town-card-commitment-mismatch');
  invalid(evidence.receipt.subject === evidence.observation.subjectUrl &&
    evidence.observation.subjectUrl === basis.card.url && evidence.observation.subjectUrl === current.card.url,
  'service-endpoint-mismatch');
  invalid(evidence.observation.cardUrl === a2aCardUrl(basis) &&
    evidence.observation.cardUrl === a2aCardUrl(current), 'card-url-mismatch');
  const extension = current.registration['x-nandacity'];
  invalid(extension.capability === 'evening-plan' && statement.input.capability === 'evening-plan' &&
    current.card.skills.some((skill) => skill.id === 'evening-plan'), 'capability-mismatch');
  invalid(extension.areaServed.some((area) => area.name === statement.input.city), 'city-mismatch');

  const signature = await verifyEnvelopeSignature(requestEnvelope, statement.service.agent.chainId);
  const decoded = decodeEnvelope(requestEnvelope);
  invalid(signature.status === 'valid' && decoded.envelope.signer.chainId === statement.caller.chainId &&
    equalHex(decoded.envelope.signer.address, statement.caller.address), 'request-signature-invalid');

  invalid(input.acceptedEvaluators.includes(evidence.receipt.observer), 'observer-not-accepted');
  invalid(evidence.runtime.commit === TOWN_EVIDENCE_COMMIT && evidence.runtime.python === TOWN_EVIDENCE_PYTHON &&
    evidence.town.version === '0.2.0' && evidence.town.declaredPython === '3.12.13' &&
    evidence.town.inspectedBase === '17fbc7902be49683aee5f7610a0a1dcf8c803b3e' &&
    evidence.receipt.capability === 'city-a2a-structured-task' &&
    evidence.receipt.profile === 'city-a2a-protocol@0.1' &&
    evidence.receipt.profileFingerprint === 'sha256:e6a1cc01584de3547a76ddc3b2bbac6d366258bc8603a26a1dad2ebd5c5212cc' &&
    evidence.result.profileEvaluator === 'city-a2a-protocol-evaluator@0.1' &&
    evidence.result.evaluator === 'path-city-a2a-protocol-0.1', 'town-release-mismatch');
  invalid(evidence.receipt.verdict === 'passed', 'town-verdict-not-passed');
  invalid(evidence.result.stages.length === requiredStages.length &&
    evidence.result.stages.every((stage, index) => stage.name === requiredStages[index] && stage.status === 'passed'),
  'town-stages-incomplete');
  invalid(evidence.receipt.tested.length === requiredStages.length &&
    evidence.receipt.tested.every((stage, index) => stage === requiredStages[index]) &&
    evidence.receipt.notTested.length === 0, 'town-coverage-incomplete');
  invalid(!evidence.receipt.limitations.some((limitation) => limitation.startsWith(replayPrefix)),
    'town-replay-unchecked');

  const created = Date.parse(statement.createdAt) / 1000;
  const requestDeadline = Date.parse(statement.deadline) / 1000;
  const { started, evaluated } = evidence.receipt;
  invalid([created, requestDeadline, started, evaluated, evidence.adapterObservedAt].every(Number.isFinite) &&
    created <= started && started <= evaluated && evaluated <= requestDeadline &&
    evaluated <= evidence.adapterObservedAt && evidence.adapterObservedAt - evaluated <= 2_592_000,
  'town-window-invalid');

  invalid(input.epoch.basis.blockNumber === basis.source.blockNumber &&
    equalHex(input.epoch.basis.blockHash, basis.source.blockHash) &&
    input.epoch.observation.blockNumber === current.source.blockNumber &&
    equalHex(input.epoch.observation.blockHash, current.source.blockHash), 'epoch-coordinate-mismatch');
  if (input.epoch.epoch === 'retired') diagnostics.push('identity-epoch-retired');
  else if (input.epoch.epoch === 'unknown') diagnostics.push('identity-epoch-unknown');

  const unknown = diagnostics.length === 1 && diagnostics[0] === 'identity-epoch-unknown';
  const status: 'valid' | 'invalid' | 'unknown' = diagnostics.length === 0 ? 'valid' : unknown ? 'unknown' : 'invalid';
  return {
    admission: {
      kind: 'test', id: `town-test:${evidence.receipt.bundleFingerprint}`,
      service: input.service, issuer: evidence.receipt.observer,
      city: statement.input.city, task: statement.input.capability,
      status, provenance: 'adapter-observed', endpoint: current.card.url,
      cardDigest: current.source.cardDigest,
    },
    diagnostics,
  };
}
