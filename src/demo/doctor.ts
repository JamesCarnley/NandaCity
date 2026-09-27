import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { INDEX_SOURCE_COMMIT, resolveLocalDocker } from './indexProcesses.js';
import { TOWN_EVIDENCE_COMMIT, TOWN_EVIDENCE_PYTHON } from '../reputation/townEvidence.js';

type Check = { id: string; requiredFor: 'fixture' | 'full-check'; ok: boolean; guidance: string };
/** No installations, upgrades, network calls or changes to the selected Docker context. */
export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<{ fixtureReady: boolean; fullCheckReady: boolean; checks: Check[] }> {
  const run = async (binary: string, args: string[], cwd?: string) => {
    const result = await promisify(execFile)(binary, args, { ...(cwd ? { cwd } : {}), env: { PATH: env.PATH ?? '' }, timeout: 10000, maxBuffer: 65536 });
    return result.stdout.trim();
  };
  const checks: Check[] = [];
  const check = async (id: string, requiredFor: Check['requiredFor'], guidance: string, probe: () => Promise<boolean>) => {
    let ok = false; try { ok = await probe(); } catch { /* Never return process args/errors, environment or private paths. */ }
    checks.push({ id, requiredFor, ok, guidance: ok ? 'Ready for this prerequisite; not evidence of a passed suite.' : guidance });
  };
  await check('node', 'fixture', 'Use Node.js 24 or newer, then run npm ci in City.', async () => Number(process.versions.node.split('.')[0]) >= 24);
  await check('anvil', 'fixture', 'Put Anvil 1.7.1 on PATH (see README); no upgrade is performed by doctor.', async () => /anvil Version: 1\.7\.1(?:\s|[-+])/.test(await run('anvil', ['--version'])));
  await check('docker', 'fixture', 'Start your local Docker engine and select a Unix-socket context; remote Docker is refused.', async () => {
    const docker = await resolveLocalDocker(env, (args) => run('docker', args));
    await docker.command(['info', '--format', '{{.ServerVersion}}'], 10000); return true;
  });
  const checkout = async (path: string | undefined, pin: string) => !!path && isAbsolute(path) && await realpath(path) === path &&
    await run('git', ['rev-parse', 'HEAD'], path) === pin && await run('git', ['status', '--porcelain'], path) === '';
  await check('index', 'fixture', `Set NANDA_INDEX_CHECKOUT to a clean canonical checkout at ${INDEX_SOURCE_COMMIT}; run npm ci in its server directory.`, async () => {
    if (!await checkout(env.NANDA_INDEX_CHECKOUT, INDEX_SOURCE_COMMIT)) return false;
    await access(join(env.NANDA_INDEX_CHECKOUT!, 'server/node_modules/typescript/bin/tsc')); return true;
  });
  await check('town', 'full-check', `For full checks/native Town admission only, set NANDATOWN_CHECKOUT to clean canonical ${TOWN_EVIDENCE_COMMIT}. Not required by this curator-admitted fixture.`,
    () => checkout(env.NANDATOWN_CHECKOUT, TOWN_EVIDENCE_COMMIT));
  await check('python', 'full-check', `For full checks/native Town admission only, set NANDATOWN_PYTHON to a Python ${TOWN_EVIDENCE_PYTHON} virtual-environment entry with the pinned Town installed editable. Do not resolve it to global Python.`, async () => {
    const python = env.NANDATOWN_PYTHON;
    if (!python || !isAbsolute(python) || !env.NANDATOWN_CHECKOUT || await run(python, ['--version']) !== `Python ${TOWN_EVIDENCE_PYTHON}`) return false;
    return await run(python, ['-B', '-c', 'import importlib.util,os,sys; s=importlib.util.find_spec("nandatown"); print("ready" if sys.prefix != sys.base_prefix and s and s.origin and os.path.realpath(s.origin).startswith(os.path.realpath(sys.argv[1])+os.sep) else "unavailable")', env.NANDATOWN_CHECKOUT]) === 'ready';
  });
  return { fixtureReady: checks.filter((c) => c.requiredFor === 'fixture').every((c) => c.ok), fullCheckReady: checks.every((c) => c.ok), checks };
}
