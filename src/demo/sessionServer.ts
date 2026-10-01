import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { liveAnswerSchema } from '../live/answer.js';
import { eveningPlanInputSchema } from '../a2a/input.js';
import { renderSessionView, type SessionRenderOptions } from '../report/sessionView.js';
import { demoEveningInput, withDemoSession, type DemoSession, type SessionAction, type SessionOptions } from './sessionController.js';
import { withOwnedLifecycle } from './ownedLifecycle.js';

const MAX_BODY = 16 * 1024;
const operationId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const common = { token: z.string(), generation: z.string().regex(/^(0|[1-9][0-9]*)$/), operationId,
  panel: z.enum(['discover', 'ask', 'review', 'resilience', 'ownership']).optional() };
const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('refresh'), city: z.enum(['Chicago', 'Boston']) }),
  z.strictObject({ ...common, action: z.literal('select'), service: z.string().max(160) }),
  z.strictObject({ ...common, action: z.enum(['invoke', 'invoke-failure']), reviewer: z.enum(['accepted', 'new']),
    start: z.string().max(40).optional(), end: z.string().max(40).optional(), area: z.string().max(120).optional(),
    budget: z.string().max(16).optional(), transport: z.enum(['walk', 'public-transit', 'walk-and-public-transit', 'bicycle', 'car', 'taxi']).optional(), preferences: z.string().max(4096).optional() }),
  z.strictObject({ ...common, action: z.literal('feedback'), invocationId: operationId, value: z.enum(['1', '2', '3', '4', '5']) }),
  z.strictObject({ ...common, action: z.literal('retry'), invocationId: operationId }),
  z.strictObject({ ...common, action: z.literal('retry-feedback'), feedbackId: operationId }),
  z.strictObject({ ...common, action: z.literal('index'), index: z.enum(['A', 'B']), state: z.enum(['stop', 'start', 'restart', 'tamper']),
    city: z.enum(['Chicago', 'Boston']).optional() }),
  z.strictObject({ ...common, action: z.literal('recover'), operatorId: z.enum(['operator-1', 'operator-2', 'operator-3']) }),
  z.strictObject({ ...common, action: z.enum(['reset', 'stop-providers', 'fresh-consumer', 'origin-comparison']) }),
]);
class HttpFailure extends Error { constructor(readonly status: number) { super('Request refused'); } }
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  if (req.headers['content-type'] !== 'application/x-www-form-urlencoded' || req.headers['content-encoding']) throw new HttpFailure(400);
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpFailure(413);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) throw new HttpFailure(413); chunks.push(Buffer.from(chunk)); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const params = new URLSearchParams(text), value: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of params) { if (Object.hasOwn(value, key)) throw new HttpFailure(400); value[key] = item; }
  return value;
}
const tokenMatches = (supplied: string | undefined, token: string) => typeof supplied === 'string' &&
  Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));

/** Synchronous display only; copies are wiped, decoded content is never installed on the public view. */
export function renderSessionPage(session: DemoSession, options: Omit<SessionRenderOptions, 'content'>): string {
  const view = session.view(), content: NonNullable<SessionRenderOptions['content']> extends ReadonlyMap<infer K, infer V> ? Map<K, V> : never = new Map();
  if (view.mode === 'licensed' && view.status === 'ready') for (const invocation of view.invocations) {
    const expiresAt = invocation.receipt?.retention.expiresAt;
    if (!expiresAt || Date.parse(expiresAt) <= Date.now()) continue;
    const bytes = session.readContent(invocation.id, view.generation);
    if (!bytes) continue;
    try {
      if (bytes.byteLength > 256 * 1024) continue;
      const answer = liveAnswerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      content.set(invocation.id, { answer, expiresAt });
    } catch { /* Invalid content never becomes provider HTML or an exported diagnostic. */ }
    finally { bytes.fill(0); }
  }
  const html = renderSessionView(view, { ...options, content });
  const latest = session.view();
  if (latest.generation !== view.generation || latest.status !== view.status ||
      [...content.values()].some(({ expiresAt }) => Date.parse(expiresAt) <= Date.now())) return renderSessionView(latest, options);
  return html;
}

/** Server accepts an already configured fixture or licensed session. It never accepts its configuration. */
export async function startSessionServer(session: DemoSession, port = 0): Promise<{ origin: string; close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid local port');
  let generation = session.view().generation, token = randomBytes(32).toString('hex');
  const submissions = new Map<string, string>();
  let resetSubmission: { id: string; serialized: string } | undefined;
  let origin = '', closed: Promise<void> | undefined;
  const rotate = () => { if (session.view().generation !== generation) { generation = session.view().generation;
    token = randomBytes(32).toString('hex'); submissions.clear(); resetSubmission = undefined; } };
  const server = createServer((req, res) => { void (async () => {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    try {
      if (req.headers.host !== origin.slice('http://'.length)) throw new HttpFailure(403);
      rotate();
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new HttpFailure(403);
      if (req.method === 'GET') {
        if (url.pathname === '/status') {
          const view = session.view(); res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ generation: view.generation, status: view.status, operations: view.operations }));
        }
        if (url.pathname === '/export.json' || url.pathname === '/export.html') {
          const view = session.view();
          res.setHeader('content-disposition', `attachment; filename="city-session.${url.pathname.endsWith('json') ? 'json' : 'html'}"`);
          res.setHeader('content-type', url.pathname.endsWith('json') ? 'application/json' : 'text/html; charset=utf-8');
          return res.end(url.pathname.endsWith('json') ? JSON.stringify(view, null, 2) : renderSessionView(view));
        }
        if (url.pathname !== '/') throw new HttpFailure(404);
        res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(renderSessionPage(session, { token, nonce }));
      }
      if (req.method !== 'POST' || url.pathname !== '/action' || url.search) throw new HttpFailure(404);
      if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) throw new HttpFailure(403);
      const form = await readForm(req); rotate();
      if (!tokenMatches(form.token, token) || form.generation !== String(generation)) throw new HttpFailure(403);
      const checked = actionSchema.safeParse(form); if (!checked.success) throw new HttpFailure(400);
      const value = checked.data, serialized = JSON.stringify(value), existing = submissions.get(value.operationId) ??
        (resetSubmission?.id === value.operationId ? resetSubmission.serialized : undefined);
      if (existing !== undefined && existing !== serialized) throw new HttpFailure(409);
      if (existing === undefined) {
        if (value.action !== 'reset' && submissions.size >= 512) throw new HttpFailure(429);
        if (value.action === 'reset') {
          if (!resetSubmission) {
            resetSubmission = { id: value.operationId, serialized };
            // One reserved reset coalesces requests while the controller awaits cleanup.
            void session.reset().catch(() => {});
          }
        } else if (value.action === 'select') {
          session.select(value.service); submissions.set(value.operationId, serialized);
        } else {
          let action: SessionAction;
          if (value.action === 'invoke' || value.action === 'invoke-failure') {
            const view = session.view();
            if (view.mode === 'licensed') {
              if (value.action !== 'invoke' || value.reviewer !== view.licensedHint?.admittedReviewer ||
                Date.parse(view.licensedHint.expiresAt) <= Date.now()) throw new HttpFailure(400);
              const city = view.discovery?.city;
              const input = eveningPlanInputSchema.safeParse({ version: '0.1', capability: 'evening-plan', city,
                timeWindow: { start: value.start, end: value.end, timeZone: city === 'Chicago' ? 'America/Chicago' : 'America/New_York' },
                area: value.area, budget: { currency: 'USD', minorUnits: value.budget },
                transport: value.transport === 'walk-and-public-transit' ? ['walk', 'public-transit'] : [value.transport],
                preferences: value.preferences?.split(/\r?\n/).filter(Boolean) ?? [] });
              if (!input.success || Date.parse(input.data.timeWindow.start) <= Date.now()) throw new HttpFailure(400);
              action = { kind: 'invoke', reviewer: value.reviewer, input: input.data };
            } else {
              if (view.answerEngine === 'openclaw' && value.action === 'invoke') {
                if (['start', 'end', 'area'].some((key) => Object.hasOwn(value, key)) || !view.discovery) throw new HttpFailure(400);
                const base = demoEveningInput(view.discovery.city);
                const input = eveningPlanInputSchema.safeParse({ ...base,
                  budget: { currency: 'USD', minorUnits: value.budget ?? base.budget.minorUnits },
                  transport: value.transport === undefined ? base.transport : value.transport === 'walk-and-public-transit' ? ['walk', 'public-transit'] : [value.transport],
                  preferences: value.preferences?.split(/\r?\n/).filter(Boolean) ?? base.preferences });
                if (!input.success) throw new HttpFailure(400);
                action = { kind: 'invoke', reviewer: value.reviewer, input: input.data };
              } else {
                if (['start', 'end', 'area', 'budget', 'transport', 'preferences'].some((key) => Object.hasOwn(value, key))) throw new HttpFailure(400);
                action = { kind: 'invoke', reviewer: value.reviewer, ...(value.action === 'invoke-failure' ? { fail: true } : {}) };
              }
            }
          } else {
            const { token: _token, operationId: _id, generation: _generation, panel: _panel, action: kind, ...fields } = value;
            action = { kind, ...fields, ...(kind === 'feedback' ? { value: Number((value as { value: string }).value) } : {}) } as SessionAction;
          }
          session.start(action, value.operationId); submissions.set(value.operationId, serialized);
        }
      }
      res.writeHead(303, { location: `/?operation=${encodeURIComponent(value.action === 'reset' ? resetSubmission!.id : value.operationId)}${value.panel ? `#${value.panel}` : ''}` }); res.end();
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 409;
      res.statusCode = status; res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(status === 400 ? 'Input not accepted. Use the shown fields, selected city, future local dates with correct UTC offsets, a window of at most 24 hours and the admitted reviewer. Reload the page and check policy expiry. No request was queued.' :
        status === 403 ? 'Local request refused. Open the exact 127.0.0.1 address printed by the launcher and reload the page.' :
        status === 413 ? 'Form exceeds the 16 KiB limit.' : 'Action unavailable or precondition changed. Reload the session; unknown outcomes remain unresolved.');
    }
  })().catch(() => { res.destroy(); }); });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('local listener unavailable');
  origin = new URL(`http://127.0.0.1:${address.port}`).origin;
  return { origin, close: () => closed ??= new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

export async function runSessionDemo(indexCheckout: string, output: Pick<NodeJS.WriteStream, 'write'>, port = 0, options: SessionOptions = {}): Promise<void> {
  await withOwnedLifecycle(async (lifecycle) => withDemoSession(indexCheckout, async (session) => {
    const server = await startSessionServer(session, port);
    output.write(`NANDA City ${options.mode !== 'licensed' && options.answerEngine === 'openclaw' ? 'OpenClaw rehearsal (fictional data)' : 'fixture'}: ${server.origin}\nPreparing owned local resources. Ctrl-C closes the session and awaits cleanup.\n`);
    try {
      await new Promise<void>((resolve) => { const stop = () => resolve();
        lifecycle.signal.addEventListener('abort', stop, { once: true }); if (lifecycle.signal.aborted) stop(); });
    } finally { await server.close(); }
  }, options));
}
