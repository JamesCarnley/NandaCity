import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createOwnedProcessStopper, ownedAnvilChildEnv } from '../../src/demo/anvil.js';

test('owned Anvil child receives PATH but not caller database or API secrets', () => {
  assert.deepEqual(ownedAnvilChildEnv({ PATH: '/test/bin', DATABASE_URL: 'postgres://private',
    OPENAI_API_KEY: 'private-key' }), { PATH: '/test/bin' });
});

class ControlledChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly receivedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    assert.equal(typeof signal, 'string');
    this.receivedSignals.push(signal as NodeJS.Signals);
    return true;
  }

  confirmExit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

test('rejects cleanup when the child never confirms exit after SIGKILL', async () => {
  const child = new ControlledChildProcess();
  const stop = createOwnedProcessStopper(child.asChildProcess(), 1);

  await assert.rejects(stop(), /did not confirm exit after SIGKILL/i);
  assert.deepEqual(child.receivedSignals, ['SIGTERM', 'SIGKILL']);
});

test('overlapping cleanup callers share one stop promise and signal sequence', async () => {
  const child = new ControlledChildProcess();
  const stop = createOwnedProcessStopper(child.asChildProcess(), 100);

  const first = stop();
  const second = stop();
  const sharedPromise = first === second;
  child.confirmExit('SIGTERM');
  await Promise.all([first, second]);

  assert.equal(sharedPromise, true);
  assert.deepEqual(child.receivedSignals, ['SIGTERM']);
});
