import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, copyFile, chmod, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
type Event = { stage?: string; pid?: number; containerId?: string; origins?: string[]; origin?: string; args?: string[] };
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export async function recordedCli(config: object): Promise<{ directory: string; log: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'city-signal-test-'));
  const log = join(directory, 'events.jsonl');
  await writeFile(log, '');
  await copyFile(join(here, 'fixtures/dockerRecorder.cjs'), join(directory, 'docker'));
  await chmod(join(directory, 'docker'), 0o755);
  await writeFile(join(directory, 'config.json'), JSON.stringify({ ...config, log }));
  return { directory, log };
}
export async function events(log: string): Promise<Event[]> {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Event);
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
export async function signalProbe(checkout: string, signal: 'SIGINT' | 'SIGTERM',
  stage: 'container-acquiring' | 'ready' | 'anvil-preflight' | 'index' | 'lost-receipt' | 'demo-ready',
  repeated = false, processGroup = false, reportCommand = false,
  externalClientCommand = false): Promise<void> {
  const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
  const anvil = execFileSync('which', ['anvil'], { encoding: 'utf8' }).trim();
  const endpoint = execFileSync(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' }).trim();
  assert.match(endpoint, /^unix:\/\//, 'tests require a local Docker endpoint');
  const dockerArgs = ['--host', endpoint];
  const containers = (): string[] => execFileSync(docker, [...dockerArgs, 'ps', '--format', '{{.ID}}'],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const unrelated = containers();
  const { directory, log } = await recordedCli({ docker, stage });
  for (const [name, binary, condition, kind] of [
    ['anvil', anvil, '[ "$1" != --version ]', 'anvil'],
    ['node', process.execPath, '[ "$1" = dist/server.js ]', 'index'],
  ]) {
    await writeFile(join(directory, name!), `#!/bin/sh\nif ${condition}; then\n` +
      `  printf '{"stage":"${kind}","pid":%s,"origin":"%s"}\\n' "$$" "$API_BASE_URL" >> ${quote(log)}\nfi\n` +
      (stage === 'anvil-preflight' && name === 'anvil' ?
        `if [ "$1" = --version ]; then\n  printf '{"stage":"anvil-preflight"}\\n' >> ${quote(log)}\n  sleep 1\nfi\n` : '') +
      `exec ${quote(binary!)} "$@"\n`, { mode: 0o755 });
  }
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const reportHtml = join(directory, 'comparison.html');
  const reportEvidence = join(directory, 'original-evidence.json');
  const childArgs = reportCommand ? ['--import', 'tsx', join(here, '../../src/cli.ts'),
    'report', 'demo', '--index-checkout', checkout, '--html', reportHtml, '--evidence', reportEvidence] :
    externalClientCommand ? ['--import', 'tsx', join(here, '../../src/cli.ts'),
      'external-client', 'demo', '--index-checkout', checkout, '--city', 'Chicago'] :
      ['--import', 'tsx', join(here, 'fixtures/signalWorker.ts'), log, checkout, stage];
  const child = spawn(process.execPath, childArgs,
    { env: { ...process.env, PATH: `${directory}:${process.env['PATH'] ?? ''}` },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let observedClientPid: number | undefined;
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString(); });
  try {
    const directClientPid = (): number | undefined => {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='],
        { encoding: 'utf8' }).split('\n');
      for (const row of rows) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
        if (match && Number(match[2]) === child.pid &&
            /(?:^|\/)externalClientCli\.(?:ts|js)(?:\s|$)/.test(match[3]!)) {
          return Number(match[1]);
        }
      }
      return undefined;
    };
    const atStage = async (): Promise<boolean> => {
      const recorded = await events(log);
      if (stage !== 'demo-ready') return recorded.some((event) =>
        event.stage === (stage === 'lost-receipt' ? 'container-acquiring' : stage));
      const indexes = recorded.filter((event) => event.stage === 'index');
      if (indexes.length < 2) return false;
      try {
        const healthy = (await Promise.all(indexes.slice(0, 2).map(async (event) =>
          (await fetch(`${event.origin}/health`, { signal: AbortSignal.timeout(250) })).ok))).every(Boolean);
        if (!healthy) return false;
        if (externalClientCommand) {
          observedClientPid = directClientPid();
          return observedClientPid !== undefined;
        }
        return true;
      } catch { return false; }
    };
    const readyDeadline = Date.now() + 60_000;
    while (!await atStage()) {
      assert.equal(child.exitCode, null, output);
      assert.equal(child.signalCode, null, output);
      assert.ok(Date.now() < readyDeadline, `worker not ready: ${output}`);
      await delay(25);
    }
    if (reportCommand) {
      assert.equal((await stat(reportHtml)).isFile(), true, 'report HTML was not reserved before signal');
      assert.equal((await stat(reportEvidence)).isFile(), true, 'report evidence was not reserved before signal');
    }
    if (externalClientCommand) {
      assert.ok(observedClientPid && alive(observedClientPid),
        'observed child client must still be running immediately before parent interruption');
    }
    if (stage !== 'lost-receipt') {
      if (processGroup) process.kill(-child.pid!, signal); else child.kill(signal);
    }
    if (repeated) { await delay(50); child.kill(signal); }
    const exitDeadline = Date.now() + 25_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline) await delay(25);
    if (stage === 'lost-receipt') assert.equal(child.exitCode, 1, output);
    else assert.equal(child.signalCode, signal, `root must terminate with original signal: ${output}`);
    if (externalClientCommand) {
      assert.ok(observedClientPid, 'signal probe must observe the actual child client process before interruption');
      const childExitDeadline = Date.now() + 5_000;
      while (alive(observedClientPid) && Date.now() < childExitDeadline) await delay(25);
      assert.equal(alive(observedClientPid), false, 'child client process survived parent cancellation');
    }
    const recorded = await events(log);
    if (!reportCommand && !externalClientCommand && stage !== 'anvil-preflight' && stage !== 'demo-ready') {
      assert.ok(recorded.some((event) => event.stage === 'scenario-cleaned'), 'scenario finally was bypassed');
    } else if (stage === 'anvil-preflight') {
      assert.equal(recorded.some((event) => event.stage === 'anvil'), false, 'Anvil spawned after cancellation');
    }
    if (stage === 'ready') assert.ok(recorded.some((event) => event.stage === 'callback-cleaned'));
    if (stage === 'container-acquiring') {
      assert.equal(recorded.some((event) => event.stage === 'index'), false, 'Index spawned after cancellation');
    }
    if (stage === 'index') {
      assert.equal(recorded.filter((event) => event.stage === 'index').length, 1, 'second Index spawned after cancellation');
    }
    for (const event of recorded) {
      if (event.pid) assert.equal(alive(event.pid), false, `owned ${event.stage} ${event.pid} survived`);
      if (event.containerId) assert.throws(() => execFileSync(docker,
        [...dockerArgs, 'inspect', event.containerId!], { stdio: 'ignore' }), 'owned container survived');
      for (const origin of [...(event.origins ?? []), ...(event.origin ? [event.origin] : [])]) {
        await assert.rejects(fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }));
      }
    }
    assert.ok(alive(sentinel.pid!), 'unrelated child was killed');
    const after = containers();
    assert.ok(unrelated.every((id) => after.includes(id)), 'unrelated container was removed');
    if (reportCommand) {
      await assert.rejects(stat(reportHtml), { code: 'ENOENT' });
      await assert.rejects(stat(reportEvidence), { code: 'ENOENT' });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (observedClientPid && alive(observedClientPid)) {
      try {
        const command = execFileSync('ps', ['-p', String(observedClientPid), '-o', 'command='],
          { encoding: 'utf8' });
        if (/(?:^|\/)externalClientCli\.(?:ts|js)(?:\s|$)/.test(command)) {
          process.kill(observedClientPid, 'SIGKILL');
        }
      } catch { /* already exited */ }
    }
    sentinel.kill('SIGTERM');
    // RED runs deliberately expose leaks. Only recorded test-owned PIDs and
    // verified-label containers can be touched by this fallback.
    await delay(1700);
    for (const event of await events(log)) {
      if (event.pid && alive(event.pid)) process.kill(event.pid, 'SIGKILL');
      if (event.containerId) {
        try {
          const label = execFileSync(docker, [...dockerArgs, 'inspect', '--format',
            '{{index .Config.Labels "org.nandacity.owned-demo"}}', event.containerId],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          assert.match(label, /^city-[0-9a-f]{16}$/);
          execFileSync(docker, [...dockerArgs, 'rm', '-f', event.containerId], { stdio: 'ignore' });
        } catch { /* already removed */ }
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
