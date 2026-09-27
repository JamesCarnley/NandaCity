import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { digestBytes } from '../../src/identity/profile.js';
import { encodeOriginDocument } from '../../src/origin/bytes.js';
import { signOriginStatement } from '../../src/origin/signatures.js';

test('archive reads pinned exact bytes, ignores projected entry claims, and bounds variants', async (t) => {
  const api = await import('../../src/origin/archive.js').catch(() => null);
  assert.ok(api, 'bounded origin archive reader must exist');
  const reviewer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  const document = new TextEncoder().encode('opaque retained feedback');
  const digest = digestBytes(document);
  const snapshot = encodeOriginDocument(await signOriginStatement({ profile: 'city-origin@0.1', kind: 'archive-snapshot',
    service: { method: 'https-origin', identityUrl: 'https://127.0.0.1:9443/identity' },
    reviewer: reviewer.address.toLowerCase(), snapshotId: 'selected', createdAt: '2026-09-27T12:05:00Z',
    historyScope: 'reviewer-declared-from-inception', entries: [digest] }, reviewer));
  let mode = 'normal';
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url!.endsWith('/status')) {
      if (mode === 'large') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
      res.end(JSON.stringify({ digest: snapshot.documentDigest, entries: [],
        retainedVariants: [{ digest: snapshot.documentDigest }], variantsTruncated: mode === 'truncated' }));
    } else if (req.url!.includes('/snapshots/')) res.end(snapshot.bytes);
    else if (mode === 'missing') res.writeHead(404).end();
    else if (mode === 'wrong') res.end('wrong bytes');
    else if (mode === 'redirect') res.writeHead(302, { location: '/else' }).end();
    else res.end(document);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { indexOrigin: `http://127.0.0.1:${address.port}`, snapshotDigest: snapshot.documentDigest };
  const retained = await api.readOriginArchive(options);
  assert.deepEqual(retained.snapshot, snapshot.bytes);
  assert.deepEqual(retained.documents, [{ digest, bytes: document }]);
  assert.equal(retained.variants.length, 1);
  const beforeCancelled = paths.length;
  assert.equal((await api.readOriginArchive({ ...options, signal: AbortSignal.abort() })).snapshot, null);
  assert.equal(paths.length, beforeCancelled, 'cancelled archive reads dispatch no transport work');
  for (mode of ['missing', 'wrong', 'redirect']) {
    const result = await api.readOriginArchive(options);
    assert.equal(result.documents[0]!.bytes, null, mode);
  }
  mode = 'truncated'; assert.equal((await api.readOriginArchive(options)).variantsTruncated, true);
  mode = 'large'; assert.equal((await api.readOriginArchive(options)).historyAvailable, false);
  assert.ok(paths.every((path) => path.startsWith('/api/ard/origin-archive/')));
  await assert.rejects(api.readOriginArchive({ ...options, indexOrigin: 'https://example.com' }));
});

test('organization pointer reader keeps authority separate and detects incomplete pagination', async (t) => {
  const api = await import('../../src/origin/profile.js');
  assert.equal(typeof api.searchOriginPointers, 'function');
  let mode = 'normal';
  let origin = '';
  const pointer = { identifier: 'https://127.0.0.1:9443/identity', displayName: 'Synthetic Chicago',
    type: 'urn:nandacity:service:evening-plan:0.1', url: 'https://127.0.0.1:9443/identity', description: null,
    capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'], areaServed: ['Chicago'], interfaces: ['A2A'],
    provenance: { sourceId: 'org:synthetic', sourceKind: 'organization-declaration', organizationId: 'synthetic',
      revision: '1', observedAt: '2026-09-27T12:00:00Z' } };
  const server = createServer((_req, res) => res.end(JSON.stringify({ items: [{ ...pointer,
    ...(mode === 'wrong-url' ? { identifier: `${pointer.url}/different` } : {}),
    ...(mode === 'authority' ? { provenance: { ...pointer.provenance, authority: { kind: 'erc8004-identity' } } } : {}) }],
    observerOrigin: origin, pageToken: mode === 'paging' ? 'repeated' : null,
    coverage: { scope: 'local-projection', upstreamSearch: 'not-attempted', paginationConsistency: 'live-keyset',
      readAt: '2026-09-27T12:00:00Z', identitySources: [] } })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  const found = await api.searchOriginPointers(origin);
  assert.equal(found.pointers[0]!.identityUrl, pointer.url); assert.equal(found.complete, true);
  for (mode of ['wrong-url', 'authority']) assert.equal((await api.searchOriginPointers(origin)).pointers.length, 0);
  mode = 'paging'; assert.equal((await api.searchOriginPointers(origin)).complete, false);
});
