import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import * as client from '../../src/client/externalClient.js';
import type { A2ATask } from '../../src/a2a/wire.js';

test('client chain RPC fetch refuses redirects and oversized responses', async () => {
  const boundedRpcFetch = (client as unknown as { boundedRpcFetch?: typeof fetch }).boundedRpcFetch;
  assert.ok(boundedRpcFetch, 'client exposes bounded chain RPC fetch');
  const server = createServer((request, response) => {
    if (request.url === '/redirect') response.writeHead(302, { location: '/large' }).end();
    else response.writeHead(200, { 'content-type': 'application/json' })
      .end('x'.repeat(512 * 1024 + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(boundedRpcFetch(`${base}/redirect`, { method: 'POST' }), /RPC redirect refused/);
    await assert.rejects(boundedRpcFetch(`${base}/large`, { method: 'POST' }), /RPC response exceeds 512 KiB/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('terminal polling rejects a completion that arrives after its task deadline',
  { timeout: 2_000 }, async () => {
    const pollTerminalTask = (client as unknown as { pollTerminalTask?: (url: string,
      taskId: string, timeoutMs: number) => Promise<A2ATask> }).pollTerminalTask;
    assert.ok(pollTerminalTask, 'client exposes deadline-bounded task polling');
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const query = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string };
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: query.id,
          result: { kind: 'task', id: 'task', contextId: 'ctx', status: { state: 'completed' } },
        }));
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await assert.rejects(pollTerminalTask(`http://127.0.0.1:${address.port}/`, 'task', 30),
        /task deadline/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

test('client A2A transport rejects redirects, oversized bodies, malformed JSON, and stalled responses',
  { timeout: 15_000 }, async () => {
    const rpcTask = (client as unknown as { rpcTask?: (url: string, method: 'tasks/get',
      params: unknown) => Promise<A2ATask> }).rpcTask;
    assert.ok(rpcTask, 'client exposes its bounded A2A transport');
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/malformed' }).end();
      } else if (request.url === '/oversized') {
        response.writeHead(200, { 'content-length': String(512 * 1024 + 1) });
        response.end('x'.repeat(512 * 1024 + 1));
      } else if (request.url === '/malformed') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{');
      } else if (request.url === '/stalled') {
        // No response: the per-request deadline must end this call.
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await assert.rejects(rpcTask(`${base}/redirect`, 'tasks/get', { id: 't' }), /redirect refused/);
      await assert.rejects(rpcTask(`${base}/oversized`, 'tasks/get', { id: 't' }), /exceeds 512 KiB/);
      await assert.rejects(rpcTask(`${base}/malformed`, 'tasks/get', { id: 't' }), /not JSON/);
      await assert.rejects(rpcTask(`${base}/stalled`, 'tasks/get', { id: 't' }), /timeout|aborted/i);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
