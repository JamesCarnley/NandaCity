import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const modulePath = '../../src/live/budget.js';
async function api() {
  const m = await import(modulePath).catch(() => ({}));
  assert.equal(typeof m.LiveBudget?.open, 'function', 'durable live budget must be implemented');
  return m as typeof import('../../src/live/budget.js');
}
export const prices = { initialize: '1', initialized: '1', list: '1', places: '1', events: '1', transit: '1', generate: '1', cancel: '1', delete: '1' };
export const budgetOptions = { sessionCapMicros: '1000', runCapMicros: '10', prices, pricingExpiresAt: '2026-10-05T00:00:00Z', now: () => Date.parse('2026-10-03T20:00:00Z') };

test('settlement observes physical callback release without closing or replenishing the ledger', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-settled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await LiveBudget.open(directory, budgetOptions), run = await ledger.begin('noncooperative');
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>((r) => { entered = r; }), barrier = new Promise<void>((r) => { release = r; });
  const dispatch = run.dispatch('generate', async () => { entered(); await barrier; });
  try {
    await arrived; run.cancel(); await assert.rejects(dispatch, /cancelled/); await run.finish();
    assert.equal(typeof ledger.settled, 'function');
    let settled = false; const waiting = ledger.settled().then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
    assert.equal(ledger.snapshot().reservedCostMicros, '1');
    release(); await waiting;
    assert.equal(JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')).runs[0].attempts[0].outcome, 'cancelled');
    await assert.rejects(LiveBudget.open(directory, budgetOptions), /writer/);
    const next = await ledger.begin('next'); await next.finish();
    assert.equal(ledger.snapshot().reservedCostMicros, '1');
  } finally { release(); await dispatch.catch(() => undefined); await ledger.close(); }
});

test('a closed writer cannot finalize or settle an old run over a replacement writer', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-writer-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = await LiveBudget.open(directory, budgetOptions), oldRun = await old.begin('old-run');
  await oldRun.dispatch('places', async () => undefined);
  await old.close();
  const replacement = await LiveBudget.open(directory, budgetOptions);
  t.after(() => replacement.close());
  const newRun = await replacement.begin('new-run'); await newRun.dispatch('places', async () => undefined); await newRun.finish();
  const before = await readFile(join(directory, 'budget.json'), 'utf8');
  await assert.rejects(oldRun.finish(), /not-configured/);
  await assert.rejects(old.settle('old-run', 0, 'cancelled'), /not-configured/);
  assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), before);
  assert.equal(replacement.snapshot().reservedCostMicros, '2');
  assert.equal(replacement.snapshot().runs[0]!.closed, false, 'inactive old holds remain conservative');
  await replacement.close();
  const historical = await LiveBudget.open(directory, budgetOptions);
  await historical.close();
});

test('shutdown serializes mutations queued while the writer lock is being released', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-closing-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await LiveBudget.open(directory, budgetOptions), run = await ledger.begin('closing-run');
  await run.dispatch('places', async () => undefined);
  const lock = (ledger as unknown as { lock: { close: () => Promise<void> } }).lock, close = lock.close.bind(lock);
  let entered!: () => void, release!: () => void;
  const closingLock = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(lock, 'close', async () => { entered(); await barrier; await close(); });
  const before = await readFile(join(directory, 'budget.json'), 'utf8');
  const closing = ledger.close(); await closingLock;
  const finalizing = run.finish(), settling = ledger.settle('closing-run', 0, 'cancelled');
  // Observe rejections immediately so neither timing order produces an unhandled rejection.
  const results = Promise.allSettled([finalizing, settling]);
  release(); await closing;
  assert.deepEqual((await results).map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(await readFile(join(directory, 'budget.json'), 'utf8'), before);
  const replacement = await LiveBudget.open(directory, budgetOptions); await replacement.close();
});

test('durable reservation precedes dispatch; restart cannot reissue ambiguous work and another writer is refused', async (t) => {
  const { LiveBudget } = await api();
  const directory = await mkdtemp(join(tmpdir(), 'city-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await LiveBudget.open(directory, budgetOptions);
  await assert.rejects(LiveBudget.open(directory, budgetOptions), /writer/);
  const run = await ledger.begin('task-1');
  await run.dispatch('places', async () => {
    const disk = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(disk.runs[0].attempts[0].outcome, 'reserved');
    assert.equal(disk.runs[0].attempts[0].costMicros, '1');
    throw new Error('SECRET upstream payload');
  }).catch(() => {});
  await ledger.close();
  const disk = await readFile(join(directory, 'budget.json'), 'utf8');
  assert.equal(disk.includes('SECRET'), false);
  const state = JSON.parse(disk); state.runs[0].attempts[0].outcome = 'reserved';
  await writeFile(join(directory, 'budget.json'), JSON.stringify(state));
  const restored = await LiveBudget.open(directory, budgetOptions);
  await assert.rejects(restored.begin('task-1'), /ambiguous-dispatch/);
  assert.equal(restored.snapshot().reservedCostMicros, '1');
  await restored.close();
  state.runs[0].attempts[0].body = 'licensed';
  await writeFile(join(directory, 'budget.json'), JSON.stringify(state));
  await assert.rejects(LiveBudget.open(directory, budgetOptions), /invalid/);
});

test('ten physical attempts include cleanup, with shared account cap and one retry', async (t) => {
  const { LiveBudget } = await api();
  const directory = await mkdtemp(join(tmpdir(), 'city-budget-'));
  const ledger = await LiveBudget.open(directory, { ...budgetOptions, sessionCapMicros: '10' });
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const run = await ledger.begin('task-1');
  for (const purpose of ['initialize', 'initialized', 'list', 'places', 'events', 'transit', 'generate'] as const) await run.dispatch(purpose, async () => 1);
  assert.equal(run.claimRetry(), true); assert.equal(run.claimRetry(), false);
  await run.dispatch('places', async () => 1);
  await assert.rejects(run.dispatch('places', async () => assert.fail('must reserve cleanup')), /budget/);
  await run.dispatch('cancel', async () => 1);
  await run.dispatch('delete', async () => 1);
  await assert.rejects(run.dispatch('delete', async () => assert.fail('unmetered')), /budget/);
  await assert.rejects(ledger.begin('task-2'), /budget/);
  assert.deepEqual(run.usage(), { physicalAttempts: 10, reservedCostMicros: '10' });
});

test('all service runs share two physical slots and cancellation cannot dispatch queued work', async (t) => {
  const { LiveBudget } = await api();
  const directory = await mkdtemp(join(tmpdir(), 'city-budget-'));
  const ledger = await LiveBudget.open(directory, budgetOptions);
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const runs = await Promise.all(Array.from({ length: 6 }, (_, n) => ledger.begin(`task-${n}`)));
  let active = 0, peak = 0; const releases: (() => void)[] = [];
  const work = runs.map((run) => run.dispatch('places', async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve)); active--;
  }));
  while (releases.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2); runs[5]!.cancel();
  const cancelled = assert.rejects(work[5]!, /cancelled/);
  for (let i = 0; i < 5; i++) {
    while (!releases[i]) await new Promise<void>((resolve) => setImmediate(resolve));
    releases[i]!();
  }
  await Promise.all([...work.slice(0, 5), cancelled]); assert.equal(peak, 2);
});

test('cancellation uses reserved cleanup slots only while deadline remains; rate and byte limits are shared', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-budget-'));
  let now = Date.parse('2026-10-03T20:00:00Z'); const waits: number[] = [];
  const ledger = await LiveBudget.open(directory, { ...budgetOptions, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const one = await ledger.begin('one'), two = await ledger.begin('two'), three = await ledger.begin('three');
  const times: number[] = [];
  for (const run of [one, two, three]) await run.dispatch('events', async () => { times.push(now); });
  assert.deepEqual(times, [1791057600000, 1791057600000, 1791057601000]); assert.deepEqual(waits, [1000]);
  one.cancel(); await assert.rejects(one.dispatch('places', async () => assert.fail()), /cancelled/);
  await one.dispatch('cancel', async () => undefined); await one.dispatch('delete', async () => undefined);
  assert.equal(one.usage().physicalAttempts, 3);
  now += 60_000; await assert.rejects(two.dispatch('delete', async () => assert.fail()), /deadline/);
  for (let i = 0; i < 4; i++) three.consumeBytes(1024 * 1024);
  assert.throws(() => three.consumeBytes(1), /oversize/);
  await one.finish(); await two.finish(); await three.finish();
});

test('missing/expired prices and insufficient aggregate admission never dispatch paid work', async (t) => {
  const { LiveBudget } = await api();
  for (const [name, changes, reason] of [
    ['missing', { prices: {} }, 'not-configured'], ['expired', { pricingExpiresAt: '2026-10-01T00:00:00Z' }, 'not-configured'],
    ['cap', { runCapMicros: '9' }, 'budget'],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), `city-budget-${name}-`));
    const ledger = await LiveBudget.open(directory, { ...budgetOptions, ...changes });
    await assert.rejects(ledger.begin(name), new RegExp(reason)); await ledger.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent admissions retain conservative session headroom and restored duplicate cleanup is invalid', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await LiveBudget.open(directory, { ...budgetOptions, sessionCapMicros: '10' });
  const run = await ledger.begin('first');
  await assert.rejects(ledger.begin('second'), /budget/);
  await run.finish(); await ledger.close();
  await writeFile(join(directory, 'budget.json'), JSON.stringify({ version: '0.1', runs: [{ taskId: 'restored', capMicros: '10', holdMicros: '10', closed: false, attempts: [
    { purpose: 'delete', costMicros: '1', outcome: 'reserved' }, { purpose: 'delete', costMicros: '1', outcome: 'reserved' },
  ] }] }));
  await assert.rejects(LiveBudget.open(directory, budgetOptions), /invalid-response/);
});

test('cancellation during awaited admission cannot dispatch after the durable save', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-admission-abort-'));
  const ledger = await LiveBudget.open(directory, budgetOptions);
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  // Delay the real save, without substituting its bytes or durability behavior.
  const persistence = ledger as unknown as { save: () => Promise<void> };
  const save = persistence.save.bind(ledger);
  let entered!: () => void, release!: () => void;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const delayed = t.mock.method(persistence, 'save', async () => { entered(); await barrier; await save(); });
  const caller = new AbortController();
  const admission = ledger.begin('cancel-during-save', caller.signal);
  await saving; caller.abort(); release();
  const run = await admission; delayed.mock.restore();
  let dispatched = false;
  await assert.rejects(run.dispatch('places', async () => { dispatched = true; }), /cancelled/);
  assert.equal(dispatched, false); assert.equal(run.usage().physicalAttempts, 0);
  const record = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')).runs[0];
  assert.equal(record.taskId, 'cancel-during-save'); assert.equal(record.holdMicros, '10'); assert.equal(record.closed, false);
  await assert.rejects(ledger.begin('cancel-during-save'), /ambiguous-dispatch/);
  await run.finish();
});

test('Ticketmaster rate timestamps follow delayed durable reservation and bound physical starts', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-rate-save-'));
  let now = budgetOptions.now(); const base = now, waits: number[] = [];
  const ledger = await LiveBudget.open(directory, { ...budgetOptions, now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; } });
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const runs = await Promise.all(['one', 'two', 'three'].map((id) => ledger.begin(id)));
  const persistence = ledger as unknown as { save: () => Promise<void> }; const save = persistence.save.bind(ledger);
  let entered!: () => void, release!: () => void, first = true;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(persistence, 'save', async () => { if (first) { first = false; entered(); await barrier; } await save(); });
  const starts: number[] = [];
  const dispatch = (run: typeof runs[number]) => run.dispatch('events', async () => {
    starts.push(now - base);
    const stored = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    assert.equal(stored.runs.find((entry: any) => entry.taskId === run.taskId).attempts[0].outcome, 'reserved');
  });
  const firstTwo = Promise.all(runs.slice(0, 2).map(dispatch));
  await saving; now += 1000; release(); await firstTwo;
  await dispatch(runs[2]!);
  assert.deepEqual(starts, [1000, 1000, 2000]); assert.deepEqual(waits, [1000]);
  for (const run of runs) await run.finish();
});

test('close while physical work is active can be retried after settlement and releases the writer lock', async (t) => {
  const { LiveBudget } = await api(); const directory = await mkdtemp(join(tmpdir(), 'city-close-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = await LiveBudget.open(directory, budgetOptions), run = await ledger.begin('active');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const dispatched = run.dispatch('generate', async () => { entered(); await barrier; });
  await started;
  await assert.rejects(ledger.close(), /still has dispatched work/);
  await assert.rejects(ledger.begin('during-shutdown'), /not-configured/);
  await assert.rejects(LiveBudget.open(directory, budgetOptions), /writer/);
  release(); await dispatched; await run.finish();
  await Promise.all([ledger.close(), ledger.close()]);
  const reopened = await LiveBudget.open(directory, budgetOptions);
  assert.equal(reopened.snapshot().reservedCostMicros, '1');
  await reopened.close();
});
