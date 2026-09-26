import assert from 'node:assert/strict';

import { encodeFunctionData, isAddress, keccak256, parseAbi, zeroAddress, type Account, type Address, type Hash,
  type PublicClient, type WalletClient, type Transport } from 'viem';

import { encodeRegistration, digestBytes } from '../identity/profile.js';
import { assertLocalWriteRpcUrl } from './anvil.js';
import { compileReferenceContracts, type ContractArtifact } from './contracts.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';

export const chicago = 'https://www.wikidata.org/entity/Q1297';
export const boston = 'https://www.wikidata.org/entity/Q100';
export const registryAbi = parseAbi([
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function register() returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
const adminAbi = parseAbi(['function initialize()', 'function getVersion() view returns (string)']);
const erc721InterfaceAbi = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);
const reputationAdminAbi = parseAbi([
  'function initialize(address identityRegistry)',
  'function getVersion() view returns (string)',
  'function getIdentityRegistry() view returns (address)',
]);
const minimalAbi = parseAbi(['function upgradeToAndCall(address newImplementation, bytes data) payable']);

export type CardRecord = { agentId: string; owner: Account; city: 'Chicago' | 'Boston';
  cardUrl: string; invocationUrl: string; revision: number; cardBytes: Uint8Array;
  agentURI: string; operatorLabel?: string };

export async function receipt(client: PublicClient, hash: Hash): Promise<import('viem').TransactionReceipt> {
  const result = await client.waitForTransactionReceipt({ hash, timeout: 10_000 });
  assert.equal(result.status, 'success');
  return result;
}
async function deploy(client: PublicClient, wallet: WalletClient<Transport, undefined, Account>,
  artifact: ContractArtifact, args: readonly unknown[]): Promise<Address> {
  const mined = await receipt(client, await wallet.deployContract({ abi: artifact.abi,
    bytecode: artifact.bytecode, args, chain: null }));
  assert.ok(mined.contractAddress);
  return mined.contractAddress;
}
export async function deployRegistry(client: PublicClient,
  admin: WalletClient<Transport, undefined, Account>): Promise<Address> {
  return (await deployKnownRegistry(client, admin)).registry;
}

/** Known implementation provenance is captured only from our pinned-artifact deployment. */
export async function deployRegistryWithDomain(client: PublicClient,
  admin: WalletClient<Transport, undefined, Account>): Promise<IdentityContinuityDomain> {
  const genesis = await client.getBlock({ blockNumber: 0n });
  assert.ok(genesis.hash);
  return { ...await deployKnownRegistry(client, admin),
    chainId: await client.getChainId(), genesisHash: genesis.hash };
}

async function deployKnownRegistry(client: PublicClient,
  admin: WalletClient<Transport, undefined, Account>) {
  const artifacts = compileReferenceContracts();
  const minimal = await deploy(client, admin, artifacts.minimalUups, []);
  const proxy = await deploy(client, admin, artifacts.erc1967Proxy, [minimal,
    encodeFunctionData({ abi: parseAbi(['function initialize(address identityRegistry)']),
      functionName: 'initialize', args: ['0x0000000000000000000000000000000000000000'] })]);
  const implementation = await deploy(client, admin, artifacts.identityRegistry, []);
  await receipt(client, await admin.writeContract({ address: proxy, abi: minimalAbi,
    functionName: 'upgradeToAndCall', args: [implementation,
      encodeFunctionData({ abi: adminAbi, functionName: 'initialize' })], chain: null }));
  assert.equal(await client.readContract({ address: proxy, abi: adminAbi, functionName: 'getVersion' }), '2.0.0');
  const code = await client.getCode({ address: implementation });
  assert.ok(code && code !== '0x');
  return { registry: proxy,
    knownImplementation: { address: implementation, codeHash: keccak256(code) } };
}

/** This write path is only for the disposable local-chain fixture. */
export async function deployReputationRegistry(client: PublicClient,
  admin: WalletClient<Transport, undefined, Account>, identityRegistry: Address): Promise<Address> {
  const publicUrl = client.transport.type === 'http' && 'url' in client.transport
    ? client.transport.url : undefined;
  const walletUrl = admin.transport.type === 'http' && 'url' in admin.transport
    ? admin.transport.url : undefined;
  if (typeof publicUrl !== 'string' || typeof walletUrl !== 'string') {
    throw new Error('Reputation deployment requires a loopback HTTP RPC');
  }
  assertLocalWriteRpcUrl(publicUrl);
  assertLocalWriteRpcUrl(walletUrl);
  if (publicUrl !== walletUrl) {
    throw new Error('Reputation deployment requires the same loopback RPC for reads and writes');
  }
  if (typeof identityRegistry !== 'string' || !isAddress(identityRegistry) ||
    identityRegistry.toLowerCase() === zeroAddress) {
    throw new Error('Reputation deployment requires a nonzero Identity Registry address');
  }
  if (await client.getChainId() !== 31_337) {
    throw new Error('Reputation deployment requires local chain ID 31337');
  }
  const identityCode = await client.getCode({ address: identityRegistry });
  if (!identityCode || identityCode === '0x') {
    throw new Error('Reputation deployment requires a deployed Identity Registry');
  }
  let identityVersion: string;
  try {
    identityVersion = await client.readContract({ address: identityRegistry, abi: adminAbi,
      functionName: 'getVersion' });
  } catch (error) {
    throw new Error('Reputation deployment requires a readable Identity Registry', { cause: error });
  }
  if (identityVersion !== '2.0.0') {
    throw new Error(`Reputation deployment requires Identity Registry 2.0.0, received ${identityVersion}`);
  }
  let supportsErc721: boolean;
  try {
    supportsErc721 = await client.readContract({ address: identityRegistry,
      abi: erc721InterfaceAbi, functionName: 'supportsInterface', args: ['0x80ac58cd'] });
  } catch (error) {
    throw new Error('Identity Registry ERC-721 interface check failed', { cause: error });
  }
  if (!supportsErc721) {
    throw new Error('Identity Registry must support ERC-721');
  }

  const artifacts = compileReferenceContracts();
  const minimal = await deploy(client, admin, artifacts.minimalUups, []);
  const proxy = await deploy(client, admin, artifacts.erc1967Proxy, [minimal,
    encodeFunctionData({ abi: reputationAdminAbi, functionName: 'initialize',
      args: [identityRegistry] })]);
  const implementation = await deploy(client, admin, artifacts.reputationRegistry, []);
  await receipt(client, await admin.writeContract({ address: proxy, abi: minimalAbi,
    functionName: 'upgradeToAndCall', args: [implementation,
      encodeFunctionData({ abi: reputationAdminAbi, functionName: 'initialize',
        args: [identityRegistry] })], chain: null }));
  assert.equal(await client.readContract({ address: proxy, abi: reputationAdminAbi,
    functionName: 'getVersion' }), '2.0.0');
  assert.equal((await client.readContract({ address: proxy, abi: reputationAdminAbi,
    functionName: 'getIdentityRegistry' })).toLowerCase(), identityRegistry.toLowerCase());
  return proxy;
}

function makeCard(record: Pick<CardRecord, 'city' | 'invocationUrl' | 'revision' | 'operatorLabel'>) {
  return { protocolVersion: '0.3.0',
    name: record.operatorLabel ? `${record.operatorLabel} ${record.city} Planner` : `Operator ${record.city} Planner`,
    description: `Synthetic ${record.city} evening plan.`, url: record.invocationUrl,
    preferredTransport: 'JSONRPC', version: `0.${record.revision}.0`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'evening-plan', name: 'Evening Plan',
      description: 'Synthetic city evening plan.', tags: ['city'] }] };
}
export function published(record: CardRecord, chainId: number, registry: Address,
  active = true, runtimeSigner?: Address): CardRecord {
  const cardBytes = new TextEncoder().encode(JSON.stringify(makeCard(record)));
  const agentURI = encodeRegistration({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: record.operatorLabel ? `${record.operatorLabel} ${record.city} Planner` :
      `Operator ${record.agentId} ${record.city} Planner`,
    description: `Synthetic ${record.city} service from a simulated operator.`,
    image: `https://city.example/${record.city.toLowerCase()}.png`, active,
    x402Support: false, supportedTrust: [],
    registrations: [{ agentId: record.agentId,
      agentRegistry: `eip155:${chainId}:${registry}` }],
    services: [{ name: 'A2A', endpoint: record.cardUrl, version: '0.3.0' }],
    'x-nandacity': { version: '0.1', ownerAtPublication: record.owner.address,
      revision: record.revision, cardDigest: digestBytes(cardBytes),
      endpoint: record.invocationUrl, receiptSigner: runtimeSigner ?? record.owner.address,
      capability: 'evening-plan', areaServed: [{ '@type': 'City',
        '@id': record.city === 'Chicago' ? chicago : boston, name: record.city }] },
  });
  return { ...record, cardBytes, agentURI };
}
