import assert from 'node:assert/strict';

import { encodeFunctionData, parseAbi, type Account, type Address, type Hash,
  type PublicClient, type WalletClient, type Transport } from 'viem';

import { encodeRegistration, digestBytes } from '../identity/profile.js';
import { compileReferenceContracts, type ContractArtifact } from './contracts.js';

export const chicago = 'https://www.wikidata.org/entity/Q1297';
export const boston = 'https://www.wikidata.org/entity/Q100';
export const registryAbi = parseAbi([
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function register() returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
const adminAbi = parseAbi(['function initialize()', 'function getVersion() view returns (string)']);
const minimalAbi = parseAbi(['function upgradeToAndCall(address newImplementation, bytes data) payable']);

export type CardRecord = { agentId: string; owner: Account; city: 'Chicago' | 'Boston';
  cardUrl: string; invocationUrl: string; revision: number; cardBytes: Uint8Array;
  agentURI: string };

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
  return proxy;
}

function makeCard(record: Pick<CardRecord, 'city' | 'invocationUrl' | 'revision'>) {
  return { protocolVersion: '0.3.0', name: `Operator ${record.city} Planner`,
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
    name: `Operator ${record.agentId} ${record.city} Planner`,
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
