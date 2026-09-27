import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readOriginEvidence } from '../reputation/originEvidence.js';
import { originConsumerPolicySchema } from '../reputation/originPolicy.js';
import { originDigestSchema, originUrlSchema } from '../origin/schema.js';

const inputSchema = z.strictObject({ indexOrigin: z.string().max(2048), snapshotDigest: originDigestSchema,
  identityUrl: originUrlSchema, allowedUrls: z.array(originUrlSchema).max(16), ca: z.string().min(1).max(16384),
  observedAt: z.string().max(20), policy: originConsumerPolicySchema, bundleBase64: z.string().max(350000) });
/** Separate process entry: private evidence arrives only on stdin, never argv or stdout. */
export async function consumeOriginInput(raw: unknown) {
  const input = inputSchema.parse(raw);
  const bundle = Buffer.from(input.bundleBase64, 'base64');
  if (bundle.toString('base64') !== input.bundleBase64) throw new Error('private bundle encoding invalid');
  return readOriginEvidence({ ...input, bundle: new Uint8Array(bundle) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 400000) throw new Error('consumer input too large'); chunks.push(bytes);
    }
    const result = await consumeOriginInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write('Origin consumer could not verify supplied evidence.\n'); process.exitCode = 1; }
}
