import { digestBytes } from '../identity/profile.js';
import { originEnvelopeSchema, originStatementSchema, type OriginEnvelope, type OriginStatement } from './schema.js';

export type OriginStatementBytes<T extends OriginStatement = OriginStatement> = {
  value: T; bytes: Uint8Array; /** Inner exact payload digest, never the document digest. */ digest: `0x${string}`;
};
export type OriginDocument<T extends OriginStatement = OriginStatement> = {
  envelope: OriginEnvelope; statement: OriginStatementBytes<T>; bytes: Uint8Array;
  /** Digest of full exact signed-envelope document bytes. */ documentDigest: `0x${string}`;
};
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function assertUnicode(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('origin JSON exceeds maximum depth');
  if (typeof value === 'string' && !value.isWellFormed()) throw new Error('malformed Unicode');
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new Error('malformed Unicode key');
      assertUnicode(entry, depth + 1);
    }
  }
}
function parseExact(bytes: Uint8Array, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maximum) throw new Error('origin bytes exceed size limit');
  const text = decoder.decode(bytes);
  const raw: unknown = JSON.parse(text);
  if (text !== JSON.stringify(raw)) throw new Error('origin bytes must be exact compact JSON without duplicate keys');
  assertUnicode(raw);
  return raw;
}
export function decodeOriginStatement(bytes: Uint8Array): OriginStatementBytes {
  const value = originStatementSchema.parse(parseExact(bytes, 24 * 1024));
  const limit = value.kind === 'archive-snapshot' ? 24 * 1024 : value.kind === 'request' ? 16 * 1024 : 4 * 1024;
  if (bytes.length > limit) throw new Error('origin payload exceeds kind size limit');
  return { value, bytes: new Uint8Array(bytes), digest: digestBytes(bytes) };
}
export function encodeOriginStatement<T extends OriginStatement>(value: T): OriginStatementBytes<T> {
  assertUnicode(value);
  originStatementSchema.parse(value);
  return decodeOriginStatement(new TextEncoder().encode(JSON.stringify(value))) as OriginStatementBytes<T>;
}
export function decodeOriginEnvelope(value: unknown): { envelope: OriginEnvelope; statement: OriginStatementBytes } {
  const envelope = originEnvelopeSchema.parse(value);
  const encoded = envelope.payloadBase64;
  if (encoded.length > 32768 || encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('noncanonical or oversized base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('noncanonical base64');
  return { envelope, statement: decodeOriginStatement(bytes) };
}
export function decodeOriginDocument(bytes: Uint8Array): OriginDocument {
  const decoded = decodeOriginEnvelope(parseExact(bytes, 32768));
  const kind = decoded.statement.value.kind;
  const limit = kind === 'archive-snapshot' || kind === 'request' ? 32768 : 6144;
  if (bytes.length > limit) throw new Error('origin document exceeds kind size limit');
  return { ...decoded, bytes: new Uint8Array(bytes), documentDigest: digestBytes(bytes) };
}
export function encodeOriginDocument(envelope: OriginEnvelope): OriginDocument {
  assertUnicode(envelope);
  decodeOriginEnvelope(envelope);
  return decodeOriginDocument(new TextEncoder().encode(JSON.stringify(envelope)));
}
