import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';

const limit = 2 * 1024 * 1024;
const rejected = () => new Error('onboarding journal rejected');
export class JournalLocked extends Error { constructor() { super('onboarding locked'); } }
export type JournalAccess = { root: string; controller: string; caller: string; guard: () => void };
const localStates = new WeakMap<JournalAccess, { enabled: boolean; active: number }>();
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const metadata = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const;

async function directory(root: string): Promise<BigIntStats> {
  if (!isAbsolute(root) || resolve(root) !== root || !process.getuid || await realpath(root) !== root) throw rejected();
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n || stat.uid !== BigInt(process.getuid())) throw rejected();
  return stat;
}
async function syncDirectory(root: string) {
  const handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readFile(root: string, name: string): Promise<Buffer | null> {
  const parent = await directory(root); const path = join(root, name);
  let entry;
  try { entry = await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!entry.isFile() || entry.nlink !== 1n) throw rejected();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameInode(before, entry) || !before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
        (before.mode & 0o777n) !== 0o600n || before.size > BigInt(limit)) throw rejected();
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(16384, buffer.length - length), null);
      length += bytesRead; if (length > limit) throw rejected(); if (!bytesRead) break;
    }
    const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    if (metadata.some((key) => before[key] !== after[key] || before[key] !== named[key]) ||
        BigInt(length) !== before.size || !sameInode(parent, await directory(root))) throw rejected();
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** The caller fixes this canonical account directory; it is never an ephemeral bundle. */
export function createJournalController(root: string, guard: () => void) {
  const controller = randomUUID();
  const state = { enabled: true, active: 0 };
  const local: JournalAccess = { root, controller, caller: randomUUID(), guard };
  localStates.set(local, state);
  const callers = new Map<string, { child: ChildProcess; exited: Promise<void>; held?: { dev: string; ino: string } }>();
  return {
    local,
    /** Give this lease over IPC only after tracking the owned child. Never share leases. */
    trackCaller(child: ChildProcess): JournalAccess {
      if (!state.enabled || !child.pid || !child.connected) throw new JournalLocked();
      const caller = randomUUID();
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      callers.set(caller, { child, exited });
      // Capture the inode over the owned child's IPC channel, not from an
      // untrusted owner record discovered after a crash.
      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        const signal = message as Record<string, unknown>;
        if (signal['type'] === 'onboarding-lock-held' && signal['controller'] === controller && signal['caller'] === caller &&
            typeof signal['dev'] === 'string' && typeof signal['ino'] === 'string' &&
            /^\d+$/.test(signal['dev']) && /^\d+$/.test(signal['ino'])) {
          callers.get(caller)!.held = { dev: signal['dev'], ino: signal['ino'] };
        }
      });
      return { root, controller, caller, guard };
    },
    /** No PID/age inference. Unknown ownership or uncertain exit leaves the lock intact. */
    async recoverLock(): Promise<void> {
      guard(); state.enabled = false;
      const gate = join(root, 'recovery'); let gateOwned = false;
      try {
        await directory(root);
        await mkdir(gate, { mode: 0o700 }); gateOwned = true;
        const lock = join(root, 'lock'); const locked = await directory(lock);
        const bytes = await readFile(lock, 'owner.json');
        if (!bytes) throw new JournalLocked();
        const owner = JSON.parse(bytes.toString());
        const captured = callers.get(owner.caller)?.held;
        if (Object.keys(owner).sort().join(',') !== 'caller,controller' || owner.controller !== controller ||
            !captured || captured.dev !== String(locked.dev) || captured.ino !== String(locked.ino) || state.active) throw new JournalLocked();
        for (const { child } of callers.values()) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.all([...callers.values()].map(({ exited }) => exited)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JournalLocked()), 2000); })]);
        } finally { clearTimeout(timer); }
        if (!sameInode(locked, await directory(lock))) throw new JournalLocked();
        const again = await readFile(lock, 'owner.json');
        if (!again?.equals(bytes)) throw new JournalLocked();
        await rename(lock, join(root, `.quarantined-lock-${randomUUID()}`));
        await syncDirectory(root);
        state.enabled = true;
      } catch { throw new JournalLocked(); }
      finally { if (gateOwned) await rmdir(gate); }
    },
  };
}

export async function readJournal<T>(access: JournalAccess, decode: (value: unknown) => T): Promise<T | null> {
  try {
    const bytes = await readFile(access.root, 'journal.json');
    if (bytes === null) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw rejected();
    return decode(value);
  } catch { throw rejected(); }
}

/** One directory lock covers every service, persisted reservation and submission. Never age-steal it. */
export async function withJournalLock<T, R>(access: JournalAccess, decode: (value: unknown) => T,
  run: (current: T | null, persist: (next: T) => Promise<void>) => Promise<R>): Promise<R> {
  access.guard();
  const state = localStates.get(access);
  if (state && !state.enabled) throw new JournalLocked();
  await directory(access.root);
  const assertNoRecovery = async () => {
    try { await lstat(join(access.root, 'recovery')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw rejected(); }
    throw new JournalLocked();
  };
  await assertNoRecovery();
  const lock = join(access.root, 'lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JournalLocked(); throw rejected(); }
  const owned = await directory(lock);
  if (state) state.active++;
  try {
    await assertNoRecovery();
    const owner = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try { await owner.writeFile(JSON.stringify({ controller: access.controller, caller: access.caller })); await owner.sync(); }
    finally { await owner.close(); }
    await syncDirectory(lock); await syncDirectory(access.root);
    process.send?.({ type: 'onboarding-lock-held', controller: access.controller, caller: access.caller,
      dev: String(owned.dev), ino: String(owned.ino) });
    const current = await readJournal(access, decode);
    return await run(current, async (next) => {
      access.guard();
      if (!sameInode(owned, await directory(lock))) throw new JournalLocked();
      const bytes = Buffer.from(JSON.stringify(decode(next)));
      if (bytes.length > limit) throw rejected();
      const parent = await directory(access.root);
      // Validate even an existing destination before replacing it.
      await readFile(access.root, 'journal.json');
      const temporary = join(access.root, `.journal-${randomUUID()}`);
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes); await handle.sync();
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) ||
            (stat.mode & 0o777n) !== 0o600n || !sameInode(stat, await lstat(temporary, { bigint: true })) ||
            !sameInode(parent, await directory(access.root))) throw rejected();
      } finally { await handle.close(); }
      try { await rename(temporary, join(access.root, 'journal.json')); await syncDirectory(access.root); }
      catch { await unlink(temporary).catch(() => undefined); throw rejected(); }
    });
  } finally {
    if (state) state.active--;
    if (sameInode(owned, await directory(lock))) {
      await unlink(join(lock, 'owner.json')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw rejected(); });
      await rmdir(lock);
    }
  }
}
