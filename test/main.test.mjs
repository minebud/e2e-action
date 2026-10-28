import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { run, actionFailed } from '../src/main.mjs';
import { parseInputs, childEnv, outputRecord, createExec, readBoundedFile } from '../src/github.mjs';
const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
async function setup(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minebud-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const temp = path.join(root, 'temp');
  await mkdir(workspace); await mkdir(temp);
  const env = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp, GITHUB_REPOSITORY: 'minebud/example', GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'), 'INPUT_API-KEY': 'mb_test_only_key', FAKE_FIXTURE: path.join(fixtures, 'passing.json'), FAKE_TRACE: path.join(root, 'trace'), ...overrides };
  for (const key of Object.keys(process.env)) if (key.startsWith('INPUT_') && !Object.hasOwn(overrides, key) && key !== 'INPUT_API-KEY') delete env[key];
  const logs = [];
  return { root, env, logs, deps: { env, log: (text) => logs.push(text), installSdk: async () => ({ command: process.execPath, args: [path.join(fixtures, 'fake-sdk.mjs')], env: {} }) } };
}
function parseOutput(text) {
  const lines = text.trimEnd().split('\n');
  const values = {};
  for (let i = 0; i < lines.length;) {
    const [name, delimiter] = lines[i++].split('<<');
    assert.match(delimiter, /^minebud_[a-f0-9]{32}$/);
    const value = [];
    while (lines[i] !== delimiter) { assert.ok(i < lines.length, 'closing delimiter'); value.push(lines[i++]); }
    i++;
    values[name] = value.join('\n');
  }
  return values;
}

test('exit-code matrix respects infra policy and always fails breached thresholds', () => {
  for (const code of [0, 1, 2, 3, 4, 5, 130, 99]) for (const failOnInfra of [false, true]) {
    assert.equal(actionFailed(code, failOnInfra), code === 0 ? false : [3, 4, 5].includes(code) ? failOnInfra : true, `${code}/${failOnInfra}`);
    assert.equal(actionFailed(code, failOnInfra, true), true);
  }
});
test('input validation rejects typos and path escapes before installation even without a key', async (t) => {
  const s = await setup(t, { 'INPUT_API-KEY': '' });
  const invalid = { 'SDK-VERSION': '1.2.3;echo', 'WAIT-TIMEOUT-MINUTES': '361', 'QUEUE-TIMEOUT-MINUTES': '0', 'MAX-MSPT-P95': 'NaN', 'MAX-SCRIPT-HOTSPOT-MS': 'Infinity', 'MAX-SCRIPT-ERRORS': '-1', 'MAX-REGRESSION-PCT': '-1', 'MIN-REGRESSION-MS': '1e999', 'FAIL-ON-INFRA': 'yes', ANNOTATIONS: '1', SUMMARY: 'FALSE', 'ON-MISSING-KEY': 'ignore', 'FAIL-ON-INSIGHT-SEVERITY': 'fatal', BASELINE: '../main', 'WORKING-DIRECTORY': '..', CONFIG: '../outside.json', JUNIT: path.join(s.root, 'outside.xml'), PATHS: '../outside.mjs', 'API-KEY': 'bad key' };
  for (const [name, value] of Object.entries(invalid)) {
    const result = await run({ ...s.deps, env: { ...s.env, [`INPUT_${name}`]: value }, installSdk: () => assert.fail('installation must not run') });
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.outputs.status, 'error', name);
  }
  await symlink(s.root, path.join(s.env.GITHUB_WORKSPACE, 'outside'));
  assert.throws(() => parseInputs({ ...s.env, INPUT_CONFIG: 'outside/new/config.json' }), /inside GITHUB_WORKSPACE/);
  const valid = parseInputs({ ...s.env, 'INPUT_WAIT-TIMEOUT-MINUTES': ' 30 ', INPUT_PATHS: 'e2e/a.mjs\n e2e/b.mjs' });
  assert.equal(valid['wait-timeout-minutes'], 30);
  assert.deepEqual(valid.paths, ['e2e/a.mjs', 'e2e/b.mjs'].map((p) => path.join(s.env.GITHUB_WORKSPACE, p)));
});
test('missing key skips fork PR without installing, or fails explicitly', async (t) => {
  const missing = JSON.parse(await readFile(path.join(fixtures, 'missing-key.json'), 'utf8'));
  const s = await setup(t, { ...missing, GITHUB_EVENT_PATH: path.join(fixtures, 'fork-event.json') });
  const skipped = await run({ ...s.deps, installSdk: () => assert.fail('must not install') });
  assert.equal(skipped.exitCode, 0);
  assert.equal(parseOutput(await readFile(s.env.GITHUB_OUTPUT, 'utf8')).status, 'skipped');
  assert.match(await readFile(s.env.GITHUB_STEP_SUMMARY, 'utf8'), /This pull request is from a fork/);
  assert.ok(s.logs.some((line) => line.startsWith('::notice::')));
  const failed = await run({ ...s.deps, env: { ...s.env, 'INPUT_ON-MISSING-KEY': 'fail' }, installSdk: () => assert.fail('must not install') });
  assert.equal(failed.exitCode, 1);
});
test('real spawn records result, safe child environment, legacy wait clamp, and framed stderr', async (t) => {
  const s = await setup(t, { FAKE_STDERR: '::error::not an annotation\n', INPUT_UNUSED: 'must-not-leak' });
  const result = await run(s.deps);
  assert.equal(result.exitCode, 0);
  const values = parseOutput(await readFile(s.env.GITHUB_OUTPUT, 'utf8'));
  assert.equal(values.status, 'passed');
  assert.equal(values['run-id'], 'run_golden');
  assert.equal(values['mspt-p95'], '7.4');
  assert.equal(values['dashboard-url'], 'https://minebud.dev/dashboard/runs/run?id=run_golden');
  assert.equal(JSON.parse(await readFile(values['result-path'], 'utf8')).name, 'warps-golden');
  const trace = JSON.parse(await readFile(s.env.FAKE_TRACE, 'utf8'));
  assert.deepEqual(trace.inputKeys, []);
  assert.equal(trace.keyPresent, true);
  assert.equal(trace.cwd, s.env.GITHUB_WORKSPACE);
  assert.ok(!trace.args.includes(s.env['INPUT_API-KEY']));
  assert.ok(!trace.args.includes('--wait-for-slot'));
  assert.equal(trace.args[trace.args.indexOf('--wait-timeout') + 1], '900');
  assert.ok(trace.args.includes('--no-save'));
  const log = s.logs.join('');
  assert.equal(s.logs.filter((line) => line.startsWith('::add-mask::')).length, 1);
  assert.match(log, /::stop-commands::([a-f0-9]{32})\n[\s\S]*::error::not an annotation\n[\s\S]*::\1::/);
  assert.ok(!log.includes('"schema"'));
  assert.match(await readFile(s.env.GITHUB_STEP_SUMMARY, 'utf8'), /Status: passed/);
});
test('real spawn newer SDK, failing step annotations, and threshold breach cannot be ignored', async (t) => {
  const s = await setup(t, { FAKE_FIXTURE: path.join(fixtures, 'failing.json'), FAKE_NEW_SDK: 'true', FAKE_EXIT: '3', 'INPUT_FAIL-ON-INFRA': 'false', 'INPUT_MAX-MSPT-P95': '7' });
  const result = await run(s.deps);
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.outputs.regressions)[0].id, 'max-mspt-p95');
  const trace = JSON.parse(await readFile(s.env.FAKE_TRACE, 'utf8'));
  assert.equal(trace.args[trace.args.indexOf('--wait-for-slot') + 1], '900');
  assert.equal(trace.args[trace.args.indexOf('--wait-timeout') + 1], '1800');
  assert.ok(s.logs.some((line) => line.startsWith('::error file=tests/warps.e2e.mjs,line=42,col=7,title=two players chat/s6::')));
  assert.ok(s.logs.some((line) => line.startsWith('::warning::SDK infrastructure exit 3')));
});
test('real spawn upcoming contract carries envelope digest and hotspot thresholds into reporting', async (t) => {
  const s = await setup(t, { FAKE_FIXTURE: path.join(fixtures, 'locations-contract.json'), FAKE_NEW_SDK: 'true',
    'INPUT_WORKING-DIRECTORY': 'project', 'INPUT_MAX-SCRIPT-HOTSPOT-MS': '19' });
  await mkdir(path.join(s.env.GITHUB_WORKSPACE, 'project'));
  const result = await run(s.deps);
  assert.equal(result.exitCode, 1);
  assert.ok(s.logs.some((line) => line.startsWith('::error file=src/hotspot.ts,line=15,title=Script hotspot::hotspot-marker self time 20 ms')));
  assert.ok(s.logs.some((line) => line.startsWith('::error file=src/digest.ts,line=18,title=script-error::digest-error-marker (×3)')));
  const summary = await readFile(s.env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.includes(`/blob/${'a'.repeat(40)}/src/digest.ts#L18`));
  assert.ok(summary.includes('Script hotspots'));
});
test('default-branch lookup never prevents the run when payload repository metadata is absent', async (t) => {
  for (const name of ['schedule', 'workflow_dispatch', 'push', 'pull_request', 'other']) {
    const s = await setup(t, { INPUT_BASELINE: 'default-branch', GITHUB_EVENT_NAME: name, GITHUB_REF_NAME: 'main' });
    s.env.GITHUB_EVENT_PATH = path.join(s.root, 'event.json');
    await writeFile(s.env.GITHUB_EVENT_PATH, JSON.stringify(name === 'schedule' ? { schedule: '17 3 * * *' } : {}));
    const requestedRefs = [];
    const result = await run({ ...s.deps, fetch: async (url) => {
      requestedRefs.push(new URL(url).searchParams.get('ref'));
      return Response.json({ baseline: null });
    } });
    assert.equal(result.exitCode, 0, name);
    assert.equal(result.outputs.status, 'passed', name);
    assert.ok(result.thresholds.checks.every((check) => check.status === 'not_compared'), name);
    assert.deepEqual(requestedRefs, name === 'schedule' ? ['main'] : [], name);
    assert.equal(s.logs.some((line) => line.startsWith('::warning::Baseline unavailable')), name !== 'schedule', name);
    assert.equal(JSON.parse(await readFile(s.env.FAKE_TRACE, 'utf8')).keyPresent, true);
  }
});
test('SDK errors still write escaped summary and outputs under infra policy', async (t) => {
  const errors = JSON.parse(await readFile(path.join(fixtures, 'errors.json'), 'utf8'));
  for (const [kind, envelope] of Object.entries(errors)) for (const failOnInfra of [true, false]) {
    const s = await setup(t, { FAKE_EXIT: String(envelope.exitCode), 'INPUT_FAIL-ON-INFRA': String(failOnInfra) });
    const file = path.join(s.root, 'error.json'); await writeFile(file, JSON.stringify(envelope)); s.env.FAKE_FIXTURE = file;
    const result = await run(s.deps);
    assert.equal(result.exitCode, envelope.exitCode === 3 && !failOnInfra ? 0 : 1, kind);
    assert.equal(parseOutput(await readFile(s.env.GITHUB_OUTPUT, 'utf8')).status, 'error');
    const summary = await readFile(s.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.ok(summary.includes('CLI error:'));
    assert.ok(!summary.includes('<script>'));
    assert.ok(!summary.includes('[a](http://evil)'));
  }
});
test('envelope-only result is saved, disabled reports still emit outputs, invalid dashboard id is not linked', async (t) => {
  const s = await setup(t, { FAKE_NO_OUT: 'true', 'INPUT_SUMMARY': 'false', 'INPUT_ANNOTATIONS': 'false' });
  const fixture = JSON.parse(await readFile(path.join(fixtures, 'insights.json'), 'utf8')); fixture.runId = 'bad\nrun';
  const file = path.join(s.root, 'fixture.json'); await writeFile(file, JSON.stringify(fixture)); s.env.FAKE_FIXTURE = file;
  const result = await run(s.deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputs['dashboard-url'], '');
  assert.equal(JSON.parse(await readFile(result.outputs['result-path'], 'utf8')).runId, 'bad\nrun');
  await assert.rejects(readFile(s.env.GITHUB_STEP_SUMMARY), { code: 'ENOENT' });
  assert.ok(!s.logs.some((line) => /^::(?:error|warning|notice) file=/.test(line)));
});
test('outputs use random collision-free multiline delimiters; child env never forwards inputs', () => {
  let attempt = 0;
  const value = `first\nminebud_${'00'.repeat(16)}\nlast`;
  const output = outputRecord('status', value, () => Buffer.alloc(16, attempt++));
  assert.equal(parseOutput(output).status, value);
  assert.equal(attempt, 2);
  const a = outputRecord('status', 'passed'), b = outputRecord('status', 'passed');
  assert.notEqual(a.split('\n')[0], b.split('\n')[0]);
  assert.deepEqual(childEnv({ INPUT_KEY: 'a', 'INPUT_API-KEY': 'b', PATH: 'keep', MINEBUD_API_KEY: 'old' }, 'new'), { PATH: 'keep', MINEBUD_API_KEY: 'new' });
});
test('signal forwarding is installed only during child lifetime and cleans up', async () => {
  const signals = new EventEmitter(); const killed = []; const logs = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = (signal) => killed.push(signal);
  const exec = createExec({ signals, log: (s) => logs.push(s), spawn: () => { setImmediate(() => { signals.emit('SIGINT'); signals.emit('SIGTERM'); child.emit('close', 130); }); return child; } });
  assert.equal((await exec('node', [], { forwardSignals: true })).code, 130);
  assert.deepEqual(killed, ['SIGINT', 'SIGTERM']);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});
test('bounded stdout, bounded files, and log redaction fail safely', async (t) => {
  const logs = [];
  const exec = createExec({ log: (s) => logs.push(s), secret: 'secret-key' });
  const child = await exec(process.execPath, ['-e', 'process.stderr.write("secret-"); setTimeout(()=>process.stderr.write("key\\n::warning::payload"),10)']);
  assert.equal(child.code, 0);
  assert.ok(!logs.join('').includes('secret-key'));
  assert.match(logs.join(''), /\[redacted\]/);
  await assert.rejects(exec(process.execPath, ['-e', 'console.log("x".repeat(1000))'], { maxStdoutBytes: 20 }), /size limit/);
  const s = await setup(t); const file = path.join(s.root, 'large'); await writeFile(file, 'x'.repeat(100));
  await assert.rejects(readBoundedFile(file, 10), /size limit/);
});
