import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { runExternalClient, projectExternalClientResult, type ExternalClientConfig, type ExternalClientResult,
  type LicensedExternalClientResult } from './externalClient.js';
import { retentionSchema } from '../live/retention.js';

const origin = z.string().url().max(256);
const configSchema = z.strictObject({
  retention: retentionSchema.optional(),
  city: z.enum(['Chicago', 'Boston']),
  indexOrigins: z.tuple([origin, origin]),
  rpcOrigin: origin,
  cardOrigin: origin,
  serviceOrigins: z.array(origin).min(1).max(6),
  domain: z.strictObject({ chainId: z.number().int().positive().safe(),
    registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    genesisHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    knownImplementation: z.strictObject({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }) }),
  chosenAgentId: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

export function serializeExternalClientResult(result: ExternalClientResult | LicensedExternalClientResult, now?: () => string): string {
  return `${JSON.stringify(projectExternalClientResult(result, now))}\n`;
}

export async function runExternalClientCli(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 2 || args[0] !== '--config' || args[1]!.length > 4096) {
      throw new Error('expected one bounded public --config argument');
    }
    const config = configSchema.parse(JSON.parse(args[1]!));
    const result = await runExternalClient(config as ExternalClientConfig);
    try { process.stdout.write(serializeExternalClientResult(result)); }
    finally { if ('mode' in result && result.mode === 'licensed-receipts-only') result.close(); }
    return 0;
  } catch (error) {
    // Configuration/transport errors can contain private or source-derived text.
    process.stderr.write('External client failed; no result exported.\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runExternalClientCli().then((status) => { process.exitCode = status; });
}
