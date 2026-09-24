import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runIdentityDemo, type IdentityDemoResult } from './demo/identity.js';
import { runTwoIndexDemo } from './demo/twoIndexes.js';
import { runChicagoJourney } from './demo/chicagoJourney.js';
import { formatJourneyPlain } from './demo/journeyReport.js';

const usage = 'Usage: npm run demo:identity -- [--json]';
const discoveryUsage = 'Usage: npm run demo:discovery -- --index-checkout /absolute/path [--json]';
const journeyUsage = 'Usage: npm run demo:journey -- --index-checkout /absolute/path [--json]';

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
  if (args[0] === 'journey' && args[1] === 'demo') {
    const indexFlag = args.indexOf('--index-checkout');
    const checkout = indexFlag >= 0 ? args[indexFlag + 1] : undefined;
    const remaining = args.slice(2).filter((argument, index) =>
      argument !== '--json' && index + 2 !== indexFlag && index + 2 !== indexFlag + 1);
    if (!checkout || !isAbsolute(checkout) || remaining.length > 0 ||
      args.filter((argument) => argument === '--index-checkout').length !== 1 ||
      args.filter((argument) => argument === '--json').length > 1) {
      errorOutput.write(`${journeyUsage}\n`);
      if (checkout && !isAbsolute(checkout)) errorOutput.write('Index checkout must be absolute.\n');
      return 2;
    }
    try {
      const result = await runChicagoJourney(checkout);
      if (!result.tamperRejected || !result.independentProcessVerified) {
        throw new Error('independent journey verification did not complete');
      }
      output.write(`${args.includes('--json') ? JSON.stringify(result, null, 2) :
        formatJourneyPlain(result.success.report, result.failure.report)}\n`);
      return 0;
    } catch (error) {
      errorOutput.write(`Chicago journey failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (args[0] === 'discovery' && args[1] === 'demo') {
    const indexFlag = args.indexOf('--index-checkout');
    const checkout = indexFlag >= 0 ? args[indexFlag + 1] : undefined;
    const remaining = args.slice(2).filter((argument, index) =>
      argument !== '--json' && index + 2 !== indexFlag && index + 2 !== indexFlag + 1);
    if (!checkout || !isAbsolute(checkout) || remaining.length > 0 ||
      args.filter((argument) => argument === '--index-checkout').length !== 1 ||
      args.filter((argument) => argument === '--json').length > 1) {
      errorOutput.write(`${discoveryUsage}\n`);
      if (checkout && !isAbsolute(checkout)) errorOutput.write('Index checkout must be absolute.\n');
      return 2;
    }
    try {
      const result = await runTwoIndexDemo(checkout);
      const failed = Object.entries(result.acceptance).filter(([, accepted]) => !accepted);
      if (failed.length > 0) throw new Error(`discovery acceptance failed: ${failed.map(([name]) => name).join(', ')}`);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (error) {
      errorOutput.write(`Discovery demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
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
