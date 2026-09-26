import { digestBytes } from '../identity/profile.js';
import { decodeFeedbackEnvelope } from './signatures.js';

export type FeedbackDocument = ReturnType<typeof decodeFeedbackEnvelope> & {
  bytes: Uint8Array;
  /** Keccak-256 of the full exact envelope document, not feedback.digest. */
  documentHash: `0x${string}`;
};

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function assertUnicode(value: unknown): void {
  if (typeof value === 'string' && !value.isWellFormed()) throw new Error('document contains malformed Unicode');
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new Error('document contains malformed Unicode key');
      assertUnicode(entry);
    }
  }
}

/** Decode only exact compact JSON. No normalization or signature-authority claim. */
export function decodeFeedbackDocument(bytes: Uint8Array): FeedbackDocument {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('document bytes must be Uint8Array');
  if (bytes.byteLength > 6 * 1024) throw new Error('document exceeds the 6 KiB size limit');
  let text: string;
  try { text = decoder.decode(bytes); }
  catch { throw new Error('document is not valid UTF-8'); }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new Error('document is not valid JSON'); }
  if (text !== JSON.stringify(raw)) throw new Error('document must use exact compact JSON without duplicate fields');
  assertUnicode(raw);
  return { ...decodeFeedbackEnvelope(raw), bytes: new Uint8Array(bytes), documentHash: digestBytes(bytes) };
}

export function encodeFeedbackDocument(envelope: unknown): FeedbackDocument {
  // Validate before stringify, which could otherwise silently remove unknown undefined fields.
  assertUnicode(envelope);
  decodeFeedbackEnvelope(envelope);
  return decodeFeedbackDocument(encoder.encode(JSON.stringify(envelope)));
}
