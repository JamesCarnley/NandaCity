import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/compilerReuseWorker.ts', import.meta.url));

test('reuses only fully validated compiler output and never exposes stale or mutable artifacts', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', worker, 'contracts'],
    { timeout: 300_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(stderr, '');
  const result = JSON.parse(stdout) as {
    compileCalls: number;
    transitiveSource: string;
    artifactSha256: Record<string, string>;
  };
  assert.equal(result.compileCalls, 11);
  assert.match(result.transitiveSource, /node_modules\/.*\.sol$/);
  assert.deepEqual(result.artifactSha256, {
    IdentityRegistryUpgradeable: 'c0e4f95ece5aef9020e27463e849a96ebcf802f252d8d5fc72f7dbe3ec1739c2',
    ReputationRegistryUpgradeable: '2301f7165ecfc4978e9ae2cbce6d75a12d8dc20769eda11be68eb215c1dcdc83',
    HardhatMinimalUUPS: '6d7c978d16accfd97118f9f715dbee54cd04ed23a1fde5131a62d434e2a0220f',
    ERC1967Proxy: '5271c17a982ad7edc3441b1e6d8d69c723e5ffc96f1cd0ff99f04e743bc5c381',
  });
});
