import { readRankingEvidence } from '../../../src/reputation/evidence.js';

async function readInput(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const observation = value['observation'];
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new Error();
  const blockNumber = (observation as Record<string, unknown>)['blockNumber'];
  if (typeof blockNumber !== 'string' || !/^(0|[1-9][0-9]*)$/.test(blockNumber) || blockNumber.length > 78) throw new Error();
  return { ...value, observation: { ...observation, blockNumber: BigInt(blockNumber) } };
}

try {
  const result = await readRankingEvidence(await readInput() as never);
  process.stdout.write(JSON.stringify({ policyInput: result.policyInput, policyResult: result.policyResult }));
} catch {
  process.stderr.write('ranking evidence worker failed\n');
  process.exitCode = 1;
}
