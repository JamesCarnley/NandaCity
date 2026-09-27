import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startStrategyA2AService } from '../a2a/service.js';
import { createOriginRuntimeStrategy } from '../a2a/strategy.js';
import { a2aTaskSchema } from '../a2a/wire.js';
import { digestBytes } from '../identity/profile.js';
import { decodeOriginEnvelope, encodeOriginDocument, type OriginDocument } from '../origin/bytes.js';
import { readOriginArchive, readIndexBytes } from '../origin/archive.js';
import { observeOriginProfile, searchOriginPointers } from '../origin/profile.js';
import { encodeOriginSupportingBundle } from '../origin/supportingBundle.js';
import { signOriginStatement } from '../origin/signatures.js';
import type { OriginEnvelope, OriginFeedback, OriginProfile, OriginRequest } from '../origin/schema.js';
import { readOriginEvidence, type OriginEvidenceOptions } from '../reputation/originEvidence.js';
import { createOriginTlsFixture } from './originTls.js';
import { withOwnedOriginIndexes, type OwnedIndex } from './indexProcesses.js';
import { withOwnedLifecycle, type OwnedLifecycle } from './ownedLifecycle.js';

const NOW = '2026-09-27T12:01:00Z', OBSERVED = '2026-09-27T12:07:00Z';
async function listen(server: Server, protocol: 'http' | 'https'): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing owned listener');
  return `${protocol}://127.0.0.1:${address.port}`;
}
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => { server.close((error) => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function rpc(url: string, ca: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', ca, rejectUnauthorized: true, agent: false, signal,
      headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 131072) res.destroy(new Error('runtime reply exceeds bound')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('runtime reply invalid')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('runtime timeout')), 5000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 'origin-comparison', method, params }));
  });
}
async function enroll(index: OwnedIndex, identityUrl: string, signal: AbortSignal): Promise<void> {
  const orgId = `synthetic-${randomUUID()}`, email = `${orgId}@example.test`;
  const json = async (path: string, body: unknown, token?: string, method = 'POST') => {
    signal.throwIfAborted();
    const response = await fetch(`${index.origin}${path}`, { method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`owned organization operation failed (${response.status})`);
    return await response.json() as Record<string, unknown>;
  };
  const registration = await json('/auth/register', { email, password: randomBytes(24).toString('hex'), display_name: 'Synthetic local caller' });
  if (typeof registration.token !== 'string') throw new Error('owned registration token unavailable');
  await json('/api/v1/orgs', { org_id: orgId, display_name: 'Synthetic Chicago', contact_email: email,
    hosting_path: 'personal', registry_url: identityUrl }, registration.token);
  await index.verifyOrganizationEmail(orgId);
  signal.throwIfAborted();
  await json(`/api/v1/orgs/${orgId}/services`, { services: [{ identifier: identityUrl, display_name: 'Synthetic Chicago evening plan',
    type: 'urn:nandacity:service:evening-plan:0.1', url: identityUrl,
    capability_ids: ['urn:nandacity:capability:evening-plan:0.1'], area_served: ['Chicago'], interfaces: ['A2A'] }] }, registration.token, 'PUT');
}
async function freshConsumer(input: unknown, lifecycle: OwnedLifecycle) {
  const built = import.meta.url.endsWith('.js');
  const worker = fileURLToPath(new URL(`../client/originConsumerCli.${built ? 'js' : 'ts'}`, import.meta.url));
  return new Promise<Awaited<ReturnType<typeof readOriginEvidence>>>((resolve, reject) => {
    const child = spawn(process.execPath, [...(built ? [] : ['--import', 'tsx']), worker], {
      env: { PATH: process.env['PATH'] ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let length = 0, failed = false;
    const kill = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, 60000); lifecycle.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 256000) kill(); else chunks.push(chunk); });
    child.stderr.on('data', kill); child.on('error', kill); child.stdin.on('error', kill);
    child.on('close', (code) => {
      clearTimeout(timer); lifecycle.signal.removeEventListener('abort', kill);
      try { if (failed || code !== 0) throw new Error(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Awaited<ReturnType<typeof readOriginEvidence>>); }
      catch { reject(new Error('fresh origin consumer failed')); }
    });
    child.stdin.end(JSON.stringify(input)); if (lifecycle.signal.aborted) kill();
  });
}

/** One synthetic service and one accepted reviewer. No public network or chain configuration. */
export async function runOriginComparison(options: { indexCheckout: string; signal?: AbortSignal; onProgress?: (phase: string) => void }) {
  return withOwnedLifecycle(async (lifecycle) => {
    const cleanup: (() => Promise<void>)[] = [];
    let runFailure: unknown;
    try {
      const tls = await createOriginTlsFixture(); cleanup.push(tls.close);
      options.onProgress?.('tls-ready'); lifecycle.check();
      const directory = await mkdtemp(join(tmpdir(), 'city-origin-comparison-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
      await chmod(directory, 0o700);
      const controller = privateKeyToAccount(generatePrivateKey()), runtime = privateKeyToAccount(generatePrivateKey()),
        reviewer = privateKeyToAccount(generatePrivateKey()), rotated = privateKeyToAccount(generatePrivateKey());
      const key = (account: typeof reviewer) => ({ method: 'secp256k1-key' as const, address: account.address.toLowerCase() });
      let current = new Uint8Array(), cardBytes = new Uint8Array(), identityAvailable = true;
      let chainRequests = 0;
      const identity = httpsServer(tls.serverOptions, (req, res) => {
        if (req.method !== 'GET') { chainRequests++; res.writeHead(405).end(); return; }
        if (!identityAvailable) res.writeHead(503).end(); else if (req.url === '/identity') res.end(current); else res.writeHead(404).end();
      });
      cleanup.push(() => closeServer(identity)); const identityUrl = `${await listen(identity, 'https')}/identity`;
      const cards = httpsServer(tls.serverOptions, (req, res) => req.url === '/card' ? res.end(cardBytes) : res.writeHead(404).end());
      cleanup.push(() => closeServer(cards)); const cardURL = `${await listen(cards, 'https')}/card`;
      const allowedUrls = [identityUrl, cardURL]; let basis!: OriginDocument<OriginProfile>;
      const observe = () => observeOriginProfile({ identityUrl, ca: tls.ca, allowedUrls, now: () => NOW, signal: lifecycle.signal });
      const service = await startStrategyA2AService({ storeDirectory: directory, runtimeSigner: runtime, now: () => NOW,
        strategy: createOriginRuntimeStrategy({ basisProfile: () => basis, observeAuthority: observe }),
        server: { protocol: 'https', create: (handler) => httpsServer(tls.serverOptions, handler) } });
      let serviceStop: Promise<void> | undefined;
      const stopService = () => serviceStop ??= service.close();
      cleanup.push(stopService); allowedUrls.push(service.url);
      cardBytes = new TextEncoder().encode(JSON.stringify({ protocolVersion: '0.3.0', name: 'Synthetic Chicago', description: 'Synthetic local comparison',
        url: service.url, preferredTransport: 'JSONRPC', version: '0.1', capabilities: {}, defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'], skills: [{ id: 'evening-plan', name: 'Evening plan', description: 'Synthetic only', tags: ['Chicago'] }] }));
      const common = { profile: 'city-origin@0.1' as const, service: { method: 'https-origin' as const, identityUrl } };
      const profile: OriginProfile = { ...common, kind: 'profile', revision: '1', active: true, controllerKey: key(controller), runtimeKey: key(runtime),
        cardURL, cardDigest: digestBytes(cardBytes), endpoint: service.url, city: 'Chicago', capability: 'evening-plan' };
      basis = encodeOriginDocument(await signOriginStatement(profile, controller)) as OriginDocument<OriginProfile>; current = new Uint8Array(basis.bytes);
      const request: OriginRequest = { ...common, kind: 'request', caller: key(reviewer), interactionId: `0x${randomBytes(32).toString('hex')}`,
        profileBasis: { profileDigest: basis.documentDigest, cardDigest: profile.cardDigest }, createdAt: '2026-09-27T12:00:00Z', deadline: '2026-09-27T12:05:00Z',
        input: { version: '0.1', capability: 'evening-plan', city: 'Chicago', timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00', timeZone: 'America/Chicago' },
          area: 'The Loop', budget: { currency: 'USD', minorUnits: '8500' }, transport: ['walk', 'public-transit'], preferences: ['Synthetic evening'] } };
      const requestEnvelope = await signOriginStatement(request, reviewer);
      const response = await rpc(service.url, tls.ca, 'message/send', { message: { kind: 'message', role: 'user', messageId: 'synthetic',
        parts: [{ kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope: requestEnvelope } }] } }, lifecycle.signal) as { result?: unknown };
      let task = a2aTaskSchema.parse(response.result);
      const deadline = Date.now() + 10000;
      while (task.status.state !== 'completed') {
        lifecycle.check(); if (Date.now() > deadline || task.status.state === 'failed') throw new Error('origin runtime did not complete');
        await delay(10, undefined, { signal: lifecycle.signal });
        const found = await rpc(service.url, tls.ca, 'tasks/get', { id: task.id }, lifecycle.signal) as { result?: unknown }; task = a2aTaskSchema.parse(found.result);
      }
      const metadata = task.metadata!['org.nandacity'] as { acceptance: OriginEnvelope; completion: OriginEnvelope };
      const acceptance = encodeOriginDocument(metadata.acceptance), completion = encodeOriginDocument(metadata.completion);
      const feedback: OriginFeedback = { ...common, kind: 'feedback', reviewer: key(reviewer), interactionId: request.interactionId,
        requestDigest: decodeOriginEnvelope(requestEnvelope).statement.digest, acceptanceDigest: acceptance.statement.digest,
        publicationPolicy: 'city-origin-archive@0.1', rubric: 'evening-plan-usefulness-v0.1', value: 5,
        createdAt: '2026-09-27T12:03:00Z', result: { kind: 'completion', completionDigest: completion.statement.digest } };
      const positive = encodeOriginDocument(await signOriginStatement(feedback, reviewer));
      const negative = encodeOriginDocument(await signOriginStatement({ ...feedback, value: 1, createdAt: '2026-09-27T12:04:00Z' }, reviewer));
      const snapshot = encodeOriginDocument(await signOriginStatement({ ...common, kind: 'archive-snapshot', reviewer: reviewer.address.toLowerCase(),
        snapshotId: 'synthetic-selected', createdAt: '2026-09-27T12:06:00Z', historyScope: 'reviewer-declared-from-inception',
        entries: [positive.documentDigest, negative.documentDigest] }, reviewer));
      const blobs = new Map([[`/owned/snapshots/${snapshot.documentDigest}`, snapshot.bytes],
        ...[positive, negative].map((d) => [`/owned/documents/${d.documentDigest}`, d.bytes] as const)]);
      const source = httpServer((req, res) => {
        if (req.method !== 'GET') { chainRequests++; res.writeHead(405).end(); return; }
        const bytes = blobs.get(req.url ?? ''); if (bytes) res.setHeader('content-type', 'application/octet-stream').end(bytes); else res.writeHead(404).end();
      });
      cleanup.push(() => closeServer(source)); const sourceBaseUrl = `${await listen(source, 'http')}/owned/`;
      const config = { sourceBaseUrl, snapshotDigests: [snapshot.documentDigest], pollMs: 100 };
      const bundle = encodeOriginSupportingBundle({ profile: basis.bytes, request: encodeOriginDocument(requestEnvelope).bytes,
        acceptance: acceptance.bytes, completion: completion.bytes, card: cardBytes });
      const evidence: Omit<OriginEvidenceOptions, 'archive'> & { snapshotDigest: string } = { identityUrl, allowedUrls, ca: tls.ca,
        observedAt: OBSERVED, policy: { reviewers: [reviewer.address.toLowerCase()], groups: [{ key: 'synthetic-caller', reviewers: [reviewer.address.toLowerCase()] }],
          curatorIncluded: true }, bundle, snapshotDigest: snapshot.documentDigest };
      return await withOwnedOriginIndexes(options.indexCheckout, { A: config, B: config }, async (owned) => {
        options.onProgress?.('indexes-ready'); lifecycle.check();
        const discovery = { A: 0, B: 0 }, retained = { A: 0, B: 0 };
        for (const name of ['A', 'B'] as const) {
          const index = owned.indexes[name]; await enroll(index, identityUrl, lifecycle.signal);
          const found = await searchOriginPointers(index.origin, lifecycle.signal); assert.equal(found.complete, true); discovery[name] = found.pointers.filter((p) => p.identityUrl === identityUrl).length;
          assert.equal(discovery[name], 1);
          const observed = await observe(); assert.equal(observed.current, 'observed');
          // The discovered, TLS-checked service handles the same signed interaction idempotently.
          const replay = await rpc(service.url, tls.ca, 'message/send', { message: { kind: 'message', role: 'user', messageId: 'discovered-retry',
            parts: [{ kind: 'data', data: { type: 'org.nandacity.city-request', version: '0.1', envelope: requestEnvelope } }] } }, lifecycle.signal) as { result?: unknown };
          assert.equal(a2aTaskSchema.parse(replay.result).id, task.id);
          const until = Date.now() + 15000;
          for (;;) {
            lifecycle.check(); const archive = await readOriginArchive({ indexOrigin: index.origin, snapshotDigest: snapshot.documentDigest, signal: lifecycle.signal });
            retained[name] = archive.documents.filter((d) => d.bytes).length;
            if (retained[name] === 2) break;
            if (Date.now() > until) throw new Error('origin archive acquisition incomplete');
            await delay(100, undefined, { signal: lifecycle.signal });
          }
        }
        const status = JSON.parse(Buffer.from(await readIndexBytes(`${owned.indexes.B.origin}/api/ard/origin-archive/snapshots/${snapshot.documentDigest}/status`, 2 * 1024 * 1024, { signal: lifecycle.signal })).toString()) as { shape: { status: string } };
        assert.equal(status.shape.status, 'valid');
        const initial = await readOriginEvidence({ ...evidence, indexOrigin: owned.indexes.A.origin, signal: lifecycle.signal }); lifecycle.check();
        assert.deepEqual(initial.policy.score, { numerator: '7', denominator: '3' });
        await stopService(); await closeServer(cards); await closeServer(source);
        const a = await owned.restart('A'), b = await owned.restart('B');
        assert.equal(a.database, owned.indexes.A.database); assert.equal(b.database, owned.indexes.B.database);
        await owned.stop('A');
        const { bundle: _private, ...publicInput } = evidence;
        const fresh = await freshConsumer({ ...publicInput, indexOrigin: b.origin, bundleBase64: Buffer.from(bundle).toString('base64') }, lifecycle);
        assert.deepEqual(fresh.policy, initial.policy);
        identityAvailable = false;
        const lost = await readOriginEvidence({ ...evidence, indexOrigin: b.origin, signal: lifecycle.signal }); lifecycle.check(); identityAvailable = true;
        current = new Uint8Array(encodeOriginDocument(await signOriginStatement({ ...profile, runtimeKey: key(rotated), revision: '2' }, controller)).bytes);
        const rotatedResult = await readOriginEvidence({ ...evidence, indexOrigin: b.origin, signal: lifecycle.signal }); lifecycle.check();
        const migratedEndpoint = `${service.url}migrated`; allowedUrls.push(migratedEndpoint);
        current = new Uint8Array(encodeOriginDocument(await signOriginStatement({ ...profile, endpoint: migratedEndpoint, revision: '3' }, controller)).bytes);
        const migrated = await readOriginEvidence({ ...evidence, indexOrigin: b.origin, signal: lifecycle.signal }); lifecycle.check();
        const rebuilt = await owned.rebuild('A');
        const empty = await readOriginEvidence({ ...evidence, indexOrigin: rebuilt.origin, signal: lifecycle.signal }); lifecycle.check();
        assert.equal(chainRequests, 0);
        return { discovery, retained, snapshotShape: status.shape.status, chainRequests, initial, fresh, lost,
          rotated: rotatedResult, migrated, empty, sameRunningDatabase: true,
          limitations: ['synthetic-local-CA', 'same-host-failure-domain', 'process-restart-not-container-or-host-durability'] };
      });
    } catch (error) { runFailure = error; throw error; }
    finally {
      const failures: unknown[] = [];
      for (const close of cleanup.reverse()) { try { await close(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError([...(runFailure ? [runFailure] : []), ...failures], 'origin owned cleanup failed');
    }
  }, options.signal);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const indexCheckout = process.env['NANDA_INDEX_CHECKOUT']; if (!indexCheckout) throw new Error('missing pinned checkout');
    const result = await runOriginComparison({ indexCheckout, onProgress: (phase) => process.stderr.write(`Origin comparison: ${phase}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch { process.stderr.write('Origin comparison failed; no success claim.\n'); process.exitCode = 1; }
}
