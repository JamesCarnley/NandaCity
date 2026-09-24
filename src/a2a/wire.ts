import { z } from 'zod';

import { envelopeSchema } from '../interaction/schema.js';

export const CITY_REQUEST_DATA_TYPE = 'org.nandacity.city-request' as const;
export const CITY_RESULT_DATA_TYPE = 'org.nandacity.city-result' as const;
export const CITY_STATUS_DATA_TYPE = 'org.nandacity.city-status' as const;

const metadataSchema = z.record(z.string(), z.unknown());

const dataPartSchema = z.strictObject({
  kind: z.literal('data'),
  data: z.strictObject({
    type: z.literal(CITY_REQUEST_DATA_TYPE),
    version: z.literal('0.1'),
    envelope: z.unknown(),
  }),
  metadata: metadataSchema.optional(),
});

export const sendParamsSchema = z.strictObject({
  message: z.object({
    kind: z.literal('message'),
    role: z.literal('user'),
    messageId: z.string().min(1).max(256),
    parts: z.array(dataPartSchema).length(1),
    metadata: metadataSchema.optional(),
    extensions: z.array(z.string()).optional(),
    referenceTaskIds: z.array(z.string()).optional(),
  }).strict(),
  configuration: z.object({
    acceptedOutputModes: z.array(z.string()).max(16).optional(),
    historyLength: z.number().int().min(0).max(100).optional(),
    blocking: z.boolean().optional(),
  }).strict().optional(),
  metadata: metadataSchema.optional(),
});

export const taskQueryParamsSchema = z.strictObject({
  id: z.string().min(1).max(256),
  historyLength: z.number().int().min(0).max(100).optional(),
  metadata: metadataSchema.optional(),
});

const a2aDataPartSchema = z.object({
  kind: z.literal('data'),
  data: metadataSchema,
  metadata: metadataSchema.optional(),
}).strict();

const a2aMessageSchema = z.object({
  kind: z.literal('message'),
  role: z.enum(['user', 'agent']),
  messageId: z.string().min(1),
  parts: z.array(a2aDataPartSchema),
  metadata: metadataSchema.optional(),
}).strict();

export const a2aTaskSchema = z.object({
  kind: z.literal('task'),
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({
    state: z.enum(['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown']),
    message: a2aMessageSchema.optional(),
    timestamp: z.string().optional(),
  }).strict(),
  history: z.array(a2aMessageSchema).optional(),
  artifacts: z.array(z.object({
    artifactId: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    parts: z.array(a2aDataPartSchema),
    metadata: metadataSchema.optional(),
  }).strict()).optional(),
  metadata: metadataSchema.optional(),
}).strict();

export type A2ADataPart = z.infer<typeof a2aDataPartSchema>;
export type A2AMessage = z.infer<typeof a2aMessageSchema>;
export type A2ATask = z.infer<typeof a2aTaskSchema>;
export type A2ATaskState = A2ATask['status']['state'];

export const storedTaskRecordSchema = z.strictObject({
  version: z.literal('0.1'),
  interactionKey: z.string().min(1),
  requestDigest: z.string().regex(/^0x[0-9a-f]{64}$/),
  requestEnvelope: envelopeSchema,
  acceptance: envelopeSchema,
  task: a2aTaskSchema,
});

export type StoredTaskRecord = z.infer<typeof storedTaskRecordSchema>;

export type JsonRpcId = string | number | null;
export type JsonRpcError = { code: number; message: string; data?: Record<string, unknown> };
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: JsonRpcError };

export function cityRequestEnvelopeFromParams(value: z.infer<typeof sendParamsSchema>): unknown {
  return value.message.parts[0]!.data.envelope;
}
