import assert from 'node:assert/strict';
import { chmod, link, lstat, open, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { makeInteractionFixture } from '../interaction/fixtures.js';
import { encodeSupportingBundle } from '../../src/feedback/supportingBundle.js';

const fixture = makeInteractionFixture();
const envelope = (value: unknown) => ({ version: '0.1', scheme: 'eip712-eoa',
  signer: { method: 'eip155-eoa', chainId: 11155111, address: '0x2222222222222222222222222222222222222222' },
  payloadBase64: Buffer.from(JSON.stringify(value)).toString('base64'), signature: `0x${'11'.repeat(65)}` });
const bundle = encodeSupportingBundle({ version: '0.1', request: envelope(fixture.request),
  acceptance: envelope(fixture.acceptance), completion: envelope(fixture.completion), cardBase64: 'AP+A' });
const module = async () => {
  const value = await import('../../src/demo/privateBundleFile.js').catch(() => undefined);
  assert.ok(value, 'owned private bundle file boundary must be implemented'); return value;
};

test('private bundle is exclusive 0600 in owned 0700 directory, read by descriptor and removed on exit', async () => {
  const { withPrivateBundleFile, readPrivateBundleFile } = await module(); let path = '';
  await withPrivateBundleFile(bundle.bytes, async (file) => {
    path = file;
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual(await readPrivateBundleFile(file), bundle.bytes);
    assert.equal(await readPrivateBundleFile(join(dirname(file), 'absent')), null);
    await assert.rejects(writeFile(file, 'replacement', { flag: 'wx' }), { code: 'EEXIST' });
  });
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('private bundle rejects links, broad modes, oversized and malformed bytes without exposing paths', async () => {
  const { withPrivateBundleFile, readPrivateBundleFile } = await module();
  await withPrivateBundleFile(bundle.bytes, async (file) => {
    const link = join(dirname(file), 'link'); await symlink(file, link);
    for (const target of [link, dirname(file)]) await assert.rejects(readPrivateBundleFile(target), /^Error: private bundle file rejected$/);
    await chmod(file, 0o644); await assert.rejects(readPrivateBundleFile(file), /^Error: private bundle file rejected$/);
    await chmod(file, 0o600); await writeFile(file, Buffer.alloc(131073));
    await assert.rejects(readPrivateBundleFile(file), /^Error: private bundle file rejected$/);
    await writeFile(file, 'private-malformed-content');
    await assert.rejects(readPrivateBundleFile(file), /^Error: private bundle file rejected$/);
  });
});

test('descriptor read rejects a file changed while reading and a hardlinked alias', async (t) => {
  const { withPrivateBundleFile, readPrivateBundleFile } = await module();
  await withPrivateBundleFile(bundle.bytes, async (file) => {
    // Interpose only the scheduler boundary; reads and the competing mutation are real filesystem operations.
    const handle = await open(file, 'r'); const prototype = Object.getPrototypeOf(handle);
    const read = prototype.read; let mutated = false;
    const mocked = t.mock.method(prototype, 'read', async function(this: unknown, ...args: unknown[]) {
      const result = await read.apply(this, args);
      if (!mutated) { mutated = true; await utimes(file, new Date(0), new Date(0)); }
      return result;
    });
    try { await assert.rejects(readPrivateBundleFile(file), /^Error: private bundle file rejected$/); }
    finally { mocked.mock.restore(); await handle.close(); }
    const alias = join(dirname(file), 'alias'); await link(file, alias);
    await assert.rejects(readPrivateBundleFile(file), /^Error: private bundle file rejected$/);
  });
});
