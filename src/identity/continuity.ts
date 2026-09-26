import { decodeEventLog, encodeEventTopics, isAddress, keccak256, numberToHex,
  parseAbi, type Address, type Hex, type PublicClient } from 'viem';
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
export const continuityLimits = { maxBlocks: 4096, maxLogs: 1024 } as const;
const events = parseAbi([
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Upgraded(address indexed implementation)',
]);
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const uint = (value: string) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const sameAgent = (a: AgentRef, b: AgentRef) => a.chainId === b.chainId &&
  a.registry.toLowerCase() === b.registry.toLowerCase() && a.agentId === b.agentId;

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
  const deadline = Date.now() + 10_000;
  async function bounded<T>(read: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('continuity total deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('continuity RPC deadline exceeded')), Math.min(remaining, 5000));
      })]);
    } finally { clearTimeout(timer); }
  }
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
    if (from > to || to - from > BigInt(limits.maxBlocks)) throw new Error('continuity range exceeds bounds');
    if (await bounded(() => client.getChainId()) !== domain.chainId) throw new Error('chain ID mismatch');
    const numbered = async (number: bigint) => {
      const block = await bounded(() => client.getBlock({ blockNumber: number }));
      if (block.number !== number || !hash(block.hash)) throw new Error('missing numbered block');
      return block.hash;
    };
    if (await numbered(0n) !== domain.genesisHash) throw new Error('genesis mismatch');
    const blocks = new Map<bigint, Hex>();
    for (const snapshot of [basis, current]) {
      const number = BigInt(snapshot.blockNumber);
      const canonical = blocks.get(number) ?? await numbered(number);
      if (canonical !== snapshot.blockHash) throw new Error('snapshot canonical hash mismatch');
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
    let count = 0, changed = false, upgraded = false;
    const coordinates = new Set<string>();
    // Explicit sequential chunks: a rejected/missing chunk cannot become an empty result.
    for (let start = from + 1n; start <= to; start += 64n) {
      const end = start + 63n < to ? start + 63n : to;
      for (let i = 0; i < filters.length; i++) {
        const topics = filters[i]!;
        // Raw request deliberately avoids viem getLogs' silent discard of bad decoded logs.
        const logs = await bounded(() => client.request({ method: 'eth_getLogs', params: [{
          address: domain.registry, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics,
        }] }));
        if (!Array.isArray(logs) || (count += logs.length) > limits.maxLogs) throw new Error('log limit or malformed chunk');
        for (const log of logs) {
          const quantity = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
          if (!log || log.removed !== false || typeof log.address !== 'string' ||
              log.address.toLowerCase() !== domain.registry.toLowerCase() ||
              !quantity(log.blockNumber) || !quantity(log.transactionIndex) || !quantity(log.logIndex) ||
              BigInt(log.transactionIndex) > BigInt(Number.MAX_SAFE_INTEGER) ||
              BigInt(log.logIndex) > BigInt(Number.MAX_SAFE_INTEGER) ||
              !hash(log.blockHash) || !hash(log.transactionHash) || !Array.isArray(log.topics) ||
              log.topics.length !== (i === 0 ? 3 : i === 1 ? 4 : 2) || !log.topics.every(hash) ||
              !topics.every((topic, index) => topic === null || topic === log.topics[index]) ||
              typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) || log.data.length > 140_000) {
            throw new Error('malformed or out-of-filter log');
          }
          const number = BigInt(log.blockNumber);
          if (number < start || number > end) throw new Error('log outside requested chunk');
          const key = `${number}:${log.logIndex}`;
          if (coordinates.has(key)) throw new Error('duplicate log coordinates');
          coordinates.add(key);
          const canonical = blocks.get(number) ?? await numbered(number);
          blocks.set(number, canonical);
          if (canonical !== log.blockHash) throw new Error('noncanonical log hash');
          decodeEventLog({ abi: events, data: log.data, topics: log.topics, strict: true });
          changed = true;
          if (i === 2) upgraded = true;
        }
      }
    }
    // Bracket even a changed finding. Reorg/partial reads outrank change evidence.
    for (const [number, expected] of new Map([[from, basis.blockHash], [to, current.blockHash]])) {
      if (await numbered(number) !== expected) throw new Error('reorganization during continuity read');
    }
    if (!currentKnown && !upgraded) throw new Error('unknown current implementation without canonical upgrade evidence');
    if (changed || basis.agentOwner.toLowerCase() !== current.agentOwner.toLowerCase() || basis.agentURI !== current.agentURI) {
      return result('changed', 'subject URI/transfer, registry upgrade, or endpoint authority changed');
    }
    return result('unchanged', 'canonical bounded interval has no authority changes, assuming complete RPC logs');
  } catch (error) {
    return result('unknown', error instanceof Error ? error.message : 'continuity read failed');
  }
}
