import { LIVE_LIMITS, LiveError, type BudgetRun, type Purpose } from './budget.js';
import { z } from 'zod';

export type Endpoint = 'places' | 'events' | 'transit';
const ENDPOINTS = Object.freeze({ places: 'https://mapstools.googleapis.com/mcp',
  events: 'https://app.ticketmaster.com/discovery/v2/events.json', transit: 'https://routes.googleapis.com/directions/v2:computeRoutes' });
type Credentials = { google: string; ticketmaster: string };
export type TransportConfig = { mode: 'production'; enabled: boolean; credentials: Credentials } |
  { mode: 'local-test'; endpoints: Record<Endpoint, string>; credentials: Credentials };
const credentialsSchema = z.strictObject({ google: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/), ticketmaster: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/) });
const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('production'), enabled: z.literal(true), credentials: credentialsSchema }),
  z.strictObject({ mode: z.literal('local-test'), endpoints: z.strictObject({ places: z.string().url(), events: z.string().url(), transit: z.string().url() }), credentials: credentialsSchema }),
]);
type Request = { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; headers?: Record<string, string>;
  query?: Record<string, string>; rpcId?: number; notification?: boolean; cleanup?: boolean };
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parse(text: string): unknown { try { return JSON.parse(text); } catch { throw new LiveError('invalid-response'); } }
function classify(status: number, body: unknown): void {
  const record = object(body), error = object(record?.error), fault = object(record?.fault);
  const code = String(error?.status ?? object(fault?.detail)?.errorcode ?? '');
  if ([401, 403].includes(status) || [401, 403].includes(Number(error?.code)) || ['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(code) || /InvalidApiKey|FailedToResolveAPIKey/.test(code)) throw new LiveError('auth');
  if (status === 429 || error?.code === 429 || code === 'RESOURCE_EXHAUSTED' || /QuotaViolation|SpikeArrestViolation/.test(code)) throw new LiveError('quota');
  if (status === 400 || error?.code === 400 || code === 'INVALID_ARGUMENT') throw new LiveError('invalid-response');
  if ((error || fault) && ![502, 503, 504].includes(status)) throw new LiveError('upstream');
}
function rpc(value: unknown, id: number): unknown {
  const message = object(value);
  if (!message || message.jsonrpc !== '2.0' || message.id !== id || message.error !== undefined || message.result === undefined) throw new LiveError('invalid-response');
  if (object(message.result)?.isError === true) throw new LiveError('invalid-response');
  return message.result;
}
function decode(text: string, contentType: string, rpcId?: number): unknown {
  if (contentType.split(';')[0]?.trim() === 'text/event-stream') {
    if (rpcId === undefined) throw new LiveError('invalid-response');
    let result: unknown, seen = false;
    const blocks = text.replaceAll('\r\n', '\n').split('\n\n');
    if (blocks.at(-1)?.trim()) throw new LiveError('invalid-response');
    for (const block of blocks) {
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (seen) throw new LiveError('invalid-response');
      const value = parse(data), message = object(value);
      if (message?.jsonrpc === '2.0' && message.method === 'notifications/progress' && message.id === undefined) continue;
      result = rpc(value, rpcId); seen = true;
    }
    if (!seen) throw new LiveError('invalid-response'); return result;
  }
  if (contentType.split(';')[0]?.trim() !== 'application/json') throw new LiveError('invalid-response');
  const value = parse(text); return rpcId === undefined ? value : rpc(value, rpcId);
}

/** Only three fixed source contracts. Local endpoint overrides require explicit local-test mode. */
export class LiveTransport {
  #endpoints: Record<Endpoint, string>;
  #credentials: Credentials;
  readonly mode: TransportConfig['mode'];
  constructor(config: TransportConfig) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new LiveError('not-configured');
    config = parsed.data;
    this.mode = config.mode;
    if (config.mode === 'production' && config.enabled !== true) throw new LiveError('not-configured');
    this.#endpoints = { ...(config.mode === 'local-test' ? config.endpoints : ENDPOINTS) };
    for (const endpoint of Object.values(this.#endpoints)) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash || /[\s\x00-\x1f]/.test(endpoint) ||
        (config.mode === 'local-test' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'))) throw new LiveError('not-configured');
    }
    this.#credentials = { ...config.credentials };
    if (Object.values(this.#credentials).some((key) => typeof key !== 'string' || !key || /[\r\n]/.test(key))) throw new LiveError('not-configured');
  }
  async request(run: BudgetRun, endpoint: Endpoint, purpose: Purpose, request: Request): Promise<{ value: unknown; sessionId?: string; status: number }> {
    for (;;) {
      const response = await run.dispatch(purpose, async (signal) => {
        const url = new URL(this.#endpoints[endpoint]);
        for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
        const headers: Record<string, string> = { Accept: endpoint === 'places' ? 'application/json, text/event-stream' : 'application/json', ...request.headers };
        if (endpoint === 'events') url.searchParams.set('apikey', this.#credentials.ticketmaster);
        else headers['X-Goog-Api-Key'] = this.#credentials.google;
        if (request.body !== undefined) headers['Content-Type'] = 'application/json';
        let result: Response;
        try { result = await fetch(url, { method: request.method, headers, redirect: 'error', signal,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }); }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof TypeError && String(error.cause).includes('redirect')) throw new LiveError('upstream');
          throw new LiveError('ambiguous-dispatch');
        }
        const chunks: Uint8Array[] = []; let bytes = 0;
        const reader = result.body?.getReader();
        try {
          if (reader) for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            run.consumeBytes(chunk.value.byteLength); bytes += chunk.value.byteLength;
            if (bytes > LIVE_LIMITS.responseBytes) throw new LiveError('oversize'); chunks.push(chunk.value);
          }
        } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { throw new LiveError('invalid-response'); }
        let errorBody: unknown;
        try { errorBody = JSON.parse(text); } catch { /* bounded non-JSON errors remain sanitized */ }
        classify(result.status, errorBody);
        if ([502, 503, 504].includes(result.status)) return { retry: true as const };
        if (request.cleanup && result.status === 405) return { retry: false as const, value: undefined, status: 405 };
        if (!result.ok) throw new LiveError('upstream');
        if (request.notification) {
          if (result.status !== 202 || text !== '') throw new LiveError('invalid-response');
          return { retry: false as const, value: undefined, status: result.status };
        }
        if (request.cleanup && !text) return { retry: false as const, value: undefined, status: result.status };
        const value = decode(text, result.headers.get('content-type') ?? '', request.rpcId);
        const sessionId = result.headers.get('mcp-session-id');
        if (sessionId !== null && !/^[\x21-\x7e]{1,128}$/.test(sessionId)) throw new LiveError('invalid-response');
        return { retry: false as const, value, status: result.status, ...(sessionId === null ? {} : { sessionId }) };
      });
      if (!response.retry) return response;
      // Notification, cleanup and inference are not transparently reissued.
      if (request.notification || request.cleanup || !run.claimRetry()) throw new LiveError('upstream');
      await run.retryDelay();
    }
  }
}
