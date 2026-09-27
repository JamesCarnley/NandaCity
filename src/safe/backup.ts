import { encryptKeystoreJson, decryptKeystoreJson } from 'ethers/wallet';
import { privateKeyToAccount } from 'viem/accounts';
import { isDeepStrictEqual } from 'node:util';
import { createPublicClient, http, type Address, type Hash, type Hex } from 'viem';
import { readSafeAccount, readSafeRegistryConfiguration } from './adapter.js';
import { exactKeys, validateAccount, validateNetwork, type SafeAccountDeploymentConfig, type SafeNetworkConfig } from './contracts.js';
import type { IdentityContinuityDomain } from '../identity/continuity.js';
import { decodeRegistration, digestBytes } from '../identity/profile.js';
import { readIdentitySnapshot } from '../identity/registry.js';
import { verifyProfile } from '../identity/verify.js';
import { readPrivateFile, writePrivateFile } from './privateFile.js';

const rejected = () => new Error('backup rejected');
export const BACKUP_PASSWORD_INSTRUCTIONS = 'Password text uses Unicode NFKC, with 1–1024 UTF-8 bytes before and after normalization. Whitespace and case remain significant. No alternative interpretation is retried. Raw-byte importers may need the normalized text; universal wallet import is not claimed.';
export function normalizeBackupPassword(value: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.length || Buffer.byteLength(value, 'utf8') > 1024) throw rejected();
  const normalized = value.normalize('NFKC');
  if (!normalized.length || Buffer.byteLength(normalized, 'utf8') > 1024) throw rejected();
  return normalized;
}

/** Parse bounded JSON while rejecting decoded duplicate/case-colliding keys at every depth. */
function unambiguousJSON(text: string): unknown {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 65536) throw rejected();
  let offset = 0;
  const whitespace = () => { while (/^[\t\r\n ]$/.test(text[offset] ?? '')) offset++; };
  const string = () => {
    const start = offset++; let escaped = false;
    for (; offset < text.length; offset++) {
      const c = text[offset];
      if (c === '"' && !escaped) { offset++; return JSON.parse(text.slice(start, offset)) as string; }
      escaped = c === '\\' && !escaped;
    }
    throw rejected();
  };
  const value = (depth: number): void => {
    if (depth > 8) throw rejected(); whitespace();
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace(); if (text[offset] !== '"') throw rejected();
        const key = string().toLowerCase(); if (keys.has(key)) throw rejected(); keys.add(key);
        whitespace(); if (text[offset++] !== ':') throw rejected(); value(depth + 1); whitespace();
        const next = text[offset++]; if (next === '}') return; if (next !== ',') throw rejected();
      }
    }
    if (text[offset] === '"') { string(); return; }
    // This export format has no arrays, nulls or booleans; JSON.parse validates number spelling.
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(offset));
    if (!match) throw rejected(); offset += match[0].length;
  };
  value(0); whitespace(); if (offset !== text.length) throw rejected(); return JSON.parse(text);
}
/** Deliberately not a general wallet importer. Returns the original, unmodified JSON. */
export function validateKeystore(text: string): string {
  try {
    const value = unambiguousJSON(text) as Record<string, any>;
    const cryptoName = Object.hasOwn(value, 'Crypto') ? 'Crypto' : 'crypto';
    exactKeys(value, ['address', 'id', 'version', cryptoName]);
    const crypt = value[cryptoName]; exactKeys(crypt, ['cipher', 'cipherparams', 'ciphertext', 'kdf', 'kdfparams', 'mac']);
    exactKeys(crypt.cipherparams, ['iv']); exactKeys(crypt.kdfparams, ['salt', 'n', 'r', 'p', 'dklen']);
    const hex = (input: unknown, length: number) => typeof input === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(input);
    if (value.version !== 3 || !hex(value.address, 40) || typeof value.id !== 'string' ||
        !/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value.id) ||
        crypt.cipher !== 'aes-128-ctr' || crypt.kdf !== 'scrypt' || crypt.kdfparams.n !== 131072 ||
        crypt.kdfparams.r !== 8 || crypt.kdfparams.p !== 1 || crypt.kdfparams.dklen !== 32 ||
        !hex(crypt.kdfparams.salt, 64) || !hex(crypt.cipherparams.iv, 32) || !hex(crypt.ciphertext, 64) || !hex(crypt.mac, 64)) throw rejected();
    return text;
  } catch { throw rejected(); }
}
/** Generated EOA only: no mnemonic or caller-selected KDF/randomness overrides. Private result. */
export async function encryptBackup(privateKey: Hex, password: string): Promise<string> {
  try {
    const normalized = normalizeBackupPassword(password); const address = privateKeyToAccount(privateKey).address;
    return validateKeystore(await encryptKeystoreJson({ address, privateKey }, normalized));
  } catch { throw rejected(); }
}
/** Returns a credential only after authenticated decryption, derived owner binding and live Safe membership. */
export async function restoreBackup(text: string, password: string,
  expected: { owner: Address; network: SafeNetworkConfig; safe: Address }): Promise<Hex> {
  try {
    const normalized = normalizeBackupPassword(password); validateKeystore(text);
    const decrypted = await decryptKeystoreJson(text, normalized);
    const privateKey = decrypted.privateKey as Hex; const address = privateKeyToAccount(privateKey).address;
    if (address.toLowerCase() !== expected.owner.toLowerCase()) throw rejected();
    const live = await readSafeAccount(expected.network, expected.safe);
    if (!live.owners.some((owner) => owner.toLowerCase() === address.toLowerCase())) throw rejected();
    return privateKey;
  } catch { throw rejected(); }
}

export type BackupBinding = { network: SafeNetworkConfig; domain: IdentityContinuityDomain;
  registryRuntimeCodeHash: Hash; account: SafeAccountDeploymentConfig; backupOwner: Address };
type BackupService = { city: 'Chicago' | 'Boston'; agentId: string; agentURI: string;
  cardUrl: string; invocationUrl: string; cardDigest: Hash; profileDigest: Hash;
  observation: { blockNumber: string; blockHash: Hash } };
export type BackupMetadata = BackupBinding & { version: '0.1'; services: [BackupService, BackupService] };
const metadataLimit = 512 * 1024;
function decodeMetadata(text: string): BackupMetadata {
  const m = JSON.parse(text) as BackupMetadata;
  if (Buffer.byteLength(text) > metadataLimit || JSON.stringify(m) !== text) throw rejected();
  exactKeys(m, ['version', 'network', 'domain', 'registryRuntimeCodeHash', 'account', 'backupOwner', 'services']);
  validateNetwork(m.network); validateAccount(m.network, m.account);
  exactKeys(m.domain, ['chainId', 'genesisHash', 'registry', 'knownImplementation']);
  if (!m.domain.knownImplementation) throw rejected();
  exactKeys(m.domain.knownImplementation, ['address', 'codeHash']);
  if (m.version !== '0.1' || !Array.isArray(m.services) || m.services.length !== 2 ||
      m.services[0].city !== 'Chicago' || m.services[1].city !== 'Boston' || m.services[0].agentId === m.services[1].agentId) throw rejected();
  for (const service of m.services) {
    exactKeys(service, ['city', 'agentId', 'agentURI', 'cardUrl', 'invocationUrl', 'cardDigest', 'profileDigest', 'observation']);
    exactKeys(service.observation, ['blockNumber', 'blockHash']);
    if (!/^(0|[1-9][0-9]{0,15})$/.test(service.agentId) || BigInt(service.agentId) > BigInt(Number.MAX_SAFE_INTEGER) ||
        !/^(0|[1-9][0-9]{0,77})$/.test(service.observation.blockNumber) ||
        ![service.cardDigest, service.profileDigest, service.observation.blockHash].every((s) => /^0x[0-9a-fA-F]{64}$/.test(s))) throw rejected();
  }
  return m;
}
/** Metadata locates evidence; separately trusted domain configuration and canonical reads authorize nothing by themselves. */
export async function verifyBackupMetadata(metadata: BackupMetadata, expected: BackupBinding, cards: readonly Uint8Array[]): Promise<void> {
  try {
    const m = decodeMetadata(JSON.stringify(metadata));
    for (const key of ['network', 'domain', 'registryRuntimeCodeHash', 'account', 'backupOwner'] as const) {
      if (!isDeepStrictEqual(m[key], expected[key])) throw rejected();
    }
    if (cards.length !== 2 || !m.account.owners.some((owner) => owner.toLowerCase() === m.backupOwner.toLowerCase())) throw rejected();
    const client = createPublicClient({ transport: http(expected.network.rpcUrl, { retryCount: 0, timeout: 5000 }) });
    await readSafeRegistryConfiguration(client, expected);
    const live = await readSafeAccount(expected.network, expected.account.predictedAddress);
    if (!live.owners.some((owner) => owner.toLowerCase() === expected.backupOwner.toLowerCase())) throw rejected();
    for (const [index, service] of m.services.entries()) {
      const agent = { chainId: expected.network.chainId, registry: expected.domain.registry, agentId: service.agentId };
      const original = await readIdentitySnapshot(client, agent, BigInt(service.observation.blockNumber));
      if (original.blockHash !== service.observation.blockHash || digestBytes(cards[index]!) !== service.cardDigest ||
          digestBytes(new TextEncoder().encode(service.agentURI)) !== service.profileDigest) throw rejected();
      await readSafeAccount(expected.network, expected.account.predictedAddress, expected.account, BigInt(service.observation.blockNumber));
      const profile = verifyProfile({ agent, agentURI: service.agentURI, cardBytes: cards[index]! }, original);
      if (profile.card.url !== service.invocationUrl ||
          decodeRegistration(service.agentURI).services.find((s) => s.name === 'A2A')?.endpoint !== service.cardUrl ||
          (await readIdentitySnapshot(client, agent)).agentOwner.toLowerCase() !== expected.account.predictedAddress.toLowerCase()) throw rejected();
    }
  } catch { throw rejected(); }
}
/** Files are private by default. No password, journal, mnemonic or signed control capability is exported. */
export async function writeBackupExport(directory: string, key: Hex, password: string, metadata: BackupMetadata,
  expected: BackupBinding, cards: readonly Uint8Array[]): Promise<void> {
  try {
    await verifyBackupMetadata(metadata, expected, cards);
    if (privateKeyToAccount(key).address.toLowerCase() !== expected.backupOwner.toLowerCase()) throw rejected();
    const encrypted = await encryptBackup(key, password);
    for (const [index, card] of cards.entries()) await writePrivateFile(directory, `card-${index}.json`, card, 65536);
    await writePrivateFile(directory, 'backup.json', Buffer.from(encrypted), 65536);
    await writePrivateFile(directory, 'metadata.json', Buffer.from(JSON.stringify(metadata)), metadataLimit);
  } catch { throw rejected(); }
}
export async function readBackupExport(directory: string, password: string, expected: BackupBinding):
Promise<{ privateKey: Hex; metadata: BackupMetadata; cards: [Uint8Array, Uint8Array] }> {
  try {
    const files = await Promise.all([readPrivateFile(directory, 'metadata.json', metadataLimit),
      readPrivateFile(directory, 'backup.json', 65536), readPrivateFile(directory, 'card-0.json', 65536), readPrivateFile(directory, 'card-1.json', 65536)]);
    if (files.some((file) => file === null)) throw rejected();
    const decoder = new TextDecoder('utf-8', { fatal: true }); const metadata = decodeMetadata(decoder.decode(files[0]!));
    const cards: [Uint8Array, Uint8Array] = [files[2]!, files[3]!];
    await verifyBackupMetadata(metadata, expected, cards);
    const privateKey = await restoreBackup(decoder.decode(files[1]!), password,
      { owner: expected.backupOwner, safe: expected.account.predictedAddress, network: expected.network });
    return { privateKey, metadata, cards };
  } catch { throw rejected(); }
}
