#!/usr/bin/env node
// Owned test CLI: remote refusal tests never invoke a real daemon. Signal tests
// forward to the known local daemon and hold the acquisition receipt briefly.
const { execFile } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const config = JSON.parse(readFileSync(join(dirname(__filename), 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const record = (value) => appendFileSync(config.log, `${JSON.stringify(value)}\n`);
if (config.remote) {
  record({ args });
  if (args.includes('inspect') && args.includes('context')) {
    process.stdout.write('ssh://remote.invalid\n');
  } else if (args.includes('show')) {
    process.stdout.write('remote-test\n');
  } else { process.exitCode = 1; }
} else {
  execFile(config.docker, args, { maxBuffer: 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
    const finish = () => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      process.exitCode = error ? 1 : 0;
    };
    if (args.includes('run') && !error) {
      record({ stage: 'container-acquiring', containerId: stdout.trim(), pid: process.pid });
      if (config.stage === 'lost-receipt') {
        // The daemon did create it; the CLI response is lost during startup.
        process.exitCode = 1;
      } else { setTimeout(finish, config.stage === 'container-acquiring' ? 1500 : 0); }
    } else { finish(); }
  });
}
