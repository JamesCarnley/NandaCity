import { keccak256, type Hex } from 'viem';
import { originalCandidate, originalOwner } from '../../identity/fixtures.js';
import type { FreshPairZeroInput, CheckpointRpcSource } from '../../../src/feedback/pairZeroCheckpoint.js';

// Synthetic chain data. These are not observed Sepolia state or a source-build proof.
export const I = '0x1111111111111111111111111111111111111111';
export const R = '0x2222222222222222222222222222222222222222';
export const II = '0x3333333333333333333333333333333333333333';
export const RI = '0x4444444444444444444444444444444444444444';
export const ROUTER = '0x5555555555555555555555555555555555555555';
export const REVIEWER = I;
export const SLOT = '0x8133de038c09af090eb6a4fd27b8039195e7d5a2fc173020055e210cebb9b76d';
export const IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const PROXY = '0x60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545f9081906001600160a01b0316368280378136915af43d5f803e156048573d5ff35b3d5ffdfea2646970667358221220d25633e50c873a78e74176feb55eabe7e699db80eeb0380952dba33544b2c7f664736f6c63430008180033';
export const PROXY_HASH = '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41';
export const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
export const addr = (a: string) => a.slice(2).padStart(64, '0');
export const ZERO = `0x${word(0)}`;
export const ONE = `0x${word(1)}`;
export const TWO = `0x${word(2)}`;
export const q = (n: number) => `0x${n.toString(16)}`;
export const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export const abiString = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  return `0x${word(32)}${word(b.length)}${b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0')}`;
};
// Independently frozen event signatures and selectors; no checkpoint helper generates expected bytes.
export const TOPICS = {
  upgraded: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
  initialized: '0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  registered: '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
  feedback: '0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc',
};
export const CALLS = {
  version: '0x0d8e6e2c', owner: '0x8da5cb5b', link: '0xbc4d861b',
  ownerOf: `0x6352211e${word(7)}`, uri: `0xc87b56dd${word(7)}`,
  supports: `0x01ffc9a780ac58cd${'0'.repeat(56)}`,
  last: `0xf2d81759${word(7)}${addr(REVIEWER)}`,
  read1: `0x232b0810${word(7)}${addr(REVIEWER)}${word(1)}`,
  read2: `0x232b0810${word(7)}${addr(REVIEWER)}${word(2)}`,
};

export function block(n: number) {
  return { number: q(n), hash: h(n), timestamp: q(1_800_000_000 + n), parentHash: h(Math.max(0, n - 1)),
    nonce: '0x0000000000000000', sha3Uncles: h(900), logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: h(901), stateRoot: h(902), receiptsRoot: h(903), miner: ROUTER,
    difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x200', gasLimit: '0x100000',
    gasUsed: '0x10000', baseFeePerGas: '0x1', mixHash: h(904), transactions: [], uncles: [] };
}
export function log(n: number, tx: number, ti: number, li: number, address: string, topics: string[], data: string) {
  return { address, topics, data, blockNumber: q(n), blockHash: h(n), transactionHash: h(tx),
    transactionIndex: q(ti), logIndex: q(li), removed: false };
}
export function transaction(n: number, tx: number, ti: number) {
  return { hash: h(tx), blockNumber: q(n), blockHash: h(n), transactionIndex: q(ti), from: ROUTER,
    to: ROUTER, nonce: '0x1', value: '0x0', input: '0x12345678', gas: '0x100000', gasPrice: '0x1',
    type: '0x0', chainId: '0xaa36a7', v: '0x1b', r: h(1), s: h(2) };
}
export function receipt(n: number, tx: number, ti: number, logs: ReturnType<typeof log>[]) {
  return { transactionHash: h(tx), blockNumber: q(n), blockHash: h(n), transactionIndex: q(ti),
    status: '0x1', from: ROUTER, to: ROUTER, contractAddress: null, cumulativeGasUsed: '0x10000',
    gasUsed: '0x10000', effectiveGasPrice: '0x1', logsBloom: `0x${'00'.repeat(256)}`, type: '0x0', logs };
}
// Four empty byte strings; tag1 keccak is the independent standard empty-input digest.
export const EMPTY_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
export const feedbackData = (index: number) => `0x${word(index)}${word(5)}${word(0)}${word(256)}${word(288)}${word(320)}${word(352)}${word(0)}${word(0)}${word(0)}${word(0)}${word(0)}`;
export const storageData = (revoked: boolean) => `0x${word(5)}${word(0)}${word(160)}${word(192)}${word(revoked ? 1 : 0)}${word(0)}${word(0)}`;
export const publication = (index: number) => log(101, 200 + index, index - 1, index - 1, R,
  [TOPICS.feedback, `0x${word(7)}`, `0x${addr(REVIEWER)}`, EMPTY_HASH], feedbackData(index));
export const registrationLogs = () => [
  log(100, 200, 0, 0, I, [TOPICS.transfer, ZERO, `0x${addr(originalOwner)}`, `0x${word(7)}`], '0x'),
  log(100, 200, 0, 1, I, [TOPICS.registered, `0x${word(7)}`, `0x${addr(originalOwner)}`], abiString('')),
];
export type Exchange = Extract<CheckpointRpcSource, { kind: 'literal-fixture' }>['exchanges'][number];
export const response = (id: number, result: unknown) => new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result }));

/** Sequential literal wire fixture. Fixed-basis state calls are repeated only once. */
export function checkpointFixture(options: { count?: number; zero?: number; observation?: number; registration?: number; chunk?: number } = {}): FreshPairZeroInput {
  const N = options.count ?? 2, B = options.observation ?? 102, G = options.registration ?? 100, A = G - 1, P = 100;
  const exchanges: Exchange[] = [];
  const cached = new Set<string>();
  const add = (method: string, params: readonly unknown[], result: unknown) => {
    if (['eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method)) {
      const k = JSON.stringify([method, params]); if (cached.has(k)) return; cached.add(k);
    }
    exchanges.push({ method, params, requestId: exchanges.length + 1, responseUtf8: response(exchanges.length + 1, result) });
  };
  const header = (n: number) => add('eth_getBlockByNumber', [q(n), false], block(n));
  const call = (address: string, data: string, n: number, result: unknown) => add('eth_call', [{ to: address, data }, q(n)], result);
  const qualify = (n: number) => {
    for (const [registry, implementation, code] of [[I, II, '0x60006000f3'], [R, RI, '0x60016000f3']] as const) {
      add('eth_getCode', [registry, q(n)], PROXY);
      add('eth_getStorageAt', [registry, IMPLEMENTATION, q(n)], `0x${addr(implementation)}`);
      add('eth_getCode', [implementation, q(n)], code);
      call(registry, CALLS.owner, n, `0x${addr(originalOwner)}`);
      call(registry, CALLS.version, n, abiString('2.0.0'));
    }
    call(R, CALLS.link, n, `0x${addr(I)}`);
  };
  add('eth_chainId', [], '0xaa36a7'); header(0); header(A); header(100); header(B);
  for (const n of [...new Set([A, G, P, B])]) { if (n === G && G !== 100) header(G); qualify(n); }
  add('eth_getTransactionByHash', [h(200)], transaction(G, 200, 0));
  add('eth_getTransactionReceipt', [h(200)], receipt(G, 200, 0, registrationLogs().map(l => ({ ...l, blockNumber: q(G), blockHash: h(G) }))));
  add('eth_chainId', [], '0xaa36a7'); header(P);
  call(I, CALLS.ownerOf, P, `0x${addr(originalOwner)}`); call(I, CALLS.uri, P, abiString(originalCandidate.agentURI)); header(P);
  const chunk = options.chunk ?? 64;
  for (const [registry, start] of [[I, G], [R, 101]] as const) {
    for (let from = start; from <= B; from += chunk) add('eth_getLogs', [{ address: registry,
      fromBlock: q(from), toBlock: q(Math.min(B, from + chunk - 1)), topics: [[TOPICS.upgraded, TOPICS.initialized]] }], []);
  }
  for (const [n, count] of [[100, options.zero ?? 0], [B, N]] as const) {
    call(R, CALLS.last, n, `0x${word(count)}`); add('eth_getStorageAt', [R, SLOT, q(n)], `0x${word(count)}`);
  }
  for (let from = 101; from <= B; from += chunk) add('eth_getLogs', [{ address: R, fromBlock: q(from),
    toBlock: q(Math.min(B, from + chunk - 1)), topics: [TOPICS.feedback, `0x${word(7)}`, `0x${addr(REVIEWER)}`] }], from === 101 ? Array.from({ length: N }, (_, i) => publication(i + 1)) : []);
  for (let index = 1; index <= N; index++) {
    if (index === 1) header(101);
    add('eth_getTransactionByHash', [h(200 + index)], transaction(101, 200 + index, index - 1));
    add('eth_getTransactionReceipt', [h(200 + index)], receipt(101, 200 + index, index - 1, [publication(index)]));
    add('eth_chainId', [], '0xaa36a7'); header(0); header(101); header(B);
    call(I, CALLS.supports, B, ONE);
    call(R, index === 1 ? CALLS.read1 : CALLS.read2, B, storageData(index === 2));
    header(101); header(B);
  }
  for (const n of [...new Set([0, A, 100, B, ...(G === 100 ? [] : [G]), ...(N ? [101] : [])])]) header(n);
  return { kind: 'fresh-pair-zero-v1', domain: { chainId: 11155111, genesisHash: h(0), identityRegistry: I, reputationRegistry: R },
    pins: { proxy: { fullRuntimeHex: PROXY, fullRuntimeHash: PROXY_HASH, reviewId: 'exact-byte-behavior-reviewed-v1' },
      identity: { implementation: II, fullRuntimeHash: keccak256('0x60006000f3'), sourceBuildId: 'synthetic-identity-not-a-source-proof' },
      reputation: { implementation: RI, fullRuntimeHash: keccak256('0x60016000f3'), sourceBuildId: 'synthetic-reputation-not-a-source-proof' } },
    registrationBasis: { blockNumber: BigInt(A), blockHash: h(A) },
    registrations: [{ transactionHash: h(200), blockNumber: String(G), blockHash: h(G), transactionIndex: 0, agentId: '7',
      owner: originalOwner, mintLogIndex: 0, registeredLogIndex: 1, profileBasis: { blockNumber: BigInt(P), blockHash: h(P) },
      cardBytes: new Uint8Array(originalCandidate.cardBytes) }],
    zeroBasis: { blockNumber: 100n, blockHash: h(100) }, pairs: [{ agentId: '7', reviewer: REVIEWER }],
    observation: { blockNumber: BigInt(B), blockHash: h(B) }, source: { kind: 'literal-fixture', exchanges },
    ...(options.chunk ? { limits: { chunkBlocks: options.chunk } } : {}) };
}
