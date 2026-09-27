import { keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { decodeOriginEnvelope, encodeOriginStatement, type OriginStatementBytes } from './bytes.js';
import { ORIGIN_PROFILE, originProfileSchema, type OriginEnvelope, type OriginProfile, type OriginStatement } from './schema.js';

const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PURPOSE = { profile: 'CityOriginProfile', request: 'CityOriginRequest', acceptance: 'CityOriginAcceptance',
  completion: 'CityOriginCompletion', feedback: 'CityOriginFeedback', retraction: 'CityOriginRetraction',
  'archive-snapshot': 'CityOriginArchiveSnapshot' } as const;
function typedData(statement: OriginStatementBytes) {
  const primaryType = PURPOSE[statement.value.kind];
  return { domain: { name: 'NandaCityOrigin', version: '0.1', salt: keccak256(toBytes(statement.value.service.identityUrl)) },
    primaryType, types: { [primaryType]: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: statement.digest } } as const;
}
function canonicalSignature(signature: string): boolean {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) return false;
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  return r > 0n && r < ORDER && s > 0n && s <= ORDER / 2n && ['1b', '1c'].includes(signature.slice(130));
}
function authoredKey(value: OriginStatement): string | undefined {
  if (value.kind === 'profile') return value.controllerKey.address;
  if (value.kind === 'request') return value.caller.address;
  if (value.kind === 'archive-snapshot') return value.reviewer;
  if ('reviewer' in value) return value.reviewer.address;
  return undefined;
}
export async function signOriginStatement(value: OriginStatement, account: PrivateKeyAccount, profile?: OriginProfile): Promise<OriginEnvelope> {
  const decoded = encodeOriginStatement(value);
  let expected = authoredKey(decoded.value);
  if (value.kind === 'acceptance' || value.kind === 'completion') {
    const authority = originProfileSchema.parse(profile);
    if (!authority.active || authority.service.identityUrl !== value.service.identityUrl) throw new Error('runtime profile service mismatch');
    expected = authority.runtimeKey.address;
  }
  if (expected !== account.address.toLowerCase()) throw new Error('origin signing key mismatch');
  const signature = (await account.signTypedData(typedData(decoded))).toLowerCase() as `0x${string}`;
  if (!canonicalSignature(signature)) throw new Error('noncanonical signature');
  return { profile: ORIGIN_PROFILE, scheme: 'eip712-secp256k1',
    signer: { method: 'secp256k1-key', address: account.address.toLowerCase() },
    payloadBase64: Buffer.from(decoded.bytes).toString('base64'), signature };
}
/** Self-signature and authored-key binding only; TLS/current or historical authority is not implied. */
export async function verifyOriginSignature(value: unknown, identityUrl: string, kind: OriginStatement['kind']):
Promise<{ status: 'valid' | 'invalid'; recovered?: string }> {
  try {
    const decoded = decodeOriginEnvelope(value);
    if (decoded.statement.value.service.identityUrl !== identityUrl || decoded.statement.value.kind !== kind ||
      !canonicalSignature(decoded.envelope.signature)) return { status: 'invalid' };
    const recovered = (await recoverTypedDataAddress({ ...typedData(decoded.statement),
      signature: decoded.envelope.signature as `0x${string}` })).toLowerCase();
    const expected = authoredKey(decoded.statement.value);
    if (recovered !== decoded.envelope.signer.address || (expected !== undefined && recovered !== expected)) return { status: 'invalid' };
    return { status: 'valid', recovered };
  } catch { return { status: 'invalid' }; }
}
