import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, keccak256, parseAbiParameters, toEventSelector, type Hex } from 'viem';

// Literal expectations below catch lossy string decoding and unsafe integer conversion.
// The encoder is Viem's real ABI codec, not the decoder under test.
const parameters = parseAbiParameters('uint64, int128, uint8, bytes, bytes, bytes, bytes, bytes32');
const storageParameters = parseAbiParameters('int128, uint8, bytes, bytes, bool');
const hash = `0x${'12'.repeat(32)}` as Hex;
const topic = toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');
const reviewerTopic = `0x${'0'.repeat(24)}1111111111111111111111111111111111111111` as Hex;
const topics = [topic, `0x${'ff'.repeat(32)}` as Hex, reviewerTopic, keccak256('0xff')] as const;
const data = encodeAbiParameters(parameters, [18446744073709551615n, -100000000000000000000000000000000000000n, 18,
  '0xff', '0xefbbbf61', '0x610062', '0xc080', hash]);

test('raw registry codecs preserve opaque string slots and exact large integers', async () => {
  const reader = await import('../../src/feedback/registryObservation.js').catch(() => undefined);
  assert.ok(reader, 'raw registry observation module must exist');
  assert.deepEqual(reader.decodeRawRegistryFeedbackEvent({ data, topics }), {
    agentId: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    reviewer: '0x1111111111111111111111111111111111111111', feedbackIndex: '18446744073709551615',
    value: '-100000000000000000000000000000000000000', valueDecimals: 18,
    tag1Bytes: '0xff', tag2Bytes: '0xefbbbf61', endpointBytes: '0x610062', feedbackURIBytes: '0xc080', feedbackHash: hash,
  });
  assert.deepEqual(reader.decodeRawRegistryFeedbackStorage(encodeAbiParameters(storageParameters,
    [-100000000000000000000000000000000000000n, 18, '0xff', '0xefbbbf61', true])), {
    value: '-100000000000000000000000000000000000000', valueDecimals: 18,
    tag1Bytes: '0xff', tag2Bytes: '0xefbbbf61', isRevoked: true,
  });
});

test('raw codec rejects noncanonical ABI, topic attribution and reference-contract range violations', async () => {
  const reader = await import('../../src/feedback/registryObservation.js').catch(() => undefined);
  assert.ok(reader, 'raw registry observation module must exist');
  const event = reader.decodeRawRegistryFeedbackEvent;
  const variants: Array<{ data: Hex; topics: readonly Hex[] }> = [
    { data: `${data}00`, topics }, // trailing bytes
    { data: `0x${data.slice(2, 194)}${'0'.repeat(64)}${data.slice(258)}`, topics }, // tag offset into head
    { data: `${data.slice(0, -2)}01` as Hex, topics }, // nonzero dynamic padding
    { data, topics: [hash, ...topics.slice(1)] },
    { data, topics: [...topics.slice(0, 3), hash] },
    { data, topics: [...topics, hash] },
    { data, topics: [topic, topics[1], `0x01${reviewerTopic.slice(4)}`, topics[3]] },
    { data: encodeAbiParameters(parameters, [0n, 1n, 0, '0xff', '0x', '0x', '0x', hash]), topics },
    { data: encodeAbiParameters(parameters, [1n, 1n, 19, '0xff', '0x', '0x', '0x', hash]), topics },
    { data: encodeAbiParameters(parameters, [1n, 100000000000000000000000000000000000001n, 0,
      '0xff', '0x', '0x', '0x', hash]), topics },
  ];
  for (const variant of variants) assert.throws(() => event(variant));
  assert.throws(() => event({ data, topics }, 32), /bound|limit/);
  assert.throws(() => reader.decodeRawRegistryFeedbackStorage(`${encodeAbiParameters(storageParameters,
    [1n, 0, '0x', '0x', false])}00`));
});

test('cancellation before a queued RPC begins prevents the transport operation itself', async () => {
  const { readRegistryFeedbackObservation } = await import('../../src/feedback/registryObservation.js');
  const controller = new AbortController();
  let requests = 0;
  const client = createPublicClient({ transport: custom({ request: async () => { requests++; return '0x7a69'; } }, { retryCount: 0 }) });
  const pending = readRegistryFeedbackObservation({ client, signal: controller.signal,
    domain: { chainId: 31337, genesisHash: hash, identityRegistry: '0x1111111111111111111111111111111111111111',
      reputationRegistry: '0x2222222222222222222222222222222222222222' },
    eventRef: { blockNumber: '1', blockHash: hash, transactionHash: hash, transactionIndex: 0, logIndex: 0 },
    observation: { blockNumber: 1n, blockHash: hash } });
  controller.abort();
  assert.equal((await pending).authenticity, 'unavailable');
  assert.equal(requests, 0, 'cancellation must stop not-yet-started RPC work');
});

test('input scalar validation rejects terminal whitespace and unknown inherited-name limit overrides', async () => {
  const { readRegistryFeedbackObservation: read } = await import('../../src/feedback/registryObservation.js');
  const client = createPublicClient({ transport: custom({ request: async () => { throw new Error('unavailable'); } }, { retryCount: 0 }) });
  const input = { client, domain: { chainId: 31337, genesisHash: hash,
    identityRegistry: '0x1111111111111111111111111111111111111111' as Hex,
    reputationRegistry: '0x2222222222222222222222222222222222222222' as Hex },
    eventRef: { blockNumber: '1', blockHash: hash, transactionHash: hash, transactionIndex: 0, logIndex: 0 },
    observation: { blockNumber: 1n, blockHash: hash } };
  const variants = [
    { ...input, domain: { ...input.domain, genesisHash: `${hash}\n` as Hex } },
    { ...input, domain: { ...input.domain, identityRegistry: `${input.domain.identityRegistry}\n` as Hex } },
    { ...input, eventRef: { ...input.eventRef, blockNumber: '1\n' } },
    { ...input, limits: { toString: 1 } },
  ];
  for (const variant of variants) await assert.rejects(read(variant as Parameters<typeof read>[0]), /domain|reference|limit/);
});
