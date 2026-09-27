import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupBinding } from '../safe/backup.js';
import type { MigrationReport } from '../safe/migration.js';
import { withOwnedAnvil } from './anvil.js';
import { withOwnedIndexes } from './indexProcesses.js';

export type CleanExitResult = { label: 'same-account-clean-exit'; originalSecretHoldersStopped: true;
  restoredInFreshProcess: true; unchangedSafeAndIds: boolean; retiredPrimaryAbsent: boolean;
  replacementExecutorSelfFunded: boolean; services: MigrationReport['services']; discoveriesVerified: number;
  freshInteractionsVerified: number; history: string[]; transactions: number; gas: string[] };
export type AdversarialResult = { label: 'adversarial-revocation-companion'; freshRetiredPrimaryRejected: boolean;
  freshRetiredRuntimeRejected: boolean };
export type SafeExitResult = { cleanExit: CleanExitResult; adversarial: AdversarialResult; failures: Record<string, boolean> };
type WorkerReply = { type: 'ready'; binding: BackupBinding } |
  { type: 'complete'; cleanExit?: Omit<CleanExitResult, 'originalSecretHoldersStopped' | 'restoredInFreshProcess'>;
    adversarial?: AdversarialResult; failures: Record<string, boolean> } | { type: 'failed'; stage: string };

function startWorker(entry: URL) {
  const child = fork(entry, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env['PATH'] ?? '' } });
  const queued: WorkerReply[] = []; let wake: (() => void) | undefined;
  child.on('message', (message) => {
    if (!message || typeof message !== 'object' || !('type' in message) ||
        !['ready', 'complete', 'failed'].includes(String(message.type))) return;
    queued.push(message as WorkerReply); wake?.();
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => { exited = true; wake?.(); resolve(); }));
  return { child, exit, async reply(): Promise<WorkerReply> {
    const deadline = Date.now() + 150_000;
    while (!queued.length && !exited && Date.now() < deadline) {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1000); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    const message = queued.shift();
    if (!message) throw new Error('exit worker unavailable');
    if (message.type === 'failed') throw new Error(`exit worker refused at ${message.stage.replace(/[^a-z0-9-]/gi, '').slice(0, 64)}`);
    return message;
  } };
}
async function stop(worker: { child: ChildProcess; exit: Promise<void> }) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) { await worker.exit; return; }
  worker.child.kill('SIGTERM');
  const timer = setTimeout(() => worker.child.kill('SIGKILL'), 2000);
  try { await worker.exit; } finally { clearTimeout(timer); }
}

/** Test-only child entry is supplied explicitly. The supervisor never receives original EOA keys,
 * journals, runtime stores, approvals or raw transactions. Infrastructure remains available. */
export async function runSafeExit(indexCheckout: string, workerEntry: URL): Promise<SafeExitResult> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'city-exit-export-'));
  const password = randomBytes(32).toString('base64');
  const children: ReturnType<typeof startWorker>[] = [];
  try {
    const owned = await withOwnedAnvil(async (rpcUrl) => {
      const original = startWorker(workerEntry); children.push(original);
      original.child.send({ role: 'original', rpcUrl, exportDirectory: root, password });
      const ready = await original.reply(); if (ready.type !== 'ready') throw new Error('original exit worker not ready');
      const { binding } = ready;
      return withOwnedIndexes(indexCheckout, { chainId: binding.domain.chainId, registry: binding.domain.registry,
        genesisHash: binding.domain.genesisHash, startBlock: '0', adapter: 'nandacity-0.1', confirmations: 0 },
      { A: rpcUrl, B: rpcUrl }, async (indexes) => {
        await stop(original); // All original client/signer/runtime/payer roles lived in this owned process.
        const restored = startWorker(workerEntry); children.push(restored);
        if (restored.child.pid === original.child.pid) throw new Error('fresh-process boundary unavailable');
        restored.child.send({ role: 'restore', rpcUrl, exportDirectory: root, password, binding,
          indexOrigins: [indexes.indexes.A.origin, indexes.indexes.B.origin] });
        const result = await restored.reply();
        if (result.type !== 'complete' || !result.cleanExit) throw new Error('clean exit incomplete');
        await stop(restored);
        const companionDirectory = join(root, 'companion'); await mkdir(companionDirectory, { mode: 0o700 });
        const companion = startWorker(workerEntry); children.push(companion);
        companion.child.send({ role: 'companion', rpcUrl, exportDirectory: companionDirectory, password });
        const attacker = await companion.reply();
        if (attacker.type !== 'complete' || !attacker.adversarial) throw new Error('companion incomplete');
        await stop(companion);
        return { cleanExit: { ...result.cleanExit, originalSecretHoldersStopped: true as const, restoredInFreshProcess: true as const },
          adversarial: attacker.adversarial, failures: { ...result.failures, ...attacker.failures } };
      });
    }, { genesisMarker: { blockNumber: 0n, timestamp: BigInt(Math.floor(Date.now() / 1000) - 120) } });
    return owned.value;
  } finally {
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true });
  }
}
