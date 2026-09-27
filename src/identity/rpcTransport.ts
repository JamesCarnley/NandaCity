/** A fixed-lane lease. First check immediately before dispatch charges the call;
 * close only after owned I/O settles or is canceled. */
export type ReadRequestLease = { signal: AbortSignal; check(): void; bytes(chunkLength: number): void; close(): void };
export type ReadRequestBudget = { open(signal?: AbortSignal): Promise<ReadRequestLease> };

/** Bound streamed RPC responses before JSON decoding, including owned cancellation. */
export function boundRpcFetch(fetcher: typeof fetch, options: { budget?: ReadRequestBudget; signal?: AbortSignal } = {}): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const incoming = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [incoming, options.signal].filter((s): s is AbortSignal => !!s);
    const abort = () => controller.abort(new Error('RPC request cancelled'));
    for (const signal of signals) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    let lease: ReadRequestLease | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      controller.signal.throwIfAborted();
      lease = await options.budget?.open(controller.signal);
      const leaseAbort = () => controller.abort(lease?.signal.reason);
      lease?.signal.addEventListener('abort', leaseAbort, { once: true });
      const start = performance.now();
      try {
        if (lease?.signal.aborted) leaseAbort();
        timer = setTimeout(() => controller.abort(new Error('RPC request deadline')), 5_000);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('accept-encoding', 'identity');
        controller.signal.throwIfAborted(); lease?.check();
        response = await fetcher(input, { ...init, headers, redirect: 'manual', signal: controller.signal });
        if (response.status >= 300 && response.status < 400) throw new Error('RPC redirect refused');
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding !== 'identity') throw new Error('RPC content encoding refused');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > 512n * 1024n)) {
          throw new Error('RPC response exceeds 512 KiB or invalid length');
        }
        reader = response.body?.getReader();
        if (!reader) throw new Error('RPC response has no body');
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted(); lease?.check();
          if (done) break;
          lease?.bytes(value.byteLength);
          length += value.byteLength;
          if (length > 512 * 1024) throw new Error('RPC response exceeds 512 KiB');
          chunks.push(value);
        }
        if (declared !== null && BigInt(declared) !== BigInt(length)) throw new Error('RPC truncated response');
        controller.signal.throwIfAborted(); lease?.check();
        if (performance.now() - start >= 5_000) throw new Error('RPC request deadline');
        return new Response(Buffer.concat(chunks, length), { status: response.status, statusText: response.statusText,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
      } finally { lease?.signal.removeEventListener('abort', leaseAbort); }
    } finally {
      controller.abort();
      try { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await response?.body?.cancel().catch(() => {}); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener('abort', abort);
        lease?.close();
      }
    }
  };
}
export const boundedRpcFetch: typeof fetch = boundRpcFetch((input, init) => fetch(input, init));
