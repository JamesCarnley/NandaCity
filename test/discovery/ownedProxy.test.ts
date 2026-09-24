import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import test from 'node:test';

import { createTamperProxy, listenOwnedServer } from '../../src/demo/twoIndexes.js';

async function local(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('tamper proxy refuses network-path targets without contacting a foreign server', async () => {
  let foreignHits = 0;
  const upstream = createServer((_request, response) => response.end('{}'));
  const foreign = createServer((_request, response) => { foreignHits++; response.end('{}'); });
  const upstreamOrigin = await local(upstream);
  const foreignOrigin = await local(foreign);
  const proxy = createTamperProxy(upstreamOrigin);
  const proxyOrigin = await local(proxy);
  try {
    const foreignPort = new URL(foreignOrigin).port;
    const response = await fetch(`${proxyOrigin}//127.0.0.1:${foreignPort}/arbitrary`, {
      signal: AbortSignal.timeout(2_000), redirect: 'manual',
    });
    assert.equal(response.status, 404);
    assert.equal(foreignHits, 0);
  } finally { await Promise.all([close(proxy), close(upstream), close(foreign)]); }
});

test('tamper proxy bounds oversized request and upstream response', async () => {
  let upstreamHits = 0;
  const upstream = createServer((_request, response) => {
    upstreamHits++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: ['x'.repeat(2 * 1024 * 1024)] }));
  });
  const upstreamOrigin = await local(upstream);
  const proxy = createTamperProxy(upstreamOrigin);
  const proxyOrigin = await local(proxy);
  try {
    const oversized = await fetch(`${proxyOrigin}/api/ard/services/search`, {
      method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(oversized.status, 413);
    assert.equal(upstreamHits, 0);
    const response = await fetch(`${proxyOrigin}/api/ard/services/search`, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 502);
    assert.equal(upstreamHits, 1);
  } finally { await Promise.all([close(proxy), close(upstream)]); }
});

test('stalled proxy upload times out and owned listener can close', async () => {
  const upstream = createServer((_request, response) => response.end('{}'));
  const upstreamOrigin = await local(upstream);
  const proxy = createTamperProxy(upstreamOrigin);
  const proxyOrigin = await local(proxy);
  try {
    const url = new URL('/api/ard/services/search', proxyOrigin);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST' });
      req.on('error', () => resolve());
      req.on('response', (response) => {
        assert.ok((response.statusCode ?? 0) >= 400);
        response.resume(); response.on('end', resolve);
      });
      req.write('partial');
      setTimeout(() => reject(new Error('stalled proxy upload did not time out')), 6_500).unref();
    });
  } finally { await Promise.all([close(proxy), close(upstream)]); }
});

test('owned HTTP listener startup error rejects instead of escaping as an unhandled event', async () => {
  const server = createServer((_request, response) => response.end());
  await local(server);
  try { await assert.rejects(listenOwnedServer(server), /listen|already/i); }
  finally { await close(server); }
});
