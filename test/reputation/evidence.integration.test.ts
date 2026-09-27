import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTestClient, createWalletClient, http, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { CITY_REQUEST_DATA_TYPE } from '../../src/a2a/service.js';
import { a2aTaskSchema } from '../../src/a2a/wire.js';
import { withSixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import type { FixtureService, SixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import { withPrivateBundleFile } from '../../src/demo/privateBundleFile.js';
import { registryAbi } from '../../src/demo/registryFixture.js';
import { listenOwnedServer } from '../../src/demo/twoIndexes.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';
import { readIndexFeedbackHistory } from '../../src/feedback/indexClient.js';
import { reputationRegistryAbi } from '../../src/feedback/registry.js';
import { encodeSupportingBundle } from '../../src/feedback/supportingBundle.js';
import { digestBytes } from '../../src/identity/profile.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { verifyProfile } from '../../src/identity/verify.js';
import { decodeEnvelope } from '../../src/interaction/signatures.js';
import { envelopeSchema, type CityRequest, type SignedEnvelope } from '../../src/interaction/schema.js';
import { readRankingEvidence } from '../../src/reputation/evidence.js';
import type { PolicyInput, PolicyResult } from '../../src/reputation/policy.js';

const execFileAsync = promisify(execFile);

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections(); });
}

type WorkerOutput = { policyInput: PolicyInput | null; policyResult: PolicyResult | null };

async function freshConsumer(input: unknown): Promise<WorkerOutput> {
  const worker = fileURLToPath(new URL('./fixtures/rankingEvidenceWorker.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), detached: true,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outLength = 0, errLength = 0, failed = false;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { failed = true; kill(); }, 130_000);
    child.stdout.on('data', (chunk: Buffer) => {
      outLength += chunk.length;
      if (outLength > 8 * 1024 * 1024) { failed = true; kill(); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errLength += chunk.length;
      if (errLength > 64 * 1024) { failed = true; kill(); return; }
      stderr.push(chunk);
    });
    child.once('error', () => { failed = true; });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        if (failed || code !== 0 || stderr.length) throw new Error();
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as WorkerOutput;
        if (!Object.hasOwn(parsed, 'policyInput') || !Object.hasOwn(parsed, 'policyResult')) throw new Error();
        resolve(parsed);
      } catch { reject(new Error('fresh ranking consumer failed')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function forwardIndex(upstream: string,
  mutate: (path: string, payload: Record<string, unknown>) => void | Promise<void>): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => { void (async () => {
    const path = request.url ?? '/';
    const found = await fetch(new URL(path, upstream), { method: 'GET', redirect: 'manual',
      headers: { accept: '*/*', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(5_000) });
    const bytes = Buffer.from(await found.arrayBuffer());
    let output = bytes;
    if (found.status === 200 && path.includes('/agents/')) {
      const payload = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      await mutate(path, payload); output = Buffer.from(JSON.stringify(payload));
    }
    response.statusCode = found.status;
    response.setHeader('content-type', found.headers.get('content-type') ?? 'application/octet-stream');
    response.end(output);
  })().catch(() => { response.statusCode = 502; response.end('{}'); }); });
  const origin = await listenOwnedServer(server);
  return { origin, close: () => closeServer(server) };
}

async function forwardRpc(upstream: string,
  mutate: (request: { method?: string; params?: unknown[] }, reply: Record<string, any>) => void):
  Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { void (async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const message = JSON.parse(text) as { method?: string; params?: unknown[] };
      const found = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: text, signal: AbortSignal.timeout(5_000) });
      const reply = await found.json() as Record<string, any>;
      mutate(message, reply);
      response.statusCode = found.status; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply));
    })().catch(() => { response.statusCode = 502; response.end('{}'); }); });
  });
  const origin = await listenOwnedServer(server);
  return { origin, close: () => closeServer(server) };
}

async function publishOpaqueFeedback(fixture: SixServiceFixture, service: FixtureService, input: {
  documentHash: `0x${string}`; tag1: string; tag2?: string; uri: string;
}): Promise<{ transactionHash: `0x${string}` }> {
  assert.ok(fixture.feedback);
  const control = createTestClient({ mode: 'anvil', transport: http(fixture.rpcOrigin) });
  await control.impersonateAccount({ address: fixture.callerAddress });
  await control.setBalance({ address: fixture.callerAddress, value: parseEther('1') });
  const wallet = createWalletClient({ account: fixture.callerAddress, transport: http(fixture.rpcOrigin) });
  try {
    const transactionHash = await wallet.writeContract({ address: fixture.feedback.provenance.domain.reputationRegistry,
      abi: reputationRegistryAbi, functionName: 'giveFeedback',
      args: [BigInt(service.agent.agentId), 5n, 0, input.tag1, input.tag2 ?? '', '', input.uri, input.documentHash], chain: null });
    const receipt = await fixture.chain.waitForTransactionReceipt({ hash: transactionHash, timeout: 10_000 });
    assert.equal(receipt.status, 'success'); return { transactionHash };
  } finally { await control.stopImpersonatingAccount({ address: fixture.callerAddress }); }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error('active native Town command was not observed');
}

async function createTownBundle(fixture: SixServiceFixture, service: FixtureService,
  checkout: string, python: string, root: string): Promise<{ bundle: string; observer: string }> {
  const observerDirectory = join(root, 'observer');
  const observerName = 'city-ranking-observer';
  const options = { cwd: checkout, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' },
    timeout: 35_000, killSignal: 'SIGKILL' as const, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const };
  const script = ['from nandatown.identity_portable import Keystore',
    `print(Keystore(${JSON.stringify(observerDirectory)}).new_identity(${JSON.stringify(observerName)})["agent_id"])`].join(';');
  const observer = (await execFileAsync(python, ['-I', '-B', '-c', script], options)).stdout.trim();
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const deadline = new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z');
  const source = service.profile.source;
  const request: CityRequest = { kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: service.agent },
    caller: { method: 'eip155-eoa', chainId: fixture.domain.chainId,
      address: fixture.callerAddress.toLowerCase() as `0x${string}` },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: { blockNumber: source.blockNumber, blockHash: source.blockHash,
      agentOwner: source.agentOwner.toLowerCase() as `0x${string}`, agentUriDigest: source.agentUriDigest,
      registrationDigest: source.registrationDigest, cardDigest: source.cardDigest,
      receiptSigner: service.runtimeAddress.toLowerCase() as `0x${string}` },
    createdAt, deadline,
    input: { version: '0.1', capability: 'evening-plan', city: service.city,
      area: service.city === 'Chicago' ? 'The Loop' : 'Back Bay',
      timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
        timeZone: 'America/Chicago' }, budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'], preferences: ['Fixture request'] },
  };
  const signed = await fixture.signAsCaller(request);
  const requestBytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'ranking-town-request',
    method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: randomUUID(),
      parts: [{ kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope: signed } }] },
    configuration: { blocking: false, acceptedOutputModes: ['application/json'] } } }));
  const cardFile = join(root, 'card.json'), requestFile = join(root, 'request.json');
  await writeFile(cardFile, service.cardBytes, { mode: 0o600 });
  await writeFile(requestFile, requestBytes, { mode: 0o600 });
  const run = await execFileAsync(python, ['-I', '-B', '-m', 'nandatown.city_path',
    '--subject-url', service.serviceUrl, '--card-url', `${fixture.cardOrigin}/cards/${service.agent.agentId}.json`,
    '--pinned-card', cardFile, '--request', requestFile, '--out-dir', join(root, 'bundles'),
    '--observer-key-dir', observerDirectory, '--observer-name', observerName], options);
  const summary = JSON.parse(run.stdout) as { bundle: string; verdict: string };
  assert.equal(summary.verdict, 'passed');
  return { bundle: summary.bundle, observer };
}

async function completedInteraction(fixture: SixServiceFixture, service: FixtureService): Promise<{
  request: SignedEnvelope; acceptance: SignedEnvelope; completion: SignedEnvelope;
  requestValue: CityRequest;
}> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const deadline = new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z');
  const source = service.profile.source;
  const requestValue: CityRequest = { kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: service.agent },
    caller: { method: 'eip155-eoa', chainId: fixture.domain.chainId,
      address: fixture.callerAddress.toLowerCase() as Address },
    interactionId: `0x${randomBytes(32).toString('hex')}`,
    profileBasis: { blockNumber: source.blockNumber, blockHash: source.blockHash,
      agentOwner: source.agentOwner.toLowerCase() as Address, agentUriDigest: source.agentUriDigest,
      registrationDigest: source.registrationDigest, cardDigest: source.cardDigest,
      receiptSigner: service.runtimeAddress.toLowerCase() as Address },
    createdAt, deadline,
    input: { version: '0.1', capability: 'evening-plan', city: service.city,
      area: service.city === 'Chicago' ? 'The Loop' : 'Back Bay',
      timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
        timeZone: 'America/Chicago' }, budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'], preferences: ['Fixture feedback'] },
  };
  const request = await fixture.signAsCaller(requestValue);
  const response = await fetch(service.serviceUrl, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'message/send', params: {
      message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
        data: { type: CITY_REQUEST_DATA_TYPE, version: '0.1', envelope: request } }] },
      configuration: { blocking: false, acceptedOutputModes: ['application/json'] } } }) });
  assert.equal(response.status, 200);
  const submitted = a2aTaskSchema.parse((await response.json() as { result: unknown }).result);
  const end = Date.now() + 20_000;
  let terminal = submitted;
  while (!['completed', 'failed'].includes(terminal.status.state) && Date.now() < end) {
    const found = await fetch(service.serviceUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000), body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(),
        method: 'tasks/get', params: { id: submitted.id } }) });
    terminal = a2aTaskSchema.parse((await found.json() as { result: unknown }).result);
    if (!['completed', 'failed'].includes(terminal.status.state)) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminal.status.state, 'completed');
  const metadata = terminal.metadata?.['org.nandacity'] as Record<string, unknown>;
  return { request, requestValue, acceptance: envelopeSchema.parse(metadata['acceptance']),
    completion: envelopeSchema.parse(metadata['completion']) };
}

async function waitForHistory(fixture: SixServiceFixture, service: FixtureService, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const histories = await Promise.all(Object.values(fixture.indexOrigins).map((origin) =>
      readIndexFeedbackHistory({ origin, source: fixture.feedback!.source,
        agentId: service.agent.agentId, reviewer: fixture.callerAddress.toLowerCase() as Address })));
    if (histories.every((result) => result.history.filter((entry) => entry.decoded.kind === 'NewFeedback').length === count)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('owned Indexes did not retain expected feedback history');
}

async function retireAndRestoreRuntime(fixture: SixServiceFixture, service: FixtureService): Promise<{
  blockNumber: bigint; blockHash: `0x${string}`;
}> {
  const control = createTestClient({ mode: 'anvil', transport: http(fixture.rpcOrigin) });
  await control.impersonateAccount({ address: service.ownerAddress });
  await control.setBalance({ address: service.ownerAddress, value: parseEther('1') });
  const wallet = createWalletClient({ account: service.ownerAddress, transport: http(fixture.rpcOrigin) });
  const original = service.profile.registration;
  const replacement = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const uri = (receiptSigner: string, revision: number) => `data:application/json;base64,${Buffer.from(JSON.stringify({
    ...original, registrations: original.registrations.map((entry) => ({ ...entry, agentId: Number(entry.agentId) })),
    'x-nandacity': { ...original['x-nandacity'], receiptSigner, revision },
  })).toString('base64')}`;
  let latest: { blockNumber: bigint; blockHash: `0x${string}` } | undefined;
  try {
    for (const [receiptSigner, revision] of [[replacement, original['x-nandacity'].revision + 1],
      [service.runtimeAddress.toLowerCase(), original['x-nandacity'].revision + 2]] as const) {
      const hash = await wallet.writeContract({ address: service.agent.registry, abi: registryAbi,
        functionName: 'setAgentURI', args: [BigInt(service.agent.agentId), uri(receiptSigner, revision)], chain: null });
      const receipt = await fixture.chain.waitForTransactionReceipt({ hash, timeout: 10_000 });
      assert.equal(receipt.status, 'success');
      latest = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    }
  } finally { await control.stopImpersonatingAccount({ address: service.ownerAddress }); }
  assert.ok(latest); return latest;
}

async function shareCardWithService(fixture: SixServiceFixture, source: FixtureService,
  target: FixtureService): Promise<{ blockNumber: bigint; blockHash: `0x${string}` }> {
  const control = createTestClient({ mode: 'anvil', transport: http(fixture.rpcOrigin) });
  await control.impersonateAccount({ address: target.ownerAddress });
  await control.setBalance({ address: target.ownerAddress, value: parseEther('1') });
  const wallet = createWalletClient({ account: target.ownerAddress, transport: http(fixture.rpcOrigin) });
  const original = target.profile.registration;
  const registration = { ...original,
    registrations: original.registrations.map((entry) => ({ ...entry, agentId: Number(entry.agentId) })),
    services: original.services.map((entry) => entry.name === 'A2A'
      ? { ...entry, endpoint: `${fixture.cardOrigin}/cards/${target.agent.agentId}.json` } : entry),
    'x-nandacity': { ...original['x-nandacity'], endpoint: source.serviceUrl,
      cardDigest: digestBytes(source.cardBytes), revision: original['x-nandacity'].revision + 1 } };
  try {
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
    const hash = await wallet.writeContract({ address: target.agent.registry, abi: registryAbi,
      functionName: 'setAgentURI', args: [BigInt(target.agent.agentId), uri], chain: null });
    const receipt = await fixture.chain.waitForTransactionReceipt({ hash, timeout: 10_000 });
    assert.equal(receipt.status, 'success');
    return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
  } finally { await control.stopImpersonatingAccount({ address: target.ownerAddress }); }
}

async function serveCardOverrides(fixture: SixServiceFixture,
  overrides: ReadonlyMap<string, Uint8Array>): Promise<{ close: () => Promise<void> }> {
  await fixture.stopCards();
  const cards = new Map(fixture.services.map((entry) =>
    [entry.agent.agentId, overrides.get(entry.agent.agentId) ?? entry.cardBytes]));
  const replacement = createServer((request, response) => {
    const id = /^\/cards\/([0-9]+)\.json$/.exec(request.url ?? '')?.[1];
    const bytes = id ? cards.get(id) : undefined; response.statusCode = bytes ? 200 : 404;
    response.setHeader('content-type', 'application/json'); response.end(bytes ?? '{}');
  });
  const origin = new URL(fixture.cardOrigin);
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject); replacement.listen(Number(origin.port), '127.0.0.1', resolve);
  });
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= closeServer(replacement) };
}

async function migrateEndpoint(fixture: SixServiceFixture, service: FixtureService,
  closeCards?: () => Promise<void>): Promise<{
  blockNumber: bigint; blockHash: `0x${string}`; cardBytes: Uint8Array; close: () => Promise<void>;
}> {
  if (closeCards) await closeCards(); else await fixture.stopCards();
  const changedUrl = `http://127.0.0.1:1/${'retired-town-endpoint-'.repeat(8)}`;
  const changedCard = new TextEncoder().encode(JSON.stringify({ ...service.profile.card, url: changedUrl }));
  const cards = new Map(fixture.services.map((entry) => [entry.agent.agentId,
    entry.agent.agentId === service.agent.agentId ? changedCard : entry.cardBytes]));
  const replacement = createServer((request, response) => {
    const id = /^\/cards\/([0-9]+)\.json$/.exec(request.url ?? '')?.[1];
    const bytes = id ? cards.get(id) : undefined; response.statusCode = bytes ? 200 : 404;
    response.setHeader('content-type', 'application/json'); response.end(bytes ?? '{}');
  });
  const origin = new URL(fixture.cardOrigin);
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject); replacement.listen(Number(origin.port), '127.0.0.1', resolve);
  });
  const control = createTestClient({ mode: 'anvil', transport: http(fixture.rpcOrigin) });
  await control.impersonateAccount({ address: service.ownerAddress });
  await control.setBalance({ address: service.ownerAddress, value: parseEther('1') });
  const wallet = createWalletClient({ account: service.ownerAddress, transport: http(fixture.rpcOrigin) });
  const original = service.profile.registration;
  const registration = { ...original,
    registrations: original.registrations.map((entry) => ({ ...entry, agentId: Number(entry.agentId) })),
    'x-nandacity': { ...original['x-nandacity'], endpoint: changedUrl,
      cardDigest: digestBytes(changedCard), revision: original['x-nandacity'].revision + 1 } };
  try {
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
    const hash = await wallet.writeContract({ address: service.agent.registry, abi: registryAbi,
      functionName: 'setAgentURI', args: [BigInt(service.agent.agentId), uri], chain: null });
    const receipt = await fixture.chain.waitForTransactionReceipt({ hash, timeout: 10_000 });
    assert.equal(receipt.status, 'success');
    return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, cardBytes: changedCard,
      close: () => closeServer(replacement) };
  } catch (error) { await closeServer(replacement); throw error; }
  finally { await control.stopImpersonatingAccount({ address: service.ownerAddress }); }
}

test('two fresh consumers derive the same six-service two-city policy input from raw sources',
  { timeout: 420_000 }, async () => {
    const indexCheckout = process.env['NANDA_INDEX_CHECKOUT'];
    const townCheckout = process.env['NANDATOWN_CHECKOUT'];
    const townPython = process.env['NANDATOWN_PYTHON'];
    assert.ok(indexCheckout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    assert.ok(townCheckout, 'NANDATOWN_CHECKOUT must identify the pinned Town checkout');
    assert.ok(townPython, 'NANDATOWN_PYTHON must identify the pinned Python interpreter');
    await withSixServiceFixture(indexCheckout, async (fixture) => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-ranking-town-'));
      await chmod(root, 0o700);
      try {
        assert.ok(fixture.feedback, 'feedback-enabled fixture missing');
        const chicago = fixture.services.filter((entry) => entry.city === 'Chicago');
        const [service, reusedService] = chicago;
        assert.ok(service && reusedService);
        const sharedCards = await serveCardOverrides(fixture,
          new Map([[reusedService.agent.agentId, service.cardBytes]]));
        try {
          const shared = await shareCardWithService(fixture, service, reusedService);
          const refreshed = await readIdentitySnapshot(fixture.chain, service.agent, shared.blockNumber);
          service.profile = verifyProfile({ agent: service.agent, agentURI: refreshed.agentURI,
            cardBytes: service.cardBytes }, refreshed);
          const town = await createTownBundle(fixture, service, townCheckout, townPython, root);
          const observation = await fixture.chain.getBlock();
        const blockTag = `0x${observation.number.toString(16)}`;
        let exactReads = 0, faultAt: number | null = null;
        const proxy = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => { void (async () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const message = JSON.parse(text) as { method?: string; params?: unknown[] };
            const upstream = await fetch(fixture.rpcOrigin, { method: 'POST',
              headers: { 'content-type': 'application/json' }, body: text });
            const reply = await upstream.json() as { result?: { hash?: string } };
            if (message.method === 'eth_getBlockByNumber' && message.params?.[0] === blockTag && ++exactReads === faultAt && reply.result) {
              reply.result.hash = `0x${'11'.repeat(32)}`;
            }
            response.statusCode = 200; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply));
          })().catch(() => { response.statusCode = 500; response.end('{}'); }); });
        });
        const proxyOrigin = await listenOwnedServer(proxy);
        try {
        const curator = 'fixture-curator';
        const raw = {
        rpcOrigin: proxyOrigin,
        provenance: fixture.feedback.provenance,
        identityDomain: fixture.domain,
        cardOrigin: fixture.cardOrigin,
        observation: { blockNumber: observation.number.toString(), blockHash: observation.hash },
        indexes: [
          { origin: fixture.indexOrigins.A, source: fixture.feedback.source },
          { origin: fixture.indexOrigins.B, source: fixture.feedback.source },
        ] as const,
        policy: { id: 'fixture-policy', version: '0.1', reviewers: [], groups: [],
          curators: [curator], evaluators: [town.observer] },
        scope: { city: 'Chicago', task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' },
        services: fixture.services.map(({ agent }) => ({ agent,
          ...([service.agent.agentId, reusedService.agent.agentId].includes(agent.agentId)
            ? { townBundleDirectory: town.bundle } : {}) })),
        privateBundleFiles: [],
        curatorInclusions: fixture.services.map(({ agent }) => ({ curator, agent })),
        townRuntime: { checkout: townCheckout, python: townPython },
      };
      exactReads = 0;
      const first = await freshConsumer(raw);
      const firstExactReads = exactReads;
      exactReads = 0;
      const second = await freshConsumer(raw);
      assert.equal(exactReads, firstExactReads);
      assert.deepEqual(second, first);
      assert.ok(first.policyInput);
      assert.ok(first.policyResult);
      assert.equal(first.policyInput.candidates.length, 6);
      assert.deepEqual(new Set(first.policyInput.candidates.map((candidate) => candidate.city)),
        new Set(['Chicago', 'Boston']));
      assert.equal(first.policyInput.candidates.filter((candidate) => candidate.city === 'Chicago').length, 3);
      assert.equal(first.policyInput.candidates.filter((candidate) => candidate.city === 'Boston').length, 3);
      assert.equal(first.policyResult.selection.newcomers.length, 3,
        JSON.stringify(first.policyResult.candidates.map(({ service, profile, history, view, warnings }) =>
          ({ service, profile, history, view, warnings }))));
      assert.equal(first.policyResult.selection.excluded.length, 3);
      assert.deepEqual(first.policyResult.selection.rated, []);
      const townAdmissions = first.policyInput.admissions.filter((entry) => entry.kind === 'test');
      assert.equal(townAdmissions.length, 2);
      assert.equal(new Set(townAdmissions.map((entry) => entry.id)).size, 2);
      assert.equal(townAdmissions.find((entry) => entry.service.endsWith(`/${service.agent.agentId}`))?.status, 'valid');
      assert.equal(townAdmissions.find((entry) => entry.service.endsWith(`/${reusedService.agent.agentId}`))?.status, 'invalid');
      const reusedResult = first.policyResult.candidates.find((candidate) =>
        candidate.service.endsWith(`/${reusedService.agent.agentId}`));
      assert.ok(reusedResult?.admissions.some((entry) => entry.kind === 'test' && entry.reason === 'invalid-evidence'));
      exactReads = 0; faultAt = firstExactReads;
      const changed = await freshConsumer(raw);
      assert.equal(exactReads, firstExactReads);
      assert.equal(changed.policyInput, null); assert.equal(changed.policyResult, null);
      faultAt = null; exactReads = 0;
      const boston = await freshConsumer({ ...raw,
        scope: { city: 'Boston', task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' } });
      assert.equal(boston.policyResult?.selection.newcomers.length, 3);
      assert.equal(boston.policyResult?.selection.excluded.length, 3);
      const later = await migrateEndpoint(fixture, service, sharedCards.close);
      try {
        const changedSnapshot = await readIdentitySnapshot(fixture.chain, service.agent, later.blockNumber);
        verifyProfile({ agent: service.agent, agentURI: changedSnapshot.agentURI, cardBytes: later.cardBytes }, changedSnapshot);
        const expired = await readRankingEvidence({ ...raw,
          observation: { blockNumber: later.blockNumber, blockHash: later.blockHash } });
        assert.equal(expired.snapshot, 'matched'); assert.ok(expired.policyInput); assert.ok(expired.policyResult);
        assert.equal(expired.policyInput.admissions.some((entry) => entry.kind === 'test' &&
          entry.service.endsWith(`/${service.agent.agentId}`)), false);
        const rejected = expired.sidecar.town.find((entry) => entry.service.endsWith(`/${service.agent.agentId}`));
        assert.equal(rejected?.admission, 'invalid');
        assert.ok(rejected?.codes.includes('policy-admission-unrepresentable'));
      } finally { await later.close(); }
        } finally { await closeServer(proxy); }
        } finally { await sharedCards.close(); }
      } finally { await rm(root, { recursive: true, force: true }); }
    }, { feedback: { documentUrls: [] } });
  });

test('fresh consumers independently map retained signed reviews and missing private evidence',
  { timeout: 420_000 }, async () => {
    const indexCheckout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(indexCheckout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    const documents = new Map<string, Uint8Array>();
    const server = createServer((request, response) => {
      const bytes = documents.get(request.url ?? '');
      response.statusCode = bytes ? 200 : 404;
      response.setHeader('content-type', 'application/json'); response.end(bytes ?? '{}');
    });
    const documentOrigin = await listenOwnedServer(server);
    const urls = [`${documentOrigin}/low`, `${documentOrigin}/revoked`, `${documentOrigin}/missing`, `${documentOrigin}/current`];
    try {
      await withSixServiceFixture(indexCheckout, async (fixture) => {
        assert.ok(fixture.feedback);
        const chicago = fixture.services.filter((service) => service.city === 'Chicago');
        const reviewer = fixture.callerAddress.toLowerCase() as Address;
        const publish = async (service: FixtureService, path: string, rating: number) => {
          const interaction = await completedInteraction(fixture, service);
          const request = decodeEnvelope(interaction.request).statement;
          const acceptance = decodeEnvelope(interaction.acceptance).statement;
          const completion = decodeEnvelope(interaction.completion).statement;
          const document = encodeFeedbackDocument(await fixture.feedback!.sign({ kind: 'feedback', version: '0.1',
            service: interaction.requestValue.service, reviewer: interaction.requestValue.caller,
            interactionId: interaction.requestValue.interactionId, requestDigest: request.digest,
            acceptanceDigest: acceptance.digest,
            reputationRegistry: { chainId: fixture.feedback!.source.chainId,
              address: fixture.feedback!.source.reputationRegistry },
            rubric: 'evening-plan-usefulness-v0.1', value: rating,
            createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            result: { kind: 'completion', completionDigest: completion.digest } }));
          documents.set(path, document.bytes);
          const snapshot = await readIdentitySnapshot(fixture.chain, service.agent,
            BigInt(interaction.requestValue.profileBasis.blockNumber));
          const submission = await fixture.feedback!.publish({ document: document.bytes, feedbackURI: `${documentOrigin}${path}`,
            originalProfile: { agent: service.agent, agentURI: snapshot.agentURI, cardBytes: service.cardBytes },
            request: interaction.request, acceptance: interaction.acceptance, completion: interaction.completion });
          return { document, interaction, submission, originalProfile: { agent: service.agent,
            agentURI: snapshot.agentURI, cardBytes: service.cardBytes }, bundle: encodeSupportingBundle({ version: '0.1',
            request: interaction.request, acceptance: interaction.acceptance, completion: interaction.completion,
            cardBase64: Buffer.from(service.cardBytes).toString('base64') }) };
        };
        const low = await publish(chicago[0]!, '/low', 1);
        await fixture.feedback.publish({ document: low.document.bytes, feedbackURI: `${documentOrigin}/low`,
          originalProfile: low.originalProfile, request: low.interaction.request,
          acceptance: low.interaction.acceptance, completion: low.interaction.completion });
        const revoked = await publish(chicago[0]!, '/revoked', 1);
        await fixture.feedback.revoke(revoked.submission.receipt.transactionHash);
        const missing = await publish(chicago[1]!, '/missing', 1);
        const current = await publish(chicago[2]!, '/current', 1);
        await Promise.all([waitForHistory(fixture, chicago[0]!, 3), waitForHistory(fixture, chicago[1]!, 1),
          waitForHistory(fixture, chicago[2]!, 1)]);
        await retireAndRestoreRuntime(fixture, chicago[0]!);
        await fixture.indexes.stop('A');
        await withPrivateBundleFile(low.bundle.bytes, async (lowPath) => {
          await withPrivateBundleFile(revoked.bundle.bytes, async (revokedPath) => {
            await withPrivateBundleFile(current.bundle.bytes, async (currentPath) => {
          const observation = await fixture.chain.getBlock();
          const curator = 'fixture-curator';
          const raw = { rpcOrigin: fixture.rpcOrigin, provenance: fixture.feedback!.provenance,
            identityDomain: fixture.domain, cardOrigin: fixture.cardOrigin,
            observation: { blockNumber: observation.number.toString(), blockHash: observation.hash },
            indexes: [{ origin: fixture.indexOrigins.A, source: fixture.feedback!.source },
              { origin: fixture.indexOrigins.B, source: fixture.feedback!.source }],
            policy: { id: 'review-policy', version: '0.1', reviewers: [reviewer],
              groups: [{ key: 'fixture-reviewers', reviewers: [reviewer] }], curators: [curator], evaluators: [] },
            scope: { city: 'Chicago', task: 'evening-plan', rubric: 'evening-plan-usefulness-v0.1' },
            services: fixture.services.map(({ agent }) => ({ agent })),
            privateBundleFiles: [{ documentHash: low.document.documentHash, path: lowPath },
              { documentHash: revoked.document.documentHash, path: revokedPath },
              { documentHash: current.document.documentHash, path: currentPath },
              { documentHash: missing.document.documentHash, path: null }],
            curatorInclusions: fixture.services.map(({ agent }) => ({ curator, agent })) };
          const first = await freshConsumer(raw), second = await freshConsumer(raw);
          assert.deepEqual(second, first);
          assert.ok(first.policyInput); assert.ok(first.policyResult);
          assert.equal(first.policyInput.reviews.length, 5);
          assert.equal(first.policyResult.selection.rated.length, 1);
          assert.equal(first.policyResult.selection.unresolved.length, 1);
          assert.equal(first.policyResult.selection.unassessed.length, 1);
          const lowReview = first.policyInput.reviews.find((review) => review.documentDigest === low.document.documentHash);
          assert.equal(lowReview?.checks.result, 'signed-completion'); assert.equal(lowReview?.epoch, 'retired');
          const currentReview = first.policyInput.reviews.find((review) => review.documentDigest === current.document.documentHash);
          assert.equal(currentReview?.epoch, 'same');
          const missingReview = first.policyInput.reviews.find((review) => review.documentDigest === missing.document.documentHash);
          assert.equal(missingReview?.checks.originalAuthority, 'unknown');
          const target = first.policyResult.candidates.find((candidate) => candidate.service ===
            `eip155:${chicago[0]!.agent.chainId}/erc721:${chicago[0]!.agent.registry.toLowerCase()}/${chicago[0]!.agent.agentId}`);
          assert.ok(target?.reviews.some((review) => review.reason === 'duplicate-publication'));
          assert.ok(target?.reviews.some((review) => review.reason === 'retired-authority'));
          assert.equal(first.policyInput.reviews.find((review) =>
            review.documentDigest === revoked.document.documentHash)?.publication.revocation, 'revoked');
          assert.ok(target?.warnings.includes('prior-history-excluded'));
          assert.equal(JSON.stringify(first).includes(lowPath), false);
          assert.equal(JSON.stringify(first).includes(low.bundle.bytes.toString()), false);
          const changedPolicy = await freshConsumer({ ...raw,
            policy: { ...raw.policy, reviewers: [], groups: [] } });
          assert.equal(changedPolicy.policyInput?.reviews.length, 0);
          assert.equal(changedPolicy.policyResult?.selection.newcomers.length, 3);
            });
          });
        });
      }, { feedback: { documentUrls: urls } });
    } finally { await closeServer(server); }
  });

test('composer preserves qualification gaps, reconciles opaque conflicts, and cancels active Town work',
  { timeout: 420_000 }, async () => {
    const indexCheckout = process.env['NANDA_INDEX_CHECKOUT'];
    const townCheckout = process.env['NANDATOWN_CHECKOUT'];
    const townPython = process.env['NANDATOWN_PYTHON'];
    assert.ok(indexCheckout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    assert.ok(townCheckout, 'NANDATOWN_CHECKOUT must identify the pinned Town checkout');
    assert.ok(townPython, 'NANDATOWN_PYTHON must identify the pinned Python interpreter');
    await withSixServiceFixture(indexCheckout, async (fixture) => {
      assert.ok(fixture.feedback);
      const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-ranking-fix-'));
      await chmod(root, 0o700);
      try {
        const chicago = fixture.services.filter((service) => service.city === 'Chicago');
        const [first, second, unaffected] = chicago;
        const conflictPeer = fixture.services.find((service) => service.city === 'Boston');
        assert.ok(first && second && unaffected && conflictPeer);
        const town = await createTownBundle(fixture, unaffected, townCheckout, townPython, root);
        const rubric = 'evening-plan-usefulness-v0.1';
        const soloHash = `0x${'71'.repeat(32)}` as const;
        const solo = await publishOpaqueFeedback(fixture, first, { documentHash: soloHash, tag1: rubric,
          uri: 'http://127.0.0.1:1/missing-solo' });
        await waitForHistory(fixture, first, 1);
        const curator = 'fixture-curator';
        const reviewer = fixture.callerAddress.toLowerCase() as Address;
        const raw = (observation: { number: bigint; hash: `0x${string}` }, rpcOrigin = fixture.rpcOrigin,
          indexA = fixture.indexOrigins.A, python = townPython, signal?: AbortSignal) => ({
          rpcOrigin, provenance: fixture.feedback!.provenance, identityDomain: fixture.domain,
          cardOrigin: fixture.cardOrigin,
          observation: { blockNumber: observation.number, blockHash: observation.hash },
          indexes: [{ origin: indexA, source: fixture.feedback!.source },
            { origin: fixture.indexOrigins.B, source: fixture.feedback!.source }] as const,
          policy: { id: 'mapping-policy', version: '0.1', reviewers: [reviewer],
            groups: [{ key: 'fixture-reviewers', reviewers: [reviewer] }],
            curators: [curator], evaluators: [town.observer] },
          scope: { city: 'Chicago', task: 'evening-plan', rubric },
          services: fixture.services.map(({ agent }) => ({ agent,
            ...(agent.agentId === unaffected.agent.agentId ? { townBundleDirectory: town.bundle } : {}) })),
          privateBundleFiles: [],
          curatorInclusions: fixture.services.map(({ agent }) => ({ curator, agent })),
          townRuntime: { checkout: townCheckout, python }, ...(signal ? { signal } : {}),
        });

        const badIndex = await forwardIndex(fixture.indexOrigins.A, (_path, payload) => {
          const items = payload['items'] as Array<{ raw?: { transactionHash?: string; block?: { timestamp?: number } } }>;
          for (const item of items ?? []) if (item.raw?.transactionHash === solo.transactionHash && item.raw.block) {
            item.raw.block.timestamp = (item.raw.block.timestamp ?? 0) + 1;
          }
        });
        const slowGoodIndex = await forwardIndex(fixture.indexOrigins.B, async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        });
        try {
          const observation = await fixture.chain.getBlock();
          const recovered = await readRankingEvidence({ ...raw(observation, fixture.rpcOrigin, badIndex.origin),
            indexes: [{ origin: badIndex.origin, source: fixture.feedback!.source },
              { origin: slowGoodIndex.origin, source: fixture.feedback!.source }] });
          assert.equal(recovered.snapshot, 'matched'); assert.ok(recovered.policyInput); assert.ok(recovered.policyResult);
          assert.equal(recovered.sidecar.coverage.status, 'complete');
          assert.ok(recovered.sidecar.coverage.rows.some((row) => row.origin === 0 && row.disposition === 'rejected' &&
            row.codes.includes('raw-assertion-mismatch')));
          assert.ok(recovered.policyInput.reviews.some((review) => review.documentDigest === soloHash),
            'good Index B must recover the authentic slot');
        } finally { await badIndex.close(); await slowGoodIndex.close(); }

        const sharedHash = `0x${'72'.repeat(32)}` as const;
        await publishOpaqueFeedback(fixture, second, { documentHash: sharedHash, tag1: rubric,
          uri: 'http://127.0.0.1:1/missing-shared-a' });
        await publishOpaqueFeedback(fixture, conflictPeer, { documentHash: sharedHash, tag1: rubric,
          uri: 'http://127.0.0.1:1/missing-shared-b' });
        const incompatibleHash = `0x${'73'.repeat(32)}` as const;
        await publishOpaqueFeedback(fixture, second, { documentHash: incompatibleHash, tag1: 'different-rubric',
          uri: 'http://127.0.0.1:1/missing-incompatible' });
        await Promise.all([waitForHistory(fixture, first, 1), waitForHistory(fixture, second, 2),
          waitForHistory(fixture, conflictPeer, 1)]);
        const observation = await fixture.chain.getBlock();
        const highIndex = '4294967296';
        const alteredIndex = await forwardIndex(fixture.indexOrigins.A, (_path, payload) => {
          const items = payload['items'] as Array<{ raw?: { transactionHash?: string; transactionIndex?: string } }>;
          for (const item of items ?? []) if (item.raw?.transactionHash === solo.transactionHash) {
            item.raw.transactionIndex = highIndex;
          }
        });
        const blockTag = `0x${observation.number.toString(16)}`;
        const alteredRpc = await forwardRpc(fixture.rpcOrigin, (message, reply) => {
          if (message.method === 'eth_getTransactionReceipt' &&
              String(message.params?.[0]).toLowerCase() === solo.transactionHash.toLowerCase() && reply['result']) {
            reply['result'].transactionIndex = '0x100000000';
            for (const log of reply['result'].logs ?? []) log.transactionIndex = '0x100000000';
          }
        });
        try {
          const reconciled = await readRankingEvidence(raw(observation, alteredRpc.origin, alteredIndex.origin));
          assert.equal(reconciled.snapshot, 'matched'); assert.ok(reconciled.policyInput); assert.ok(reconciled.policyResult);
          const firstKey = `eip155:${first.agent.chainId}/erc721:${first.agent.registry.toLowerCase()}/${first.agent.agentId}`;
          const secondKey = `eip155:${second.agent.chainId}/erc721:${second.agent.registry.toLowerCase()}/${second.agent.agentId}`;
          const unaffectedKey = `eip155:${unaffected.agent.chainId}/erc721:${unaffected.agent.registry.toLowerCase()}/${unaffected.agent.agentId}`;
          const firstCandidate = reconciled.policyInput.candidates.find((candidate) => candidate.service === firstKey);
          const secondCandidate = reconciled.policyInput.candidates.find((candidate) => candidate.service === secondKey);
          const unaffectedCandidate = reconciled.policyInput.candidates.find((candidate) => candidate.service === unaffectedKey);
          assert.equal(firstCandidate?.history.status, 'partial');
          assert.equal(secondCandidate?.history.status, 'partial');
          assert.equal(unaffectedCandidate?.history.status, 'complete');
          assert.ok(reconciled.policyResult.selection.unresolved.includes(firstKey));
          assert.ok(reconciled.policyResult.selection.unresolved.includes(secondKey));
          assert.ok(reconciled.policyResult.selection.newcomers.includes(unaffectedKey));
          const slots = reconciled.sidecar.services.flatMap((service) => service.slots);
          const unrepresentable = slots.find((slot) => slot.documentHash === soloHash);
          assert.equal(unrepresentable?.policyReviewId, null);
          assert.ok(unrepresentable?.codes.includes('policy-review-unrepresentable'));
          const conflicts = slots.filter((slot) => slot.documentHash === sharedHash);
          assert.equal(conflicts.length, 2);
          assert.ok(conflicts.every((slot) => slot.policyReviewId === null && slot.codes.includes('policy-document-conflict')));
          const incompatible = slots.find((slot) => slot.documentHash === incompatibleHash);
          assert.equal(incompatible?.document, 'incompatible');
          assert.equal(incompatible?.historical, 'not-evaluated');
          assert.equal(incompatible?.policyReviewId, null);
          assert.ok(incompatible?.codes.includes('city-publication-incompatible'));
          assert.equal(reconciled.policyInput.reviews.some((review) => review.documentDigest === incompatibleHash), false);
        } finally { await alteredRpc.close(); await alteredIndex.close(); }

        await fixture.indexes.stop('A');
        const finalMarker = join(root, 'town-verify-complete');
        const finalPython = join(root, 'final-python');
        await writeFile(finalPython, `#!/bin/sh\n${JSON.stringify(townPython)} "$@"\nstatus=$?\nif [ "$4" = "verify" ]; then : > ${JSON.stringify(finalMarker)}; fi\nexit $status\n`, { mode: 0o700 });
        let postTownGenesisReads = 0;
        const finalRpc = await forwardRpc(fixture.rpcOrigin, (message, reply) => {
          if (existsSync(finalMarker) && message.method === 'eth_getBlockByNumber' && message.params?.[0] === '0x0') {
            postTownGenesisReads++;
          } else if (postTownGenesisReads >= 2 && message.method === 'eth_getBlockByNumber' &&
              message.params?.[0] === blockTag && reply['result']) reply['result'].hash = `0x${'74'.repeat(32)}`;
        });
        try {
          const changed = await readRankingEvidence(raw(observation, finalRpc.origin,
            fixture.indexOrigins.A, finalPython));
          assert.ok(postTownGenesisReads >= 2); assert.equal(changed.snapshot, 'changed');
          assert.equal(changed.policyInput, null); assert.equal(changed.policyResult, null);
          assert.equal(changed.sidecar.services.length, 6);
          assert.ok(changed.sidecar.services.some((service) => service.slots.length > 0));
          assert.equal(changed.sidecar.town.length, 1);
          assert.ok(changed.sidecar.town[0]!.stages.length > 0);
          const serialized = JSON.stringify(changed);
          for (const secret of [root, town.bundle, townCheckout, townPython, fixture.services[0]!.storeDirectory,
            Buffer.from(unaffected.cardBytes).toString('base64'), 'Fixture request']) {
            assert.equal(serialized.includes(secret), false);
          }
        } finally { await finalRpc.close(); }

        const marker = join(root, 'native-town-active');
        const blockingPython = join(root, 'blocking-python');
        await writeFile(blockingPython, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${JSON.stringify(townPython)} "$@"; fi\n: > ${JSON.stringify(marker)}\nexec /bin/sleep 30\n`, { mode: 0o700 });
        const originalSetTimeout = globalThis.setTimeout;
        const deadlineCallbacks: Array<() => void> = [];
        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
          if (delay === 120_000) {
            deadlineCallbacks.push(() => callback(...args));
            const placeholder = originalSetTimeout(() => {}, 2_000_000_000);
            placeholder.unref(); return placeholder;
          }
          return originalSetTimeout(callback, delay, ...args);
        }) as typeof setTimeout;
        const controller = new AbortController();
        try {
          const pending = readRankingEvidence(raw(observation, fixture.rpcOrigin, fixture.indexOrigins.A,
            blockingPython, controller.signal));
          await waitForPath(marker);
          assert.equal(deadlineCallbacks.length, 2, 'composer and owned budget must share the aggregate deadline');
          for (const expire of deadlineCallbacks) expire();
          const settled = await Promise.race([pending.then((result) => result),
            new Promise<null>((resolve) => originalSetTimeout(() => resolve(null), 1_500))]);
          if (!settled) { controller.abort(); await pending; assert.fail('aggregate deadline did not cancel active Town work'); }
          assert.equal(settled.snapshot, 'unavailable');
          assert.equal(settled.sidecar.town[0]?.admission, 'unavailable');
          assert.ok(settled.budget.diagnostics.some((code) => code === 'batch-deadline' || code === 'batch-cancelled'));
        } finally { controller.abort(); globalThis.setTimeout = originalSetTimeout; }
      } finally { await rm(root, { recursive: true, force: true }); }
    }, { feedback: { documentUrls: [] } });
  });
