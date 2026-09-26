import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, serializeTransaction, toHex } from 'viem';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistry, registryAbi, receipt } from '../../src/demo/registryFixture.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';
import { signFeedback } from '../../src/feedback/signatures.js';
import { publicationFixture } from './fixtures.js';

const readAbi = parseAbi([
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('owned local feedback publication and restart-safe revocation', async (t) => {
  const writer = await import('../../src/demo/feedbackPublication.js').catch(() => undefined);
  assert.ok(writer, 'local feedback publication writer must be implemented');
  const { prepareLocalFeedbackPublication: prepare, submitPreparedFeedback: submit, prepareLocalFeedbackRevocation: revoke } = writer;
  await withOwnedAnvil(async (rpcUrl) => {
    const f = await publicationFixture(rpcUrl);
    const clients = { publicClient: f.publicClient, walletClient: createWalletClient({ transport: f.transport }) };
    const lastIndex = () => f.publicClient.readContract({ address: f.reputationRegistry, abi: readAbi,
      functionName: 'getLastIndex', args: [0n, f.caller.address] });
    let original: Awaited<ReturnType<typeof prepare>>;
    let originalResult: Awaited<ReturnType<typeof submit>>;

    await t.test('prepare signs exact contract fields without broadcasting; a fresh process submits serialized bytes', async () => {
      original = await prepare(f.input);
      assert.equal(await lastIndex(), 0n);
      assert.equal(original.transactionHash, keccak256(original.rawTransaction));
      assert.equal(parseTransaction(original.rawTransaction).nonce, original.nonce);
      assert.equal(JSON.stringify(original).includes('privateKey'), false);
      const program = `import {createPublicClient,createWalletClient,http} from 'viem';
        import {submitPreparedFeedback} from './src/demo/feedbackPublication.ts';
        const prepared=JSON.parse(process.argv[1]); const transport=http(prepared.rpcUrl,{retryCount:0,timeout:2000});
        const result=await submitPreparedFeedback({publicClient:createPublicClient({transport,pollingInterval:25}),walletClient:createWalletClient({transport}),prepared});
        process.stdout.write(JSON.stringify(result));`;
      const child = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', program, JSON.stringify(original)], { timeout: 20_000 });
      originalResult = JSON.parse(child.stdout) as typeof originalResult;
      assert.equal(originalResult.receipt.transactionHash, original.transactionHash);
      assert.equal(originalResult.event.feedbackIndex, '1');
      assert.equal(originalResult.payer.toLowerCase(), f.caller.address.toLowerCase());
      assert.ok(BigInt(originalResult.gasCostWei) > 0n);
      assert.equal(BigInt(originalResult.gasCostWei), BigInt(originalResult.receipt.gasUsed) * BigInt(originalResult.receipt.effectiveGasPrice));
      assert.deepEqual(await f.publicClient.readContract({ address: f.reputationRegistry, abi: readAbi,
        functionName: 'readFeedback', args: [0n, f.caller.address, 1n] }), [5n, 0, 'evening-plan-usefulness-v0.1', '', false]);
      const mined = await f.publicClient.getTransactionReceipt({ hash: original.transactionHash });
      assert.ok(mined.logs.some((log) => log.data.includes(Buffer.from(f.feedbackURI).toString('hex'))));
      assert.ok(mined.logs.some((log) => log.data.includes(f.documentValue.documentHash.slice(2))));
    });

    await t.test('already-mined serialized submit recovers original receipt and creates no extra operation', async () => {
      assert.deepEqual(await submit({ ...clients, prepared: clone(original) }), originalResult);
      assert.equal(await lastIndex(), 1n);
    });

    await t.test('post-deadline negative publishes without completion, a live provider, or unchanged ownership', async () => {
      await receipt(f.publicClient, await f.ownerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'transferFrom', args: [f.owner.address, f.stranger.address, 0n], chain: null }));
      const feedback = { ...f.feedbackValue, value: 1, createdAt: f.at(62),
        result: { kind: 'no-result-observed' as const, observedAt: f.at(61) } };
      const { completion: _completion, ...input } = f.input;
      const prepared = await prepare({ ...input, document: encodeFeedbackDocument(await signFeedback(feedback, f.caller)).bytes });
      const result = await submit({ ...clients, prepared });
      assert.equal(result.event.feedbackIndex, '2');
      assert.equal(prepared.expectedEvent.eventName, 'NewFeedback');
    });

    await t.test('missing acceptance, corrupt signatures, wrong request caller, and unsupported methods refuse before broadcast', async () => {
      const { acceptance: _acceptance, ...missing } = f.input;
      await assert.rejects(prepare(missing), /acceptance/i);
      await assert.rejects(prepare({ ...f.input, acceptance: { ...f.acceptance, signature: `0x${'00'.repeat(65)}` } }), /acceptanceSignature/i);
      await assert.rejects(prepare({ ...f.input, request: { ...f.request, signer: { ...f.request.signer, address: f.stranger.address.toLowerCase() } } }), /requestSignature|requestCallerBinding/i);
      const unsupported = encodeFeedbackDocument({ ...f.documentValue.envelope, scheme: 'future-method' });
      await assert.rejects(prepare({ ...f.input, document: unsupported.bytes }), /feedbackSignature/i);
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('wrong sender, reviewer, reputation domain, original profile, and time basis refuse', async () => {
      await assert.rejects(prepare({ ...f.input, walletClient: createWalletClient({ account: f.stranger, transport: f.transport }) }), /sender|reviewer/i);
      const wrongReviewer = { ...f.feedbackValue, reviewer: { ...f.feedbackValue.reviewer, address: f.stranger.address.toLowerCase() as `0x${string}` } };
      await assert.rejects(prepare({ ...f.input, document: encodeFeedbackDocument(await signFeedback(wrongReviewer, f.stranger)).bytes,
        walletClient: createWalletClient({ account: f.stranger, transport: f.transport }) }), /reviewerBinding/i);
      const wrongDomain = { ...f.feedbackValue, reputationRegistry: { ...f.feedbackValue.reputationRegistry, address: f.identityRegistry.toLowerCase() as `0x${string}` } };
      await assert.rejects(prepare({ ...f.input, document: encodeFeedbackDocument(await signFeedback(wrongDomain, f.caller)).bytes }), /registryDomain|domain/i);
      await assert.rejects(prepare({ ...f.input, originalProfile: { ...f.originalProfile, cardBytes: new TextEncoder().encode('{}') } }), /card|protocolVersion/i);
      const early = { ...f.feedbackValue, createdAt: f.at(0) };
      await assert.rejects(prepare({ ...f.input, document: encodeFeedbackDocument(await signFeedback(early, f.caller)).bytes }), /claimedTime/i);
    });

    await t.test('wrong linked Identity registry refuses without a transaction', async () => {
      const otherIdentity = await deployRegistry(f.publicClient, f.ownerWallet);
      await assert.rejects(prepare({ ...f.input, identityRegistry: otherIdentity }), /linked|Identity|domain/i);
      await assert.rejects(prepare({ ...f.input, reputationRegistry: f.identityRegistry }), /Reputation|registry/i);
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('unsafe, oversized and non-exact document URI refuses without fetching', async () => {
      for (const uri of ['https://127.0.0.1/doc', 'http://example.invalid/doc', 'http://user:pass@127.0.0.1/doc',
        `${f.feedbackURI}#fragment`, `${f.feedbackURI}&different=1`, 'http://127.0.0.1:39003/feedback/review.json?version=1',
        'http://127.0.0.1:39002/other', `http://127.0.0.1/${'a'.repeat(2048)}`]) {
        await assert.rejects(prepare({ ...f.input, feedbackURI: uri }), /URI|URL|2048|loopback|exact/i);
      }
      await assert.rejects(prepare({ ...f.input, feedbackURI: 'http://127.0.0.1/x#', allowedDocumentURL: 'http://127.0.0.1/x#' }), /fragment|URI|URL/i);
    });

    await t.test('non-loopback and mismatched read/write RPC are refused before external calls', async () => {
      const remote = http('https://example.invalid');
      await assert.rejects(prepare({ ...f.input, publicClient: createPublicClient({ transport: remote }),
        walletClient: createWalletClient({ account: f.caller, transport: remote }) }), /loopback HTTP/i);
      await assert.rejects(prepare({ ...f.input, walletClient: createWalletClient({ account: f.caller,
        transport: http('http://127.0.0.1:1') }) }), /same loopback/i);
      const wrongChain = clone(original);
      wrongChain.domain.chainId = 1 as 31337;
      await assert.rejects(submit({ ...clients, prepared: wrongChain }), /chain|domain/i);
    });

    await t.test('prepared raw bytes, hash, nonce, domain, projection, and document mutation are rejected', async () => {
      for (const mutate of [
        (p: typeof original) => { p.rawTransaction = `${p.rawTransaction.slice(0, -2)}ff` as `0x02${string}`; },
        (p: typeof original) => { p.transactionHash = `0x${'11'.repeat(32)}`; },
        (p: typeof original) => { p.nonce++; },
        (p: typeof original) => { p.domain.reputationRegistry = f.identityRegistry; },
        (p: typeof original) => { p.reviewer = f.stranger.address; },
        (p: typeof original) => { p.expectedEvent.feedbackURI += '&tampered=1'; },
        (p: typeof original) => { p.documentBase64 = Buffer.from('{}').toString('base64'); },
      ]) { const changed = clone(original); mutate(changed); await assert.rejects(submit({ ...clients, prepared: changed })); }
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('a different signed transaction cannot be substituted even with its own computed hash', async () => {
      const decoded = parseTransaction(original.rawTransaction);
      for (const delta of [{ chainId: 1 }, { to: f.stranger.address }, { value: 1n }, { data: '0x' as const }]) {
        const changed = clone(original);
        changed.rawTransaction = await f.caller.signTransaction({ ...decoded, ...delta }) as `0x02${string}`;
        changed.transactionHash = keccak256(changed.rawTransaction);
        await assert.rejects(submit({ ...clients, prepared: changed }), /signed transaction/i);
      }
      const changed = clone(original);
      changed.rawTransaction = await f.stranger.signTransaction(decoded) as `0x02${string}`;
      changed.transactionHash = keccak256(changed.rawTransaction);
      await assert.rejects(submit({ ...clients, prepared: changed }), /signed transaction/i);
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('high-s signature malleation is rejected even when sender recovery and the recomputed hash match', async () => {
      const decoded = parseTransaction(original.rawTransaction);
      assert.ok(decoded.r && decoded.s && decoded.yParity !== undefined);
      const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const changed = clone(original);
      changed.rawTransaction = serializeTransaction(decoded, { r: decoded.r,
        s: toHex(order - BigInt(decoded.s), { size: 32 }), yParity: decoded.yParity === 0 ? 1 : 0 });
      changed.transactionHash = keccak256(changed.rawTransaction);
      assert.equal((await recoverTransactionAddress({ serializedTransaction: changed.rawTransaction })).toLowerCase(), original.reviewer);
      await assert.rejects(submit({ ...clients, prepared: changed }), /canonical|signature/i);
    });

    await t.test('a nonce consumed by a different transaction is explicitly unresolved and never freshly signed', async () => {
      const prepared = await prepare(f.input);
      await receipt(f.publicClient, await f.walletClient.sendTransaction({ to: f.stranger.address, value: 0n,
        nonce: prepared.nonce, chain: null }));
      await assert.rejects(submit({ ...clients, prepared }), /unresolved.*nonce|nonce.*replacement/i);
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('an unmined competing nonce is explicitly unresolved without waiting for replacement mining', async () => {
      const prepared = await prepare(f.input);
      await f.testClient.setAutomine(false);
      try {
        await f.walletClient.sendTransaction({ to: f.stranger.address, value: 0n, nonce: prepared.nonce,
          maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n, chain: null });
        await assert.rejects(submit({ ...clients, prepared }), /unresolved.*nonce|nonce.*replacement/i);
      } finally {
        await f.testClient.mine({ blocks: 1 });
        await f.testClient.setAutomine(true);
      }
      assert.equal(await lastIndex(), 2n);
    });

    await t.test('bounded proxy drops a broadcast and later its mined reply; only the identical raw operation is retried', async () => {
      const rawBroadcasts: string[] = [];
      const proxy = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of request) {
            length += (chunk as Buffer).length;
            if (length > 100_000) throw new Error('bounded proxy request too large');
            chunks.push(chunk as Buffer);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(body) as { method: string; params: string[] };
          if (parsed.method === 'eth_sendRawTransaction') {
            rawBroadcasts.push(parsed.params[0]!);
            if (rawBroadcasts.length === 1) { response.destroy(); return; }
          }
          const forwarded = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body,
            signal: AbortSignal.timeout(2_000) });
          const result = await forwarded.text();
          if (parsed.method === 'eth_sendRawTransaction') { response.destroy(); return; }
          response.setHeader('content-type', 'application/json');
          response.end(result);
        } catch { response.destroy(); }
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const address = proxy.address();
        assert.ok(address && typeof address === 'object');
        const transport = http(`http://127.0.0.1:${address.port}`, { retryCount: 0, timeout: 2_000 });
        const publicClient = createPublicClient({ transport, pollingInterval: 25 });
        const walletClient = createWalletClient({ account: f.caller, transport });
        const prepared = await prepare({ ...f.input, publicClient, walletClient });
        const result = await submit({ publicClient, walletClient: createWalletClient({ transport }), prepared });
        assert.equal(result.receipt.transactionHash, prepared.transactionHash);
        assert.equal(result.event.feedbackIndex, '3');
        assert.deepEqual(rawBroadcasts, [prepared.rawTransaction, prepared.rawTransaction]);
        assert.equal(await lastIndex(), 3n, 'a lost request/reply must not create more than one feedback operation');
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      }
    });

    await t.test('revocation checks original attribution; repeated serialized submission retains original document and receipt', async () => {
      await assert.rejects(revoke({ ...f.input, originalPublication: original, publicationResult: originalResult,
        walletClient: createWalletClient({ account: f.stranger, transport: f.transport }) }), /reviewer/i);
      const changedResult = clone(originalResult);
      changedResult.event.feedbackIndex = '2';
      await assert.rejects(revoke({ ...f.input, originalPublication: original, publicationResult: changedResult }), /original|receipt|event/i);
      const prepared = await revoke({ ...f.input, originalPublication: original, publicationResult: originalResult });
      const result = await submit({ ...clients, prepared: clone(prepared) });
      assert.equal(result.event.feedbackIndex, '1');
      assert.equal(result.event.eventName, 'FeedbackRevoked');
      assert.deepEqual(await submit({ ...clients, prepared: clone(prepared) }), result);
      assert.equal(prepared.originalPublication.documentBase64, original.documentBase64);
      assert.deepEqual(prepared.publicationResult, originalResult);
      assert.deepEqual(await f.publicClient.readContract({ address: f.reputationRegistry, abi: readAbi,
        functionName: 'readFeedback', args: [0n, f.caller.address, 1n] }), [5n, 0, 'evening-plan-usefulness-v0.1', '', true]);
      assert.equal(await lastIndex(), 3n);
    });

    await t.test('current owner self-feedback refuses even with valid historical signatures', async () => {
      // The original provider has transferred ownership; make the historical caller the current owner.
      const strangerWallet = createWalletClient({ account: f.stranger, transport: f.transport });
      await receipt(f.publicClient, await strangerWallet.writeContract({ address: f.identityRegistry, abi: registryAbi,
        functionName: 'transferFrom', args: [f.stranger.address, f.caller.address, 0n], chain: null }));
      await assert.rejects(prepare(f.input), /self.feedback|authorized|owner/i);
    });
  });
});
