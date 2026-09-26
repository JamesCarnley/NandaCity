import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { digestBytes } from '../identity/profile.js';
import type { VerifiedProfile } from '../identity/verify.js';
import { decodeEnvelope, signProviderStatement } from '../interaction/signatures.js';
import { isUtcSecond, type CityAcceptance, type CityCompletion, type CityRequest, type SignedEnvelope } from '../interaction/schema.js';
import { verifyInteraction, type ContinuityFinding } from '../interaction/verify.js';
import type { PrivateKeyAccount } from 'viem/accounts';
import { syntheticEveningPlan } from './answer.js';
import { CityTaskStore } from './store.js';
import {
  CITY_REQUEST_DATA_TYPE,
  CITY_RESULT_DATA_TYPE,
  CITY_STATUS_DATA_TYPE,
  cityRequestEnvelopeFromParams,
  sendParamsSchema,
  taskQueryParamsSchema,
  type A2AMessage,
  type A2ATask,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcResponse,
  type StoredTaskRecord,
} from './wire.js';

export { CITY_REQUEST_DATA_TYPE, type A2ATask, type JsonRpcResponse } from './wire.js';

const MAX_HTTP_BODY_BYTES = 128 * 1024;
const MAX_ANSWER_BYTES = 256 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 5_000;
const MAX_EXECUTION_TIMEOUT_MS = 60_000;

export type AuthorityObservation = {
  basisProfile: VerifiedProfile | null;
  currentProfile: VerifiedProfile | null;
  continuity: ContinuityFinding;
  observedAt: string;
};

export type ExecutionContext = { taskId: string; contextId: string; signal: AbortSignal };

export type LoopbackServiceOptions = {
  storeDirectory: string;
  runtimeSigner: PrivateKeyAccount;
  observeAuthority: (request: CityRequest) => Promise<AuthorityObservation>;
  now: () => string;
  executionTimeoutMs?: number;
  execute?: (request: CityRequest, context: ExecutionContext) => Promise<Uint8Array>;
};

export type LoopbackA2AService = {
  url: string;
  close: () => Promise<void>;
};

class RpcFault extends Error {
  constructor(readonly rpc: JsonRpcError) {
    super(rpc.message);
  }
}

class ExecutionTimeoutError extends Error {}

type AcceptedFinding = Awaited<ReturnType<typeof verifyInteraction>>;
type AuthorityCheck =
  | { observation: AuthorityObservation; finding: AcceptedFinding }
  | { reason: string };

function rpcFault(code: number, message: string, reason?: string): RpcFault {
  return new RpcFault({ code, message, ...(reason ? { data: { reason } } : {}) });
}

function interactionKey(request: CityRequest): string {
  const agent = request.service.agent;
  return [
    request.service.method,
    agent.chainId,
    agent.registry.toLowerCase(),
    agent.agentId,
    request.caller.method,
    request.caller.chainId,
    request.caller.address.toLowerCase(),
    request.interactionId,
  ].join(':');
}

function providerMessage(messageId: string, data: Record<string, unknown>): A2AMessage {
  return { kind: 'message', role: 'agent', messageId, parts: [{ kind: 'data', data }] };
}

function metadataFor(request: CityRequest, acceptance: SignedEnvelope): Record<string, unknown> {
  return {
    'org.nandacity': {
      subset: 'a2a-0.3-jsonrpc-loopback',
      pollingAuthentication: 'none-loopback-only',
      interactionId: request.interactionId,
      acceptance,
    },
  };
}

function authorityFailureReason(observation: AuthorityObservation, finding: Awaited<ReturnType<typeof verifyInteraction>>): string {
  if (finding.request.cryptography !== 'valid' || finding.request.signerBinding !== 'matched') return 'request-signature-invalid';
  if (finding.request.profileBasis === 'mismatched') return 'profile-basis-mismatch';
  if (finding.request.deadline === 'expired') return 'deadline-expired';
  if (observation.continuity === 'changed' || finding.request.currentAuthority === 'unauthorized') return 'authority-changed';
  if (observation.continuity === 'unknown' || finding.request.profileBasis === 'unavailable' ||
      finding.request.currentAuthority === 'unavailable') return 'authority-unavailable';
  return 'request-evidence-invalid';
}

function terminalAuthorityEligible(finding: Awaited<ReturnType<typeof verifyInteraction>>): boolean {
  const request = finding.request;
  const acceptance = finding.acceptance;
  return request.cryptography === 'valid' && request.signerBinding === 'matched' &&
    request.profileBasis === 'matched' && request.currentAuthority === 'authorized' &&
    request.continuity === 'unchanged' && request.claimedTime === 'observed' &&
    acceptance !== undefined && acceptance.cryptography === 'valid' &&
    acceptance.signerBinding === 'matched' && acceptance.profileBasis === 'matched' &&
    acceptance.currentAuthority === 'authorized' && acceptance.continuity === 'unchanged' &&
    acceptance.claimedTime === 'observed' && acceptance.link === 'matched';
}

function asCityMetadata(task: A2ATask): Record<string, unknown> {
  const existing = task.metadata?.['org.nandacity'];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('persisted task lacks City metadata');
  return existing as Record<string, unknown>;
}

class CityA2ARuntime {
  readonly #running = new Map<string, Promise<void>>();
  #closed = false;

  constructor(private readonly store: CityTaskStore, private readonly options: LoopbackServiceOptions) {}

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#running.values());
  }

  async getTask(taskId: string, historyLength?: number): Promise<A2ATask> {
    const record = this.store.getByTask(taskId);
    if (!record) throw rpcFault(-32001, 'Task not found', 'task-not-found');
    this.schedule(record);
    if (historyLength !== undefined) {
      return {
        ...record.task,
        history: historyLength === 0 ? [] : (record.task.history ?? []).slice(-historyLength),
      };
    }
    return record.task;
  }

  async send(value: unknown): Promise<A2ATask> {
    let params: ReturnType<typeof sendParamsSchema.parse>;
    let decoded: ReturnType<typeof decodeEnvelope>;
    try {
      params = sendParamsSchema.parse(value);
      decoded = decodeEnvelope(cityRequestEnvelopeFromParams(params));
      if (decoded.statement.value.kind !== 'request') throw new Error('City DataPart must contain a request envelope');
    } catch {
      throw rpcFault(-32602, 'Invalid method parameters', 'invalid-city-request-part');
    }
    if (params.configuration?.blocking === true) {
      throw rpcFault(-32004, 'This operation is not supported', 'blocking-send-unsupported');
    }
    if (params.configuration?.historyLength !== undefined) {
      throw rpcFault(-32004, 'This operation is not supported', 'send-history-length-unsupported');
    }
    if (params.configuration?.acceptedOutputModes &&
        !params.configuration.acceptedOutputModes.includes('application/json')) {
      throw rpcFault(-32005, 'Incompatible content types', 'json-output-not-accepted');
    }
    const request = decoded.statement.value;
    const requestEnvelope = cityRequestEnvelopeFromParams(params) as SignedEnvelope;
    const key = interactionKey(request);

    return this.store.withInteractionLock(key, async () => {
      const existing = this.store.getByInteraction(key);
      if (existing) {
        if (existing.requestDigest !== decoded.statement.digest) {
          throw rpcFault(-32009, 'Interaction key conflicts with different request bytes', 'interaction-key-conflict');
        }
        this.schedule(existing);
        return existing.task;
      }

      const acceptedAt = this.options.now();
      if (!isUtcSecond(acceptedAt) || Date.parse(acceptedAt) < Date.parse(request.createdAt) ||
          Date.parse(acceptedAt) > Date.parse(request.deadline)) {
        throw rpcFault(-32011, 'Acceptance time is outside the signed request window', 'acceptance-time-invalid');
      }
      let observation: AuthorityObservation;
      try { observation = await this.options.observeAuthority(request); }
      catch { throw rpcFault(-32010, 'Authority observation unavailable', 'authority-unavailable'); }
      if (Date.parse(acceptedAt) > Date.parse(observation.observedAt)) {
        throw rpcFault(-32010, 'Authority observation predates acceptance', 'authority-observation-stale');
      }
      const finding = await verifyInteraction({
        request: requestEnvelope,
        basisProfile: observation.basisProfile,
        currentProfile: observation.currentProfile,
        continuity: observation.continuity,
        observedAt: observation.observedAt,
      });
      if (!finding.request.usableAtObservation) {
        const reason = authorityFailureReason(observation, finding);
        const code = reason === 'request-evidence-invalid' ? -32602 : -32010;
        throw rpcFault(code, 'Request evidence is not currently usable', reason);
      }
      if (!observation.currentProfile) throw rpcFault(-32010, 'Authority observation unavailable', 'authority-unavailable');
      if (this.options.runtimeSigner.address.toLowerCase() !==
          observation.currentProfile.registration['x-nandacity'].receiptSigner.toLowerCase()) {
        throw rpcFault(-32010, 'Runtime signer is not authorized by the current profile', 'runtime-signer-unauthorized');
      }

      const acceptanceValue: CityAcceptance = {
        kind: 'acceptance',
        version: '0.1',
        requestDigest: decoded.statement.digest,
        acceptanceId: `0x${randomBytes(32).toString('hex')}`,
        acceptedAt,
        deadline: request.deadline,
      };
      const acceptance = await signProviderStatement(acceptanceValue, this.options.runtimeSigner, observation.currentProfile);
      const taskId = randomUUID();
      const contextId = randomUUID();
      const submitted: A2ATask = {
        kind: 'task',
        id: taskId,
        contextId,
        status: {
          state: 'submitted',
          timestamp: acceptedAt,
          message: providerMessage(randomUUID(), {
            type: CITY_STATUS_DATA_TYPE,
            version: '0.1',
            state: 'accepted',
            acceptance,
          }),
        },
        history: [{
          kind: params.message.kind,
          role: params.message.role,
          messageId: params.message.messageId,
          parts: params.message.parts.map((part) => ({
            kind: part.kind,
            data: part.data,
            ...(part.metadata ? { metadata: part.metadata } : {}),
          })),
          ...(params.message.metadata ? { metadata: params.message.metadata } : {}),
        }],
        metadata: metadataFor(request, acceptance),
      };
      const record: StoredTaskRecord = {
        version: '0.1',
        interactionKey: key,
        requestDigest: decoded.statement.digest,
        requestEnvelope,
        acceptance,
        task: submitted,
      };
      await this.store.save(record);
      this.schedule(record);
      return submitted;
    });
  }

  private schedule(record: StoredTaskRecord): void {
    if (this.#closed || record.task.status.state !== 'submitted' || this.#running.has(record.interactionKey)) return;
    let resolveStart!: () => void;
    const start = new Promise<void>((resolve) => { resolveStart = resolve; });
    const running = start
      .then(() => this.executeAccepted(record))
      .catch(() => undefined)
      .finally(() => { this.#running.delete(record.interactionKey); });
    this.#running.set(record.interactionKey, running);
    setImmediate(resolveStart);
  }

  private async executeAccepted(record: StoredTaskRecord): Promise<void> {
    const requestStatement = decodeEnvelope(record.requestEnvelope).statement.value;
    if (requestStatement.kind !== 'request') throw new Error('persisted request has wrong statement kind');
    const acceptanceStatement = decodeEnvelope(record.acceptance).statement.value;
    if (acceptanceStatement.kind !== 'acceptance') throw new Error('persisted acceptance has wrong statement kind');
    const request = requestStatement;

    const workStartedAt = this.options.now();
    const prework = await this.checkAcceptedAuthority(record, workStartedAt);
    if ('reason' in prework) {
      await this.failWithoutCompletion(record, prework.reason);
      return;
    }
    if (Date.parse(workStartedAt) > Date.parse(request.deadline)) {
      if (terminalAuthorityEligible(prework.finding) && prework.observation.currentProfile) {
        await this.failWithExpiredCompletion(record, prework.observation.currentProfile, workStartedAt);
      } else {
        await this.failWithoutCompletion(record, authorityFailureReason(prework.observation, prework.finding));
      }
      return;
    }
    if (!prework.finding.allPresentedEvidenceUsableAtObservation || !prework.observation.currentProfile) {
      await this.failWithoutCompletion(record, authorityFailureReason(prework.observation, prework.finding));
      return;
    }

    let answerBytes: Uint8Array;
    try {
      answerBytes = await this.runExecutor(request, record);
      if (!(answerBytes instanceof Uint8Array) || answerBytes.byteLength === 0 || answerBytes.byteLength > MAX_ANSWER_BYTES) {
        throw new Error('executor returned invalid answer bytes');
      }
    } catch (error) {
      await this.finalizeExecutionFailure(
        record,
        error instanceof ExecutionTimeoutError ? 'execution-timeout' : 'provider-error',
      );
      return;
    }

    const recordedAt = this.options.now();
    const terminal = await this.checkAcceptedAuthority(record, recordedAt);
    if ('reason' in terminal) {
      await this.failWithoutCompletion(record, terminal.reason);
      return;
    }
    if (Date.parse(recordedAt) > Date.parse(request.deadline)) {
      if (terminalAuthorityEligible(terminal.finding) && terminal.observation.currentProfile) {
        await this.failWithExpiredCompletion(record, terminal.observation.currentProfile, recordedAt);
      } else {
        await this.failWithoutCompletion(record, authorityFailureReason(terminal.observation, terminal.finding));
      }
      return;
    }
    if (!terminal.finding.allPresentedEvidenceUsableAtObservation || !terminal.observation.currentProfile) {
      await this.failWithoutCompletion(record, authorityFailureReason(terminal.observation, terminal.finding));
      return;
    }
    const completionValue: CityCompletion = {
      kind: 'completion',
      version: '0.1',
      acceptanceDigest: decodeEnvelope(record.acceptance).statement.digest,
      recordedAt,
      outcome: 'completed',
      answerDigest: digestBytes(answerBytes),
    };
    let completion: SignedEnvelope;
    try {
      completion = await signProviderStatement(completionValue, this.options.runtimeSigner, terminal.observation.currentProfile);
    } catch {
      await this.failWithoutCompletion(record, 'terminal-signing-failed');
      return;
    }
    const completedMetadata = { ...asCityMetadata(record.task), completion };
    const completed: A2ATask = {
      ...record.task,
      status: { state: 'completed', timestamp: recordedAt },
      artifacts: [{
        artifactId: randomUUID(),
        name: 'Nanda City synthetic evening plan',
        description: 'Exact authored fixture bytes and linked signed completion.',
        parts: [{
          kind: 'data',
          data: {
            type: CITY_RESULT_DATA_TYPE,
            version: '0.1',
            answerBase64: Buffer.from(answerBytes).toString('base64'),
            completion,
          },
        }],
      }],
      metadata: { 'org.nandacity': completedMetadata },
    };
    await this.store.save({ ...record, task: completed });
  }

  private async runExecutor(request: CityRequest, record: StoredTaskRecord): Promise<Uint8Array> {
    const execute = this.options.execute ?? (async (cityRequest: CityRequest) => syntheticEveningPlan(cityRequest));
    const controller = new AbortController();
    const timeoutMs = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ExecutionTimeoutError());
      }, timeoutMs);
      timer.unref();
    });
    const execution = Promise.resolve().then(() => execute(request, {
      taskId: record.task.id,
      contextId: record.task.contextId,
      signal: controller.signal,
    }));
    try {
      return await Promise.race([execution, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async checkAcceptedAuthority(record: StoredTaskRecord, claimedAt: string): Promise<AuthorityCheck> {
    const acceptance = decodeEnvelope(record.acceptance).statement.value;
    if (acceptance.kind !== 'acceptance') throw new Error('persisted acceptance has wrong statement kind');
    if (!isUtcSecond(claimedAt) || Date.parse(claimedAt) < Date.parse(acceptance.acceptedAt)) {
      return { reason: 'terminal-time-invalid' };
    }
    let observation: AuthorityObservation;
    const request = decodeEnvelope(record.requestEnvelope).statement.value;
    if (request.kind !== 'request') return { reason: 'request-evidence-invalid' };
    try { observation = await this.options.observeAuthority(request); }
    catch { return { reason: 'authority-unavailable' }; }
    if (!isUtcSecond(observation.observedAt)) return { reason: 'authority-observation-invalid' };
    if (Date.parse(claimedAt) > Date.parse(observation.observedAt)) {
      return { reason: 'authority-observation-stale' };
    }
    try {
      const finding = await verifyInteraction({
        request: record.requestEnvelope,
        acceptance: record.acceptance,
        basisProfile: observation.basisProfile,
        currentProfile: observation.currentProfile,
        continuity: observation.continuity,
        observedAt: observation.observedAt,
      });
      if (finding.request.currentAuthority === 'authorized' && observation.currentProfile &&
          this.options.runtimeSigner.address.toLowerCase() !==
            observation.currentProfile.registration['x-nandacity'].receiptSigner.toLowerCase()) {
        return { reason: 'runtime-signer-unauthorized' };
      }
      return { observation, finding };
    } catch {
      return { reason: 'request-evidence-invalid' };
    }
  }

  private async finalizeExecutionFailure(
    record: StoredTaskRecord,
    failureReason: 'provider-error' | 'execution-timeout',
  ): Promise<StoredTaskRecord> {
    const requestStatement = decodeEnvelope(record.requestEnvelope).statement.value;
    if (requestStatement.kind !== 'request') throw new Error('persisted request has wrong statement kind');
    const recordedAt = this.options.now();
    const terminal = await this.checkAcceptedAuthority(record, recordedAt);
    if ('reason' in terminal) return this.failWithoutCompletion(record, terminal.reason);
    if (Date.parse(recordedAt) > Date.parse(requestStatement.deadline)) {
      if (terminalAuthorityEligible(terminal.finding) && terminal.observation.currentProfile) {
        return this.failWithExpiredCompletion(record, terminal.observation.currentProfile, recordedAt);
      }
      return this.failWithoutCompletion(record, authorityFailureReason(terminal.observation, terminal.finding));
    }
    if (!terminal.finding.allPresentedEvidenceUsableAtObservation || !terminal.observation.currentProfile) {
      return this.failWithoutCompletion(record, authorityFailureReason(terminal.observation, terminal.finding));
    }
    const completionValue: CityCompletion = {
      kind: 'completion',
      version: '0.1',
      acceptanceDigest: decodeEnvelope(record.acceptance).statement.digest,
      recordedAt,
      outcome: 'failed',
      reason: 'provider-error',
    };
    let completion: SignedEnvelope;
    try {
      completion = await signProviderStatement(completionValue, this.options.runtimeSigner, terminal.observation.currentProfile);
    } catch {
      return this.failWithoutCompletion(record, 'terminal-signing-failed');
    }
    const metadata = { ...asCityMetadata(record.task), completion, failureReason };
    const failed: A2ATask = {
      ...record.task,
      status: {
        state: 'failed',
        timestamp: recordedAt,
        message: providerMessage(randomUUID(), {
          type: CITY_STATUS_DATA_TYPE,
          version: '0.1',
          state: 'failed',
          reason: failureReason,
          acceptance: record.acceptance,
          completion,
        }),
      },
      metadata: { 'org.nandacity': metadata },
    };
    const next = { ...record, task: failed };
    await this.store.save(next);
    return next;
  }

  private async failWithExpiredCompletion(
    record: StoredTaskRecord,
    currentProfile: VerifiedProfile,
    recordedAt: string,
  ): Promise<StoredTaskRecord> {
    const completionValue: CityCompletion = {
      kind: 'completion',
      version: '0.1',
      acceptanceDigest: decodeEnvelope(record.acceptance).statement.digest,
      recordedAt,
      outcome: 'expired',
    };
    let completion: SignedEnvelope;
    try {
      completion = await signProviderStatement(completionValue, this.options.runtimeSigner, currentProfile);
    } catch {
      return this.failWithoutCompletion(record, 'terminal-signing-failed');
    }
    const metadata = { ...asCityMetadata(record.task), completion, failureReason: 'deadline-expired' };
    const failed: A2ATask = {
      ...record.task,
      status: {
        state: 'failed',
        timestamp: recordedAt,
        message: providerMessage(randomUUID(), {
          type: CITY_STATUS_DATA_TYPE,
          version: '0.1',
          state: 'failed',
          reason: 'deadline-expired',
          acceptance: record.acceptance,
          completion,
        }),
      },
      metadata: { 'org.nandacity': metadata },
    };
    const next = { ...record, task: failed };
    await this.store.save(next);
    return next;
  }

  private async failWithoutCompletion(record: StoredTaskRecord, reason: string): Promise<StoredTaskRecord> {
    const failedAt = this.options.now();
    const metadata = { ...asCityMetadata(record.task), failureReason: reason };
    const failed: A2ATask = {
      ...record.task,
      status: {
        state: 'failed',
        timestamp: failedAt,
        message: providerMessage(randomUUID(), {
          type: CITY_STATUS_DATA_TYPE,
          version: '0.1',
          state: 'failed',
          reason,
          acceptance: record.acceptance,
        }),
      },
      metadata: { 'org.nandacity': metadata },
    };
    const next = { ...record, task: failed };
    await this.store.save(next);
    return next;
  }
}

function jsonResponse(response: ServerResponse, body: JsonRpcResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_HTTP_BODY_BYTES) throw rpcFault(-32600, 'Invalid Request', 'request-too-large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw rpcFault(-32700, 'Parse error', 'invalid-json'); }
}

function requestId(value: unknown): JsonRpcId {
  if (!value || typeof value !== 'object' || !('id' in value)) return null;
  const id = (value as { id: unknown }).id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)) || id === null ? id : null;
}

async function handleRpc(runtime: CityA2ARuntime, value: unknown): Promise<JsonRpcResponse> {
  const id = requestId(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw rpcFault(-32600, 'Invalid Request', 'invalid-json-rpc-request');
  }
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== '2.0' || !('id' in request) || request.id === null ||
      !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isInteger(request.id))) ||
      typeof request.method !== 'string') {
    throw rpcFault(-32600, 'Invalid Request', 'invalid-json-rpc-request');
  }
  if (request.method === 'message/send') {
    const result = await runtime.send(request.params);
    return { jsonrpc: '2.0', id, result };
  }
  if (request.method === 'tasks/get') {
    let params: ReturnType<typeof taskQueryParamsSchema.parse>;
    try { params = taskQueryParamsSchema.parse(request.params); }
    catch { throw rpcFault(-32602, 'Invalid method parameters', 'invalid-task-query'); }
    const result = await runtime.getTask(params.id, params.historyLength);
    return { jsonrpc: '2.0', id, result };
  }
  throw rpcFault(-32601, 'Method not found', 'unsupported-a2a-method');
}

export async function startLoopbackA2AService(options: LoopbackServiceOptions): Promise<LoopbackA2AService> {
  const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1 ||
      executionTimeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error(`executionTimeoutMs must be an integer from 1 to ${MAX_EXECUTION_TIMEOUT_MS}`);
  }
  const store = await CityTaskStore.open(options.storeDirectory);
  const runtime = new CityA2ARuntime(store, { ...options, executionTimeoutMs });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/') {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      response.statusCode = 415;
      response.end();
      return;
    }
    let id: JsonRpcId = null;
    try {
      const body = await readBody(request);
      id = requestId(body);
      jsonResponse(response, await handleRpc(runtime, body));
    } catch (error) {
      const fault = error instanceof RpcFault ? error.rpc : { code: -32603, message: 'Internal server error' };
      jsonResponse(response, { jsonrpc: '2.0', id, error: fault });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback A2A server did not publish a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await runtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
