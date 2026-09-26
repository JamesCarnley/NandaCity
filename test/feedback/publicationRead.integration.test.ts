import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPublicClient, createWalletClient, encodeFunctionData, encodeFunctionResult, http, type Hex, type PublicClient } from 'viem';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { prepareLocalFeedbackPublication, prepareLocalFeedbackRevocation, submitPreparedFeedback } from '../../src/demo/feedbackPublication.js';
import { receipt, registryAbi } from '../../src/demo/registryFixture.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';
import { signFeedback } from '../../src/feedback/signatures.js';
import { publicationFixture } from './fixtures.js';

const otherHash = `0x${'12'.repeat(32)}` as Hex;
const readSelector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'readFeedback',
  args: [0n, '0x1111111111111111111111111111111111111111', 1n] }).slice(0, 10);
const callSelector = (request: RpcMessage) => request.method === 'eth_call'
  ? (request.params[0] as { data: string }).data.slice(0, 10) : '';
type RpcMessage = { method: string; params: unknown[]; id: number };
type RpcReply = { result?: any; error?: unknown; id: number; jsonrpc: string };

/** Forward real owned-chain reads, changing only the transport fault under test. */
async function withReadProxy(rpcUrl: string, alter: (request: RpcMessage, reply: RpcReply) => void,
  use: (client: PublicClient) => Promise<void>) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += (chunk as Buffer).length;
        if (length > 100_000) throw new Error('oversized proxy request');
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(body) as RpcMessage;
      assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call', 'eth_getCode'].includes(parsed.method),
        `reader must only issue reads: ${parsed.method}`);
      const forwarded = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(2_000) });
      const reply = await forwarded.json() as RpcReply;
      alter(parsed, reply);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply));
    } catch { response.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await use(createPublicClient({ transport: http(`http://127.0.0.1:${address.port}`, { retryCount: 0, timeout: 2_000 }) }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('independent block-qualified feedback publication reader', async (t) => {
  const reader = await import('../../src/feedback/publication.js').catch(() => undefined);
  assert.ok(reader, 'independent feedback publication reader must be implemented');
  const { readFeedbackPublication: read } = reader;
  await withOwnedAnvil(async (rpcUrl) => {
    const f = await publicationFixture(rpcUrl);
    const prepared = await prepareLocalFeedbackPublication(f.input);
    const published = await submitPreparedFeedback({ ...f.input, prepared });
    const genesis = await f.publicClient.getBlock({ blockNumber: 0n });
    assert.ok(genesis.hash);
    const domain = { chainId: 31337, identityRegistry: f.identityRegistry,
      reputationRegistry: f.reputationRegistry, genesisHash: genesis.hash };
    const eventRef = { ...published.event, feedbackURI: f.feedbackURI };
    const input = { client: f.publicClient, domain, eventRef, documentBytes: f.document,
      observationBlock: BigInt(eventRef.blockNumber) };

    await t.test('actual receipt, exact document projection, and numbered storage produce separate JSON-safe findings', async () => {
      const result = await read(input);
      assert.equal(result.publication, 'matched');
      assert.equal(result.revocation, 'active');
      assert.equal(result.document.decoding, 'valid');
      assert.equal(result.document.signature, 'valid');
      assert.equal(result.document.documentHash, f.documentValue.documentHash);
      assert.equal(result.document.bytesBase64, Buffer.from(f.document).toString('base64'));
      assert.equal(result.event?.feedbackIndex, '1');
      assert.equal(result.event?.value, '5');
      assert.equal(result.event?.reviewer, f.caller.address.toLowerCase());
      assert.equal(result.event?.feedbackURI, f.feedbackURI);
      assert.equal(result.source?.blockHash, eventRef.blockHash);
      assert.equal(result.source?.transactionHash, eventRef.transactionHash);
      assert.equal(result.source?.logIndex, eventRef.logIndex);
      assert.equal(result.observation?.blockNumber, eventRef.blockNumber);
      assert.equal(result.qualification, 'rpc-derived-not-state-proof');
      assert.equal(result.historicalExistence, 'unknown');
      assert.equal(result.historicalOrdering, 'unknown');
      assert.equal(result.claimedFeedbackTime, 'after-publication');
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    });

    await t.test('changed document and wrong expected URI are mismatches, not new authoritative scores', async () => {
      const changed = encodeFeedbackDocument(await signFeedback({ ...f.feedbackValue, value: 1 }, f.caller));
      const result = await read({ ...input, documentBytes: changed.bytes });
      assert.equal(result.publication, 'mismatched');
      assert.ok(result.diagnostics.includes('document-hash-mismatch'));
      assert.ok(result.diagnostics.includes('event-value-mismatch'));
      assert.equal(result.document.signature, 'valid');
      const wrongUri = await read({ ...input, eventRef: { ...eventRef, feedbackURI: `${f.feedbackURI}&wrong=1` } });
      assert.equal(wrongUri.publication, 'mismatched');
      assert.ok(wrongUri.diagnostics.includes('event-uri-mismatch'));
    });

    await t.test('missing or malformed bytes remain inspectably distinct from absent publication', async () => {
      const missing = await read({ ...input, documentBytes: null });
      assert.equal(missing.publication, 'unavailable');
      assert.equal(missing.document.decoding, 'unavailable');
      assert.equal(missing.revocation, 'active');
      const malformed = await read({ ...input, documentBytes: new TextEncoder().encode('{}') });
      assert.equal(malformed.publication, 'mismatched');
      assert.equal(malformed.document.decoding, 'invalid');
      assert.equal(malformed.event?.feedbackIndex, '1');
    });

    await t.test('chain, genesis, Identity, and Reputation domain mismatches cannot become matched', async () => {
      for (const patch of [{ chainId: 1 }, { genesisHash: otherHash }, { identityRegistry: f.stranger.address },
        { reputationRegistry: f.identityRegistry }]) {
        const result = await read({ ...input, domain: { ...domain, ...patch } });
        assert.equal(result.publication, 'mismatched');
        assert.equal(result.revocation, 'unknown');
      }
    });

    await t.test('unknown transaction is unavailable; wrong log coordinate and pre-publication basis mismatch', async () => {
      const missing = await read({ ...input, eventRef: { ...eventRef, transactionHash: otherHash } });
      assert.equal(missing.publication, 'unavailable');
      assert.equal(missing.source, undefined, 'unconfirmed caller coordinates must not be promoted to source evidence');
      assert.equal(missing.claimedFeedbackTime, 'unavailable');
      assert.equal((await read({ ...input, eventRef: { ...eventRef, logIndex: eventRef.logIndex + 99 } })).publication, 'mismatched');
      const before = await read({ ...input, observationBlock: input.observationBlock - 1n });
      assert.equal(before.publication, 'mismatched');
      assert.equal(before.revocation, 'unknown');
      assert.ok(before.diagnostics.includes('publication-after-observation'));
      await assert.rejects(read({ ...input, observationBlock: undefined as unknown as bigint }), /numbered|observationBlock/);
    });

    await t.test('later owner and profile changes do not erase the prior publication', async () => {
      await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'setAgentURI', args: [0n, 'data:application/json,{}'], chain: null }));
      const changed = await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'transferFrom', args: [f.owner.address, f.stranger.address, 0n], chain: null }));
      const result = await read({ ...input, observationBlock: changed.blockNumber });
      assert.equal(result.publication, 'matched');
      assert.equal(result.revocation, 'active');
      assert.equal(result.document.bytesBase64, Buffer.from(f.document).toString('base64'));
    });

    await t.test('revocation at a later block does not alter historical active state or the document', async () => {
      const revoke = await prepareLocalFeedbackRevocation({ ...f.input, originalPublication: prepared, publicationResult: published });
      const revoked = await submitPreparedFeedback({ ...f.input, prepared: revoke });
      const result = await read({ ...input, observationBlock: BigInt(revoked.receipt.blockNumber) });
      assert.equal(result.publication, 'matched');
      assert.equal(result.revocation, 'revoked');
      assert.equal(result.document.bytesBase64, Buffer.from(f.document).toString('base64'));
      assert.equal((await read(input)).revocation, 'active');
    });

    await t.test('real reference-contract publications with wrong scalar, decimals, tags, endpoint, or hash are mismatched', async () => {
      const base = [0n, 5n, 0, 'evening-plan-usefulness-v0.1', '', '', f.feedbackURI, f.documentValue.documentHash] as const;
      const variants = [
        { args: [0n, 1n, ...base.slice(2)], diagnostic: 'event-value-mismatch' },
        { args: [0n, 5n, 1, ...base.slice(3)], diagnostic: 'event-decimals-mismatch' },
        { args: [...base.slice(0, 3), 'different-rubric', ...base.slice(4)], diagnostic: 'event-tag1-mismatch' },
        { args: [...base.slice(0, 4), 'extra-tag', ...base.slice(5)], diagnostic: 'event-tag2-mismatch' },
        { args: [...base.slice(0, 5), 'https://example.invalid/service', ...base.slice(6)], diagnostic: 'event-endpoint-mismatch' },
        { args: [...base.slice(0, 7), otherHash], diagnostic: 'document-hash-mismatch' },
      ];
      for (const variant of variants) {
        const mined = await receipt(f.publicClient, await f.walletClient.writeContract({ address: f.reputationRegistry,
          abi: reputationRegistryAbi, functionName: 'giveFeedback', args: variant.args as unknown as typeof base, chain: null }));
        const log = mined.logs.find((entry) => entry.address.toLowerCase() === f.reputationRegistry.toLowerCase())!;
        const result = await read({ ...input, observationBlock: mined.blockNumber, eventRef: {
          blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash, transactionHash: mined.transactionHash,
          transactionIndex: mined.transactionIndex, logIndex: log.logIndex, feedbackURI: f.feedbackURI } });
        assert.equal(result.publication, 'mismatched', variant.diagnostic);
        assert.ok(result.diagnostics.includes(variant.diagnostic), variant.diagnostic);
      }
    });

    await t.test('real feedback from another reviewer cannot attribute the supplied document to that sender', async () => {
      const wallet = createWalletClient({ account: f.owner, transport: f.transport });
      const mined = await receipt(f.publicClient, await wallet.writeContract({ address: f.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback',
        args: [0n, 5n, 0, 'evening-plan-usefulness-v0.1', '', '', f.feedbackURI, f.documentValue.documentHash], chain: null }));
      const log = mined.logs.find((entry) => entry.address.toLowerCase() === f.reputationRegistry.toLowerCase())!;
      const result = await read({ ...input, observationBlock: mined.blockNumber, eventRef: {
        blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash, transactionHash: mined.transactionHash,
        transactionIndex: mined.transactionIndex, logIndex: log.logIndex, feedbackURI: f.feedbackURI } });
      assert.equal(result.publication, 'mismatched');
      assert.ok(result.diagnostics.includes('event-reviewer-mismatch'));
    });

    await t.test('another registered agent cannot receive the supplied document by scalar similarity', async () => {
      await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'register', chain: null }));
      const mined = await receipt(f.publicClient, await f.walletClient.writeContract({ address: f.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback',
        args: [1n, 5n, 0, 'evening-plan-usefulness-v0.1', '', '', f.feedbackURI, f.documentValue.documentHash], chain: null }));
      const log = mined.logs.find((entry) => entry.address.toLowerCase() === f.reputationRegistry.toLowerCase())!;
      const result = await read({ ...input, observationBlock: mined.blockNumber, eventRef: {
        blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash, transactionHash: mined.transactionHash,
        transactionIndex: mined.transactionIndex, logIndex: log.logIndex, feedbackURI: f.feedbackURI } });
      assert.equal(result.publication, 'mismatched');
      assert.ok(result.diagnostics.includes('event-agent-mismatch'));
    });

    await t.test('an actually published invalid signature remains distinct from its matching byte commitment', async () => {
      const invalid = encodeFeedbackDocument({ ...f.documentValue.envelope, signature: `0x${'00'.repeat(65)}` });
      const mined = await receipt(f.publicClient, await f.walletClient.writeContract({ address: f.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback',
        args: [0n, 5n, 0, 'evening-plan-usefulness-v0.1', '', '', f.feedbackURI, invalid.documentHash], chain: null }));
      const log = mined.logs.find((entry) => entry.address.toLowerCase() === f.reputationRegistry.toLowerCase())!;
      const result = await read({ ...input, documentBytes: invalid.bytes, observationBlock: mined.blockNumber, eventRef: {
        blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash, transactionHash: mined.transactionHash,
        transactionIndex: mined.transactionIndex, logIndex: log.logIndex, feedbackURI: f.feedbackURI } });
      assert.equal(result.publication, 'matched');
      assert.equal(result.document.signature, 'invalid');
      assert.equal(result.historicalExistence, 'unknown');
      assert.equal(result.historicalOrdering, 'unknown');
    });

    await t.test('receipt failure or sender, destination, and log-coordinate contradictions are mismatches', async () => {
      for (const alter of [
        (r: RpcReply) => { r.result.status = '0x0'; },
        (r: RpcReply) => { r.result.from = f.stranger.address; },
        (r: RpcReply) => { r.result.to = f.identityRegistry; },
        (r: RpcReply) => { r.result.logs[0].transactionHash = otherHash; },
        (r: RpcReply) => { r.result.logs[0].address = f.identityRegistry; },
      ]) await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getTransactionReceipt') alter(reply);
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.publication, 'mismatched');
        assert.equal(result.revocation, 'unknown');
      });
    });

    await t.test('unavailable storage stays unknown, never silently active', async () => {
      await withReadProxy(rpcUrl, (request, reply) => {
        if (callSelector(request) === readSelector) {
          delete reply.result; reply.error = { code: -32000, message: 'historical state unavailable' };
        }
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.publication, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.equal(result.document.decoding, 'valid');
        assert.ok(result.diagnostics.includes('storage-unavailable'));
        const changed = encodeFeedbackDocument(await signFeedback({ ...f.feedbackValue, value: 1 }, f.caller));
        const partial = await read({ ...input, client, documentBytes: changed.bytes });
        assert.equal(partial.publication, 'unavailable', 'partial mismatch must not conceal missing chain evidence');
        assert.ok(partial.diagnostics.includes('document-hash-mismatch'));
        assert.ok(partial.diagnostics.includes('storage-unavailable'));
      });
    });

    await t.test('registry linkage, version and stored scalar contradictions cannot be treated as matching state', async () => {
      const faults = [
        { functionName: 'getIdentityRegistry' as const, value: f.stranger.address, diagnostic: 'linked-identity-mismatch' },
        { functionName: 'getVersion' as const, value: '3.0.0', diagnostic: 'reputation-version-mismatch' },
      ];
      for (const fault of faults) {
        const selector = encodeFunctionData({ abi: reputationRegistryAbi, functionName: fault.functionName }).slice(0, 10);
        await withReadProxy(rpcUrl, (request, reply) => {
          if (callSelector(request) === selector) reply.result = encodeFunctionResult({ abi: reputationRegistryAbi,
            functionName: fault.functionName, result: fault.value });
        }, async (client) => {
          const result = await read({ ...input, client });
          assert.equal(result.publication, 'mismatched');
          assert.equal(result.revocation, 'unknown');
          assert.ok(result.diagnostics.includes(fault.diagnostic));
        });
      }
      await withReadProxy(rpcUrl, (request, reply) => {
        if (callSelector(request) === readSelector) reply.result = encodeFunctionResult({ abi: reputationRegistryAbi,
          functionName: 'readFeedback', result: [1n, 0, 'evening-plan-usefulness-v0.1', '', false] });
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.publication, 'mismatched');
        assert.equal(result.revocation, 'unknown');
        assert.ok(result.diagnostics.includes('stored-projection-mismatch'));
      });
    });

    await t.test('every contract read uses the numbered historical basis, and failed final readbacks remove active qualification', async () => {
      await withReadProxy(rpcUrl, (request) => {
        if (request.method === 'eth_call') assert.equal(request.params[1], `0x${input.observationBlock.toString(16)}`);
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.publication, 'matched');
        assert.equal(result.revocation, 'active');
      });
      let basisReads = 0;
      await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getBlockByNumber' && reply.result?.number === `0x${input.observationBlock.toString(16)}` && ++basisReads >= 3) {
          delete reply.result; reply.error = { code: -32000, message: 'block no longer available' };
        }
      }, async (client) => {
        const result = await read({ ...input, client });
        assert.equal(result.publication, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.ok(result.diagnostics.includes('publication-recheck-unavailable'));
      });
    });

    await t.test('changed observation hash during reads invalidates the qualification', async () => {
      const latest = await f.publicClient.getBlock({ blockTag: 'latest' });
      let reads = 0;
      await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getBlockByNumber' && reply.result?.number === `0x${latest.number!.toString(16)}` && ++reads === 2) {
          reply.result.hash = otherHash;
        }
      }, async (client) => {
        const result = await read({ ...input, client, observationBlock: latest.number! });
        assert.equal(result.publication, 'unavailable');
        assert.equal(result.revocation, 'unknown');
        assert.ok(result.diagnostics.includes('observation-basis-changed'));
      });
    });

    await t.test('publication block is independently rechecked even when the observation block stays unchanged', async () => {
      const latest = await f.publicClient.getBlock({ blockTag: 'latest' });
      let reads = 0;
      await withReadProxy(rpcUrl, (request, reply) => {
        if (request.method === 'eth_getBlockByNumber' && reply.result?.number === `0x${input.observationBlock.toString(16)}` && ++reads === 2) {
          reply.result.hash = otherHash;
        }
      }, async (client) => {
        const result = await read({ ...input, client, observationBlock: latest.number! });
        assert.equal(result.publication, 'orphaned');
        assert.equal(result.revocation, 'unknown');
        assert.equal(result.document.decoding, 'valid');
      });
    });

    await t.test('real local reorg orphans an event while retained exact document remains inspectable', async () => {
      const snapshot = await f.testClient.snapshot();
      const next = await prepareLocalFeedbackPublication(f.input);
      const mined = await submitPreparedFeedback({ ...f.input, prepared: next });
      await f.testClient.revert({ id: snapshot });
      await f.testClient.setNextBlockTimestamp({ timestamp: BigInt(Date.parse(f.at(100)) / 1000) });
      await f.testClient.mine({ blocks: 1 });
      const result = await read({ ...input, observationBlock: BigInt(mined.event.blockNumber),
        eventRef: { ...mined.event, feedbackURI: f.feedbackURI } });
      assert.equal(result.publication, 'orphaned');
      assert.equal(result.revocation, 'unknown');
      assert.equal(result.document.bytesBase64, Buffer.from(f.document).toString('base64'));
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});
