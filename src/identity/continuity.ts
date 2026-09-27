import { decodeEventLog, encodeEventTopics, encodeFunctionData, isAddress, keccak256,
  numberToHex, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { decodeRegistration } from './profile.js';
import { decodeStrictRawString } from './rawAbi.js';
import type { AgentRef, AuthoritySnapshot } from './verify.js';

/** Locked OpenZeppelin 5.4 ERC1967Utils implementation slot. */
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export type IdentityContinuityDomain = {
  chainId: number; registry: Address; genesisHash: Hex;
  /** Must come from configured deployment provenance, never candidate/TOFU reads. */
  knownImplementation: { address: Address; codeHash: Hex };
};
export type IdentityContinuity = {
  status: 'unchanged' | 'changed' | 'unknown'; reason: string;
  basisBlockHash: Hex; currentBlockHash: Hex;
};
export type IdentityFeedbackEpoch = {
  epoch: 'same' | 'retired' | 'unknown';
  qualification: 'rpc-derived-not-state-proof';
  basis: { blockNumber: string; blockHash: Hex };
  observation: { blockNumber: string; blockHash: Hex };
  diagnostics: string[];
  firstBreak?: { blockNumber: string; transactionIndex: number; logIndex: number;
    kind: 'transfer' | 'runtime-replaced' | 'deauthorized' };
};
export const continuityLimits = { maxBlocks: 4096, maxLogs: 1024 } as const;

const events = parseAbi([
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Upgraded(address indexed implementation)',
]);
const boundaryFunctions = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const quantity = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const uint = (value: string) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const sameAgent = (a: AgentRef, b: AgentRef) => a.chainId === b.chainId &&
  a.registry.toLowerCase() === b.registry.toLowerCase() && a.agentId === b.agentId;

type BoundedRead = <T>(read: () => Promise<T>) => Promise<T>;
type CheckedEvent = {
  kind: 'uri' | 'transfer' | 'upgrade'; blockNumber: bigint; blockHash: Hex;
  transactionIndex: number; logIndex: number; data: Hex; decoded: { eventName: string; args: Record<string, unknown> };
};
type CheckedInterval = { events: CheckedEvent[]; blocks: Map<bigint, Hex>; currentKnown: boolean; failure?: string };

function makeBoundedRead(signal: AbortSignal | undefined, totalMs: number, label: string): BoundedRead {
  const deadline = Date.now() + totalMs;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(`${label} total deadline exceeded`);
  };
  return async <T>(read: () => Promise<T>): Promise<T> => {
    check();
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error(`${label} cancelled`));
        signal?.addEventListener('abort', abort, { once: true });
      });
      const value = await Promise.race([read(), cancelled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} RPC deadline exceeded`)), Math.min(remaining, 5000));
      })]);
      check();
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  };
}

async function collectCheckedInterval(client: PublicClient, input: {
  domain: IdentityContinuityDomain; agent: AgentRef; from: bigint; to: bigint;
  expectedBasisHash: Hex; expectedObservationHash: Hex;
  limits: { maxBlocks: number; maxLogs: number }; maxRawLogBytes: number; bounded: BoundedRead;
}): Promise<CheckedInterval> {
  const { domain, agent, from, to, limits, bounded } = input;
  if (from > to || to - from > BigInt(limits.maxBlocks)) throw new Error('continuity range exceeds bounds');
  if (await bounded(() => client.getChainId()) !== domain.chainId) throw new Error('chain ID mismatch');
  const numbered = async (number: bigint) => {
    const block = await bounded(() => client.getBlock({ blockNumber: number }));
    if (block.number !== number || !hash(block.hash)) throw new Error('missing numbered block');
    return block.hash;
  };
  if (await numbered(0n) !== domain.genesisHash) throw new Error('genesis mismatch');
  const blocks = new Map<bigint, Hex>();
  for (const [number, expected] of [[from, input.expectedBasisHash], [to, input.expectedObservationHash]] as const) {
    const canonical = blocks.get(number) ?? await numbered(number);
    if (canonical !== expected) throw new Error('snapshot canonical hash mismatch');
    blocks.set(number, canonical);
  }
  async function knownAt(blockNumber: bigint): Promise<boolean> {
    const slot = await bounded(() => client.getStorageAt({ address: domain.registry,
      slot: IMPLEMENTATION_SLOT, blockNumber }));
    if (!slot || !/^0x0{24}[0-9a-fA-F]{40}$/.test(slot) ||
        slot.slice(-40).toLowerCase() !== domain.knownImplementation.address.slice(2).toLowerCase()) return false;
    const code = await bounded(() => client.getCode({ address: domain.knownImplementation.address, blockNumber }));
    return !!code && code !== '0x' && keccak256(code) === domain.knownImplementation.codeHash;
  }
  if (!await knownAt(from)) throw new Error('unknown implementation at basis');
  const currentKnown = from === to ? true : await knownAt(to);
  const filters = [
    encodeEventTopics({ abi: events, eventName: 'URIUpdated', args: { agentId: BigInt(agent.agentId) } }),
    encodeEventTopics({ abi: events, eventName: 'Transfer', args: { tokenId: BigInt(agent.agentId) } }),
    encodeEventTopics({ abi: events, eventName: 'Upgraded' }),
  ];
  const found: CheckedEvent[] = [];
  const coordinates = new Set<string>();
  let count = 0;
  let failure: string | undefined;
  try {
    // Explicit sequential chunks: a rejected/missing chunk cannot become an empty result.
    for (let start = from + 1n; start <= to; start += 64n) {
      const end = start + 63n < to ? start + 63n : to;
      for (let i = 0; i < filters.length; i++) {
        const topics = filters[i]!;
        const response = await bounded(() => client.request({ method: 'eth_getLogs', params: [{
          address: domain.registry, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics,
        }] }));
        if (!Array.isArray(response) || (count += response.length) > limits.maxLogs) throw new Error('log limit or malformed chunk');
        for (const raw of response) {
          const log = raw as Record<string, unknown>;
          const logTopics = log?.topics;
          if (!log || log.removed !== false || typeof log.address !== 'string' ||
              log.address.toLowerCase() !== domain.registry.toLowerCase() ||
              !quantity(log.blockNumber) || !quantity(log.transactionIndex) || !quantity(log.logIndex) ||
              BigInt(log.transactionIndex) > BigInt(Number.MAX_SAFE_INTEGER) ||
              BigInt(log.logIndex) > BigInt(Number.MAX_SAFE_INTEGER) ||
              !hash(log.blockHash) || !hash(log.transactionHash) || !Array.isArray(logTopics) ||
              logTopics.length !== (i === 0 ? 3 : i === 1 ? 4 : 2) || !logTopics.every(hash) ||
              !topics.every((topic, index) => topic === null || topic === logTopics[index]) ||
              typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) {
            throw new Error('malformed or out-of-filter log');
          }
          if ((log.data.length - 2) / 2 > input.maxRawLogBytes) throw new Error('raw log ABI exceeds byte bound');
          const blockNumber = BigInt(log.blockNumber);
          if (blockNumber < start || blockNumber > end) throw new Error('log outside requested chunk');
          const transactionIndex = Number(BigInt(log.transactionIndex));
          const logIndex = Number(BigInt(log.logIndex));
          const key = `${blockNumber}:${logIndex}`;
          if (coordinates.has(key)) throw new Error('duplicate log coordinates');
          coordinates.add(key);
          const canonical = blocks.get(blockNumber) ?? await numbered(blockNumber);
          blocks.set(blockNumber, canonical);
          if (canonical !== log.blockHash) throw new Error('noncanonical log hash');
          const decoded = decodeEventLog({ abi: events, data: log.data as Hex,
            topics: logTopics as [Hex, ...Hex[]], strict: true }) as unknown as CheckedEvent['decoded'];
          found.push({ kind: i === 0 ? 'uri' : i === 1 ? 'transfer' : 'upgrade', blockNumber,
            blockHash: log.blockHash, transactionIndex, logIndex, data: log.data as Hex, decoded });
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : 'continuity interval scan failed';
  }
  found.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 :
    a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  return { events: found, blocks, currentKnown, ...(failure ? { failure } : {}) };
}

async function recheckBlocks(client: PublicClient, blocks: Map<bigint, Hex>, bounded: BoundedRead, label: string): Promise<void> {
  for (const [number, expected] of blocks) {
    const block = await bounded(() => client.getBlock({ blockNumber: number }));
    if (block.number !== number || block.hash !== expected) throw new Error(`reorganization during ${label}`);
  }
}

/**
 * Bounded RPC-derived continuity for the configured reference implementation.
 * Empty results assume the selected RPC returns ALL matching logs; no state/log
 * proof is supplied. Use a response-size-bounded transport. Any explicit gap,
 * malformed response, limit or canonicality failure is unknown, never absence.
 */
export async function readIdentityContinuity(client: PublicClient, input: {
  domain: IdentityContinuityDomain; agent: AgentRef;
  basis: AuthoritySnapshot; current: AuthoritySnapshot;
  limits: { maxBlocks: number; maxLogs: number };
}): Promise<IdentityContinuity> {
  const { domain, agent, basis, current, limits } = input;
  const result = (status: IdentityContinuity['status'], reason: string): IdentityContinuity =>
    ({ status, reason, basisBlockHash: basis.blockHash, currentBlockHash: current.blockHash });
  const bounded = makeBoundedRead(undefined, 10_000, 'continuity');
  try {
    if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 ||
        !isAddress(domain.registry) || !hash(domain.genesisHash) ||
        !isAddress(domain.knownImplementation.address) || !hash(domain.knownImplementation.codeHash) ||
        !uint(agent.agentId) || !sameAgent(agent, basis.agent) || !sameAgent(agent, current.agent) ||
        agent.chainId !== domain.chainId || agent.registry.toLowerCase() !== domain.registry.toLowerCase() ||
        !uint(basis.blockNumber) || !uint(current.blockNumber) ||
        !hash(basis.blockHash) || !hash(current.blockHash) ||
        !Number.isSafeInteger(limits.maxBlocks) || limits.maxBlocks < 1 || limits.maxBlocks > continuityLimits.maxBlocks ||
        !Number.isSafeInteger(limits.maxLogs) || limits.maxLogs < 1 || limits.maxLogs > continuityLimits.maxLogs) {
      throw new Error('invalid continuity domain, subject, snapshot or limits');
    }
    const from = BigInt(basis.blockNumber), to = BigInt(current.blockNumber);
    const interval = await collectCheckedInterval(client, { domain, agent, from, to,
      expectedBasisHash: basis.blockHash, expectedObservationHash: current.blockHash,
      limits, maxRawLogBytes: 69_999, bounded });
    if (interval.failure) throw new Error(interval.failure);
    // Preserve the legacy reader's boundary-only final bracket.
    await recheckBlocks(client, new Map([[from, basis.blockHash], [to, current.blockHash]]), bounded, 'continuity read');
    const upgraded = interval.events.some((event) => event.kind === 'upgrade');
    if (!interval.currentKnown && !upgraded) throw new Error('unknown current implementation without canonical upgrade evidence');
    if (interval.events.length || basis.agentOwner.toLowerCase() !== current.agentOwner.toLowerCase() ||
        basis.agentURI !== current.agentURI) {
      return result('changed', 'subject URI/transfer, registry upgrade, or endpoint authority changed');
    }
    return result('unchanged', 'canonical bounded interval has no authority changes, assuming complete RPC logs');
  } catch (error) {
    return result('unknown', error instanceof Error ? error.message : 'continuity read failed');
  }
}

async function readGuardedBoundarySnapshot(client: PublicClient, input: {
  agent: AgentRef; expected: { blockNumber: bigint; blockHash: Hex }; bounded: BoundedRead;
}): Promise<AuthoritySnapshot> {
  const { agent, expected, bounded } = input;
  const header = await bounded(() => client.getBlock({ blockNumber: expected.blockNumber }));
  if (header.number !== expected.blockNumber || header.hash !== expected.blockHash) {
    throw new Error('feedback epoch boundary snapshot mismatch');
  }
  const blockTimestamp = Number(header.timestamp);
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) {
    throw new Error('feedback epoch boundary timestamp is outside the supported range');
  }
  const block = numberToHex(expected.blockNumber);
  const tokenId = BigInt(agent.agentId);
  const [ownerRaw, uriRaw] = await Promise.all([
    bounded(() => client.request({ method: 'eth_call', params: [{ to: agent.registry,
      data: encodeFunctionData({ abi: boundaryFunctions, functionName: 'ownerOf', args: [tokenId] }) }, block] })),
    bounded(() => client.request({ method: 'eth_call', params: [{ to: agent.registry,
      data: encodeFunctionData({ abi: boundaryFunctions, functionName: 'tokenURI', args: [tokenId] }) }, block] })),
  ]);
  if (typeof ownerRaw !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(ownerRaw)) {
    throw new Error('noncanonical boundary ownerOf raw ABI');
  }
  const agentOwner = `0x${ownerRaw.slice(-40)}` as Address;
  if (!isAddress(agentOwner) || /^0x0{40}$/i.test(agentOwner)) throw new Error('invalid boundary owner');
  const agentURI = decodeStrictRawString(uriRaw, 64 * 1024, 'boundary tokenURI');
  const checked = await bounded(() => client.getBlock({ blockNumber: expected.blockNumber }));
  if (checked.number !== expected.blockNumber || checked.hash !== expected.blockHash) {
    throw new Error('reorganization during feedback epoch boundary read');
  }
  return { agent: { ...agent }, blockNumber: expected.blockNumber.toString(), blockHash: expected.blockHash,
    blockTimestamp, agentOwner, agentURI };
}

function declarationAuthority(uri: string, owner: Address, agent: AgentRef): { receiptSigner: Address; active: boolean } {
  const registration = decodeRegistration(uri);
  const locator = `eip155:${agent.chainId}:${agent.registry}`.toLowerCase();
  if (!registration.registrations.some((entry) => entry.agentId === agent.agentId &&
      entry.agentRegistry.toLowerCase() === locator)) throw new Error('registration does not contain selected agent locator');
  const extension = registration['x-nandacity'];
  if (extension.ownerAtPublication.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('registration ownerAtPublication does not match tracked owner');
  }
  return { receiptSigner: extension.receiptSigner as Address, active: registration.active };
}

/**
 * Bounded declaration-level authority interval for historical feedback.
 * The finding is RPC-derived and assumes complete log responses; it is not a
 * state proof, endpoint/card validity finding, or historical signature proof.
 */
export async function readIdentityFeedbackEpoch(client: PublicClient, input: {
  domain: IdentityContinuityDomain; agent: AgentRef;
  basis: { blockNumber: bigint; blockHash: Hex };
  observation: { blockNumber: bigint; blockHash: Hex };
  limits: { maxBlocks: number; maxLogs: number }; signal?: AbortSignal;
}): Promise<IdentityFeedbackEpoch> {
  const basis = { blockNumber: String(input.basis?.blockNumber), blockHash: input.basis?.blockHash };
  const observation = { blockNumber: String(input.observation?.blockNumber), blockHash: input.observation?.blockHash };
  let firstBreak: IdentityFeedbackEpoch['firstBreak'];
  const unknown = (diagnostic: string): IdentityFeedbackEpoch => ({
    epoch: 'unknown', qualification: 'rpc-derived-not-state-proof',
    basis: basis as IdentityFeedbackEpoch['basis'], observation: observation as IdentityFeedbackEpoch['observation'],
    diagnostics: [diagnostic], ...(firstBreak ? { firstBreak } : {}),
  });
  const { domain, agent, limits } = input;
  if (!domain || !agent || !input.basis || !input.observation ||
      !Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 ||
      !isAddress(domain.registry) || !hash(domain.genesisHash) ||
      !isAddress(domain.knownImplementation.address) || !hash(domain.knownImplementation.codeHash) ||
      !uint(agent.agentId) || agent.chainId !== domain.chainId ||
      agent.registry.toLowerCase() !== domain.registry.toLowerCase() ||
      input.basis.blockNumber < 0n || input.observation.blockNumber < 0n ||
      !hash(input.basis.blockHash) || !hash(input.observation.blockHash) ||
      !Number.isSafeInteger(limits?.maxBlocks) || limits.maxBlocks < 1 || limits.maxBlocks > continuityLimits.maxBlocks ||
      !Number.isSafeInteger(limits?.maxLogs) || limits.maxLogs < 1 || limits.maxLogs > continuityLimits.maxLogs) {
    return unknown('invalid feedback epoch domain, subject, coordinates or limits');
  }
  // Copy the complete authority configuration before the first await.
  const copied = {
    domain: { chainId: domain.chainId, registry: domain.registry, genesisHash: domain.genesisHash,
      knownImplementation: { ...domain.knownImplementation } },
    agent: { chainId: agent.chainId, registry: agent.registry, agentId: agent.agentId },
    basis: { ...input.basis }, observation: { ...input.observation }, limits: { ...limits },
  };
  const signal = input.signal;
  const bounded = makeBoundedRead(signal, 10_000, 'feedback epoch');
  try {
    const from = copied.basis.blockNumber, to = copied.observation.blockNumber;
    const interval = await collectCheckedInterval(client, { domain: copied.domain, agent: copied.agent, from, to,
      expectedBasisHash: copied.basis.blockHash, expectedObservationHash: copied.observation.blockHash,
      limits: copied.limits, maxRawLogBytes: 64 * 1024, bounded });
    const original = await readGuardedBoundarySnapshot(client, { agent: copied.agent,
      expected: copied.basis, bounded });
    const initial = declarationAuthority(original.agentURI, original.agentOwner, copied.agent);
    if (!initial.active) throw new Error('unsupported feedback epoch basis authority');
    let trackedOwner = original.agentOwner;
    let trackedURI = original.agentURI;
    let trackedRuntime = initial.receiptSigner;
    let intervalFailure: string | undefined = interval.failure ?? (interval.currentKnown ? undefined :
      'unsupported identity implementation at observation');
    const retire = (event: CheckedEvent, kind: NonNullable<IdentityFeedbackEpoch['firstBreak']>['kind']) => {
      firstBreak ??= { blockNumber: event.blockNumber.toString(), transactionIndex: event.transactionIndex,
        logIndex: event.logIndex, kind };
    };
    for (const event of interval.events) {
      signal?.throwIfAborted();
      if (event.kind === 'upgrade') { intervalFailure ??= 'identity implementation upgrade observed'; continue; }
      if (event.kind === 'transfer') {
        const { from: previous, to: next, tokenId } = event.decoded.args;
        if (typeof previous !== 'string' || typeof next !== 'string' || typeof tokenId !== 'bigint' ||
            tokenId !== BigInt(copied.agent.agentId) || previous.toLowerCase() !== trackedOwner.toLowerCase()) {
          throw new Error('contradictory transfer history');
        }
        retire(event, 'transfer');
        trackedOwner = next as Address;
        continue;
      }
      const { agentId, updatedBy } = event.decoded.args;
      if (typeof agentId !== 'bigint' || agentId !== BigInt(copied.agent.agentId) ||
          typeof updatedBy !== 'string' || !isAddress(updatedBy)) throw new Error('contradictory URI history');
      const nextURI = decodeStrictRawString(event.data, 64 * 1024, 'URIUpdated');
      const next = declarationAuthority(nextURI, trackedOwner, copied.agent);
      if (next.receiptSigner.toLowerCase() !== trackedRuntime.toLowerCase()) retire(event, 'runtime-replaced');
      if (!next.active) retire(event, 'deauthorized');
      trackedRuntime = next.receiptSigner;
      trackedURI = nextURI;
    }
    const current = await readGuardedBoundarySnapshot(client, { agent: copied.agent,
      expected: copied.observation, bounded });
    decodeRegistration(current.agentURI);
    if (!interval.failure && (trackedOwner.toLowerCase() !== current.agentOwner.toLowerCase() || trackedURI !== current.agentURI)) {
      throw new Error('feedback epoch final state disagrees with complete event history');
    }
    // Epoch observations recheck every referenced block, including genesis,
    // boundaries and event blocks. This is intentionally stronger than the live wrapper.
    const allBlocks = new Map(interval.blocks);
    allBlocks.set(0n, copied.domain.genesisHash);
    await recheckBlocks(client, allBlocks, bounded, 'feedback epoch read');
    if (intervalFailure) return unknown(intervalFailure);
    return { epoch: firstBreak ? 'retired' : 'same', qualification: 'rpc-derived-not-state-proof',
      basis: basis as IdentityFeedbackEpoch['basis'], observation: observation as IdentityFeedbackEpoch['observation'],
      diagnostics: [], ...(firstBreak ? { firstBreak } : {}) };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : 'feedback epoch read failed');
  }
}
