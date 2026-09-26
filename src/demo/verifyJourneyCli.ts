import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPublicClient, http, isAddress, type Address, type Hex } from 'viem';

import { verifyJourneyEvidence, type JourneyEvidence } from './journeyReport.js';
import { chicago } from './registryFixture.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';

const usage = 'Usage: node --import tsx src/demo/verifyJourneyCli.ts --evidence /absolute/file.json --rpc-url http://127.0.0.1:PORT --card-origin http://127.0.0.1:PORT --chain-id 31337 --registry 0x... --genesis-hash 0x... --implementation 0x... --implementation-code-hash 0x...';

function option(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length || args.indexOf(flag, index + 1) >= 0) throw new Error(usage);
  return args[index + 1]!;
}

function loopbackOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== raw.replace(/\/$/, '')) {
    throw new Error('verifier RPC and card origin must be exact 127.0.0.1 HTTP origins');
  }
  return url.origin;
}

export async function runVerifyJourneyCli(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length !== 16) throw new Error(usage);
    const file = option(args, '--evidence');
    if (!isAbsolute(file)) throw new Error('evidence path must be absolute');
    const rpcOrigin = loopbackOrigin(option(args, '--rpc-url'));
    const cardOrigin = loopbackOrigin(option(args, '--card-origin'));
    const chainId = Number(option(args, '--chain-id'));
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('invalid chain ID');
    const registry = option(args, '--registry');
    if (!isAddress(registry, { strict: true })) throw new Error('invalid registry address');
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('evidence file exceeds 2 MiB');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const caseEvidence = (key: 'success' | 'failure'): JourneyEvidence => {
      const item = raw[key];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('evidence file requires success and failure');
      }
      const value = item as Record<string, unknown>;
      return (value['evidence'] ?? value) as JourneyEvidence;
    };
    const domain = { chainId, registry: registry as Address,
      genesisHash: option(args, '--genesis-hash') as Hex,
      knownImplementation: { address: option(args, '--implementation') as Address,
        codeHash: option(args, '--implementation-code-hash') as Hex } };
    const filter = { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
      areaServed: [chicago], interfaces: ['application/a2a+json;version=0.3'] };
    const client = createPublicClient({ transport: http(rpcOrigin, { retryCount: 0, timeout: 5_000, fetchFn: boundedRpcFetch }) });
    const success = await verifyJourneyEvidence(caseEvidence('success'),
      client, domain, filter, cardOrigin);
    const failure = await verifyJourneyEvidence(caseEvidence('failure'),
      client, domain, filter, cardOrigin);
    process.stdout.write(`${JSON.stringify({ success, failure })}\n`);
    return success.evidenceUsable && success.execution === 'completed' &&
      failure.evidenceUsable && failure.execution === 'failed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Independent journey verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runVerifyJourneyCli().then((status) => { process.exitCode = status; });
}
