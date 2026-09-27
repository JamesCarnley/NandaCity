import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const backup = async () => {
  const module = await import('../../src/safe/backup.js').catch(() => undefined);
  assert.ok(module, 'bounded encrypted backup must exist'); return module;
};
test('password validation preserves whitespace and explicitly uses bounded well-formed NFKC text', async () => {
  const { normalizeBackupPassword } = await backup();
  assert.equal(normalizeBackupPassword(' x '), ' x ');
  assert.equal(normalizeBackupPassword('é'), normalizeBackupPassword('e\u0301'));
  assert.equal(normalizeBackupPassword('Ａ'), 'A');
  for (const value of ['', '\ud800', '\udc00', 'x'.repeat(1025), 'Ａ'.repeat(342), '\uFDFA'.repeat(60), 1, new Uint8Array([1])]) {
    assert.throws(() => normalizeBackupPassword(value as string), /^Error: backup rejected$/);
  }
});

test('generated V3 preserves random defaults and ordinary ethers string compatibility', async () => {
  const { encryptBackup, validateKeystore } = await backup();
  const { decryptKeystoreJson } = await import('ethers/wallet');
  const key = generatePrivateKey(); const password = ` Ａé ${randomBytes(12).toString('hex')} `;
  const first = await encryptBackup(key, password); const second = await encryptBackup(key, password);
  assert.ok(first !== second, 'library random salt/IV must be retained');
  const parsed = JSON.parse(first);
  assert.equal(parsed.version, 3); assert.equal(parsed.Crypto.kdf, 'scrypt');
  assert.deepEqual({ ...parsed.Crypto.kdfparams, salt: 'random' }, { salt: 'random', n: 131072, r: 8, p: 1, dklen: 32 });
  assert.equal(parsed.Crypto.cipher, 'aes-128-ctr'); assert.equal(parsed['x-ethers'], undefined);
  assert.ok(validateKeystore(first) === first, 'never rewrite original V3 bytes');
  const restored = await decryptKeystoreJson(first, password);
  assert.ok(restored.privateKey === key, 'ordinary library string import must recover the generated credential');
  assert.ok(restored.address.toLowerCase() === privateKeyToAccount(key).address.toLowerCase());
  const equivalent = await decryptKeystoreJson(first, password.replace('Ａ', 'A').replace('é', 'e\u0301'));
  assert.ok(equivalent.privateKey === key, 'NFKC-equivalent ordinary library string input must decrypt');
  await assert.rejects(decryptKeystoreJson(first, password.trim()));
});

test('bounded generated-export parser rejects ambiguous keys and hostile KDFs before decryption', async () => {
  const { encryptBackup, validateKeystore } = await backup();
  const text = await encryptBackup(generatePrivateKey(), randomBytes(16).toString('hex'));
  const value = JSON.parse(text);
  assert.ok(validateKeystore(text.replace('"Crypto"', '"crypto"')) === text.replace('"Crypto"', '"crypto"'));
  for (const mutate of [
    (v: typeof value) => { v.Crypto.kdfparams.n = 2 ** 30; },
    (v: typeof value) => { v.Crypto.kdf = 'pbkdf2'; },
    (v: typeof value) => { v.Crypto.kdfparams.p = 2; },
    (v: typeof value) => { v.Crypto.kdfparams.dklen = 64; },
    (v: typeof value) => { v.Crypto.cipher = 'aes-256-ctr'; },
    (v: typeof value) => { v.Crypto.ciphertext = '00'; },
    (v: typeof value) => { v.Crypto.mac = 'gg'.repeat(32); },
    (v: typeof value) => { v.crypto = v.Crypto; },
    (v: typeof value) => { v.Crypto.KDF = v.Crypto.kdf; },
    (v: typeof value) => { v.version = 4; },
    (v: typeof value) => { v.mnemonic = 'forbidden'; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => validateKeystore(JSON.stringify(changed)), /^Error: backup rejected$/);
  }
  for (const bad of [text.replace('"version":3', '"version":3,"version":3'),
    text.replace('"version":3', '"version":3,"\\u0076ersion":3'), ' '.repeat(65537), '{',
    text.replace('"n":131072', '"n":131072,"N":131072')]) {
    assert.throws(() => validateKeystore(bad), /^Error: backup rejected$/);
  }
});

test('private-file descriptor mutation is refused at a deterministic read barrier', async (t) => {
  const { readPrivateFile, writePrivateFile } = await import('../../src/safe/privateFile.js');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'city-backup-race-'));
  try {
    const file = join(root, 'backup.json'); await writePrivateFile(root, 'backup.json', Buffer.alloc(32768), 65536);
    const handle = await open(file, 'r'); const prototype = Object.getPrototypeOf(handle); const read = prototype.read;
    let mutated = false;
    const intercepted = t.mock.method(prototype, 'read', async function(this: import('node:fs/promises').FileHandle,
      ...args: unknown[]) {
      const result = await read.apply(this, args);
      if (!mutated) { mutated = true; await writeFile(file, Buffer.alloc(32768, 1)); }
      return result;
    });
    try { await assert.rejects(readPrivateFile(root, 'backup.json', 65536), /^Error: private file rejected$/); assert.ok(mutated); }
    finally { intercepted.mock.restore(); await handle.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared private-file primitive bounds names and bytes and rejects unsafe files', async () => {
  const module = await import('../../src/safe/privateFile.js').catch(() => undefined);
  assert.ok(module, 'backup must reuse extracted private-file persistence');
  const { readPrivateFile, writePrivateFile } = module;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'city-backup-test-'));
  try {
    await writePrivateFile(root, 'backup.json', Buffer.from('private'), 64);
    assert.ok((await readPrivateFile(root, 'backup.json', 64))?.equals(Buffer.from('private')));
    await assert.rejects(readPrivateFile(root, '../backup.json', 64));
    await assert.rejects(writePrivateFile(root, 'backup.json', Buffer.alloc(65), 64));
    await assert.rejects(readPrivateFile(root, 'backup.json', 6));
    const file = join(root, 'backup.json');
    await chmod(file, 0o644); await assert.rejects(readPrivateFile(root, 'backup.json', 64)); await chmod(file, 0o600);
    await link(file, join(root, 'alias')); await assert.rejects(readPrivateFile(root, 'backup.json', 64)); await rm(join(root, 'alias'));
    await rm(file); await writeFile(join(root, 'target'), 'private', { mode: 0o600 });
    await symlink(join(root, 'target'), file); await assert.rejects(readPrivateFile(root, 'backup.json', 64));
    await assert.rejects(writePrivateFile(root, 'backup.json', Buffer.from('replacement'), 64));
  } finally { await rm(root, { recursive: true, force: true }); }
});
