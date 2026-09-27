import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAddress, padHex, zeroAddress, type Abi, type Address, type Hash, type Hex } from 'viem';
import type { ContractNetworkConfig, ContractNetworksConfig } from '@safe-global/protocol-kit';
import { assertLocalWriteRpcUrl } from '../demo/anvil.js';

const vendor = join(dirname(fileURLToPath(import.meta.url)), '../../vendor/safe-contracts-1.4.1');
const pins = {
  safeSingleton: ['Safe.sol/Safe.json', 'c36a5e99bc3f25c2d75ac5f7920b679200b3ce617c0d26e674b1321dbc6b0bdf'],
  safeProxyFactory: ['proxies/SafeProxyFactory.sol/SafeProxyFactory.json', 'f77ccb60e95345e6583216e82feb5430098679d62aa4aeda7388df3831476997'],
  safeProxy: ['proxies/SafeProxy.sol/SafeProxy.json', 'b05eaeaf7278097e52a9e9b38410de2a812c23fa3622373473e73eaa19646ecd'],
  fallbackHandler: ['handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json', 'cd4f07b0984afb35dc9699e911eff240b11599fd78e4be12be64b401e5fd57bb'],
  multiSend: ['libraries/MultiSend.sol/MultiSend.json', '379f3d2133eee9b8742888749dc5caf3a1f195b37cd21013bff1d00f9e806470'],
  multiSendCallOnly: ['libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json', '1cdf585a317b17e50e15c2cde9a41fa5a16b1579076a8a209005924b3cc2a8f2'],
} as const;
export type SafeArtifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex };
export type SupportName = Exclude<keyof typeof pins, 'safeProxy'>;
export const supportNames: readonly SupportName[] = [
  'safeSingleton', 'safeProxyFactory', 'fallbackHandler', 'multiSend', 'multiSendCallOnly',
];
export type SafeNetworkConfig = {
  chainId: number; genesisHash: Hash; rpcUrl: string; safeVersion: '1.4.1';
  contracts: Record<SupportName, { address: Address; abi: Abi }>;
};
export type SafeAccountDeploymentConfig = {
  owners: [Address, Address]; threshold: 1; saltNonce: string;
  fallbackHandler: Address; predictedAddress: Address;
};
export type SafeAccountInput = Omit<SafeAccountDeploymentConfig, 'predictedAddress'> & { predictedAddress?: Address };

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function loadSafeArtifacts(): Record<keyof typeof pins, SafeArtifact> {
  return Object.fromEntries(Object.entries(pins).map(([name, [path, hash]]) => {
    const bytes = readFileSync(join(vendor, 'build/artifacts/contracts', path));
    if (sha(bytes) !== hash) throw new Error('Safe artifact hash mismatch');
    const artifact = JSON.parse(bytes.toString()) as SafeArtifact & { linkReferences: object; deployedLinkReferences: object };
    if (Object.keys(artifact.linkReferences).length || Object.keys(artifact.deployedLinkReferences).length) {
      throw new Error('Safe artifacts must not require linking');
    }
    return [name, artifact];
  })) as unknown as Record<keyof typeof pins, SafeArtifact>;
}

/** Offline byte/source/metadata checks, not an independent compiler rebuild. */
export function checkSafeVendor(): void {
  loadSafeArtifacts();
  const inputBytes = readFileSync(join(vendor, 'compiler-input.json'));
  if (sha(inputBytes) !== '993b5937c36f9a479df8771febc0c2a040a00c90b83b6202652803db2bb6cc3a') {
    throw new Error('Safe compiler input hash mismatch');
  }
  const input = JSON.parse(inputBytes.toString());
  const provenance = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
  const build = provenance.buildInfo['package/build/artifacts/build-info/fac0757097c452567d4b64f14075f2c2.json'];
  if (build.sha256 !== '652f67c5cd5ef0bb9e6b160b08a1c9521d8f34c6c6afffc65b0b721bdb647e96' ||
      build.solcLongVersion !== '0.7.6+commit.7338295f' || build.solcVersion !== '0.7.6' ||
      input.settings.optimizer.enabled !== false || Object.keys(input.sources).length !== 53 ||
      provenance.archive.sha256 !== 'aa9793c1b0c4a298b977559181e0ac5fcdc89bf0ec993a6e24d76afc51ed0713' ||
      provenance.archive.publishedGitHead !== 'aa14911666deb13cdbbe37c37253a55918525437') {
    throw new Error('Safe source/compiler provenance mismatch');
  }
  for (const [path, source] of Object.entries(input.sources) as [string, { content: string }][]) {
    // Full source hashes preserve notices exactly, including the two upstream
    // source units that did not contain an SPDX header. Do not modify sources.
    if (sha(source.content) !== provenance.sourceSha256[path]) {
      throw new Error('Safe source hash or notice mismatch');
    }
  }
  for (const [name, [path, hash]] of Object.entries(pins)) {
    const entry = provenance.artifacts.find((a: { path: string }) => a.path === `build/artifacts/contracts/${path}`);
    if (!entry || entry.sha256 !== hash) throw new Error('Safe artifact provenance mismatch');
    const refs = Object.values(entry.immutableReferences).flat();
    if (JSON.stringify(refs) !== (name === 'multiSend' ? '[{"length":32,"start":224}]' : '[]')) {
      throw new Error('Safe immutable metadata mismatch');
    }
  }
  if (sha(readFileSync(join(vendor, 'LICENSE'))) !== 'da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768' ||
      sha(readFileSync(join(vendor, 'COPYING'))) !== '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986') {
    throw new Error('Safe license text mismatch');
  }
}

export function expectedSupportRuntime(name: SupportName, address: Address): Hex {
  const runtime = loadSafeArtifacts()[name].deployedBytecode;
  // solc 0.7.6 published immutableReferences: self-address, 32 bytes at offset 224.
  return name === 'multiSend'
    ? `${runtime.slice(0, 2 + 224 * 2)}${padHex(address, { size: 32 }).slice(2).toLowerCase()}${runtime.slice(2 + 256 * 2)}` as Hex
    : runtime;
}

export function exactKeys(value: object, keys: readonly string[]): void {
  if (value === null || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('unexpected configuration fields');
}
export function requireAddress(value: string): asserts value is Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress) {
    throw new Error('expected a nonzero address');
  }
}
export function validateNetwork(network: SafeNetworkConfig): void {
  // Must precede any provider construction/request at every adapter write seam.
  assertLocalWriteRpcUrl(network.rpcUrl);
  exactKeys(network, ['chainId', 'genesisHash', 'rpcUrl', 'safeVersion', 'contracts']);
  if (network.chainId !== 31337 || network.safeVersion !== '1.4.1' || !/^0x[0-9a-fA-F]{64}$/.test(network.genesisHash)) {
    throw new Error('Safe network requires local chain 31337, genesis hash and version 1.4.1');
  }
  exactKeys(network.contracts, supportNames);
  const artifacts = loadSafeArtifacts();
  const addresses = new Set<string>();
  for (const name of supportNames) {
    const contract = network.contracts[name];
    exactKeys(contract, ['address', 'abi']); requireAddress(contract.address);
    if (JSON.stringify(contract.abi) !== JSON.stringify(artifacts[name].abi)) throw new Error('Safe support ABI mismatch');
    addresses.add(contract.address.toLowerCase());
  }
  if (addresses.size !== 5) throw new Error('Safe support addresses must be distinct');
}
export function validateAccount(network: SafeNetworkConfig, account: SafeAccountInput): void {
  exactKeys(account, ['owners', 'threshold', 'saltNonce', 'fallbackHandler',
    ...(account.predictedAddress === undefined ? [] : ['predictedAddress'])]);
  if (!Array.isArray(account.owners) || account.owners.length !== 2) throw new Error('Safe requires exactly two owners');
  account.owners.forEach(requireAddress);
  if (account.owners[0].toLowerCase() === account.owners[1].toLowerCase() || account.threshold !== 1) {
    throw new Error('Safe requires two distinct owners and threshold one');
  }
  if (typeof account.saltNonce !== 'string' || !/^(0|[1-9][0-9]*)$/.test(account.saltNonce) ||
      account.saltNonce.length > 78 || BigInt(account.saltNonce) >= 1n << 256n) throw new Error('invalid canonical salt nonce');
  requireAddress(account.fallbackHandler);
  if (account.fallbackHandler.toLowerCase() !== network.contracts.fallbackHandler.address.toLowerCase()) {
    throw new Error('Safe fallback handler mismatch');
  }
  if (account.predictedAddress !== undefined) requireAddress(account.predictedAddress);
}
export function protocolContractNetworks(network: SafeNetworkConfig): ContractNetworksConfig {
  validateNetwork(network);
  const config: ContractNetworkConfig = {};
  for (const name of supportNames) Object.assign(config, {
    [`${name}Address`]: network.contracts[name].address,
    [`${name}Abi`]: network.contracts[name].abi,
  });
  return { [network.chainId]: config };
}
