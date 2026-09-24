import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { fetchOwnedCard } from '../../src/demo/twoIndexes.js';

test('owned AgentCard fetch refuses query/redirect and over-budget bytes', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/cards/1.json') { response.end('{}'); return; }
    if (request.url === '/cards/2.json') {
      response.statusCode = 302; response.setHeader('location', 'https://elsewhere.example/card');
      response.end(); return;
    }
    if (request.url === '/cards/3.json') {
      response.end('x'.repeat(64 * 1024 + 1)); return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(new TextDecoder().decode(await fetchOwnedCard(`${origin}/cards/1.json`, origin)), '{}');
    await assert.rejects(fetchOwnedCard(`${origin}/cards/1.json?other=1`, origin), /allowlist/);
    await assert.rejects(fetchOwnedCard(`${origin}/cards/2.json`, origin), /302/);
    await assert.rejects(fetchOwnedCard(`${origin}/cards/3.json`, origin), /64 KiB/);
    await assert.rejects(fetchOwnedCard('https://elsewhere.example/cards/1.json', origin), /allowlist/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
