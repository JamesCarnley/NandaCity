import type { PrivateKeyAccount } from 'viem/accounts';
import type { VerifiedProfile } from '../identity/verify.js';
import { decodeEnvelope, signProviderStatement } from '../interaction/signatures.js';
import { isUtcSecond, type CityAcceptance, type CityCompletion, type CityRequest, type SignedEnvelope } from '../interaction/schema.js';
import { verifyInteraction, type ContinuityFinding } from '../interaction/verify.js';
import { decodeOriginDocument, decodeOriginEnvelope, type OriginDocument } from '../origin/bytes.js';
import { originEnvelopeSchema, type OriginEnvelope, type OriginProfile, type OriginRequest } from '../origin/schema.js';
import { signOriginStatement, verifyOriginSignature } from '../origin/signatures.js';
import type { OriginProfileObservation } from '../origin/profile.js';
import type { EveningPlanInput } from './input.js';
import { licensedTaskRecordSchema, storedTaskRecordSchema, type StoredTaskRecord, type TaskRecordParser } from './wire.js';

export type RuntimeRequest = { kind: 'request'; interactionId: string; createdAt: string; deadline: string; input: EveningPlanInput;
  caller: { method: string; address: string; chainId?: number } };
export type RuntimeAuthority<Profile> = {
  observedAt: string; currentProfile: Profile | null; requestUsable: boolean; allUsable: boolean;
  terminalEligible: boolean; runtimeSigner: 'authorized' | 'unauthorized' | 'not-evaluated'; failureReason: string;
};
/** Distinguishes an unavailable observer from invalid already-observed evidence. */
export class AuthorityObservationError extends Error {}
export type RuntimeStrategy<Request extends RuntimeRequest, Envelope, Profile> = {
  decodeRequest: (value: unknown) => { request: Request; envelope: Envelope; digest: `0x${string}` };
  decodeAcceptance: (value: Envelope) => { acceptedAt: string; deadline: string; digest: `0x${string}` };
  interactionKey: (request: Request) => string;
  parseRecord: TaskRecordParser<Envelope>;
  evaluate: (request: Envelope, acceptance: Envelope | undefined, signer: PrivateKeyAccount) => Promise<RuntimeAuthority<Profile>>;
  signAcceptance: (value: CityAcceptance, request: Request, signer: PrivateKeyAccount, profile: Profile) => Promise<Envelope>;
  signCompletion: (value: CityCompletion, request: Request, signer: PrivateKeyAccount, profile: Profile) => Promise<Envelope>;
};
export type AuthorityObservation = {
  basisProfile: VerifiedProfile | null; currentProfile: VerifiedProfile | null;
  continuity: ContinuityFinding; observedAt: string;
};
function ethereumFailure(observation: AuthorityObservation, finding: Awaited<ReturnType<typeof verifyInteraction>>): string {
  if (finding.request.cryptography !== 'valid' || finding.request.signerBinding !== 'matched') return 'request-signature-invalid';
  if (finding.request.profileBasis === 'mismatched') return 'profile-basis-mismatch';
  if (finding.request.deadline === 'expired') return 'deadline-expired';
  if (observation.continuity === 'changed' || finding.request.currentAuthority === 'unauthorized') return 'authority-changed';
  if (observation.continuity === 'unknown' || finding.request.profileBasis === 'unavailable' ||
      finding.request.currentAuthority === 'unavailable') return 'authority-unavailable';
  return 'request-evidence-invalid';
}
function ethereumTerminalEligible(finding: Awaited<ReturnType<typeof verifyInteraction>>): boolean {
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
export function createEthereumRuntimeStrategy(observeAuthority: (request: CityRequest) => Promise<AuthorityObservation>):
RuntimeStrategy<CityRequest, SignedEnvelope, VerifiedProfile> {
  return {
    decodeRequest(value) {
      const decoded = decodeEnvelope(value);
      if (decoded.statement.value.kind !== 'request') throw new Error('expected Ethereum request');
      return { request: decoded.statement.value, envelope: decoded.envelope, digest: decoded.statement.digest };
    },
    decodeAcceptance(value) {
      const decoded = decodeEnvelope(value);
      if (decoded.statement.value.kind !== 'acceptance') throw new Error('expected Ethereum acceptance');
      return { ...decoded.statement.value, digest: decoded.statement.digest };
    },
    interactionKey(request) {
      const agent = request.service.agent;
      return [request.service.method, agent.chainId, agent.registry.toLowerCase(), agent.agentId,
        request.caller.method, request.caller.chainId, request.caller.address.toLowerCase(), request.interactionId].join(':');
    },
    parseRecord: parseEthereumTaskRecord,
    async evaluate(request, acceptance, signer) {
      const decoded = decodeEnvelope(request).statement.value;
      if (decoded.kind !== 'request') throw new Error('expected request');
      let observation: AuthorityObservation;
      try { observation = await observeAuthority(decoded); }
      catch { throw new AuthorityObservationError('authority observation unavailable'); }
      // The original Ethereum terminal path rejects invalid clocks before evidence
      // verification; its initial path lets the verifier reject them as internal errors.
      if (acceptance && !isUtcSecond(observation.observedAt)) {
        return { observedAt: observation.observedAt, currentProfile: null, requestUsable: false,
          allUsable: false, terminalEligible: false, runtimeSigner: 'not-evaluated', failureReason: 'authority-observation-invalid' };
      }
      const finding = await verifyInteraction({ request, ...(acceptance ? { acceptance } : {}),
        basisProfile: observation.basisProfile, currentProfile: observation.currentProfile,
        continuity: observation.continuity, observedAt: observation.observedAt });
      return { observedAt: observation.observedAt, currentProfile: observation.currentProfile,
        requestUsable: finding.request.usableAtObservation, allUsable: finding.allPresentedEvidenceUsableAtObservation,
        terminalEligible: ethereumTerminalEligible(finding), failureReason: ethereumFailure(observation, finding),
        runtimeSigner: finding.request.currentAuthority !== 'authorized' || !observation.currentProfile ? 'not-evaluated' :
          signer.address.toLowerCase() === observation.currentProfile.registration['x-nandacity'].receiptSigner.toLowerCase()
            ? 'authorized' : 'unauthorized' };
    },
    signAcceptance: (value, _request, signer, profile) => signProviderStatement(value, signer, profile),
    signCompletion: (value, _request, signer, profile) => signProviderStatement(value, signer, profile),
  };
}

function originInteractionKey(request: OriginRequest): string {
  return `city-origin@0.1:${JSON.stringify([request.service.identityUrl, request.caller.address, request.interactionId])}`;
}
const originRecordSchema = storedTaskRecordSchema.extend({ requestEnvelope: originEnvelopeSchema, acceptance: originEnvelopeSchema });
const licensedOriginRecordSchema = licensedTaskRecordSchema.extend({ requestEnvelope: originEnvelopeSchema, acceptance: originEnvelopeSchema });
function isLicensedRecord(value: unknown): boolean { return !!value && typeof value === 'object' && 'version' in value && value.version === '0.2'; }

/** Structural linkage only; signature/authority verification remains the selected strategy's job. */
function checkLicensedSlots<Envelope>(record: StoredTaskRecord<Envelope>, interactionId: string,
  check: (value: unknown, kind: 'request' | 'acceptance' | 'completion') => { time: string; outcome?: string }): void {
  const task = record.task;
  const city = task.metadata!['org.nandacity'] as Record<string, unknown>;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (city.interactionId !== interactionId || !same(city.acceptance, record.acceptance)) throw new Error('licensed metadata linkage mismatch');
  const accepted = check(city.acceptance, 'acceptance');
  const history = task.history![0]!;
  if (history.role !== 'user' || history.parts[0]!.data.type !== 'org.nandacity.city-request' ||
      !same(history.parts[0]!.data.envelope, record.requestEnvelope)) throw new Error('licensed request history mismatch');
  check(history.parts[0]!.data.envelope, 'request');
  if (task.status.state === 'completed') {
    const completed = check(city.completion, 'completion');
    const data = task.artifacts?.[0]?.parts[0]?.data;
    if (completed.outcome !== 'completed' || completed.time !== task.status.timestamp || city.failureReason !== undefined ||
        task.status.message || !data || data.type !== 'org.nandacity.city-result' || !same(data.completion, city.completion)) {
      throw new Error('licensed completed task mismatch');
    }
    check(data.completion, 'completion');
  } else {
    const message = task.status.message;
    const data = message?.parts[0]?.data;
    if (task.artifacts || message?.role !== 'agent' || !data || data.type !== 'org.nandacity.city-status' ||
        !same(data.acceptance, record.acceptance)) throw new Error('licensed status mismatch');
    check(data.acceptance, 'acceptance');
    if (task.status.state === 'submitted') {
      if (data.state !== 'accepted' || task.status.timestamp !== accepted.time || city.completion !== undefined ||
          data.completion !== undefined || city.failureReason !== undefined || data.reason !== undefined) throw new Error('licensed submitted task mismatch');
    } else {
      if (data.state !== 'failed' || !city.failureReason || city.failureReason !== data.reason ||
          !same(data.completion, city.completion)) throw new Error('licensed failed task mismatch');
      if (city.completion !== undefined) {
        const completed = check(city.completion, 'completion');
        if (!['failed', 'expired'].includes(completed.outcome ?? '') || completed.time !== task.status.timestamp) throw new Error('licensed failure completion mismatch');
        check(data.completion, 'completion');
      }
    }
  }
}

export const parseEthereumTaskRecord: TaskRecordParser<SignedEnvelope> = (value) => {
  if (!isLicensedRecord(value)) return storedTaskRecordSchema.parse(value);
  const record = licensedTaskRecordSchema.parse(value);
  const request = decodeEnvelope(record.requestEnvelope).statement;
  const acceptance = decodeEnvelope(record.acceptance).statement;
  if (request.value.kind !== 'request' || acceptance.value.kind !== 'acceptance') throw new Error('licensed Ethereum statement kind mismatch');
  const agent = request.value.service.agent;
  const expectedKey = [request.value.service.method, agent.chainId, agent.registry.toLowerCase(), agent.agentId,
    request.value.caller.method, request.value.caller.chainId, request.value.caller.address.toLowerCase(), request.value.interactionId].join(':');
  if (record.interactionKey !== expectedKey || record.requestDigest !== request.digest ||
      acceptance.value.requestDigest !== request.digest || acceptance.value.deadline !== request.value.deadline ||
      Date.parse(acceptance.value.acceptedAt) < Date.parse(request.value.createdAt)) throw new Error('licensed Ethereum linkage mismatch');
  checkLicensedSlots(record, request.value.interactionId, (nested, kind) => {
    const decoded = decodeEnvelope(nested).statement;
    const statement = decoded.value;
    if (statement.kind !== kind ||
        (kind === 'request' && decoded.digest !== request.digest) ||
        (kind === 'acceptance' && decoded.digest !== acceptance.digest) ||
        (statement.kind === 'completion' && (statement.acceptanceDigest !== acceptance.digest ||
          Date.parse(statement.recordedAt) < Date.parse(acceptance.value.kind === 'acceptance' ? acceptance.value.acceptedAt : '')))) {
      throw new Error('licensed Ethereum nested evidence mismatch');
    }
    return { time: statement.kind === 'request' ? statement.createdAt : statement.kind === 'acceptance' ? statement.acceptedAt : statement.recordedAt,
      ...(statement.kind === 'completion' ? { outcome: statement.outcome } : {}) };
  });
  return record;
};
export const parseOriginTaskRecord: TaskRecordParser<OriginEnvelope> = (value) => {
  const record = isLicensedRecord(value) ? licensedOriginRecordSchema.parse(value) : originRecordSchema.parse(value);
  const request = decodeOriginEnvelope(record.requestEnvelope).statement;
  const acceptance = decodeOriginEnvelope(record.acceptance).statement;
  if (request.value.kind !== 'request' || acceptance.value.kind !== 'acceptance' ||
    record.interactionKey !== originInteractionKey(request.value) || record.requestDigest !== request.digest ||
    acceptance.value.requestDigest !== request.digest || acceptance.value.service.identityUrl !== request.value.service.identityUrl) {
    throw new Error('persisted origin task linkage mismatch');
  }
  // Check only the defined City evidence slots. Other A2A metadata stays opaque.
  function checkEnvelope(value: unknown, kind: 'request' | 'acceptance' | 'completion'): void {
    const nested = decodeOriginEnvelope(value).statement;
    if (nested.value.kind !== kind || nested.value.service.identityUrl !== request.value.service.identityUrl ||
      (kind === 'request' && nested.digest !== request.digest) ||
      (kind === 'acceptance' && nested.digest !== acceptance.digest) ||
      (nested.value.kind === 'completion' && nested.value.acceptanceDigest !== acceptance.digest)) {
      throw new Error('persisted origin nested evidence mismatch');
    }
  }
  const metadata = record.task.metadata?.['org.nandacity'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('missing origin task metadata');
  checkEnvelope((metadata as Record<string, unknown>).acceptance, 'acceptance');
  if ('completion' in metadata) checkEnvelope(metadata.completion, 'completion');
  const parts = [
    ...(record.task.history ?? []).flatMap((message) => message.parts),
    ...(record.task.status.message?.parts ?? []),
    ...(record.task.artifacts ?? []).flatMap((artifact) => artifact.parts),
  ];
  for (const { data } of parts) {
    if (data.type === 'org.nandacity.city-request') checkEnvelope(data.envelope, 'request');
    if (data.type === 'org.nandacity.city-status' || data.type === 'org.nandacity.city-result') {
      if ('acceptance' in data) checkEnvelope(data.acceptance, 'acceptance');
      if ('completion' in data) checkEnvelope(data.completion, 'completion');
    }
  }
  if (record.version === '0.2') {
    if (acceptance.value.deadline !== request.value.deadline || Date.parse(acceptance.value.acceptedAt) < Date.parse(request.value.createdAt)) throw new Error('licensed origin acceptance time mismatch');
    checkLicensedSlots(record, request.value.interactionId, (nested, kind) => {
      checkEnvelope(nested, kind);
      const statement = decodeOriginEnvelope(nested).statement.value;
      if (statement.kind !== 'request' && statement.kind !== 'acceptance' && statement.kind !== 'completion') throw new Error('licensed origin statement kind mismatch');
      if (statement.kind === 'completion' && Date.parse(statement.recordedAt) < Date.parse(acceptance.value.kind === 'acceptance' ? acceptance.value.acceptedAt : '')) throw new Error('licensed origin completion time mismatch');
      return { time: statement.kind === 'request' ? statement.createdAt : statement.kind === 'acceptance' ? statement.acceptedAt : statement.recordedAt,
        ...(statement.kind === 'completion' ? { outcome: statement.outcome } : {}) };
    });
  }
  return record;
};
export type OriginRuntimeStrategyOptions = {
  basisProfile: (request: OriginRequest) => OriginDocument<OriginProfile> | null;
  observeAuthority: (request: OriginRequest) => Promise<OriginProfileObservation>;
};
export function createOriginRuntimeStrategy(options: OriginRuntimeStrategyOptions): RuntimeStrategy<OriginRequest, OriginEnvelope, OriginProfile> {
  return {
    decodeRequest(value) {
      const decoded = decodeOriginEnvelope(value);
      if (decoded.statement.value.kind !== 'request') throw new Error('expected origin request');
      return { request: decoded.statement.value, envelope: decoded.envelope, digest: decoded.statement.digest };
    },
    decodeAcceptance(value) {
      const decoded = decodeOriginEnvelope(value);
      if (decoded.statement.value.kind !== 'acceptance') throw new Error('expected origin acceptance');
      return { ...decoded.statement.value, digest: decoded.statement.digest };
    },
    interactionKey: originInteractionKey,
    parseRecord: parseOriginTaskRecord,
    async evaluate(envelope, acceptance, signer) {
      const decoded = decodeOriginEnvelope(envelope).statement;
      if (decoded.value.kind !== 'request') throw new Error('expected origin request');
      const request = decoded.value;
      let observation: OriginProfileObservation;
      try { observation = await options.observeAuthority(request); }
      catch { throw new AuthorityObservationError('authority observation unavailable'); }
      const result: RuntimeAuthority<OriginProfile> = { observedAt: observation.observedAt, currentProfile: null,
        requestUsable: false, allUsable: false, terminalEligible: false, runtimeSigner: 'not-evaluated', failureReason: 'authority-unavailable' };
      if ((await verifyOriginSignature(envelope, request.service.identityUrl, 'request')).status !== 'valid') {
        return { ...result, failureReason: 'request-signature-invalid' };
      }
      const suppliedBasis = options.basisProfile(request);
      if (!suppliedBasis) return result;
      // Re-decode the retained exact document. Never trust precomputed digest/value fields from a caller.
      const basis = decodeOriginDocument(suppliedBasis.bytes);
      if (basis.statement.value.kind !== 'profile' || basis.documentDigest !== request.profileBasis.profileDigest ||
        basis.statement.value.cardDigest !== request.profileBasis.cardDigest ||
        basis.statement.value.city !== request.input.city || basis.statement.value.capability !== request.input.capability ||
        (await verifyOriginSignature(basis.envelope, request.service.identityUrl, 'profile')).status !== 'valid') {
        return { ...result, failureReason: 'profile-basis-mismatch' };
      }
      if (observation.current !== 'observed') return result;
      const current = decodeOriginDocument(observation.profile.bytes);
      if (current.statement.value.kind !== 'profile' ||
        (await verifyOriginSignature(current.envelope, request.service.identityUrl, 'profile')).status !== 'valid') return result;
      const profile = current.statement.value;
      if (!profile.active || !basis.statement.value.active || current.documentDigest !== basis.documentDigest) {
        return { ...result, failureReason: 'authority-changed' };
      }
      result.currentProfile = profile;
      result.runtimeSigner = signer.address.toLowerCase() === profile.runtimeKey.address ? 'authorized' : 'unauthorized';
      const timeValid = isUtcSecond(observation.observedAt) && Date.parse(request.createdAt) <= Date.parse(observation.observedAt);
      const beforeDeadline = Date.parse(observation.observedAt) <= Date.parse(request.deadline);
      result.requestUsable = timeValid && beforeDeadline;
      result.failureReason = !timeValid ? 'request-evidence-invalid' : !beforeDeadline ? 'deadline-expired' : 'request-evidence-invalid';
      if (!acceptance) { result.allUsable = result.requestUsable; return result; }
      const accepted = decodeOriginEnvelope(acceptance).statement;
      const validAcceptance = accepted.value.kind === 'acceptance' &&
        accepted.value.requestDigest === decoded.digest && accepted.value.deadline === request.deadline &&
        accepted.value.service.identityUrl === request.service.identityUrl && acceptance.signer.address === profile.runtimeKey.address &&
        Date.parse(accepted.value.acceptedAt) >= Date.parse(request.createdAt) &&
        Date.parse(accepted.value.acceptedAt) <= Date.parse(observation.observedAt) &&
        (await verifyOriginSignature(acceptance, request.service.identityUrl, 'acceptance')).status === 'valid';
      result.terminalEligible = timeValid && validAcceptance;
      result.allUsable = result.requestUsable && validAcceptance;
      return result;
    },
    signAcceptance(value, request, signer, profile) {
      const { version: _version, ...statement } = value;
      return signOriginStatement({ ...statement, profile: 'city-origin@0.1', service: request.service }, signer, profile);
    },
    signCompletion(value, request, signer, profile) {
      const { version: _version, ...statement } = value;
      return signOriginStatement({ ...statement, profile: 'city-origin@0.1', service: request.service }, signer, profile);
    },
  };
}
