import { encodeAbiParameters, parseAbiParameters } from 'viem';

const stringParameters = parseAbiParameters('string');
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strictly decodes one raw ABI string without normalizing its UTF-8 bytes. */
export function decodeStrictRawString(data: unknown, maxBytes: number | undefined,
  label: string): string {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) {
    throw new Error(`malformed ${label} raw ABI`);
  }
  const rawLength = (data.length - 2) / 2;
  if (maxBytes !== undefined && rawLength > maxBytes) {
    throw new Error(`${label} raw ABI exceeds byte bound`);
  }
  if (rawLength < 64) throw new Error(`malformed ${label} raw ABI`);
  const bytes = Buffer.from(data.slice(2), 'hex');
  const offset = BigInt(`0x${bytes.subarray(0, 32).toString('hex')}`);
  const length = BigInt(`0x${bytes.subarray(32, 64).toString('hex')}`);
  if (offset !== 32n || length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`noncanonical ${label} raw ABI`);
  }
  const size = Number(length), padded = Math.ceil(size / 32) * 32;
  if (bytes.length !== 64 + padded || bytes.subarray(64 + size).some((value) => value !== 0)) {
    throw new Error(`noncanonical ${label} raw ABI`);
  }
  let value: string;
  try {
    value = fatalTextDecoder.decode(bytes.subarray(64, 64 + size));
  } catch {
    throw new Error(`${label} string is not valid UTF-8`);
  }
  if (encodeAbiParameters(stringParameters, [value]).toLowerCase() !== data.toLowerCase()) {
    throw new Error(`noncanonical ${label} raw ABI`);
  }
  return value;
}
