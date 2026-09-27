import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { withOwnedLifecycle, ownedFetch } from '../../src/demo/ownedLifecycle.js';

test('nested session cancellation propagates to physical reads and awaits lexical cleanup', { timeout: 3000 }, async () => {
  let entered!: () => void; let closed!: () => void; let release!: () => void;
  const arrived = new Promise<void>((r) => { entered = r; });
  const disconnected = new Promise<void>((r) => { closed = r; });
  const cleanup = new Promise<void>((r) => { release = r; });
  const server = createServer((_req, res) => { res.on('close', closed); res.writeHead(200); res.write('x'); entered(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const parent = new AbortController(); let finished = false;
  const pending = withOwnedLifecycle(() => withOwnedLifecycle(async () => {
    try { await (await ownedFetch(`http://127.0.0.1:${address.port}`)).text(); }
    finally { await cleanup; }
  }, new AbortController().signal), parent.signal);
  void pending.then(() => { finished = true; }, () => { finished = true; });
  try {
    await arrived; parent.abort(new Error('reset')); await disconnected;
    assert.equal(finished, false); release(); await assert.rejects(pending, /reset|abort/i);
    const aborted = new AbortController(); aborted.abort(); let acquired = false;
    await assert.rejects(withOwnedLifecycle(async () => { acquired = true; }, aborted.signal));
    assert.equal(acquired, false);
  } finally { release(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
