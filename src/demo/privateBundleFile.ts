import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeSupportingBundle } from '../feedback/supportingBundle.js';

const rejected = () => new Error('private bundle file rejected');
const limit = 128 * 1024;

/** Only the owned reader callback receives this path. It is never report evidence. */
export async function withPrivateBundleFile<T>(bytes: Uint8Array, run: (path: string) => Promise<T>): Promise<T> {
  let directory: string | undefined;
  let file: string;
  try {
    const copied = decodeSupportingBundle(bytes).bytes;
    directory = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-private-bundle-'));
    await chmod(directory, 0o700); file = join(directory, 'bundle.json');
    const descriptor = await open(file, 'wx', 0o600);
    try { await descriptor.writeFile(copied); await descriptor.sync(); } finally { await descriptor.close(); }
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw rejected();
  }
  try { return await run(file); }
  finally {
    try { await rm(directory, { recursive: true, force: true }); } catch { throw rejected(); }
  }
}

/** Bound descriptor reads, not stat-then-readFile; reject aliases and changes before decoding. */
export async function readPrivateBundleFile(path: string | null): Promise<Uint8Array | null> {
  if (path === null) return null;
  try {
    if (!isAbsolute(path) || resolve(path) !== path || !process.getuid) throw rejected();
    let entry;
    try { entry = await lstat(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const directory = dirname(path); const parent = await lstat(directory, { bigint: true });
    if (!parent.isDirectory() || (parent.mode & 0o777n) !== 0o700n || parent.uid !== BigInt(process.getuid()) ||
      await realpath(directory) !== directory || !entry.isFile() || entry.nlink !== 1n) throw rejected();
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await descriptor.stat({ bigint: true });
      if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.nlink !== 1n ||
        (before.mode & 0o777n) !== 0o600n || before.uid !== BigInt(process.getuid()) || before.size > BigInt(limit)) throw rejected();
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      for (;;) {
        const { bytesRead } = await descriptor.read(buffer, length, Math.min(16384, buffer.length - length), null);
        length += bytesRead; if (length > limit) throw rejected(); if (bytesRead === 0) break;
      }
      const after = await descriptor.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const) {
        if (before[key] !== after[key] || before[key] !== named[key]) throw rejected();
      }
      if (BigInt(length) !== before.size) throw rejected();
      return decodeSupportingBundle(buffer.subarray(0, length)).bytes;
    } finally { await descriptor.close(); }
  } catch { throw rejected(); }
}
