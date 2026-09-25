import { recoverTypedDataAddress } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import { envelopeSchema, type SignedEnvelope } from '../interaction/schema.js';
import { decodeFeedback, encodeFeedback, type DecodedFeedback } from './bytes.js';
import type { CityFeedback } from './schema.js';

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MAX_ENCODED_PAYLOAD = Math.ceil((4 * 1024) / 3) * 4;

function typedData(feedback: DecodedFeedback, chainId: number) {
  return {
    domain: { name: 'NandaCityFeedback', version: '0.1', chainId },
    primaryType: 'CityFeedback',
    types: { CityFeedback: [{ name: 'payloadDigest', type: 'bytes32' }] },
    message: { payloadDigest: feedback.digest },
  } as const;
}

function validCanonicalEcdsa(signature: string): boolean {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) return false;
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130, 132);
  return r > 0n && r < SECP256K1_ORDER && s > 0n && s <= SECP256K1_ORDER / 2n && (v === '1b' || v === '1c');
}

export function decodeFeedbackEnvelope(value: unknown): { envelope: SignedEnvelope; feedback: DecodedFeedback } {
  const envelope = envelopeSchema.parse(value);
  const encoded = envelope.payloadBase64;
  if (encoded.length > MAX_ENCODED_PAYLOAD || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('payloadBase64 must be bounded canonical padded Base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('payloadBase64 must be canonical padded Base64');
  return { envelope, feedback: decodeFeedback(bytes) };
}

/** Feedback is a separate purpose signed by the request caller, never the provider runtime. */
export async function signFeedback(value: CityFeedback, account: PrivateKeyAccount): Promise<SignedEnvelope> {
  const feedback = encodeFeedback(value);
  if (feedback.value.reviewer.address !== account.address.toLowerCase()) {
    throw new Error('reviewer signing key does not match feedback reviewer');
  }
  const chainId = feedback.value.service.agent.chainId;
  const signature = (await account.signTypedData(typedData(feedback, chainId))).toLowerCase() as `0x${string}`;
  if (!validCanonicalEcdsa(signature)) throw new Error('signer produced a noncanonical ECDSA signature');
  return {
    version: '0.1', scheme: 'eip712-eoa',
    signer: { method: 'eip155-eoa', chainId, address: account.address.toLowerCase() as `0x${string}` },
    payloadBase64: Buffer.from(feedback.bytes).toString('base64'), signature,
  };
}

export type FeedbackCryptoFinding = { status: 'valid' | 'invalid' | 'unsupported'; recovered?: `0x${string}` };

/** Cryptographic EOA validity only; it does not establish the reviewer's identity or timing. */
export async function verifyFeedbackSignature(value: unknown, chainId: number): Promise<FeedbackCryptoFinding> {
  let decoded: ReturnType<typeof decodeFeedbackEnvelope>;
  try { decoded = decodeFeedbackEnvelope(value); }
  catch { return { status: 'invalid' }; }
  const { envelope, feedback } = decoded;
  if (envelope.scheme !== 'eip712-eoa' || envelope.signer.method !== 'eip155-eoa') return { status: 'unsupported' };
  if (envelope.signer.chainId !== chainId || !validCanonicalEcdsa(envelope.signature)) return { status: 'invalid' };
  try {
    const recovered = await recoverTypedDataAddress({ ...typedData(feedback, chainId), signature: envelope.signature as `0x${string}` });
    if (recovered.toLowerCase() !== envelope.signer.address) return { status: 'invalid' };
    return { status: 'valid', recovered: recovered.toLowerCase() as `0x${string}` };
  } catch {
    return { status: 'invalid' };
  }
}
