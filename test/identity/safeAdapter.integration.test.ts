import assert from 'node:assert/strict';
import test from 'node:test';
import SafeExport from '@safe-global/protocol-kit';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http,
  keccak256, parseAbi, parseEther, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistryWithDomain } from '../../src/demo/registryFixture.js';
import { protocolContractNetworks } from '../../src/safe/contracts.js';

const Safe = SafeExport as unknown as typeof SafeExport.default;
const corruptLastByte = (bytes: Hex): Hex => `${bytes.slice(0, -2)}${(Number.parseInt(bytes.slice(-2), 16) ^ 1).toString(16).padStart(2, '0')}` as Hex;

const registerData = '0x1aa3a008' as const; // keccak256("register()")[:4]
const tokenAbi = parseAbi([
  'function ownerOf(uint256) view returns(address)', 'function tokenURI(uint256) view returns(string)',
  'function approve(address,uint256)', 'function setApprovalForAll(address,bool)',
]);

test('bounded Safe deployment, separate payer and exact registered effect on an owned chain',
  { timeout: 150_000 }, async (t) => {
  const adapter = await import('../../src/safe/adapter.js');
  const fixture = await import('../../src/demo/safeFixture.js').catch(() => undefined);
  assert.ok(fixture, 'owned Safe support fixture must exist');
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0 });
    const client = createPublicClient({ transport, pollingInterval: 20 });
    const control = createTestClient({ mode: 'anvil', transport });
    const ownerKeys = [generatePrivateKey(), generatePrivateKey()] as const;
    const owners = ownerKeys.map((key) => privateKeyToAccount(key));
    const payer = privateKeyToAccount(generatePrivateKey());
    const runtime = privateKeyToAccount(generatePrivateKey());
    await control.setBalance({ address: payer.address, value: parseEther('100') });
    const wallet = createWalletClient({ account: payer, transport });
    const network = await fixture.deploySafeSupportContracts(client, wallet);
    const domain = await deployRegistryWithDomain(client, wallet);
    const registryRuntimeCodeHash = keccak256((await client.getCode({ address: domain.registry }))!);
    const call = { to: domain.registry, value: '0', data: registerData, operation: 0 } as const;
    const expected = { domain, registryRuntimeCodeHash, call };
    const input = { owners: [owners[0]!.address, owners[1]!.address] as [Address, Address],
      threshold: 1 as const, saltNonce: '42', fallbackHandler: network.contracts.fallbackHandler.address };
    const blockBefore = await client.getBlockNumber({ cacheTime: 0 });
    const prepared = await adapter.prepareSafeDeployment(network, input);
    const signed = await adapter.prepareDeploymentExecution(prepared, wallet);
    const safe = prepared.predictedAddress;
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), blockBefore);
    assert.ok(!(await client.getCode({ address: safe })));
    assert.equal(prepared.account.saltNonce, '42');
    assert.equal(prepared.account.predictedAddress, safe);
    assert.equal(signed.payer.toLowerCase(), payer.address.toLowerCase());
    assert.ok(signed.transactionHash === keccak256(signed.rawTransaction));
    await t.test('deployment mutation refuses before sending', async () => {
      const mutations = [
        { ...signed, predictedAddress: runtime.address },
        { ...signed, account: { ...signed.account, saltNonce: '43' } },
        { ...signed, payer: runtime.address },
        { ...signed, payerNonce: signed.payerNonce + 1 },
        { ...signed, transactionHash: toHex(1n, { size: 32 }) },
        { ...signed, rawTransaction: corruptLastByte(signed.rawTransaction) },
        { ...signed, transaction: { ...signed.transaction, data: '0x' as Hex } },
      ];
      for (const mutation of mutations) await assert.rejects(adapter.executeSafeDeployment(mutation));
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), blockBefore);
    });
    const deployed = await adapter.executeSafeDeployment(signed);
    assert.equal(deployed.account.threshold, 1);
    assert.ok(deployed.account.owners.every((o) => input.owners.includes(o)));
    assert.equal(deployed.safe, safe);
    await t.test('configuration read-back re-derives the deployment salt/address binding', async () => {
      await adapter.readSafeAccount(network, safe, prepared.account);
      await assert.rejects(adapter.readSafeAccount(network, safe, { ...prepared.account, saltNonce: '43' }), /predicted/);
    });
    await assert.rejects(adapter.executeSafeDeployment(signed), /deployed|nonce|submitted/i);
    const kits = await Promise.all(ownerKeys.map((signer) => Safe.init({ provider: rpcUrl, signer,
      safeAddress: safe, isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) })));
    const beforeRegistration = await control.snapshot();
    let firstExecution: Awaited<ReturnType<typeof adapter.executePrepared>> | undefined;
    for (let index = 0; index < 2; index++) await t.test(`owner ${index + 1} approves with unfunded owners and Safe`, async () => {
      const before = await client.getBlockNumber({ cacheTime: 0 });
      const pending = await adapter.prepareSingleCall(network, safe, call);
      assert.equal(pending.nonce, index);
      assert.equal(pending.transactionData.safeTxGas, '0');
      assert.equal(pending.transactionData.gasPrice, '0');
      assert.equal(pending.transactionData.baseGas, '0');
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
      const approval = await adapter.approveSingleCall(pending, kits[index]!);
      const execution = await adapter.prepareExecution(approval, wallet);
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
      if (index === 0) {
        for (const changed of [
          { ...pending, call: { ...call, to: runtime.address } },
          { ...pending, call: { ...call, data: '0x' as Hex } },
          { ...pending, call: { ...call, value: '1' } },
          { ...pending, call: { ...call, operation: 1 } },
          { ...pending, nonce: pending.nonce + 1 },
          { ...pending, nonce: Number.MAX_SAFE_INTEGER + 1 },
          { ...pending, transactionData: { ...pending.transactionData, baseGas: '1' } },
          { ...pending, transactionData: { ...pending.transactionData, gasPrice: '1' } },
          { ...pending, transactionData: { ...pending.transactionData, safeTxGas: '1' } },
          { ...pending, transactionData: { ...pending.transactionData, refundReceiver: payer.address } },
          { ...pending, safeTxHash: toHex(1n, { size: 32 }) },
        ]) await assert.rejects(adapter.approveSingleCall(changed as typeof pending, kits[0]!));
        const stranger = await Safe.init({ provider: rpcUrl, signer: generatePrivateKey(), safeAddress: safe,
          isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
        await assert.rejects(adapter.approveSingleCall(pending, stranger), /owner/i);
        await assert.rejects(adapter.prepareExecution({ ...approval, owner: runtime.address }, wallet));
        await assert.rejects(adapter.prepareExecution({ ...approval,
          ownerSignature: `${approval.ownerSignature.slice(0, -2)}00` as Hex }, wallet));
        await assert.rejects(adapter.executePrepared({ ...execution, rawTransaction: corruptLastByte(execution.rawTransaction) }));
        await assert.rejects(adapter.executePrepared({ ...execution, payerNonce: execution.payerNonce + 1 }));
        await assert.rejects(adapter.executePrepared({ ...execution, payer: runtime.address }));
        await assert.rejects(adapter.executePrepared({ ...execution, executionCalldata: '0x' }));
        assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
      }
      const result = await adapter.executePrepared(execution);
      firstExecution ??= result;
      const effect = await adapter.readRegisteredAgentEffect(client, result, expected);
      assert.equal(effect.agentId, String(index));
      assert.equal(effect.owner.toLowerCase(), safe.toLowerCase());
      assert.equal(effect.agentURI, '');
      assert.equal(effect.transactionHash, execution.transactionHash);
      assert.equal(effect.safeTxHash, execution.safeTxHash);
      assert.equal(effect.payment, '0');
      await assert.rejects(adapter.executePrepared(execution), /nonce|submitted/i);
      await assert.rejects(adapter.prepareExecution(approval, wallet), /nonce/i);
      assert.equal(await client.readContract({ address: domain.registry, abi: tokenAbi,
        functionName: 'ownerOf', args: [BigInt(index)] }), safe);
      for (const account of [...owners.map((o) => o.address), safe]) {
        assert.equal(await client.getBalance({ address: account }), 0n);
      }
    });
    await t.test('independent reader binds receipt, transaction, call, code and numbered block', async () => {
      assert.ok(firstExecution);
      await adapter.readRegisteredAgentEffect(client, firstExecution, expected);
      for (const changed of [
        { ...firstExecution, payer: runtime.address },
        { ...firstExecution, safeTxHash: toHex(1n, { size: 32 }) },
        { ...firstExecution, executionCalldata: '0x' as Hex },
        { ...firstExecution, blockHash: toHex(1n, { size: 32 }) },
      ]) await assert.rejects(adapter.readRegisteredAgentEffect(client, changed, expected));
      await assert.rejects(adapter.readRegisteredAgentEffect(client, firstExecution,
        { ...expected, registryRuntimeCodeHash: toHex(1n, { size: 32 }) }));
      await assert.rejects(adapter.readRegisteredAgentEffect(client, firstExecution,
        { ...expected, call: { ...call, data: '0x' } }));
      await assert.rejects(adapter.readRegisteredAgentEffect(client, firstExecution,
        { ...expected, domain: { ...domain, knownImplementation: { ...domain.knownImplementation, codeHash: toHex(1n, { size: 32 }) } } }));
    });
    await t.test('runtime is neither owner nor token or operator approval', async () => {
      const account = { network, safe };
      await adapter.assertRuntimeSeparated(runtime.address, account, domain.registry, '0');
      await assert.rejects(adapter.assertRuntimeSeparated(input.owners[0], account), /owner/i);
      const run = async (data: Hex) => adapter.executePrepared(await adapter.prepareExecution(
        await adapter.approveSingleCall(await adapter.prepareSingleCall(network, safe, { ...call, data }), kits[0]!), wallet));
      await run(encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [runtime.address, 0n] }));
      await assert.rejects(adapter.assertRuntimeSeparated(runtime.address, account, domain.registry, '0'), /approval/i);
      await run(encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [zeroAddress, 0n] }));
      await run(encodeFunctionData({ abi: tokenAbi, functionName: 'setApprovalForAll', args: [runtime.address, true] }));
      await assert.rejects(adapter.assertRuntimeSeparated(runtime.address, account, domain.registry, '0'), /approval/i);
      await run(encodeFunctionData({ abi: tokenAbi, functionName: 'setApprovalForAll', args: [runtime.address, false] }));
      await adapter.assertRuntimeSeparated(runtime.address, account, domain.registry, '0');
    });
    await t.test('unsafe Safe and payer nonce values refuse before signing or sending', async () => {
      const before = await client.getBlockNumber({ cacheTime: 0 });
      const nonceSlot = toHex(5n, { size: 32 });
      const saved = await client.getStorageAt({ address: safe, slot: nonceSlot });
      await control.setStorageAt({ address: safe, index: nonceSlot, value: toHex(9007199254740992n, { size: 32 }) });
      await assert.rejects(adapter.prepareSingleCall(network, safe, call), /nonce/);
      await control.setStorageAt({ address: safe, index: nonceSlot, value: saved! });
      const approval = await adapter.approveSingleCall(await adapter.prepareSingleCall(network, safe, call), kits[0]!);
      const savedPayerNonce = await client.getTransactionCount({ address: payer.address });
      await control.request({ method: 'anvil_setNonce', params: [payer.address, toHex(9007199254740992n)] });
      await assert.rejects(adapter.prepareExecution(approval, wallet), /nonce/);
      await control.setNonce({ address: payer.address, nonce: savedPayerNonce });
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
    });
    await t.test('changed support code and invalid recovery-account shape refuse', async () => {
      const before = await client.getBlockNumber({ cacheTime: 0 });
      for (const invalid of [
        { ...input, owners: [input.owners[0], input.owners[0]] },
        { ...input, threshold: 2 }, { ...input, saltNonce: '042' },
        { ...input, saltNonce: String(1n << 256n) },
        { ...input, owners: [safe, input.owners[1]] },
        { ...input, fallbackHandler: runtime.address },
      ]) await assert.rejects(adapter.prepareSafeDeployment(network, invalid as typeof input));
      await assert.rejects(adapter.prepareSafeDeployment({ ...network, genesisHash: toHex(1n, { size: 32 }) }, input), /genesis/);
      const multiSend = network.contracts.multiSend.address;
      const code = await client.getCode({ address: multiSend });
      await control.setCode({ address: multiSend, bytecode: corruptLastByte(code!) });
      await assert.rejects(adapter.readSafeAccount(network, safe), /runtime/);
      await control.setCode({ address: multiSend, bytecode: code! });
      assert.equal(await client.getBlockNumber({ cacheTime: 0 }), before);
    });
    await t.test('wrong Safe kit is not an approval authority for the prepared Safe', async () => {
      const other = await adapter.prepareSafeDeployment(network, { ...input, saltNonce: '43' });
      await adapter.executeSafeDeployment(await adapter.prepareDeploymentExecution(other, wallet));
      const wrongKit = await Safe.init({ provider: rpcUrl, signer: ownerKeys[0], safeAddress: other.predictedAddress,
        isL1SafeSingleton: true, contractNetworks: protocolContractNetworks(network) });
      const pending = await adapter.prepareSingleCall(network, safe, call);
      await assert.rejects(adapter.approveSingleCall(pending, wrongKit), /account mismatch/);
    });
    await t.test('effect read-back refuses after the execution block is removed', async () => {
      assert.ok(firstExecution);
      await control.revert({ id: beforeRegistration });
      await assert.rejects(adapter.readRegisteredAgentEffect(client, firstExecution, expected));
    });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_800_000_000n } });
});

test('owned fixture deploys support and verifies a predicted proxy without exporting owners keys', async () => {
  const { withOwnedSafeFixture } = await import('../../src/demo/safeFixture.js');
  await withOwnedSafeFixture(async ({ account, network }) => {
    assert.equal(account.threshold, 1);
    assert.equal(account.owners.length, 2);
    assert.equal(account.account.saltNonce, '0');
    assert.equal(account.safe, account.account.predictedAddress);
    assert.equal(account.network.genesisHash, network.genesisHash);
    assert.equal(Object.keys(account).some((key) => /key|signature|rawTransaction/i.test(key)), false);
  });
});
