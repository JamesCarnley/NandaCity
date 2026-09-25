import { digestBytes } from '../identity/profile.js';
import { feedbackSchema, type CityFeedback } from './schema.js';

export type DecodedFeedback = { value: CityFeedback; bytes: Uint8Array; digest: `0x${string}` };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const MAX_FEEDBACK_BYTES = 4 * 1024;

function assertWellFormed(value: unknown): void {
  if (typeof value === 'string' && !value.isWellFormed()) throw new Error('feedback contains malformed Unicode surrogate');
  if (Array.isArray(value)) {
    for (const entry of value) assertWellFormed(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new Error('feedback contains malformed Unicode surrogate in key');
      assertWellFormed(entry);
    }
  }
}

/** Decode only exact compact JSON bytes. Re-serialization never substitutes for the original bytes. */
export function decodeFeedback(bytes: Uint8Array): DecodedFeedback {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('feedback bytes must be Uint8Array');
  if (bytes.byteLength > MAX_FEEDBACK_BYTES) throw new Error('feedback exceeds the 4 KiB size limit');
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { throw new Error('feedback is not valid UTF-8'); }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new Error('feedback is not valid JSON'); }
  if (text !== JSON.stringify(raw)) throw new Error('feedback must use compact canonical JSON without duplicate keys');
  assertWellFormed(raw);
  return { value: feedbackSchema.parse(raw), bytes: new Uint8Array(bytes), digest: digestBytes(bytes) };
}

export function encodeFeedback(value: CityFeedback): DecodedFeedback {
  return decodeFeedback(encoder.encode(JSON.stringify(value)));
}
