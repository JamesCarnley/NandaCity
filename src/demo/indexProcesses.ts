import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkOwnedCancellation, withOwnedLifecycle, type OwnedLifecycle } from './ownedLifecycle.js';
import { feedbackSourceId, type FeedbackIndexSource } from '../feedback/indexClient.js';

const execFileAsync = promisify(execFile);
export const INDEX_PUBLIC_REPOSITORY = 'https://github.com/JamesCarnley/nanda-index-v2';
// Updated only after the reviewed public source commit is known.
export const INDEX_SOURCE_COMMIT = 'b9c6ccef4907c5dc3c7d9d898cf671207166f435';
const LABEL = 'org.nandacity.owned-demo';

export type IdentitySourceConfig = {
  chainId: number; registry: `0x${string}`; genesisHash: `0x${string}`;
  startBlock: string; adapter: 'nandacity-0.1'; confirmations: number;
};
export type OwnedIndex = { name: 'A' | 'B'; origin: string; database: string;
  verifyOrganizationEmail: (orgId: string) => Promise<void>;
  stop: () => Promise<void> };
export type OwnedIndexEnvironment = {
  indexes: { A: OwnedIndex; B: OwnedIndex };
  restart: (name: 'A' | 'B') => Promise<OwnedIndex>;
  rebuild: (name: 'A' | 'B') => Promise<OwnedIndex>;
  stop: (name: 'A' | 'B') => Promise<void>;
  start: (name: 'A' | 'B') => Promise<OwnedIndex>;
  restartA: () => Promise<OwnedIndex>;
  rebuildA: () => Promise<OwnedIndex>;
  stopA: () => Promise<void>;
  startA: () => Promise<OwnedIndex>;
  containerId: string;
  lifecycle: OwnedLifecycle;
};
export type OriginArchiveConfig = { sourceBaseUrl: string; snapshotDigests: string[]; pollMs: number };
type IndexOptions = { serverExecutable?: string; originArchive?: Record<'A' | 'B', OriginArchiveConfig>;
  feedback?: Partial<Record<'A' | 'B', FeedbackIndexSource & { documentUrls: string[] }>> };

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'] ?? '', ...extra };
}

export function safeCommandFailure(binary: string, _underlying: unknown): Error {
  // execFile errors include the full argv (including disposable DB passwords).
  return new Error(`${binary} failed; owned-resource operation aborted`);
}

async function command(binary: string, args: string[], cwd?: string,
  env: NodeJS.ProcessEnv = childEnv({}), timeout = 120_000): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, { cwd, env, timeout, killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return result.stdout.trim();
  } catch (error) { throw safeCommandFailure(binary, error); }
}

type DockerCommand = (args: string[], timeout: number) => Promise<string>;
/** Resolve once, without changing global context. --host pins every subsequent
 * operation, including cleanup, even if the saved context changes mid-run. */
export async function resolveLocalDocker(env: NodeJS.ProcessEnv = process.env,
  run: DockerCommand = (args, timeout) => command('docker', args, undefined, childEnv({}), timeout)):
  Promise<{ endpoint: string; command: DockerCommand }> {
  const config = env['DOCKER_CONFIG'] ? ['--config', env['DOCKER_CONFIG']] : [];
  const context = env['DOCKER_CONTEXT'];
  let endpoint: string;
  if (!context && env['DOCKER_HOST']) endpoint = env['DOCKER_HOST'];
  else {
    const selected = context || await run([...config, 'context', 'show'], 10_000);
    endpoint = await run([...config, 'context', 'inspect', selected,
      '--format', '{{.Endpoints.docker.Host}}'], 10_000);
  }
  // Docker's Unix socket scheme only. No TCP (even loopback), SSH, named pipe,
  // URL authority, query, fragment, or relative socket path is supported.
  if (!/^unix:\/\/\/[^\s?#\u0000]+$/.test(endpoint)) {
    throw new Error('Docker requires an explicitly local Unix socket endpoint; remote contexts are refused');
  }
  return { endpoint, command: (args, timeout) => run([...config, '--host', endpoint, ...args], timeout) };
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

const childStops = new WeakMap<ChildProcess, Promise<void>>();
function stopChild(child: ChildProcess): Promise<void> {
  let stopped = childStops.get(child);
  if (!stopped) { stopped = stopChildOnce(child); childStops.set(child, stopped); }
  return stopped;
}

async function stopChildOnce(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitChildClosed(child, 3_000)) return;
  child.kill('SIGKILL');
  if (!await waitChildClosed(child, 3_000)) throw new Error('owned Index did not close after SIGKILL');
}

async function waitChildClosed(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      child.off('exit', onClose);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onClose);
    child.once('close', onClose);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

/** Every owned cleanup is attempted even when a preceding one fails. */
export async function settleOwnedCleanup(stoppers: readonly (() => Promise<void>)[],
  removeContainer: () => Promise<void>, initialFailures: readonly unknown[] = []): Promise<void> {
  const failures = [...initialFailures];
  const stopped = await Promise.allSettled(stoppers.map(async (stop) => stop()));
  for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason);
  try { await removeContainer(); } catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, 'owned Index run and cleanup failed');
  if (failures.length === 1) throw failures[0];
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

export function assertOwnedIndexReady(body: unknown, origin: string, sourceId: string | null): void {
  if (!body || typeof body !== 'object') throw new Error('owned Index readiness response malformed');
  const value = body as { observerOrigin?: unknown;
    coverage?: { identitySources?: Array<{ sourceId?: unknown }> } };
  if (value.observerOrigin !== origin) throw new Error('owned Index origin mismatch');
  const sources = value.coverage?.identitySources;
  if (!Array.isArray(sources) || (sourceId === null ? sources.length !== 0 : sources.length !== 1 || sources[0]?.sourceId !== sourceId)) {
    throw new Error('owned Index source mismatch');
  }
}

/** The disposable database must not inherit the image's anonymous data volume. */
export function assertOwnedPostgresTmpfs(mounts: unknown): void {
  if (!Array.isArray(mounts) || mounts.length !== 1) throw new Error('owned PostgreSQL requires only its data tmpfs mount');
  const mount = mounts[0] as { Type?: unknown; Destination?: unknown; RW?: unknown; Name?: unknown; Source?: unknown } | null;
  if (!mount || mount.Type !== 'tmpfs' || mount.Destination !== '/var/lib/postgresql/data' || mount.RW !== true ||
    (mount.Name !== undefined && mount.Name !== '') || (mount.Source !== undefined && mount.Source !== '')) {
    throw new Error('owned PostgreSQL requires a writable data tmpfs without a volume or bind source');
  }
}

async function waitReady(origin: string, child: ChildProcess, sourceId: string | null,
  spawnError: () => Error | null): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    checkOwnedCancellation();
    if (spawnError()) throw new Error('owned Index spawn failed', { cause: spawnError() });
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
  rpcUrls: { A: string; B: string }, run: (owned: OwnedIndexEnvironment) => Promise<T>,
  options: IndexOptions = {}): Promise<T> {
  return withOwnedLifecycle((lifecycle) => runWithOwnedIndexes(indexCheckout, source, rpcUrls, run, options, lifecycle));
}

/** Explicit chain-free lifecycle: no identity/feedback connector, same owned database/process semantics. */
export async function withOwnedOriginIndexes<T>(indexCheckout: string, originArchive: Record<'A' | 'B', OriginArchiveConfig>,
  run: (owned: OwnedIndexEnvironment) => Promise<T>): Promise<T> {
  return withOwnedLifecycle((lifecycle) => runWithOwnedIndexes(indexCheckout, null, null, run, { originArchive }, lifecycle));
}

async function runWithOwnedIndexes<T>(indexCheckout: string, source: IdentitySourceConfig | null,
  rpcUrls: { A: string; B: string } | null, run: (owned: OwnedIndexEnvironment) => Promise<T>,
  options: IndexOptions, lifecycle: OwnedLifecycle): Promise<T> {
  for (const feedback of Object.values(options.feedback ?? {})) {
    const { documentUrls, ...domain } = feedback;
    feedbackSourceId(domain);
    if (!source || domain.chainId !== source.chainId || domain.genesisHash.toLowerCase() !== source.genesisHash.toLowerCase() ||
      domain.identityRegistry.toLowerCase() !== source.registry.toLowerCase() || !Array.isArray(documentUrls)) {
      throw new Error('owned Index feedback/identity source mismatch');
    }
  }
  const docker = await resolveLocalDocker();
  lifecycle.check();
  const checkout = await assertPinnedCheckout(indexCheckout);
  const serverDir = join(checkout, 'server');
  // Do not trust an ignored, previously compiled dist/ from a clean tracked checkout.
  lifecycle.check();
  await command('npm', ['run', 'build'], serverDir);
  lifecycle.check();
  const nonce = randomBytes(8).toString('hex');
  const dbA = `city_a_${nonce}`;
  const dbB = `city_b_${nonce}`;
  const password = randomBytes(24).toString('hex');
  const ownedLabel = `city-${nonce}`;
  const containerName = `nandacity-${nonce}`;
  let containerAcquisitionStarted = false;
  let containerId = '';
  let a: OwnedIndex | undefined;
  let b: OwnedIndex | undefined;
  let pgPort = 0;
  const processes = new Map<'A' | 'B', ChildProcess>();
  const usedPorts = new Set<number>();
  const busy = new Set<'A' | 'B'>();
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const active = (): void => {
    lifecycle.check();
    if (closing) throw new Error('owned Index scope is closing');
  };
  const operation = <R>(runOperation: () => Promise<R>): Promise<R> => {
    active();
    const promise = runOperation();
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };

  async function assertOwned(): Promise<void> {
    if (!containerId) throw new Error('no owned PostgreSQL container');
    const label = await docker.command(['inspect', '--format', `{{index .Config.Labels "${LABEL}"}}`, containerId], 10_000);
    if (label !== ownedLabel) throw new Error('PostgreSQL ownership label mismatch');
  }
  async function assertEphemeralData(): Promise<void> {
    await assertOwned();
    const mounts = await docker.command(['inspect', '--format', '{{json .Mounts}}', containerId], 10_000);
    assertOwnedPostgresTmpfs(JSON.parse(mounts) as unknown);
  }
  async function sql(statement: string): Promise<void> {
    active();
    await assertEphemeralData();
    active();
    await docker.command(['exec', '-e', `PGPASSWORD=${password}`, containerId,
      'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', statement], 10_000);
  }
  async function start(name: 'A' | 'B'): Promise<OwnedIndex> {
    active();
    if (processes.has(name)) throw new Error(`Index ${name} already running`);
    await assertEphemeralData();
    active();
    const database = name === 'A' ? dbA : dbB;
    let indexPort = await port();
    while (usedPorts.has(indexPort)) { active(); indexPort = await port(); }
    usedPorts.add(indexPort);
    active();
    const origin = `http://127.0.0.1:${indexPort}`;
    const env = childEnv({ NODE_ENV: 'development', PORT: String(indexPort),
      API_BASE_URL: origin, BIND_HOST: '127.0.0.1',
      DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/${database}`,
      ERC8004_IDENTITY_CONFIG: source ? JSON.stringify({ ...source, rpcUrl: rpcUrls![name], pollMs: 100,
        maxBlockSpan: 200 }) : '', ERC8004_FEEDBACK_CONFIG: '', SMTP_URL: 'log',
      ...(options.originArchive ? { ORIGIN_ARCHIVE_CONFIG: JSON.stringify(options.originArchive[name]) } : {}),
      ...(options.feedback?.[name] ? { ERC8004_FEEDBACK_CONFIG: JSON.stringify({ ...options.feedback[name],
        rpcUrl: `${rpcUrls![name].replace(/\/$/, '')}/`, pollMs: 100, maxBlockSpan: 128 }) } : {}) });
    await command('node', ['dist/db/migrate.js'], serverDir, env);
    active();
    const child = spawn(options.serverExecutable ?? 'node', ['dist/server.js'], { cwd: serverDir, env,
      stdio: ['ignore', 'pipe', 'ignore'] });
    // Only disposable owned verification links are retained, never full process logs.
    const verification = new Map<string, string>(); let pendingLine = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      pendingLine = (pendingLine + chunk.toString('utf8')).slice(-65536);
      const lines = pendingLine.split('\n'); pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^\[email\] verification link for org "([A-Za-z0-9_-]{1,64})" → (\S+)$/.exec(line);
        if (!match || verification.size >= 32) continue;
        try {
          const url = new URL(match[2]!); const token = url.searchParams.get('token');
          if (url.pathname === '/api/v1/verify-email' && token && /^[A-Za-z0-9_-]{16,256}$/.test(token)) verification.set(match[1]!, token);
        } catch { /* other process output is discarded */ }
      }
    });
    let spawnFailure: Error | null = null;
    child.once('error', (error) => { spawnFailure = error; });
    processes.set(name, child);
    const sourceId = source ? `erc8004-identity:${source.chainId}:${source.registry.toLowerCase()}` : null;
    try { await waitReady(origin, child, sourceId, () => spawnFailure); active(); }
    catch (error) {
      try { await stopChild(child); processes.delete(name); }
      catch (stopError) { throw new AggregateError([error, stopError], 'Index startup and stop failed'); }
      throw error;
    }
    return { name, origin, database, verifyOrganizationEmail: async (orgId) => {
      const deadline = Date.now() + 5000;
      while (!verification.has(orgId) && Date.now() < deadline) { active(); await new Promise((resolve) => setTimeout(resolve, 20)); }
      const token = verification.get(orgId); if (!token) throw new Error('owned verification unavailable');
      const response = await fetch(`${origin}/api/v1/verify-email?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      verification.delete(orgId);
      if (!response.ok) throw new Error('owned verification failed');
    }, stop: async () => {
      if (processes.get(name) !== child) return;
      await stopChild(child);
      if (processes.get(name) === child) processes.delete(name);
    } };
  }
  async function stopNamed(name: 'A' | 'B'): Promise<void> { await (name === 'A' ? a : b)?.stop(); }
  async function startNamed(name: 'A' | 'B'): Promise<OwnedIndex> {
    const index = await start(name); if (name === 'A') a = index; else b = index; return index;
  }
  async function restartNamed(name: 'A' | 'B'): Promise<OwnedIndex> { active(); await stopNamed(name); return startNamed(name); }
  async function rebuildNamed(name: 'A' | 'B'): Promise<OwnedIndex> {
    active();
    await stopNamed(name);
    const database = name === 'A' ? dbA : dbB;
    await sql(`DROP DATABASE ${database} WITH (FORCE)`);
    await sql(`CREATE DATABASE ${database}`);
    return startNamed(name);
  }
  const named = <R>(name: 'A' | 'B', action: (name: 'A' | 'B') => Promise<R>) => operation(async () => {
    if ((name !== 'A' && name !== 'B') || busy.has(name)) throw new Error('owned Index lifecycle operation conflicts');
    busy.add(name); try { return await action(name); } finally { busy.delete(name); }
  });

  let result!: T;
  const runFailures: unknown[] = [];
  try {
    active();
    containerAcquisitionStarted = true;
    // Record the returned ID before checking cancellation. A deterministic name
    // also recovers ownership if Docker mutates successfully but its receipt fails.
    // --mount exposes tmpfs in .Mounts, so the same guard can reject image-created volumes.
    containerId = await docker.command(['run', '-d', '--name', containerName, '--label', `${LABEL}=${ownedLabel}`,
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16'], 120_000);
    active();
    await assertEphemeralData();
    active();
    const binding = await docker.command(['port', containerId, '5432/tcp'], 10_000);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('PostgreSQL must publish only on loopback');
    pgPort = Number(match[1]);
    const deadline = Date.now() + 15_000;
    for (;;) {
      active();
      const logs = await docker.command(['logs', containerId], 10_000);
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        active();
        try { await docker.command(['exec', containerId, 'pg_isready', '-U', 'postgres'], 10_000); break; }
        catch { /* final post-init server not ready yet */ }
      }
      if (Date.now() > deadline) throw new Error('owned PostgreSQL not ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await sql(`CREATE DATABASE ${dbA}`);
    await sql(`CREATE DATABASE ${dbB}`);
    a = await start('A');
    b = await start('B');
    active();
    result = await run({ indexes: { A: a, B: b },
      restart: (name) => named(name, restartNamed), rebuild: (name) => named(name, rebuildNamed),
      stop: (name) => named(name, stopNamed), start: (name) => named(name, startNamed),
      restartA: () => named('A', restartNamed), rebuildA: () => named('A', rebuildNamed),
      stopA: () => named('A', stopNamed), startA: () => named('A', startNamed), containerId, lifecycle });
  } catch (error) { runFailures.push(error); }
  closing = true;
  // Even a callback that forgets to await a lifecycle operation cannot let its
  // in-flight acquisition race teardown or create a new child after closing.
  for (const outcome of await Promise.allSettled([...pending])) {
    if (outcome.status === 'rejected') runFailures.push(outcome.reason);
  }
  await settleOwnedCleanup([...processes.values()].map((child) => () => stopChild(child)),
    async () => {
      if (containerAcquisitionStarted && !containerId) {
        containerId = await docker.command(['ps', '-aq', '--no-trunc', '--filter',
          `name=^/${containerName}$`], 10_000);
        if (containerId && !/^[0-9a-f]{64}$/.test(containerId)) throw new Error('ambiguous owned container lookup');
      }
      // Remove anonymous volumes too if acquisition failed before mount validation.
      if (containerId) { await assertOwned(); await docker.command(['rm', '-fv', containerId], 10_000); }
    }, runFailures);
  return result;
}
