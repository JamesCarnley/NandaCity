// A real subprocess stand-in for the provider CLI, not a verifier mock.
const mode = process.argv[2];
if (mode === 'wait') {
  const { writeFileSync } = await import('node:fs');
  if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));
  process.on('SIGTERM', () => { process.exitCode = 143; clearInterval(held); });
  const held = setInterval(() => {}, 100);
} else if (mode === 'overflow') process.stdout.write('x'.repeat(200000));
else if (mode === 'fail') { process.stderr.write('provider-private-detail'); process.exitCode = 1; }
else process.stdout.write('synthetic-provider-output');
