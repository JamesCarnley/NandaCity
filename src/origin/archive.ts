import { z } from 'zod';
import { digestBytes } from '../identity/profile.js';
import { ownedFetch } from '../demo/ownedLifecycle.js';
import { decodeOriginDocument } from './bytes.js';
import { originDigestSchema } from './schema.js';

export type ArchiveBlob = { digest: string; bytes: Uint8Array | null };
export type OriginArchive = {
  snapshotDigest: string; snapshot: Uint8Array | null; documents: ArchiveBlob[];
  variants: ArchiveBlob[]; variantsTruncated: boolean; historyAvailable: boolean;
};
export function ownedIndexOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== raw ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Index requires exact owned loopback origin');
  return raw;
}
/** Bounded transport only. Neither a response nor a content digest establishes authority. */
export async function readIndexBytes(url: string, maximum: number, init: RequestInit = {}): Promise<Uint8Array> {
  ownedIndexOrigin(new URL(url).origin);
  const perRead = AbortSignal.timeout(5000);
  const response = await ownedFetch(url, { ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, perRead]) : perRead,
    headers: { 'accept-encoding': 'identity', ...init.headers } });
  if (response.status !== 200 || !response.body ||
    (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) throw new Error('Index read unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new Error('Index response exceeds bound'); }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
const statusSchema = z.object({ digest: originDigestSchema,
  retainedVariants: z.array(z.object({ digest: originDigestSchema })).max(32), variantsTruncated: z.boolean() });
export async function readOriginArchive(options: { indexOrigin: string; snapshotDigest: string; signal?: AbortSignal }): Promise<OriginArchive> {
  const origin = ownedIndexOrigin(options.indexOrigin); const digest = originDigestSchema.parse(options.snapshotDigest);
  const base = `${origin}/api/ard/origin-archive/`;
  const result: OriginArchive = { snapshotDigest: digest, snapshot: null, documents: [], variants: [],
    variantsTruncated: false, historyAvailable: false };
  const deadline = AbortSignal.timeout(30000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const read = async (kind: 'snapshots' | 'documents', expected: string): Promise<Uint8Array | null> => {
    try {
      const bytes = await readIndexBytes(`${base}${kind}/${expected}`, kind === 'snapshots' ? 32768 : 6144, { signal });
      return digestBytes(bytes) === expected ? bytes : null;
    } catch { return null; }
  };
  result.snapshot = await read('snapshots', digest);
  try {
    const status = statusSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readIndexBytes(`${base}snapshots/${digest}/status`, 2 * 1024 * 1024, { signal }))));
    if (status.digest !== digest || new Set(status.retainedVariants.map((v) => v.digest)).size !== status.retainedVariants.length) throw new Error('status mismatch');
    result.historyAvailable = true; result.variantsTruncated = status.variantsTruncated;
    // Fetch every claimed variant before interpreting it; unsigned claims are not conflicts.
    for (const variant of status.retainedVariants) result.variants.push({ digest: variant.digest,
      bytes: variant.digest === digest ? result.snapshot : await read('snapshots', variant.digest) });
  } catch { /* unknown retained history, not absence */ }
  try {
    const selected = decodeOriginDocument(result.snapshot!);
    if (selected.statement.value.kind !== 'archive-snapshot') throw new Error('not snapshot');
    for (const entry of selected.statement.value.entries) result.documents.push({ digest: entry, bytes: await read('documents', entry) });
  } catch { /* exact bytes remain inspectable even when not a valid City snapshot */ }
  return result;
}
