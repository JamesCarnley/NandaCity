import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { runExternalClient, type ExternalClientConfig } from './externalClient.js';

const origin = z.string().url().max(256);
const configSchema = z.strictObject({
  city: z.enum(['Chicago', 'Boston']),
  indexOrigins: z.tuple([origin, origin]),
  rpcOrigin: origin,
  cardOrigin: origin,
  serviceOrigins: z.array(origin).min(1).max(6),
  domain: z.strictObject({ chainId: z.number().int().positive().safe(),
    registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
  chosenAgentId: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

export async function runExternalClientCli(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 2 || args[0] !== '--config' || args[1]!.length > 4096) {
      throw new Error('expected one bounded public --config argument');
    }
    const config = configSchema.parse(JSON.parse(args[1]!));
    process.stdout.write(`${JSON.stringify(await runExternalClient(config as ExternalClientConfig))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`External client failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runExternalClientCli().then((status) => { process.exitCode = status; });
}
