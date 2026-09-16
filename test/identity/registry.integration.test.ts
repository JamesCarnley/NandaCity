import assert from 'node:assert/strict';
import test from 'node:test';

test('fails helpfully instead of skipping when Anvil is unavailable', async () => {
  const { runIdentityDemo } = await import('../../src/demo/identity.js');

  await assert.rejects(
    runIdentityDemo({ anvilBinary: 'nandacity-intentionally-missing-anvil' }),
    /Anvil 1\.7\.1.*foundryup/i,
  );
});

test('runs the identity acceptance story against an owned local Anvil process', async () => {
  const demoModule = await import('../../src/demo/identity.js').catch(() => undefined);
  const cliModule = await import('../../src/cli.js').catch(() => undefined);

  assert.ok(demoModule, 'the executable local identity demo must be implemented');
  assert.equal(typeof demoModule.runIdentityDemo, 'function');
  assert.ok(cliModule, 'the identity demo CLI must be implemented');
  assert.equal(typeof cliModule.formatIdentityDemoPlain, 'function');
  assert.equal(typeof cliModule.formatIdentityDemoJson, 'function');

  const result = await demoModule.runIdentityDemo();

  assert.equal(result.label, 'local-demo');
  assert.equal(result.chainId, 31_337);
  assert.equal(result.registryVersion, '2.0.0');
  assert.equal(result.snapshot.agent.chainId, 31_337);
  assert.equal(result.snapshot.agent.registry, result.registry);
  assert.equal(result.snapshot.agent.agentId, result.agentId);
  assert.match(result.snapshot.blockHash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.snapshot.agentOwner, result.agentOwner);
  assert.notEqual(result.registryAdmin.toLowerCase(), result.agentOwner.toLowerCase());
  assert.notEqual(result.implementation.toLowerCase(), result.registry.toLowerCase());
  assert.ok(
    Object.values(result.acceptance).every((accepted) => accepted === true),
    'every real-chain acceptance assertion must pass',
  );
  assert.equal(
    result.provenance.referenceCommit,
    'b9e466c250744a7e06b13dff9d3c2844ed64f825',
  );
  assert.match(result.provenance.solcVersion, /^0\.8\.24\+commit\.e11b9ed9\./);
  assert.equal(result.provenance.openZeppelinVersion, '5.4.0');
  assert.ok(BigInt(result.observedHead) >= BigInt(result.snapshot.blockNumber));
  assert.ok(BigInt(result.confirmationCount) >= 1n);
  assert.equal(result.cleanup.stopped, true);

  const plain = cliModule.formatIdentityDemoPlain(result);
  assert.match(plain, /local-demo/);
  assert.match(plain, /chainId: 31337/);
  assert.match(plain, new RegExp(`registry: ${result.registry}`, 'i'));
  assert.match(plain, new RegExp(`agentId: ${result.agentId}`));
  assert.match(plain, new RegExp(`blockHash: ${result.snapshot.blockHash}`, 'i'));
  assert.match(plain, /RPC-derived snapshot, not a cryptographic state proof/i);

  const json = cliModule.formatIdentityDemoJson(result);
  const parsed = JSON.parse(json) as typeof result;
  assert.equal(parsed.label, 'local-demo');
  assert.equal(parsed.snapshot.agent.registry, result.registry);
  assert.equal(parsed.snapshot.agent.agentId, result.agentId);
  assert.equal('privateKey' in parsed, false);

  await assert.rejects(
    fetch(result.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      signal: AbortSignal.timeout(1_000),
    }),
    /fetch failed|abort/i,
    'the owned Anvil RPC must be gone when the demo returns',
  );
});
