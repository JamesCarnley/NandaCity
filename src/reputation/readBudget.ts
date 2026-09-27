import type { ReadRequestBudget, ReadRequestLease } from '../identity/rpcTransport.js';
import { feedbackIndexOrigin } from '../feedback/indexClient.js';

export type RankingReadLane = 'shared' | 'index-a' | 'index-b';
type Kind = 'rpc' | 'index';
type Counts = { calls: number; indexBytes: number; rpcBytes: number; pages: number; rows: number };
export type RankingReadBudgetSnapshot = {
  calls: number; bytes: number; bundleBytes: number; pages: number; rows: number; inFlight: number;
  lanes: Record<RankingReadLane, Counts>; diagnostics: string[];
};
type Options = { origins: readonly [string, string]; signal?: AbortSignal;
  limits?: { totalTimeoutMs?: number; requestTimeoutMs?: number } };
type Pending = { lane: RankingReadLane; kind: Kind; signal?: AbortSignal;
  resolve: (value: ReadRequestLease) => void; reject: (error: Error) => void; cancel: () => void };
const MiB = 1024 * 1024;
const counts = (): Counts => ({ calls: 0, indexBytes: 0, rpcBytes: 0, pages: 0, rows: 0 });

/** One consumer's fixed reservations, monotonic deadline and physical request semaphore. */
export class RankingReadBudget {
  readonly origins: readonly [string, string];
  private readonly deadline: number;
  private readonly requestTimeout: number;
  private readonly controller = new AbortController();
  private readonly lanes = { shared: counts(), 'index-a': counts(), 'index-b': counts() };
  private readonly active = new Map<ReadRequestLease, { lane: RankingReadLane; kind: Kind; dispatched: boolean; abort: () => void }>();
  private readonly queue: Pending[] = [];
  private readonly histories = new Map<string, number>();
  private readonly stopped = new Set<string>();
  private readonly diagnostics = new Set<string>();
  private calls = 0;
  private bytes = 0;
  private bundleBytes = 0;
  private pages = 0;
  private rows = 0;
  private disposed = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly inputSignal: AbortSignal | undefined;
  private readonly inputAbort: () => void;
  private drains: Array<() => void> = [];

  constructor(options: Options) {
    if (!Array.isArray(options.origins) || options.origins.length !== 2) throw new Error('invalid budget origins');
    const a = feedbackIndexOrigin(options.origins[0]), b = feedbackIndexOrigin(options.origins[1]);
    if (a === b) throw new Error('duplicate budget origin');
    this.origins = Object.freeze([a, b]);
    const total = options.limits?.totalTimeoutMs ?? 120_000;
    this.requestTimeout = options.limits?.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(total) || total <= 0 || total > 120_000 || !Number.isSafeInteger(this.requestTimeout) ||
      this.requestTimeout <= 0 || this.requestTimeout > 5_000 ||
      Object.keys(options.limits ?? {}).some((k) => k !== 'totalTimeoutMs' && k !== 'requestTimeoutMs')) throw new Error('invalid read budget limits');
    this.deadline = performance.now() + total;
    this.inputSignal = options.signal;
    this.inputAbort = () => this.stop('batch-cancelled');
    options.signal?.addEventListener('abort', this.inputAbort, { once: true });
    this.timer = setTimeout(() => this.stop('batch-deadline'), total);
    if (options.signal?.aborted) this.inputAbort();
  }
  private stop(code: string): void {
    this.diagnostics.add(code); this.controller.abort(new Error(code));
    for (const entry of this.active.values()) entry.abort();
    this.pump();
  }
  check(): void {
    if (this.disposed) throw new Error('batch-disposed');
    if (performance.now() >= this.deadline && !this.controller.signal.aborted) this.stop('batch-deadline');
    this.controller.signal.throwIfAborted();
    for (const pool of ['shared:calls', 'shared:rpc']) if (this.stopped.has(pool)) throw new Error(`read budget ${pool} exhausted`);
  }
  private laneCheck(lane: RankingReadLane, kind: Kind): void {
    this.check();
    for (const key of [`${lane}:calls`, `${lane}:${kind}`]) if (this.stopped.has(key)) throw new Error(`read budget ${key} exhausted`);
    if (this.calls >= 8192 || this.lanes[lane].calls >= (lane === 'shared' ? 4096 : 2048)) this.exhaust(lane, 'calls', 'call-budget');
  }
  private exhaust(lane: RankingReadLane, pool: Kind | 'calls', code: string): never {
    const key = `${lane}:${pool}`;
    this.stopped.add(key); this.diagnostics.add(`${key}:${code}`);
    // Already dispatched exchanges paid for their call; a refused next call must not cancel them.
    for (const entry of this.active.values()) if (entry.lane === lane && pool !== 'calls' && entry.kind === pool) entry.abort();
    throw new Error(`read budget ${key} ${code}`);
  }
  requestBudget(lane: RankingReadLane, kind: Kind): ReadRequestBudget {
    if (!Object.hasOwn(this.lanes, lane) || !['rpc', 'index'].includes(kind) || (lane === 'shared' && kind === 'index')) throw new Error('invalid request budget lane/kind');
    return Object.freeze({ open: (signal?: AbortSignal) => new Promise<ReadRequestLease>((resolve, reject) => {
      try { this.laneCheck(lane, kind); if (signal?.aborted) throw new Error('request cancelled');
        if (this.queue.length >= 96) throw new Error('request queue bound'); }
      catch (error) { reject(error); return; }
      const item: Pending = { lane, kind, ...(signal ? { signal } : {}), resolve, reject,
        cancel: () => { const i = this.queue.indexOf(item); if (i < 0) return;
          this.queue.splice(i, 1); signal?.removeEventListener('abort', item.cancel); reject(new Error('queued request cancelled')); } };
      signal?.addEventListener('abort', item.cancel, { once: true });
      this.queue.push(item); this.pump();
    }) });
  }
  private pump(): void {
    for (let i = 0; i < this.queue.length;) {
      const item = this.queue[i]!;
      let failure: Error | undefined;
      if (this.disposed || this.controller.signal.aborted) failure = new Error('batch cancelled/deadline');
      else if (item.signal?.aborted) failure = new Error('queued request cancelled');
      else if (this.stopped.has(`${item.lane}:calls`) || this.stopped.has(`${item.lane}:${item.kind}`)) failure = new Error('read budget lane exhausted');
      else if (this.calls + [...this.active.values()].filter((v) => !v.dispatched).length >= 8192 ||
        this.lanes[item.lane].calls + [...this.active.values()].filter((v) => !v.dispatched && v.lane === item.lane).length >=
        (item.lane === 'shared' ? 4096 : 2048)) failure = new Error('read budget call-budget');
      const occupied = item.lane !== 'shared' && [...this.active.values()].some((v) => v.lane === item.lane);
      if (!failure && (this.active.size >= 2 || occupied)) { i++; continue; }
      this.queue.splice(i, 1); item.signal?.removeEventListener('abort', item.cancel);
      if (failure) { item.reject(failure); continue; }
      const controller = new AbortController();
      const end = Math.min(this.deadline, performance.now() + this.requestTimeout);
      const abort = () => controller.abort(new Error('request cancelled/deadline'));
      item.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(0, end - performance.now()));
      let closed = false;
      const check = () => { this.check(); controller.signal.throwIfAborted();
        if (closed) throw new Error('request lease closed');
        if (performance.now() >= end) { abort(); throw new Error('request deadline'); }
        // First check is immediately before transport dispatch, not queue admission.
        const entry = this.active.get(lease)!;
        if (!entry.dispatched) { entry.dispatched = true; this.calls++; this.lanes[item.lane].calls++; } };
      const lease: ReadRequestLease = { signal: controller.signal, check,
        bytes: (length) => {
          check(); this.size(length);
          const lane = this.lanes[item.lane], key = item.kind === 'index' ? 'indexBytes' : 'rpcBytes';
          const limit = item.kind === 'index' || item.lane === 'shared' ? 8 * MiB : 4 * MiB;
          if (lane[key] + length > limit || this.bytes + length > 32 * MiB) this.exhaust(item.lane, item.kind, 'byte-budget');
          lane[key] += length; this.bytes += length;
        },
        close: () => { if (closed) return; closed = true; clearTimeout(timer);
          item.signal?.removeEventListener('abort', abort); this.active.delete(lease); this.pump();
          if (!this.active.size) { for (const resolve of this.drains.splice(0)) resolve(); } },
      };
      this.active.set(lease, { lane: item.lane, kind: item.kind, dispatched: false, abort }); item.resolve(lease);
    }
  }
  private size(n: number): void { if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid budget charge'); }
  chargeHistory(lane: Exclude<RankingReadLane, 'shared'>, pair: string, charge: { pages?: number; rows?: number }): void {
    this.check();
    if ((lane !== 'index-a' && lane !== 'index-b') || typeof pair !== 'string' || !pair.length || pair.length > 256) throw new Error('invalid history charge');
    const pages = charge.pages ?? 0, rows = charge.rows ?? 0; this.size(pages); this.size(rows);
    const key = `${lane}:${pair}`, previous = this.histories.get(key) ?? 0;
    const count = this.lanes[lane];
    if (previous + pages > 8 || count.pages + pages > 96 || this.pages + pages > 192 ||
      (!this.histories.has(key) && this.histories.size >= 96)) {
      this.diagnostics.add(`${lane}:history:page-budget`); throw new Error('history page-budget');
    }
    if (count.rows + rows > 1024 || this.rows + rows > 2048) {
      this.diagnostics.add(`${lane}:history:row-budget`); throw new Error('history row-budget');
    }
    this.histories.set(key, previous + pages); count.pages += pages; count.rows += rows;
    this.pages += pages; this.rows += rows;
  }
  chargeBundle(length: number): void {
    this.check(); this.size(length);
    if (this.lanes.shared.rpcBytes + length > 8 * MiB || this.bytes + length > 32 * MiB) this.exhaust('shared', 'rpc', 'byte-budget');
    this.lanes.shared.rpcBytes += length; this.bundleBytes += length; this.bytes += length;
  }
  snapshot(): RankingReadBudgetSnapshot {
    return Object.freeze({ calls: this.calls, bytes: this.bytes, bundleBytes: this.bundleBytes, pages: this.pages,
      rows: this.rows, inFlight: this.active.size, lanes: Object.freeze({ shared: Object.freeze({ ...this.lanes.shared }),
        'index-a': Object.freeze({ ...this.lanes['index-a'] }), 'index-b': Object.freeze({ ...this.lanes['index-b'] }) }),
      diagnostics: Object.freeze([...this.diagnostics]) as unknown as string[] });
  }
  async dispose(): Promise<void> {
    if (!this.disposed) { this.disposed = true; clearTimeout(this.timer);
      this.inputSignal?.removeEventListener('abort', this.inputAbort); this.stop('batch-disposed'); }
    if (this.active.size) await new Promise<void>((resolve) => this.drains.push(resolve));
  }
}
export function createRankingReadBudget(options: Options): RankingReadBudget { return new RankingReadBudget(options); }
