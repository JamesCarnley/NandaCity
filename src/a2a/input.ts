import { z } from "zod";

const MAX_UINT256 = (1n << 256n) - 1n;
const canonicalUint = z.string().refine((value) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) <= MAX_UINT256);

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

export const eveningPlanInputSchema = z.strictObject({
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

export type EveningPlanInput = z.infer<typeof eveningPlanInputSchema>;
