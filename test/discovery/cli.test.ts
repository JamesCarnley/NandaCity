import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli.js';

test('discovery CLI requires an absolute Index checkout and reports usage', async () => {
  let error = '';
  const output = { write: (_value: string) => true };
  const errorOutput = { write: (value: string) => { error += value; return true; } };
  assert.equal(await runCli(['discovery', 'demo'], output, errorOutput), 2);
  assert.match(error, /--index-checkout/);
  error = '';
  assert.equal(await runCli(['discovery', 'demo', '--index-checkout', 'relative/path'],
    output, errorOutput), 2);
  assert.match(error, /absolute/);
});

test('Chicago journey CLI rejects missing or relative pinned Index checkout', async () => {
  let error = '';
  const output = { write: (_value: string) => true };
  const errorOutput = { write: (value: string) => { error += value; return true; } };
  assert.equal(await runCli(['journey', 'demo'], output, errorOutput), 2);
  assert.match(error, /--index-checkout/);
  error = '';
  assert.equal(await runCli(['journey', 'demo', '--index-checkout', 'relative/path'],
    output, errorOutput), 2);
  assert.match(error, /absolute/);
});

test('six-service comparison CLI rejects missing or relative pinned Index checkout', async () => {
  let error = '';
  const output = { write: (_value: string) => true };
  const errorOutput = { write: (value: string) => { error += value; return true; } };
  assert.equal(await runCli(['compare', 'demo'], output, errorOutput), 2);
  assert.match(error, /--index-checkout/);
  error = '';
  assert.equal(await runCli(['compare', 'demo', '--index-checkout', 'relative/path'],
    output, errorOutput), 2);
  assert.match(error, /absolute/);
});

test('static report CLI requires explicit absolute sibling outputs and refuses existing paths before demo', async () => {
  let error = '';
  const output = { write: (_value: string) => true };
  const errorOutput = { write: (value: string) => { error += value; return true; } };
  assert.equal(await runCli(['report', 'demo'], output, errorOutput), 2);
  assert.match(error, /--html.*--evidence/);
  error = '';
  assert.equal(await runCli(['report', 'demo', '--index-checkout', '/tmp/index',
    '--html', 'relative.html', '--evidence', '/tmp/evidence.json'], output, errorOutput), 2);
  assert.match(error, /absolute/i);

  const directory = await mkdtemp(join(tmpdir(), 'city-report-cli-test-'));
  try {
    const htmlPath = join(directory, 'report.html');
    const evidencePath = join(directory, 'evidence.json');
    await writeFile(evidencePath, 'keep');
    error = '';
    assert.equal(await runCli(['report', 'demo', '--index-checkout', '/does-not-exist',
      '--html', htmlPath, '--evidence', evidencePath], output, errorOutput), 1);
    assert.match(error, /exists|EEXIST/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
