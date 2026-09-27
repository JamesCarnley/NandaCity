import { z } from 'zod';
import { eveningPlanInputSchema } from '../a2a/input.js';
import { isUtcSecond } from '../interaction/schema.js';

export const ORIGIN_PROFILE = 'city-origin@0.1' as const;
export const originDigestSchema = z.string().regex(/^0x[0-9a-f]{64}$/).refine((v) => !/^0x0+$/.test(v));
export const originKeySchema = z.strictObject({ method: z.literal('secp256k1-key'),
  address: z.string().regex(/^0x[0-9a-f]{40}$/).refine((v) => !/^0x0+$/.test(v)) });
export const originUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.href === value && !url.username && !url.password &&
      !value.includes('?') && !value.includes('#') && !value.includes('\\') &&
      !/%(?:2e|2f|5c)/i.test(value) && !/[\u0000-\u0020\u007f]/.test(value);
  } catch { return false; }
}, 'must be an exact canonical HTTPS URL without credentials, query or fragment');
export const originServiceSchema = z.strictObject({ method: z.literal('https-origin'), identityUrl: originUrlSchema });
const common = { profile: z.literal(ORIGIN_PROFILE), service: originServiceSchema };
const time = z.string().refine(isUtcSecond);
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

export const originProfileSchema = z.strictObject({ ...common, kind: z.literal('profile'),
  revision: identifier, active: z.boolean(), controllerKey: originKeySchema, runtimeKey: originKeySchema,
  cardURL: originUrlSchema, cardDigest: originDigestSchema, endpoint: originUrlSchema,
  city: z.enum(['Chicago', 'Boston']), capability: z.literal('evening-plan'),
}).refine((v) => v.controllerKey.address !== v.runtimeKey.address, 'controller and runtime keys must differ');
export const originRequestSchema = z.strictObject({ ...common, kind: z.literal('request'), caller: originKeySchema,
  interactionId: originDigestSchema,
  profileBasis: z.strictObject({ profileDigest: originDigestSchema, cardDigest: originDigestSchema }),
  createdAt: time, deadline: time, input: eveningPlanInputSchema,
}).refine((v) => Date.parse(v.deadline) > Date.parse(v.createdAt), 'deadline must follow createdAt');
export const originAcceptanceSchema = z.strictObject({ ...common, kind: z.literal('acceptance'),
  requestDigest: originDigestSchema, acceptanceId: originDigestSchema, acceptedAt: time, deadline: time,
}).refine((v) => Date.parse(v.acceptedAt) <= Date.parse(v.deadline), 'acceptance must precede deadline');
const completionCommon = { ...common, kind: z.literal('completion'), acceptanceDigest: originDigestSchema, recordedAt: time };
export const originCompletionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...completionCommon, outcome: z.literal('completed'), answerDigest: originDigestSchema }),
  z.strictObject({ ...completionCommon, outcome: z.literal('failed'), reason: z.enum(['provider-error', 'dependency-unavailable']) }),
  z.strictObject({ ...completionCommon, outcome: z.literal('cancelled'), reason: z.literal('provider-cancelled') }),
  z.strictObject({ ...completionCommon, outcome: z.literal('expired') }),
]);
export const originFeedbackSchema = z.strictObject({ ...common, kind: z.literal('feedback'), reviewer: originKeySchema,
  interactionId: originDigestSchema, requestDigest: originDigestSchema, acceptanceDigest: originDigestSchema,
  publicationPolicy: z.literal('city-origin-archive@0.1'), rubric: z.literal('evening-plan-usefulness-v0.1'),
  value: z.number().int().min(1).max(5), createdAt: time,
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('completion'), completionDigest: originDigestSchema }),
    z.strictObject({ kind: z.literal('no-result-observed'), observedAt: time }),
  ]),
}).refine((v) => v.result.kind !== 'no-result-observed' || Date.parse(v.result.observedAt) <= Date.parse(v.createdAt),
  'no-result observation cannot follow feedback creation');
export const originRetractionSchema = z.strictObject({ ...common, kind: z.literal('retraction'), reviewer: originKeySchema,
  interactionId: originDigestSchema, feedbackDocumentDigest: originDigestSchema, createdAt: time });
export const originSnapshotSchema = z.strictObject({ ...common, kind: z.literal('archive-snapshot'), reviewer: originKeySchema.shape.address,
  snapshotId: identifier, createdAt: time, historyScope: z.literal('reviewer-declared-from-inception'),
  entries: z.array(originDigestSchema).max(256).refine((v) => new Set(v).size === v.length, 'entries must be unique') });
export const originStatementSchema = z.discriminatedUnion('kind', [originProfileSchema, originRequestSchema,
  originAcceptanceSchema, originCompletionSchema, originFeedbackSchema, originRetractionSchema, originSnapshotSchema]);
export const originEnvelopeSchema = z.strictObject({ profile: z.literal(ORIGIN_PROFILE),
  scheme: z.literal('eip712-secp256k1'), signer: originKeySchema, payloadBase64: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/) });
export type OriginProfile = z.infer<typeof originProfileSchema>;
export type OriginRequest = z.infer<typeof originRequestSchema>;
export type OriginAcceptance = z.infer<typeof originAcceptanceSchema>;
export type OriginCompletion = z.infer<typeof originCompletionSchema>;
export type OriginFeedback = z.infer<typeof originFeedbackSchema>;
export type OriginRetraction = z.infer<typeof originRetractionSchema>;
export type OriginSnapshot = z.infer<typeof originSnapshotSchema>;
export type OriginStatement = z.infer<typeof originStatementSchema>;
export type OriginEnvelope = z.infer<typeof originEnvelopeSchema>;
