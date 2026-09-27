import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import test from 'node:test';
import { createOriginTlsFixture } from '../../src/demo/originTls.js';
import { readOriginBytes, observeOriginProfile } from '../../src/origin/profile.js';

test('caller abort physically closes an in-flight TLS profile read before its five-second deadline', async () => {
  const tls = await createOriginTlsFixture();
  let arrived!: () => void, disconnected!: () => void;
  const incoming = new Promise<void>((r) => { arrived = r; });
  const closed = new Promise<void>((r) => { disconnected = r; });
  const server = createServer(tls.serverOptions, (req) => { req.on('close', disconnected); arrived(); });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `https://127.0.0.1:${address.port}/identity`, abort = new AbortController();
    const work = readOriginBytes(url, { ca: tls.ca, allowedUrls: [url], signal: abort.signal }, 6144);
    const rejection = assert.rejects(work);
    await incoming; const start = performance.now(); abort.abort(); await rejection; await closed;
    assert.ok(performance.now() - start < 1500, 'abort must close the actual socket, not just wait for the timeout');
    await assert.rejects(observeOriginProfile({ identityUrl: url, ca: tls.ca, allowedUrls: [url], signal: abort.signal,
      now: () => '2026-09-27T12:00:00Z' }), 'cancellation must not become an ordinary unknown that permits later stages');
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); await tls.close();
  }
});
