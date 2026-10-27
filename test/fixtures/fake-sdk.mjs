// Test-only CLI: emits recorded SDK 0.8.0 envelopes, never submits a run.
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'help') {
  console.log(`minebud-e2e run --json --out FILE --wait-timeout SEC ${process.env.FAKE_NEW_SDK === 'true' ? '--wait-for-slot SEC' : ''}`);
} else if (args[0] === 'run') {
  const fixture = JSON.parse(readFileSync(process.env.FAKE_FIXTURE, 'utf8'));
  const code = Number(process.env.FAKE_EXIT ?? 0);
  const envelope = fixture.schema === 'minebud-e2e-cli/1' ? fixture : { schema: 'minebud-e2e-cli/1', exitCode: code, digest: {}, result: fixture };
  const out = args[args.indexOf('--out') + 1];
  if (envelope.result && process.env.FAKE_NO_OUT !== 'true') writeFileSync(out, JSON.stringify(envelope.result));
  if (process.env.FAKE_TRACE) writeFileSync(process.env.FAKE_TRACE, JSON.stringify({ args, inputKeys: Object.keys(process.env).filter((key) => key.startsWith('INPUT_')), keyPresent: !!process.env.MINEBUD_API_KEY, cwd: process.cwd() }));
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
  console.log(JSON.stringify(envelope));
  process.exitCode = code;
}
