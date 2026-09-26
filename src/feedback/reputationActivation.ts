import { isDeepStrictEqual } from 'node:util';
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, getContractAddress,
  isAddress, keccak256, numberToHex, parseAbi, parseAbiParameters, toEventSelector,
  zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { compileReferenceContracts, type ReferenceProvenance } from '../demo/contracts.js';
import { IMPLEMENTATION_SLOT } from '../identity/continuity.js';
import type { FeedbackPublicationDomain } from './publication.js';

export type DeploymentTransaction = {
  transactionHash: Hex; blockNumber: string; blockHash: Hex; transactionIndex: number;
};
export type DirectCreation = DeploymentTransaction & { address: Address; nonce: string; runtimeCodeHash: Hex };
/** Trusted deployment configuration, never a writer-supplied successful finding. */
export type ReputationDeploymentProvenance = {
  domain: FeedbackPublicationDomain; deployer: Address; artifacts: ReferenceProvenance;
  bootstrap: DirectCreation; proxy: DirectCreation; implementation: DirectCreation;
  activation: DeploymentTransaction & { upgradedLogIndex: number };
};
export type ReputationActivationLimits = {
  totalTimeoutMs: number; rpcTimeoutMs: number; maxBlocks: number; maxRpcCalls: number;
  maxUpgradeLogs: number; maxReceiptLogs: number; maxReceiptBytes: number; maxLogBytes: number;
  maxInputBytes: number; maxCodeBytes: number; maxCallBytes: number; maxTotalPayloadBytes: number;
};
const ceilings: ReputationActivationLimits = { totalTimeoutMs: 60_000, rpcTimeoutMs: 5_000,
  maxBlocks: 4096, maxRpcCalls: 256, maxUpgradeLogs: 64, maxReceiptLogs: 1024,
  maxReceiptBytes: 2_097_152, maxLogBytes: 65_536, maxInputBytes: 65_536,
  maxCodeBytes: 32_768, maxCallBytes: 1024, maxTotalPayloadBytes: 8_388_608 };
const defaults: ReputationActivationLimits = { ...ceilings, totalTimeoutMs: 30_000,
  maxRpcCalls: 128, maxReceiptLogs: 256, maxReceiptBytes: 1_048_576 };
export type ReadReputationActivationInput = {
  client: PublicClient; provenance: ReputationDeploymentProvenance;
  observation: { blockNumber: bigint; blockHash: Hex };
  limits?: Partial<ReputationActivationLimits>; signal?: AbortSignal;
};
export type ReputationActivationObservation = {
  activation: 'matched' | 'mismatched' | 'unsupported' | 'unavailable';
  qualification: 'rpc-derived-not-state-proof'; domain: FeedbackPublicationDomain;
  observation: { blockNumber: string; blockHash: Hex; blockTimestamp?: string };
  knownDeployment?: {
    implementation: { address: Address; runtimeCodeHash: Hex };
    activation: DeploymentTransaction & { upgradedLogIndex: number; initializedLogIndex: number };
  };
  assumptions: ['configured-deployment-pins', 'configured-rpc-complete-upgrade-logs'];
  diagnostics: string[];
};

const abi = parseAbi(['function initialize(address identityRegistry)',
  'function upgradeToAndCall(address implementation, bytes data) payable',
  'function getVersion() view returns (string)', 'function getIdentityRegistry() view returns (address)']);
const upgradedTopic = toEventSelector('Upgraded(address)');
const initializedTopic = toEventSelector('Initialized(uint64)');
const feedbackTopic = toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');
const addressParameter = parseAbiParameters('address');
const versionResult = encodeAbiParameters(parseAbiParameters('bytes'), ['0x322e302e30']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (v: unknown): v is Hex => typeof v === 'string' && v.length === 66 && /^0x[0-9a-f]{64}$/i.test(v);
const address = (v: unknown): v is Address => typeof v === 'string' && v.length === 42 && isAddress(v, { strict: false });
const uint = (v: unknown): v is string => typeof v === 'string' && v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 1n << 256n;
const index = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const transaction = (v: DeploymentTransaction) => hash(v.transactionHash) && uint(v.blockNumber) && hash(v.blockHash) && index(v.transactionIndex);

function copyProvenance(p: ReputationDeploymentProvenance): ReputationDeploymentProvenance {
  function map(value: Record<string, string>): Record<string, string> {
    const keys = Object.keys(value);
    if (keys.length > 16 || keys.some((key) => key.length > 256 || typeof value[key] !== 'string' || value[key]!.length > 256)) {
      throw new Error('invalid artifact provenance map');
    }
    return Object.fromEntries(keys.map((key) => [key, value[key]!]));
  }
  const a = p.artifacts;
  if (![a.referenceCommit, a.solcVersion, a.solcTmpVersion, a.openZeppelinVersion].every((v) => typeof v === 'string' && v.length <= 256)) {
    throw new Error('invalid artifact provenance');
  }
  return { domain: { ...p.domain }, deployer: p.deployer,
    artifacts: { referenceCommit: a.referenceCommit, solcVersion: a.solcVersion,
      solcTmpVersion: a.solcTmpVersion, openZeppelinVersion: a.openZeppelinVersion,
      compilerSettings: { evmVersion: a.compilerSettings.evmVersion, viaIR: a.compilerSettings.viaIR,
        optimizer: { ...a.compilerSettings.optimizer } }, sourceSha256: map(a.sourceSha256), artifactSha256: map(a.artifactSha256) },
    bootstrap: { ...p.bootstrap }, proxy: { ...p.proxy }, implementation: { ...p.implementation }, activation: { ...p.activation } };
}
type Finding = Exclude<ReputationActivationObservation['activation'], 'matched'>;
class Failure extends Error {
  constructor(readonly finding: Finding, readonly code: string, readonly stop = false) { super(code); }
}
function mismatch(code: string): never { throw new Failure('mismatched', code); }
function unavailable(code: string, stop = false): never { throw new Failure('unavailable', code, stop); }
function unsupported(code: string): never { throw new Failure('unsupported', code); }
function object(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) mismatch('malformed-rpc-object');
  return v as Record<string, unknown>;
}
function quantity(v: unknown): bigint {
  if (typeof v !== 'string' || v.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v)) mismatch('malformed-rpc-quantity');
  return BigInt(v);
}
function coordinate(v: unknown): number {
  const n = quantity(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) mismatch('unsafe-rpc-coordinate');
  return Number(n);
}
function checkedHash(v: unknown): Hex { if (!hash(v)) mismatch('malformed-rpc-hash'); return v; }
function checkedAddress(v: unknown): Address { if (!address(v)) mismatch('malformed-rpc-address'); return v.toLowerCase() as Address; }
type Log = DeploymentTransaction & { address: Address; logIndex: number; topics: Hex[]; data: Hex };
type BlockBasis = { blockNumber: string; blockHash: Hex; blockTimestamp: string };
const position = (v: DeploymentTransaction): [bigint, number] => [BigInt(v.blockNumber), v.transactionIndex];
function before(a: DeploymentTransaction, b: DeploymentTransaction): boolean {
  const [an, ai] = position(a), [bn, bi] = position(b);
  return an < bn || (an === bn && ai < bi);
}
function sameLog(a: Log, b: Log): boolean {
  return a.blockNumber === b.blockNumber && a.transactionIndex === b.transactionIndex && a.logIndex === b.logIndex &&
    same(a.blockHash, b.blockHash) && same(a.transactionHash, b.transactionHash) && same(a.address, b.address) &&
    same(a.data, b.data) && a.topics.length === b.topics.length && a.topics.every((t, i) => same(t, b.topics[i]!));
}

/**
 * Fixed reference-deployment qualification, not coverage or a state/log proof.
 * The caller owns whole-response byte limits, JSON parsing and transport aborts.
 * No reader retries. Deadlines stop awaiting/starting work, but cannot preempt
 * synchronous pinned compilation or abort an in-flight PublicClient request.
 */
export async function readReputationActivation(input: ReadReputationActivationInput): Promise<ReputationActivationObservation> {
  const started = performance.now();
  const request = input.client.request.bind(input.client), signal = input.signal;
  const p = copyProvenance(input.provenance), observation = { ...input.observation };
  const limits = { ...defaults, ...input.limits };
  for (const key of Object.keys(limits) as Array<keyof ReputationActivationLimits>) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ceilings[key]) {
      throw new Error(`invalid reputation activation limit: ${key}`);
    }
  }
  const d = p.domain;
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0 || !hash(d.genesisHash) ||
    ![d.identityRegistry, d.reputationRegistry, p.deployer].every((v) => address(v) && !same(v, zeroAddress)) ||
    ![p.bootstrap, p.proxy, p.implementation].every((c) => transaction(c) && address(c.address) && !same(c.address, zeroAddress) && uint(c.nonce) && hash(c.runtimeCodeHash)) ||
    !transaction(p.activation) || !index(p.activation.upgradedLogIndex) || typeof observation.blockNumber !== 'bigint' ||
    observation.blockNumber < 0n || observation.blockNumber >= 1n << 256n || !hash(observation.blockHash)) throw new Error('invalid reputation activation configuration');
  const result: ReputationActivationObservation = { activation: 'unavailable', qualification: 'rpc-derived-not-state-proof',
    domain: d, observation: { blockNumber: observation.blockNumber.toString(), blockHash: observation.blockHash },
    assumptions: ['configured-deployment-pins', 'configured-rpc-complete-upgrade-logs'], diagnostics: [] };
  const deadline = started + limits.totalTimeoutMs;
  const blocks = new Map<bigint, { expected: Hex; header?: BlockBasis }>();
  let calls = 0, totalPayload = 0, stopped = false, unavailableObserved = false;
  function work(): void {
    if (signal?.aborted) unavailable('cancelled', true);
    if (performance.now() >= deadline) unavailable('total-timeout', true);
  }
  function bytes(value: unknown, maximum: number, name: string): Hex {
    work();
    if (typeof value !== 'string') mismatch(`malformed-${name}`);
    if (value.length > 2 + maximum * 2) unavailable(`${name}-byte-budget-exceeded`, true);
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(value)) mismatch(`malformed-${name}`);
    totalPayload += (value.length - 2) / 2;
    if (totalPayload > limits.maxTotalPayloadBytes) unavailable('total-payload-budget-exceeded', true);
    return value as Hex;
  }
  async function rpc(method: string, params?: readonly unknown[]): Promise<unknown> {
    work();
    if (calls >= limits.maxRpcCalls) unavailable('rpc-call-budget-exceeded', true);
    calls++;
    const now = performance.now(), rpcDeadline = now + limits.rpcTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Failure('unavailable', 'cancelled', true));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => reject(new Failure('unavailable',
          deadline <= rpcDeadline ? 'total-timeout' : 'rpc-timeout', true)), Math.min(deadline, rpcDeadline) - now);
        Promise.resolve().then(() => { work(); return request({ method, ...(params ? { params } : {}) } as
          Parameters<PublicClient['request']>[0], { retryCount: 0 }); }).then(resolve, reject);
      });
      work();
      if (performance.now() >= rpcDeadline) unavailable('rpc-timeout', true);
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async function block(n: bigint): Promise<BlockBasis> {
    const value = await rpc('eth_getBlockByNumber', [numberToHex(n), false]);
    if (value === null) unavailable('numbered-block-unavailable');
    const raw = object(value);
    if (quantity(raw.number) !== n) mismatch('block-number-mismatch');
    return { blockNumber: n.toString(), blockHash: checkedHash(raw.hash), blockTimestamp: quantity(raw.timestamp).toString() };
  }
  async function basis(n: bigint, expected: Hex): Promise<BlockBasis> {
    const previous = blocks.get(n);
    if (previous !== undefined && !same(previous.expected, expected)) unavailable('canonicality-conflicting-bases');
    // Save even a failed basis so the final check cannot silently erase the gap.
    const entry = previous ?? { expected };
    blocks.set(n, entry);
    if (!entry.header) {
      const header = await block(n);
      if (!same(header.blockHash, expected)) unavailable('canonicality-changed');
      entry.header = header;
    }
    return entry.header;
  }
  function rawLog(value: unknown): Log {
    const raw = object(value);
    if (!Array.isArray(raw.topics) || raw.topics.length > 4 || raw.removed !== false) mismatch('malformed-log');
    const topics = raw.topics.map((t) => checkedHash(bytes(t, 32, 'topic')));
    return { address: checkedAddress(raw.address), transactionHash: checkedHash(raw.transactionHash),
      blockNumber: quantity(raw.blockNumber).toString(), blockHash: checkedHash(raw.blockHash),
      transactionIndex: coordinate(raw.transactionIndex), logIndex: coordinate(raw.logIndex),
      data: bytes(raw.data, limits.maxLogBytes, 'log'), topics };
  }
  async function authenticate(ref: DeploymentTransaction, creation: DirectCreation | undefined, expectedInput: Hex): Promise<Log[]> {
    await basis(BigInt(ref.blockNumber), ref.blockHash);
    const txValue = await rpc('eth_getTransactionByHash', [ref.transactionHash]);
    if (txValue === null) unavailable('transaction-unavailable');
    const tx = object(txValue);
    if (!same(checkedHash(tx.hash), ref.transactionHash) || quantity(tx.blockNumber) !== BigInt(ref.blockNumber) ||
      !same(checkedHash(tx.blockHash), ref.blockHash) || coordinate(tx.transactionIndex) !== ref.transactionIndex ||
      !same(checkedAddress(tx.from), p.deployer) || quantity(tx.value) !== 0n) mismatch('transaction-mismatch');
    const nonce = quantity(tx.nonce);
    if (creation) {
      if (tx.to !== null || nonce !== BigInt(creation.nonce) || !same(getContractAddress({ from: p.deployer, nonce }), creation.address)) mismatch('creation-address-mismatch');
    } else if (!same(checkedAddress(tx.to), d.reputationRegistry)) mismatch('activation-destination-mismatch');
    if (!same(bytes(tx.input, limits.maxInputBytes, 'input'), expectedInput)) mismatch('transaction-input-mismatch');
    const receiptValue = await rpc('eth_getTransactionReceipt', [ref.transactionHash]);
    if (receiptValue === null) unavailable('receipt-unavailable');
    const receipt = object(receiptValue);
    if (receipt.status !== '0x1' || !same(checkedHash(receipt.transactionHash), ref.transactionHash) ||
      quantity(receipt.blockNumber) !== BigInt(ref.blockNumber) || !same(checkedHash(receipt.blockHash), ref.blockHash) ||
      coordinate(receipt.transactionIndex) !== ref.transactionIndex || !same(checkedAddress(receipt.from), p.deployer) ||
      (creation ? receipt.to !== null || !same(checkedAddress(receipt.contractAddress), creation.address) :
        !same(checkedAddress(receipt.to), d.reputationRegistry) || receipt.contractAddress !== null)) mismatch('receipt-mismatch');
    if (!Array.isArray(receipt.logs)) mismatch('malformed-receipt-logs');
    if (receipt.logs.length > limits.maxReceiptLogs) unavailable('receipt-log-budget-exceeded', true);
    let payload = 0, previous = -1;
    return receipt.logs.map((value) => {
      const raw = object(value);
      if (typeof raw.data !== 'string' || !Array.isArray(raw.topics)) mismatch('malformed-log');
      payload += Math.max(0, (raw.data.length - 2) / 2) + raw.topics.length * 32;
      if (payload > limits.maxReceiptBytes) unavailable('receipt-byte-budget-exceeded', true);
      const log = rawLog(raw);
      if (log.blockNumber !== ref.blockNumber || !same(log.blockHash, ref.blockHash) || !same(log.transactionHash, ref.transactionHash) ||
        log.transactionIndex !== ref.transactionIndex || log.logIndex <= previous) mismatch('receipt-log-coordinate-mismatch');
      previous = log.logIndex;
      return log;
    });
  }
  function upgrade(log: Log, implementation: Address): boolean {
    return same(log.address, d.reputationRegistry) && log.topics.length === 2 && same(log.topics[0]!, upgradedTopic) &&
      same(log.topics[1]!, encodeAbiParameters(addressParameter, [implementation])) && log.data === '0x';
  }
  function receiptUpgrade(logs: Log[], implementation: Address, version: bigint, expectedIndex?: number): { upgraded: Log; initialized: Log } {
    const own = logs.filter((log) => same(log.address, d.reputationRegistry));
    const upgrades = own.filter((log) => same(log.topics[0] ?? '', upgradedTopic));
    const initializations = own.filter((log) => same(log.topics[0] ?? '', initializedTopic));
    const up = upgrades[0], init = initializations[0];
    if (upgrades.length !== 1 || !up || !upgrade(up, implementation) ||
      (expectedIndex !== undefined && up.logIndex !== expectedIndex)) mismatch('activation-upgrade-mismatch');
    if (initializations.length !== 1 || !init || init.topics.length !== 1 || init.logIndex <= up.logIndex ||
      !same(init.data, encodeAbiParameters(parseAbiParameters('uint64'), [version]))) mismatch('initializer-event-mismatch');
    if (own.some((log) => same(log.topics[0] ?? '', feedbackTopic))) mismatch('feedback-inside-activation');
    return { upgraded: up, initialized: init };
  }
  async function code(address: Address, n: bigint, expectedHash: Hex, template?: Hex): Promise<void> {
    const value = bytes(await rpc('eth_getCode', [address, numberToHex(n)]), limits.maxCodeBytes, 'code');
    if (value === '0x' || !same(keccak256(value), expectedHash) || (template !== undefined && !same(value, template))) unsupported('runtime-code-mismatch');
  }
  async function knownAt(n: bigint, proxyTemplate: Hex): Promise<void> {
    await code(d.reputationRegistry, n, p.proxy.runtimeCodeHash, proxyTemplate);
    const slot = bytes(await rpc('eth_getStorageAt', [d.reputationRegistry, IMPLEMENTATION_SLOT, numberToHex(n)]), 32, 'slot');
    if (!same(slot, encodeAbiParameters(addressParameter, [p.implementation.address]))) unsupported('implementation-slot-mismatch');
    await code(p.implementation.address, n, p.implementation.runtimeCodeHash);
    const call = async (data: Hex) => bytes(await rpc('eth_call', [{ to: d.reputationRegistry, data }, numberToHex(n)]), limits.maxCallBytes, 'call');
    if (!same(await call(encodeFunctionData({ abi, functionName: 'getVersion' })), versionResult)) mismatch('reputation-version-mismatch');
    if (!same(await call(encodeFunctionData({ abi, functionName: 'getIdentityRegistry' })),
      encodeAbiParameters(addressParameter, [d.identityRegistry]))) mismatch('identity-link-mismatch');
  }
  function fail(error: unknown): void {
    const failure = error instanceof Failure ? error : new Failure('unavailable', 'rpc-unavailable');
    // The initial unavailable default is not a finding. Once a real gap occurs,
    // subsequent contradictory replies may add diagnostics but cannot erase it.
    unavailableObserved ||= failure.finding === 'unavailable';
    result.activation = unavailableObserved ? 'unavailable' : failure.finding;
    delete result.knownDeployment;
    if (!result.diagnostics.includes(failure.code)) result.diagnostics.push(failure.code);
    stopped ||= failure.stop;
  }
  async function read(): Promise<void> {
    work();
    if (!same(p.proxy.address, d.reputationRegistry) || new Set([p.bootstrap.address, p.proxy.address, p.implementation.address].map((a) => a.toLowerCase())).size !== 3 ||
      !before(p.bootstrap, p.proxy) || !before(p.proxy, p.implementation) || !before(p.implementation, p.activation) ||
      BigInt(p.activation.blockNumber) > observation.blockNumber) mismatch('deployment-causal-order-mismatch');
    if (observation.blockNumber - BigInt(p.proxy.blockNumber) + 1n > BigInt(limits.maxBlocks)) unavailable('block-span-budget-exceeded', true);
    let artifacts;
    try { artifacts = compileReferenceContracts(); } catch { work(); unsupported('reference-artifacts-unavailable'); }
    work();
    if (!isDeepStrictEqual(p.artifacts, artifacts.provenance)) unsupported('reference-artifacts-mismatch');
    if (quantity(await rpc('eth_chainId')) !== BigInt(d.chainId)) mismatch('chain-id-mismatch');
    await basis(0n, d.genesisHash);
    const observed = await basis(observation.blockNumber, observation.blockHash);
    result.observation = { ...result.observation, blockTimestamp: observed.blockTimestamp };
    const initialize = encodeFunctionData({ abi, functionName: 'initialize', args: [d.identityRegistry] });
    await authenticate(p.bootstrap, p.bootstrap, encodeDeployData({ abi: artifacts.minimalUups.abi, bytecode: artifacts.minimalUups.bytecode }));
    const proxyLogs = await authenticate(p.proxy, p.proxy, encodeDeployData({ abi: artifacts.erc1967Proxy.abi,
      bytecode: artifacts.erc1967Proxy.bytecode, args: [p.bootstrap.address, initialize] }));
    await authenticate(p.implementation, p.implementation, encodeDeployData({ abi: artifacts.reputationRegistry.abi, bytecode: artifacts.reputationRegistry.bytecode }));
    const activationLogs = await authenticate(p.activation, undefined, encodeFunctionData({ abi, functionName: 'upgradeToAndCall', args: [p.implementation.address, initialize] }));
    const constructor = receiptUpgrade(proxyLogs, p.bootstrap.address, 1n);
    const activation = receiptUpgrade(activationLogs, p.implementation.address, 2n, p.activation.upgradedLogIndex);
    await code(p.bootstrap.address, BigInt(p.bootstrap.blockNumber), p.bootstrap.runtimeCodeHash);
    await code(p.bootstrap.address, BigInt(p.proxy.blockNumber), p.bootstrap.runtimeCodeHash);
    await code(p.implementation.address, BigInt(p.implementation.blockNumber), p.implementation.runtimeCodeHash);
    await code(p.proxy.address, BigInt(p.proxy.blockNumber), p.proxy.runtimeCodeHash, artifacts.erc1967Proxy.deployedBytecode);
    await knownAt(BigInt(p.activation.blockNumber), artifacts.erc1967Proxy.deployedBytecode);
    if (observation.blockNumber !== BigInt(p.activation.blockNumber)) await knownAt(observation.blockNumber, artifacts.erc1967Proxy.deployedBytecode);
    const expected = [constructor.upgraded, activation.upgraded];
    const seen = new Set<number>();
    let count = 0;
    for (let start = BigInt(p.proxy.blockNumber); start <= observation.blockNumber; start += 64n) {
      const end = start + 63n < observation.blockNumber ? start + 63n : observation.blockNumber;
      const response = await rpc('eth_getLogs', [{ address: d.reputationRegistry, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics: [upgradedTopic] }]);
      if (!Array.isArray(response)) mismatch('malformed-upgrade-logs');
      if ((count += response.length) > limits.maxUpgradeLogs) unavailable('upgrade-log-budget-exceeded', true);
      for (const entry of response) {
        const log = rawLog(entry), number = BigInt(log.blockNumber);
        if (number < start || number > end || !same(log.address, d.reputationRegistry) || log.topics.length !== 2 ||
          !same(log.topics[0]!, upgradedTopic) || log.data !== '0x' || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1]!)) mismatch('malformed-upgrade-log');
        await basis(number, log.blockHash);
        const match = expected.findIndex((allowed) => sameLog(log, allowed));
        if (match === -1) mismatch('unexpected-upgrade');
        if (seen.has(match)) mismatch('duplicate-upgrade');
        seen.add(match);
      }
    }
    if (seen.size !== 2) mismatch('missing-upgrade-log');
    result.activation = 'matched';
    result.knownDeployment = { implementation: { address: p.implementation.address.toLowerCase() as Address,
      runtimeCodeHash: p.implementation.runtimeCodeHash }, activation: { ...p.activation, initializedLogIndex: activation.initialized.logIndex } };
  }
  try { await read(); } catch (error) { fail(error); }
  if (!stopped) {
    for (const [number, { expected }] of blocks) {
      try { if (!same((await block(number)).blockHash, expected)) unavailable('canonicality-changed'); }
      catch (error) { fail(error); if (stopped) break; }
    }
  }
  try { work(); } catch (error) { fail(error); }
  return result;
}
