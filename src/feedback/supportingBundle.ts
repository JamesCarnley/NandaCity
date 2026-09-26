import { MAX_CARD_BYTES } from '../identity/profile.js';
import type { DecodedStatement } from '../interaction/bytes.js';
import type { CityAcceptance, CityCompletion, CityRequest, CityStatement, SignedEnvelope } from '../interaction/schema.js';
import { decodeEnvelope } from '../interaction/signatures.js';

const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_DEPTH = 8;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export type SupportingBundleDiagnostic = 'bundle-incomplete' | 'bundle-shape-invalid' |
  'bundle-size-exceeded' | 'bundle-depth-exceeded' | 'bundle-unicode-invalid' |
  'bundle-json-invalid' | 'bundle-json-not-exact' | 'bundle-card-invalid' | 'bundle-envelope-invalid';

/** Controlled codes only: errors never quote a private payload. */
export class SupportingBundleError extends Error {
  readonly code: 'bundle-incomplete' | 'bundle-malformed';
  constructor(readonly diagnostic: SupportingBundleDiagnostic) {
    super(diagnostic);
    this.code = diagnostic === 'bundle-incomplete' ? 'bundle-incomplete' : 'bundle-malformed';
  }
}

type DecodedEnvelope<T extends CityStatement> = { envelope: SignedEnvelope; statement: DecodedStatement<T> };
export type SupportingBundle = {
  bytes: Uint8Array;
  request: DecodedEnvelope<CityRequest>;
  acceptance: DecodedEnvelope<CityAcceptance>;
  completion?: DecodedEnvelope<CityCompletion>;
  /** Exact opaque bytes: no card parsing, fetch or profile authority in this codec. */
  cardBytes: Uint8Array;
};

function fail(code: SupportingBundleDiagnostic): never { throw new SupportingBundleError(code); }

// Check lexical depth before JSON.parse/stringify or any recursive downstream codec.
function checkTextDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > MAX_DEPTH) fail('bundle-depth-exceeded');
    } else if (char === '}' || char === ']') depth--;
  }
}

// Iterative and bounded even for cyclic/non-JSON encoder inputs. Reject hooks that
// could change values between validation and serialization.
function checkValue(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let size = 0;
  while (pending.length) {
    const { value: entry, depth } = pending.pop()!;
    if (depth > MAX_DEPTH) fail('bundle-depth-exceeded');
    if (typeof entry === 'string') {
      if (!entry.isWellFormed()) fail('bundle-unicode-invalid');
      size += Buffer.byteLength(entry, 'utf8');
    } else if (entry !== null && typeof entry === 'object') {
      if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
        fail('bundle-shape-invalid');
      }
      for (const key of Reflect.ownKeys(entry)) {
        if (Array.isArray(entry) && key === 'length') continue;
        if (typeof key !== 'string') fail('bundle-shape-invalid');
        if (!key.isWellFormed()) fail('bundle-unicode-invalid');
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) fail('bundle-shape-invalid');
        size += Buffer.byteLength(key, 'utf8');
        pending.push({ value: descriptor.value as unknown, depth: depth + 1 });
      }
    } else if (entry !== null && typeof entry !== 'boolean' &&
      (typeof entry !== 'number' || !Number.isFinite(entry))) fail('bundle-shape-invalid');
    if (++size > MAX_BUNDLE_BYTES) fail('bundle-size-exceeded');
  }
}

function base64(value: unknown, limit: number, code: SupportingBundleDiagnostic): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) fail(code);
  return new Uint8Array(bytes);
}

function statement<T extends CityStatement>(value: unknown, kind: T['kind']): DecodedEnvelope<T> {
  if (!value || typeof value !== 'object' || !('payloadBase64' in value)) fail('bundle-envelope-invalid');
  const payload = base64(value.payloadBase64, kind === 'request' ? 16 * 1024 : 4 * 1024, 'bundle-envelope-invalid');
  try { checkTextDepth(decoder.decode(payload)); }
  catch (error) {
    if (error instanceof SupportingBundleError) throw error;
    fail('bundle-envelope-invalid');
  }
  try {
    const decoded = decodeEnvelope(value);
    if (decoded.statement.value.kind !== kind) fail('bundle-envelope-invalid');
    return decoded as DecodedEnvelope<T>;
  } catch { fail('bundle-envelope-invalid'); }
}

function validate(value: unknown): Omit<SupportingBundle, 'bytes'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('bundle-shape-invalid');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['version', 'request', 'acceptance', 'completion', 'cardBase64'].includes(key))) {
    fail('bundle-shape-invalid');
  }
  if (['version', 'request', 'acceptance', 'cardBase64'].some((key) => !Object.hasOwn(raw, key))) fail('bundle-incomplete');
  if (raw.version !== '0.1') fail('bundle-shape-invalid');
  return {
    request: statement<CityRequest>(raw.request, 'request'),
    acceptance: statement<CityAcceptance>(raw.acceptance, 'acceptance'),
    ...(Object.hasOwn(raw, 'completion') ? { completion: statement<CityCompletion>(raw.completion, 'completion') } : {}),
    cardBytes: base64(raw.cardBase64, MAX_CARD_BYTES, 'bundle-card-invalid'),
  };
}

/** Private caller evidence only. Never includes a document, snapshot, answer or Index metadata. */
export function decodeSupportingBundle(bytes: Uint8Array): SupportingBundle {
  if (!(bytes instanceof Uint8Array)) fail('bundle-shape-invalid');
  if (bytes.byteLength > MAX_BUNDLE_BYTES) fail('bundle-size-exceeded');
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { fail('bundle-unicode-invalid'); }
  checkTextDepth(text);
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { fail('bundle-json-invalid'); }
  checkValue(raw);
  if (text !== JSON.stringify(raw)) fail('bundle-json-not-exact');
  return { ...validate(raw), bytes: new Uint8Array(bytes) };
}

export function encodeSupportingBundle(value: unknown): SupportingBundle {
  checkValue(value);
  validate(value); // Unknown undefined fields must not vanish in JSON.stringify.
  return decodeSupportingBundle(encoder.encode(JSON.stringify(value)));
}
