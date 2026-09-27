import type { ReadRequestBudget, ReadRequestLease } from '../identity/rpcTransport.js';

export type DiscoveryRequestKind = 'search' | 'observation' | 'card' | 'rpc';
export type DiscoveryBudgetSnapshot = Readonly<{
  requests: number;
  /** Decoded stream bytes admitted to processing (at most 16 MiB). */
  bytes: number;
  /** A chunk crossing the remaining allowance is counted here, discarded, and aborts the lane. */
  discardedBytes: number;
  inFlight: number;
  kinds: Readonly<Record<DiscoveryRequestKind, number>>;
  exhausted: readonly string[];
}>;
export type DiscoveryLimits = { totalTimeoutMs?: number; requestTimeoutMs?: number };
type Lane = { requests: number; bytes: number; discardedBytes: number; kinds: Record<DiscoveryRequestKind, number>; exhausted: Set<string> };

/** Fixed independent acquisition reservations; ranking owns a separate ledger. */
export class DiscoveryReadBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly lanes = new Map<string, Lane>();
  private readonly active = new Map<ReadRequestLease, { origin: string; abort: () => void; dispatched: boolean }>();
  private readonly deadline: number;
  private readonly requestTimeout: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly inputSignal: AbortSignal | undefined;
  private readonly inputAbort: () => void;
  private readonly drains: Array<() => void> = [];
  private disposed = false;

  constructor(options: { origins: readonly [string, string]; signal?: AbortSignal; limits?: DiscoveryLimits }) {
    if (options.origins.length !== 2 || new Set(options.origins).size !== 2) throw new Error('two distinct discovery origins required');
    const total = options.limits?.totalTimeoutMs ?? 30_000;
    this.requestTimeout = options.limits?.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(total) || total < 1 || total > 30_000 || !Number.isSafeInteger(this.requestTimeout) ||
      this.requestTimeout < 1 || this.requestTimeout > 5_000 ||
      Object.keys(options.limits ?? {}).some((key) => !['totalTimeoutMs', 'requestTimeoutMs'].includes(key))) throw new Error('invalid discovery limits');
    for (const origin of options.origins) this.lanes.set(origin, { requests: 0, bytes: 0, discardedBytes: 0,
      kinds: { search: 0, observation: 0, card: 0, rpc: 0 }, exhausted: new Set() });
    this.signal = this.controller.signal;
    this.deadline = performance.now() + total;
    this.inputSignal = options.signal;
    this.inputAbort = () => this.stop('cancelled');
    options.signal?.addEventListener('abort', this.inputAbort, { once: true });
    this.timer = setTimeout(() => this.stop('deadline'), total);
    if (options.signal?.aborted) this.inputAbort();
  }
  private stop(code: string): void {
    for (const lane of this.lanes.values()) lane.exhausted.add(code);
    this.controller.abort(new Error(`discovery ${code}`));
    for (const entry of this.active.values()) entry.abort();
  }
  private lane(origin: string): Lane {
    const lane = this.lanes.get(origin); if (!lane) throw new Error('unknown discovery origin'); return lane;
  }
  check(origin?: string): void {
    if (this.disposed) throw new Error('discovery disposed');
    if (performance.now() >= this.deadline && !this.signal.aborted) this.stop('deadline');
    this.signal.throwIfAborted();
    if (origin) for (const code of this.lane(origin).exhausted) if (code !== 'request-timeout') throw new Error(`discovery ${code}`);
  }
  requestBudget(origin: string, kind: DiscoveryRequestKind): ReadRequestBudget {
    const lane = this.lane(origin);
    if (!Object.hasOwn(lane.kinds, kind)) throw new Error('unknown discovery request kind');
    return { open: async (input?: AbortSignal) => {
      this.check(origin); input?.throwIfAborted();
      if (lane.requests + [...this.active.values()].filter((entry) => entry.origin === origin && !entry.dispatched).length >= 64) {
        lane.exhausted.add('request-budget'); throw new Error('discovery request-budget');
      }
      const controller = new AbortController(), end = Math.min(this.deadline, performance.now() + this.requestTimeout);
      const abort = () => controller.abort(new Error('discovery request cancelled/deadline'));
      input?.addEventListener('abort', abort, { once: true });
      const timeout = () => {
        if (end === this.deadline) this.stop('deadline');
        else { lane.exhausted.add('request-timeout'); abort(); }
      };
      const timer = setTimeout(timeout, Math.max(0, end - performance.now()));
      let closed = false;
      const lease: ReadRequestLease = {
        signal: controller.signal,
        check: () => {
          if (closed) throw new Error('discovery lease closed');
          this.check(); controller.signal.throwIfAborted();
          if (performance.now() >= end) { timeout(); controller.signal.throwIfAborted(); }
          const entry = this.active.get(lease)!;
          if (!entry.dispatched) { this.check(origin); entry.dispatched = true; lane.requests++; lane.kinds[kind]++; }
        },
        bytes: (length) => {
          lease.check();
          if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid byte charge');
          if (lane.bytes + length > 16 * 1024 * 1024) {
            lane.discardedBytes += length;
            lane.exhausted.add('byte-budget');
            for (const entry of this.active.values()) if (entry.origin === origin) entry.abort();
            throw new Error('discovery byte-budget');
          }
          lane.bytes += length;
        },
        close: () => {
          if (closed) return; closed = true; clearTimeout(timer); input?.removeEventListener('abort', abort);
          this.active.delete(lease);
          if (!this.active.size) for (const drain of this.drains.splice(0)) drain();
        },
      };
      this.active.set(lease, { origin, abort, dispatched: false });
      return lease;
    } };
  }
  snapshot(origin: string): DiscoveryBudgetSnapshot {
    const lane = this.lane(origin);
    return { requests: lane.requests, bytes: lane.bytes, discardedBytes: lane.discardedBytes, kinds: { ...lane.kinds },
      inFlight: [...this.active.values()].filter((entry) => entry.origin === origin).length,
      exhausted: [...lane.exhausted] };
  }
  async dispose(): Promise<void> {
    if (!this.disposed) { this.disposed = true; clearTimeout(this.timer);
      this.inputSignal?.removeEventListener('abort', this.inputAbort);
      for (const entry of this.active.values()) entry.abort(); }
    if (this.active.size) await new Promise<void>((resolve) => this.drains.push(resolve));
  }
}
