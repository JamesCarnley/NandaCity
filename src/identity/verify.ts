import { isAddress } from 'viem';

import {
  decodeCard,
  decodeRegistration,
  digestBytes,
  registrationBytes,
  type AgentCard,
  type Registration,
} from './profile.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const textEncoder = new TextEncoder();

export type AgentRef = {
  chainId: number;
  registry: `0x${string}`;
  agentId: string;
};

export type AuthoritySnapshot = {
  agent: AgentRef;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: number;
  agentOwner: `0x${string}`;
  agentURI: string;
};

export type ProfileCandidate = {
  agent: AgentRef;
  agentURI: string;
  cardBytes: Uint8Array;
};

export type VerifiedProfile = {
  agent: AgentRef;
  registration: Registration;
  card: AgentCard;
  source: {
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTimestamp: number;
    agentOwner: `0x${string}`;
    agentUriDigest: `0x${string}`;
    registrationDigest: `0x${string}`;
    cardDigest: `0x${string}`;
  };
};

function assertCanonicalUint(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  if (value.length > 78) {
    throw new Error(`${label} must contain at most 78 digits`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  if (BigInt(value) > MAX_UINT256) {
    throw new Error(`${label} must fit in uint256`);
  }
}

function assertNonZeroAddress(
  value: unknown,
  label: string,
): asserts value is `0x${string}` {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: true }) ||
    value.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error(`${label} must be a non-zero Ethereum address`);
  }
}

function assertAgentRef(value: AgentRef, label: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be an agent reference`);
  }
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
    throw new Error(`${label}.chainId must be a positive safe integer`);
  }
  assertNonZeroAddress(value.registry, `${label}.registry`);
  assertCanonicalUint(value.agentId, `${label}.agentId`);
}

function assertSameAgent(candidate: AgentRef, basis: AgentRef): void {
  if (
    candidate.chainId !== basis.chainId ||
    candidate.registry.toLowerCase() !== basis.registry.toLowerCase() ||
    candidate.agentId !== basis.agentId
  ) {
    throw new Error('candidate agent does not match the authority snapshot agent');
  }
}

function assertSnapshot(basis: AuthoritySnapshot): void {
  assertAgentRef(basis.agent, 'basis.agent');
  assertCanonicalUint(basis.blockNumber, 'blockNumber');
  if (!/^0x[0-9a-fA-F]{64}$/.test(basis.blockHash)) {
    throw new Error('blockHash must be a 32-byte hexadecimal value');
  }
  if (!Number.isSafeInteger(basis.blockTimestamp) || basis.blockTimestamp < 0) {
    throw new Error('blockTimestamp must be a nonnegative safe integer');
  }
  assertNonZeroAddress(basis.agentOwner, 'agentOwner');
  if (typeof basis.agentURI !== 'string' || !basis.agentURI.isWellFormed()) {
    throw new Error('agentURI must be a well-formed string');
  }
}

/**
 * Verifies a profile only against the supplied immutable authority snapshot.
 * This performs no network or chain I/O and makes no current-safety assertion.
 */
export function verifyProfile(
  candidate: ProfileCandidate,
  basis: AuthoritySnapshot,
): VerifiedProfile {
  assertSnapshot(basis);
  assertAgentRef(candidate.agent, 'candidate.agent');
  assertSameAgent(candidate.agent, basis.agent);

  if (typeof candidate.agentURI !== 'string' || !candidate.agentURI.isWellFormed()) {
    throw new Error('candidate agentURI must be a well-formed string');
  }
  if (candidate.agentURI !== basis.agentURI) {
    throw new Error('candidate agentURI does not exactly match the authority snapshot agentURI');
  }
  if (!(candidate.cardBytes instanceof Uint8Array)) {
    throw new TypeError('candidate cardBytes must be a Uint8Array');
  }

  const registrationRawBytes = registrationBytes(candidate.agentURI);
  const registration = decodeRegistration(candidate.agentURI);
  const qualifier =
    `eip155:${candidate.agent.chainId}:${candidate.agent.registry}`.toLowerCase();
  const hasMatchingRegistration = registration.registrations.some(
    (entry) =>
      entry.agentId === candidate.agent.agentId &&
      entry.agentRegistry.toLowerCase() === qualifier,
  );
  if (!hasMatchingRegistration) {
    throw new Error('profile does not contain a matching registration for this agent');
  }

  const extension = registration['x-nandacity'];
  if (extension.ownerAtPublication.toLowerCase() !== basis.agentOwner.toLowerCase()) {
    throw new Error('ownerAtPublication does not match the agent owner at the source block');
  }

  const card = decodeCard(candidate.cardBytes);
  const computedCardDigest = digestBytes(candidate.cardBytes);
  if (computedCardDigest.toLowerCase() !== extension.cardDigest.toLowerCase()) {
    throw new Error('card bytes do not match the owner-published cardDigest');
  }
  if (card.url !== extension.endpoint) {
    throw new Error('card URL does not exactly match the owner-published endpoint');
  }

  return {
    agent: { ...candidate.agent },
    registration,
    card,
    source: {
      blockNumber: basis.blockNumber,
      blockHash: basis.blockHash,
      blockTimestamp: basis.blockTimestamp,
      agentOwner: basis.agentOwner,
      agentUriDigest: digestBytes(textEncoder.encode(candidate.agentURI)),
      registrationDigest: digestBytes(registrationRawBytes),
      cardDigest: computedCardDigest,
    },
  };
}
