import { recoverTypedDataAddress } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import type { VerifiedProfile } from '../identity/verify.js';
import { decodeStatement, encodeStatement, UnsupportedInteractionMethodError, type DecodedStatement } from './bytes.js';
import {
  envelopeSchema,
  type CityAcceptance,
  type CityCompletion,
  type CityRequest,
  type CityStatement,
  type SignedEnvelope,
} from './schema.js';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MAX_ENCODED_PAYLOAD = Math.ceil((16 * 1024) / 3) * 4;

function typeFor(kind: CityStatement['kind']) {
  if (kind === 'request') return 'CityRequest' as const;
  if (kind === 'acceptance') return 'CityAcceptance' as const;
  return 'CityCompletion' as const;
}

function typedData(statement: DecodedStatement, chainId: number) {
  const primaryType = typeFor(statement.value.kind);
  return {
    domain: { name: 'NandaCityInteraction', version: '0.1', chainId },
    primaryType,
    types: { [primaryType]: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: statement.digest },
  } as const;
}

function validCanonicalEcdsa(signature: string): boolean {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) return false;
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130, 132);
  return r > 0n && r < SECP256K1_ORDER && s > 0n && s <= SECP256K1_ORDER / 2n && (v === '1b' || v === '1c');
}

export function decodeEnvelope(value: unknown): { envelope: SignedEnvelope; statement: DecodedStatement } {
  const envelope = envelopeSchema.parse(value);
  const encoded = envelope.payloadBase64;
  if (encoded.length > MAX_ENCODED_PAYLOAD || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('payloadBase64 must be bounded canonical padded Base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new Error('payloadBase64 must be canonical padded Base64');
  }
  const statement = decodeStatement(bytes);
  return { envelope, statement };
}

async function signStatement(statement: CityStatement, account: PrivateKeyAccount, chainId: number): Promise<SignedEnvelope> {
  const decoded = encodeStatement(statement);
  const signature = (await account.signTypedData(typedData(decoded, chainId))).toLowerCase() as `0x${string}`;
  if (!validCanonicalEcdsa(signature)) throw new Error('signer produced a noncanonical ECDSA signature');
  return {
    version: '0.1', scheme: 'eip712-eoa',
    signer: { method: 'eip155-eoa', chainId, address: account.address.toLowerCase() as `0x${string}` },
    payloadBase64: Buffer.from(decoded.bytes).toString('base64'),
    signature,
  };
}

/** The caller must prove control of the exact key named inside the request bytes. */
export async function signRequest(request: CityRequest, account: PrivateKeyAccount): Promise<SignedEnvelope> {
  if (request.caller.address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('caller signing key does not match request caller');
  }
  return signStatement(request, account, request.service.agent.chainId);
}

/** The service runtime has only this named City statement scope; it never receives an owner key. */
export async function signProviderStatement(
  statement: CityAcceptance | CityCompletion,
  account: PrivateKeyAccount,
  profile: VerifiedProfile,
): Promise<SignedEnvelope> {
  if (statement.kind !== 'acceptance' && statement.kind !== 'completion') {
    throw new Error('runtime signer may only sign acceptance or completion');
  }
  const owner = profile.source.agentOwner.toLowerCase();
  const runtime = profile.registration['x-nandacity'].receiptSigner.toLowerCase();
  if (runtime === owner) throw new Error('runtime receiptSigner must differ from agent owner');
  if (account.address.toLowerCase() !== runtime) {
    throw new Error('runtime signing key does not match owner-published receiptSigner');
  }
  return signStatement(statement, account, profile.agent.chainId);
}

export type CryptoFinding = { status: 'valid' | 'invalid' | 'unsupported'; recovered?: `0x${string}` };

/** Cryptographic EOA validity only; this makes no authority or timing claim. */
export async function verifyEnvelopeSignature(value: unknown, chainId: number): Promise<CryptoFinding> {
  let decoded: ReturnType<typeof decodeEnvelope>;
  try { decoded = decodeEnvelope(value); }
  catch (error) { return { status: error instanceof UnsupportedInteractionMethodError ? 'unsupported' : 'invalid' }; }
  const { envelope, statement } = decoded;
  if (envelope.scheme !== 'eip712-eoa' || envelope.signer.method !== 'eip155-eoa') {
    return { status: 'unsupported' };
  }
  if (envelope.signer.chainId !== chainId || !validCanonicalEcdsa(envelope.signature)) {
    return { status: 'invalid' };
  }
  try {
    const recovered = await recoverTypedDataAddress({
      ...typedData(statement, chainId),
      signature: envelope.signature as `0x${string}`,
    });
    if (recovered.toLowerCase() !== envelope.signer.address.toLowerCase()) return { status: 'invalid' };
    return { status: 'valid', recovered: recovered.toLowerCase() as `0x${string}` };
  } catch {
    return { status: 'invalid' };
  }
}
