import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, type Hex } from 'viem';
import { encodeFeedbackDocument } from '../feedback/document.js';
import { feedbackEventId, readIndexFeedback, type FeedbackIndexSource } from '../feedback/indexClient.js';
import { encodeSupportingBundle } from '../feedback/supportingBundle.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { INDEX_SOURCE_COMMIT } from './indexProcesses.js';
import { checkOwnedCancellation, withOwnedLifecycle } from './ownedLifecycle.js';
import { withPrivateBundleFile } from './privateBundleFile.js';
import { invokeOwnedFixtureFailure } from './sixServiceJourney.js';
import { withSixServiceFixture, type SixServiceFixture } from './sixServiceFixture.js';
import { listenOwnedServer } from './twoIndexes.js';
import type { FeedbackSubmissionResult } from './feedbackPublication.js';
import type { FeedbackReaderConfig, FeedbackReaderReport } from './verifyFeedbackCli.js';

type Publication = { eventId: string; documentHash: Hex };
export type FeedbackRetentionReport = {
  mode: 'local-fixture'; indexSourceCommit: string; source: FeedbackIndexSource;
  failure: { execution: 'failed'; completionClaimedOutcome: 'failed'; reviewValue: 1; messageSend: number; tasksGet: number };
  publications: { primary: Publication; suffix: Publication };
  retained: { A: string[]; B: string[] }; restarted: { A: string[]; B: string[] };
  outages: { provider: true; cards: true; documents: true; indexA: true };
  origins: { initial: { A: string; B: string }; restarted: { A: string; B: string }; emptyRebuildA: string };
  bOnly: { primary: FeedbackReaderReport; suffix: FeedbackReaderReport; missingBundle: FeedbackReaderReport };
  reorg: { primary: FeedbackReaderReport; suffix: FeedbackReaderReport };
  revoked: FeedbackReaderReport; emptyRebuild: FeedbackReaderReport;
  cleanup: { ownedResourcesStopped: true }; limitations: string[];
};

async function unavailable(url: string): Promise<true> {
  checkOwnedCancellation();
  return new Promise((resolveOutage, reject) => {
    const req = httpRequest(url, { agent: false, signal: AbortSignal.timeout(1000) }, (response) => {
      response.destroy(); reject(new Error('owned source unexpectedly still reachable'));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolveOutage(true);
      else reject(new Error('owned source outage not established by connection refusal'));
    }); req.end();
  });
}

async function eventually<T>(read: () => Promise<T>, accepted: (value: T) => boolean, label: string): Promise<T> {
  const deadline = performance.now() + 30000;
  let last = '';
  do {
    checkOwnedCancellation();
    try { const value = await read(); if (accepted(value)) return value; }
    catch (error) { last = error instanceof Error ? error.message : 'read failed'; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (performance.now() < deadline);
  throw new Error(`owned feedback did not reach ${label}: ${last}`);
}

/** Await close even on abort; exec errors/argv can contain a private path and are never surfaced. */
async function separateReader(config: FeedbackReaderConfig, bundlePath: string | null, signal: AbortSignal): Promise<FeedbackReaderReport> {
  const module = fileURLToPath(import.meta.url), built = module.endsWith('.js');
  const args = [...(built ? [] : ['--import', 'tsx']), join(dirname(module), `verifyFeedbackCli.${built ? 'js' : 'ts'}`),
    '--config', JSON.stringify(config), ...(bundlePath === null ? [] : ['--private-bundle', bundlePath])];
  return new Promise((resolveResult, reject) => {
    let output: string | undefined; let failed = false;
    const child = execFile(process.execPath, args, { cwd: resolve(dirname(module), '../..'),
      env: { PATH: process.env['PATH'] ?? '' }, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      killSignal: 'SIGKILL', signal, encoding: 'utf8' }, (error, stdout) => {
      if (error) failed = true; else output = stdout;
    });
    child.once('error', () => { failed = true; });
    child.once('close', () => {
      try {
        if (failed || output === undefined) throw new Error();
        const report = JSON.parse(output) as FeedbackReaderReport;
        if (report.version !== '0.1' || report.index.origin !== config.indexOrigin ||
          report.index.event.eventId !== config.eventId || report.index.documentHash !== config.documentHash) throw new Error();
        resolveResult(report);
      } catch { reject(new Error('separate feedback reader failed; no private evidence exported')); }
    });
  });
}

async function publicationIdentity(fixture: SixServiceFixture, source: FeedbackIndexSource,
  publication: FeedbackSubmissionResult, documentHash: Hex): Promise<Publication> {
  const event = publication.event;
  const receipt = await fixture.chain.getTransactionReceipt({ hash: event.transactionHash });
  const block = await fixture.chain.getBlock({ blockNumber: BigInt(event.blockNumber) });
  const log = receipt.logs.find((entry) => entry.logIndex === event.logIndex);
  if (!log || log.transactionIndex === null || log.logIndex === null) throw new Error('owned feedback event receipt missing');
  return { documentHash, eventId: feedbackEventId(source, { block: { number: block.number.toString(), hash: block.hash,
    timestamp: Number(block.timestamp) }, transactionHash: log.transactionHash, transactionIndex: String(log.transactionIndex),
    logIndex: String(log.logIndex), address: log.address, topics: log.topics, data: log.data }) };
}

function requireHistorical(report: FeedbackReaderReport, publication: 'matched' | 'orphaned', revocation?: 'active' | 'revoked'): void {
  const h = report.historical;
  if (report.status !== 'evaluated' || h?.publication.publication !== publication ||
    (revocation && h.publication.revocation !== revocation)) throw new Error('independent publication/revocation finding did not match the owned drill');
}

/** Synthetic same-host retention proof; no ranking, consumer adapter or public-chain writes. */
export async function runFeedbackRetentionDemo(indexCheckout: string): Promise<FeedbackRetentionReport> {
  return withOwnedLifecycle(async (lifecycle) => {
    const documents = new Map<string, Uint8Array>();
    const documentServer = createServer((request, response) => {
      const bytes = request.method === 'GET' ? documents.get(request.url ?? '') : undefined;
      response.statusCode = bytes ? 200 : 404; response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytes);
    });
    const documentOrigin = await listenOwnedServer(documentServer);
    let stopping: Promise<void> | undefined;
    const stopDocuments = () => stopping ??= new Promise<void>((resolveStop, reject) => {
      documentServer.close((error) => error ? reject(error) : resolveStop()); documentServer.closeAllConnections();
    });
    try {
      const result = await withSixServiceFixture(indexCheckout, async (fixture) => {
        const feedback = fixture.feedback!; const source = feedback.source;
        const failure = await invokeOwnedFixtureFailure(fixture);
        const evidence = failure.evidence;
        const request = decodeEnvelope(evidence.request).statement;
        const acceptance = decodeEnvelope(evidence.acceptance!).statement;
        const completion = decodeEnvelope(evidence.completion!).statement;
        if (request.value.kind !== 'request' || completion.value.kind !== 'completion' || completion.value.outcome !== 'failed') {
          throw new Error('retention drill requires an actual signed failed completion');
        }
        const requestValue = request.value;
        const bundle = encodeSupportingBundle({ version: '0.1', request: evidence.request, acceptance: evidence.acceptance,
          completion: evidence.completion, cardBase64: evidence.cardBase64 });
        await fixture.stopProvider(failure.service.agent.agentId);
        const provider = await unavailable(failure.service.serviceUrl);
        const makeDocument = async (value: number) => encodeFeedbackDocument(await feedback.sign({
          kind: 'feedback', version: '0.1', service: requestValue.service, reviewer: requestValue.caller,
          interactionId: requestValue.interactionId, requestDigest: request.digest, acceptanceDigest: acceptance.digest,
          reputationRegistry: { chainId: source.chainId, address: source.reputationRegistry.toLowerCase() as Hex },
          rubric: 'evening-plan-usefulness-v0.1', value, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          result: { kind: 'completion', completionDigest: completion.digest },
        }));
        const primaryDoc = await makeDocument(1);
        documents.set('/primary', primaryDoc.bytes);
        const publish = (bytes: Uint8Array, path: string) => feedback.publish({ document: bytes, feedbackURI: `${documentOrigin}${path}`,
          originalProfile: { agent: failure.service.agent, agentURI: evidence.candidate.agentURI, cardBytes: failure.service.cardBytes },
          request: evidence.request, acceptance: evidence.acceptance, completion: evidence.completion });
        const submitted = await publish(primaryDoc.bytes, '/primary');
        const primary = await publicationIdentity(fixture, source, submitted, primaryDoc.documentHash);
        const selection = { source, agentId: failure.service.agent.agentId, reviewer: fixture.callerAddress.toLowerCase(), signal: lifecycle.signal };
        const read = (origin: string, publication: Publication) => readIndexFeedback({ origin, ...selection, ...publication });
        const retained = async (origin: string, publications: Publication[]) => {
          const hashes: string[] = [];
          for (const publication of publications) {
            const found = await eventually(() => read(origin, publication), (r) => r.documentBytes !== null, 'retained bytes');
            if (!found.documentBytes || keccak256(found.documentBytes) !== publication.documentHash) throw new Error('owned retention commitment mismatch');
            hashes.push(publication.documentHash);
          } return hashes;
        };
        const initial = { ...fixture.indexOrigins };
        await retained(initial.A, [primary]); await retained(initial.B, [primary]);
        await feedback.savePrefix();
        const suffixDoc = await makeDocument(2); documents.set('/suffix', suffixDoc.bytes);
        const suffixSubmission = await publish(suffixDoc.bytes, '/suffix');
        const suffix = await publicationIdentity(fixture, source, suffixSubmission, suffixDoc.documentHash);
        const publications = { primary, suffix }; const pair = [primary, suffix];
        const bothRetained = { A: await retained(initial.A, pair), B: await retained(initial.B, pair) };
        await fixture.stopCards(); await stopDocuments();
        const cards = await unavailable(fixture.cardOrigin), docs = await unavailable(`${documentOrigin}/primary`);
        const restartedA = await fixture.indexes.restart('A'), restartedB = await fixture.indexes.restart('B');
        const restarted = { A: await retained(restartedA.origin, pair), B: await retained(restartedB.origin, pair) };
        await fixture.indexes.stop('A'); const indexA = await unavailable(`${restartedA.origin}/health`);
        return withPrivateBundleFile(bundle.bytes, async (bundlePath) => {
          const verify = async (origin: string, publication: Publication, path: string | null = bundlePath) => {
            const basis = await fixture.chain.getBlock();
            return separateReader({ indexOrigin: origin, rpcOrigin: fixture.rpcOrigin, source, agentId: selection.agentId,
              reviewer: selection.reviewer, ...publication, observationBlock: basis.number.toString(), observationHash: basis.hash }, path, lifecycle.signal);
          };
          const bOnly = { primary: await verify(restartedB.origin, primary), suffix: await verify(restartedB.origin, suffix),
            missingBundle: await verify(restartedB.origin, primary, null) };
          requireHistorical(bOnly.primary, 'matched', 'active'); requireHistorical(bOnly.suffix, 'matched', 'active');
          const h = bOnly.primary.historical!;
          if (h.originalAuthority.status !== 'matched' || h.historical.status !== 'evaluated' ||
            h.historical.findings.resultEvidence !== 'matched' || h.historical.findings.completionClaimedOutcome !== 'failed' ||
            h.historical.findings.claimedTime !== 'consistent' || h.publication.claimedFeedbackTime !== 'not-after-publication') {
            throw new Error('retained original signed failure did not independently verify');
          }
          if (bOnly.missingBundle.historical?.bundle.availability !== 'absent') throw new Error('missing bundle was not preserved');
          const oldCheckpoint = (await read(restartedB.origin, suffix)).coverage.checkpoint;
          if (!oldCheckpoint) throw new Error('owned feedback checkpoint unavailable');
          await feedback.replaceSuffixThrough(oldCheckpoint.number);
          await eventually(() => read(restartedB.origin, primary), (r) => r.event.canonicality === 'canonical' &&
            r.coverage.progress === 'synchronized' && BigInt(r.coverage.generation) > BigInt(bOnly.primary.index.coverage.generation), 'prefix replay');
          await eventually(() => read(restartedB.origin, suffix), (r) => r.event.canonicality !== 'canonical' && r.documentBytes !== null, 'retained orphan suffix');
          const reorg = { primary: await verify(restartedB.origin, primary), suffix: await verify(restartedB.origin, suffix) };
          requireHistorical(reorg.primary, 'matched', 'active'); requireHistorical(reorg.suffix, 'orphaned');
          const revocation = await feedback.revoke(submitted.receipt.transactionHash);
          await eventually(() => read(restartedB.origin, primary), (r) => r.history.some((e) => e.decoded.kind === 'FeedbackRevoked' &&
            e.raw.transactionHash === revocation.receipt.transactionHash && e.canonicality === 'canonical'), 'revocation ingestion');
          const revoked = await verify(restartedB.origin, primary); requireHistorical(revoked, 'matched', 'revoked');
          await fixture.indexes.stop('B'); await unavailable(`${restartedB.origin}/health`);
          const emptyA = await fixture.indexes.rebuild('A');
          await eventually(() => read(emptyA.origin, primary), (r) => r.coverage.progress === 'synchronized' &&
            r.documentBytes === null && r.event.document.job !== null && BigInt(r.event.document.job.attempts) > 0n, 'empty-DB missing bytes');
          const emptyRebuild = await verify(emptyA.origin, primary);
          if (emptyRebuild.index.documentAvailability !== 'unavailable' || emptyRebuild.historical?.publication.revocation !== 'revoked') {
            throw new Error('empty database falsely recovered unavailable document bytes or lost revocation');
          }
          return { source, failure: { execution: 'failed' as const, completionClaimedOutcome: 'failed' as const, reviewValue: 1 as const,
            messageSend: failure.calls.messageSend, tasksGet: failure.calls.tasksGet }, publications, retained: bothRetained, restarted,
            outages: { provider, cards, documents: docs, indexA }, origins: { initial,
              restarted: { A: restartedA.origin, B: restartedB.origin }, emptyRebuildA: emptyA.origin }, bOnly, reorg, revoked, emptyRebuild };
        });
      }, { feedback: { documentUrls: [`${documentOrigin}/primary`, `${documentOrigin}/suffix`] } });
      return { mode: 'local-fixture', indexSourceCommit: INDEX_SOURCE_COMMIT, ...result,
        cleanup: { ownedResourcesStopped: true }, limitations: [
          'Synthetic signed failure and reviewer opinions; not service quality, independent customer reputation or ranking.',
          'Separate Node readers/processes and PostgreSQL databases share one host; not independent operators or physical failure domains.',
          'Index coverage is self-reported; bounded pagination does not prove all feedback was found.',
          'RPC-derived numbered history and revocation are not cryptographic state proofs or finality.',
          'The private request/acceptance/completion/card bundle is caller-owned, not retained by the Index; missing it leaves interaction evidence incomplete.',
          'The fork suffix is another publication about the same synthetic interaction; no revision selection or sample counting occurs.',
          'Empty A is rebuilt while B is offline; B database is not claimed destroyed. Ephemeral chain and all owned resources stop before return.',
        ] };
    } finally { await stopDocuments(); }
  });
}
