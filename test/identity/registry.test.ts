import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAbiParameters, parseAbiParameters, type Hex, type PublicClient } from 'viem';

import { assertLocalWriteRpcUrl } from '../../src/demo/anvil.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';

const agent = {
  chainId: 31_337,
  registry: '0x1111111111111111111111111111111111111111' as const,
  agentId: '7',
};
const owner = '0x2222222222222222222222222222222222222222' as const;
const blockHash =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const changedBlockHash =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const stringParameters = parseAbiParameters('string');
const bytesParameters = parseAbiParameters('bytes');

function rawString(value: string): Hex {
  return encodeAbiParameters(stringParameters, [value]);
}

function makeSnapshotClient(input: {
  decodedURI?: string;
  rawURI?: unknown;
  selectedNumber?: bigint;
  checkedNumber?: bigint;
  selectedHash?: Hex;
  checkedHash?: Hex;
} = {}) {
  const getBlockCalls: unknown[] = [];
  const stateCalls: string[] = [];
  let blockRead = 0;
  const decodedURI = input.decodedURI ?? 'data:example';
  const selectedNumber = input.selectedNumber ?? 42n;
  const client = {
    async getChainId() { return 31_337; },
    async getBlock(parameters: unknown) {
      getBlockCalls.push(parameters);
      blockRead += 1;
      return {
        number: blockRead === 1 ? selectedNumber : (input.checkedNumber ?? selectedNumber),
        hash: blockRead === 1 ? (input.selectedHash ?? blockHash) :
          (input.checkedHash ?? input.selectedHash ?? blockHash),
        timestamp: 1_700_000_000n,
      };
    },
    async readContract(parameters: { functionName: string; blockNumber?: bigint }) {
      assert.equal(parameters.blockNumber, selectedNumber);
      stateCalls.push(`readContract:${parameters.functionName}`);
      return parameters.functionName === 'ownerOf' ? owner : decodedURI;
    },
    async request(parameters: { method: string; params?: readonly unknown[] }) {
      assert.equal(parameters.params?.[1], `0x${selectedNumber.toString(16)}`);
      stateCalls.push(parameters.method);
      return input.rawURI ?? rawString(decodedURI);
    },
  } as unknown as PublicClient;
  return { client, getBlockCalls, stateCalls };
}

test('qualifies owner and URI reads to one numbered block', async () => {
  const { client, getBlockCalls, stateCalls } = makeSnapshotClient();

  const snapshot = await readIdentitySnapshot(client, agent);

  assert.deepEqual(snapshot, {
    agent,
    blockNumber: '42',
    blockHash,
    blockTimestamp: 1_700_000_000,
    agentOwner: owner,
    agentURI: 'data:example',
  });
  assert.deepEqual(stateCalls, ['readContract:ownerOf', 'eth_call']);
  assert.deepEqual(getBlockCalls, [{ blockTag: 'latest' }, { blockNumber: 42n }]);
});

test('preserves generic tokenURI strings without a City schema or 64 KiB ceiling', async () => {
  const values = [
    '',
    'https://opaque.example/agent',
    'ipfs://bafybeigdyrzt/agent.json',
    'https://opaque.example/\u6771\u4eac/\uD83C\uDF06',
    '\uFEFFopaque-leading-bom',
    `https://opaque.example/${'x'.repeat(64 * 1024)}`,
  ];
  for (const value of values) {
    const { client } = makeSnapshotClient({ decodedURI: 'decoded fallback must not be used',
      rawURI: rawString(value) });
    assert.equal((await readIdentitySnapshot(client, agent)).agentURI, value,
      `${new TextEncoder().encode(value).byteLength} UTF-8 bytes`);
  }
});

test('rejects noncanonical raw tokenURI ABI instead of falling back to decoded strings', async () => {
  const valid = rawString('a');
  const body = valid.slice(2);
  const word = (value: bigint) => value.toString(16).padStart(64, '0');
  const cases = [
    `0x${word(64n)}${body.slice(64)}`,
    `0x${body.slice(0, 64)}${word(33n)}${body.slice(128)}`,
    `${valid.slice(0, -2)}01`,
    `${valid}00`,
  ];
  for (const rawURI of cases) {
    const { client } = makeSnapshotClient({ decodedURI: 'decoded fallback must not be used', rawURI });
    await assert.rejects(readIdentitySnapshot(client, agent), /tokenURI.*ABI|canonical/i);
  }
});

test('rejects invalid UTF-8 in raw tokenURI ABI', async () => {
  const invalidUTF8 = encodeAbiParameters(bytesParameters, ['0xff']);
  const { client } = makeSnapshotClient({ decodedURI: '\uFFFD', rawURI: invalidUTF8 });
  await assert.rejects(readIdentitySnapshot(client, agent), /tokenURI.*UTF-8/i);
});

test('rejects an explicit block-number mismatch before owner or URI state reads', async () => {
  const { client, stateCalls } = makeSnapshotClient({ selectedNumber: 43n });
  await assert.rejects(readIdentitySnapshot(client, agent, 42n), /block number|numbered block/i);
  assert.deepEqual(stateCalls, []);
});

test('treats a same-hash different-number final header as a reorganization', async () => {
  const { client } = makeSnapshotClient({ checkedNumber: 43n });
  await assert.rejects(readIdentitySnapshot(client, agent), /reorganization detected/i);
});

test('rejects a block hash change during block-qualified reads', async () => {
  const { client } = makeSnapshotClient({ checkedHash: changedBlockHash });

  await assert.rejects(readIdentitySnapshot(client, agent), /reorganization detected/i);
});

test('refuses identity demo writes to non-loopback RPCs', () => {
  assert.doesNotThrow(() => assertLocalWriteRpcUrl('http://127.0.0.1:8545'));
  assert.doesNotThrow(() => assertLocalWriteRpcUrl('http://localhost:8545'));
  assert.throws(
    () => assertLocalWriteRpcUrl('https://mainnet.example'),
    /loopback HTTP RPC/i,
  );
  assert.throws(
    () => assertLocalWriteRpcUrl('http://127.0.0.1.evil.example:8545'),
    /loopback HTTP RPC/i,
  );
});
