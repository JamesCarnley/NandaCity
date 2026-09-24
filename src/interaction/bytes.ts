import { digestBytes } from '../identity/profile.js';
import { statementSchema, type CityRequest, type CityStatement } from './schema.js';

export type DecodedStatement<T extends CityStatement = CityStatement> = {
  value: T;
  bytes: Uint8Array;
  digest: `0x${string}`;
};

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export class UnsupportedInteractionMethodError extends Error {}

function assertWellFormedAndBounded(value: unknown, depth: number): void {
  if (depth > 8) throw new Error('statement exceeds maximum JSON depth of 8');
  if (typeof value === 'string' && !value.isWellFormed()) {
    throw new Error('statement contains malformed Unicode surrogate');
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertWellFormedAndBounded(entry, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new Error('statement contains malformed Unicode surrogate in key');
      assertWellFormedAndBounded(entry, depth + 1);
    }
  }
}

export function decodeStatement(bytes: Uint8Array): DecodedStatement {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('statement bytes must be Uint8Array');
  if (bytes.byteLength > 16 * 1024) throw new Error('request exceeds the 16 KiB size limit');
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { throw new Error('statement is not valid UTF-8'); }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new Error('statement is not valid JSON'); }
  if (text !== JSON.stringify(raw)) throw new Error('statement must use compact canonical JSON without duplicate keys');
  assertWellFormedAndBounded(raw, 0);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'kind' in raw && raw.kind === 'request') {
    if ('service' in raw && raw.service && typeof raw.service === 'object' &&
        'method' in raw.service && raw.service.method !== 'erc8004') {
      throw new UnsupportedInteractionMethodError('unsupported service identity method');
    }
    if ('caller' in raw && raw.caller && typeof raw.caller === 'object' &&
        'method' in raw.caller && raw.caller.method !== 'eip155-eoa') {
      throw new UnsupportedInteractionMethodError('unsupported caller identity method');
    }
  }
  const value = statementSchema.parse(raw);
  if (value.kind !== 'request' && bytes.byteLength > 4 * 1024) {
    throw new Error('acceptance/completion exceeds the 4 KiB size limit');
  }
  return { value, bytes: new Uint8Array(bytes), digest: digestBytes(bytes) };
}

export function encodeStatement<T extends CityStatement>(value: T): DecodedStatement<T> {
  return decodeStatement(encoder.encode(JSON.stringify(value))) as DecodedStatement<T>;
}

export function idempotencyKey(value: CityRequest): string {
  return `erc8004:${value.service.agent.chainId}:${value.service.agent.registry.toLowerCase()}:${value.service.agent.agentId}:eip155-eoa:${value.caller.chainId}:${value.caller.address.toLowerCase()}:${value.interactionId.toLowerCase()}`;
}

export function requestsMatchForRetry(left: DecodedStatement<CityRequest>, right: DecodedStatement<CityRequest>): boolean {
  if (idempotencyKey(left.value) !== idempotencyKey(right.value)) return false;
  if (!Buffer.from(left.bytes).equals(right.bytes)) {
    throw new Error('idempotency conflict: same service, caller and interaction ID with changed request bytes');
  }
  return true;
}
