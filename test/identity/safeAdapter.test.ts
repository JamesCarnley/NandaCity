import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http, zeroAddress, type Address, type Hash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadSafeArtifacts, type SafeNetworkConfig } from '../../src/safe/contracts.js';

test('Safe vendor validates pinned artifacts, complete source and address-specific MultiSend runtime', async () => {
  const contracts = await import('../../src/safe/contracts.js').catch(() => undefined);
  assert.ok(contracts, 'the pinned Safe contracts validator must exist');
  const artifacts = contracts.loadSafeArtifacts();
  contracts.checkSafeVendor();
  assert.equal(Object.keys(artifacts).length, 6);
  const address = '0x1111111111111111111111111111111111111111';
  const expected = artifacts.multiSend.deployedBytecode.slice(0, 450) +
    '0000000000000000000000001111111111111111111111111111111111111111' +
    artifacts.multiSend.deployedBytecode.slice(514);
  assert.equal(contracts.expectedSupportRuntime('multiSend', address), expected);
  assert.equal(contracts.expectedSupportRuntime('safeSingleton', address), artifacts.safeSingleton.deployedBytecode);
});

test('all write seams refuse non-loopback RPC before dispatching any request', async () => {
  const adapter = await import('../../src/safe/adapter.js');
  const fixture = await import('../../src/demo/safeFixture.js');
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const rpcUrl = `http://127.0.0.1:${address.port}`;
    const artifacts = loadSafeArtifacts();
    const contracts = Object.fromEntries(['safeSingleton', 'safeProxyFactory', 'fallbackHandler', 'multiSend', 'multiSendCallOnly']
      .map((name, index) => [name, { address: `0x${String(index + 1).repeat(40)}`, abi: artifacts[name as keyof typeof artifacts].abi }]));
    const network = { chainId: 31337, genesisHash: `0x${'11'.repeat(32)}` as Hash, rpcUrl, safeVersion: '1.4.1', contracts } as SafeNetworkConfig;
    const bad = { ...network, rpcUrl: 'https://mainnet.example.invalid' };
    const owner = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ account: owner, transport: http(bad.rpcUrl, { retryCount: 0 }) });
    const input = { owners: ['0x7777777777777777777777777777777777777777', '0x8888888888888888888888888888888888888888'] as [Address, Address],
      threshold: 1 as const, saltNonce: '0', fallbackHandler: network.contracts.fallbackHandler.address };
    const prepared = { network: bad } as Parameters<typeof adapter.prepareDeploymentExecution>[0];
    const execution = { network: bad } as Parameters<typeof adapter.executePrepared>[0];
    await assert.rejects(adapter.prepareSafeDeployment(bad, input), /loopback/);
    await assert.rejects(adapter.prepareDeploymentExecution(prepared, wallet), /loopback/);
    await assert.rejects(adapter.executeSafeDeployment(prepared as Parameters<typeof adapter.executeSafeDeployment>[0]), /loopback/);
    await assert.rejects(adapter.prepareSingleCall(bad, owner.address, { to: owner.address, value: '0', data: '0x', operation: 0 }), /loopback/);
    await assert.rejects(adapter.approveSingleCall(execution, {} as Parameters<typeof adapter.approveSingleCall>[1]), /loopback/);
    await assert.rejects(adapter.prepareExecution(execution, wallet), /loopback/);
    await assert.rejects(adapter.executePrepared(execution), /loopback/);
    await assert.rejects(fixture.deploySafeSupportContracts(createPublicClient({ transport: http(rpcUrl) }), wallet), /loopback/);
    // Even when the read config is local, reject a nonlocal payer before any read.
    await assert.rejects(adapter.prepareDeploymentExecution({ ...prepared, network }, wallet), /loopback/);
    await assert.rejects(adapter.prepareExecution({ ...execution, network }, wallet), /loopback/);
    assert.equal(requests, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('nonce narrowing rejects unsafe, negative, fractional and out-of-range inputs', async () => {
  const adapter = await import('../../src/safe/adapter.js').catch(() => undefined);
  assert.ok(adapter, 'the bounded Safe adapter must exist');
  assert.equal(adapter.checkedNonce(0n), 0);
  assert.equal(adapter.checkedNonce(9007199254740991n), Number.MAX_SAFE_INTEGER);
  for (const value of [-1n, 9007199254740992n, (1n << 256n), -1, 0.5, NaN, Infinity, 9007199254740992]) {
    assert.throws(() => adapter.checkedNonce(value), /nonce/i);
  }
});
