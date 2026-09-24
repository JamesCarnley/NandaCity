import assert from 'node:assert/strict';
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
