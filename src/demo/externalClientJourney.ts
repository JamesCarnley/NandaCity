import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPublicClient, http } from 'viem';

import { boundedRpcFetch, filterForCity, type City, type ExternalClientConfig,
  type ExternalClientResult } from '../client/externalClient.js';
import { decodeEnvelope } from '../interaction/signatures.js';
import { verifyJourneyEvidence } from './journeyReport.js';
import { withOwnedLifecycle } from './ownedLifecycle.js';
import { withSixServiceFixture } from './sixServiceFixture.js';

const execFileAsync = promisify(execFile);

export type ExternalClientDemoResult = ExternalClientResult & {
  mode: 'local-fixture'; parentVerified: true;
  cleanup: { ownedResourcesStopped: true };
  limitations: string[];
};

/** Parent passes only public configuration and independently rechecks child-exported evidence live. */
export async function runExternalClientDemo(indexCheckout: string, city: City): Promise<ExternalClientDemoResult> {
  const value = await withOwnedLifecycle(async ({ signal }) => withSixServiceFixture(indexCheckout, async (fixture) => {
    const config: ExternalClientConfig = { city, indexOrigins: [fixture.indexOrigins.A, fixture.indexOrigins.B],
      rpcOrigin: fixture.rpcOrigin, cardOrigin: fixture.cardOrigin,
      serviceOrigins: fixture.services.map((service) => new URL(service.serviceUrl).origin),
      domain: fixture.domain };
    const currentModule = fileURLToPath(import.meta.url);
    const built = currentModule.endsWith('.js');
    const script = join(dirname(currentModule), '..', 'client', `externalClientCli.${built ? 'js' : 'ts'}`);
    const { stdout } = await execFileAsync(process.execPath,
      [...(built ? [] : ['--import', 'tsx']), script, '--config', JSON.stringify(config)],
      { cwd: resolve(dirname(currentModule), '../..'), env: { PATH: process.env['PATH'] ?? '' },
        signal, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const child = JSON.parse(stdout) as ExternalClientResult;
    if (child.city !== city || child.childVerified !== true || child.retry?.sameTask !== true ||
        child.retry.taskId !== child.evidence?.task?.id || child.selectedAgentId !== child.evidence.candidate.agent.agentId) {
      throw new Error('child export has inconsistent city, selected agent, or exact retry');
    }
    const request = decodeEnvelope(child.evidence.request).statement.value;
    if (request.kind !== 'request' || request.input.city !== city ||
        request.caller.address.toLowerCase() !== child.callerAddress.toLowerCase() ||
        child.callerAddress.toLowerCase() === fixture.callerAddress.toLowerCase() ||
        fixture.services.some((service) => [service.ownerAddress, service.runtimeAddress]
          .some((address) => address.toLowerCase() === child.callerAddress.toLowerCase()))) {
      throw new Error('child caller is not distinct from fixture caller, owners, and runtime signers');
    }
    const selected = fixture.services.find((service) => service.agent.agentId === child.selectedAgentId);
    if (!selected || selected.city !== city) throw new Error('child selected no owned city service');
    const independentlySelected = fixture.services.filter((service) => service.city === city)
      .sort((a, b) => BigInt(a.agent.agentId) < BigInt(b.agent.agentId) ? -1 : 1)[0];
    if (!independentlySelected || independentlySelected.agent.agentId !== child.selectedAgentId ||
        child.selectionReason !== 'lowest numeric agent ID among three verified city candidates; demo order, not reputation') {
      throw new Error('child selection differs from explicit deterministic demo policy');
    }
    const verifier = createPublicClient({ transport: http(fixture.rpcOrigin,
      { retryCount: 0, timeout: 5_000, fetchFn: boundedRpcFetch }) });
    const report = await verifyJourneyEvidence(child.evidence, verifier, fixture.domain,
      filterForCity(city), fixture.cardOrigin);
    if (!report.evidenceUsable || report.execution !== 'completed' || report.firstBrokenBoundary !== null) {
      throw new Error(`parent recheck failed at ${report.firstBrokenBoundary ?? 'unknown'}`);
    }
    return { ...child, report, mode: 'local-fixture' as const, parentVerified: true as const,
      limitations: [
        'City-authored separate Node client on the same host; not a stock third-party agent or independent operator.',
        'Three synthetic candidates per city; lowest agent ID is a deterministic demo choice, not reputation or quality ranking.',
        'No live venue, event, price, travel, accessibility, or semantic-quality verification.',
        'Owned local chain and Indexes stop at cleanup; exported observations are not durable state proofs.',
      ] };
  }));
  return { ...value, cleanup: { ownedResourcesStopped: true } };
}
