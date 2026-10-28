import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installSdk, waitOptions } from '../src/install.mjs';

const pins = JSON.parse(await readFile(new URL('../sdk-pins.json', import.meta.url), 'utf8'));
async function setup(t, overrides = {}) {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), 'minebud-install-'));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const calls = [], warnings = [];
  return { calls, warnings, options: { runnerTemp, env: { MINEBUD_API_KEY: 'secret', KEEP: 'yes' },
    exec: async (...args) => { calls.push(args); return { code: 0 }; },
    fetch: async () => new Response('override archive'), warning: (text) => warnings.push(text), platform: 'linux', ...overrides } };
}

test('matching pinned archive runs exact offline npm argv and returns Node CLI', async (t) => {
  const bytes = Buffer.from('tiny deterministic SDK fixture');
  const testPins = { ...pins, js: { ...pins.js, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const s = await setup(t, { pins: testPins, fetch: async (url, options) => {
    assert.equal(url, `https://minebud.dev/e2e/minebud-e2e-${pins.js.version}.tgz`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes);
  } });
  const out = await installSdk(s.options);
  const root = path.join(s.options.runnerTemp, 'minebud');
  assert.deepEqual(s.calls[0][1], ['install', '--no-save', '--no-audit', '--no-fund', '--offline', '--ignore-scripts', '--prefix', path.join(root, 'js'), path.join(root, `minebud-e2e-${pins.js.version}.tgz`)]);
  assert.equal(s.calls[0][0], 'npm');
  assert.equal(s.calls[0][2].shell, false);
  assert.equal(s.calls[0][2].env.MINEBUD_API_KEY, undefined);
  assert.equal(out.command, process.execPath);
  assert.deepEqual(out.args, [path.join(root, 'js/node_modules/@minebud/e2e/bin/minebud-e2e.mjs')]);
  assert.equal(out.version, pins.js.version);
  assert.deepEqual(s.warnings, []);
});

test('digest mismatch aborts before npm', async (t) => {
  const s = await setup(t);
  await assert.rejects(installSdk(s.options), { code: 'sdk_integrity_failed' });
  assert.equal(s.calls.length, 0);
});

test('version validation precedes fetch and execution', async (t) => {
  for (const version of ['1.2', 'v1.2.3', '1.2.3;echo hi', '10000.1.1', '1.2.3\n', null, 1]) {
    const s = await setup(t, { version, fetch: () => assert.fail('fetch called') });
    await assert.rejects(installSdk(s.options), { code: 'invalid_input' });
    assert.equal(s.calls.length, 0);
  }
});

test('override warns and skips integrity verification', async (t) => {
  const s = await setup(t, { version: '9.9.9' });
  assert.equal((await installSdk(s.options)).version, '9.9.9');
  assert.match(s.warnings[0], /integrity is not verified/);
  assert.equal(s.calls.length, 1);
});

test('fetch retries only network and 5xx with three attempt cap', async (t) => {
  for (const kind of ['network', 'server', 'client', 'redirect']) {
    let attempts = 0;
    const s = await setup(t, { version: '9.9.9', fetch: async () => {
      attempts++;
      if (kind === 'network') throw new TypeError('connection reset');
      if (kind === 'redirect') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      return new Response('', { status: kind === 'server' ? 503 : 404 });
    } });
    await assert.rejects(installSdk(s.options));
    assert.equal(attempts, ['network', 'server'].includes(kind) ? 3 : 1);
    assert.equal(s.calls.length, 0);
  }
});

test('download bounds declared and streamed bytes without retry', async (t) => {
  for (const declared of [true, false]) {
    let attempts = 0;
    const s = await setup(t, { version: '9.9.9', fetch: async () => {
      attempts++;
      return declared ? new Response('', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } })
        : new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        } }));
    } });
    await assert.rejects(installSdk(s.options), /32 MiB/);
    assert.equal(attempts, 1);
    assert.equal(s.calls.length, 0);
  }
});

test('Windows explicit cmd wrapper quotes argv and rejects expansion paths', async (t) => {
  const s = await setup(t, { platform: 'win32', version: '9.9.9' });
  await installSdk(s.options);
  assert.equal(s.calls[0][0], 'cmd.exe');
  assert.deepEqual(s.calls[0][1].slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(s.calls[0][1][4], /^""npm\.cmd" "install"/);
  assert.equal(s.calls[0][2].windowsVerbatimArguments, true);
  s.options.runnerTemp = path.join(s.options.runnerTemp, '%unsafe%');
  s.calls.length = 0;
  await assert.rejects(installSdk(s.options), /Unsafe Windows/);
  assert.equal(s.calls.length, 0);
});

test('wait options detect an exact flag and clamp legacy timeout', () => {
  assert.deepEqual(waitOptions('  --wait-for-slot SECONDS\n', 3, 20), {
    args: ['--wait-for-slot', '180', '--wait-timeout', '1200'], notice: null,
  });
  for (const help of ['', '--wait-for-slot-other']) {
    const out = waitOptions(help, 3, 20);
    assert.deepEqual(out.args, ['--wait-timeout', '900']);
    assert.match(out.notice, /does not support/);
  }
  assert.deepEqual(waitOptions('', 3, 2).args, ['--wait-timeout', '120']);
});
