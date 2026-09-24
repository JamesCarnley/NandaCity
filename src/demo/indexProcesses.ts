import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const INDEX_PUBLIC_REPOSITORY = 'https://github.com/JamesCarnley/nanda-index-v2';
// Updated only after the reviewed public source commit is known.
export const INDEX_SOURCE_COMMIT = '94dca70d86fcd915d8f6e46442e1e3a71ebb9ce7';
const LABEL = 'org.nandacity.owned-demo';

export type IdentitySourceConfig = {
  chainId: number; registry: `0x${string}`; genesisHash: `0x${string}`;
  startBlock: string; adapter: 'nandacity-0.1'; confirmations: number;
};
export type OwnedIndex = { name: 'A' | 'B'; origin: string; database: string;
  stop: () => Promise<void> };
export type OwnedIndexEnvironment = {
  indexes: { A: OwnedIndex; B: OwnedIndex };
  restartA: () => Promise<OwnedIndex>;
  rebuildA: () => Promise<OwnedIndex>;
  stopA: () => Promise<void>;
  startA: () => Promise<OwnedIndex>;
  containerId: string;
};

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'] ?? '', ...extra };
}

export function safeCommandFailure(binary: string, _underlying: unknown): Error {
  // execFile errors include the full argv (including disposable DB passwords).
  return new Error(`${binary} failed; owned-resource operation aborted`);
}

async function command(binary: string, args: string[], cwd?: string,
  env: NodeJS.ProcessEnv = childEnv({})): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, { cwd, env, timeout: 120_000,
      maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return result.stdout.trim();
  } catch (error) { throw safeCommandFailure(binary, error); }
}

async function port(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no loopback port')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))]);
  if (exited) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function assertPinnedCheckout(indexCheckout: string): Promise<string> {
  if (!indexCheckout.startsWith('/')) throw new Error('Index checkout must be an absolute path');
  const checkout = await realpath(indexCheckout);
  if (checkout !== indexCheckout) throw new Error('Index checkout must not be a symlink');
  const head = await command('git', ['rev-parse', 'HEAD'], checkout);
  if (head !== INDEX_SOURCE_COMMIT) throw new Error(`Index source pin mismatch: expected ${INDEX_SOURCE_COMMIT}`);
  if (await command('git', ['status', '--porcelain'], checkout)) throw new Error('Index checkout must be clean');
  return checkout;
}

export function assertOwnedIndexReady(body: unknown, origin: string, sourceId: string): void {
  if (!body || typeof body !== 'object') throw new Error('owned Index readiness response malformed');
  const value = body as { observerOrigin?: unknown;
    coverage?: { identitySources?: Array<{ sourceId?: unknown }> } };
  if (value.observerOrigin !== origin) throw new Error('owned Index origin mismatch');
  const sources = value.coverage?.identitySources;
  if (!Array.isArray(sources) || sources.length !== 1 || sources[0]?.sourceId !== sourceId) {
    throw new Error('owned Index source mismatch');
  }
}

async function waitReady(origin: string, child: ChildProcess, sourceId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('owned Index exited before ready');
    try {
      const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok) {
        const response = await fetch(`${origin}/api/ard/services/search`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filter: { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'] },
            pageSize: 1 }), signal: AbortSignal.timeout(500), redirect: 'manual',
        });
        if (response.ok) {
          assertOwnedIndexReady(await response.json() as unknown, origin, sourceId);
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error && /owned Index (origin|source) mismatch/.test(error.message)) throw error;
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('owned Index did not become ready');
}

export async function withOwnedIndexes<T>(indexCheckout: string, source: IdentitySourceConfig,
  rpcUrls: { A: string; B: string }, run: (owned: OwnedIndexEnvironment) => Promise<T>): Promise<T> {
  const checkout = await assertPinnedCheckout(indexCheckout);
  const serverDir = join(checkout, 'server');
  // Do not trust an ignored, previously compiled dist/ from a clean tracked checkout.
  await command('npm', ['run', 'build'], serverDir);
  const nonce = randomBytes(8).toString('hex');
  const dbA = `city_a_${nonce}`;
  const dbB = `city_b_${nonce}`;
  const password = randomBytes(24).toString('hex');
  const ownedLabel = `city-${nonce}`;
  let containerId = '';
  let a: OwnedIndex | undefined;
  let b: OwnedIndex | undefined;
  let pgPort = 0;
  const processes = new Map<'A' | 'B', ChildProcess>();

  async function assertOwned(): Promise<void> {
    if (!containerId) throw new Error('no owned PostgreSQL container');
    const label = await command('docker', ['inspect', '--format', `{{index .Config.Labels "${LABEL}"}}`, containerId]);
    if (label !== ownedLabel) throw new Error('PostgreSQL ownership label mismatch');
  }
  async function sql(statement: string): Promise<void> {
    await assertOwned();
    await command('docker', ['exec', '-e', `PGPASSWORD=${password}`, containerId,
      'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', statement]);
  }
  async function start(name: 'A' | 'B'): Promise<OwnedIndex> {
    if (processes.has(name)) throw new Error(`Index ${name} already running`);
    const database = name === 'A' ? dbA : dbB;
    const indexPort = await port();
    const origin = `http://127.0.0.1:${indexPort}`;
    const env = childEnv({ NODE_ENV: 'development', PORT: String(indexPort),
      API_BASE_URL: origin, BIND_HOST: '127.0.0.1',
      DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/${database}`,
      ERC8004_IDENTITY_CONFIG: JSON.stringify({ ...source, rpcUrl: rpcUrls[name], pollMs: 100,
        maxBlockSpan: 200 }) });
    await command('node', ['dist/db/migrate.js'], serverDir, env);
    const child = spawn('node', ['dist/server.js'], { cwd: serverDir, env,
      stdio: ['ignore', 'ignore', 'ignore'] });
    processes.set(name, child);
    const sourceId = `erc8004-identity:${source.chainId}:${source.registry.toLowerCase()}`;
    try { await waitReady(origin, child, sourceId); }
    catch (error) { await stopChild(child); processes.delete(name); throw error; }
    return { name, origin, database, stop: async () => {
      if (processes.get(name) !== child) return;
      await stopChild(child);
      processes.delete(name);
    } };
  }
  async function stopA(): Promise<void> { await a?.stop(); }
  async function startA(): Promise<OwnedIndex> { a = await start('A'); return a; }
  async function restartA(): Promise<OwnedIndex> { await stopA(); return startA(); }
  async function rebuildA(): Promise<OwnedIndex> {
    await stopA();
    await sql(`DROP DATABASE ${dbA} WITH (FORCE)`);
    await sql(`CREATE DATABASE ${dbA}`);
    return startA();
  }

  try {
    containerId = await command('docker', ['run', '-d', '--label', `${LABEL}=${ownedLabel}`,
      '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16']);
    await assertOwned();
    const binding = await command('docker', ['port', containerId, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('PostgreSQL must publish only on loopback');
    pgPort = Number(match[1]);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const logs = await command('docker', ['logs', containerId]);
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        try { await command('docker', ['exec', containerId, 'pg_isready', '-U', 'postgres']); break; }
        catch { /* final post-init server not ready yet */ }
      }
      if (Date.now() > deadline) throw new Error('owned PostgreSQL not ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await sql(`CREATE DATABASE ${dbA}`);
    await sql(`CREATE DATABASE ${dbB}`);
    a = await start('A');
    b = await start('B');
    return await run({ indexes: { A: a, B: b }, restartA, rebuildA,
      stopA, startA, containerId });
  } finally {
    await Promise.all([...processes.values()].map(stopChild));
    if (containerId) { await assertOwned(); await command('docker', ['rm', '-f', containerId]); }
  }
}
