import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address, type PublicClient, type TestClient, type WalletClient, type Transport } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { deployRegistry, deployReputationRegistry, published, receipt, registryAbi } from '../../src/demo/registryFixture.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { verifyProfile } from '../../src/identity/verify.js';
import { encodeStatement } from '../../src/interaction/bytes.js';
import { signProviderStatement, signRequest } from '../../src/interaction/signatures.js';
import { signFeedback } from '../../src/feedback/signatures.js';
import { encodeFeedbackDocument } from '../../src/feedback/document.js';
import type { CityFeedback } from '../../src/feedback/schema.js';
import type { FeedbackDocument } from '../../src/feedback/document.js';
import type { PrepareLocalFeedbackPublicationInput } from '../../src/demo/feedbackPublication.js';
import type { SignedEnvelope } from '../../src/interaction/schema.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

type Fixture = PrepareLocalFeedbackPublicationInput & {
  input: PrepareLocalFeedbackPublicationInput;
  transport: Transport;
  testClient: TestClient;
  owner: PrivateKeyAccount;
  caller: PrivateKeyAccount;
  stranger: PrivateKeyAccount;
  ownerWallet: WalletClient<Transport, undefined, PrivateKeyAccount>;
  walletClient: WalletClient<Transport, undefined, PrivateKeyAccount>;
  request: SignedEnvelope;
  acceptance: SignedEnvelope;
  completion: SignedEnvelope;
  feedbackValue: CityFeedback;
  at: (offset: number) => string;
  documentValue: FeedbackDocument;
};

export async function publicationFixture(rpcUrl: string): Promise<Fixture> {
  const transport = http(rpcUrl, { retryCount: 0, timeout: 2_000 });
  const publicClient: PublicClient = createPublicClient({ transport, pollingInterval: 25 });
  const testClient: TestClient = createTestClient({ mode: 'anvil', transport });
  const owner = privateKeyToAccount(generatePrivateKey());
  const runtime = privateKeyToAccount(generatePrivateKey());
  const caller = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  for (const account of [owner, caller, stranger]) await testClient.setBalance({ address: account.address, value: parseEther('100') });
  const ownerWallet: WalletClient<Transport, undefined, PrivateKeyAccount> = createWalletClient({ account: owner, transport });
  const walletClient: WalletClient<Transport, undefined, PrivateKeyAccount> = createWalletClient({ account: caller, transport });
  const identityRegistry = await deployRegistry(publicClient, ownerWallet);
  const reputationRegistry = await deployReputationRegistry(publicClient, ownerWallet, identityRegistry);
  await receipt(publicClient, await ownerWallet.writeContract({ address: identityRegistry, abi: registryAbi, functionName: 'register', chain: null }));
  const record = published({ agentId: '0', owner, city: 'Chicago', cardUrl: 'http://127.0.0.1:39001/card',
    invocationUrl: 'http://127.0.0.1:39001/a2a', revision: 1, cardBytes: new Uint8Array(), agentURI: '' },
  31337, identityRegistry, true, runtime.address);
  const publication = await receipt(publicClient, await ownerWallet.writeContract({ address: identityRegistry,
    abi: registryAbi, functionName: 'setAgentURI', args: [0n, record.agentURI], chain: null }));
  const agent = { chainId: 31337, registry: identityRegistry.toLowerCase() as Address, agentId: '0' };
  const originalProfile = { agent, agentURI: record.agentURI, cardBytes: record.cardBytes };
  const snapshot = await readIdentitySnapshot(publicClient, agent, publication.blockNumber);
  const profile = verifyProfile(originalProfile, snapshot);
  const at = (offset: number) => new Date((snapshot.blockTimestamp + offset) * 1000).toISOString().replace('.000Z', 'Z');
  const base = makeInteractionFixture();
  const requestValue = { ...base.request, service: { method: 'erc8004' as const, agent },
    caller: { method: 'eip155-eoa' as const, chainId: 31337, address: caller.address.toLowerCase() as Address },
    profileBasis: { blockNumber: profile.source.blockNumber, blockHash: profile.source.blockHash,
      agentOwner: profile.source.agentOwner.toLowerCase() as Address, agentUriDigest: profile.source.agentUriDigest,
      registrationDigest: profile.source.registrationDigest, cardDigest: profile.source.cardDigest,
      receiptSigner: runtime.address.toLowerCase() as Address }, createdAt: at(1), deadline: at(60) };
  const acceptanceValue = { ...base.acceptance, requestDigest: encodeStatement(requestValue).digest,
    acceptedAt: at(2), deadline: at(60) };
  const completionValue = { ...base.completion, acceptanceDigest: encodeStatement(acceptanceValue).digest,
    recordedAt: at(30) };
  const request = await signRequest(requestValue, caller);
  const acceptance = await signProviderStatement(acceptanceValue, runtime, profile);
  const completion = await signProviderStatement(completionValue, runtime, profile);
  const feedbackValue: CityFeedback = { kind: 'feedback', version: '0.1', service: requestValue.service,
    reviewer: requestValue.caller, interactionId: requestValue.interactionId,
    requestDigest: encodeStatement(requestValue).digest, acceptanceDigest: encodeStatement(acceptanceValue).digest,
    reputationRegistry: { chainId: 31337, address: reputationRegistry.toLowerCase() as Address },
    rubric: 'evening-plan-usefulness-v0.1', value: 5, createdAt: at(31),
    result: { kind: 'completion', completionDigest: encodeStatement(completionValue).digest } };
  const document = encodeFeedbackDocument(await signFeedback(feedbackValue, caller));
  assert.equal(document.feedback.value.value, 5);
  const feedbackURI = 'http://127.0.0.1:39002/feedback/review.json?version=1';
  const input = { publicClient, walletClient, identityRegistry, reputationRegistry,
    document: document.bytes, feedbackURI, allowedDocumentURL: feedbackURI,
    request, acceptance, completion, originalProfile };
  return { ...input, input, transport, testClient, owner, ownerWallet, caller, stranger,
    feedbackValue, at, documentValue: document };
}
