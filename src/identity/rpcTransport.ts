/** Bound streamed RPC responses before JSON decoding, including custom owned fetch lifecycles. */
export function boundRpcFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = AbortSignal.timeout(5_000);
    const response = await fetcher(input, { ...init, redirect: 'manual',
      signal: requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('RPC redirect refused');
    }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > 512 * 1024) {
      await response.body?.cancel();
      throw new Error('RPC response exceeds 512 KiB');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('RPC response has no body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512 * 1024) {
        await reader.cancel();
        throw new Error('RPC response exceeds 512 KiB');
      }
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
  };
}
export const boundedRpcFetch: typeof fetch = boundRpcFetch((input, init) => fetch(input, init));
