import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/main.mjs';
import { installSdk } from '../src/install.mjs';
import { createExec } from '../src/github.mjs';

const artifact = process.env.MINEBUD_E2E_TEST_TGZ;
test('pinned real JS SDK installs offline and completes the golden suite on a local mock API', { skip: !artifact, timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minebud-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); const runnerTemp = path.join(root, 'temp');
  await mkdir(workspace); await mkdir(runnerTemp);
  const logs = [], calls = [];
  const exec = createExec({ log: (text) => logs.push(text) });
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: 'minebud/example', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'push', GITHUB_WORKFLOW: 'integration', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'), 'INPUT_API-KEY': 'mb_test_0123456789abcdef' };
  for (const key of Object.keys(env)) if (key.startsWith('INPUT_') && key !== 'INPUT_API-KEY') delete env[key];
  const bytes = await readFile(artifact);
  const offlineFetch = async (url, options) => {
    assert.equal(url, 'https://minebud.dev/e2e/minebud-e2e-0.8.0.tgz');
    assert.equal(options.redirect, 'error');
    return new Response(bytes);
  };
  const installed = await installSdk({ runnerTemp, env: { PATH: process.env.PATH, HOME: process.env.HOME }, fetch: offlineFetch, exec, warning: () => assert.fail('pinned install must verify integrity') });
  const packageRoot = path.dirname(path.dirname(installed.args[0]));
  const golden = path.join(packageRoot, 'fixtures/golden/warps');
  await cp(golden, workspace, { recursive: true });
  const server = spawn(process.execPath, [path.join(packageRoot, 'tools/mock-runner/server.js'), '--port', '0', '--world', path.join(golden, 'world.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) { const closed = once(server, 'close'); server.kill('SIGTERM'); await closed; }
  });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Mock runner did not become ready.')), 10_000);
    server.on('error', (error) => { clearTimeout(timeout); reject(error); });
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /mock runner on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Mock runner exited before readiness: ${code}`)); });
  });
  // Install has already been exercised; orchestration consumes the real installed executable.
  env.MINEBUD_API_URL = origin;
  const result = await run({ env, fetch: offlineFetch, log: (text) => logs.push(text), installSdk: async () => ({ ...installed, env: {} }),
    exec: async (command, args, options) => { calls.push({ command, args }); return exec(command, args, options); } });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.outputs.status, 'passed');
  assert.match(result.outputs['run-id'], /^run_[A-Za-z0-9]+$/);
  assert.equal(JSON.parse(await readFile(result.outputs['result-path'], 'utf8')).schema, 'minebud-e2e-result/1');
  const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
  assert.match(output, /run-id<<minebud_[a-f0-9]{32}\nrun_/);
  assert.match(output, /status<<minebud_[a-f0-9]{32}\npassed\n/);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /Status: passed/);
  assert.match(summary, /Tests passed \/ failed \| 2 \/ 0/);
  assert.match(summary, /MSPT p95/);
  const runCall = calls.find((call) => call.args.includes('run'));
  assert.ok(runCall);
  assert.ok(!runCall.args.includes('--wait-for-slot'));
  assert.equal(runCall.args[runCall.args.indexOf('--wait-timeout') + 1], '900');
  assert.equal(logs.filter((line) => line.startsWith('::notice::') && line.includes('does not support --wait-for-slot')).length, 1);
});
