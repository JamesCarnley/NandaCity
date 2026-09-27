import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { LiveBudget, type BudgetRun } from '../../src/live/budget.js';
export const NOW = Date.parse('2026-10-03T20:00:00Z');
export const prices = { initialize: '1', initialized: '1', list: '1', places: '1', events: '1', transit: '1', generate: '1', cancel: '1', delete: '1' };
export const policy = { kind: 'licensed', policyId: 'owned-test', expiresAt: '2026-10-04T20:00:00Z', export: 'receipts-only', persistContent: false } as const;
export async function owned(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'city-adapter-'));
  let now = NOW;
  const ledger = await LiveBudget.open(directory, { prices, sessionCapMicros: '10000', runCapMicros: '10',
    pricingExpiresAt: '2026-10-05T00:00:00Z', now: () => now, sleep: async (ms) => { now += ms; } });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { await handler(request, response, Buffer.concat(chunks).toString()); }
    catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const finishRuns: BudgetRun[] = [];
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); for (const run of finishRuns) await run.finish(); await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { ledger, directory, origin, finishRuns, endpoints: { places: `${origin}/mcp`, events: `${origin}/events`, transit: `${origin}/routes` } };
}
export function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
export const requestInput = { version: '0.1', capability: 'evening-plan', city: 'Chicago',
  timeWindow: { start: '2026-10-03T18:00:00-05:00', end: '2026-10-03T23:00:00-05:00', timeZone: 'America/Chicago' },
  area: 'Loop', budget: { currency: 'USD', minorUnits: '3000' }, transport: ['walk', 'public-transit'], preferences: [] } as const;
