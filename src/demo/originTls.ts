import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ServerOptions } from 'node:https';

const run = promisify(execFile);
export type OriginTlsFixture = { ca: string; serverOptions: ServerOptions; close: () => Promise<void> };

/** Disposable local fixture only. Trust is supplied per client, never installed globally. */
export async function createOriginTlsFixture(ip: '127.0.0.1' | '127.0.0.2' = '127.0.0.1'): Promise<OriginTlsFixture> {
  if (ip !== '127.0.0.1' && ip !== '127.0.0.2') throw new Error('fixture SAN must be owned literal loopback');
  const directory = await mkdtemp(join(tmpdir(), 'city-origin-tls-'));
  const close = () => rm(directory, { recursive: true, force: true });
  const openssl = (args: string[]) => run('openssl', args, { cwd: directory, timeout: 10_000, maxBuffer: 64 * 1024 });
  try {
    await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=City Owned Fixture CA',
      '-addext', 'basicConstraints=critical,CA:TRUE']);
    await openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=City Owned Loopback Fixture']);
    await writeFile(join(directory, 'server.ext'), `subjectAltName=IP:${ip}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext']);
    const [ca, cert, key] = await Promise.all(['ca.pem', 'server.pem', 'server.key'].map((name) => readFile(join(directory, name), 'utf8')));
    return { ca: ca!, serverOptions: { cert: cert!, key: key! }, close };
  } catch {
    await close();
    throw new Error('owned TLS fixture generation failed');
  }
}
