/** Fetch only an exact card path at a separately configured loopback origin. */
export async function fetchOwnedCard(url: string, allowedOrigin: string, signal?: AbortSignal): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.origin !== allowedOrigin || parsed.protocol !== 'http:' ||
    parsed.username || parsed.password || parsed.hash || parsed.search ||
    !/^\/cards\/[0-9]+\.json$/.test(parsed.pathname)) {
    throw new Error('card URL outside owned exact loopback allowlist');
  }
  signal?.throwIfAborted();
  const response = await fetch(parsed, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`owned card HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('owned card has no response body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try { for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 64 * 1024) throw new Error('owned card exceeds 64 KiB');
    chunks.push(value);
  } } catch (error) { signal?.throwIfAborted(); throw error; }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks));
}
