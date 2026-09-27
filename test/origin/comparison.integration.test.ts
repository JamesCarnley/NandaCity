import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { recordedCli, events } from '../discovery/signalHarness.js';

test('real two-Index origin discovery and negative retention survive source/provider/A loss and fresh consumer', { timeout: 180000 }, async (t) => {
  const originalFetch = globalThis.fetch; let chainRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string' && /"(?:jsonrpc|method)"\s*:\s*"(?:2\.0|eth_|net_|web3_)/.test(init.body)) {
      chainRequests++; throw new Error('origin mode attempted chain RPC');
    }
    return originalFetch(input, init);
  });
  const api = await import('../../src/demo/originComparison.js').catch(() => null);
  assert.ok(api, 'actual chain-free two-Index comparison must exist');
  assert.ok(process.env['NANDA_INDEX_CHECKOUT']);
  const result = await api.runOriginComparison({ indexCheckout: process.env['NANDA_INDEX_CHECKOUT']! });
  assert.deepEqual(result.discovery, { A: 1, B: 1 });
  assert.deepEqual(result.retained, { A: 2, B: 2 });
  assert.equal(result.snapshotShape, 'valid');
  assert.equal(result.chainRequests, 0);
  assert.equal(chainRequests, 0);
  assert.deepEqual(result.initial.policy.score, { numerator: '7', denominator: '3' });
  assert.deepEqual(result.fresh.policy, result.initial.policy);
  assert.equal(result.fresh.originAuthority.current, 'observed');
  assert.equal(result.fresh.reviews[1]!.rating, 1);
  assert.equal(result.lost.originAuthority.current, 'unknown'); assert.equal(result.lost.policy.score, null);
  assert.equal(result.rotated.originAuthority.current, 'changed'); assert.equal(result.rotated.policy.score, null);
  assert.equal(result.empty.coverage, 'unavailable'); assert.equal(result.empty.policy.score, null);
  assert.equal(result.migrated.town, 'unsupported-not-tested');
  assert.equal(result.sameRunningDatabase, true);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`owned origin ${signal} cleans actual Index processes, database, TLS and runtime stores`,
  { timeout: 120000 }, async () => {
    const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
    const endpoint = execFileSync(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
    assert.match(endpoint, /^unix:\/\//);
    const dockerArgs = ['--host', endpoint];
    const containers = () => execFileSync(docker, [...dockerArgs, 'ps', '-q', '--no-trunc'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    const beforeContainers = containers();
    const temporary = async () => (await readdir(tmpdir())).filter((name) => /^city-origin-(tls|comparison)-/.test(name)).sort();
    const beforeTemporary = await temporary();
    const { directory, log } = await recordedCli({ docker, stage: 'none' });
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const wrapper = join(directory, 'node');
    await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = dist/server.js ]; then\n` +
      `printf '{"stage":"index","pid":%s,"origin":"%s","identityConfig":"%s","feedbackConfig":"%s"}\\n' "$$" "$API_BASE_URL" "$ERC8004_IDENTITY_CONFIG" "$ERC8004_FEEDBACK_CONFIG" >> ${quote(log)}\nfi\nexec ${quote(process.execPath)} "$@"\n`);
    await chmod(wrapper, 0o755);
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../src/demo/originComparison.ts', import.meta.url))], {
      env: { PATH: `${directory}:${process.env['PATH'] ?? ''}`, NANDA_INDEX_CHECKOUT: process.env['NANDA_INDEX_CHECKOUT']! },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { output += b.toString(); if (output.includes('Origin comparison: indexes-ready')) child.kill(signal); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
      assert.equal(child.signalCode, signal, output);
      const recorded = await events(log);
      const indexes = recorded.filter((entry) => entry.stage === 'index') as (typeof recorded[number] & { identityConfig: string; feedbackConfig: string })[];
      assert.equal(indexes.length, 2);
      for (const index of indexes) {
        assert.equal(index.identityConfig, ''); assert.equal(index.feedbackConfig, '');
        assert.throws(() => process.kill(index.pid!, 0));
        await assert.rejects(fetch(`${index.origin}/health`, { signal: AbortSignal.timeout(500) }));
      }
      assert.deepEqual(containers(), beforeContainers);
      assert.deepEqual(await temporary(), beforeTemporary);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
  });

test('built origin command spawns its built consumer and emits only public findings', { timeout: 120000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../../dist/demo/originComparison.js', import.meta.url))], {
      env: { PATH: process.env['PATH'] ?? '', NANDA_INDEX_CHECKOUT: process.env['NANDA_INDEX_CHECKOUT']! },
      timeout: 90000, maxBuffer: 256000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.fresh.policy.score, { numerator: '7', denominator: '3' });
  for (const privateField of ['payloadBase64', 'bundleBase64', 'privateKey', 'requestEnvelope', 'cardBytes']) assert.equal(stdout.includes(privateField), false);
});
