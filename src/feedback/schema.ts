import { isAddress } from 'viem';
import { z } from 'zod';

import { isUtcSecond } from '../interaction/schema.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().refine(
  (value) => value === value.toLowerCase() && isAddress(value, { strict: true }) && value !== ZERO_ADDRESS,
  'must be a lowercase non-zero EVM address',
);
const canonicalUint = z.string().refine(
  (value) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) <= MAX_UINT256,
  'must be a canonical unsigned uint256 decimal string',
);
const utcSecond = z.string().refine(isUtcSecond, 'must be a real UTC date at whole-second precision');
const chainId = z.number().int().safe().positive();

export const feedbackSchema = z.strictObject({
  kind: z.literal('feedback'),
  version: z.literal('0.1'),
  service: z.strictObject({
    method: z.literal('erc8004'),
    agent: z.strictObject({ chainId, registry: address, agentId: canonicalUint }),
  }),
  reviewer: z.strictObject({ method: z.literal('eip155-eoa'), chainId, address }),
  interactionId: bytes32,
  requestDigest: bytes32,
  acceptanceDigest: bytes32,
  reputationRegistry: z.strictObject({ chainId, address }),
  rubric: z.literal('evening-plan-usefulness-v0.1'),
  value: z.number().int().min(1).max(5),
  createdAt: utcSecond,
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('completion'), completionDigest: bytes32 }),
    z.strictObject({ kind: z.literal('no-result-observed'), observedAt: utcSecond }),
  ]),
}).superRefine((value, context) => {
  if (value.reviewer.chainId !== value.service.agent.chainId) {
    context.addIssue({ code: 'custom', path: ['reviewer', 'chainId'], message: 'reviewer and service chain IDs must match' });
  }
  if (value.reputationRegistry.chainId !== value.service.agent.chainId) {
    context.addIssue({ code: 'custom', path: ['reputationRegistry', 'chainId'], message: 'reputation registry and service chain IDs must match' });
  }
});

export type CityFeedback = z.infer<typeof feedbackSchema>;
