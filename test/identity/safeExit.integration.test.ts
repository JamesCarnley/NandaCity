import assert from 'node:assert/strict';
import test from 'node:test';

test('same-account clean exit and disposable attacker companion are separate process proofs', { timeout: 240_000 }, async (t) => {
  const exit = await import('../../src/demo/safeExit.js').catch(() => undefined);
  assert.ok(exit, 'same-account clean-process exit drill must exist');
  const checkout = process.env['NANDA_INDEX_CHECKOUT']; assert.ok(checkout);
  const result = await exit.runSafeExit(checkout, new URL('./fixtures/safeExitWorker.ts', import.meta.url));
  assert.equal(result.cleanExit.label, 'same-account-clean-exit');
  assert.equal(result.cleanExit.originalSecretHoldersStopped, true);
  assert.equal(result.cleanExit.restoredInFreshProcess, true);
  assert.equal(result.cleanExit.unchangedSafeAndIds, true);
  assert.equal(result.cleanExit.retiredPrimaryAbsent, true);
  assert.equal(result.cleanExit.replacementExecutorSelfFunded, true);
  assert.deepEqual(result.cleanExit.services.map((s) => s.status), ['verified', 'verified']);
  assert.equal(result.cleanExit.discoveriesVerified, 4);
  assert.equal(result.cleanExit.freshInteractionsVerified, 2);
  assert.deepEqual(result.cleanExit.history, ['qualified', 'qualified']);
  assert.equal(result.adversarial.label, 'adversarial-revocation-companion');
  assert.equal(result.adversarial.freshRetiredPrimaryRejected, true);
  assert.equal(result.adversarial.freshRetiredRuntimeRejected, true);
  assert.deepEqual(Object.keys(result.failures).sort(), ['backup-mutations-no-signing', 'contract-owner-before-approval-refused', 'future-owner-runtime-refused', 'history-missing-mismatched-incomplete',
    'lost-reply-exact-bytes', 'migration-tampering-no-signing', 'operator-previous-uri-before-send-refused', 'operator-runtime-approval-before-send-refused',
    'owner-code-before-approval-refused', 'owner-code-before-broadcast-refused',
    'partial-existing-ids', 'planned-publication-binding-refused', 'removed-backup-no-recovery',
    'stale-index-no-fresh-authority']);
  assert.ok(Object.values(result.failures).every((value) => value === true));
  assert.ok(!/privateKey|password|rawTransaction|ownerSignature|executionCalldata|ciphertext/.test(JSON.stringify(result)));
  t.diagnostic(`clean migration: ${result.cleanExit.transactions} transactions; gas ${result.cleanExit.gas.join(',')}`);
});
