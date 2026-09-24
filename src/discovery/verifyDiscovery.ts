import type { PublicClient } from 'viem';

import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AgentRef, type AuthoritySnapshot, type VerifiedProfile } from '../identity/verify.js';

export type BlockRef = { number: string; hash: `0x${string}`; timestamp: number };
export type ServiceFilter = { capabilityIds?: string[]; areaServed?: string[]; interfaces?: string[] };
export type ServiceDeclaration = {
  identifier: string; displayName: string; type: string; url: string;
  description: string | null; capabilityIds: string[]; areaServed: string[];
  interfaces: string[];
};
export type DiscoveredCandidate = {
  observerOrigin: string; agent: AgentRef; agentURI: string;
  declaration: ServiceDeclaration; observationBlock: BlockRef;
};
export type DiscoveryVerification =
  | { status: 'verified'; profile: VerifiedProfile; observerOrigin: string }
  | { status: 'rejected'; reason: string; observerOrigin: string }
  | { status: 'unavailable'; reason: string; observerOrigin: string };

function normalized(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function expectedDeclaration(profile: VerifiedProfile): ServiceDeclaration {
  const registration = profile.registration;
  const service = registration.services.find((item) => item.name === 'A2A')!;
  return {
    identifier: `eip155:${profile.agent.chainId}/erc721:${profile.agent.registry.toLowerCase()}/${profile.agent.agentId}`,
    displayName: registration.name,
    type: 'application/agent-card+json',
    url: service.endpoint,
    description: registration.description,
    capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
    areaServed: normalized(registration['x-nandacity'].areaServed.map((area) => area['@id'])),
    interfaces: ['application/a2a+json;version=0.3'],
  };
}

function matchesFilter(declaration: ServiceDeclaration, filter: ServiceFilter): boolean {
  return (['capabilityIds', 'areaServed', 'interfaces'] as const).every((key) =>
    filter[key] === undefined || filter[key]!.some((value) => declaration[key].includes(value)));
}

/** Purely verifies Index-supplied metadata against a caller-supplied chain basis and exact card bytes. */
export function verifyDiscovery(candidate: DiscoveredCandidate, basis: AuthoritySnapshot,
  cardBytes: Uint8Array, filter: ServiceFilter): DiscoveryVerification {
  const reject = (reason: string): DiscoveryVerification => ({
    status: 'rejected', reason, observerOrigin: candidate.observerOrigin,
  });
  try {
    if (!/^(0|[1-9][0-9]*)$/.test(candidate.observationBlock.number) ||
      BigInt(candidate.observationBlock.number) > BigInt(basis.blockNumber)) {
      return reject('observation block is later than authority basis');
    }
    if (candidate.observationBlock.number === basis.blockNumber &&
      (candidate.observationBlock.hash !== basis.blockHash ||
        candidate.observationBlock.timestamp !== basis.blockTimestamp)) {
      return reject('observation block differs from authority basis');
    }
    const profile = verifyProfile({ agent: candidate.agent, agentURI: candidate.agentURI, cardBytes }, basis);
    if (!profile.registration.active) return reject('registration is inactive');
    const expected = expectedDeclaration(profile);
    for (const key of ['identifier', 'displayName', 'type', 'url', 'description',
      'capabilityIds', 'areaServed', 'interfaces'] as const) {
      if (JSON.stringify(candidate.declaration[key]) !== JSON.stringify(expected[key])) {
        return reject(`declaration ${key} does not match independently verified registration`);
      }
    }
    if (!matchesFilter(expected, filter)) return reject('declaration does not match requested filter');
    return { status: 'verified', profile, observerOrigin: candidate.observerOrigin };
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'profile verification failed');
  }
}

/** Separately configured RPC is needed for current-state evidence; failures are unavailable, not rejected. */
export async function verifyDiscoveryAtCurrentChain(candidate: DiscoveredCandidate,
  chainClient: PublicClient, cardBytes: Uint8Array, filter: ServiceFilter): Promise<DiscoveryVerification> {
  let basis: AuthoritySnapshot;
  let observedBlock: Awaited<ReturnType<PublicClient['getBlock']>>;
  try {
    observedBlock = await chainClient.getBlock({ blockNumber: BigInt(candidate.observationBlock.number) });
    basis = await readIdentitySnapshot(chainClient, candidate.agent);
  }
  catch { return { status: 'unavailable', reason: 'independent chain read failed',
    observerOrigin: candidate.observerOrigin }; }
  if (observedBlock.hash?.toLowerCase() !== candidate.observationBlock.hash.toLowerCase() ||
    Number(observedBlock.timestamp) !== candidate.observationBlock.timestamp) {
    return { status: 'rejected', reason: 'observation block differs from canonical chain',
      observerOrigin: candidate.observerOrigin };
  }
  return verifyDiscovery(candidate, basis, cardBytes, filter);
}

/** Transport failures remain unavailable; the caller supplies an explicitly scoped card reader. */
export async function verifyDiscoveryWithCard(candidate: DiscoveredCandidate,
  chainClient: PublicClient, filter: ServiceFilter,
  readCard: (url: string) => Promise<Uint8Array>): Promise<DiscoveryVerification> {
  let bytes: Uint8Array;
  try { bytes = await readCard(candidate.declaration.url); }
  catch { return { status: 'unavailable', reason: 'card fetch failed',
    observerOrigin: candidate.observerOrigin }; }
  return verifyDiscoveryAtCurrentChain(candidate, chainClient, bytes, filter);
}
