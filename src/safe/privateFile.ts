import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const rejected = () => new Error('private file rejected');
export const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const metadata = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const;
function bounds(name: string, limit: number) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 2 * 1024 * 1024) throw rejected();
}
export async function privateDirectory(root: string): Promise<BigIntStats> {
  if (!isAbsolute(root) || resolve(root) !== root || !process.getuid || await realpath(root) !== root) throw rejected();
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n || stat.uid !== BigInt(process.getuid())) throw rejected();
  return stat;
}
export async function syncPrivateDirectory(root: string) {
  const handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Descriptor-bounded reads reject replacement, mutation, links and non-private files. */
export async function readPrivateFile(root: string, name: string, limit: number): Promise<Buffer | null> {
  try {
    bounds(name, limit); const parent = await privateDirectory(root); const path = join(root, name);
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
          BigInt(length) !== before.size || !sameInode(parent, await privateDirectory(root))) throw rejected();
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  } catch { throw rejected(); }
}
/** Caller owns serialization; durable same-directory replace never relaxes destination checks. */
export async function writePrivateFile(root: string, name: string, bytes: Uint8Array, limit: number): Promise<void> {
  let temporary: string | undefined;
  try {
    bounds(name, limit); if (bytes.byteLength > limit) throw rejected();
    const parent = await privateDirectory(root);
    await readPrivateFile(root, name, limit);
    temporary = join(root, `.private-${randomUUID()}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes); await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) || stat.uid !== BigInt(process.getuid!()) ||
          (stat.mode & 0o777n) !== 0o600n || !sameInode(stat, await lstat(temporary, { bigint: true })) ||
          !sameInode(parent, await privateDirectory(root))) throw rejected();
    } finally { await handle.close(); }
    await rename(temporary, join(root, name)); temporary = undefined; await syncPrivateDirectory(root);
  } catch { throw rejected(); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}
