import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, custom, type Hex, type PublicClient } from 'viem';

import type { ReferenceArtifacts } from '../../../src/demo/contracts.js';
import type { ReputationDeploymentProvenance } from '../../../src/feedback/reputationActivation.js';

type Solc = {
  compile(
    input: string,
    callbacks: { import(path: string): { contents?: string; error?: string } },
  ): string;
  version(): string;
};

type ReadBehavior =
  | { kind: 'normal' }
  | { kind: 'append'; path: string; suffix: string }
  | { kind: 'replace'; path: string; contents: string }
  | { kind: 'missing'; path: string }
  | { kind: 'delay'; delayMs: number; abort?: AbortController; used: boolean };

type CompileBehavior = 'normal' | 'corrupt-artifact';

const require = createRequire(import.meta.url);
const mutableFs = require('node:fs') as {
  readFileSync: typeof import('node:fs').readFileSync;
};
const solc = require('solc') as Solc;
const originalReadFileSync = mutableFs.readFileSync as unknown as (...args: unknown[]) => unknown;
const originalCompile = solc.compile;
const originalVersion = solc.version;
const actualVersion = originalVersion();
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const entryPaths = new Set([
  join(repositoryRoot, 'vendor/erc-8004/IdentityRegistryUpgradeable.sol'),
  join(repositoryRoot, 'vendor/erc-8004/ReputationRegistryUpgradeable.sol'),
  join(repositoryRoot, 'vendor/erc-8004/HardhatMinimalUUPS.sol'),
  join(repositoryRoot, 'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'),
]);
const solidityReads = new Set<string>();

let readBehavior: ReadBehavior = { kind: 'normal' };
let compileBehavior: CompileBehavior = 'normal';
let versionOverride: string | undefined;
let compileCalls = 0;
let postCompileDelayMs = 0;

function delay(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    // The production operation is synchronous; this child-local delay makes
    // elapsed-budget tests deterministic without changing production clocks.
  }
}

mutableFs.readFileSync = ((...args: unknown[]) => {
  const path = typeof args[0] === 'string' ? args[0] : undefined;
  if (path !== undefined && readBehavior.kind === 'missing' && path === readBehavior.path) {
    throw new Error(`isolated missing source: ${path}`);
  }
  const value = originalReadFileSync(...args);
  if (path?.endsWith('.sol')) solidityReads.add(path);
  if (path !== undefined && readBehavior.kind === 'delay' && path.endsWith('.sol') && !readBehavior.used) {
    readBehavior.used = true;
    readBehavior.abort?.abort();
    delay(readBehavior.delayMs);
  }
  if (path !== undefined && readBehavior.kind === 'append' && path === readBehavior.path) {
    assert.equal(typeof value, 'string');
    return `${value}${readBehavior.suffix}`;
  }
  if (path !== undefined && readBehavior.kind === 'replace' && path === readBehavior.path) {
    return readBehavior.contents;
  }
  return value;
}) as typeof mutableFs.readFileSync;
syncBuiltinESMExports();

solc.version = () => versionOverride ?? originalVersion();
solc.compile = (input, callbacks) => {
  compileCalls++;
  const raw = originalCompile(input, callbacks);
  if (postCompileDelayMs > 0) {
    const milliseconds = postCompileDelayMs;
    postCompileDelayMs = 0;
    delay(milliseconds);
  }
  if (compileBehavior === 'normal') return raw;
  const output = JSON.parse(raw) as {
    contracts?: Record<string, Record<string, {
      evm?: { bytecode?: { object?: string } };
    }>>;
  };
  const artifact = output.contracts?.['vendor/erc-8004/IdentityRegistryUpgradeable.sol']
    ?.IdentityRegistryUpgradeable;
  assert.ok(artifact?.evm?.bytecode);
  artifact.evm.bytecode.object = '00';
  return JSON.stringify(output);
};

function normalReads(): void {
  readBehavior = { kind: 'normal' };
}

function mutateReturnedArtifacts(artifacts: ReferenceArtifacts): void {
  const abi = artifacts.identityRegistry.abi as unknown as Array<Record<string, unknown>>;
  const named = abi.find((entry) => typeof entry.name === 'string');
  assert.ok(named);
  named.name = 'mutated-by-caller';
  artifacts.provenance.compilerSettings.optimizer.runs = 1 as 200;
  artifacts.provenance.sourceSha256['caller-mutation'] = 'not-a-source-hash';
}

async function runContracts(): Promise<void> {
  const { compileReferenceContracts } = await import('../../../src/demo/contracts.js');

  const cold = compileReferenceContracts();
  const expected = structuredClone(cold);
  assert.equal(compileCalls, 1, 'the first call must execute the real compiler once');
  mutateReturnedArtifacts(cold);
  const hot = compileReferenceContracts();
  assert.equal(compileCalls, 1, 'an unchanged second call must reuse validated compiler output');
  assert.deepEqual(hot, expected, 'caller mutation must not reach the private template');
  assert.notStrictEqual(hot, cold);
  assert.notStrictEqual(hot.identityRegistry.abi, cold.identityRegistry.abi);
  assert.notStrictEqual(hot.provenance.sourceSha256, cold.provenance.sourceSha256);

  const transitivePath = [...solidityReads].find(
    (path) => path.endsWith('.sol') && !entryPaths.has(path),
  );
  assert.ok(transitivePath, 'the real compiler must consume a transitive source');

  const identityPath = join(repositoryRoot, 'vendor/erc-8004/IdentityRegistryUpgradeable.sol');
  readBehavior = { kind: 'append', path: identityPath, suffix: '\n' };
  assert.throws(() => compileReferenceContracts(), /source hash mismatch/);
  assert.equal(compileCalls, 1, 'entry drift must fail before compilation');
  normalReads();
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 2, 'restored entry input must recover through a real compile');

  const openZeppelinPackage = join(
    repositoryRoot,
    'node_modules/@openzeppelin/contracts/package.json',
  );
  const packageValue = JSON.parse(originalReadFileSync(openZeppelinPackage, 'utf8') as string) as {
    version: string;
  };
  readBehavior = {
    kind: 'replace',
    path: openZeppelinPackage,
    contents: JSON.stringify({ ...packageValue, version: '5.4.1-isolated-drift' }),
  };
  assert.throws(() => compileReferenceContracts(), /expected @openzeppelin\/contracts 5\.4\.0/);
  assert.equal(compileCalls, 2, 'package drift must fail before compilation');
  normalReads();
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 3, 'restored package input must recover through a real compile');

  versionOverride = `${actualVersion}-isolated-drift`;
  const compilerDrift = compileReferenceContracts();
  assert.equal(compileCalls, 4, 'full compiler-version drift must invalidate the memo');
  assert.equal(compilerDrift.provenance.solcVersion, versionOverride);
  versionOverride = undefined;
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 5, 'restoring the full compiler version must compile again');

  readBehavior = {
    kind: 'append',
    path: transitivePath,
    suffix: '\nthis is deliberately invalid Solidity;\n',
  };
  assert.throws(() => compileReferenceContracts(), /reference contract compilation failed/);
  assert.equal(compileCalls, 6, 'changed transitive bytes must invalidate and compile');
  normalReads();
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 7, 'restoring a changed transitive source must compile again');

  readBehavior = { kind: 'missing', path: transitivePath };
  assert.throws(() => compileReferenceContracts(), /reference contract compilation failed/);
  assert.equal(compileCalls, 8, 'a missing transitive source must not return stale output');
  normalReads();
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 9, 'restoring a missing transitive source must compile again');

  versionOverride = `${actualVersion}-isolated-validation-failure`;
  compileBehavior = 'corrupt-artifact';
  assert.throws(() => compileReferenceContracts(), /artifact hash mismatch/);
  assert.equal(compileCalls, 10, 'invalid compiler output must be validated and rejected');
  versionOverride = undefined;
  compileBehavior = 'normal';
  assert.deepEqual(compileReferenceContracts(), expected);
  assert.equal(compileCalls, 11, 'a validation failure must not retain partial output');

  process.stdout.write(JSON.stringify({
    compileCalls,
    transitiveSource: relative(repositoryRoot, transitivePath),
    artifactSha256: expected.provenance.artifactSha256,
  }));
}

type DeadlineInput = {
  provenance: ReputationDeploymentProvenance;
  observation: { blockNumber: string; blockHash: Hex };
};

async function runDeadlines(serialized: string | undefined): Promise<void> {
  assert.ok(serialized, 'deadline input is required');
  const parsed = JSON.parse(serialized) as DeadlineInput;
  const { readReputationActivation } = await import('../../../src/feedback/reputationActivation.js');
  let rpcCalls = 0;
  const client = createPublicClient({
    transport: custom({
      async request() {
        rpcCalls++;
        throw new Error('deadline worker must stop before RPC');
      },
    }, { retryCount: 0 }),
  }) as PublicClient;
  const input = {
    client,
    provenance: parsed.provenance,
    observation: {
      blockNumber: BigInt(parsed.observation.blockNumber),
      blockHash: parsed.observation.blockHash,
    },
  };

  postCompileDelayMs = 2_100;
  const cold = await readReputationActivation({ ...input, limits: { totalTimeoutMs: 2_000 } });
  assert.equal(cold.activation, 'unavailable');
  assert.ok(cold.diagnostics.includes('total-timeout'));
  assert.equal(compileCalls, 1, 'the fresh process must execute a real cold compilation');
  assert.equal(rpcCalls, 0);
  const coldSummary = { compileCalls, rpcCalls, diagnostic: 'total-timeout' };

  readBehavior = { kind: 'delay', delayMs: 600, used: false };
  const warm = await readReputationActivation({ ...input, limits: { totalTimeoutMs: 500 } });
  assert.equal(warm.activation, 'unavailable');
  assert.ok(warm.diagnostics.includes('total-timeout'));
  assert.equal(compileCalls, 1, 'warm validation must not compile unchanged inputs');
  assert.equal(rpcCalls, 0);
  const warmSummary = { compileCalls, rpcCalls, diagnostic: 'total-timeout' };

  const controller = new AbortController();
  readBehavior = { kind: 'delay', delayMs: 600, abort: controller, used: false };
  const cancelled = await readReputationActivation({
    ...input,
    limits: { totalTimeoutMs: 500 },
    signal: controller.signal,
  });
  assert.equal(cancelled.activation, 'unavailable');
  assert.ok(cancelled.diagnostics.includes('cancelled'));
  assert.equal(cancelled.diagnostics.includes('total-timeout'), false);
  assert.equal(compileCalls, 1, 'cancellation during warm validation must not compile');
  assert.equal(rpcCalls, 0);

  process.stdout.write(JSON.stringify({
    cold: coldSummary,
    warm: warmSummary,
    cancelled: { compileCalls, rpcCalls, diagnostic: 'cancelled' },
  }));
}

const mode = process.argv[2];
if (mode === 'contracts') {
  await runContracts();
} else if (mode === 'deadlines') {
  await runDeadlines(process.argv[3]);
} else {
  throw new Error(`unknown compiler reuse worker mode: ${mode ?? 'missing'}`);
}
