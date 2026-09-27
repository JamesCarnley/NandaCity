import { request } from 'node:https';
import { decodeCard, digestBytes, type AgentCard } from '../identity/profile.js';
import { isUtcSecond } from '../interaction/schema.js';
import { decodeOriginDocument, type OriginDocument } from './bytes.js';
import { originUrlSchema, type OriginProfile } from './schema.js';
import { verifyOriginSignature } from './signatures.js';
import { z } from 'zod';
import { ownedIndexOrigin, readIndexBytes } from './archive.js';

export type OriginReadOptions = { allowedUrls: readonly string[]; ca: string; timeoutMs?: number; signal?: AbortSignal };
function ownedUrl(url: string, options: OriginReadOptions): URL {
  originUrlSchema.parse(url);
  const parsed = new URL(url);
  if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || !options.allowedUrls.includes(url)) throw new Error('origin URL outside owned allowlist');
  return parsed;
}
/** Only administrator-allowlisted exact literal-loopback HTTPS URLs. No redirect or global trust override. */
export async function readOriginBytes(url: string, options: OriginReadOptions, maxBytes: number): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const parsed = ownedUrl(url, options);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536 || !options.ca) throw new Error('invalid bounded origin read');
  return new Promise((resolve, reject) => {
    const req = request(parsed, { method: 'GET', ca: options.ca, agent: false, rejectUnauthorized: true,
      ...(options.signal ? { signal: options.signal } : {}) }, (res) => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy(); reject(new Error('origin read status or encoding refused')); return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) { res.destroy(new Error('origin response exceeds byte limit')); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
    const timer = setTimeout(() => req.destroy(new Error('origin read timed out')), timeoutMs);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}
export type OriginProfileObservation = {
  current: 'observed'; profile: OriginDocument<OriginProfile>; observedAt: string;
  historicalAuthority: 'not-independently-proven'; card?: AgentCard; cardBytes?: Uint8Array;
} | { current: 'unknown'; observedAt: string; historicalAuthority: 'not-independently-proven'; reason: string };
export type ObserveOriginProfileOptions = OriginReadOptions & { identityUrl: string; now: () => string; includeCard?: boolean };

/** Direct TLS observation binds these exact bytes to this URL now; self-signature alone does not. */
export async function observeOriginProfile(options: ObserveOriginProfileOptions): Promise<OriginProfileObservation> {
  try {
    const document = decodeOriginDocument(await readOriginBytes(options.identityUrl, options, 6144));
    if (document.statement.value.kind !== 'profile' ||
      (await verifyOriginSignature(document.envelope, options.identityUrl, 'profile')).status !== 'valid') throw new Error('origin profile signature invalid');
    const profile = document as OriginDocument<OriginProfile>;
    ownedUrl(profile.statement.value.cardURL, options);
    ownedUrl(profile.statement.value.endpoint, options);
    let card: AgentCard | undefined;
    let cardBytes: Uint8Array | undefined;
    if (options.includeCard !== false) {
      cardBytes = await readOriginBytes(profile.statement.value.cardURL, options, 65536);
      card = decodeCard(cardBytes);
      if (digestBytes(cardBytes) !== profile.statement.value.cardDigest || card.url !== profile.statement.value.endpoint ||
        !card.skills.some((skill) => skill.id === profile.statement.value.capability) ||
        !card.defaultInputModes.includes('application/json') || !card.defaultOutputModes.includes('application/json')) throw new Error('origin card binding mismatch');
    }
    const observedAt = options.now();
    if (!isUtcSecond(observedAt)) throw new Error('invalid observation time');
    return { current: 'observed', profile, observedAt, historicalAuthority: 'not-independently-proven',
      ...(card && cardBytes ? { card, cardBytes } : {}) };
  } catch {
    options.signal?.throwIfAborted();
    return { current: 'unknown', observedAt: options.now(), historicalAuthority: 'not-independently-proven', reason: 'origin-observation-unavailable' };
  }
}

const pointerSchema = z.strictObject({ identifier: originUrlSchema, displayName: z.string().min(1).max(255),
  type: z.string().min(1).max(512), url: originUrlSchema, description: z.string().max(1000).nullable(),
  capabilityIds: z.array(z.string().max(512)).max(64), areaServed: z.array(z.string().max(512)).max(64),
  interfaces: z.array(z.string().max(512)).max(64), provenance: z.strictObject({
    sourceId: z.string().max(512), sourceKind: z.literal('organization-declaration'), organizationId: z.string().min(1).max(512),
    revision: z.string().max(128), observedAt: z.string().max(64) }) });
const pointerResponse = z.strictObject({ items: z.array(z.unknown()).max(100), observerOrigin: z.string().max(2048),
  pageToken: z.string().min(1).max(4096).nullable(), coverage: z.strictObject({ scope: z.literal('local-projection'),
    upstreamSearch: z.literal('not-attempted'), paginationConsistency: z.literal('live-keyset'),
    readAt: z.string().max(64), identitySources: z.array(z.unknown()).max(32) }) });
/** Organization rows are untrusted pointers only; ERC8004 discovery remains separate and strict. */
export async function searchOriginPointers(indexOrigin: string, signal?: AbortSignal) {
  const origin = ownedIndexOrigin(indexOrigin);
  const pointers: { identityUrl: string; observerOrigin: string; authority: 'untrusted-organization-pointer' }[] = [];
  const errors: string[] = [], tokens = new Set<string>(); let token: string | null = null, complete = false;
  for (let page = 0; page < 10; page++) {
    signal?.throwIfAborted();
    try {
      const bytes = await readIndexBytes(`${origin}/api/ard/services/search`, 2 * 1024 * 1024, {
        method: 'POST', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          filter: { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'], areaServed: ['Chicago'], interfaces: ['A2A'] },
          pageSize: 100, ...(token ? { pageToken: token } : {}) }) });
      const body = pointerResponse.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (body.observerOrigin !== origin) throw new Error('observer mismatch');
      for (const raw of body.items) {
        const item = pointerSchema.safeParse(raw);
        if (!item.success || item.data.identifier !== item.data.url ||
          !item.data.capabilityIds.includes('urn:nandacity:capability:evening-plan:0.1') ||
          !item.data.areaServed.includes('Chicago') || !item.data.interfaces.includes('A2A')) { errors.push('rejected-pointer'); continue; }
        if (!pointers.some((p) => p.identityUrl === item.data.url)) pointers.push({ identityUrl: item.data.url,
          observerOrigin: origin, authority: 'untrusted-organization-pointer' });
      }
      if (!body.pageToken) { complete = true; break; }
      if (tokens.has(body.pageToken)) throw new Error('repeated cursor');
      token = body.pageToken; tokens.add(token);
    } catch { signal?.throwIfAborted(); errors.push('search-incomplete'); break; }
  }
  if (!complete && !errors.includes('search-incomplete')) errors.push('search-incomplete');
  return { pointers, complete, errors };
}
