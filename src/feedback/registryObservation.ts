import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAbiItem, isAddress,
  keccak256, parseAbi, parseAbiParameters, toEventSelector, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { REPUTATION_REGISTRY_VERSION, reputationRegistryAbi } from './registry.js';
import type { FeedbackPublicationDomain, FeedbackPublicationReference } from './publication.js';

// Solidity string and bytes have the same ABI representation. Never decode these
// fields as text: arbitrary on-chain bytes, including malformed UTF-8, are legal.
const eventParameters = parseAbiParameters('uint64, int128, uint8, bytes, bytes, bytes, bytes, bytes32');
const storageParameters = parseAbiParameters('int128, uint8, bytes, bytes, bool');
const agentParameter = parseAbiParameters('uint256');
const reviewerParameter = parseAbiParameters('address');
const eventTopic = toEventSelector(getAbiItem({ abi: reputationRegistryAbi, name: 'NewFeedback' }));
const MAX_ABS_VALUE = 10n ** 38n;
const MAX_ABI_BYTES = 262_144;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isHash = (value: unknown): value is Hex => typeof value === 'string' && value.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(value);

function boundedHex(value: unknown, maxBytes: number): asserts value is Hex {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ABI_BYTES ||
    typeof value !== 'string' || value.length > 2 + maxBytes * 2 || value.trim() !== value || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error('invalid hex or ABI byte bound exceeded');
  }
}
function assertReferenceValue(value: bigint, decimals: number): void {
  if (value < -MAX_ABS_VALUE || value > MAX_ABS_VALUE || decimals > 18) {
    throw new Error('outside reference registry value bounds');
  }
}

export type RawRegistryFeedbackEvent = {
  agentId: string; reviewer: `0x${string}`; feedbackIndex: string; value: string; valueDecimals: number;
  tag1Bytes: Hex; tag2Bytes: Hex; endpointBytes: Hex; feedbackURIBytes: Hex; feedbackHash: Hex;
};
export type RawRegistryFeedbackStorage = {
  value: string; valueDecimals: number; tag1Bytes: Hex; tag2Bytes: Hex; isRevoked: boolean;
};

/** Strict raw ABI projection, not receipt authenticity, City eligibility or code provenance. */
export function decodeRawRegistryFeedbackEvent(log: { data: Hex; topics: readonly Hex[] },
  maxBytes = 65_536): RawRegistryFeedbackEvent {
  boundedHex(log.data, maxBytes);
  if (log.topics.length !== 4 || !log.topics.every(isHash) || !same(log.topics[0]!, eventTopic)) {
    throw new Error('invalid NewFeedback topics');
  }
  const [agentId] = decodeAbiParameters(agentParameter, log.topics[1]!);
  const [reviewer] = decodeAbiParameters(reviewerParameter, log.topics[2]!);
  const decoded = decodeAbiParameters(eventParameters, log.data);
  if (!same(encodeAbiParameters(agentParameter, [agentId]), log.topics[1]!) ||
    !same(encodeAbiParameters(reviewerParameter, [reviewer]), log.topics[2]!) ||
    !same(encodeAbiParameters(eventParameters, decoded), log.data)) throw new Error('noncanonical event ABI');
  const [feedbackIndex, value, valueDecimals, tag1Bytes, tag2Bytes, endpointBytes, feedbackURIBytes, feedbackHash] = decoded;
  assertReferenceValue(value, valueDecimals);
  if (feedbackIndex === 0n || !same(keccak256(tag1Bytes), log.topics[3]!)) throw new Error('event attribution mismatch');
  return { agentId: agentId.toString(), reviewer: reviewer.toLowerCase() as `0x${string}`,
    feedbackIndex: feedbackIndex.toString(), value: value.toString(), valueDecimals,
    tag1Bytes, tag2Bytes, endpointBytes, feedbackURIBytes, feedbackHash };
}

export function decodeRawRegistryFeedbackStorage(data: Hex, maxBytes = 65_536): RawRegistryFeedbackStorage {
  boundedHex(data, maxBytes);
  const decoded = decodeAbiParameters(storageParameters, data);
  if (!same(encodeAbiParameters(storageParameters, decoded), data)) throw new Error('noncanonical storage ABI');
  const [value, valueDecimals, tag1Bytes, tag2Bytes, isRevoked] = decoded;
  assertReferenceValue(value, valueDecimals);
  return { value: value.toString(), valueDecimals, tag1Bytes, tag2Bytes, isRevoked };
}

export type RegistryObservationLimits = {
  totalTimeoutMs: number; rpcTimeoutMs: number; maxRpcCalls: number;
  maxReceiptLogs: number; maxReceiptBytes: number; maxLogBytes: number;
};
const defaults: RegistryObservationLimits = { totalTimeoutMs: 10_000, rpcTimeoutMs: 2_000, maxRpcCalls: 16,
  maxReceiptLogs: 256, maxReceiptBytes: 1_048_576, maxLogBytes: 65_536 };
const ceilings: RegistryObservationLimits = { totalTimeoutMs: 30_000, rpcTimeoutMs: 10_000, maxRpcCalls: 32,
  maxReceiptLogs: 4_096, maxReceiptBytes: 8_388_608, maxLogBytes: MAX_ABI_BYTES };
type EventReference = Omit<FeedbackPublicationReference, 'feedbackURI'>;
type BlockBasis = { blockNumber: string; blockHash: Hex; blockTimestamp: string };
export type ReadRegistryFeedbackObservationInput = {
  client: PublicClient; domain: FeedbackPublicationDomain; eventRef: EventReference;
  /** Caller-selected numbered AND hash-qualified basis; there is no latest fallback. */
  observation: { blockNumber: bigint; blockHash: Hex };
  limits?: Partial<RegistryObservationLimits>; signal?: AbortSignal;
};
export type RegistryFeedbackObservation = {
  authenticity: 'matched' | 'mismatched' | 'orphaned' | 'unavailable';
  revocation: 'active' | 'revoked' | 'unknown';
  qualification: 'rpc-derived-not-state-proof';
  domain: FeedbackPublicationDomain; eventRef: EventReference;
  observation: { blockNumber: string; blockHash: Hex; blockTimestamp?: string };
  source?: BlockBasis & { transactionHash: Hex; transactionIndex: number; logIndex: number };
  event?: RawRegistryFeedbackEvent & { address: Address };
  storage?: RawRegistryFeedbackStorage & { lastIndex: string };
  /** ABI/version/link checks describe the responding contracts, not implementation provenance. */
  registryDescription?: { identityVersion: string; reputationVersion: string; linkedIdentity: Address };
  diagnostics: string[];
};

class ObservationFailure extends Error {
  constructor(readonly finding: 'mismatched' | 'orphaned' | 'unavailable', readonly code: string,
    readonly stop = false) { super(code); }
}
function mismatch(code: string): never { throw new ObservationFailure('mismatched', code); }
function unavailable(code: string, stop = false): never { throw new ObservationFailure('unavailable', code, stop); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) mismatch('malformed-rpc-object');
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 66 || value.trim() !== value || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    mismatch('malformed-rpc-quantity');
  }
  return BigInt(value);
}
function coordinate(value: unknown): number {
  const integer = quantity(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) mismatch('unsupported-unsafe-coordinate');
  return Number(integer);
}
function checkedHash(value: unknown): Hex {
  if (!isHash(value)) mismatch('malformed-rpc-hash');
  return value;
}
function checkedAddress(value: unknown): Address {
  if (typeof value !== 'string' || value.length !== 42 || !isAddress(value, { strict: false })) mismatch('malformed-rpc-address');
  return value.toLowerCase() as Address;
}
const identityAbi = parseAbi(['function getVersion() view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)']);
const uint64Parameter = parseAbiParameters('uint64');
const bytesParameter = parseAbiParameters('bytes');
const boolParameter = parseAbiParameters('bool');

/**
 * Read-only RPC evidence for ONE slot, not accepted-reviewer coverage or a ranking.
 * PublicClient owns JSON parsing, retries, response-size limits and transport cancellation.
 * These deadlines stop awaiting/starting work; they cannot abort an in-flight PublicClient
 * request. Use a caller-owned bounded transport (including response bytes and retries).
 */
export async function readRegistryFeedbackObservation(input: ReadRegistryFeedbackObservationInput): Promise<RegistryFeedbackObservation> {
  // Copy every caller-controlled authority coordinate before the first await.
  const { client, signal } = input;
  const domain = { ...input.domain };
  const { blockNumber, blockHash, transactionHash, transactionIndex, logIndex } = input.eventRef;
  const eventRef = { blockNumber, blockHash, transactionHash, transactionIndex, logIndex };
  const observation = { ...input.observation };
  const limits = { ...defaults, ...input.limits };
  for (const key of Object.keys(limits) as Array<keyof RegistryObservationLimits>) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ceilings[key]) {
      throw new Error(`invalid registry observation limit: ${key}`);
    }
  }
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 || !isHash(domain.genesisHash) ||
    ![domain.identityRegistry, domain.reputationRegistry].every((a) => typeof a === 'string' && a.length === 42 &&
      isAddress(a, { strict: false }) && !same(a, zeroAddress))) throw new Error('invalid registry observation domain');
  if (typeof observation.blockNumber !== 'bigint' || observation.blockNumber < 0n || observation.blockNumber >= 1n << 256n ||
    !isHash(observation.blockHash)) throw new Error('observation requires an explicit numbered/hash basis');
  if (typeof blockNumber !== 'string' || blockNumber.length > 78 || blockNumber.trim() !== blockNumber || !/^(0|[1-9][0-9]*)$/.test(blockNumber) ||
    BigInt(blockNumber) >= 1n << 256n || !isHash(blockHash) || !isHash(transactionHash) ||
    ![transactionIndex, logIndex].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid event reference coordinate');
  const sourceNumber = BigInt(blockNumber);
  const result: RegistryFeedbackObservation = { authenticity: 'unavailable', revocation: 'unknown',
    qualification: 'rpc-derived-not-state-proof', domain, eventRef,
    observation: { blockNumber: observation.blockNumber.toString(), blockHash: observation.blockHash }, diagnostics: [] };
  const started = performance.now();
  const deadline = started + limits.totalTimeoutMs;
  let calls = 0;
  let stopped = false;
  let sourceRead = false;
  let observationRead = false;
  function work(): void {
    if (signal?.aborted) unavailable('cancelled', true);
    if (performance.now() >= deadline) unavailable('total-timeout', true);
  }
  async function rpc<T>(operation: () => Promise<T>): Promise<T> {
    work();
    if (calls >= limits.maxRpcCalls) unavailable('rpc-call-budget-exceeded', true);
    calls++;
    const callStarted = performance.now();
    const rpcDeadline = callStarted + limits.rpcTimeoutMs;
    const remaining = deadline - callStarted;
    const timeout = Math.min(limits.rpcTimeoutMs, remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await new Promise<T>((resolve, reject) => {
        abort = () => reject(new ObservationFailure('unavailable', 'cancelled', true));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => reject(new ObservationFailure('unavailable',
          remaining <= limits.rpcTimeoutMs ? 'total-timeout' : 'rpc-timeout', true)), timeout);
        // Both handlers remain attached if the deadline wins; no unhandled rejection.
        Promise.resolve().then(() => { work(); return operation(); }).then(resolve, reject);
      });
      // Fulfillment/microtasks can run before an overdue timer after synchronous
      // transport work. Reject that late reply before accepting or starting more I/O.
      work(); // Cancellation, then the total deadline, take precedence.
      if (performance.now() >= rpcDeadline) unavailable('rpc-timeout', true);
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async function block(number: bigint): Promise<BlockBasis> {
    const value = await rpc(() => client.request({ method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false] }));
    if (value === null) unavailable('numbered-block-unavailable');
    const raw = record(value);
    if (quantity(raw.number) !== number) mismatch('block-number-mismatch');
    return { blockNumber: number.toString(), blockHash: checkedHash(raw.hash), blockTimestamp: quantity(raw.timestamp).toString() };
  }
  async function call(address: Address, data: Hex): Promise<Hex> {
    const value = await rpc(() => client.request({ method: 'eth_call',
      params: [{ to: address, data }, `0x${observation.blockNumber.toString(16)}`] }));
    if (typeof value === 'string' && value.length > 2 + limits.maxLogBytes * 2) unavailable('abi-byte-budget-exceeded', true);
    try { boundedHex(value, limits.maxLogBytes); } catch { mismatch('malformed-call-result'); }
    return value;
  }
  function fail(error: unknown): void {
    const failure = error instanceof ObservationFailure ? error : new ObservationFailure('unavailable', 'rpc-unavailable');
    if (result.authenticity !== 'orphaned' || failure.finding === 'orphaned') result.authenticity = failure.finding;
    result.revocation = 'unknown';
    if (!result.diagnostics.includes(failure.code)) result.diagnostics.push(failure.code);
    stopped ||= failure.stop;
  }
  async function read(): Promise<void> {
    if (sourceNumber > observation.blockNumber) mismatch('source-after-observation');
    if (quantity(await rpc(() => client.request({ method: 'eth_chainId' }))) !== BigInt(domain.chainId)) mismatch('chain-id-mismatch');
    if (!same((await block(0n)).blockHash, domain.genesisHash)) mismatch('genesis-hash-mismatch');
    // Check the source first: a changed observation must not hide an independently
    // readable orphan, including replay with both original hashes at the same height.
    const source = await block(sourceNumber);
    if (!same(source.blockHash, blockHash)) throw new ObservationFailure('orphaned', 'source-block-orphaned');
    sourceRead = true;
    const observed = await block(observation.blockNumber);
    if (!same(observed.blockHash, observation.blockHash)) unavailable('observation-basis-changed');
    observationRead = true;
    result.observation = observed;
    const receiptValue = await rpc(() => client.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] }));
    if (receiptValue === null) unavailable('receipt-unavailable');
    const receipt = record(receiptValue);
    if (receipt.status !== '0x1' || !same(checkedHash(receipt.transactionHash), transactionHash) ||
      quantity(receipt.blockNumber) !== sourceNumber || !same(checkedHash(receipt.blockHash), blockHash) ||
      coordinate(receipt.transactionIndex) !== transactionIndex) mismatch('receipt-mismatch');
    // Routed calls are allowed. Neither receipt.from nor receipt.to identifies the storage client.
    checkedAddress(receipt.from);
    if (receipt.to !== null) checkedAddress(receipt.to);
    if (!Array.isArray(receipt.logs)) mismatch('malformed-receipt-logs');
    if (receipt.logs.length > limits.maxReceiptLogs) unavailable('receipt-log-budget-exceeded', true);
    let payloadBytes = 0;
    const selected: Array<Record<string, unknown>> = [];
    for (const entry of receipt.logs) {
      work();
      const log = record(entry);
      if (typeof log.data !== 'string' || !Array.isArray(log.topics)) mismatch('malformed-log-payload');
      if (log.topics.length > 4) mismatch('malformed-log-topics');
      if (log.data.length > 2 + limits.maxLogBytes * 2) unavailable('log-byte-budget-exceeded', true);
      payloadBytes += (log.data.length - 2) / 2 + log.topics.length * 32;
      if (payloadBytes > limits.maxReceiptBytes) unavailable('receipt-byte-budget-exceeded', true);
      if (!log.topics.every(isHash)) mismatch('malformed-log-topics');
      try { boundedHex(log.data, limits.maxLogBytes); } catch { mismatch('malformed-log-data'); }
      if (coordinate(log.logIndex) === logIndex) selected.push(log);
    }
    const log = selected[0];
    if (selected.length !== 1 || !log || log.removed !== false ||
      !same(checkedAddress(log.address), domain.reputationRegistry) || quantity(log.blockNumber) !== sourceNumber ||
      !same(checkedHash(log.blockHash), blockHash) || !same(checkedHash(log.transactionHash), transactionHash) ||
      coordinate(log.transactionIndex) !== transactionIndex) mismatch('event-coordinate-mismatch');
    let event: RawRegistryFeedbackEvent;
    try { event = decodeRawRegistryFeedbackEvent({ data: log.data as Hex, topics: log.topics as Hex[] }, limits.maxLogBytes); }
    catch { mismatch('event-abi-mismatch'); }
    result.source = { ...source, transactionHash, transactionIndex, logIndex };
    result.event = { address: domain.reputationRegistry.toLowerCase() as Address, ...event };
    const reputation = domain.reputationRegistry;
    const linkedRaw = await call(reputation, encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getIdentityRegistry' }));
    let linked: Address;
    try {
      [linked] = decodeAbiParameters(reviewerParameter, linkedRaw);
      if (!same(encodeAbiParameters(reviewerParameter, [linked]), linkedRaw)) mismatch('linked-identity-abi-mismatch');
    } catch { mismatch('linked-identity-abi-mismatch'); }
    if (!same(linked, domain.identityRegistry)) mismatch('linked-identity-mismatch');
    const versionData = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getVersion' });
    const versionBytes = encodeAbiParameters(bytesParameter, ['0x322e302e30']); // literal UTF-8 "2.0.0"
    if (!same(await call(reputation, versionData), versionBytes)) mismatch('reputation-version-mismatch');
    if (!same(await call(domain.identityRegistry, versionData), versionBytes)) mismatch('identity-version-mismatch');
    if (!same(await call(domain.identityRegistry, encodeFunctionData({ abi: identityAbi,
      functionName: 'supportsInterface', args: ['0x80ac58cd'] })), encodeAbiParameters(boolParameter, [true]))) mismatch('identity-interface-mismatch');
    result.registryDescription = { identityVersion: '2.0.0', reputationVersion: REPUTATION_REGISTRY_VERSION,
      linkedIdentity: linked.toLowerCase() as Address };
    const args = [BigInt(event.agentId), event.reviewer] as const;
    const lastRaw = await call(reputation, encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'getLastIndex', args }));
    let lastIndex: bigint;
    try {
      [lastIndex] = decodeAbiParameters(uint64Parameter, lastRaw);
      if (!same(encodeAbiParameters(uint64Parameter, [lastIndex]), lastRaw)) mismatch('stored-index-abi-mismatch');
    } catch { mismatch('stored-index-abi-mismatch'); }
    if (BigInt(event.feedbackIndex) > lastIndex) mismatch('stored-index-mismatch');
    const storedRaw = await call(reputation, encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'readFeedback',
      args: [...args, BigInt(event.feedbackIndex)] }));
    let storage: RawRegistryFeedbackStorage;
    try { storage = decodeRawRegistryFeedbackStorage(storedRaw, limits.maxLogBytes); }
    catch { mismatch('stored-abi-mismatch'); }
    result.storage = { ...storage, lastIndex: lastIndex.toString() };
    if (storage.value !== event.value || storage.valueDecimals !== event.valueDecimals ||
      !same(storage.tag1Bytes, event.tag1Bytes) || !same(storage.tag2Bytes, event.tag2Bytes)) mismatch('stored-projection-mismatch');
    work();
    result.authenticity = 'matched';
    result.revocation = storage.isRevoked ? 'revoked' : 'active';
  }
  try { await read(); } catch (error) { fail(error); }
  // Rechecks also follow failed reads, unless cancellation/deadlines/budgets prohibit
  // further work. An orphaned source remains orphaned even if the second check fails.
  if (sourceRead && !stopped) {
    try {
      if (!same((await block(sourceNumber)).blockHash, blockHash)) throw new ObservationFailure('orphaned', 'source-block-orphaned');
    } catch (error) { fail(error); }
  }
  if (observationRead && !stopped) {
    try {
      if (!same((await block(observation.blockNumber)).blockHash, observation.blockHash)) unavailable('observation-basis-changed');
    } catch (error) { fail(error); }
  }
  try { work(); } catch (error) { fail(error); }
  return result;
}
