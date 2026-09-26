import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { prepareLocalFeedbackPublication, prepareLocalFeedbackRevocation, submitPreparedFeedback } from '../../src/demo/feedbackPublication.js';
import { published as publishProfile, receipt, registryAbi } from '../../src/demo/registryFixture.js';
import { boundRpcFetch } from '../../src/identity/rpcTransport.js';
import { decodeEnvelope, signRequest } from '../../src/interaction/signatures.js';
import type { CityRequest } from '../../src/interaction/schema.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';
import { readFeedbackPublication } from '../../src/feedback/publication.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';
import { signFeedback } from '../../src/feedback/signatures.js';
import { encodeSupportingBundle } from '../../src/feedback/supportingBundle.js';
import { publicationFixture } from './fixtures.js';

const otherHash = `0x${'12'.repeat(32)}` as Hex;
const ownerSelector = encodeFunctionData({ abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
  functionName: 'ownerOf', args: [0n] }).slice(0, 10);
const uriSelector = encodeFunctionData({ abi: parseAbi(['function tokenURI(uint256) view returns (string)']),
  functionName: 'tokenURI', args: [0n] }).slice(0, 10);
type RpcMessage = { method: string; params: unknown[] };
type RpcReply = { result?: any; error?: unknown; id: number; jsonrpc: string };
const selector = (message: RpcMessage) => message.method === 'eth_call'
  ? (message.params[0] as { data: string }).data.slice(0, 10) : '';

/** All observations forward to real owned Anvil. Only selected RPC faults are altered. */
function readClient(rpcUrl: string, originalBlock: bigint, observationBlock: bigint,
  alter: (message: RpcMessage, reply: RpcReply) => void = () => {}, violations: unknown[] = []) {
  const calls: RpcMessage[] = [];
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 5_000,
    fetchFn: boundRpcFetch(async (url, init) => {
      const message = JSON.parse(String(init?.body)) as RpcMessage;
      calls.push(message);
      try {
        assert.equal(String(url), new URL(rpcUrl).href, 'no provider, card, document or external URL fetch');
        assert.ok(calls.length <= 64, 'one reader invocation has a finite read budget');
        assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call'].includes(message.method),
          `read-only explicit RPC method: ${message.method}`);
        if (message.method === 'eth_getBlockByNumber') assert.match(String(message.params[0]), /^0x[0-9a-f]+$/);
        if (message.method === 'eth_call') {
          const basis = [ownerSelector, uriSelector].includes(selector(message)) ? originalBlock : observationBlock;
          assert.equal(message.params[1], `0x${basis.toString(16)}`, 'no current provider authority or implicit latest');
        }
      } catch (error) { violations.push(error); throw error; }
      const response = await fetch(url, init);
      const reply = await response.json() as RpcReply;
      alter(message, reply);
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    }) }) });
  return { client, calls };
}

test('independent retained-feedback historical composition on owned Anvil', async (t) => {
  const module = await import('../../src/feedback/historicalRead.js').catch(() => undefined);
  assert.ok(module, 'independent historical feedback reader must be implemented');
  const { readHistoricalFeedback: read } = module;
  const violations: unknown[] = [];
  t.afterEach(() => assert.deepEqual(violations.splice(0), [], 'RPC contract assertions must not be swallowed as unavailable'));
  await withOwnedAnvil(async (rpcUrl) => {
    const f = await publicationFixture(rpcUrl);
    const prepared = await prepareLocalFeedbackPublication(f.input);
    const published = await submitPreparedFeedback({ ...f.input, prepared });
    const genesis = await f.publicClient.getBlock({ blockNumber: 0n });
    assert.ok(genesis.hash);
    const domain = { chainId: 31337, identityRegistry: f.identityRegistry,
      reputationRegistry: f.reputationRegistry, genesisHash: genesis.hash };
    const request = decodeEnvelope(f.request).statement.value as CityRequest;
    const originalBlock = BigInt(request.profileBasis.blockNumber);
    const observationBlock = BigInt(published.event.blockNumber);
    const bundle = { version: '0.1', request: f.request, acceptance: f.acceptance, completion: f.completion,
      cardBase64: Buffer.from(f.originalProfile.cardBytes).toString('base64') };
    const input = { domain, eventRef: { ...published.event, feedbackURI: f.feedbackURI },
      documentBytes: f.document, bundleBytes: encodeSupportingBundle(bundle).bytes, observationBlock };
    const observe = (block = observationBlock, alter?: (message: RpcMessage, reply: RpcReply) => void) =>
      readClient(rpcUrl, originalBlock, block, alter, violations);

    await t.test('exact retained evidence composes separate JSON-safe findings without echoing private bytes', async () => {
      const result = await read({ ...input, ...observe() });
      assert.deepEqual(result.bundle, { availability: 'available', diagnostics: [] });
      assert.equal(result.originalAuthority.status, 'matched');
      assert.equal(result.originalAuthority.qualification, 'rpc-derived-not-state-proof');
      assert.equal(result.originalAuthority.basis?.blockNumber, request.profileBasis.blockNumber);
      assert.equal(result.originalAuthority.basis?.blockHash, request.profileBasis.blockHash);
      assert.equal(result.historical.status, 'evaluated');
      if (result.historical.status !== 'evaluated') assert.fail('history must be evaluated');
      assert.equal(result.historical.findings.originalProfileBasis, 'matched');
      assert.equal(result.historical.findings.resultEvidence, 'matched');
      assert.equal(result.historical.findings.completionClaimedOutcome, 'completed');
      assert.equal(result.historical.findings.historicalExistence, 'unknown');
      assert.equal(result.historical.findings.historicalOrdering, 'unknown');
      assert.equal(result.historical.findings.publication, 'not-evaluated');
      assert.equal(result.answerEvidence, 'not-supplied');
      assert.deepEqual(result.publication, await readFeedbackPublication({ ...input, ...observe() }));
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      const exported = JSON.stringify(result);
      assert.ok(!exported.includes(bundle.cardBase64));
      assert.ok(!exported.includes(f.request.payloadBase64));
      assert.ok(!exported.includes('Low carb'));
    });

    await t.test('absent, incomplete and malformed bundles leave the public publication observation available', async () => {
      for (const [bundleBytes, availability, reason] of [
        [null, 'absent', 'bundle-absent'],
        [new TextEncoder().encode('{"version":"0.1"}'), 'incomplete', 'bundle-incomplete'],
        [new TextEncoder().encode('{"request":null,"private":"not echoed"}'), 'malformed', 'bundle-malformed'],
      ] as const) {
        const result = await read({ ...input, ...observe(), bundleBytes });
        assert.equal(result.bundle.availability, availability);
        assert.equal(result.publication.publication, 'matched');
        assert.equal(result.originalAuthority.status, 'unavailable');
        assert.deepEqual(result.historical, { status: 'not-evaluated', reason });
        assert.ok(!JSON.stringify(result).includes('not echoed'));
      }
    });

    await t.test('missing completion and post-deadline no-result claims keep their narrower pure findings', async () => {
      const { completion: _, ...withoutCompletion } = bundle;
      const bundleBytes = encodeSupportingBundle(withoutCompletion).bytes;
      const absent = await read({ ...input, ...observe(), bundleBytes });
      assert.equal(absent.historical.status, 'evaluated');
      if (absent.historical.status !== 'evaluated') assert.fail();
      assert.equal(absent.historical.findings.completionSignature, 'not-present');
      assert.equal(absent.historical.findings.resultEvidence, 'unavailable');
      const noResult = encodeFeedbackDocument(await signFeedback({ ...f.feedbackValue, createdAt: f.at(70),
        result: { kind: 'no-result-observed', observedAt: f.at(65) } }, f.caller));
      const claimed = await read({ ...input, ...observe(), bundleBytes, documentBytes: noResult.bytes });
      assert.equal(claimed.publication.publication, 'mismatched');
      assert.equal(claimed.historical.status, 'evaluated');
      if (claimed.historical.status !== 'evaluated') assert.fail();
      assert.equal(claimed.historical.findings.resultEvidence, 'post-deadline-reviewer-claim');
      assert.equal(claimed.answerEvidence, 'not-supplied');
    });

    await t.test('missing or malformed public bytes are explicit, and changed valid bytes still get signed findings', async () => {
      for (const [documentBytes, reason] of [[null, 'document-unavailable'],
        [new TextEncoder().encode('{}'), 'document-malformed']] as const) {
        const result = await read({ ...input, ...observe(), documentBytes });
        assert.equal(result.bundle.availability, 'available');
        assert.deepEqual(result.historical, { status: 'not-evaluated', reason });
        assert.equal(result.publication.revocation, 'active');
      }
      const changed = encodeFeedbackDocument(await signFeedback({ ...f.feedbackValue, value: 1 }, f.caller));
      const result = await read({ ...input, ...observe(), documentBytes: changed.bytes });
      assert.equal(result.publication.publication, 'mismatched');
      assert.equal(result.originalAuthority.status, 'matched');
      assert.equal(result.historical.status, 'evaluated');
    });

    await t.test('request and feedback selected-domain contradictions are checked before reading either identity subject', async () => {
      const requestVariants = [
        { ...request, service: { ...request.service, agent: { ...request.service.agent, registry: f.stranger.address.toLowerCase() as Hex } } },
        { ...request, service: { ...request.service, agent: { ...request.service.agent, chainId: 1 } },
          caller: { ...request.caller, chainId: 1 } },
      ];
      for (const requestValue of requestVariants) {
        const transport = observe();
        const result = await read({ ...input, ...transport, bundleBytes: encodeSupportingBundle({ ...bundle,
          request: await signRequest(requestValue, f.caller) }).bytes });
        assert.equal(result.originalAuthority.status, 'mismatched');
        assert.ok(result.originalAuthority.diagnostics.includes('request-domain-mismatch'));
        assert.ok(!transport.calls.some((call) => [ownerSelector, uriSelector].includes(selector(call))));
      }
      for (const agent of [{ ...f.feedbackValue.service.agent, chainId: 1 },
        { ...f.feedbackValue.service.agent, registry: f.stranger.address.toLowerCase() as Hex }]) {
        const document = encodeFeedbackDocument(await signFeedback({ ...f.feedbackValue,
          service: { method: 'erc8004', agent }, reviewer: { ...f.feedbackValue.reviewer, chainId: agent.chainId },
          reputationRegistry: { ...f.feedbackValue.reputationRegistry, chainId: agent.chainId } }, f.caller));
        const transport = observe();
        const result = await read({ ...input, ...transport, documentBytes: document.bytes });
        assert.equal(result.originalAuthority.status, 'mismatched');
        assert.ok(result.originalAuthority.diagnostics.includes('feedback-domain-mismatch'));
        assert.ok(!transport.calls.some((call) => [ownerSelector, uriSelector].includes(selector(call))));
      }
    });

    await t.test('chain/genesis authority checks are independent of publication and retain valid signatures on failure', async () => {
      for (const patch of [{ chainId: 1 }, { genesisHash: otherHash }, { identityRegistry: f.stranger.address }]) {
        const result = await read({ ...input, ...observe(), domain: { ...domain, ...patch } });
        assert.equal(result.originalAuthority.status, 'mismatched');
        assert.equal(result.historical.status, 'evaluated');
        if (result.historical.status !== 'evaluated') assert.fail();
        assert.equal(result.historical.findings.originalProfileBasis, 'unavailable');
        assert.equal(result.historical.findings.requestSignature, 'valid');
      }
      // Corrupt only the first genesis read: a later healthy publication check may
      // not substitute for the original-authority check (or vice versa).
      let genesisReads = 0;
      const transport = observe(observationBlock, (message, reply) => {
        if (message.method === 'eth_getBlockByNumber' && message.params[0] === '0x0' && ++genesisReads === 1) reply.result.hash = otherHash;
      });
      const result = await read({ ...input, ...transport });
      assert.equal(genesisReads, 2);
      assert.equal(result.originalAuthority.status, 'mismatched');
      assert.equal(result.publication.publication, 'matched');
    });

    await t.test('returned original block number and hash are both checked against the signed basis', async () => {
      for (const field of ['number', 'hash'] as const) {
        const transport = observe(observationBlock, (message, reply) => {
          if (message.method === 'eth_getBlockByNumber' && message.params[0] === `0x${originalBlock.toString(16)}`) {
            reply.result[field] = field === 'number' ? `0x${(originalBlock - 1n).toString(16)}` : otherHash;
          }
        });
        const result = await read({ ...input, ...transport });
        assert.equal(result.originalAuthority.status, 'mismatched');
        assert.ok(result.originalAuthority.diagnostics.includes('original-basis-mismatch'));
        assert.equal(result.historical.status, 'evaluated');
        if (result.historical.status !== 'evaluated') assert.fail();
        assert.equal(result.historical.findings.originalProfileBasis, 'unavailable');
      }
      const altered = await signRequest({ ...request, profileBasis: { ...request.profileBasis, blockHash: otherHash } }, f.caller);
      const result = await read({ ...input, ...observe(), bundleBytes: encodeSupportingBundle({ ...bundle, request: altered }).bytes });
      assert.equal(result.originalAuthority.status, 'mismatched');
    });

    await t.test('snapshot reader cannot follow an RPC-selected wrong number after a matching first basis read', async () => {
      let originalReads = 0;
      const transport = observe(observationBlock, (message, reply) => {
        if (message.method === 'eth_getBlockByNumber' && message.params[0] === `0x${originalBlock.toString(16)}` && ++originalReads === 2) {
          reply.result.number = `0x${(originalBlock - 1n).toString(16)}`;
        }
      });
      const result = await read({ ...input, ...transport });
      assert.equal(result.originalAuthority.status, 'mismatched');
      assert.ok(result.originalAuthority.diagnostics.includes('original-basis-mismatch'));
      assert.ok(!transport.calls.some((call) => [ownerSelector, uriSelector].includes(selector(call))),
        'reject the contradictory header before following its subject-read number');
    });

    await t.test('altered cards and signed profile commitments cannot become original authority', async () => {
      const cardBase64 = Buffer.from('{}').toString('base64');
      const alteredCard = await read({ ...input, ...observe(), bundleBytes: encodeSupportingBundle({ ...bundle, cardBase64 }).bytes });
      assert.equal(alteredCard.originalAuthority.status, 'mismatched');
      assert.ok(alteredCard.originalAuthority.diagnostics.includes('original-profile-mismatch'));
      const altered = await signRequest({ ...request, profileBasis: { ...request.profileBasis, agentUriDigest: otherHash } }, f.caller);
      const result = await read({ ...input, ...observe(), bundleBytes: encodeSupportingBundle({ ...bundle, request: altered }).bytes });
      assert.equal(result.originalAuthority.status, 'mismatched');
      assert.equal(result.historical.status, 'evaluated');
      if (result.historical.status !== 'evaluated') assert.fail();
      assert.equal(result.historical.findings.originalProfileBasis, 'unavailable');
    });

    await t.test('archive failure and unsupported large profile ID keep authority unavailable with stable diagnostics', async () => {
      const unavailable = observe(observationBlock, (message, reply) => {
        if ([ownerSelector, uriSelector].includes(selector(message))) {
          delete reply.result; reply.error = { code: -32000, message: 'private transport detail must not escape' };
        }
      });
      const result = await read({ ...input, ...unavailable });
      assert.equal(result.originalAuthority.status, 'unavailable');
      assert.ok(result.originalAuthority.diagnostics.includes('original-snapshot-unavailable'));
      assert.equal(result.publication.publication, 'matched');
      assert.ok(!JSON.stringify(result).includes('private transport detail'));
      const large = await signRequest({ ...request, service: { ...request.service,
        agent: { ...request.service.agent, agentId: '9007199254740992' } } }, f.caller);
      const transport = observe();
      const unsupported = await read({ ...input, ...transport, bundleBytes: encodeSupportingBundle({ ...bundle, request: large }).bytes });
      assert.equal(unsupported.originalAuthority.status, 'unavailable');
      assert.ok(unsupported.originalAuthority.diagnostics.includes('profile-agent-id-unsupported'));
      assert.ok(!transport.calls.some((call) => [ownerSelector, uriSelector].includes(selector(call))));
    });

    await t.test('post-composition original basis change or loss removes authority and recomputes pure findings with null', async () => {
      for (const mode of ['changed', 'unavailable']) {
        let receiptSeen = false;
        const transport = observe(observationBlock, (message, reply) => {
          if (message.method === 'eth_getTransactionReceipt') receiptSeen = true;
          if (receiptSeen && message.method === 'eth_getBlockByNumber' && message.params[0] === `0x${originalBlock.toString(16)}`) {
            if (mode === 'changed') reply.result.hash = otherHash;
            else { delete reply.result; reply.error = { code: -32000, message: 'original block pruned' }; }
          }
        });
        const result = await read({ ...input, ...transport });
        assert.equal(result.originalAuthority.status, mode === 'changed' ? 'mismatched' : 'unavailable');
        assert.ok(result.originalAuthority.diagnostics.includes(mode === 'changed' ? 'original-basis-changed' : 'original-recheck-unavailable'));
        assert.equal(result.publication.publication, 'matched');
        assert.equal(result.historical.status, 'evaluated');
        if (result.historical.status !== 'evaluated') assert.fail();
        assert.equal(result.historical.findings.originalProfileBasis, 'unavailable');
        assert.equal(result.historical.findings.requestSignature, 'valid');
        assert.equal(result.historical.findings.resultEvidence, 'matched');
      }
    });

    await t.test('malformed caller configuration fails explicitly rather than implying authority', async () => {
      await assert.rejects(read({ ...input, ...observe(), observationBlock: undefined as unknown as bigint }), /observationBlock|numbered/);
      await assert.rejects(read({ ...input, ...observe(), domain: { ...domain, genesisHash: '0x' } }), /domain/);
    });

    await t.test('signature-invalid committed document is distinct from matched publication bytes', async () => {
      const document = encodeFeedbackDocument({ ...f.documentValue.envelope, signature: `0x${'00'.repeat(65)}` });
      const mined = await receipt(f.publicClient, await f.walletClient.writeContract({ address: f.reputationRegistry,
        abi: reputationRegistryAbi, functionName: 'giveFeedback',
        args: [0n, 5n, 0, 'evening-plan-usefulness-v0.1', '', '', f.feedbackURI, document.documentHash], chain: null }));
      const log = mined.logs.find((entry) => entry.address.toLowerCase() === f.reputationRegistry.toLowerCase())!;
      const result = await read({ ...input, ...observe(mined.blockNumber), observationBlock: mined.blockNumber,
        documentBytes: document.bytes, eventRef: { blockNumber: mined.blockNumber.toString(), blockHash: mined.blockHash,
          transactionHash: mined.transactionHash, transactionIndex: mined.transactionIndex, logIndex: log.logIndex!, feedbackURI: f.feedbackURI } });
      assert.equal(result.publication.publication, 'matched');
      assert.equal(result.originalAuthority.status, 'matched');
      assert.equal(result.historical.status, 'evaluated');
      if (result.historical.status !== 'evaluated') assert.fail();
      assert.equal(result.historical.findings.feedbackSignature, 'invalid');
      assert.equal(result.historical.findings.resultEvidence, 'mismatched');
    });

    await t.test('expired deadline and later owner, URI, runtime rotation require no current provider', async () => {
      const rotated = publishProfile({ agentId: '0', owner: f.owner, city: 'Chicago', cardUrl: 'http://127.0.0.1:39001/card',
        invocationUrl: 'http://127.0.0.1:39001/retired', revision: 2, cardBytes: new Uint8Array(), agentURI: '' },
      31337, f.identityRegistry, true, f.stranger.address);
      await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'setAgentURI', args: [0n, rotated.agentURI], chain: null }));
      await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'transferFrom', args: [f.owner.address, f.stranger.address, 0n], chain: null }));
      await f.testClient.setNextBlockTimestamp({ timestamp: BigInt(Date.parse(f.at(100)) / 1000) });
      await f.testClient.mine({ blocks: 1 });
      const block = await f.publicClient.getBlockNumber({ cacheTime: 0 });
      const result = await read({ ...input, ...observe(block), observationBlock: block });
      assert.equal(result.originalAuthority.status, 'matched');
      assert.equal(result.publication.publication, 'matched');
      assert.equal(result.historical.status, 'evaluated');
      if (result.historical.status !== 'evaluated') assert.fail();
      assert.equal(result.historical.findings.originalProfileBasis, 'matched');
      assert.equal(result.historical.findings.resultEvidence, 'matched');
      assert.equal(result.historical.findings.historicalOrdering, 'unknown');
    });

    await t.test('revocation and orphaned or unavailable publication do not erase signed history', async () => {
      const revocation = await prepareLocalFeedbackRevocation({ ...f.input, originalPublication: prepared, publicationResult: published });
      const revoked = await submitPreparedFeedback({ ...f.input, prepared: revocation });
      const block = BigInt(revoked.receipt.blockNumber);
      const result = await read({ ...input, ...observe(block), observationBlock: block });
      assert.equal(result.publication.revocation, 'revoked');
      assert.equal((await read({ ...input, ...observe() })).publication.revocation, 'active');
      assert.equal(result.originalAuthority.status, 'matched');
      assert.equal(result.historical.status, 'evaluated');
      const unavailable = await read({ ...input, ...observe(), eventRef: { ...input.eventRef, transactionHash: otherHash } });
      assert.equal(unavailable.publication.publication, 'unavailable');
      assert.equal(unavailable.originalAuthority.status, 'matched');
      assert.equal(unavailable.historical.status, 'evaluated');
      const snapshot = await f.testClient.snapshot();
      const next = await prepareLocalFeedbackPublication(f.input);
      const mined = await submitPreparedFeedback({ ...f.input, prepared: next });
      await f.testClient.revert({ id: snapshot });
      await f.testClient.setNextBlockTimestamp({ timestamp: BigInt(Date.parse(f.at(200)) / 1000) });
      await f.testClient.mine({ blocks: 1 });
      const orphanedBlock = BigInt(mined.event.blockNumber);
      const orphaned = await read({ ...input, ...observe(orphanedBlock), observationBlock: orphanedBlock,
        eventRef: { ...mined.event, feedbackURI: f.feedbackURI } });
      assert.equal(orphaned.publication.publication, 'orphaned');
      assert.equal(orphaned.originalAuthority.status, 'matched');
      assert.equal(orphaned.historical.status, 'evaluated');
      if (orphaned.historical.status !== 'evaluated') assert.fail();
      assert.equal(orphaned.historical.findings.resultEvidence, 'matched');
      assert.equal(orphaned.historical.findings.historicalExistence, 'unknown');
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_700_000_000n } });
});
