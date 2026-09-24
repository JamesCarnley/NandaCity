import assert from 'node:assert/strict';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { encodeRegistration, digestBytes } from '../identity/profile.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import {
  verifyProfile,
  type AgentRef,
  type AuthoritySnapshot,
  type ProfileCandidate,
} from '../identity/verify.js';
import { assertLocalWriteRpcUrl, withOwnedAnvil } from './anvil.js';
import { ownedFetch } from './ownedLifecycle.js';
import {
  compileReferenceContracts,
  type ContractArtifact,
  type ReferenceArtifacts,
  type ReferenceProvenance,
} from './contracts.js';

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const textEncoder = new TextEncoder();

const minimalAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
]);
const registryAdminAbi = parseAbi([
  'function initialize()',
  'function owner() view returns (address)',
  'function getVersion() pure returns (string)',
]);
const registryAgentAbi = parseAbi([
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function register() returns (uint256 agentId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);

type AcceptanceChecks = {
  emptyRegistrationUnusable: boolean;
  originalProfile: boolean;
  tamperedUriRejected: boolean;
  tamperedCardRejected: boolean;
  wrongChainRejected: boolean;
  wrongRegistryRejected: boolean;
  wrongAgentRejected: boolean;
  otherOperatorUpdateRejected: boolean;
  ownerUpdateAccepted: boolean;
  oldCandidateRejectedByFreshState: boolean;
  oldCandidateValidAtOriginalSnapshot: boolean;
  transferInvalidatedOldOwnerProfile: boolean;
  newOwnerPublicationAccepted: boolean;
};

export type IdentityDemoResult = {
  label: 'local-demo';
  chainId: 31_337;
  rpcUrl: string;
  registry: Address;
  agentId: string;
  registryAdmin: Address;
  agentOwner: Address;
  implementation: Address;
  registryVersion: '2.0.0';
  declaredReceiptSigner: Address;
  snapshot: AuthoritySnapshot;
  observedHead: string;
  confirmationCount: string;
  acceptance: AcceptanceChecks;
  provenance: ReferenceProvenance;
  cleanup: {
    ownedAnvilProcessId: number;
    stopped: true;
  };
  limits: readonly string[];
};

type ScenarioResult = Omit<IdentityDemoResult, 'rpcUrl' | 'cleanup'>;

function assertAddressEqual(actual: Address, expected: Address, label: string): void {
  assert.equal(actual.toLowerCase(), expected.toLowerCase(), label);
}

function bytesFor(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function profileFor(input: {
  agent: AgentRef;
  owner: Address;
  receiptSigner: Address;
  revision: number;
  endpoint: string;
  cardVersion: string;
}): { candidate: ProfileCandidate; card: Record<string, unknown> } {
  const card = {
    protocolVersion: '0.3.0',
    name: 'NANDA City Chicago Planner',
    description: 'Builds a bounded evening plan for Chicago.',
    url: input.endpoint,
    preferredTransport: 'JSONRPC',
    version: input.cardVersion,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'evening-plan',
        name: 'Evening Plan',
        description: 'Builds a bounded city evening plan.',
        tags: ['city', 'food', 'events'],
      },
    ],
  };
  const cardBytes = bytesFor(card);
  const registration = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'NANDA City Chicago Planner',
    description: 'A local ERC-8004 identity demonstration for Chicago.',
    image: 'https://city.example/chicago.png',
    active: true,
    x402Support: false,
    supportedTrust: [],
    registrations: [
      {
        agentId: input.agent.agentId,
        agentRegistry: `eip155:${input.agent.chainId}:${input.agent.registry}`,
      },
    ],
    services: [
      {
        name: 'A2A',
        endpoint: 'https://chicago-planner.example/.well-known/agent-card.json',
        version: '0.3.0',
      },
    ],
    'x-nandacity': {
      version: '0.1',
      ownerAtPublication: input.owner,
      revision: input.revision,
      cardDigest: digestBytes(cardBytes),
      endpoint: input.endpoint,
      receiptSigner: input.receiptSigner,
      capability: 'evening-plan',
      areaServed: [
        {
          '@type': 'City',
          '@id': 'https://www.wikidata.org/entity/Q1297',
          name: 'Chicago',
        },
      ],
    },
  };
  const agentURI = encodeRegistration(registration);

  return {
    card,
    candidate: {
      agent: { ...input.agent },
      agentURI,
      cardBytes,
    },
  };
}

async function confirmedReceipt(
  client: PublicClient,
  hash: Hash,
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 10_000,
  });
  return receipt;
}

async function successfulReceipt(
  client: PublicClient,
  hash: Hash,
  label: string,
): Promise<TransactionReceipt> {
  const receipt = await confirmedReceipt(client, hash);
  assert.equal(receipt.status, 'success', `${label} transaction must succeed`);
  return receipt;
}

async function deploy(
  client: PublicClient,
  wallet: WalletClient<Transport, undefined, Account>,
  artifact: ContractArtifact,
  args: readonly unknown[],
  label: string,
): Promise<Address> {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    chain: null,
  });
  const receipt = await successfulReceipt(client, hash, label);
  assert.ok(receipt.contractAddress, `${label} receipt must contain a contract address`);
  return receipt.contractAddress;
}

async function proxyImplementation(
  client: PublicClient,
  proxy: Address,
): Promise<Address> {
  const value = await client.getStorageAt({
    address: proxy,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  assert.ok(value, 'proxy implementation slot must be readable');
  return getAddress(`0x${value.slice(-40)}`);
}

function expectVerificationFailure(
  run: () => unknown,
  expected: RegExp,
  label: string,
): boolean {
  assert.throws(run, expected, label);
  return true;
}

async function runScenario(
  rpcUrl: string,
  artifacts: ReferenceArtifacts,
): Promise<ScenarioResult> {
  assertLocalWriteRpcUrl(rpcUrl);
  const transport = http(rpcUrl, { retryCount: 0, timeout: 5_000, fetchFn: ownedFetch });
  const publicClient = createPublicClient({ pollingInterval: 50, transport });
  const testClient = createTestClient({ mode: 'anvil', transport });
  const registryAdminAccount = privateKeyToAccount(generatePrivateKey());
  const operatorAAccount = privateKeyToAccount(generatePrivateKey());
  const operatorBAccount = privateKeyToAccount(generatePrivateKey());
  const receiptSignerA = privateKeyToAccount(generatePrivateKey()).address;
  const receiptSignerB = privateKeyToAccount(generatePrivateKey()).address;
  const registryAdminWallet = createWalletClient({
    account: registryAdminAccount,
    transport,
  });
  const operatorAWallet = createWalletClient({ account: operatorAAccount, transport });
  const operatorBWallet = createWalletClient({ account: operatorBAccount, transport });

  const chainId = await publicClient.getChainId();
  assert.equal(chainId, 31_337, 'owned Anvil must use chain ID 31337');
  for (const account of [registryAdminAccount, operatorAAccount, operatorBAccount]) {
    await testClient.setBalance({ address: account.address, value: parseEther('100') });
  }

  const minimalImplementation = await deploy(
    publicClient,
    registryAdminWallet,
    artifacts.minimalUups,
    [],
    'minimal UUPS implementation deployment',
  );
  const minimalInitialize = encodeFunctionData({
    abi: parseAbi(['function initialize(address identityRegistry)']),
    functionName: 'initialize',
    args: [zeroAddress],
  });
  const registry = await deploy(
    publicClient,
    registryAdminWallet,
    artifacts.erc1967Proxy,
    [minimalImplementation, minimalInitialize],
    'ERC1967 proxy deployment',
  );
  const initialProxyOwner = await publicClient.readContract({
    address: registry,
    abi: minimalAdminAbi,
    functionName: 'owner',
  });
  assertAddressEqual(
    initialProxyOwner,
    registryAdminAccount.address,
    'proxy bootstrap owner must be the registry admin',
  );
  assertAddressEqual(
    await proxyImplementation(publicClient, registry),
    minimalImplementation,
    'proxy must initially target HardhatMinimalUUPS',
  );

  const realImplementation = await deploy(
    publicClient,
    registryAdminWallet,
    artifacts.identityRegistry,
    [],
    'identity registry implementation deployment',
  );
  const registryInitialize = encodeFunctionData({
    abi: registryAdminAbi,
    functionName: 'initialize',
  });
  await successfulReceipt(
    publicClient,
    await registryAdminWallet.writeContract({
      address: registry,
      abi: minimalAdminAbi,
      functionName: 'upgradeToAndCall',
      args: [realImplementation, registryInitialize],
      chain: null,
    }),
    'proxy upgrade and registry initialization',
  );
  assertAddressEqual(
    await proxyImplementation(publicClient, registry),
    realImplementation,
    'proxy must target the real identity registry implementation after upgrade',
  );
  const registryAdmin = await publicClient.readContract({
    address: registry,
    abi: registryAdminAbi,
    functionName: 'owner',
  });
  assertAddressEqual(
    registryAdmin,
    registryAdminAccount.address,
    'registry upgrade admin must remain separate and explicit',
  );
  const registryVersion = await publicClient.readContract({
    address: registry,
    abi: registryAdminAbi,
    functionName: 'getVersion',
  });
  assert.equal(registryVersion, '2.0.0');

  const registrationReceipt = await successfulReceipt(
    publicClient,
    await operatorAWallet.writeContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'register',
      chain: null,
    }),
    'empty identity registration',
  );
  const registeredLogs = parseEventLogs({
    abi: registryAgentAbi,
    eventName: 'Registered',
    logs: registrationReceipt.logs,
    strict: true,
  });
  assert.equal(registeredLogs.length, 1, 'registration must emit one Registered event');
  const registered = registeredLogs[0];
  assert.ok(registered, 'registration must expose its confirmed event');
  const agentIdValue = registered.args.agentId;
  assert.equal(registered.args.agentURI, '', 'initial registration URI must be empty');
  assertAddressEqual(
    registered.args.owner,
    operatorAAccount.address,
    'Registered owner must be operator A',
  );
  const agent: AgentRef = {
    chainId: 31_337,
    registry,
    agentId: agentIdValue.toString(),
  };
  const agentOwner = await publicClient.readContract({
    address: registry,
    abi: registryAgentAbi,
    functionName: 'ownerOf',
    args: [agentIdValue],
  });
  assertAddressEqual(agentOwner, operatorAAccount.address, 'agent owner must be operator A');
  assert.notEqual(
    registryAdmin.toLowerCase(),
    agentOwner.toLowerCase(),
    'registry upgrade admin and agent owner must be distinct roles',
  );

  const emptySnapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    registrationReceipt.blockNumber,
  );
  const emptyRegistrationUnusable = expectVerificationFailure(
    () =>
      verifyProfile(
        { agent, agentURI: '', cardBytes: bytesFor({ invalid: true }) },
        emptySnapshot,
      ),
    /registration.*data URI/i,
    'empty registration must not verify as a usable profile',
  );

  const original = profileFor({
    agent,
    owner: operatorAAccount.address,
    receiptSigner: receiptSignerA,
    revision: 1,
    endpoint: 'https://chicago-planner.example/a2a',
    cardVersion: '0.1.0',
  });
  const originalPublication = await successfulReceipt(
    publicClient,
    await operatorAWallet.writeContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'setAgentURI',
      args: [agentIdValue, original.candidate.agentURI],
      chain: null,
    }),
    'original profile publication',
  );
  const originalSnapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    originalPublication.blockNumber,
  );
  verifyProfile(original.candidate, originalSnapshot);

  const tamperedUriRejected = expectVerificationFailure(
    () =>
      verifyProfile(
        { ...original.candidate, agentURI: `${original.candidate.agentURI}A` },
        originalSnapshot,
      ),
    /agentURI.*exactly match/i,
    'tampered URI must fail verification',
  );
  const tamperedCard = { ...original.card, description: 'Altered after publication.' };
  const tamperedCardRejected = expectVerificationFailure(
    () =>
      verifyProfile(
        { ...original.candidate, cardBytes: bytesFor(tamperedCard) },
        originalSnapshot,
      ),
    /cardDigest/i,
    'tampered card must fail verification',
  );
  await assert.rejects(
    readIdentitySnapshot(publicClient, { ...agent, chainId: 1 }),
    /chain ID/i,
  );
  const wrongChainRejected = expectVerificationFailure(
    () =>
      verifyProfile(
        { ...original.candidate, agent: { ...agent, chainId: 1 } },
        { ...originalSnapshot, agent: { ...agent, chainId: 1 } },
      ),
    /matching registration/i,
    'wrong chain reference must fail profile verification',
  );
  const wrongRegistry = operatorBAccount.address;
  const wrongRegistryRejected = expectVerificationFailure(
    () =>
      verifyProfile(
        { ...original.candidate, agent: { ...agent, registry: wrongRegistry } },
        { ...originalSnapshot, agent: { ...agent, registry: wrongRegistry } },
      ),
    /matching registration/i,
    'wrong registry reference must fail profile verification',
  );
  const wrongAgentRejected = expectVerificationFailure(
    () =>
      verifyProfile(
        { ...original.candidate, agent: { ...agent, agentId: '1' } },
        { ...originalSnapshot, agent: { ...agent, agentId: '1' } },
      ),
    /matching registration/i,
    'wrong agent ID must fail profile verification',
  );

  const unauthorizedHash = await operatorBWallet.writeContract({
    address: registry,
    abi: registryAgentAbi,
    functionName: 'setAgentURI',
    args: [agentIdValue, 'https://unauthorized.invalid/profile'],
    gas: 1_000_000n,
    chain: null,
  });
  const unauthorizedReceipt = await confirmedReceipt(publicClient, unauthorizedHash);
  assert.equal(unauthorizedReceipt.status, 'reverted', 'operator B update must revert');
  assert.equal(
    await publicClient.readContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'tokenURI',
      args: [agentIdValue],
    }),
    original.candidate.agentURI,
    'failed operator B update must not alter the profile',
  );

  const updated = profileFor({
    agent,
    owner: operatorAAccount.address,
    receiptSigner: receiptSignerA,
    revision: 2,
    endpoint: 'https://chicago-planner.example/a2a/v2',
    cardVersion: '0.2.0',
  });
  const updateReceipt = await successfulReceipt(
    publicClient,
    await operatorAWallet.writeContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'setAgentURI',
      args: [agentIdValue, updated.candidate.agentURI],
      chain: null,
    }),
    'operator A profile update',
  );
  const updatedSnapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    updateReceipt.blockNumber,
  );
  verifyProfile(updated.candidate, updatedSnapshot);
  const oldCandidateRejectedByFreshState = expectVerificationFailure(
    () => verifyProfile(original.candidate, updatedSnapshot),
    /agentURI.*exactly match/i,
    'old profile must fail against fresh chain state',
  );
  const rereadOriginalSnapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    originalPublication.blockNumber,
  );
  verifyProfile(original.candidate, rereadOriginalSnapshot);

  const transferReceipt = await successfulReceipt(
    publicClient,
    await operatorAWallet.writeContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'transferFrom',
      args: [operatorAAccount.address, operatorBAccount.address, agentIdValue],
      chain: null,
    }),
    'agent ownership transfer',
  );
  const transferSnapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    transferReceipt.blockNumber,
  );
  assertAddressEqual(
    transferSnapshot.agentOwner,
    operatorBAccount.address,
    'snapshot agentOwner must track ERC-721 ownership',
  );
  const transferInvalidatedOldOwnerProfile = expectVerificationFailure(
    () => verifyProfile(updated.candidate, transferSnapshot),
    /ownerAtPublication/i,
    'transferred identity must reject the old declared owner profile',
  );

  const newOwnerProfile = profileFor({
    agent,
    owner: operatorBAccount.address,
    receiptSigner: receiptSignerB,
    revision: 3,
    endpoint: 'https://chicago-planner.example/a2a/v3',
    cardVersion: '0.3.0',
  });
  const newOwnerPublication = await successfulReceipt(
    publicClient,
    await operatorBWallet.writeContract({
      address: registry,
      abi: registryAgentAbi,
      functionName: 'setAgentURI',
      args: [agentIdValue, newOwnerProfile.candidate.agentURI],
      chain: null,
    }),
    'new owner profile publication',
  );
  const snapshot = await readIdentitySnapshot(
    publicClient,
    agent,
    newOwnerPublication.blockNumber,
  );
  verifyProfile(newOwnerProfile.candidate, snapshot);

  await testClient.mine({ blocks: 2 });
  const observedHead = await publicClient.getBlockNumber({ cacheTime: 0 });
  const confirmationCount = observedHead - BigInt(snapshot.blockNumber) + 1n;
  assert.ok(confirmationCount >= 1n, 'snapshot block must be observed in the local chain');

  return {
    label: 'local-demo',
    chainId: 31_337,
    registry,
    agentId: agent.agentId,
    registryAdmin,
    agentOwner: snapshot.agentOwner,
    implementation: realImplementation,
    registryVersion,
    declaredReceiptSigner: receiptSignerB,
    snapshot,
    observedHead: observedHead.toString(),
    confirmationCount: confirmationCount.toString(),
    acceptance: {
      emptyRegistrationUnusable,
      originalProfile: true,
      tamperedUriRejected,
      tamperedCardRejected,
      wrongChainRejected,
      wrongRegistryRejected,
      wrongAgentRejected,
      otherOperatorUpdateRejected: true,
      ownerUpdateAccepted: true,
      oldCandidateRejectedByFreshState,
      oldCandidateValidAtOriginalSnapshot: true,
      transferInvalidatedOldOwnerProfile,
      newOwnerPublicationAccepted: true,
    },
    provenance: artifacts.provenance,
    limits: [
      'RPC-derived snapshot, not a cryptographic state proof.',
      'A later reorganization can supersede the observed block.',
      'Local confirmation depth is not economic finality.',
      'receiptSigner is declared only; this demo creates no receipt.',
      'No inference, Index synchronization, reputation, or live service result is demonstrated.',
    ],
  };
}

export async function runIdentityDemo(
  options: { anvilBinary?: string } = {},
): Promise<IdentityDemoResult> {
  const artifacts = compileReferenceContracts();
  const owned = await withOwnedAnvil(
    (rpcUrl) => runScenario(rpcUrl, artifacts),
    options,
  );

  return {
    ...owned.value,
    rpcUrl: owned.rpcUrl,
    cleanup: {
      ownedAnvilProcessId: owned.processId,
      stopped: true,
    },
  };
}
