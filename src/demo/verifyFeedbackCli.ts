import { pathToFileURL } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { z } from 'zod';
import { decodeFeedbackIndexSource, feedbackIndexOrigin, readIndexFeedback, type IndexFeedbackRead } from '../feedback/indexClient.js';
import { readHistoricalFeedback, type HistoricalFeedbackObservation } from '../feedback/historicalRead.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
import { readPrivateBundleFile } from './privateBundleFile.js';

const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((s) => BigInt(s) < 1n << 256n);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const configSchema = z.strictObject({ indexOrigin: z.string().transform(feedbackIndexOrigin),
  rpcOrigin: z.string().transform(feedbackIndexOrigin), source: z.unknown().transform(decodeFeedbackIndexSource),
  agentId: uint, reviewer: z.string().regex(/^0x[0-9a-f]{40}$/), eventId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  documentHash: hash, observationBlock: uint, observationHash: hash });
export type FeedbackReaderConfig = z.input<typeof configSchema>;
export type FeedbackReaderReport = {
  version: '0.1'; status: 'evaluated' | 'unsupported-event-reference';
  index: {
    origin: string; sourceId: string; coverage: IndexFeedbackRead['coverage']; basis: IndexFeedbackRead['basis'];
    event: { eventId: string; blockNumber: string; blockHash: Hex; transactionHash: Hex; transactionIndex: string;
      logIndex: string; canonicality: 'canonical' | 'withdrawn' | 'orphaned' };
    history: Array<{ eventId: string; kind: string; canonicality: string }>;
    historyPages: IndexFeedbackRead['historyPages'];
    documentHash: string; documentAvailability: 'retained' | 'unavailable'; byteLength: number | null;
    completeness: 'index-reported-only';
  };
  historical?: HistoricalFeedbackObservation;
};

/** Reads public evidence from exactly one selected Index; the private bundle travels separately. */
export async function verifyFeedbackFromIndex(raw: FeedbackReaderConfig, privateBundlePath: string | null,
  signal?: AbortSignal): Promise<FeedbackReaderReport> {
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(raw); } catch { throw new Error('feedback reader configuration rejected'); }
  const selected = await readIndexFeedback({ origin: config.indexOrigin, source: config.source,
    agentId: config.agentId, reviewer: config.reviewer, eventId: config.eventId, documentHash: config.documentHash,
    ...(signal ? { signal } : {}) });
  const e = selected.event, r = e.raw;
  const report: FeedbackReaderReport = { version: '0.1', status: 'unsupported-event-reference', index: {
    origin: config.indexOrigin, sourceId: e.sourceId, coverage: selected.coverage, basis: selected.basis,
    event: { eventId: e.eventId, blockNumber: r.block.number, blockHash: r.block.hash, transactionHash: r.transactionHash,
      transactionIndex: r.transactionIndex, logIndex: r.logIndex, canonicality: e.canonicality },
    history: selected.history.map((entry) => ({ eventId: entry.eventId, kind: entry.decoded.kind, canonicality: entry.canonicality })),
    historyPages: selected.historyPages,
    documentHash: config.documentHash, documentAvailability: selected.documentBytes === null ? 'unavailable' : 'retained',
    byteLength: selected.documentBytes?.length ?? null, completeness: 'index-reported-only',
  } };
  if (e.decoded.kind !== 'NewFeedback' || e.decoded.feedbackURI === null || Buffer.byteLength(e.decoded.feedbackURI) > 2048 ||
    BigInt(r.transactionIndex) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(r.logIndex) > BigInt(Number.MAX_SAFE_INTEGER)) return report;
  const bundleBytes = await readPrivateBundleFile(privateBundlePath);
  const rpcFetch: typeof fetch = (input, init) => boundedRpcFetch(input, { ...init,
    ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}) });
  const client = createPublicClient({ transport: http(config.rpcOrigin, { retryCount: 0, timeout: 5000, fetchFn: rpcFetch }) });
  const observationBlock = BigInt(config.observationBlock);
  const before = await client.getBlock({ blockNumber: observationBlock });
  if (before.hash !== config.observationHash) throw new Error('feedback reader observation basis conflict');
  const historical = await readHistoricalFeedback({ client, domain: config.source,
    eventRef: { blockNumber: r.block.number, blockHash: r.block.hash, transactionHash: r.transactionHash,
      transactionIndex: Number(r.transactionIndex), logIndex: Number(r.logIndex), feedbackURI: e.decoded.feedbackURI },
    documentBytes: selected.documentBytes, bundleBytes, observationBlock });
  const after = await client.getBlock({ blockNumber: observationBlock });
  if (after.hash !== before.hash || (historical.publication.observation && historical.publication.observation.blockHash !== before.hash)) {
    throw new Error('feedback reader observation basis changed');
  }
  return { ...report, status: 'evaluated', historical };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--config' ||
    (args.length === 4 && args[2] !== '--private-bundle') || Buffer.byteLength(args[1]!) > 16384) throw new Error();
  const config: unknown = JSON.parse(args[1]!);
  const report = await verifyFeedbackFromIndex(config as FeedbackReaderConfig, args[3] ?? null);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { process.stderr.write('feedback reader failed; no private evidence exported\n'); process.exitCode = 1; });
}
