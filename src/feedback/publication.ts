import { decodeEventLog, isAddress, keccak256, parseAbi, zeroAddress,
  type Address, type Hex, type PublicClient } from 'viem';
import { decodeFeedbackDocument, type FeedbackDocument } from './document.js';
import { REPUTATION_REGISTRY_VERSION, reputationRegistryAbi } from './registry.js';
import { verifyFeedbackSignature, type FeedbackCryptoFinding } from './signatures.js';

export type FeedbackPublicationDomain = {
  chainId: number;
  identityRegistry: Address;
  reputationRegistry: Address;
  /** Hash of numbered block zero on the selected chain. */
  genesisHash: Hex;
};

/** Coordinates and URI are expectations, not authority supplied by a writer or Index. */
export type FeedbackPublicationReference = {
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  /** The envelope does not contain a URI. Compare this exact caller-selected URI to the event. */
  feedbackURI: string;
};

export type ReadFeedbackPublicationInput = {
  client: PublicClient;
  domain: FeedbackPublicationDomain;
  eventRef: FeedbackPublicationReference;
  documentBytes: Uint8Array | null;
  /** Required numbered observation; no implicit latest-head read. */
  observationBlock: bigint;
};

type BlockBasis = { blockNumber: string; blockHash: Hex; blockTimestamp: string };
export type FeedbackPublicationObservation = {
  publication: 'matched' | 'mismatched' | 'orphaned' | 'unavailable';
  /** State of the authenticated event's registry tuple at observation, not a signature finding. */
  revocation: 'active' | 'revoked' | 'unknown';
  qualification: 'rpc-derived-not-state-proof';
  domain: FeedbackPublicationDomain;
  eventRef: FeedbackPublicationReference;
  observationBlock: string;
  observation?: BlockBasis;
  source?: BlockBasis & { transactionHash: Hex; transactionIndex: number; logIndex: number };
  event?: {
    address: Address; agentId: string; reviewer: Address; feedbackIndex: string;
    value: string; valueDecimals: number; tag1: string; tag2: string; endpoint: string;
    feedbackURI: string; feedbackHash: Hex;
  };
  storage?: { value: string; valueDecimals: number; tag1: string; tag2: string; isRevoked: boolean };
  document: {
    decoding: 'valid' | 'invalid' | 'unavailable';
    signature: FeedbackCryptoFinding['status'] | 'unavailable';
    reviewerBinding: 'matched' | 'mismatched' | 'unavailable';
    /** Available only after strict bounded decoding. No document URI is fetched. */
    bytesBase64?: string;
    documentHash?: Hex;
    feedbackDigest?: Hex;
    envelope?: FeedbackDocument['envelope'];
    feedback?: FeedbackDocument['feedback']['value'];
  };
  claimedFeedbackTime: 'not-after-publication' | 'after-publication' | 'unavailable';
  historicalExistence: 'unknown';
  historicalOrdering: 'unknown';
  diagnostics: string[];
};

const identityAbi = parseAbi([
  'function getVersion() view returns (string)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

function validateInput(input: ReadFeedbackPublicationInput): void {
  const { domain, eventRef, observationBlock } = input;
  if (typeof observationBlock !== 'bigint' || observationBlock < 0n || observationBlock >= 1n << 256n) {
    throw new Error('observationBlock must be an explicit nonnegative numbered block');
  }
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 || !isHash(domain.genesisHash) ||
    ![domain.identityRegistry, domain.reputationRegistry].every((a) => isAddress(a) && !same(a, zeroAddress))) {
    throw new Error('invalid feedback publication domain');
  }
  if (typeof eventRef.blockNumber !== 'string' || !/^(0|[1-9][0-9]*)$/.test(eventRef.blockNumber) ||
    eventRef.blockNumber.length > 78 || BigInt(eventRef.blockNumber) >= 1n << 256n ||
    !isHash(eventRef.blockHash) || !isHash(eventRef.transactionHash) ||
    ![eventRef.transactionIndex, eventRef.logIndex].every((i) => Number.isSafeInteger(i) && i >= 0) ||
    typeof eventRef.feedbackURI !== 'string' || !eventRef.feedbackURI.isWellFormed() ||
    Buffer.byteLength(eventRef.feedbackURI, 'utf8') > 2048) throw new Error('invalid feedback event reference');
}

/**
 * Independent, read-only RPC observation. It authenticates a receipt and its exact
 * NewFeedback log, compares the supplied document, and reads registry state at an
 * explicit block. It neither imports writer authority nor upgrades claimed history.
 * Clients must configure bounded transport timeouts/retries; this reader adds none.
 */
export async function readFeedbackPublication(input: ReadFeedbackPublicationInput): Promise<FeedbackPublicationObservation> {
  validateInput(input);
  const { client, observationBlock } = input;
  const domain = { ...input.domain };
  const { blockNumber, blockHash, transactionHash, transactionIndex, logIndex, feedbackURI } = input.eventRef;
  const eventRef = { blockNumber, blockHash, transactionHash, transactionIndex, logIndex, feedbackURI };
  const publicationBlock = BigInt(blockNumber);
  const result: FeedbackPublicationObservation = {
    publication: 'unavailable', revocation: 'unknown', qualification: 'rpc-derived-not-state-proof',
    domain, eventRef, observationBlock: observationBlock.toString(),
    document: { decoding: 'unavailable', signature: 'unavailable', reviewerBinding: 'unavailable' },
    claimedFeedbackTime: 'unavailable', historicalExistence: 'unknown', historicalOrdering: 'unknown', diagnostics: [],
  };
  const note = (code: string) => { if (!result.diagnostics.includes(code)) result.diagnostics.push(code); };
  const mismatch = (code: string) => { result.publication = 'mismatched'; note(code); };
  let document: FeedbackDocument | undefined;
  if (input.documentBytes === null) note('document-unavailable');
  else {
    try {
      document = decodeFeedbackDocument(input.documentBytes);
      const signature = await verifyFeedbackSignature(document.envelope, document.feedback.value.service.agent.chainId);
      result.document = { decoding: 'valid', signature: signature.status,
        reviewerBinding: same(document.envelope.signer.address, document.feedback.value.reviewer.address) &&
          document.envelope.signer.chainId === document.feedback.value.reviewer.chainId ? 'matched' : 'mismatched',
        bytesBase64: Buffer.from(document.bytes).toString('base64'), documentHash: document.documentHash,
        feedbackDigest: document.feedback.digest, envelope: document.envelope, feedback: document.feedback.value };
    } catch { result.document.decoding = 'invalid'; mismatch('document-invalid'); }
  }

  let phase = 'chain';
  let publicationBasis: BlockBasis | undefined;
  const read = async (): Promise<void> => {
    if (await client.getChainId() !== domain.chainId) { mismatch('chain-id-mismatch'); return; }
    phase = 'genesis';
    const genesis = await client.getBlock({ blockNumber: 0n });
    if (genesis.number !== 0n || !genesis.hash) { note('genesis-unavailable'); return; }
    if (!same(genesis.hash, domain.genesisHash)) { mismatch('genesis-hash-mismatch'); return; }
    phase = 'observation';
    const observation = await client.getBlock({ blockNumber: observationBlock });
    if (observation.number !== observationBlock || !observation.hash) { note('observation-unavailable'); return; }
    result.observation = { blockNumber: observation.number.toString(), blockHash: observation.hash,
      blockTimestamp: observation.timestamp.toString() };
    if (publicationBlock > observationBlock) { mismatch('publication-after-observation'); return; }
    phase = 'publication-block';
    const source = await client.getBlock({ blockNumber: publicationBlock });
    if (source.number !== publicationBlock || !source.hash) { note('publication-block-unavailable'); return; }
    if (!same(source.hash, blockHash)) { result.publication = 'orphaned'; note('publication-block-orphaned'); return; }
    publicationBasis = { blockNumber, blockHash: source.hash, blockTimestamp: source.timestamp.toString() };

    phase = 'receipt';
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success' || !same(receipt.transactionHash, transactionHash) ||
      receipt.blockNumber !== publicationBlock || !same(receipt.blockHash, blockHash) ||
      receipt.transactionIndex !== transactionIndex || !receipt.to || !same(receipt.to, domain.reputationRegistry)) {
      mismatch('receipt-mismatch'); return;
    }
    const logs = receipt.logs.filter((log) => log.logIndex === logIndex);
    const log = logs[0];
    if (logs.length !== 1 || !log || log.removed || !same(log.address, domain.reputationRegistry) ||
      log.blockNumber !== publicationBlock || !log.blockHash || !same(log.blockHash, blockHash) ||
      !log.transactionHash || !same(log.transactionHash, transactionHash) || log.transactionIndex !== transactionIndex) {
      mismatch('event-coordinate-mismatch'); return;
    }
    let decoded;
    try { decoded = decodeEventLog({ abi: reputationRegistryAbi, data: log.data, topics: log.topics, strict: true }); }
    catch { mismatch('event-decode-mismatch'); return; }
    if (decoded.eventName !== 'NewFeedback') { mismatch('event-kind-mismatch'); return; }
    const args = decoded.args;
    if (!same(receipt.from, args.clientAddress) || args.feedbackIndex === 0n ||
      args.indexedTag1 !== keccak256(new TextEncoder().encode(args.tag1))) {
      mismatch('event-attribution-mismatch'); return;
    }
    result.source = { ...publicationBasis, transactionHash: receipt.transactionHash,
      transactionIndex: receipt.transactionIndex, logIndex: log.logIndex! };
    if (document) result.claimedFeedbackTime = BigInt(Date.parse(document.feedback.value.createdAt) / 1000) > source.timestamp
      ? 'after-publication' : 'not-after-publication';
    result.event = { address: log.address, agentId: args.agentId.toString(), reviewer: args.clientAddress.toLowerCase() as Address,
      feedbackIndex: args.feedbackIndex.toString(), value: args.value.toString(), valueDecimals: args.valueDecimals,
      tag1: args.tag1, tag2: args.tag2, endpoint: args.endpoint, feedbackURI: args.feedbackURI, feedbackHash: args.feedbackHash };
    if (args.feedbackURI !== feedbackURI) mismatch('event-uri-mismatch');

    if (document) {
      const value = document.feedback.value;
      if (value.service.agent.chainId !== domain.chainId || !same(value.service.agent.registry, domain.identityRegistry) ||
        value.reputationRegistry.chainId !== domain.chainId || !same(value.reputationRegistry.address, domain.reputationRegistry)) {
        mismatch('document-domain-mismatch'); return;
      }
      if (!same(args.feedbackHash, document.documentHash)) mismatch('document-hash-mismatch');
      if (args.agentId.toString() !== value.service.agent.agentId) mismatch('event-agent-mismatch');
      if (!same(args.clientAddress, value.reviewer.address)) mismatch('event-reviewer-mismatch');
      if (args.value !== BigInt(value.value)) mismatch('event-value-mismatch');
      if (args.valueDecimals !== 0) mismatch('event-decimals-mismatch');
      if (args.tag1 !== value.rubric) mismatch('event-tag1-mismatch');
      if (args.tag2 !== '') mismatch('event-tag2-mismatch');
      if (args.endpoint !== '') mismatch('event-endpoint-mismatch');
    }

    phase = 'registry-domain';
    const reputation = { address: domain.reputationRegistry, abi: reputationRegistryAbi, blockNumber: observationBlock } as const;
    const linkedIdentity = await client.readContract({ ...reputation, functionName: 'getIdentityRegistry' });
    if (!same(linkedIdentity, domain.identityRegistry)) { mismatch('linked-identity-mismatch'); return; }
    if (await client.readContract({ ...reputation, functionName: 'getVersion' }) !== REPUTATION_REGISTRY_VERSION) {
      mismatch('reputation-version-mismatch'); return;
    }
    const identity = { address: domain.identityRegistry, abi: identityAbi, blockNumber: observationBlock } as const;
    if (await client.readContract({ ...identity, functionName: 'getVersion' }) !== '2.0.0' ||
      !await client.readContract({ ...identity, functionName: 'supportsInterface', args: ['0x80ac58cd'] })) {
      mismatch('identity-version-mismatch'); return;
    }
    phase = 'storage';
    const lastIndex = await client.readContract({ ...reputation, functionName: 'getLastIndex', args: [args.agentId, args.clientAddress] });
    if (args.feedbackIndex > lastIndex) { mismatch('stored-index-mismatch'); return; }
    const [value, valueDecimals, tag1, tag2, isRevoked] = await client.readContract({ ...reputation, functionName: 'readFeedback',
      args: [args.agentId, args.clientAddress, args.feedbackIndex] });
    result.storage = { value: value.toString(), valueDecimals, tag1, tag2, isRevoked };
    if (value !== args.value || valueDecimals !== args.valueDecimals || tag1 !== args.tag1 || tag2 !== args.tag2) {
      mismatch('stored-projection-mismatch'); return;
    }
    result.revocation = isRevoked ? 'revoked' : 'active';
    if (document && result.publication !== 'mismatched') result.publication = 'matched';
  };

  try { await read(); }
  catch {
    result.publication = 'unavailable'; result.revocation = 'unknown'; note(`${phase}-unavailable`);
  }

  // Both numbered bases must still name the same hashes when all other reads finish.
  // This checks RPC consistency, not finality or a cryptographic state proof.
  if (publicationBasis) {
    try {
      const checked = await client.getBlock({ blockNumber: publicationBlock });
      if (checked.number !== publicationBlock || !checked.hash || !same(checked.hash, blockHash)) {
        result.publication = 'orphaned'; result.revocation = 'unknown'; note('publication-block-orphaned');
      }
    } catch {
      result.publication = 'unavailable'; result.revocation = 'unknown'; note('publication-recheck-unavailable');
    }
  }
  if (result.observation) {
    try {
      const checked = await client.getBlock({ blockNumber: observationBlock });
      if (checked.number !== observationBlock || !checked.hash || !same(checked.hash, result.observation.blockHash)) {
        if (result.publication !== 'orphaned') result.publication = 'unavailable';
        result.revocation = 'unknown'; note('observation-basis-changed');
      }
    } catch {
      if (result.publication !== 'orphaned') result.publication = 'unavailable';
      result.revocation = 'unknown'; note('observation-recheck-unavailable');
    }
  }
  return result;
}
