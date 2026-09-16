import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Abi, Hex } from 'viem';

const require = createRequire(import.meta.url);
const solc = require('solc') as {
  compile(
    input: string,
    callbacks: { import(path: string): { contents?: string; error?: string } },
  ): string;
  version(): string;
};

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const identitySourceUnit = 'vendor/erc-8004/IdentityRegistryUpgradeable.sol';
const minimalSourceUnit = 'vendor/erc-8004/HardhatMinimalUUPS.sol';
const proxySourceUnit = '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

const expectedSourceHashes = {
  [identitySourceUnit]:
    '18c8ca8c88493b46e54d000c96eaf7470d1f9dbfe55493fd7fa923bae543ff75',
  [minimalSourceUnit]:
    '9d3b152b88733e61f40ae2de775f7448001b73d9165f23ee8bbe5dd88cd042aa',
  [proxySourceUnit]:
    'a06fe97082355529c1da9076ea6c4518875ca9fdb1a4fa1e194c35cff21b29a1',
} as const;

const expectedArtifactHashes = {
  IdentityRegistryUpgradeable:
    'c0e4f95ece5aef9020e27463e849a96ebcf802f252d8d5fc72f7dbe3ec1739c2',
  HardhatMinimalUUPS:
    '6d7c978d16accfd97118f9f715dbee54cd04ed23a1fde5131a62d434e2a0220f',
  ERC1967Proxy:
    '5271c17a982ad7edc3441b1e6d8d69c723e5ffc96f1cd0ff99f04e743bc5c381',
} as const;

type SolcContract = {
  abi?: Abi;
  evm?: {
    bytecode?: { object?: string };
    deployedBytecode?: { object?: string };
  };
};

type SolcOutput = {
  contracts?: Record<string, Record<string, SolcContract>>;
  errors?: Array<{
    severity?: string;
    formattedMessage?: string;
    message?: string;
  }>;
};

export type ContractArtifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
};

export type ReferenceProvenance = {
  referenceCommit: string;
  solcVersion: string;
  solcTmpVersion: string;
  openZeppelinVersion: string;
  compilerSettings: {
    evmVersion: 'shanghai';
    optimizer: { enabled: true; runs: 200 };
    viaIR: true;
  };
  sourceSha256: Record<string, string>;
  artifactSha256: Record<string, string>;
};

export type ReferenceArtifacts = {
  identityRegistry: ContractArtifact;
  minimalUups: ContractArtifact;
  erc1967Proxy: ContractArtifact;
  provenance: ReferenceProvenance;
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readSource(sourceUnit: string): string {
  const path = sourceUnit.startsWith('@openzeppelin/')
    ? join(repositoryRoot, 'node_modules', sourceUnit)
    : join(repositoryRoot, sourceUnit);
  return readFileSync(path, 'utf8');
}

function assertPinnedInputs(entrySources: Record<string, string>): void {
  const solcVersion = solc.version();
  if (!solcVersion.startsWith('0.8.24+commit.e11b9ed9.')) {
    throw new Error(`expected solc 0.8.24, received ${solcVersion}`);
  }

  const solcTmpPackage = JSON.parse(
    readFileSync(
      require.resolve('tmp/package.json', {
        paths: [join(repositoryRoot, 'node_modules', 'solc')],
      }),
      'utf8',
    ),
  ) as { version?: string };
  if (solcTmpPackage.version !== '0.2.7') {
    throw new Error(
      `expected the solc-scoped tmp override at 0.2.7, received ${solcTmpPackage.version ?? 'unknown'}`,
    );
  }

  for (const [sourceUnit, expectedHash] of Object.entries(expectedSourceHashes)) {
    const source = entrySources[sourceUnit];
    if (source === undefined) {
      throw new Error(`missing pinned source ${sourceUnit}`);
    }
    if (!source.startsWith('// SPDX-License-Identifier: MIT')) {
      throw new Error(`source notice is missing from ${sourceUnit}`);
    }
    const actualHash = sha256(source);
    if (actualHash !== expectedHash) {
      throw new Error(
        `source hash mismatch for ${sourceUnit}: expected ${expectedHash}, received ${actualHash}`,
      );
    }
  }

  for (const packageName of [
    '@openzeppelin/contracts',
    '@openzeppelin/contracts-upgradeable',
  ]) {
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { version?: string };
    if (packageJson.version !== '5.4.0') {
      throw new Error(`expected ${packageName} 5.4.0, received ${packageJson.version ?? 'unknown'}`);
    }
  }
}

function toArtifact(
  output: SolcOutput,
  sourceUnit: string,
  contractName: string,
): ContractArtifact {
  const contract = output.contracts?.[sourceUnit]?.[contractName];
  const bytecode = contract?.evm?.bytecode?.object;
  const deployedBytecode = contract?.evm?.deployedBytecode?.object;
  if (
    contract?.abi === undefined ||
    bytecode === undefined ||
    bytecode === '' ||
    deployedBytecode === undefined ||
    deployedBytecode === ''
  ) {
    throw new Error(`compiler did not produce ${sourceUnit}:${contractName}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(bytecode) || !/^[0-9a-fA-F]+$/.test(deployedBytecode)) {
    throw new Error(`compiler produced malformed bytecode for ${contractName}`);
  }

  return {
    abi: contract.abi,
    bytecode: `0x${bytecode}`,
    deployedBytecode: `0x${deployedBytecode}`,
  };
}

function artifactHash(artifact: ContractArtifact): string {
  return sha256(
    JSON.stringify({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
    }),
  );
}

export function compileReferenceContracts(): ReferenceArtifacts {
  const entrySources = Object.fromEntries(
    Object.keys(expectedSourceHashes).map((sourceUnit) => [sourceUnit, readSource(sourceUnit)]),
  );
  assertPinnedInputs(entrySources);

  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(
      Object.entries(entrySources).map(([sourceUnit, content]) => [sourceUnit, { content }]),
    ),
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  } as const;

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import(importPath) {
        try {
          return { contents: readSource(importPath) };
        } catch {
          return { error: `dependency source not found: ${importPath}` };
        }
      },
    }),
  ) as SolcOutput;
  const errors =
    output.errors?.filter((entry) => entry.severity === 'error').map(
      (entry) => entry.formattedMessage ?? entry.message ?? 'unknown compiler error',
    ) ?? [];
  if (errors.length > 0) {
    throw new Error(`reference contract compilation failed:\n${errors.join('\n')}`);
  }

  const identityRegistry = toArtifact(
    output,
    identitySourceUnit,
    'IdentityRegistryUpgradeable',
  );
  const minimalUups = toArtifact(output, minimalSourceUnit, 'HardhatMinimalUUPS');
  const erc1967Proxy = toArtifact(output, proxySourceUnit, 'ERC1967Proxy');
  const artifactSha256 = {
    IdentityRegistryUpgradeable: artifactHash(identityRegistry),
    HardhatMinimalUUPS: artifactHash(minimalUups),
    ERC1967Proxy: artifactHash(erc1967Proxy),
  };
  for (const [contractName, expectedHash] of Object.entries(expectedArtifactHashes)) {
    const actualHash = artifactSha256[contractName as keyof typeof artifactSha256];
    if (actualHash !== expectedHash) {
      throw new Error(
        `artifact hash mismatch for ${contractName}: expected ${expectedHash}, received ${actualHash}`,
      );
    }
  }

  return {
    identityRegistry,
    minimalUups,
    erc1967Proxy,
    provenance: {
      referenceCommit: 'b9e466c250744a7e06b13dff9d3c2844ed64f825',
      solcVersion: solc.version(),
      solcTmpVersion: '0.2.7',
      openZeppelinVersion: '5.4.0',
      compilerSettings: {
        evmVersion: 'shanghai',
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
      },
      sourceSha256: Object.fromEntries(
        Object.entries(entrySources).map(([sourceUnit, content]) => [sourceUnit, sha256(content)]),
      ),
      artifactSha256,
    },
  };
}
