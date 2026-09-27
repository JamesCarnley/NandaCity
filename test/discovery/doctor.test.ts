import assert from 'node:assert/strict';
import test from 'node:test';

test('doctor reports missing tools safely and separates optional Town from fixture launch', async () => {
  const api = await import('../../src/demo/doctor.js').catch(() => undefined);
  assert.ok(api?.runDoctor, 'read-only demo doctor must exist');
  const result = await api.runDoctor({ PATH: '/missing-city-tools', NANDA_INDEX_CHECKOUT: '/not-a-checkout-PRIVATE-SENTINEL' });
  assert.equal(result.fixtureReady, false); assert.equal(result.fullCheckReady, false);
  assert.equal(result.checks.find((c) => c.id === 'town')?.requiredFor, 'full-check');
  assert.equal(result.checks.find((c) => c.id === 'python')?.requiredFor, 'full-check');
  assert.equal(result.checks.find((c) => c.id === 'index')?.ok, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE-SENTINEL'), false);
  assert.ok(result.checks.every((c) => c.ok || c.guidance.length > 0));
});
