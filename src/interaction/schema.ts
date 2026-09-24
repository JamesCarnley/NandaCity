import { isAddress } from 'viem';
import { z } from 'zod';

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
const byteBounded = (max: number) => z.string().refine(
  (value) => value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= max,
  `must be well-formed UTF-8 within ${max} bytes`,
);

const localDateTime = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-](?:0\d|1[0-4]):[0-5]\d$/,
  'must include full local date, seconds, and UTC offset',
);

function localEpoch(value: string, zone: string): number | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName?.replace('GMT', '');
  return value === `${date}${offset}` ? epoch : null;
}

const timeWindow = z.strictObject({
  start: localDateTime,
  end: localDateTime,
  timeZone: z.enum(['America/Chicago', 'America/New_York']),
});

const input = z.strictObject({
  version: z.literal('0.1'),
  capability: z.literal('evening-plan'),
  city: z.enum(['Chicago', 'Boston']),
  timeWindow,
  area: byteBounded(120).refine((value) => Buffer.byteLength(value, 'utf8') > 0, 'area is required'),
  budget: z.strictObject({
    currency: z.literal('USD'),
    minorUnits: canonicalUint.refine((value) => BigInt(value) <= 10_000_000n, 'minorUnits exceeds 10000000'),
  }),
  transport: z.array(z.enum(['walk', 'public-transit', 'bicycle', 'car', 'taxi'])).min(1).max(5)
    .refine((values) => new Set(values).size === values.length, 'transport values must be unique'),
  preferences: z.array(byteBounded(256)).max(16),
}).superRefine((value, context) => {
  const expectedZone = value.city === 'Chicago' ? 'America/Chicago' : 'America/New_York';
  if (value.timeWindow.timeZone !== expectedZone) {
    context.addIssue({ code: 'custom', path: ['timeWindow', 'timeZone'], message: 'time zone does not match city' });
  }
  const start = localEpoch(value.timeWindow.start, value.timeWindow.timeZone);
  const end = localEpoch(value.timeWindow.end, value.timeWindow.timeZone);
  if (start === null || end === null) {
    context.addIssue({ code: 'custom', path: ['timeWindow'], message: 'local date or offset does not match time zone' });
  } else if (end <= start || end - start > 86_400_000) {
    context.addIssue({ code: 'custom', path: ['timeWindow'], message: 'window duration must be positive and at most 24 hours' });
  }
});

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
