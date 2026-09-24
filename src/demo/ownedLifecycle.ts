import { AsyncLocalStorage } from 'node:async_hooks';

export type OwnedLifecycle = {
  signal: AbortSignal;
  check: () => void;
};
const current = new AsyncLocalStorage<OwnedLifecycle>();
class OwnedCancellation extends Error {}

/** Guard before starting a mutation, never between acquiring and recording it. */
export function checkOwnedCancellation(): void { current.getStore()?.check(); }
/** Compose, do not replace, the RPC transport's per-request deadline signal. */
export const ownedFetch: typeof fetch = (input, init) => {
  const cancellation = current.getStore()?.signal;
  if (!cancellation) return fetch(input, init);
  const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetch(input, { ...init, signal: requestSignal ?
    AbortSignal.any([cancellation, requestSignal]) : cancellation });
};

/** Nested resource scopes share one signal owner. Cleanup is lexical: cancellation
 * unwinds awaited work, not a Promise.race against still-running acquisition.
 * Callbacks must observe signal/check and await all work they start. */
export async function withOwnedLifecycle<T>(run: (lifecycle: OwnedLifecycle) => Promise<T>): Promise<T> {
  const existing = current.getStore();
  if (existing) { existing.check(); return run(existing); }
  const controller = new AbortController();
  let received: 'SIGINT' | 'SIGTERM' | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const lifecycle: OwnedLifecycle = { signal: controller.signal,
    check: () => { controller.signal.throwIfAborted(); } };
  const remove = (): void => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (watchdog) clearTimeout(watchdog);
  };
  const finishSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    remove();
    process.kill(process.pid, signal);
  };
  const cancel = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (received) {
      process.stderr.write('Owned demo cleanup is still in progress (180 second hard deadline).\n');
      return; // Repeated signals never reset the bounded shutdown deadline.
    }
    received = signal;
    controller.abort(new OwnedCancellation(`owned demo cancelled by ${signal}`));
    // Covers a contract-violating callback that ignores cancellation. This is a
    // reported cleanup failure, not a success claim or an early-exit race.
    watchdog = setTimeout(() => {
      process.stderr.write('Owned demo cleanup did not finish within 180 seconds; resources may remain.\n');
      finishSignal(signal);
    }, 180_000);
  };
  const interrupt = (): void => cancel('SIGINT');
  const terminate = (): void => cancel('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await current.run(lifecycle, async () => {
      const value = await run(lifecycle);
      lifecycle.check();
      return value;
    });
  } catch (error) {
    if (received && !(error instanceof OwnedCancellation)) {
      // Cleanup errors must not disappear behind the conventional signal exit.
      process.stderr.write(`Owned demo cancellation/cleanup failed: ${String(error)}\n`);
    }
    throw error;
  } finally {
    if (received) {
      finishSignal(received);
      // Give the OS signal the exit, rather than a rejected top-level promise.
      await new Promise<never>(() => {});
    }
    remove();
  }
}
