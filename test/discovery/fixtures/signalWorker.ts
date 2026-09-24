import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http } from 'viem';
import { withOwnedAnvil } from '../../../src/demo/anvil.js';
import { withOwnedIndexes } from '../../../src/demo/indexProcesses.js';
import { runTwoIndexDemo } from '../../../src/demo/twoIndexes.js';

const log = process.argv[2]!;
const checkout = process.argv[3]!;
const record = async (event: object): Promise<void> => appendFile(log, `${JSON.stringify(event)}\n`);
if (process.argv[4] === 'demo-ready') await runTwoIndexDemo(checkout);
else await withOwnedAnvil(async (rpcUrl) => {
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const genesis = await client.getBlock({ blockNumber: 0n });
    await withOwnedIndexes(checkout, {
      chainId: 31_337, registry: '0x1111111111111111111111111111111111111111',
      genesisHash: genesis.hash!, startBlock: '0', adapter: 'nandacity-0.1', confirmations: 0,
    }, { A: rpcUrl, B: rpcUrl }, async (owned) => {
      // A real callback's asynchronous finally must finish before the root exits.
      await record({ stage: 'ready', containerId: owned.containerId,
        origins: [owned.indexes.A.origin, owned.indexes.B.origin] });
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await delay(300);
      await record({ stage: 'callback-cleaned' });
    });
  } finally { await record({ stage: 'scenario-cleaned' }); }
}, { genesisMarker: { blockNumber: 0n, timestamp: BigInt(Date.now()) } });
