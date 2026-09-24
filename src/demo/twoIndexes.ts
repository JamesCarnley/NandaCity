import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient, createTestClient, createWalletClient,
  http, parseEther, parseEventLogs, type Address, type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { searchIndexes, type IndexSearchResult } from '../discovery/indexClient.js';
import { verifyDiscoveryAtCurrentChain, verifyDiscoveryWithCard, type BlockRef,
  type ServiceFilter } from '../discovery/verifyDiscovery.js';
import { withOwnedAnvil } from './anvil.js';
import { INDEX_SOURCE_COMMIT, withOwnedIndexes, type OwnedIndex } from './indexProcesses.js';
import { boston, chicago, deployRegistry, published, receipt, registryAbi,
  type CardRecord } from './registryFixture.js';
export type TwoIndexDemoResult = {
  mode: 'local-fixture'; cityCommit: string; cityWorkingTreeDirty: boolean;
  indexCommit: string; chainId: number; registry: Address; qualifiedRegistry: string;
  contactedOrigins: [string, string]; checkpoints: [BlockRef, BlockRef];
  acceptance: {
    sixPublishedTwoIndexes: boolean; updateConverged: boolean; stoppedAUsedB: boolean;
    restartedAOwnCheckpoint: boolean; emptyARebuilt: boolean; tamperRejectedBFallback: boolean;
    transferWithdrawn: boolean; inactiveWithdrawn: boolean; outageDistinct: boolean;
    reorgConverged: boolean; reorgStaleRejected: boolean;
  };
  limitations: string[]; cleanup: { ownedResourcesStopped: true };
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned loopback listener unavailable');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function waitFor<T>(read: () => Promise<T>, condition: (value: T) => boolean,
  label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (condition(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(last)?.slice(0, 500)}`);
}
export async function fetchOwnedCard(url: string, allowedOrigin: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.origin !== allowedOrigin || parsed.protocol !== 'http:' ||
    parsed.username || parsed.password || parsed.hash || parsed.search ||
    !/^\/cards\/[0-9]+\.json$/.test(parsed.pathname)) {
    throw new Error('card URL outside owned exact loopback allowlist');
  }
  const response = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`owned card HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('owned card has no response body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 64 * 1024) { await reader.cancel(); throw new Error('owned card exceeds 64 KiB'); }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function verifiedCandidates(result: IndexSearchResult, client: PublicClient,
  filter: ServiceFilter, cardOrigin: string): Promise<number> {
  let accepted = 0;
  for (const candidate of result.candidates) {
    const verdict = await verifyDiscoveryWithCard(candidate, client, filter,
      (url) => fetchOwnedCard(url, cardOrigin));
    if (verdict.status === 'verified') accepted += 1;
  }
  return accepted;
}
async function search(origin: string, area: string): Promise<IndexSearchResult> {
  return searchIndexes([origin], { areaServed: [area] });
}
function count(result: IndexSearchResult): number { return result.candidates.length; }
function checkpoint(result: IndexSearchResult): BlockRef | null {
  return (result.origins[0]?.coverage?.identitySources[0]?.checkpoint ?? null) as BlockRef | null;
}

async function scenario(rpcUrl: string, indexCheckout: string): Promise<Omit<TwoIndexDemoResult,
  'cleanup' | 'cityCommit' | 'cityWorkingTreeDirty'>> {
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
  const chain = createPublicClient({ transport, pollingInterval: 50 });
  const test = createTestClient({ mode: 'anvil', transport });
  const adminAccount = privateKeyToAccount(generatePrivateKey());
  const operators = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
  for (const account of [adminAccount, ...operators]) {
    await test.setBalance({ address: account.address, value: parseEther('100') });
  }
  const admin = createWalletClient({ account: adminAccount, transport });
  const wallets = operators.map((account) => createWalletClient({ account, transport }));
  const registry = await deployRegistry(chain, admin);
  const genesis = await chain.getBlock({ blockNumber: 0n });
  assert.ok(genesis.hash);
  const cards = new Map<string, Uint8Array>();
  const cardServer = createServer((request, response) => {
    const id = /^\/cards\/([0-9]+)\.json$/.exec(request.url ?? '')?.[1];
    const bytes = id ? cards.get(id) : undefined;
    response.statusCode = bytes ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(bytes ?? '{}');
  });
  const cardOrigin = await listen(cardServer);
  try {
    const records: CardRecord[] = [];
    for (let operator = 0; operator < 3; operator++) {
      for (const city of ['Chicago', 'Boston'] as const) {
        const wallet = wallets[operator]!;
        const mined = await receipt(chain, await wallet.writeContract({ address: registry,
          abi: registryAbi, functionName: 'register', chain: null }));
        const logs = parseEventLogs({ abi: registryAbi, eventName: 'Registered',
          logs: mined.logs, strict: true });
        assert.equal(logs.length, 1);
        const agentId = logs[0]!.args.agentId.toString();
        const record = published({ agentId, owner: operators[operator]!, city,
          cardUrl: `${cardOrigin}/cards/${agentId}.json`,
          invocationUrl: `${cardOrigin}/invoke/${agentId}`, revision: 1,
          cardBytes: new Uint8Array(), agentURI: '' }, 31_337, registry);
        cards.set(agentId, record.cardBytes);
        await receipt(chain, await wallet.writeContract({ address: registry, abi: registryAbi,
          functionName: 'setAgentURI', args: [BigInt(agentId), record.agentURI], chain: null }));
        records.push(record);
      }
    }
    const source = { chainId: 31_337, registry, genesisHash: genesis.hash,
      startBlock: '0', adapter: 'nandacity-0.1' as const, confirmations: 0 };
    let rpcAvailable = true;
    const rpcProxy = createServer(async (request, response) => {
      if (!rpcAvailable) { response.statusCode = 503; response.end('unavailable'); return; }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          length += bytes.byteLength;
          if (length > 2 * 1024 * 1024) throw new Error('RPC request too large');
          chunks.push(bytes);
        }
        const upstream = await fetch(rpcUrl, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks).toString('utf8'), redirect: 'manual',
          signal: AbortSignal.timeout(5_000) });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('RPC response too large');
        response.statusCode = upstream.status;
        response.setHeader('content-type', 'application/json');
        response.end(bytes);
      } catch { response.statusCode = 502; response.end('{}'); }
    });
    const rpcProxyOrigin = await listen(rpcProxy);
    try { return await withOwnedIndexes(indexCheckout, source,
      { A: rpcProxyOrigin, B: rpcUrl }, async (owned) => {
      let a: OwnedIndex = owned.indexes.A;
      const b = owned.indexes.B;
      const initial = await waitFor(async () => ({ aChicago: await search(a.origin, chicago),
        aBoston: await search(a.origin, boston), bChicago: await search(b.origin, chicago),
        bBoston: await search(b.origin, boston) }),
      (value) => [value.aChicago, value.aBoston, value.bChicago, value.bBoston].every((item) => count(item) === 3),
      'six published services');
      const sixPublishedTwoIndexes = await verifiedCandidates(initial.aChicago, chain,
        { areaServed: [chicago] }, cardOrigin) === 3 &&
        await verifiedCandidates(initial.bBoston, chain, { areaServed: [boston] }, cardOrigin) === 3;
      const originalCheckpointA = checkpoint(initial.aChicago)!;

      const updated = published({ ...records[0]!, revision: 2,
        invocationUrl: `${cardOrigin}/invoke/${records[0]!.agentId}/updated` }, 31_337, registry);
      records[0] = updated; cards.set(updated.agentId, updated.cardBytes);
      await receipt(chain, await wallets[0]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(updated.agentId), updated.agentURI], chain: null }));
      const convergence = await waitFor(async () => ({ a: await search(a.origin, chicago),
        b: await search(b.origin, chicago) }),
      (value) => [value.a, value.b].every((item) => item.candidates.some((candidate) =>
        candidate.agent.agentId === updated.agentId && candidate.agentURI === updated.agentURI)),
      'updated endpoint convergence');
      const updateConverged = await verifiedCandidates(convergence.a, chain,
        { areaServed: [chicago] }, cardOrigin) === 3 &&
        await verifiedCandidates(convergence.b, chain, { areaServed: [chicago] }, cardOrigin) === 3;

      await owned.stopA();
      const stoppedAUsedB = count(await search(b.origin, chicago)) === 3 &&
        await verifiedCandidates(await search(b.origin, chicago), chain,
          { areaServed: [chicago] }, cardOrigin) === 3;
      a = await owned.restartA();
      const recovered = await waitFor(() => search(a.origin, chicago), (item) => count(item) === 3 &&
        item.candidates.some((candidate) => candidate.agent.agentId === updated.agentId &&
          candidate.agentURI === updated.agentURI), 'A checkpoint restart');
      const restartedAOwnCheckpoint = BigInt(checkpoint(recovered)!.number) >= BigInt(originalCheckpointA.number);
      a = await owned.rebuildA();
      const rebuilt = await waitFor(() => search(a.origin, chicago), (item) => count(item) === 3 &&
        item.candidates.some((candidate) => candidate.agent.agentId === updated.agentId &&
          candidate.agentURI === updated.agentURI), 'A empty-database rebuild');
      const emptyARebuilt = count(rebuilt) === 3 && count(await search(b.origin, chicago)) === 3;

      // Labeled, owned proxy changes the same meaningful declaration in search and
      // immutable-observation envelopes so rejection reaches independent verification.
      const tamperProxy = createServer(async (request, response) => {
        try {
          const target = new URL(request.url ?? '/', a.origin);
          const body = await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => resolve(Buffer.concat(chunks)));
          });
          const upstream = await fetch(target, { method: request.method ?? 'GET',
            ...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' },
              body: body.toString('utf8') } : {}), redirect: 'manual' });
          const payload = await upstream.json() as Record<string, unknown>;
          if (target.pathname.endsWith('/services/search')) {
            const items = payload['items'] as Array<{ displayName: string }>;
            if (items[0]) items[0].displayName = 'Tampered unverified name';
          } else if (target.pathname.includes('/identity-observations/')) {
            const observation = payload['observation'] as { declaration: { displayName: string } };
            observation.declaration.displayName = 'Tampered unverified name';
            payload['observationBytes'] = JSON.stringify(observation);
          }
          response.statusCode = upstream.status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(payload));
        } catch { response.statusCode = 502; response.end('{}'); }
      });
      const tamperOrigin = await listen(tamperProxy);
      let tamperRejectedBFallback = false;
      try {
        const tampered = await search(tamperOrigin, chicago);
        const candidate = tampered.candidates[0];
        assert.ok(candidate, 'tampering proxy must return a candidate to independent verifier');
        const verdict = await verifyDiscoveryWithCard(candidate, chain,
          { areaServed: [chicago] }, (url) => fetchOwnedCard(url, cardOrigin));
        tamperRejectedBFallback = verdict.status === 'rejected' &&
          /displayName/.test(verdict.reason) &&
          await verifiedCandidates(await search(b.origin, chicago), chain,
            { areaServed: [chicago] }, cardOrigin) === 3;
      } finally { await close(tamperProxy); }

      await receipt(chain, await wallets[0]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'transferFrom', args: [operators[0]!.address,
          operators[1]!.address, BigInt(records[1]!.agentId)], chain: null }));
      await waitFor(() => search(b.origin, boston), (item) => count(item) === 2,
        'transfer withdrawal');
      const transferWithdrawn = count(await search(a.origin, boston)) === 2;
      const inactive = published({ ...records[2]!, revision: 2 }, 31_337, registry, false);
      await receipt(chain, await wallets[1]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(inactive.agentId), inactive.agentURI], chain: null }));
      await waitFor(() => search(b.origin, chicago), (item) => count(item) === 2,
        'inactive withdrawal');
      const inactiveWithdrawn = count(await search(a.origin, chicago)) === 2;

      rpcAvailable = false;
      const unavailableA = await waitFor(() => search(a.origin, chicago), (item) =>
        item.origins[0]?.coverage?.identitySources[0]?.availability === 'unavailable',
      'A follower RPC outage');
      const availableB = await search(b.origin, chicago);
      const outageDistinct = count(unavailableA) === 2 && count(availableB) === 2 &&
        availableB.origins[0]?.coverage?.identitySources[0]?.availability === 'available' &&
        await verifiedCandidates(availableB, chain, { areaServed: [chicago] }, cardOrigin) === 2;
      rpcAvailable = true;
      await waitFor(() => search(a.origin, chicago), (item) =>
        item.origins[0]?.coverage?.identitySources[0]?.availability === 'available',
      'A follower RPC recovery');

      const snapshotId = await test.snapshot();
      const old = records[4]!;
      const reorgVersion = published({ ...old, revision: 2 }, 31_337, registry);
      await receipt(chain, await wallets[2]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(old.agentId), reorgVersion.agentURI], chain: null }));
      const staleA = await waitFor(() => search(a.origin, chicago), (item) => item.candidates.some((candidate) =>
        candidate.agent.agentId === old.agentId && candidate.agentURI === reorgVersion.agentURI), 'pre-reorg update');
      await waitFor(() => search(b.origin, chicago), (item) => item.candidates.some((candidate) =>
        candidate.agent.agentId === old.agentId && candidate.agentURI === reorgVersion.agentURI), 'pre-reorg B');
      await test.revert({ id: snapshotId });
      await test.mine({ blocks: 1 });
      const afterReorg = await waitFor(async () => ({ a: await search(a.origin, chicago),
        b: await search(b.origin, chicago) }), (value) => [value.a, value.b].every((item) =>
        item.candidates.some((candidate) => candidate.agent.agentId === old.agentId &&
          candidate.agentURI === old.agentURI)), 'reorganization replay', 45_000);
      const reorgConverged = count(afterReorg.a) === 2 && count(afterReorg.b) === 2;
      const staleCandidate = staleA.candidates.find((candidate) => candidate.agent.agentId === old.agentId)!;
      const staleVerdict = await verifyDiscoveryAtCurrentChain(staleCandidate, chain,
        reorgVersion.cardBytes, { areaServed: [chicago] });
      const reorgStaleRejected = staleVerdict.status === 'rejected' &&
        /canonical chain/.test(staleVerdict.reason);
      return { mode: 'local-fixture', indexCommit: INDEX_SOURCE_COMMIT,
        chainId: 31_337, registry,
        qualifiedRegistry: `eip155:31337:${registry.toLowerCase()}`,
        contactedOrigins: [a.origin, b.origin],
        checkpoints: [checkpoint(afterReorg.a)!, checkpoint(afterReorg.b)!],
        acceptance: { sixPublishedTwoIndexes, updateConverged, stoppedAUsedB,
          restartedAOwnCheckpoint, emptyARebuilt, tamperRejectedBFallback,
          transferWithdrawn, inactiveWithdrawn, outageDistinct, reorgConverged,
          reorgStaleRejected },
        limitations: ['Simulated operators and loopback AgentCards only.',
          'No A2A invocation, live city API, receipt, reputation, or public-chain write.',
          'RPC reads are not cryptographic state proofs.'], };
    }); } finally { await close(rpcProxy); }
  } finally { await close(cardServer); }
}

/** Starts only owned local resources; exported result is recorded after cleanup. */
export async function runTwoIndexDemo(indexCheckout: string): Promise<TwoIndexDemoResult> {
  const cityRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const cityCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cityRoot,
    encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } }).trim();
  const cityWorkingTreeDirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: cityRoot, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } }).trim() !== '';
  const marker = { blockNumber: 0n,
    timestamp: BigInt(Math.floor(Date.now() / 1_000)) + BigInt(randomBytes(3).readUIntBE(0, 3)) };
  const owned = await withOwnedAnvil((rpcUrl) => scenario(rpcUrl, indexCheckout),
    { genesisMarker: marker });
  return { ...owned.value, cityCommit, cityWorkingTreeDirty,
    cleanup: { ownedResourcesStopped: true } };
}
