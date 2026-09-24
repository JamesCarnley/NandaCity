import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { verifyProfile, type VerifiedProfile } from '../../src/identity/verify.js';
import type { CityAcceptance, CityCompletion, CityRequest } from '../../src/interaction/schema.js';
import {
  cloneOriginalRegistration,
  dataUriFor,
  originalBasis,
  originalCandidate,
  registryAddress,
} from '../identity/fixtures.js';

export function makeInteractionFixture() {
  const caller = privateKeyToAccount(generatePrivateKey());
  const runtime = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  const baseRegistration = cloneOriginalRegistration();
  const registration = {
    ...baseRegistration,
    'x-nandacity': {
      ...baseRegistration['x-nandacity'],
      receiptSigner: runtime.address.toLowerCase(),
    },
  };
  const agentURI = dataUriFor(registration);
  const profile: VerifiedProfile = verifyProfile(
    { ...originalCandidate, agentURI },
    { ...originalBasis, agentURI },
  );

  const request: CityRequest = {
    kind: 'request', version: '0.1',
    service: { method: 'erc8004', agent: { chainId: 11155111, registry: registryAddress, agentId: '7' } },
    caller: { method: 'eip155-eoa', chainId: 11155111, address: caller.address.toLowerCase() as `0x${string}` },
    interactionId: `0x${'ab'.repeat(32)}`,
    profileBasis: {
      blockNumber: profile.source.blockNumber,
      blockHash: profile.source.blockHash,
      agentOwner: profile.source.agentOwner,
      agentUriDigest: profile.source.agentUriDigest,
      registrationDigest: profile.source.registrationDigest,
      cardDigest: profile.source.cardDigest,
      receiptSigner: profile.registration['x-nandacity'].receiptSigner as `0x${string}`,
    },
    createdAt: '2026-09-24T12:00:00Z', deadline: '2026-09-24T13:00:00Z',
    input: {
      version: '0.1', capability: 'evening-plan', city: 'Chicago',
      timeWindow: {
        start: '2026-10-02T18:00:00-05:00',
        end: '2026-10-02T22:00:00-05:00',
        timeZone: 'America/Chicago',
      },
      area: 'The Loop', budget: { currency: 'USD', minorUnits: '8500' },
      transport: ['walk', 'public-transit'], preferences: ['Low carb'],
    },
  };

  const acceptance: CityAcceptance = {
    kind: 'acceptance', version: '0.1',
    requestDigest: `0x${'11'.repeat(32)}`,
    acceptanceId: `0x${'22'.repeat(32)}`,
    acceptedAt: '2026-09-24T12:01:00Z', deadline: request.deadline,
  };

  const completion: CityCompletion = {
    kind: 'completion', version: '0.1',
    acceptanceDigest: `0x${'33'.repeat(32)}`,
    recordedAt: '2026-09-24T12:10:00Z', outcome: 'completed',
    answerDigest: `0x${'44'.repeat(32)}`,
  };

  return { caller, runtime, stranger, profile, request, acceptance, completion };
}
