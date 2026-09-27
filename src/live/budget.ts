import { mkdir, open, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isUtcSecond } from '../interaction/schema.js';

export const LIVE_LIMITS = Object.freeze({ attempts: 10, concurrency: 2, overallMs: 60_000,
  dataMs: 10_000, inferenceMs: 20_000, responseBytes: 1024 * 1024, aggregateBytes: 4 * 1024 * 1024,
  inputTokens: 8000, outputTokens: 2000 });
export const failureSchema = z.enum(['not-configured', 'policy-unapproved', 'auth', 'quota', 'deadline',
  'cancelled', 'budget', 'oversize', 'invalid-response', 'upstream', 'unsupported-contract', 'ambiguous-dispatch']);
export type LiveFailure = z.infer<typeof failureSchema>;
export class LiveError extends Error {
  constructor(readonly reason: LiveFailure) { super(reason); }
}
export function safeFailure(error: unknown): LiveFailure { return error instanceof LiveError ? error.reason : 'ambiguous-dispatch'; }
export const cleanupFindingSchema = z.enum(['not-needed', 'closed', 'unsupported', 'remote-cancellation-unconfirmed']);
const runDiagnosticSchema = z.strictObject({ failureReason: failureSchema, cleanup: cleanupFindingSchema });
export type RunDiagnostic = z.infer<typeof runDiagnosticSchema>;
const purposeSchema = z.enum(['initialize', 'initialized', 'list', 'places', 'events', 'transit', 'generate', 'cancel', 'delete']);
export type Purpose = z.infer<typeof purposeSchema>;
const amount = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const attemptSchema = z.strictObject({ purpose: purposeSchema, costMicros: amount,
  outcome: z.union([z.literal('reserved'), z.literal('ok'), failureSchema]) });
const stateSchema = z.strictObject({ version: z.literal('0.1'), runs: z.array(z.strictObject({
  taskId: id, capMicros: amount, holdMicros: amount, closed: z.boolean(), attempts: z.array(attemptSchema).max(10),
  diagnostic: runDiagnosticSchema.optional(),
})).max(1000) });
type State = z.infer<typeof stateSchema>;
export type BudgetOptions = { sessionCapMicros: string; runCapMicros: string;
  prices: Partial<Record<Purpose, string>>; pricingExpiresAt: string; now?: () => number;
  /** Clock-controlled waiting is for owned tests; never provider/model-controlled. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void> };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new LiveError('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One owned writer per directory. Stale lock removal requires explicit operator reconciliation. */
export class LiveBudget {
  #state: State;
  #tail: Promise<unknown> = Promise.resolve();
  #active = 0;
  #waiters = new Set<() => void>();
  #events: number[] = [];
  #closed = false;
  #closeComplete = false;
  #closing: Promise<void> | undefined;
  #lockClosed = false;
  #writerReleased = false;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private constructor(private directory: string, private lock: FileHandle, private options: BudgetOptions, state: State) {
    this.#state = state; this.now = options.now ?? Date.now; this.sleep = options.sleep ?? pause;
  }
  static async open(directory: string, options: BudgetOptions): Promise<LiveBudget> {
    try {
      amount.parse(options.sessionCapMicros); amount.parse(options.runCapMicros);
      if (!isUtcSecond(options.pricingExpiresAt)) throw new Error();
      for (const [purpose, price] of Object.entries(options.prices)) { purposeSchema.parse(purpose); amount.parse(price); }
    } catch { throw new LiveError('not-configured'); }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lock: FileHandle;
    try { lock = await open(join(directory, 'writer.lock'), 'wx', 0o600); }
    catch { throw new Error('live budget writer unavailable; reconcile existing lock'); }
    try {
      let state: State = { version: '0.1', runs: [] };
      try {
        if ((await stat(join(directory, 'budget.json'))).size > 2 * 1024 * 1024) throw new LiveError('invalid-response');
        state = stateSchema.parse(JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LiveError('invalid-response'); }
      if (new Set(state.runs.map((run) => run.taskId)).size !== state.runs.length || state.runs.some((run) =>
        run.attempts.reduce((n, a) => n + BigInt(a.costMicros), 0n) > BigInt(run.holdMicros) || BigInt(run.holdMicros) > BigInt(run.capMicros) ||
        run.attempts.filter((a) => a.purpose === 'delete').length > 1 || run.attempts.filter((a) => a.purpose === 'cancel').length > 1 ||
        run.attempts.filter((a) => a.purpose !== 'delete' && a.purpose !== 'cancel').length > 8)) throw new LiveError('invalid-response');
      return new LiveBudget(directory, lock, { ...options, prices: { ...options.prices } }, state);
    } catch (error) { await lock.close(); await unlink(join(directory, 'writer.lock')); throw error; }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action); this.#tail = next.catch(() => undefined); return next;
  }
  private async save(): Promise<void> {
    const temporary = join(this.directory, 'budget.pending');
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(this.#state)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(this.directory, 'budget.json'));
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  snapshot(): { reservedCostMicros: string; runs: State['runs'] } {
    return { reservedCostMicros: this.#state.runs.flatMap((r) => r.attempts).reduce((n, a) => n + BigInt(a.costMicros), 0n).toString(),
      runs: structuredClone(this.#state.runs) };
  }
  async begin(taskId: string, signal?: AbortSignal, deadline?: number): Promise<BudgetRun> {
    return this.serial(async () => {
      if (this.#closed || !id.safeParse(taskId).success) throw new LiveError('not-configured');
      if (this.#state.runs.some((r) => r.taskId === taskId)) throw new LiveError('ambiguous-dispatch');
      if (this.now() >= Date.parse(this.options.pricingExpiresAt)) throw new LiveError('not-configured');
      const prices = purposeSchema.options.map((purpose) => this.options.prices[purpose]);
      if (prices.some((p) => p === undefined)) throw new LiveError('not-configured');
      const max = prices.reduce((m, p) => BigInt(p!) > m ? BigInt(p!) : m, 0n);
      // Conservative cold-session admission includes both cleanup dispatches and the retry.
      const exposure = this.#state.runs.reduce((sum, run) => sum + (run.closed ? run.attempts.reduce((n, a) => n + BigInt(a.costMicros), 0n) : BigInt(run.holdMicros)), 0n);
      if (BigInt(this.options.runCapMicros) < max * 10n || exposure + max * 10n > BigInt(this.options.sessionCapMicros) || this.#state.runs.length >= 1000) throw new LiveError('budget');
      const end = Math.min(this.now() + LIVE_LIMITS.overallMs, deadline ?? Infinity);
      if (end <= this.now()) throw new LiveError('deadline');
      if (signal?.aborted) throw new LiveError('cancelled');
      this.#state.runs.push({ taskId, capMicros: this.options.runCapMicros, holdMicros: (max * 10n).toString(), closed: false, attempts: [] });
      await this.save();
      return new BudgetRun(this, taskId, end, signal);
    });
  }
  async reserve(taskId: string, purpose: Purpose): Promise<number> {
    return this.serial(async () => {
      const run = this.#state.runs.find((r) => r.taskId === taskId)!;
      const price = this.options.prices[purpose];
      if (this.#closed || price === undefined || this.now() >= Date.parse(this.options.pricingExpiresAt)) throw new LiveError('not-configured');
      const cleanup = purpose === 'delete' || purpose === 'cancel';
      const work = run.attempts.filter((a) => a.purpose !== 'delete' && a.purpose !== 'cancel').length;
      if (run.attempts.length >= 10 || (!cleanup && work >= 8) ||
        (cleanup && run.attempts.some((a) => a.purpose === purpose)) ||
        run.attempts.reduce((n, a) => n + BigInt(a.costMicros), BigInt(price)) > BigInt(run.capMicros) ||
        BigInt(this.snapshot().reservedCostMicros) + BigInt(price) > BigInt(this.options.sessionCapMicros)) throw new LiveError('budget');
      run.attempts.push({ purpose, costMicros: price, outcome: 'reserved' });
      await this.save(); return run.attempts.length - 1;
    });
  }
  async settle(taskId: string, index: number, outcome: 'ok' | LiveFailure): Promise<void> {
    return this.serial(async () => {
      if (this.#writerReleased) throw new LiveError('not-configured');
      this.#state.runs.find((r) => r.taskId === taskId)!.attempts[index]!.outcome = outcome;
      await this.save();
    });
  }
  async finish(taskId: string, diagnostic?: RunDiagnostic): Promise<void> {
    return this.serial(async () => {
      if (this.#writerReleased) throw new LiveError('not-configured');
      const checked = diagnostic === undefined ? undefined : runDiagnosticSchema.parse(diagnostic);
      const run = this.#state.runs.find((r) => r.taskId === taskId)!;
      run.closed = true;
      if (checked) run.diagnostic = checked;
      await this.save();
    });
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.#active >= LIVE_LIMITS.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); this.#waiters.delete(wake); resolve(); };
        const abort = () => { this.#waiters.delete(wake); reject(new LiveError('cancelled')); };
        this.#waiters.add(wake); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
    if (signal.aborted) throw new LiveError('cancelled');
    if (this.#closed) throw new LiveError('not-configured');
    this.#active++;
    return () => { this.#active--; for (const wake of this.#waiters) wake(); };
  }
  async eventRate<T>(signal: AbortSignal, dispatch: () => Promise<T>): Promise<T> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      this.#events = this.#events.filter((at) => this.now() - at < 1000);
      // No await between recording the rate slot and starting the physical callback.
      if (this.#events.length < 2) { this.#events.push(this.now()); return dispatch(); }
      await this.sleep(Math.max(1, 1000 - (this.now() - this.#events[0]!)), signal);
    }
  }
  async close(): Promise<void> {
    if (this.#closeComplete) return;
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const closing = this.serial(async () => {
      if (this.#active) throw new Error('live budget still has dispatched work');
      // Fence before the first asynchronous release step, including failed release retries.
      // Late continuations leave their conservative durable hold untouched.
      this.#writerReleased = true;
      if (!this.#lockClosed) { await this.lock.close(); this.#lockClosed = true; }
      await unlink(join(this.directory, 'writer.lock'));
      this.#closeComplete = true;
    });
    this.#closing = closing;
    try { await closing; } finally { this.#closing = undefined; }
  }
}

export class BudgetRun {
  #controller = new AbortController();
  #retried = false;
  #bytes = 0;
  #done = false;
  #timer: NodeJS.Timeout;
  #unlink: () => void;
  constructor(private ledger: LiveBudget, readonly taskId: string, readonly deadline: number, signal?: AbortSignal) {
    const abort = () => this.cancel(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); // Admission may have awaited durable storage after the caller aborted.
    this.#unlink = () => signal?.removeEventListener('abort', abort);
    this.#timer = setTimeout(() => this.#controller.abort(new LiveError('deadline')), Math.max(1, deadline - ledger.now()));
    this.#timer.unref();
  }
  now(): number { return this.ledger.now(); }
  remaining(): number { return Math.max(0, this.deadline - this.now()); }
  cancel(): void { this.#controller.abort(new LiveError('cancelled')); }
  async finish(diagnostic?: RunDiagnostic): Promise<void> {
    if (this.#done) return;
    this.#done = true; clearTimeout(this.#timer); this.#unlink(); await this.ledger.finish(this.taskId, diagnostic);
  }
  claimRetry(): boolean { if (this.#retried || this.remaining() < 1000 || this.#controller.signal.aborted) return false; this.#retried = true; return true; }
  async retryDelay(): Promise<void> { await this.ledger.sleep(100 + Math.floor(Math.random() * 101), this.#controller.signal); }
  consumeBytes(count: number): void {
    this.#bytes += count;
    if (this.#bytes > LIVE_LIMITS.aggregateBytes) throw new LiveError('oversize');
  }
  usage(): { physicalAttempts: number; reservedCostMicros: string } {
    const attempts = this.ledger.snapshot().runs.find((r) => r.taskId === this.taskId)!.attempts;
    return { physicalAttempts: attempts.length, reservedCostMicros: attempts.reduce((n, a) => n + BigInt(a.costMicros), 0n).toString() };
  }
  async dispatch<T>(purpose: Purpose, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#done || this.remaining() <= 0) throw new LiveError('deadline');
    const cleanup = purpose === 'cancel' || purpose === 'delete';
    if (this.#controller.signal.aborted && (!cleanup || safeFailure(this.#controller.signal.reason) === 'deadline')) throw this.#controller.signal.reason;
    const controller = new AbortController();
    const abort = () => controller.abort(this.#controller.signal.reason);
    if (!cleanup) this.#controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new LiveError('deadline')), Math.min(this.remaining(), purpose === 'generate' ? LIVE_LIMITS.inferenceMs : LIVE_LIMITS.dataMs));
    let release: (() => void) | undefined, index: number | undefined;
    try {
      release = await this.ledger.acquire(controller.signal);
      if (this.remaining() <= 0) throw new LiveError('deadline');
      if (controller.signal.aborted) throw controller.signal.reason;
      index = await this.ledger.reserve(this.taskId, purpose);
      const invoke = () => {
        if (this.remaining() <= 0) throw new LiveError('deadline');
        if (controller.signal.aborted) throw controller.signal.reason;
        return work(controller.signal);
      };
      const pending = purpose === 'events' ? this.ledger.eventRate(controller.signal, invoke) : Promise.resolve().then(invoke);
      const held = release; release = undefined;
      void pending.finally(held).catch(() => undefined); // Non-cooperative inference keeps its account slot.
      const result = await new Promise<T>((resolve, reject) => {
        const stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop)).catch(() => undefined);
        if (controller.signal.aborted) stop();
      });
      if (this.remaining() <= 0) throw new LiveError('deadline');
      await this.ledger.settle(this.taskId, index, 'ok'); return result;
    } catch (error) {
      const reason = safeFailure(error);
      if (index !== undefined) await this.ledger.settle(this.taskId, index, reason);
      throw new LiveError(reason);
    } finally { release?.(); clearTimeout(timer); this.#controller.signal.removeEventListener('abort', abort); }
  }
}
