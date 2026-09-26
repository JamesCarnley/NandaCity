import { isDeepStrictEqual } from 'node:util';
import { decodeEventLog, encodeFunctionData, isAddress, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, TransactionNotFoundError, TransactionReceiptNotFoundError, zeroAddress,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { z } from 'zod';
import { decodeFeedbackDocument } from '../feedback/document.js';
import { FEEDBACK_RUBRIC, LOCAL_FEEDBACK_CHAIN_ID, REPUTATION_REGISTRY_VERSION, reputationRegistryAbi } from '../feedback/registry.js';
import { verifyFeedbackSignature } from '../feedback/signatures.js';
import { verifyHistoricalFeedback } from '../feedback/verify.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type ProfileCandidate } from '../identity/verify.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { assertLocalWriteRpcUrl } from './anvil.js';

const identityAbi = parseAbi([
  'function getVersion() view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)',
]);
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const address = z.custom<Address>((value) => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress);
const hash = z.custom<Hex>((value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value));
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine((v) => BigInt(v) < 1n << 256n);
const index = uint.refine((v) => BigInt(v) > 0n && BigInt(v) < 1n << 64n);
const domainSchema = z.strictObject({ chainId: z.literal(LOCAL_FEEDBACK_CHAIN_ID), identityRegistry: address, reputationRegistry: address });
const eventBasis = { agentId: uint, reviewer: address };
const publicationEventSchema = z.strictObject({ ...eventBasis, eventName: z.literal('NewFeedback'), value: z.number().int().min(1).max(5),
  valueDecimals: z.literal(0), tag1: z.literal(FEEDBACK_RUBRIC), tag2: z.literal(''), endpoint: z.literal(''),
  feedbackURI: z.string(), feedbackHash: hash });
const revocationEventSchema = z.strictObject({ ...eventBasis, eventName: z.literal('FeedbackRevoked'), feedbackIndex: index });
const eventReferenceSchema = z.strictObject({ ...eventBasis, eventName: z.enum(['NewFeedback', 'FeedbackRevoked']), feedbackIndex: index,
  address, transactionHash: hash, blockHash: hash, blockNumber: uint,
  transactionIndex: z.number().int().nonnegative(), logIndex: z.number().int().nonnegative() });
const resultSchema = z.strictObject({
  receipt: z.strictObject({ transactionHash: hash, blockHash: hash, blockNumber: uint,
    transactionIndex: z.number().int().nonnegative(), status: z.literal('success'), gasUsed: uint, effectiveGasPrice: uint }),
  event: eventReferenceSchema, payer: address, gasCostWei: uint,
});
const preparedBase = { version: z.literal('0.1'), rpcUrl: z.string().max(2048), domain: domainSchema, ...eventBasis,
  nonce: z.number().int().safe().nonnegative(), transactionHash: hash,
  rawTransaction: z.custom<`0x02${string}`>((v) => typeof v === 'string' && /^0x02[0-9a-f]+$/.test(v) && v.length <= 100_000) };
const publicationSchema = z.strictObject({ ...preparedBase, action: z.literal('publish'), expectedEvent: publicationEventSchema,
  documentBase64: z.string().max(8192), allowedDocumentURL: z.string().max(2048) });
const revocationSchema = z.strictObject({ ...preparedBase, action: z.literal('revoke'), expectedEvent: revocationEventSchema,
  originalPublication: publicationSchema, publicationResult: resultSchema });
const preparedSchema = z.discriminatedUnion('action', [publicationSchema, revocationSchema]);

export type PreparedFeedbackPublication = z.infer<typeof publicationSchema>;
export type PreparedFeedbackRevocation = z.infer<typeof revocationSchema>;
export type PreparedFeedbackOperation = z.infer<typeof preparedSchema>;
export type FeedbackSubmissionResult = z.infer<typeof resultSchema>;
export type FeedbackEventReference = FeedbackSubmissionResult['event'];
type Clients = { publicClient: PublicClient; walletClient: WalletClient };
type Domain = PreparedFeedbackOperation['domain'];
export type PrepareLocalFeedbackPublicationInput = Clients & {
  identityRegistry: Address;
  reputationRegistry: Address;
  document: Uint8Array;
  feedbackURI: string;
  allowedDocumentURL: string;
  originalProfile: ProfileCandidate;
  request: unknown;
  acceptance?: unknown;
  completion?: unknown;
};
export type PrepareLocalFeedbackRevocationInput = Clients & {
  originalPublication: PreparedFeedbackPublication;
  publicationResult: FeedbackSubmissionResult;
};

const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function localClients({ publicClient, walletClient }: Clients): string {
  const readUrl: unknown = publicClient.transport.type === 'http' ? publicClient.transport.url : undefined;
  const writeUrl: unknown = walletClient.transport.type === 'http' ? walletClient.transport.url : undefined;
  if (typeof readUrl !== 'string' || typeof writeUrl !== 'string') throw new Error('feedback requires loopback HTTP RPC clients');
  assertLocalWriteRpcUrl(readUrl);
  assertLocalWriteRpcUrl(writeUrl);
  if (readUrl !== writeUrl) throw new Error('feedback requires the same loopback RPC for reads and writes');
  if (new URL(readUrl).hash || readUrl.includes('#')) throw new Error('RPC URL must not contain a fragment');
  return readUrl;
}

async function verifyDomain(client: PublicClient, domain: Domain): Promise<void> {
  domainSchema.parse(domain);
  if (await client.getChainId() !== LOCAL_FEEDBACK_CHAIN_ID) throw new Error('feedback requires chain ID 31337');
  for (const registry of [domain.identityRegistry, domain.reputationRegistry]) {
    const code = await client.getCode({ address: registry });
    if (!code || code === '0x') throw new Error('feedback requires deployed Identity and Reputation registries');
  }
  const identity = { address: domain.identityRegistry, abi: identityAbi } as const;
  const reputation = { address: domain.reputationRegistry, abi: reputationRegistryAbi } as const;
  try {
    if (await client.readContract({ ...identity, functionName: 'getVersion' }) !== '2.0.0' ||
      !await client.readContract({ ...identity, functionName: 'supportsInterface', args: ['0x80ac58cd'] })) {
      throw new Error('Identity Registry must be version 2.0.0 and support ERC-721');
    }
    if (await client.readContract({ ...reputation, functionName: 'getVersion' }) !== REPUTATION_REGISTRY_VERSION ||
      !equal(await client.readContract({ ...reputation, functionName: 'getIdentityRegistry' }), domain.identityRegistry)) {
      throw new Error('Reputation Registry version or linked Identity Registry mismatch');
    }
  } catch (error) {
    throw new Error('Reputation/Identity registry domain preflight failed', { cause: error });
  }
}

function validateURI(uri: string, allowed: string): void {
  for (const candidate of [uri, allowed]) {
    if (typeof candidate !== 'string' || !candidate.isWellFormed() || Buffer.byteLength(candidate, 'utf8') > 2048) {
      throw new Error('feedback URI must be well-formed and at most 2048 UTF-8 bytes');
    }
    assertLocalWriteRpcUrl(candidate);
    const parsed = new URL(candidate);
    if (candidate.includes('#') || parsed.hash || parsed.href !== candidate) {
      throw new Error('feedback URI must be an exact URL without fragment or normalization');
    }
  }
  if (uri !== allowed) throw new Error('feedback URI must equal the exact configured document URL');
}

function publicationProjection(document: ReturnType<typeof decodeFeedbackDocument>, feedbackURI: string) {
  return publicationEventSchema.parse({ eventName: 'NewFeedback', agentId: document.feedback.value.service.agent.agentId,
    reviewer: document.feedback.value.reviewer.address, value: document.feedback.value.value, valueDecimals: 0,
    tag1: document.feedback.value.rubric, tag2: '', endpoint: '', feedbackURI, feedbackHash: document.documentHash });
}

function calldata(prepared: Pick<PreparedFeedbackOperation, 'action' | 'expectedEvent'>): Hex {
  const event = prepared.expectedEvent;
  return event.eventName === 'NewFeedback'
    ? encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'giveFeedback', args: [BigInt(event.agentId), BigInt(event.value),
      event.valueDecimals, event.tag1, event.tag2, event.endpoint, event.feedbackURI, event.feedbackHash] })
    : encodeFunctionData({ abi: reputationRegistryAbi, functionName: 'revokeFeedback', args: [BigInt(event.agentId), BigInt(event.feedbackIndex)] });
}

async function signingAccount(clients: Clients, reviewer: Address): Promise<void> {
  const account = clients.walletClient.account;
  if (!account || account.type !== 'local' || !account.signTransaction || !equal(account.address, reviewer)) {
    throw new Error('local EOA sender must equal the feedback signer/reviewer');
  }
  const code = await clients.publicClient.getCode({ address: account.address });
  if (code && code !== '0x') throw new Error('feedback sender must be an undelegated EOA');
}

async function signOperation(clients: Clients, operation: Omit<PreparedFeedbackPublication, 'nonce' | 'transactionHash' | 'rawTransaction'> |
  Omit<PreparedFeedbackRevocation, 'nonce' | 'transactionHash' | 'rawTransaction'>): Promise<PreparedFeedbackOperation> {
  await signingAccount(clients, operation.reviewer);
  const account = clients.walletClient.account!;
  const request = await clients.walletClient.prepareTransactionRequest({ account, chain: null,
    chainId: LOCAL_FEEDBACK_CHAIN_ID, type: 'eip1559', to: operation.domain.reputationRegistry, data: calldata(operation), value: 0n });
  const rawTransaction = await clients.walletClient.signTransaction({ ...request, account, chain: null });
  return preparedSchema.parse({ ...operation, nonce: request.nonce, rawTransaction, transactionHash: keccak256(rawTransaction) });
}

/** Pure signed evidence plus RPC-derived original profile authority. No document/provider fetching. */
export async function prepareLocalFeedbackPublication(input: PrepareLocalFeedbackPublicationInput): Promise<PreparedFeedbackPublication> {
  const rpcUrl = localClients(input);
  validateURI(input.feedbackURI, input.allowedDocumentURL);
  const document = decodeFeedbackDocument(input.document);
  const domain = domainSchema.parse({ chainId: LOCAL_FEEDBACK_CHAIN_ID,
    identityRegistry: input.identityRegistry, reputationRegistry: input.reputationRegistry });
  await verifyDomain(input.publicClient, domain);
  const value = document.feedback.value;
  if (value.service.agent.chainId !== domain.chainId || !equal(value.service.agent.registry, domain.identityRegistry)) {
    throw new Error('feedback Identity registry domain mismatch');
  }
  await signingAccount(input, value.reviewer.address as Address);
  const request = decodeEnvelope(input.request).statement.value;
  if (request.kind !== 'request') throw new Error('expected signed request evidence');
  const basis = await readIdentitySnapshot(input.publicClient, value.service.agent as ProfileCandidate['agent'], BigInt(request.profileBasis.blockNumber));
  const profile = verifyProfile(input.originalProfile, basis);
  const finding = await verifyHistoricalFeedback({ feedback: document.envelope, request: input.request,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    ...(input.completion === undefined ? {} : { completion: input.completion }),
    basisProfile: profile, expectedReputationRegistry: { chainId: domain.chainId, address: domain.reputationRegistry } });
  const required = {
    feedbackSignature: 'valid', requestSignature: 'valid', acceptanceSignature: 'valid', reviewerBinding: 'matched',
    requestCallerBinding: 'matched', serviceLink: 'matched', registryDomain: 'matched', requestLink: 'matched',
    acceptanceLink: 'matched', originalProfileBasis: 'matched', acceptanceSignerBinding: 'matched', claimedTime: 'consistent',
  } as const;
  for (const [key, expected] of Object.entries(required)) {
    if (finding[key as keyof typeof required] !== expected) throw new Error(`feedback evidence refused: ${key}=${finding[key as keyof typeof required]}`);
  }
  if (input.completion !== undefined && (finding.completionSignature !== 'valid' || finding.completionLink !== 'matched' || finding.completionSignerBinding !== 'matched')) {
    throw new Error('feedback evidence refused: supplied completion signature/link/signer');
  }
  if (finding.resultEvidence !== (value.result.kind === 'completion' ? 'matched' : 'post-deadline-reviewer-claim')) {
    throw new Error(`feedback evidence refused: resultEvidence=${finding.resultEvidence}`);
  }
  if (await input.publicClient.readContract({ address: domain.identityRegistry, abi: identityAbi,
    functionName: 'isAuthorizedOrOwner', args: [value.reviewer.address as Address, BigInt(value.service.agent.agentId)] })) {
    throw new Error('self-feedback from a current owner or authorized operator is not allowed');
  }
  const prepared = await signOperation(input, { version: '0.1', action: 'publish', rpcUrl, domain,
    reviewer: value.reviewer.address as Address, agentId: value.service.agent.agentId,
    expectedEvent: publicationProjection(document, input.feedbackURI),
    documentBase64: Buffer.from(document.bytes).toString('base64'), allowedDocumentURL: input.allowedDocumentURL });
  return publicationSchema.parse(prepared);
}

async function validatePrepared(clients: Clients, raw: unknown): Promise<PreparedFeedbackOperation> {
  const prepared = preparedSchema.parse(raw);
  const rpcUrl = localClients(clients);
  if (rpcUrl !== prepared.rpcUrl) throw new Error('prepared RPC domain does not match selected clients');
  if (keccak256(prepared.rawTransaction) !== prepared.transactionHash) throw new Error('prepared raw transaction hash mismatch');
  const transaction = parseTransaction(prepared.rawTransaction);
  if (!transaction.r || !transaction.s || BigInt(transaction.r) <= 0n || BigInt(transaction.r) >= SECP256K1_ORDER ||
    BigInt(transaction.s) <= 0n || BigInt(transaction.s) > SECP256K1_ORDER / 2n ||
    (transaction.yParity !== 0 && transaction.yParity !== 1)) {
    throw new Error('prepared transaction requires a canonical low-s ECDSA signature');
  }
  if (transaction.type !== 'eip1559' || transaction.chainId !== prepared.domain.chainId ||
    !transaction.to || !equal(transaction.to, prepared.domain.reputationRegistry) || (transaction.value ?? 0n) !== 0n ||
    transaction.nonce !== prepared.nonce || transaction.data !== calldata(prepared) ||
    !equal(await recoverTransactionAddress({ serializedTransaction: prepared.rawTransaction }), prepared.reviewer)) {
    throw new Error('prepared signed transaction sender/domain/nonce/calldata mismatch');
  }
  if (!equal(prepared.expectedEvent.reviewer, prepared.reviewer) || prepared.expectedEvent.agentId !== prepared.agentId) {
    throw new Error('prepared event projection attribution mismatch');
  }
  if (prepared.action === 'publish') {
    const documentBytes = Buffer.from(prepared.documentBase64, 'base64');
    if (documentBytes.toString('base64') !== prepared.documentBase64) throw new Error('prepared document must be canonical Base64');
    const document = decodeFeedbackDocument(documentBytes);
    validateURI(prepared.expectedEvent.feedbackURI, prepared.allowedDocumentURL);
    if (!isDeepStrictEqual(publicationProjection(document, prepared.expectedEvent.feedbackURI), prepared.expectedEvent) ||
      !equal(document.envelope.signer.address, prepared.reviewer) ||
      document.feedback.value.service.agent.chainId !== prepared.domain.chainId ||
      !equal(document.feedback.value.service.agent.registry, prepared.domain.identityRegistry) ||
      !equal(document.feedback.value.reputationRegistry.address, prepared.domain.reputationRegistry) ||
      (await verifyFeedbackSignature(document.envelope, prepared.domain.chainId)).status !== 'valid') {
      throw new Error('prepared document signature/domain/event projection mismatch');
    }
  } else {
    const original = await validatePrepared(clients, prepared.originalPublication);
    if (original.action !== 'publish' || !isDeepStrictEqual(prepared.domain, original.domain) ||
      !equal(prepared.reviewer, original.reviewer) || prepared.agentId !== original.agentId ||
      prepared.expectedEvent.feedbackIndex !== prepared.publicationResult.event.feedbackIndex) {
      throw new Error('prepared revocation does not match original publication');
    }
    const originalReceipt = await clients.publicClient.getTransactionReceipt({ hash: original.transactionHash });
    if (!isDeepStrictEqual(receiptResult(original, originalReceipt), prepared.publicationResult)) {
      throw new Error('original publication receipt/event attribution mismatch');
    }
  }
  await verifyDomain(clients.publicClient, prepared.domain);
  return prepared;
}

function receiptResult(prepared: PreparedFeedbackOperation, receipt: TransactionReceipt): FeedbackSubmissionResult {
  if (receipt.transactionHash !== prepared.transactionHash || !equal(receipt.from, prepared.reviewer) ||
    !receipt.to || !equal(receipt.to, prepared.domain.reputationRegistry)) throw new Error('receipt does not match prepared transaction');
  if (receipt.status !== 'success') throw new Error('prepared feedback transaction reverted; no new transaction was signed');
  const matching = receipt.logs.flatMap((log) => {
    if (!equal(log.address, prepared.domain.reputationRegistry)) return [];
    try {
      const decoded = decodeEventLog({ abi: reputationRegistryAbi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName !== prepared.expectedEvent.eventName) return [];
      const args = decoded.args;
      const common = { eventName: decoded.eventName, agentId: args.agentId.toString(), reviewer: args.clientAddress.toLowerCase() as Address };
      const projection = decoded.eventName === 'NewFeedback' ? { ...common, value: Number(decoded.args.value),
        valueDecimals: decoded.args.valueDecimals, tag1: decoded.args.tag1, tag2: decoded.args.tag2,
        endpoint: decoded.args.endpoint, feedbackURI: decoded.args.feedbackURI, feedbackHash: decoded.args.feedbackHash }
        : { ...common, feedbackIndex: args.feedbackIndex.toString() };
      if (!isDeepStrictEqual(projection, prepared.expectedEvent)) return [];
      if (decoded.eventName === 'NewFeedback' && decoded.args.indexedTag1 !== keccak256(new TextEncoder().encode(FEEDBACK_RUBRIC))) return [];
      return [{ ...common, feedbackIndex: args.feedbackIndex.toString(), address: log.address,
        transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(),
        transactionIndex: receipt.transactionIndex, logIndex: log.logIndex }];
    } catch { return []; }
  });
  if (matching.length !== 1) throw new Error('receipt must contain one exact expected feedback event');
  return resultSchema.parse({ receipt: { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(), transactionIndex: receipt.transactionIndex, status: receipt.status,
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() },
  event: matching[0], payer: receipt.from, gasCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
}

export class FeedbackSubmissionUnresolvedError extends Error {
  constructor(public readonly transactionHash: Hex, public readonly reason: 'nonce-replacement-unresolved' | 'receipt-unresolved') {
    super(`feedback submission unresolved: ${reason}; retain and reconcile the original prepared transaction ${transactionHash}`);
  }
}

async function existingReceipt(client: PublicClient, hash: Hex): Promise<TransactionReceipt | null> {
  try { return await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
}

async function nonceIsOccupied(client: PublicClient, prepared: PreparedFeedbackOperation): Promise<boolean> {
  const request = { address: prepared.reviewer };
  if (await client.getTransactionCount({ ...request, blockTag: 'latest' }) > prepared.nonce) return true;
  if (await client.getTransactionCount({ ...request, blockTag: 'pending' }) <= prepared.nonce) return false;
  try { await client.getTransaction({ hash: prepared.transactionHash }); return false; }
  catch (error) { if (error instanceof TransactionNotFoundError) return true; throw error; }
}

/** Broadcast only these exact signed bytes. A signing account is neither needed nor consulted. */
export async function submitPreparedFeedback(input: Clients & { prepared: PreparedFeedbackOperation }): Promise<FeedbackSubmissionResult> {
  const prepared = await validatePrepared(input, input.prepared);
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await existingReceipt(input.publicClient, prepared.transactionHash);
    if (found) return receiptResult(prepared, found);
    if (await nonceIsOccupied(input.publicClient, prepared)) {
      // Recheck after the nonce read to avoid racing the original transaction's mining.
      const raced = await existingReceipt(input.publicClient, prepared.transactionHash);
      if (raced) return receiptResult(prepared, raced);
      throw new FeedbackSubmissionUnresolvedError(prepared.transactionHash, 'nonce-replacement-unresolved');
    }
    try {
      const returnedHash = await input.walletClient.sendRawTransaction({ serializedTransaction: prepared.rawTransaction });
      if (returnedHash !== prepared.transactionHash) throw new Error('RPC returned a different transaction hash');
    } catch {
      // A lost reply is not proof of failed broadcast. Only the same bytes can be retried.
    }
    for (let poll = 0; poll < 20; poll++) {
      const mined = await existingReceipt(input.publicClient, prepared.transactionHash);
      if (mined) return receiptResult(prepared, mined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const found = await existingReceipt(input.publicClient, prepared.transactionHash);
  if (found) return receiptResult(prepared, found);
  const occupied = await nonceIsOccupied(input.publicClient, prepared);
  throw new FeedbackSubmissionUnresolvedError(prepared.transactionHash,
    occupied ? 'nonce-replacement-unresolved' : 'receipt-unresolved');
}

/** Original document/receipt are retained; revocation changes only the original reviewer's named index. */
export async function prepareLocalFeedbackRevocation(input: PrepareLocalFeedbackRevocationInput): Promise<PreparedFeedbackRevocation> {
  const original = publicationSchema.parse(await validatePrepared(input, input.originalPublication));
  await signingAccount(input, original.reviewer);
  const mined = await input.publicClient.getTransactionReceipt({ hash: original.transactionHash });
  const publicationResult = receiptResult(original, mined);
  if (!isDeepStrictEqual(publicationResult, resultSchema.parse(input.publicationResult))) {
    throw new Error('original publication receipt/event attribution mismatch');
  }
  const feedbackIndex = publicationResult.event.feedbackIndex;
  const record = await input.publicClient.readContract({ address: original.domain.reputationRegistry, abi: reputationRegistryAbi,
    functionName: 'readFeedback', args: [BigInt(original.agentId), original.reviewer, BigInt(feedbackIndex)] });
  const expected = original.expectedEvent;
  if (record[0] !== BigInt(expected.value) || record[1] !== 0 || record[2] !== expected.tag1 || record[3] !== '' || record[4]) {
    throw new Error('original feedback record mismatch or already revoked; reuse an existing prepared revocation for recovery');
  }
  return revocationSchema.parse(await signOperation(input, { version: '0.1', action: 'revoke', rpcUrl: original.rpcUrl,
    domain: original.domain, reviewer: original.reviewer, agentId: original.agentId,
    expectedEvent: { eventName: 'FeedbackRevoked', agentId: original.agentId, reviewer: original.reviewer, feedbackIndex },
    originalPublication: original, publicationResult }));
}
