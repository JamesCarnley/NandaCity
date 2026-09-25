import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCli } from '../../src/cli.js';
import type { ExternalClientConfig, ExternalClientResult } from '../../src/client/externalClient.js';
import { withSixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import { verifyJourneyEvidence } from '../../src/demo/journeyReport.js';
import { filterForCity } from '../../src/client/externalClient.js';

const execFileAsync = promisify(execFile);

async function child(config: ExternalClientConfig): Promise<ExternalClientResult> {
  const { stdout } = await execFileAsync(process.execPath,
    ['--import', 'tsx', 'src/client/externalClientCli.ts', '--config', JSON.stringify(config)],
    { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' }, timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(stdout) as ExternalClientResult;
}

test('separate client discovers and invokes a Chicago specialist', { timeout: 180_000 }, async () => {
  const checkout = process.env['NANDA_INDEX_CHECKOUT'];
  assert.ok(checkout);
  let output = '';
  let errors = '';
  const status = await runCli(['external-client', 'demo', '--index-checkout', checkout,
    '--city', 'Chicago', '--json'], { write: (chunk) => { output += chunk; return true; } },
  { write: (chunk) => { errors += chunk; return true; } });
  assert.equal(status, 0, errors);
  const result = JSON.parse(output) as Record<string, unknown>;
  assert.equal(result['city'], 'Chicago');
  assert.equal(result['parentVerified'], true);
  assert.equal(result['childVerified'], true);
});

test('fresh Boston child succeeds, bad authority/origins fail, and child failure unwinds the fixture',
  { timeout: 180_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout);
    let ownedOrigins: string[] = [];
    let storeDirectories: string[] = [];
    await assert.rejects(withSixServiceFixture(checkout, async (fixture) => {
      ownedOrigins = [fixture.rpcOrigin, fixture.cardOrigin,
        ...Object.values(fixture.indexOrigins),
        ...fixture.services.map((service) => service.serviceUrl)];
      storeDirectories = fixture.services.map((service) => service.storeDirectory);
      const config: ExternalClientConfig = { city: 'Boston',
        indexOrigins: [fixture.indexOrigins.A, fixture.indexOrigins.B],
        rpcOrigin: fixture.rpcOrigin, cardOrigin: fixture.cardOrigin,
        serviceOrigins: fixture.services.map((service) => new URL(service.serviceUrl).origin),
        domain: fixture.domain };
      const result = await child(config);
      assert.equal(result.city, 'Boston');
      assert.equal(result.report.evidenceUsable, true);
      assert.equal(result.retry.taskId, result.evidence.task.id);
      assert.notEqual(result.callerAddress.toLowerCase(), fixture.callerAddress.toLowerCase());
      assert.ok(fixture.services.every((service) =>
        result.callerAddress.toLowerCase() !== service.ownerAddress.toLowerCase() &&
        result.callerAddress.toLowerCase() !== service.runtimeAddress.toLowerCase()));

      await assert.rejects(child({ ...config,
        domain: { ...config.domain, chainId: config.domain.chainId + 1 } }),
      /independent RPC is not selected chain/);
      await assert.rejects(child({ ...config,
        domain: { ...config.domain, registry: '0x0000000000000000000000000000000000000001' } }),
      /candidate outside client-selected identity domain/);
      await assert.rejects(child({ ...config, cardOrigin: fixture.indexOrigins.A }),
        /card URL outside owned exact loopback allowlist/);
      await assert.rejects(child({ ...config, serviceOrigins: [fixture.indexOrigins.A] }),
        /selected service URL outside exact configured origin/);

      const tampered = structuredClone(result.evidence);
      const bytes = Buffer.from(tampered.answerBase64!, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      tampered.answerBase64 = bytes.toString('base64');
      const report = await verifyJourneyEvidence(tampered, fixture.chain, fixture.domain,
        filterForCity('Boston'), fixture.cardOrigin);
      assert.equal(report.evidenceUsable, false);
      assert.equal(report.firstBrokenBoundary, 'answer');
      // Let a real child-process failure escape the callback. The fixture owner
      // must unwind its services, Indexes, Anvil and local stores.
      await child({ ...config, domain: { ...config.domain, chainId: config.domain.chainId + 1 } });
    }), /independent RPC is not selected chain/);
    for (const origin of ownedOrigins) {
      await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
    }
    for (const directory of storeDirectories) await assert.rejects(stat(directory), { code: 'ENOENT' });
  });
