import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRankingEvidence, type RankingEvidenceInput } from '../reputation/evidence.js';
import type { PolicyResult } from '../reputation/policy.js';

const MAX_BYTES = 2 * 1024 * 1024;
/** Private raw inputs only. No verdict, credentials or paths in argv/environment. */
export async function rankingConsumerMain(): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => { deadline.abort(); process.stdin.destroy(new Error('consumer deadline')); }, 60000);
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length; if (length > MAX_BYTES) throw new Error(); chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'signal')) throw new Error();
    const observation = value['observation'] as Record<string, unknown> | undefined;
    const block = observation?.['blockNumber'];
    if (typeof block !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(block)) throw new Error();
    const result = await readRankingEvidence({ ...value, observation: { ...observation, blockNumber: BigInt(block) }, signal: deadline.signal } as RankingEvidenceInput);
    const output = JSON.stringify({ policyInput: result.policyInput, policyResult: result.policyResult });
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error(); process.stdout.write(output);
  } catch { process.stderr.write('Ranking consumer unavailable.\n'); process.exitCode = 1; }
  finally { clearTimeout(timer); }
}

export async function runFreshRankingConsumer(input: RankingEvidenceInput, expected: PolicyResult | null,
  signal: AbortSignal): Promise<{ status: 'matched' | 'different' | 'unavailable'; reason: string }> {
  signal.throwIfAborted();
  const { signal: _signal, ...privateInput } = input;
  const bytes = Buffer.from(JSON.stringify(privateInput, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  if (bytes.length > MAX_BYTES) { bytes.fill(0); return { status: 'unavailable', reason: 'raw-input-bound' }; }
  const built = import.meta.url.endsWith('.js');
  const worker = fileURLToPath(new URL(`./rankingConsumerCli.${built ? 'js' : 'ts'}`, import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(built ? [] : ['--import', 'tsx']), worker], {
      env: { PATH: process.env['PATH'] ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let failed = false, length = 0; const chunks: Buffer[] = [];
    const kill = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, 60000); signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_BYTES) kill(); else chunks.push(chunk); });
    child.stderr.on('data', kill); child.on('error', kill); child.stdin.on('error', kill);
    child.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', kill); bytes.fill(0);
      let result: { status: 'matched' | 'different' | 'unavailable'; reason: string } = { status: 'unavailable', reason: 'fresh-reader-unavailable' };
      try {
        if (failed || code !== 0 || signal.aborted) throw new Error();
        const output = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { policyResult?: unknown };
        if (!expected || !output.policyResult) throw new Error();
        result = isDeepStrictEqual(output.policyResult, expected) ? { status: 'matched', reason: 'same-policy-same-observation' } :
          { status: 'different', reason: 'recomputed-policy-differs' };
      } catch { /* bounded diagnostic only */ }
      for (const chunk of chunks) chunk.fill(0); resolve(result);
    });
    child.stdin.end(bytes); if (signal.aborted) kill();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await rankingConsumerMain();
