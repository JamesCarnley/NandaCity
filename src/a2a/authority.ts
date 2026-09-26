import type { PublicClient } from 'viem';
import { continuityLimits, readIdentityContinuity, type IdentityContinuityDomain } from '../identity/continuity.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile, type AgentRef } from '../identity/verify.js';
import type { CityRequest } from '../interaction/schema.js';
import type { AuthorityObservation } from './service.js';

/** Resolve the caller's exact signed basis, never a cached startup profile. */
export async function observeRequestAuthority(client: PublicClient, config: {
  domain: IdentityContinuityDomain; agent: AgentRef; cardBytes: Uint8Array; now: () => string;
}, request: CityRequest): Promise<AuthorityObservation> {
  const { agent, domain, cardBytes } = config;
  const subject = request.service.agent;
  if (request.service.method !== 'erc8004' || subject.agentId !== agent.agentId ||
      subject.chainId !== agent.chainId || subject.registry.toLowerCase() !== agent.registry.toLowerCase() ||
      agent.chainId !== domain.chainId || agent.registry.toLowerCase() !== domain.registry.toLowerCase()) {
    throw new Error('request is not for this configured service');
  }
  const basis = await readIdentitySnapshot(client, agent, BigInt(request.profileBasis.blockNumber));
  if (basis.blockHash !== request.profileBasis.blockHash) throw new Error('request basis block hash mismatch');
  const basisProfile = verifyProfile({ agent, agentURI: basis.agentURI, cardBytes }, basis);
  const current = await readIdentitySnapshot(client, agent);
  const finding = await readIdentityContinuity(client, { domain, agent, basis, current, limits: continuityLimits });
  let currentProfile = null;
  try { currentProfile = verifyProfile({ agent, agentURI: current.agentURI, cardBytes }, current); }
  catch { /* A retired/invalid current profile is not a reason to replace the signed basis. */ }
  return { basisProfile, currentProfile, continuity: finding.status, observedAt: config.now() };
}
