import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient, createTestClient, createWalletClient,
  http, parseEther, parseEventLogs, type Address, type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { searchIndexes, type IndexSearchResult } from '../discovery/indexClient.js';
import { verifyDiscoveryAtCurrentChain, verifyDiscoveryWithCard, type BlockRef,
  type IdentityDomain, type ServiceFilter } from '../discovery/verifyDiscovery.js';
import { withOwnedAnvil } from './anvil.js';
import { checkOwnedCancellation, ownedFetch } from './ownedLifecycle.js';
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

export async function listenOwnedServer(server: Server): Promise<string> {
  checkOwnedCancellation();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned loopback listener unavailable');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
const PROXY_MAX_BYTES = 2 * 1024 * 1024;
const PROXY_DEADLINE_MS = 5_000;
async function boundedRequestBytes(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > PROXY_MAX_BYTES) {
    throw new Error('owned proxy request too large');
  }
  const timeout = setTimeout(() => request.destroy(new Error('owned proxy request timed out')),
    PROXY_DEADLINE_MS);
  timeout.unref();
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      length += bytes.byteLength;
      if (length > PROXY_MAX_BYTES) throw new Error('owned proxy request too large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); }
}
async function boundedResponseBytes(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > PROXY_MAX_BYTES) {
    throw new Error('owned proxy response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('owned proxy upstream has no body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > PROXY_MAX_BYTES) {
      await reader.cancel();
      throw new Error('owned proxy response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export function createTamperProxy(upstreamOrigin: string): Server {
  return createServer(async (request, response) => {
    const path = request.url ?? '';
    const search = request.method === 'POST' && path === '/api/ard/services/search';
    const observation = request.method === 'GET' &&
      /^\/api\/ard\/identity-observations\/sha256:[0-9a-f]{64}$/.test(path);
    if (!search && !observation) { response.statusCode = 404; response.end(); return; }
    if (observation && (request.headers['content-length'] || request.headers['transfer-encoding'])) {
      response.statusCode = 400; response.end(); return;
    }
    try {
      const body = search ? await boundedRequestBytes(request) : undefined;
      const upstream = await fetch(new URL(path, upstreamOrigin), {
        method: search ? 'POST' : 'GET', ...(search ? { headers: { 'content-type': 'application/json' },
          body: body!.toString('utf8') } : {}), redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_DEADLINE_MS),
      });
      if (!upstream.ok) throw new Error('owned proxy upstream unavailable');
      const payload = JSON.parse((await boundedResponseBytes(upstream)).toString('utf8')) as Record<string, unknown>;
      if (search) {
        const items = payload['items'] as Array<{ displayName: string }>;
        if (items[0]) items[0].displayName = 'Tampered unverified name';
      } else {
        const item = payload['observation'] as { declaration: { displayName: string } };
        item.declaration.displayName = 'Tampered unverified name';
        payload['observationBytes'] = JSON.stringify(item);
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    } catch (error) {
      if (!response.destroyed) {
        response.statusCode = error instanceof Error && /request too large/.test(error.message) ? 413 : 502;
        response.end('{}');
      }
    }
  });
}
async function waitFor<T>(read: () => Promise<T>, condition: (value: T) => boolean,
  label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    checkOwnedCancellation();
    last = await read();
    if (condition(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(last)?.slice(0, 500)}`);
}
export async function waitForBothWithdrawals(readA: () => Promise<number>,
  readB: () => Promise<number>, expected: number, label: string): Promise<{ a: number; b: number }> {
  return waitFor(async () => ({ a: await readA(), b: await readB() }),
    ({ a, b }) => a === expected && b === expected, label);
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
async function verifiedCandidates(result: IndexSearchResult, client: PublicClient, domain: IdentityDomain,
  filter: ServiceFilter, cardOrigin: string): Promise<number> {
  let accepted = 0;
  for (const candidate of result.candidates) {
    const verdict = await verifyDiscoveryWithCard(candidate, client, domain, filter,
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
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000, fetchFn: ownedFetch });
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
  const trustedDomain = { chainId: 31_337, registry };
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
  const cardOrigin = await listenOwnedServer(cardServer);
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
        const body = await boundedRequestBytes(request);
        const upstream = await fetch(rpcUrl, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body.toString('utf8'), redirect: 'manual',
          signal: AbortSignal.timeout(PROXY_DEADLINE_MS) });
        const bytes = await boundedResponseBytes(upstream);
        response.statusCode = upstream.status;
        response.setHeader('content-type', 'application/json');
        response.end(bytes);
      } catch { if (!response.destroyed) { response.statusCode = 502; response.end('{}'); } }
    });
    const rpcProxyOrigin = await listenOwnedServer(rpcProxy);
    try { return await withOwnedIndexes(indexCheckout, source,
      { A: rpcProxyOrigin, B: rpcUrl }, async (owned) => {
      let a: OwnedIndex = owned.indexes.A;
      const b = owned.indexes.B;
      const initial = await waitFor(async () => ({ aChicago: await search(a.origin, chicago),
        aBoston: await search(a.origin, boston), bChicago: await search(b.origin, chicago),
        bBoston: await search(b.origin, boston) }),
      (value) => [value.aChicago, value.aBoston, value.bChicago, value.bBoston].every((item) => count(item) === 3),
      'six published services');
      const sixPublishedTwoIndexes = await verifiedCandidates(initial.aChicago, chain, trustedDomain,
        { areaServed: [chicago] }, cardOrigin) === 3 &&
        await verifiedCandidates(initial.bBoston, chain, trustedDomain, { areaServed: [boston] }, cardOrigin) === 3;
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
      const updateConverged = await verifiedCandidates(convergence.a, chain, trustedDomain,
        { areaServed: [chicago] }, cardOrigin) === 3 &&
        await verifiedCandidates(convergence.b, chain, trustedDomain, { areaServed: [chicago] }, cardOrigin) === 3;

      await owned.stopA();
      const stoppedAUsedB = count(await search(b.origin, chicago)) === 3 &&
        await verifiedCandidates(await search(b.origin, chicago), chain, trustedDomain,
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
      const tamperProxy = createTamperProxy(a.origin);
      const tamperOrigin = await listenOwnedServer(tamperProxy);
      let tamperRejectedBFallback = false;
      try {
        const tampered = await search(tamperOrigin, chicago);
        const candidate = tampered.candidates[0];
        assert.ok(candidate, 'tampering proxy must return a candidate to independent verifier');
        const verdict = await verifyDiscoveryWithCard(candidate, chain, trustedDomain,
          { areaServed: [chicago] }, (url) => fetchOwnedCard(url, cardOrigin));
        tamperRejectedBFallback = verdict.status === 'rejected' &&
          /displayName/.test(verdict.reason) &&
          await verifiedCandidates(await search(b.origin, chicago), chain, trustedDomain,
            { areaServed: [chicago] }, cardOrigin) === 3;
      } finally { await close(tamperProxy); }

      await receipt(chain, await wallets[0]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'transferFrom', args: [operators[0]!.address,
          operators[1]!.address, BigInt(records[1]!.agentId)], chain: null }));
      const transferCounts = await waitForBothWithdrawals(
        async () => count(await search(a.origin, boston)),
        async () => count(await search(b.origin, boston)), 2, 'transfer withdrawal');
      const transferWithdrawn = transferCounts.a === 2 && transferCounts.b === 2;
      const inactive = published({ ...records[2]!, revision: 2 }, 31_337, registry, false);
      await receipt(chain, await wallets[1]!.writeContract({ address: registry,
        abi: registryAbi, functionName: 'setAgentURI', args: [BigInt(inactive.agentId), inactive.agentURI], chain: null }));
      const inactiveCounts = await waitForBothWithdrawals(
        async () => count(await search(a.origin, chicago)),
        async () => count(await search(b.origin, chicago)), 2, 'inactive withdrawal');
      const inactiveWithdrawn = inactiveCounts.a === 2 && inactiveCounts.b === 2;

      rpcAvailable = false;
      const unavailableA = await waitFor(() => search(a.origin, chicago), (item) =>
        item.origins[0]?.coverage?.identitySources[0]?.availability === 'unavailable',
      'A follower RPC outage');
      const availableB = await search(b.origin, chicago);
      const outageDistinct = count(unavailableA) === 2 && count(availableB) === 2 &&
        availableB.origins[0]?.coverage?.identitySources[0]?.availability === 'available' &&
        await verifiedCandidates(availableB, chain, trustedDomain, { areaServed: [chicago] }, cardOrigin) === 2;
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
      const staleVerdict = await verifyDiscoveryAtCurrentChain(staleCandidate, chain, trustedDomain,
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
