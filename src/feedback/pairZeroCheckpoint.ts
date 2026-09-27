import { isDeepStrictEqual } from 'node:util';
import { createPublicClient, custom, http, encodeAbiParameters, encodeFunctionData, isAddress,
  keccak256, numberToHex, parseAbi, parseAbiParameters, stringToHex, toEventSelector, zeroAddress,
  type Address, type Hex, type PublicClient, type Transport } from 'viem';
import { IMPLEMENTATION_SLOT } from '../identity/continuity.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { decodeStrictRawString } from '../identity/rawAbi.js';
import { verifyProfile } from '../identity/verify.js';
import { boundRpcFetch, type ReadRequestBudget, type ReadRequestLease } from '../identity/rpcTransport.js';
import type { DeploymentTransaction } from './reputationActivation.js';
import type { FeedbackPublicationDomain } from './publication.js';
import { reputationRegistryAbi } from './registry.js';
import { decodeRawRegistryFeedbackEvent, readRegistryFeedbackObservation,
  type RegistryFeedbackObservation } from './registryObservation.js';

export type CheckpointRpcSource = { kind: 'bounded-http'; url: string } | {
  kind: 'literal-fixture'; exchanges: readonly {
    method: string; params: readonly unknown[]; requestId: number; responseUtf8: Uint8Array;
  }[];
};
export type CheckpointBasis = { blockNumber: bigint; blockHash: Hex };
export type CheckpointPair = { agentId: string; reviewer: Address };
export type CheckpointPins = {
  proxy: { fullRuntimeHex: Hex; fullRuntimeHash: Hex; reviewId: string };
  identity: { implementation: Address; fullRuntimeHash: Hex; sourceBuildId: string };
  reputation: { implementation: Address; fullRuntimeHash: Hex; sourceBuildId: string };
};
export type CheckpointRegistration = DeploymentTransaction & {
  agentId: string; owner: Address; mintLogIndex: number; registeredLogIndex: number;
  profileBasis: CheckpointBasis; cardBytes: Uint8Array;
};
export type FreshPairZeroLimits = {
  maxBlocks: number; chunkBlocks: number; maxPairs: number; maxPairCounter: number;
  maxTotalCounter: number; maxRpcCalls: number; totalTimeoutMs: number; rpcTimeoutMs: number;
  maxTotalResponseBytes: number; maxResponseBytes: number; maxLogs: number; maxReceiptLogs: number;
  maxReceiptBytes: number; maxLogBytes: number; maxInputBytes: number; maxCodeBytes: number;
  maxRequestMetadataBytes: number; maxTotalRequestMetadataBytes: number; maxLedgerBytes: number;
};
export type FreshPairZeroInput = {
  kind: 'fresh-pair-zero-v1'; domain: FeedbackPublicationDomain; pins: CheckpointPins;
  registrationBasis: CheckpointBasis; registrations: readonly CheckpointRegistration[];
  zeroBasis: CheckpointBasis; pairs: readonly CheckpointPair[]; observation: CheckpointBasis;
  source: CheckpointRpcSource; parentBudget?: ReadRequestBudget;
  limits?: Partial<FreshPairZeroLimits>; signal?: AbortSignal;
};
export type QualifiedCheckpointPair = CheckpointPair & {
  zeroSlot: Hex; zeroValue: '0'; lastIndex: string; coveredIndices: string[]; slots: RegistryFeedbackObservation[];
};
export type SerializedCheckpointBasis = { blockNumber: string; blockHash: Hex };
export type CheckpointResultBasis = {
  kind: 'fresh-pair-zero-v1'; qualification: 'rpc-derived-not-state-proof';
  domain: FeedbackPublicationDomain; pins: CheckpointPins;
  registrationBasis: SerializedCheckpointBasis; zeroBasis: SerializedCheckpointBasis;
  observation: SerializedCheckpointBasis & { blockTimestamp?: string };
  proxyQualification: 'exact-byte-behavior-reviewed'; proxyFullBuildMatch: false;
  assumptions: string[]; diagnostics: string[];
  registrations: (DeploymentTransaction & { agentId: string; owner: Address; mintLogIndex: number;
    registeredLogIndex: number; profileBasis: SerializedCheckpointBasis })[];
  admins: { registry: Address; basis: SerializedCheckpointBasis; owner: Address }[];
  rawEvidenceRefs: { method: string; requestDigest: Hex; responseDigest: Hex }[];
};
export type FreshPairZeroObservation = CheckpointResultBasis & (
  { status: 'matched'; observation: SerializedCheckpointBasis & { blockTimestamp: string }; qualifiedPairs: QualifiedCheckpointPair[] } |
  { status: 'mismatched' | 'unsupported' | 'unavailable'; qualifiedPairs?: never }
);
export type CheckpointRpcLedger = { entries: readonly {
  method: string; params: readonly unknown[]; requestId: number;
  disposition: 'result' | 'rpc-error' | 'invalid-response' | 'transport-failed' | 'aborted';
  responseUtf8?: Uint8Array;
}[]; complete: boolean };
export type FreshPairZeroAcquisition = { finding: FreshPairZeroObservation; ledger: CheckpointRpcLedger };

const ceilings: FreshPairZeroLimits = { maxBlocks: 4096, chunkBlocks: 64, maxPairs: 48, maxPairCounter: 32,
  maxTotalCounter: 512, maxRpcCalls: 4096, totalTimeoutMs: 60_000, rpcTimeoutMs: 5000,
  maxTotalResponseBytes: 8 * 1024 * 1024, maxResponseBytes: 512 * 1024, maxLogs: 1024,
  maxReceiptLogs: 256, maxReceiptBytes: 128 * 1024, maxLogBytes: 64 * 1024, maxInputBytes: 64 * 1024,
  maxCodeBytes: 32 * 1024, maxRequestMetadataBytes: 128 * 1024,
  maxTotalRequestMetadataBytes: 2 * 1024 * 1024, maxLedgerBytes: 12 * 1024 * 1024 };
// This exact runtime alone has the narrow reviewed dispatch behavior. No stripped metadata allowlist.
const reviewedProxy = '0x60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545f9081906001600160a01b0316368280378136915af43d5f803e156048573d5ff35b3d5ffdfea2646970667358221220d25633e50c873a78e74176feb55eabe7e699db80eeb0380952dba33544b2c7f664736f6c63430008180033';
const reviewedProxyHash = '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41';
const lastIndexBase = '0xa03d7693f2b3746b2d03f163c788147b71aa82854399a21fdf4de143ba778301';
const addressAbi = parseAbiParameters('address'), uintAbi = parseAbiParameters('uint256');
const ownerAbi = parseAbi(['function owner() view returns (address)']);
const upgradeTopic = toEventSelector('Upgraded(address)'), initTopic = toEventSelector('Initialized(uint64)');
const mintTopic = toEventSelector('Transfer(address,address,uint256)');
const registeredTopic = toEventSelector('Registered(uint256,string,address)');
const feedbackTopic = toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');
const versionBytes = encodeAbiParameters(parseAbiParameters('string'), ['2.0.0']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && v.length === 66;
const address = (v: unknown): v is Address => typeof v === 'string' && v.length === 42 && isAddress(v, { strict: false });
const uint = (v: unknown): v is string => typeof v === 'string' && v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v) && v.trim() === v && BigInt(v) < 1n << 256n;
const index = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const serialized = (b: CheckpointBasis): SerializedCheckpointBasis => ({ blockNumber: b.blockNumber.toString(), blockHash: b.blockHash });
class Failure extends Error {
  constructor(readonly status: 'mismatched' | 'unsupported' | 'unavailable', readonly code: string) { super(code); }
}
function fail(status: Failure['status'], code: string): never { throw new Failure(status, code); }
function unavailable(code: string): never { return fail('unavailable', code); }
function mismatch(code: string): never { return fail('mismatched', code); }
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) mismatch('malformed-rpc-object');
  return v as Record<string, unknown>;
}
function quantity(v: unknown): bigint {
  if (typeof v !== 'string' || v.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) || v.trim() !== v) mismatch('malformed-rpc-quantity');
  return BigInt(v);
}
function coordinate(v: unknown): number {
  const n = quantity(v); if (n > BigInt(Number.MAX_SAFE_INTEGER)) mismatch('unsafe-rpc-coordinate'); return Number(n);
}
function checkedHash(v: unknown): Hex { if (!hash(v)) mismatch('malformed-rpc-hash'); return v; }
function checkedAddress(v: unknown): Address { if (!address(v)) mismatch('malformed-rpc-address'); return v.toLowerCase() as Address; }
function bytes(v: unknown, cap: number, label: string): Hex {
  if (typeof v !== 'string') mismatch(`malformed-${label}`);
  if (v.length > cap * 2 + 2) unavailable(`${label}-byte-budget-exceeded`);
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(v) || v.trim() !== v) mismatch(`malformed-${label}`);
  return v as Hex;
}
function word(v: unknown): Hex {
  const value = bytes(v, 32, 'word'); if (value.length !== 66) mismatch('malformed-word'); return value;
}
function decodedAddress(v: unknown): Address {
  const value = word(v); if (!/^0x0{24}[0-9a-f]{40}$/i.test(value)) mismatch('noncanonical-address-word');
  return `0x${value.slice(26)}`.toLowerCase() as Address;
}
export function deriveLastIndexSlot(agentId: string, reviewer: Address): Hex {
  if (!uint(agentId) || !address(reviewer)) throw new Error('invalid checkpoint pair');
  const outer = keccak256(encodeAbiParameters(parseAbiParameters('uint256,uint256'), [BigInt(agentId), BigInt(lastIndexBase)]));
  return keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'), [reviewer, outer]));
}

/** Own every physical acquisition and its wire bytes; consumers only borrow this client. */
function acquisition(source: CheckpointRpcSource, limits: FreshPairZeroLimits, refs: CheckpointResultBasis['rawEvidenceRefs'],
  parent?: ReadRequestBudget, signal?: AbortSignal) {
  const sourceKind = source.kind;
  const controller = new AbortController(), deadline = performance.now() + limits.totalTimeoutMs;
  const abort = () => controller.abort(new Error('checkpoint cancelled'));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, limits.totalTimeoutMs);
  const entries: Array<CheckpointRpcLedger['entries'][number]> = [];
  const completeBodies = new WeakSet<CheckpointRpcLedger['entries'][number]>();
  const pending = new Set<Promise<unknown>>();
  let calls = 0, totalBytes = 0, metadataBytes = 0, ledgerBytes = 31, cursor = 0, complete = true;
  const check = () => {
    if (controller.signal.aborted) unavailable('cancelled-or-deadline');
    if (performance.now() >= deadline) unavailable('total-timeout');
  };
  const local: ReadRequestBudget = { async open(incoming) {
    check();
    const leaseController = new AbortController();
    const signals = [controller.signal, incoming].filter((s): s is AbortSignal => !!s);
    const cancel = () => leaseController.abort();
    for (const s of signals) { s.addEventListener('abort', cancel, { once: true }); if (s.aborted) cancel(); }
    const due = performance.now() + limits.rpcTimeoutMs;
    const timeout = setTimeout(cancel, limits.rpcTimeoutMs);
    let charged = false, responseBytes = 0;
    return { signal: leaseController.signal, check() {
      check(); if (leaseController.signal.aborted || performance.now() >= due) unavailable('rpc-timeout-or-cancelled');
      if (!charged) { if (calls >= limits.maxRpcCalls) unavailable('rpc-call-budget-exceeded'); calls++; charged = true; }
    }, bytes(n) {
      if (!Number.isSafeInteger(n) || n < 0) unavailable('invalid-byte-charge');
      responseBytes += n; totalBytes += n;
      if (responseBytes > limits.maxResponseBytes || totalBytes > limits.maxTotalResponseBytes) unavailable('response-wire-budget-exceeded');
    }, close() { clearTimeout(timeout); for (const s of signals) s.removeEventListener('abort', cancel); } };
  } };
  const composite: ReadRequestBudget = { async open(incoming) {
    const own = await local.open(incoming); let outer: ReadRequestLease | undefined;
    try {
      if (parent) outer = await parent.open(own.signal);
      check(); own.signal.throwIfAborted(); outer?.signal.throwIfAborted();
      return { signal: outer ? AbortSignal.any([own.signal, outer.signal]) : own.signal,
        check() { own.check(); outer?.check(); }, bytes(n) { try { own.bytes(n); } finally { outer?.bytes(n); } },
        close() { try { outer?.close(); } finally { own.close(); } } };
    } catch (error) { try { outer?.close(); } finally { own.close(); } throw error; }
  } };
  function reserve(method: string, params: readonly unknown[], requestId: number) {
    // Metadata is bounded before its snapshot; JSON serialization is limited by the validated RPC methods/inputs.
    const raw = JSON.stringify({ method, params, requestId }); const size = Buffer.byteLength(raw);
    if (size > limits.maxRequestMetadataBytes || metadataBytes + size > limits.maxTotalRequestMetadataBytes) {
      complete = false; unavailable('request-metadata-budget-exceeded');
    }
    const copy = JSON.parse(raw) as { method: string; params: readonly unknown[]; requestId: number };
    const entry: CheckpointRpcLedger['entries'][number] = { ...copy, disposition: 'transport-failed' };
    const cost = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (ledgerBytes + cost > limits.maxLedgerBytes) { complete = false; unavailable('ledger-budget-exceeded'); }
    metadataBytes += size; ledgerBytes += cost; entries.push(entry); return entry;
  }
  function keep(entry: CheckpointRpcLedger['entries'][number], raw: Uint8Array) {
    // Uint8Array's actual JSON form is an indexed object, not a base64 estimate.
    let cost = 19; // responseUtf8 property, object braces, comma; conservative by one byte.
    for (let i = 0; i < raw.length; i++) cost += String(i).length + String(raw[i]).length + 4;
    if (ledgerBytes + cost > limits.maxLedgerBytes) { complete = false; unavailable('ledger-budget-exceeded'); }
    ledgerBytes += cost; entry.responseUtf8 = new Uint8Array(raw);
  }
  function decode(entry: CheckpointRpcLedger['entries'][number]): unknown {
    try {
      if (!entry.responseUtf8) throw new Error('missing response');
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.responseUtf8));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid envelope');
      const r = decoded as Record<string, unknown>;
      if (r.jsonrpc !== '2.0' || r.id !== entry.requestId || Object.hasOwn(r, 'result') === Object.hasOwn(r, 'error')) throw new Error('invalid envelope');
      if (Object.hasOwn(r, 'error')) { entry.disposition = 'rpc-error'; unavailable('rpc-error'); }
      entry.disposition = 'result';
      refs.push({ method: entry.method, requestDigest: keccak256(stringToHex(JSON.stringify([entry.method, entry.params]))),
        responseDigest: keccak256(stringToHex(JSON.stringify(r.result))) });
      return r.result;
    } catch (error) {
      if (entry.disposition !== 'rpc-error') entry.disposition = 'invalid-response';
      if (error instanceof Failure) throw error;
      unavailable('invalid-rpc-response');
    }
  }
  let transport: Transport;
  try {
  if (source.kind === 'literal-fixture') {
    // Bound the entire caller-owned fixture before copying any response bytes or awaiting a lease.
    if (source.exchanges.length > limits.maxRpcCalls) unavailable('fixture-call-budget-exceeded');
    let wire = 0, meta = 0;
    const exchanges = source.exchanges.map(e => {
      if (!index(e.requestId) || typeof e.method !== 'string' || !Array.isArray(e.params) || !(e.responseUtf8 instanceof Uint8Array)) throw new Error('invalid literal exchange');
      const request = JSON.stringify([e.method, e.params, e.requestId]);
      const size = Buffer.byteLength(request); meta += size; wire += e.responseUtf8.byteLength;
      if (size > limits.maxRequestMetadataBytes || meta > limits.maxTotalRequestMetadataBytes ||
        e.responseUtf8.byteLength > limits.maxResponseBytes || wire > limits.maxTotalResponseBytes) unavailable('fixture-byte-budget-exceeded');
      return { method: e.method, params: JSON.parse(JSON.stringify(e.params)) as readonly unknown[],
        requestId: e.requestId, responseUtf8: new Uint8Array(e.responseUtf8) };
    });
    transport = custom({ async request({ method, params }) {
      const exchange = exchanges[cursor++];
      const entry = reserve(method, (params ?? []) as readonly unknown[], exchange?.requestId ?? cursor);
      let lease: ReadRequestLease | undefined;
      try {
        lease = await composite.open(controller.signal); lease.signal.throwIfAborted(); lease.check();
        if (!exchange || exchange.method !== method || !isDeepStrictEqual(exchange.params, params ?? [])) unavailable('literal-exchange-unavailable');
        lease.signal.throwIfAborted();
        try { lease.bytes(exchange.responseUtf8.byteLength); }
        finally { keep(entry, exchange.responseUtf8); }
        lease.check();
        return decode(entry);
      } catch (error) { if (controller.signal.aborted || lease?.signal.aborted) entry.disposition = 'aborted'; throw error; }
      finally { lease?.close(); }
    } }, { retryCount: 0 });
  } else {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
      throw new Error('checkpoint HTTP requires loopback HTTP or HTTPS');
    }
    // Never copy URL, headers or credentials into evidence. The provider body is private, untrusted data.
    const capturedFetch: typeof fetch = (input, options) => {
      let wireLease: ReadRequestLease | undefined;
      const physicallyChargedBudget: ReadRequestBudget = { async open(incoming) {
        wireLease = await composite.open(incoming);
        // The owned reader charges at acquisition, before capture can reject a chunk.
        // boundRpcFetch still owns checks/cancellation/close, but must not recharge bytes.
        return { ...wireLease, bytes() {} };
      } };
      const ownedFetch: typeof fetch = async (request, init) => {
        const lease = wireLease; if (!lease) unavailable('http-budget-unavailable');
        const body = init?.body;
        if (typeof body !== 'string' || Buffer.byteLength(body) > limits.maxRequestMetadataBytes) unavailable('request-metadata-budget-exceeded');
        const rpc = JSON.parse(body) as { method: string; params?: readonly unknown[]; id: number };
        const entry = reserve(rpc.method, rpc.params ?? [], rpc.id);
        let response: Response;
        try {
          response = await fetch(request, init);
        } catch (error) {
          entry.disposition = init?.signal?.aborted || controller.signal.aborted ? 'aborted' : 'transport-failed';
          throw error;
        }
        const reader = response.body?.getReader();
        if (!reader) unavailable('rpc-response-unavailable');
        const chunks: Uint8Array[] = []; let length = 0, settled = false;
        function finish() {
          if (settled) return; settled = true;
          if (chunks.length) { ledgerBytes += 19; entry.responseUtf8 = new Uint8Array(Buffer.concat(chunks, length)); }
          reader!.releaseLock();
        }
        async function cancel() {
          if (settled) return;
          if (init?.signal?.aborted || controller.signal.aborted) entry.disposition = 'aborted';
          try { await reader!.cancel(); } catch { /* preserve the failed disposition */ } finally { finish(); }
        }
        // Charge every physically acquired chunk before any capture/cancellation rejection.
        // Retain locally bounded bytes even if the parent rejects their charge; never parse them.
        const bodyStream = new ReadableStream<Uint8Array>({ async pull(out) {
          try {
            const { done, value } = await reader.read();
            if (!done) {
              try { lease.bytes(value.byteLength); }
              finally {
                if (length + value.length > limits.maxResponseBytes || totalBytes > limits.maxTotalResponseBytes) {
                  complete = false; unavailable('response-wire-budget-exceeded');
                }
                let cost = 0; for (let n = 0; n < value.length; n++) cost += String(length + n).length + String(value[n]).length + 4;
                if (ledgerBytes + cost + 19 > limits.maxLedgerBytes) { complete = false; unavailable('ledger-budget-exceeded'); }
                ledgerBytes += cost; length += value.length; chunks.push(new Uint8Array(value));
              }
            }
            check(); init?.signal?.throwIfAborted();
            if (done) { completeBodies.add(entry); finish(); out.close(); return; }
            out.enqueue(value);
          } catch (error) { await cancel(); out.error(error); }
        }, cancel }, { highWaterMark: 0 });
        return new Response(bodyStream, { status: response.status, headers: response.headers });
      };
      return boundRpcFetch(ownedFetch, { budget: physicallyChargedBudget, signal: controller.signal })(input, options);
    };
    transport = http(url.toString(), { retryCount: 0, batch: false, timeout: 5000,
      fetchFn: capturedFetch });
  }
  const cache = new Map<string, Promise<unknown>>();
  const owned: Transport = options => {
    const upstream = transport(options);
    const request: typeof upstream.request = ((args: Parameters<typeof upstream.request>[0], requestOptions: Parameters<typeof upstream.request>[1]) => {
      check(); const params = (args.params ?? []) as readonly unknown[];
      const cacheable = ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(args.method) &&
        typeof params.at(-1) === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(params.at(-1) as string) ||
        ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(args.method);
      const key = JSON.stringify([args.method, params]);
      if (cacheable && cache.has(key)) return cache.get(key)! as ReturnType<typeof upstream.request>;
      const work = (async () => {
        const first = entries.length;
        try {
          const value = await upstream.request(args, { ...requestOptions, retryCount: 0 });
          check();
          if (sourceKind === 'bounded-http') {
            const entry = entries.slice(first).find(e => e.method === args.method && JSON.stringify(e.params) === JSON.stringify(params));
            if (!entry) unavailable('ledger-response-unavailable');
            return decode(entry);
          }
          return value;
        } catch (error) {
          if (sourceKind === 'bounded-http') for (const entry of entries.slice(first)) {
            if (entry.method === args.method && isDeepStrictEqual(entry.params, params) && entry.responseUtf8 &&
              completeBodies.has(entry) && entry.disposition === 'transport-failed') {
              // HTTP RPC errors/malformed envelopes are still complete acquisitions; do not
              // turn a transport failure with only a partial body into a result.
              try { decode(entry); } catch { /* decode preserves rpc-error versus invalid-response */ }
            }
          }
          throw error;
        }
      })();
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
      if (cacheable) cache.set(key, work);
      return work as ReturnType<typeof upstream.request>;
    }) as typeof upstream.request;
    return { ...upstream, request };
  };
  const client = createPublicClient({ cacheTime: 0, batch: { multicall: false }, transport: owned });
  return { client, signal: controller.signal, check,
    async close(): Promise<CheckpointRpcLedger> {
      controller.abort(); await Promise.allSettled(pending); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      return { entries, complete };
    } };
  } catch (error) {
    controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); throw error;
  }
}

type Log = DeploymentTransaction & { address: Address; logIndex: number; data: Hex; topics: Hex[] };
const identicalLog = (a: Log, b: Log) => JSON.stringify(a).toLowerCase() === JSON.stringify(b).toLowerCase();

/** Fixed pair-scoped checkpoint; no deployment provenance, eligibility, document fetch or state proof. */
export async function readFreshPairZeroCheckpoint(input: FreshPairZeroInput): Promise<FreshPairZeroAcquisition> {
  const limits = { ...ceilings, ...input.limits };
  for (const key of Object.keys(limits) as Array<keyof FreshPairZeroLimits>) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ceilings[key]) throw new Error(`invalid checkpoint limit: ${key}`);
  }
  const validBasis = (b: CheckpointBasis) => typeof b.blockNumber === 'bigint' && b.blockNumber >= 0n && b.blockNumber < 1n << 256n && hash(b.blockHash);
  const domain = { ...input.domain }, pins = { proxy: { ...input.pins.proxy }, identity: { ...input.pins.identity }, reputation: { ...input.pins.reputation } };
  const A = { ...input.registrationBasis }, C = { ...input.zeroBasis }, B = { ...input.observation };
  if (input.kind !== 'fresh-pair-zero-v1' || !Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 || !hash(domain.genesisHash) ||
    ![domain.identityRegistry, domain.reputationRegistry].every(v => address(v) && !same(v, zeroAddress)) || same(domain.identityRegistry, domain.reputationRegistry) ||
    ![A, C, B].every(validBasis) || ![pins.identity, pins.reputation].every(p => address(p.implementation) && !same(p.implementation, zeroAddress) && hash(p.fullRuntimeHash) &&
      typeof p.sourceBuildId === 'string' && p.sourceBuildId.length > 0 && Buffer.byteLength(p.sourceBuildId) <= 256) ||
    !hash(pins.proxy.fullRuntimeHash) || typeof pins.proxy.reviewId !== 'string' || !pins.proxy.reviewId.length || Buffer.byteLength(pins.proxy.reviewId) > 256 ||
    typeof pins.proxy.fullRuntimeHex !== 'string' || pins.proxy.fullRuntimeHex.length > 2 + ceilings.maxCodeBytes * 2) throw new Error('invalid checkpoint configuration');
  if (!Array.isArray(input.pairs) || !Array.isArray(input.registrations)) throw new Error('invalid checkpoint subjects');
  const base: CheckpointResultBasis = { kind: 'fresh-pair-zero-v1', qualification: 'rpc-derived-not-state-proof', domain, pins,
    registrationBasis: serialized(A), zeroBasis: serialized(C), observation: serialized(B), proxyQualification: 'exact-byte-behavior-reviewed',
    proxyFullBuildMatch: false, assumptions: ['configured-trusted-pins-not-source-verification', 'truthful-canonical-rpc-and-complete-logs',
      'normal-chain-execution-no-invisible-state-edits', 'upgradeable-administration-not-trusted-by-identity',
      'pair-scoped-post-checkpoint-history-only'], diagnostics: [], registrations: [], admins: [], rawEvidenceRefs: [] };
  let finding: FreshPairZeroObservation = { ...base, status: 'unavailable' };
  let owned: ReturnType<typeof acquisition> | undefined;
  let ledger: CheckpointRpcLedger = { entries: [], complete: true };
  try {
    if (input.pairs.length === 0 || input.registrations.length === 0) mismatch('empty-checkpoint-scope');
    if (input.pairs.length > limits.maxPairs || input.registrations.length > limits.maxPairs) unavailable('pair-budget-exceeded');
    if (A.blockNumber >= C.blockNumber || C.blockNumber > B.blockNumber) mismatch('checkpoint-basis-order');
    if (B.blockNumber - A.blockNumber + 1n > BigInt(limits.maxBlocks)) unavailable('block-span-budget-exceeded');
    if (!same(pins.proxy.fullRuntimeHex, reviewedProxy) || !same(pins.proxy.fullRuntimeHash, reviewedProxyHash)) fail('unsupported', 'unreviewed-proxy-pin');
    const pairs = input.pairs.map(p => ({ agentId: p.agentId, reviewer: p.reviewer }));
    if (pairs.some(p => !uint(p.agentId) || !address(p.reviewer) || same(p.reviewer, zeroAddress))) throw new Error('invalid checkpoint pair');
    if (new Set(pairs.map(p => `${p.agentId}:${p.reviewer.toLowerCase()}`)).size !== pairs.length) mismatch('duplicate-pair');
    const registrations = input.registrations.map(r => {
      if (!uint(r.agentId) || !uint(r.blockNumber) || !hash(r.transactionHash) || !hash(r.blockHash) || !index(r.transactionIndex) ||
        !index(r.mintLogIndex) || !index(r.registeredLogIndex) || !address(r.owner) || same(r.owner, zeroAddress) || !validBasis(r.profileBasis) ||
        !(r.cardBytes instanceof Uint8Array)) throw new Error('invalid checkpoint registration');
      if (r.cardBytes.byteLength > limits.maxInputBytes) unavailable('card-byte-budget-exceeded');
      const n = BigInt(r.blockNumber);
      if (!(A.blockNumber < n && n <= r.profileBasis.blockNumber && r.profileBasis.blockNumber <= C.blockNumber)) mismatch('registration-basis-order');
      const ref = { transactionHash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash,
        transactionIndex: r.transactionIndex, agentId: r.agentId, owner: r.owner, mintLogIndex: r.mintLogIndex,
        registeredLogIndex: r.registeredLogIndex, profileBasis: { ...r.profileBasis } };
      base.registrations.push({ ...ref, profileBasis: serialized(ref.profileBasis) });
      return { ...ref, cardBytes: new Uint8Array(r.cardBytes) };
    });
    const ids = new Set(registrations.map(r => r.agentId));
    if (ids.size !== registrations.length || pairs.some(p => !ids.has(p.agentId)) || registrations.some(r => !pairs.some(p => p.agentId === r.agentId))) mismatch('registration-pair-scope-mismatch');
    owned = acquisition(input.source, limits, base.rawEvidenceRefs, input.parentBudget, input.signal);
    const { client, signal, check } = owned;
    const rpc = (method: string, params: readonly unknown[] = []): Promise<unknown> => client.request({ method, params } as Parameters<PublicClient['request']>[0]);
    const call = async (registry: Address, data: Hex, n: bigint) => rpc('eth_call', [{ to: registry, data }, numberToHex(n)]);
    const blocks = new Map<bigint, { blockHash: Hex; blockTimestamp: string }>();
    async function block(n: bigint, expected: Hex, recheck = false) {
      const previous = blocks.get(n); if (previous && !same(previous.blockHash, expected)) unavailable('conflicting-block-bases');
      if (previous && !recheck) return previous;
      const raw = await rpc('eth_getBlockByNumber', [numberToHex(n), false]); if (raw === null) unavailable('numbered-block-unavailable');
      const b = object(raw); if (quantity(b.number) !== n) mismatch('block-number-mismatch');
      const bh = checkedHash(b.hash); if (!same(bh, expected)) unavailable('canonicality-changed');
      const result = { blockHash: bh, blockTimestamp: quantity(b.timestamp).toString() }; blocks.set(n, result); return result;
    }
    function rawLog(v: unknown): Log {
      const l = object(v); if (l.removed !== false) unavailable('removed-or-orphaned-log');
      if (!Array.isArray(l.topics) || l.topics.length > 4) mismatch('malformed-log-topics');
      const data = bytes(l.data, limits.maxLogBytes, 'log');
      if ((data.length - 2) / 2 + l.topics.length * 32 > limits.maxLogBytes) unavailable('log-byte-budget-exceeded');
      return { address: checkedAddress(l.address), transactionHash: checkedHash(l.transactionHash),
        blockNumber: quantity(l.blockNumber).toString(), blockHash: checkedHash(l.blockHash), transactionIndex: coordinate(l.transactionIndex),
        logIndex: coordinate(l.logIndex), data, topics: l.topics.map(checkedHash) };
    }
    const authenticated = new Map<string, Log[]>();
    const transactionPositions = new Map<string, string>(), transactionCoordinates = new Map<string, string>();
    const logPositions = new Map<string, Log>();
    async function authenticate(ref: DeploymentTransaction): Promise<Log[]> {
      await block(BigInt(ref.blockNumber), ref.blockHash);
      const key = JSON.stringify([ref.transactionHash, ref.blockNumber, ref.blockHash, ref.transactionIndex]);
      if (authenticated.has(key)) return authenticated.get(key)!;
      const position = `${ref.blockNumber}:${ref.transactionIndex}`, txHash = ref.transactionHash.toLowerCase();
      if ((transactionPositions.has(position) && transactionPositions.get(position) !== txHash) ||
        (transactionCoordinates.has(txHash) && transactionCoordinates.get(txHash) !== position)) mismatch('conflicting-transaction-coordinates');
      transactionPositions.set(position, txHash); transactionCoordinates.set(txHash, position);
      const tv = await rpc('eth_getTransactionByHash', [ref.transactionHash]); if (tv === null) unavailable('transaction-unavailable');
      const tx = object(tv);
      if (!same(checkedHash(tx.hash), ref.transactionHash) || quantity(tx.blockNumber) !== BigInt(ref.blockNumber) ||
        !same(checkedHash(tx.blockHash), ref.blockHash) || coordinate(tx.transactionIndex) !== ref.transactionIndex) mismatch('transaction-coordinate-mismatch');
      const from = checkedAddress(tx.from), to = tx.to === null ? null : checkedAddress(tx.to);
      bytes(tx.input, limits.maxInputBytes, 'transaction-input'); quantity(tx.value); quantity(tx.nonce);
      const rv = await rpc('eth_getTransactionReceipt', [ref.transactionHash]); if (rv === null) unavailable('receipt-unavailable');
      const r = object(rv);
      if (r.status !== '0x1' || !same(checkedHash(r.transactionHash), ref.transactionHash) || quantity(r.blockNumber) !== BigInt(ref.blockNumber) ||
        !same(checkedHash(r.blockHash), ref.blockHash) || coordinate(r.transactionIndex) !== ref.transactionIndex || !same(checkedAddress(r.from), from) ||
        (to === null ? r.to !== null : !same(checkedAddress(r.to), to))) mismatch('receipt-coordinate-mismatch');
      if (!Array.isArray(r.logs)) mismatch('malformed-receipt-logs');
      if (r.logs.length > limits.maxReceiptLogs) unavailable('receipt-log-budget-exceeded');
      let total = 0, previous = -1;
      const logs = r.logs.map(v => {
        const log = rawLog(v); total += (log.data.length - 2) / 2 + log.topics.length * 32;
        if (total > limits.maxReceiptBytes) unavailable('receipt-byte-budget-exceeded');
        if (log.blockNumber !== ref.blockNumber || !same(log.blockHash, ref.blockHash) || !same(log.transactionHash, ref.transactionHash) ||
          log.transactionIndex !== ref.transactionIndex || log.logIndex <= previous) mismatch('receipt-log-coordinate-mismatch');
        const logPosition = `${log.blockNumber}:${log.logIndex}`, existing = logPositions.get(logPosition);
        if (existing && !identicalLog(existing, log)) mismatch('conflicting-receipt-log-coordinates');
        logPositions.set(logPosition, log);
        previous = log.logIndex; return log;
      });
      authenticated.set(key, logs); return logs;
    }
    if (quantity(await rpc('eth_chainId')) !== BigInt(domain.chainId)) mismatch('chain-id-mismatch');
    await block(0n, domain.genesisHash); await block(A.blockNumber, A.blockHash); await block(C.blockNumber, C.blockHash);
    const observation = await block(B.blockNumber, B.blockHash); base.observation = { ...serialized(B), blockTimestamp: observation.blockTimestamp };
    const bases = [A, ...registrations.flatMap(r => [{ blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash }, r.profileBasis]), C, B];
    const qualified = new Set<bigint>();
    for (const basis of bases) {
      await block(basis.blockNumber, basis.blockHash); if (qualified.has(basis.blockNumber)) continue;
      for (const [registry, pin] of [[domain.identityRegistry, pins.identity], [domain.reputationRegistry, pins.reputation]] as const) {
        const runtime = bytes(await rpc('eth_getCode', [registry, numberToHex(basis.blockNumber)]), limits.maxCodeBytes, 'code');
        if (!same(runtime, reviewedProxy) || !same(keccak256(runtime), pins.proxy.fullRuntimeHash)) fail('unsupported', 'proxy-runtime-mismatch');
        const slot = word(await rpc('eth_getStorageAt', [registry, IMPLEMENTATION_SLOT, numberToHex(basis.blockNumber)]));
        if (!same(slot, encodeAbiParameters(addressAbi, [pin.implementation]))) fail('unsupported', 'implementation-slot-mismatch');
        const implementation = bytes(await rpc('eth_getCode', [pin.implementation, numberToHex(basis.blockNumber)]), limits.maxCodeBytes, 'code');
        if (implementation === '0x' || !same(keccak256(implementation), pin.fullRuntimeHash)) fail('unsupported', 'implementation-runtime-mismatch');
        const admin = decodedAddress(await call(registry, encodeFunctionData({ abi: ownerAbi, functionName: 'owner' }), basis.blockNumber));
        base.admins.push({ registry, basis: serialized(basis), owner: admin });
        if (!same(bytes(await call(registry, encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getVersion' }), basis.blockNumber), limits.maxLogBytes, 'version'), versionBytes)) mismatch('registry-version-mismatch');
      }
      if (!same(decodedAddress(await call(domain.reputationRegistry, encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getIdentityRegistry' }), basis.blockNumber)), domain.identityRegistry)) mismatch('identity-link-mismatch');
      qualified.add(basis.blockNumber);
    }
    for (const r of registrations) {
      const logs = await authenticate(r), mint = logs.find(l => l.logIndex === r.mintLogIndex), registered = logs.find(l => l.logIndex === r.registeredLogIndex);
      if (!mint || !registered || mint.logIndex >= registered.logIndex || !same(mint.address, domain.identityRegistry) || !same(registered.address, domain.identityRegistry) ||
        mint.topics.length !== 4 || mint.data !== '0x' || !same(mint.topics[0]!, mintTopic) || !same(mint.topics[1]!, encodeAbiParameters(addressAbi, [zeroAddress])) ||
        !same(mint.topics[2]!, encodeAbiParameters(addressAbi, [r.owner])) || !same(mint.topics[3]!, encodeAbiParameters(uintAbi, [BigInt(r.agentId)])) ||
        registered.topics.length !== 3 || !same(registered.topics[0]!, registeredTopic) || !same(registered.topics[1]!, encodeAbiParameters(uintAbi, [BigInt(r.agentId)])) ||
        !same(registered.topics[2]!, encodeAbiParameters(addressAbi, [r.owner]))) mismatch('registration-event-mismatch');
      try { decodeStrictRawString(registered.data, limits.maxLogBytes, 'Registered'); } catch { mismatch('registration-event-abi-mismatch'); }
      const agent = { chainId: domain.chainId, registry: domain.identityRegistry, agentId: r.agentId };
      const snapshot = await readIdentitySnapshot(client, agent, r.profileBasis.blockNumber);
      if (!same(snapshot.blockHash, r.profileBasis.blockHash) || !same(snapshot.agentOwner, r.owner)) mismatch('profile-basis-mismatch');
      if (Buffer.byteLength(snapshot.agentURI) > limits.maxInputBytes) unavailable('profile-input-byte-budget-exceeded');
      try { verifyProfile({ agent, agentURI: snapshot.agentURI, cardBytes: r.cardBytes }, snapshot); } catch { mismatch('profile-verification-mismatch'); }
    }
    let scanned = 0;
    async function scan(registry: Address, from: bigint, topics: unknown[], consume: (log: Log) => Promise<void>) {
      for (let start = from; start <= B.blockNumber; start += BigInt(limits.chunkBlocks)) {
        const end = start + BigInt(limits.chunkBlocks - 1) < B.blockNumber ? start + BigInt(limits.chunkBlocks - 1) : B.blockNumber;
        const raw = await rpc('eth_getLogs', [{ address: registry, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics }]);
        if (!Array.isArray(raw)) unavailable('log-range-unavailable');
        if ((scanned += raw.length) > limits.maxLogs) unavailable('scan-log-budget-exceeded');
        for (const v of raw) {
          const log = rawLog(v), n = BigInt(log.blockNumber);
          if (n < start || n > end || !same(log.address, registry)) mismatch('log-filter-coordinate-mismatch');
          await consume(log);
        }
      }
    }
    for (const [registry, start] of [[domain.identityRegistry, A.blockNumber + 1n], [domain.reputationRegistry, C.blockNumber + 1n]] as const) {
      await scan(registry, start, [[upgradeTopic, initTopic]], async log => {
        if (!same(log.topics[0] ?? '', upgradeTopic) && !same(log.topics[0] ?? '', initTopic)) mismatch('continuity-log-topic-mismatch');
        fail('unsupported', 'initialization-or-upgrade-observed');
      });
    }
    async function counter(pair: CheckpointPair, n: bigint) {
      const getter = word(await call(domain.reputationRegistry, encodeFunctionData({ abi: reputationRegistryAbi,
        functionName: 'getLastIndex', args: [BigInt(pair.agentId), pair.reviewer] }), n));
      const storage = word(await rpc('eth_getStorageAt', [domain.reputationRegistry, deriveLastIndexSlot(pair.agentId, pair.reviewer), numberToHex(n)]));
      if (BigInt(getter) >= 1n << 64n || !same(getter, storage)) mismatch('counter-getter-storage-mismatch');
      return BigInt(getter);
    }
    const qualifiedPairs: QualifiedCheckpointPair[] = []; let total = 0;
    for (const pair of pairs) {
      const zero = await counter(pair, C.blockNumber); if (zero !== 0n) fail('unsupported', 'nonzero-checkpoint-counter');
      const last = await counter(pair, B.blockNumber);
      if (last > BigInt(limits.maxPairCounter) || (total += Number(last)) > limits.maxTotalCounter) unavailable('counter-budget-exceeded');
      const publications: Log[] = [];
      await scan(domain.reputationRegistry, C.blockNumber + 1n, [feedbackTopic, encodeAbiParameters(uintAbi, [BigInt(pair.agentId)]), encodeAbiParameters(addressAbi, [pair.reviewer])], async log => { publications.push(log); });
      publications.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
      if (publications.length !== Number(last)) mismatch('publication-counter-coverage-mismatch');
      const slots: RegistryFeedbackObservation[] = [];
      for (let i = 0; i < publications.length; i++) {
        const log = publications[i]!;
        let event; try { event = decodeRawRegistryFeedbackEvent(log, limits.maxLogBytes); } catch { mismatch('publication-event-abi-mismatch'); }
        if (event.agentId !== pair.agentId || !same(event.reviewer, pair.reviewer) || event.feedbackIndex !== String(i + 1)) mismatch('publication-index-order-mismatch');
        const ref = { transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: log.transactionIndex };
        const logs = await authenticate(ref);
        if (logs.filter(l => identicalLog(l, log)).length !== 1) mismatch('publication-receipt-log-mismatch');
        const observation = await readRegistryFeedbackObservation({ client, domain, eventRef: { ...ref, logIndex: log.logIndex },
          observation: B, signal, limits: { maxReceiptBytes: limits.maxReceiptBytes, maxReceiptLogs: limits.maxReceiptLogs,
            maxLogBytes: limits.maxLogBytes, rpcTimeoutMs: limits.rpcTimeoutMs, totalTimeoutMs: Math.min(limits.totalTimeoutMs, 30_000) } });
        if (observation.authenticity !== 'matched') fail(observation.authenticity === 'mismatched' ? 'mismatched' : 'unavailable', 'raw-slot-observation-failed');
        slots.push(observation);
      }
      qualifiedPairs.push({ ...pair, zeroSlot: deriveLastIndexSlot(pair.agentId, pair.reviewer), zeroValue: '0', lastIndex: last.toString(), coveredIndices: slots.map((_, i) => String(i + 1)), slots });
    }
    for (const [n, b] of blocks) await block(n, b.blockHash, true);
    check();
    finding = { ...base, status: 'matched', observation: { ...serialized(B), blockTimestamp: observation.blockTimestamp }, qualifiedPairs };
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('unavailable', 'rpc-or-input-unavailable');
    base.diagnostics.push(failure.code); finding = { ...base, status: failure.status };
  } finally { if (owned) ledger = await owned.close(); }
  if (!ledger.complete && finding.status === 'matched') finding = { ...base, status: 'unavailable', diagnostics: [...base.diagnostics, 'ledger-incomplete'] };
  return { finding, ledger };
}
