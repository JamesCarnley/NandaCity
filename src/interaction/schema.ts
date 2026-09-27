import { isAddress } from 'viem';
import { z } from 'zod';
import { eveningPlanInputSchema as input } from '../a2a/input.js';

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

export function isUtcSecond(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value.replace('Z', '.000Z');
}

const utcSecond = z.string().refine(isUtcSecond, 'must be a real UTC date at whole-second precision');

const agentRef = z.strictObject({
  chainId: z.number().int().safe().positive(),
  registry: address,
  agentId: canonicalUint,
});

const service = z.strictObject({ method: z.literal('erc8004'), agent: agentRef });
const signer = z.strictObject({
  method: z.literal('eip155-eoa'),
  chainId: z.number().int().safe().positive(),
  address,
});

const profileBasis = z.strictObject({
  blockNumber: canonicalUint,
  blockHash: bytes32,
  agentOwner: address,
  agentUriDigest: bytes32,
  registrationDigest: bytes32,
  cardDigest: bytes32,
  receiptSigner: address,
}).refine(
  (value) => value.agentOwner.toLowerCase() !== value.receiptSigner.toLowerCase(),
  'runtime receiptSigner must differ from agentOwner',
);

export const requestSchema = z.strictObject({
  kind: z.literal('request'),
  version: z.literal('0.1'),
  service,
  caller: signer,
  interactionId: bytes32,
  profileBasis,
  createdAt: utcSecond,
  deadline: utcSecond,
  input,
}).superRefine((value, context) => {
  if (value.caller.chainId !== value.service.agent.chainId) {
    context.addIssue({ code: 'custom', path: ['caller', 'chainId'], message: 'caller and service chain IDs must match' });
  }
  if (Date.parse(value.deadline) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: 'custom', path: ['deadline'], message: 'deadline must follow createdAt' });
  }
});

export const acceptanceSchema = z.strictObject({
  kind: z.literal('acceptance'),
  version: z.literal('0.1'),
  requestDigest: bytes32,
  acceptanceId: bytes32,
  acceptedAt: utcSecond,
  deadline: utcSecond,
});

export const completionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    kind: z.literal('completion'), version: z.literal('0.1'),
    acceptanceDigest: bytes32, recordedAt: utcSecond,
    outcome: z.literal('completed'), answerDigest: bytes32,
  }),
  z.strictObject({
    kind: z.literal('completion'), version: z.literal('0.1'),
    acceptanceDigest: bytes32, recordedAt: utcSecond,
    outcome: z.literal('failed'), reason: z.enum(['provider-error', 'dependency-unavailable']),
  }),
  z.strictObject({
    kind: z.literal('completion'), version: z.literal('0.1'),
    acceptanceDigest: bytes32, recordedAt: utcSecond,
    outcome: z.literal('cancelled'), reason: z.literal('provider-cancelled'),
  }),
  z.strictObject({
    kind: z.literal('completion'), version: z.literal('0.1'),
    acceptanceDigest: bytes32, recordedAt: utcSecond,
    outcome: z.literal('expired'),
  }),
]);

export const statementSchema = z.discriminatedUnion('kind', [
  requestSchema, acceptanceSchema, completionSchema,
]);

export type CityRequest = z.infer<typeof requestSchema>;
export type CityAcceptance = z.infer<typeof acceptanceSchema>;
export type CityCompletion = z.infer<typeof completionSchema>;
export type CityStatement = CityRequest | CityAcceptance | CityCompletion;

export const envelopeSchema = z.strictObject({
  version: z.literal('0.1'),
  scheme: z.string().min(1),
  signer: z.strictObject({
    method: z.string().min(1),
    chainId: z.number().int().safe().positive(),
    address,
  }),
  payloadBase64: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/, 'signature must be 65 lowercase bytes'),
});

export type SignedEnvelope = z.infer<typeof envelopeSchema>;
