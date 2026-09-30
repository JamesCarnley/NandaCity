import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi,
  parseEther, stringToHex, zeroAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { withOwnedAnvil } from '../../src/demo/anvil.js';
import { deployRegistry, deployReputationRegistry, published, receipt,
  registryAbi } from '../../src/demo/registryFixture.js';
import { verifyDiscovery, type DiscoveredCandidate } from '../../src/discovery/verifyDiscovery.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';

const reputationAbi = parseAbi([
  'function getVersion() view returns (string)',
  'function getIdentityRegistry() view returns (address)',
]);

test('owned registry exact URI bytes reject a normalized discovery substitute',
  { timeout: 90_000 }, async () => {
    await withOwnedAnvil(async (rpcUrl) => {
      const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
      const client = createPublicClient({ transport, pollingInterval: 25 });
      const control = createTestClient({ mode: 'anvil', transport });
      const owner = privateKeyToAccount(generatePrivateKey());
      await control.setBalance({ address: owner.address, value: parseEther('100') });
      const wallet = createWalletClient({ account: owner, transport });
      const registry = await deployRegistry(client, wallet);
      await receipt(client, await wallet.writeContract({ address: registry, abi: registryAbi,
        functionName: 'register', chain: null }));
      const agent = { chainId: 31_337, registry, agentId: '0' };
      const record = published({ agentId: '0', owner, city: 'Chicago', revision: 1,
        cardUrl: 'http://127.0.0.1:39001/card', invocationUrl: 'http://127.0.0.1:39001/a2a',
        cardBytes: new Uint8Array(), agentURI: '' }, agent.chainId, registry);
      const writeURI = async (agentURI: string) => receipt(client,
        await wallet.writeContract({ address: registry, abi: registryAbi,
          functionName: 'setAgentURI', args: [0n, agentURI], chain: null }));
      const exactAgentURI = `\uFEFF${record.agentURI}`;
      const publication = await writeURI(exactAgentURI);
      const header = await client.getBlock({ blockNumber: publication.blockNumber });
      const snapshot = await readIdentitySnapshot(client, agent, publication.blockNumber);
      const candidate: DiscoveredCandidate = {
        observerOrigin: 'http://127.0.0.1:39002', agent, agentURI: record.agentURI,
        declaration: {
          identifier: `eip155:31337/erc721:${registry}/0`,
          displayName: 'Operator 0 Chicago Planner', type: 'application/agent-card+json',
          url: record.cardUrl, description: 'Synthetic Chicago service from a simulated operator.',
          capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
          areaServed: ['https://www.wikidata.org/entity/Q1297'],
          interfaces: ['application/a2a+json;version=0.3'],
        },
        observationBlock: { number: publication.blockNumber.toString(), hash: publication.blockHash,
          timestamp: Number(header.timestamp) },
      };

      const result = verifyDiscovery(candidate, snapshot, record.cardBytes,
        { areaServed: ['https://www.wikidata.org/entity/Q1297'] });

      assert.equal(result.status, 'rejected');
      assert.match(result.status === 'rejected' ? result.reason : '', /exactly match/i);
      assert.equal(snapshot.agentURI, exactAgentURI);

      const ordinaryPublication = await writeURI(record.agentURI);
      const ordinaryHeader = await client.getBlock({ blockNumber: ordinaryPublication.blockNumber });
      const ordinarySnapshot = await readIdentitySnapshot(client, agent, ordinaryPublication.blockNumber);
      const ordinary = verifyDiscovery({ ...candidate, observationBlock: {
        number: ordinaryPublication.blockNumber.toString(), hash: ordinaryPublication.blockHash,
        timestamp: Number(ordinaryHeader.timestamp),
      } }, ordinarySnapshot, record.cardBytes,
      { areaServed: ['https://www.wikidata.org/entity/Q1297'] });
      assert.equal(ordinary.status, 'verified');
      assert.equal(ordinary.status === 'verified' ? ordinary.profile.source.agentUriDigest : undefined,
        keccak256(stringToHex(record.agentURI)));

      for (const opaqueURI of ['', 'https://opaque.example/agent',
        'ipfs://bafybeigdyrzt/agent.json', 'https://opaque.example/\u6771\u4eac/\uD83C\uDF06']) {
        const opaquePublication = await writeURI(opaqueURI);
        assert.equal((await readIdentitySnapshot(client, agent, opaquePublication.blockNumber)).agentURI,
          opaqueURI);
      }
    });
  });

test('deploys the pinned local Reputation proxy linked to the selected Identity Registry', async () => {
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000 });
    // No-write assertions need fresh heads, not a receipt poller's cached block.
    const client = createPublicClient({ transport, pollingInterval: 50, cacheTime: 0 });
    const testClient = createTestClient({ mode: 'anvil', transport });
    const account = privateKeyToAccount(generatePrivateKey());
    await testClient.setBalance({ address: account.address, value: parseEther('100') });
    const admin = createWalletClient({ account, transport });
    const identity = await deployRegistry(client, admin);

    const beforeInvalid = await client.getBlockNumber();
    await assert.rejects(deployReputationRegistry(client, admin, zeroAddress),
      /identity registry/i);
    await assert.rejects(deployReputationRegistry(client, admin, account.address),
      /identity registry/i);
    await assert.rejects(deployReputationRegistry(client, admin, undefined as unknown as Address),
      /identity registry/i);
    assert.equal(await client.getBlockNumber(), beforeInvalid,
      'invalid identity input must not trigger a deployment');

    const reputation = await deployReputationRegistry(client, admin, identity);
    assert.notEqual(reputation.toLowerCase(), identity.toLowerCase());
    assert.ok(await client.getCode({ address: reputation }));
    assert.equal(await client.readContract({ address: reputation, abi: reputationAbi,
      functionName: 'getVersion' }), '2.0.0');
    assert.equal((await client.readContract({ address: reputation, abi: reputationAbi,
      functionName: 'getIdentityRegistry' })).toLowerCase(), identity.toLowerCase());

    const beforeWrongRegistry = await client.getBlockNumber();
    await assert.rejects(deployReputationRegistry(client, admin, reputation),
      /Identity Registry.*ERC-721/i,
      'a Reputation proxy is not an Identity Registry even when it reports version 2.0.0');
    assert.equal(await client.getBlockNumber(), beforeWrongRegistry,
      'wrong-registry preflight must not trigger a deployment');
  });
});

test('refuses Reputation deployment through non-loopback or mismatched RPC transports', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const local = http('http://127.0.0.1:8545', { retryCount: 0 });
  const otherLocal = http('http://127.0.0.1:8546', { retryCount: 0 });
  const publicRpc = http('https://mainnet.example', { retryCount: 0 });
  const identity = '0x1111111111111111111111111111111111111111';
  await assert.rejects(deployReputationRegistry(createPublicClient({ transport: publicRpc }),
    createWalletClient({ account, transport: publicRpc }), identity), /loopback HTTP RPC/i);
  await assert.rejects(deployReputationRegistry(createPublicClient({ transport: local }),
    createWalletClient({ account, transport: publicRpc }), identity), /loopback HTTP RPC|same.*RPC/i);
  await assert.rejects(deployReputationRegistry(createPublicClient({ transport: local }),
    createWalletClient({ account, transport: otherLocal }), identity), /same loopback RPC/i);
});

test('fails helpfully instead of skipping when Anvil is unavailable', async () => {
  const { runIdentityDemo } = await import('../../src/demo/identity.js');

  await assert.rejects(
    runIdentityDemo({ anvilBinary: 'nandacity-intentionally-missing-anvil' }),
    /Anvil 1\.7\.1.*foundryup/i,
  );
});

test('does not enter the write callback when another chain occupies the selected port', async () => {
  const foreignMarker = { blockNumber: 71_001n, timestamp: 1_710_000_001n };
  const expectedMarker = { blockNumber: 82_002n, timestamp: 1_720_000_002n };

  await withOwnedAnvil(
    async (foreignRpcUrl) => {
      let callbackEntered = false;
      const port = Number(new URL(foreignRpcUrl).port);

      await assert.rejects(
        withOwnedAnvil(
          async () => {
            callbackEntered = true;
          },
          { port, genesisMarker: expectedMarker },
        ),
        /owned Anvil genesis marker mismatch/i,
      );
      assert.equal(callbackEntered, false);

      const foreignClient = createPublicClient({
        transport: http(foreignRpcUrl, { retryCount: 0, timeout: 1_000 }),
      });
      assert.equal(await foreignClient.getBlockNumber(), foreignMarker.blockNumber);
    },
    { genesisMarker: foreignMarker },
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
  assert.equal(result.provenance.solcTmpVersion, '0.2.7');
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
