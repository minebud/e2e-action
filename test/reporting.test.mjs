import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapeData, escapeProperty, containedPath, buildAnnotations } from '../src/annotate.mjs';
import { renderSummary } from '../src/summary.mjs';

function workspace(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'minebud-reporting-'));
  const root = path.join(directory, 'workspace');
  mkdirSync(path.join(root, 'project'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, workspace: root, workingDirectory: path.join(root, 'project') };
}

function result() {
  return {
    schema: 'minebud-e2e-result/1', runId: 'run_123-abc', status: 'failed', avgTps: 19.5,
    summary: { tests: 2, passed: 1, failed: 1, errored: 0, skipped: 0 },
    server: { type: 'endstone', speed: 'standard' },
    metrics: { 'tps.mean': 20, 'mspt.p95': 30, 'memory.rssMaxMb': 512, 'scriptErrors.count': 2 },
    tests: [{ id: 't1', name: 'warps', status: 'failed', steps: [{
      id: 's1', status: 'failed', error: { message: 'wrong block', expected: { name: 'stone' }, actual: { name: 'air' } },
      source: { file: 'tests/warps.mjs', line: 7, column: 3 },
    }] }],
    diagnostics: { performance: {
      nativeProfile: { top: [
        { function: 'native', selfMs: 200 },
        { function: 'update', selfMs: 12, packUuid: 'pack-1', file: 'scripts/main.js', line: 9 },
      ] },
      insights: [{ severity: 'medium', rule: 'slow-tick', message: 'Too much work.', fix: 'Batch updates.', localFile: 'scripts/main.js', line: 9 }],
    } },
    billing: { chargedCredits: 200, ticks: 200, speed: 'standard' },
  };
}

function context(options, value = result()) {
  return { ...options, result: value, sdkExitCode: 1, env: { GITHUB_REPOSITORY: 'minebud/example', GITHUB_SHA: 'a'.repeat(40) }, event: {},
    thresholds: { checks: [
      { id: 'max-mspt-p95', label: 'MSPT maximum', value: 30, limit: 25, status: 'breach' },
      { id: 'mspt-regression', label: 'MSPT regression', value: 30, limit: 24, baseline: 20, status: 'breach' },
      { id: 'hotspot-regression', label: 'Hotspot regression', value: 12, limit: null, baseline: null, status: 'not_compared', reason: 'missing baseline' },
    ], breached: true, regressions: [] }, annotations: { lines: [], emitted: [], overflow: [] } };
}

test('workflow command data and property escaping is exact and ordered', () => {
  const input = 'x%0A::set-output name=a::b\r\n<script>|[a](http://evil),';
  assert.equal(escapeData(input), 'x%250A::set-output name=a::b%0D%0A<script>|[a](http://evil),');
  assert.equal(escapeProperty(input), 'x%250A%3A%3Aset-output name=a%3A%3Ab%0D%0A<script>|[a](http%3A//evil)%2C');
});

test('annotations contain escaped properties, object error messages, and bounded raw fields', (t) => {
  const options = workspace(t);
  const value = result();
  value.tests[0].name = 't,:\r\n%';
  value.tests[0].steps[0].error.message = 'x%0A::set-output name=a::b\r\n<script>|[a](http://evil)';
  const annotations = buildAnnotations(value, options);
  assert.equal(annotations.lines[0], '::error file=project/tests/warps.mjs,line=7,col=3,title=t%2C%3A%0D%0A%25/s1::x%250A::set-output name=a::b%0D%0A<script>|[a](http://evil)');
  assert.equal(annotations.lines[1], '::warning file=project/scripts/main.js,line=9,title=slow-tick::Too much work. Fix: Batch updates.');
  value.tests[0].name = '%'.repeat(1000);
  value.tests[0].steps[0].error.message = '%'.repeat(10000);
  const bounded = buildAnnotations(value, options);
  assert.equal(bounded.emitted[0].title.length, 200);
  assert.equal(bounded.emitted[0].message.length, 4000);
  assert.ok(bounded.lines[0].includes('%25'.repeat(199) + '…'));
  assert.ok(bounded.lines[0].endsWith('%25'.repeat(3999) + '…'));
});

test('annotations rank failures first and cap exactly ten of each severity', (t) => {
  const options = workspace(t);
  const value = result();
  value.tests[0].steps = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, status: index % 2 ? 'error' : 'failed', error: { message: `failure ${index}` }, source: { file: 'test.mjs', line: index + 1 } }));
  value.diagnostics.performance.insights = ['low', 'medium', 'high'].flatMap((severity) => Array.from({ length: 12 }, (_, index) => ({ severity, rule: `${severity}-${index}`, message: 'message', fix: 'fix', localFile: 'script.js', line: index + 1 })));
  const annotations = buildAnnotations(value, options);
  assert.deepEqual(['error', 'warning', 'notice'].map((level) => annotations.emitted.filter((item) => item.level === level).length), [10, 10, 10]);
  assert.deepEqual(annotations.emitted.slice(0, 10).map((item) => item.title), Array.from({ length: 10 }, (_, index) => `warps/s${index}`));
  assert.equal(annotations.overflow.length, 18);
  assert.ok(annotations.overflow.every((item) => item.reason === 'annotation limit'));
  assert.equal(annotations.emitted[10].title, 'medium-0');
  assert.equal(annotations.emitted[20].title, 'low-0');
});

test('contained paths reject traversal, controls, outside absolute paths, and symlink ancestors', (t) => {
  const options = workspace(t);
  const outside = path.join(options.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'outside.js'), '');
  symlinkSync(outside, path.join(options.workingDirectory, 'escape'));
  symlinkSync(path.join(outside, 'missing'), path.join(options.workingDirectory, 'dangling'));
  symlinkSync(options.workspace, path.join(outside, 'return'));
  symlinkSync(options.workingDirectory, path.join(options.workspace, 'inside'));
  assert.equal(containedPath('tests/../test.mjs', options), 'project/test.mjs');
  assert.equal(containedPath(path.join(options.workspace, 'absolute.js'), options), 'absolute.js');
  assert.equal(containedPath('inside/new/file.js', { ...options, workingDirectory: options.workspace }), 'inside/new/file.js');
  for (const file of ['../../outside/outside.js', path.join(outside, 'outside.js'), 'a\nb.js', 'a\u007fb.js', 'escape/outside.js', 'escape/missing/nested.js', 'dangling/new.js', 'escape/return/project/test.js']) {
    assert.equal(containedPath(file, options), null, file);
  }
  const value = result();
  value.tests[0].steps = [
    { id: 'outside', status: 'failed', source: { file: '../../outside.js', line: 1 } },
    { id: 'line', status: 'failed', source: { file: 'good.js', line: 0 } },
    { id: 'column', status: 'error', source: { file: 'good.js', line: 1, column: -1 } },
  ];
  value.diagnostics.performance.insights = [];
  const annotations = buildAnnotations(value, options);
  assert.equal(annotations.lines.length, 0);
  assert.deepEqual(annotations.overflow.map((item) => item.reason), ['invalid path', 'invalid line', 'invalid column']);
});

test('summary renders all metrics, failures, comparisons, thresholds, billing and overflow', (t) => {
  const options = workspace(t);
  const ctx = context(options);
  ctx.annotations.overflow = [{ level: 'error', title: 'overflow', message: 'extra failure', reason: 'annotation limit', file: 'test.js', line: 2 }];
  const output = renderSummary(ctx);
  for (const text of ['Status: failed', 'Run: run\\_123-abc', '[Dashboard](https://minebud.dev/dashboard/runs/run?id=run_123-abc)', 'Tests passed / failed | 1 / 1', 'TPS mean | 20', 'MSPT p95 | 30 ms (+10 ms / +50% vs baseline)', 'Memory peak (RSS) | 512 MB', 'Script errors | 2', 'Top hotspot | update — 12 ms — scripts/main.js:9', 'wrong block', 'Expected: \\{&quot;name&quot;:&quot;stone&quot;\\}', 'Actual: \\{&quot;name&quot;:&quot;air&quot;\\}', 'slow-tick — Too much work. Fix: Batch updates.', 'MSPT maximum | 30 | 25', 'not compared: missing baseline', 'Charged credits: 200', 'Ticks: 200', 'Speed: standard', 'Annotation overflow', 'extra failure']) assert.ok(output.includes(text), text);
  delete ctx.result.metrics['tps.mean'];
  ctx.thresholds.checks.find((item) => item.id === 'mspt-regression').status = 'not_compared';
  const missing = renderSummary(ctx);
  assert.ok(missing.includes('TPS mean | 19.5'));
  assert.ok(missing.includes('MSPT p95 | 30 ms (not compared)'));
  assert.ok(!missing.includes('+50%'));
});

test('test-level errors retain expected and actual values when no step result exists', (t) => {
  const ctx = context(workspace(t));
  ctx.result.tests = [{ id: 't1', name: 'setup failure', status: 'error',
    error: { message: 'Setup assertion failed', expected: 'ready', actual: null } }];
  const summary = renderSummary(ctx);
  assert.ok(summary.includes('Setup assertion failed'));
  assert.ok(summary.includes('Expected: &quot;ready&quot;'));
  assert.ok(summary.includes('Actual: null'));
});

test('summary source links use PR head SHA, validated GitHub origin and encoded contained paths', (t) => {
  const options = workspace(t);
  const ctx = context(options);
  // Isolate insight links; failing step sources are independently linked too.
  ctx.result.tests = [];
  ctx.event.pull_request = { head: { sha: 'b'.repeat(64) } };
  ctx.result.diagnostics.performance.insights[0].localFile = "scripts/a b')].js";
  const expected = `https://github.com/minebud/example/blob/${'b'.repeat(64)}/project/scripts/a%20b%27%29%5D.js#L9`;
  assert.ok(renderSummary(ctx).includes(`[Source](${expected})`));
  const variants = [
    { env: { ...ctx.env, GITHUB_SERVER_URL: 'https://evil.example' } },
    { env: { ...ctx.env, GITHUB_REPOSITORY: 'minebud/..' } },
    { env: { ...ctx.env, GITHUB_REPOSITORY: 'bad.owner/repo' } },
    { env: { ...ctx.env, GITHUB_REPOSITORY: 'owner/repo/extra' } },
    { event: { pull_request: { head: { sha: 'A'.repeat(40) } } } },
    { event: { pull_request: { head: { sha: 'bad' } } } },
  ];
  for (const variant of variants) assert.ok(!renderSummary({ ...ctx, ...variant }).includes('[Source]('));
  ctx.env.GITHUB_SERVER_URL = 'https://github.com';
  assert.ok(renderSummary(ctx).includes('[Source]('));
  delete ctx.event.pull_request;
  assert.ok(renderSummary(ctx).includes(`/blob/${'a'.repeat(40)}/`));
  ctx.result.diagnostics.performance.insights[0].localFile = '../../outside.js';
  assert.ok(!renderSummary(ctx).includes('[Source]('));
  ctx.result.diagnostics.performance.insights[0].localFile = 'good.js';
  ctx.result.diagnostics.performance.insights[0].line = 0;
  assert.ok(!renderSummary(ctx).includes('[Source]('));
});

test('summary neutralizes HTML, Markdown, command injection and table newlines', (t) => {
  const options = workspace(t);
  const ctx = context(options);
  const injection = 'x%0A::set-output name=a::b\r\n<script>|[a](http://evil)';
  ctx.result.tests[0].name = injection;
  ctx.result.tests[0].steps[0].error.message = injection;
  ctx.result.diagnostics.performance.insights[0].message = injection;
  ctx.result.diagnostics.performance.nativeProfile.top[1].function = '\\`*_[]()#|~!{}<> & "\'';
  ctx.result.runId = injection;
  const output = renderSummary(ctx);
  assert.ok(output.includes('x%0A::set-output name=a::b &lt;script&gt;\\|\\[a\\]\\(http://evil\\)'));
  assert.ok(!output.includes('\\&'));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('[a](http://evil)'));
  assert.ok(!output.includes('\r'));
  assert.ok(!output.includes('[Dashboard]('));
  assert.ok(output.includes('\\\\\\`\\*\\_\\[\\]\\(\\)\\#\\|\\~\\!\\{\\}&lt;&gt; &amp; &quot;&#39;'));
  ctx.result.runId = 'safe_id';
  ctx.result.tests[0].steps[0].error.expected = null;
  ctx.result.tests[0].steps[0].error.actual = 'actual';
  const json = renderSummary(ctx);
  assert.ok(json.includes('Expected: null'));
  assert.ok(json.includes('Actual: &quot;actual&quot;'));
  ctx.result.diagnostics.performance.nativeProfile.top[1].function = 'a|b';
  assert.ok(renderSummary(ctx).includes('| a\\|b | 12 |'));
});

test('summary variants tolerate skipped runs, CLI errors and missing optional result fields', (t) => {
  const options = workspace(t);
  const skipped = renderSummary({ ...options, skipped: true, note: 'No API key: <skip>' });
  assert.ok(skipped.includes('Status: skipped'));
  assert.ok(skipped.includes('No API key: &lt;skip&gt;'));
  const cli = renderSummary({ ...options, error: { code: 'sdk_failed', message: '<bad>\ncommand' }, sdkExitCode: 3 });
  assert.ok(cli.includes('Status: error'));
  assert.ok(cli.includes('CLI error: sdk\\_failed — &lt;bad&gt; command'));
  assert.ok(cli.includes('SDK exit code: 3'));
  const minimal = renderSummary({ ...options, result: { status: 'passed' } });
  assert.ok(minimal.includes('No insights available.'));
  assert.ok(minimal.includes('No thresholds configured.'));
  assert.ok(minimal.includes('Memory peak (RSS) | unavailable'));
  assert.ok(renderSummary({ ...options, result: { status: 'rejected' } }).includes('Status: rejected'));
});

test('summary keeps stable severity order and limits failures, steps and insights', (t) => {
  const options = workspace(t);
  const ctx = context(options);
  ctx.result.tests = Array.from({ length: 52 }, (_, index) => ({ id: `t${index}`, name: `test-${index}`, status: 'failed', steps: Array.from({ length: 22 }, (_, step) => ({ id: `s${step}`, status: 'failed', error: 'failure' })) }));
  ctx.result.diagnostics.performance.insights = [
    ...Array.from({ length: 5 }, (_, index) => ({ severity: 'low', rule: `info-${index}` })),
    ...Array.from({ length: 6 }, (_, index) => ({ severity: 'medium', rule: `warning-${index}` })),
    ...Array.from({ length: 2 }, (_, index) => ({ severity: 'high', rule: `error-${index}` })),
  ];
  const output = renderSummary(ctx);
  assert.ok(output.includes('and 2 more failing tests'));
  assert.ok(output.includes('and 2 more failing steps'));
  assert.ok(!output.includes('#### test-50'));
  assert.ok(!output.includes('- Step s20:'));
  assert.ok(output.indexOf('error-0') < output.indexOf('error-1'));
  assert.ok(output.indexOf('error-1') < output.indexOf('warning-0'));
  assert.ok(output.indexOf('warning-5') < output.indexOf('info-0'));
  assert.ok(!output.includes('info-2'));
  assert.ok(output.includes('and 3 more insights'));
});

test('huge Unicode summary remains at most one million UTF-8 bytes with explicit truncation', (t) => {
  const options = workspace(t);
  const ctx = context(options);
  const huge = '<😀&|'.repeat(2000);
  ctx.result.tests = Array.from({ length: 60 }, (_, index) => ({ id: `t${index}`, name: huge, status: 'failed', steps: Array.from({ length: 25 }, (_, step) => ({ id: `s${step}`, status: 'failed', error: { message: huge, expected: { value: huge }, actual: huge } })) }));
  ctx.annotations.overflow = Array.from({ length: 1000 }, () => ({ title: huge, message: huge, reason: 'annotation limit' }));
  const output = renderSummary(ctx);
  assert.ok(Buffer.byteLength(output, 'utf8') <= 1_000_000);
  assert.ok(output.includes('Summary truncated:'));
  assert.ok(output.includes('Status: failed'));
  assert.ok(!output.includes('\uFFFD'));
});
