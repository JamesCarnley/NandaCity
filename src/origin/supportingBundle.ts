import { z } from 'zod';
import { decodeOriginDocument } from './bytes.js';
import { decodeCard } from '../identity/profile.js';

export type OriginSupportingBundle = { profile: Uint8Array; request: Uint8Array; acceptance: Uint8Array;
  completion?: Uint8Array; card: Uint8Array };
const base64 = z.string().min(4).max(90000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const schema = z.strictObject({ profile: z.literal('city-origin-private@0.1'), profileDocument: base64,
  request: base64, acceptance: base64, completion: base64.optional(), card: base64 });
/** Caller-private bytes only: never publish this bundle to an Index or log it. */
export function decodeOriginSupportingBundle(bytes: Uint8Array): OriginSupportingBundle {
  if (!(bytes instanceof Uint8Array) || bytes.length > 256 * 1024) throw new Error('private origin bundle too large');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const raw: unknown = JSON.parse(text);
  if (JSON.stringify(raw) !== text) throw new Error('private bundle requires exact compact JSON');
  const parsed = schema.parse(raw);
  const unpack = (value: string): Uint8Array => {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) throw new Error('private bundle base64 invalid');
    return new Uint8Array(decoded);
  };
  const output: OriginSupportingBundle = { profile: unpack(parsed.profileDocument), request: unpack(parsed.request),
    acceptance: unpack(parsed.acceptance), card: unpack(parsed.card),
    ...(parsed.completion ? { completion: unpack(parsed.completion) } : {}) };
  for (const kind of ['profile', 'request', 'acceptance', 'completion'] as const) {
    if (output[kind] && decodeOriginDocument(output[kind]).statement.value.kind !== kind) throw new Error('private bundle purpose mismatch');
  }
  if (output.card.length > 65536) throw new Error('private card too large');
  decodeCard(output.card);
  return output;
}
export function encodeOriginSupportingBundle(bundle: OriginSupportingBundle): Uint8Array {
  const encode = (value: Uint8Array) => Buffer.from(value).toString('base64');
  const bytes = new TextEncoder().encode(JSON.stringify({ profile: 'city-origin-private@0.1',
    profileDocument: encode(bundle.profile), request: encode(bundle.request), acceptance: encode(bundle.acceptance),
    ...(bundle.completion ? { completion: encode(bundle.completion) } : {}), card: encode(bundle.card) }));
  decodeOriginSupportingBundle(bytes); return bytes;
}
