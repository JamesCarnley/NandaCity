import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runIdentityDemo, type IdentityDemoResult } from './demo/identity.js';

const usage = 'Usage: npm run demo:identity -- [--json]';

export function formatIdentityDemoJson(result: IdentityDemoResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatIdentityDemoPlain(result: IdentityDemoResult): string {
  const passed = Object.values(result.acceptance).filter(Boolean).length;
  const total = Object.keys(result.acceptance).length;
  return [
    'NANDA City local identity demonstration',
    `label: ${result.label}`,
    `chainId: ${result.chainId}`,
    `registry: ${result.registry}`,
    `agentId: ${result.agentId}`,
    `registryAdmin: ${result.registryAdmin}`,
    `agentOwner: ${result.agentOwner}`,
    `implementation: ${result.implementation}`,
    `registryVersion: ${result.registryVersion}`,
    `blockNumber: ${result.snapshot.blockNumber}`,
    `blockHash: ${result.snapshot.blockHash}`,
    `blockTimestamp: ${result.snapshot.blockTimestamp}`,
    `observedHead: ${result.observedHead}`,
    `confirmationCount: ${result.confirmationCount} (local observed depth only)`,
    `acceptance: ${passed}/${total} assertions passed`,
    `referenceCommit: ${result.provenance.referenceCommit}`,
    `solc: ${result.provenance.solcVersion}`,
    `OpenZeppelin: ${result.provenance.openZeppelinVersion}`,
    'limits:',
    ...result.limits.map((limit) => `- ${limit}`),
  ].join('\n');
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  output: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
  errorOutput: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): Promise<number> {
  const json = args.includes('--json');
  const positional = args.filter((argument) => argument !== '--json');
  if (
    positional.length !== 2 ||
    positional[0] !== 'identity' ||
    positional[1] !== 'demo' ||
    args.filter((argument) => argument === '--json').length > 1
  ) {
    errorOutput.write(`${usage}\n`);
    return 2;
  }

  try {
    const result = await runIdentityDemo();
    const failed = Object.entries(result.acceptance).filter(([, accepted]) => !accepted);
    if (failed.length > 0) {
      throw new Error(
        `identity acceptance failed: ${failed.map(([name]) => name).join(', ')}`,
      );
    }
    output.write(`${json ? formatIdentityDemoJson(result) : formatIdentityDemoPlain(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorOutput.write(`Identity demo failed: ${message}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
