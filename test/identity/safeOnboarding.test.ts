import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const journalModule = async () => {
  const module = await import('../../src/safe/onboardingJournal.js').catch(() => undefined);
  assert.ok(module, 'restart-safe private journal must exist'); return module;
};
const decode = (value: unknown): { reservation: string } => {
  assert.ok(value && typeof value === 'object');
  assert.deepEqual(Object.keys(value), ['reservation']);
  assert.equal(typeof (value as { reservation: unknown }).reservation, 'string');
  return value as { reservation: string };
};
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'city-onboarding-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('journal persists a reservation, reopens unchanged and serializes both city callers', async () => {
  const { createJournalController, withJournalLock, readJournal } = await journalModule();
  await temporary(async (root) => {
    const controller = createJournalController(root, () => undefined);
    const access = controller.local;
    await withJournalLock(access, decode, async (current, persist) => {
      assert.equal(current, null); await persist({ reservation: 'chicago:0' });
      await assert.rejects(withJournalLock(access, decode, async () => undefined), /locked/);
    });
    assert.deepEqual(await readJournal(access, decode), { reservation: 'chicago:0' });
    const reopened = createJournalController(root, () => undefined);
    await withJournalLock(reopened.local, decode, async (current) => {
      assert.deepEqual(current, { reservation: 'chicago:0' });
    });
    assert.equal((await lstat(join(root, 'journal.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
  });
});

test('journal rejects links, modes, malformed and oversized input without leaking bytes or paths', async () => {
  const { createJournalController, withJournalLock, readJournal } = await journalModule();
  await temporary(async (root) => {
    const access = createJournalController(root, () => undefined).local;
    await withJournalLock(access, decode, async (_current, persist) => persist({ reservation: 'private' }));
    const file = join(root, 'journal.json');
    await chmod(file, 0o644); await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
    await chmod(file, 0o600);
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
    await writeFile(file, '{"reservation": "private", "extra":true}');
    await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
    await writeFile(file, '{"reservation":"first","reservation":"private"}');
    await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
    await writeFile(file, '{"reservation":"private"}');
    await link(file, join(root, 'alias'));
    await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
    await rm(join(root, 'alias'));
    const bytes = await readFile(file); await rm(file); await writeFile(join(root, 'target'), bytes, { mode: 0o600 });
    await symlink(join(root, 'target'), file);
    await assert.rejects(readJournal(access, decode), /^Error: onboarding journal rejected$/);
  });
});

test('two processes share one reservation; killed holder stays locked until owned quiescence recovery', async () => {
  const { createJournalController, readJournal, withJournalLock } = await journalModule();
  await temporary(async (root) => {
    const controller = createJournalController(root, () => undefined);
    assert.equal(typeof controller.trackCaller, 'function', 'controller must track real callers before giving write access');
    const start = async (mode: 'hold' | 'race') => {
      const child = fork(new URL('./fixtures/safeOnboardingWorker.ts', import.meta.url), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const access = controller.trackCaller(child);
      const reply = new Promise<unknown[]>((resolve) => child.on('message', (message) => {
        if (typeof message === 'string') resolve([message]);
      }));
      child.send({ ...access, guard: undefined, mode });
      return { child, reply };
    };
    const holder = await start('hold'); assert.equal((await holder.reply)[0], 'held');
    const contender = await start('race'); assert.equal((await contender.reply)[0], 'locked');
    const exit = once(holder.child, 'exit'); holder.child.kill('SIGKILL'); await exit;
    await assert.rejects(withJournalLock(controller.local, decode, async () => undefined), /locked/);
    assert.deepEqual(await readJournal(controller.local, decode), { reservation: 'chicago:0' });
    const stranger = createJournalController(root, () => undefined);
    await assert.rejects(stranger.recoverLock(), /locked/);
    await controller.recoverLock();
    await withJournalLock(controller.local, decode, async (current) => {
      assert.deepEqual(current, { reservation: 'chicago:0' });
    });
  });
});

test('recovery refuses a replacement lock inode even when its owner record was copied', async () => {
  const { createJournalController } = await journalModule();
  await temporary(async (root) => {
    const controller = createJournalController(root, () => undefined);
    const child = fork(new URL('./fixtures/safeOnboardingWorker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const access = controller.trackCaller(child);
    const ready = new Promise<void>((resolve) => child.on('message', (message) => { if (message === 'held') resolve(); }));
    child.send({ ...access, guard: undefined, mode: 'hold' }); await ready;
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const owner = await readFile(join(root, 'lock', 'owner.json'));
    await rename(join(root, 'lock'), join(root, 'original-lock'));
    await mkdir(join(root, 'lock'), { mode: 0o700 });
    await writeFile(join(root, 'lock', 'owner.json'), owner, { mode: 0o600 });
    await assert.rejects(controller.recoverLock(), /locked/);
  });
});
