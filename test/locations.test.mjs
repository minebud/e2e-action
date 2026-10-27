import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAnnotations } from '../src/annotate.mjs';
import { renderSummary } from '../src/summary.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
const sha = 'a'.repeat(40);
const sourceUrl = (file, line) => `https://github.com/minebud/example/blob/${sha}/${file}#L${line}`;
function context(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'minebud-locations-'));
  const workspace = path.join(directory, 'workspace');
  const workingDirectory = path.join(workspace, 'project');
  mkdirSync(workingDirectory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envelope = load('locations-contract');
  return { directory, workspace, workingDirectory, result: envelope.result, digest: envelope.digest,
    env: { GITHUB_REPOSITORY: 'minebud/example', GITHUB_SHA: sha }, event: {},
    thresholds: { checks: [], breached: false, regressions: [] }, annotations: { emitted: [], lines: [], overflow: [] } };
}
const annotations = (ctx) => buildAnnotations(ctx.result, ctx);
function insightOnly(ctx) {
  ctx.result.tests = [];
  ctx.result.diagnostics.performance.nativeProfile.top = [];
  ctx.result.diagnostics.performance.insights = [ctx.result.diagnostics.performance.insights[0]];
  ctx.digest.items = [];
  return ctx.result.diagnostics.performance.insights[0];
}

test('contract location pairs prefer source and use workspace rather than subdirectory cwd', (t) => {
  const ctx = context(t);
  const emitted = annotations(ctx).emitted;
  for (const [marker, file, line] of [
    ['step-marker', 'src/step.ts', 11], ['insight-error-marker', 'src/insight.ts', 12],
    ['digest-error-marker', 'src/digest.ts', 18], ['hotspot-marker', 'src/hotspot.ts', 15],
    ['insight-warning-marker', 'src/insight-warning.ts', 13], ['digest-warning-marker', 'src/warning.ts', 19],
  ]) {
    const item = emitted.find((item) => `${item.title} ${item.message}`.includes(marker));
    assert.ok(item, marker);
    assert.equal(item.file, file, marker);
    assert.equal(item.line, line, marker);
    assert.ok(renderSummary(ctx).includes(sourceUrl(file, line)), marker);
  }
});

test('incomplete or mistyped pairs fall back atomically without mixing line or path', (t) => {
  const ctx = context(t);
  const insight = insightOnly(ctx);
  for (const [location, expectedFile, expectedLine] of [
    [{ sourcePath: 'src/source.ts', repoPath: 'repo/built.js', line: 7 }, 'repo/built.js', 7],
    [{ sourceLine: 22, repoPath: 'repo/built.js', line: 7 }, 'repo/built.js', 7],
    [{ sourcePath: 'src/source.ts', sourceLine: '22', repoPath: 'repo/built.js', line: 7 }, 'repo/built.js', 7],
    [{ sourcePath: 'src/source.ts', sourceLine: 0, repoPath: 'repo/built.js', line: 7 }, 'repo/built.js', 7],
    [{ repoPath: 'repo/built.js' }, 'project/legacy-insight.js', 92],
    [{ line: 7 }, 'project/legacy-insight.js', 92],
    [{ sourcePath: 'src/source.ts', sourceLine: 22, repoPath: 'repo/built.js' }, 'src/source.ts', 22],
  ]) {
    insight.location = location;
    const [item] = annotations(ctx).emitted;
    assert.equal(item.file, expectedFile, JSON.stringify(location));
    assert.equal(item.line, expectedLine, JSON.stringify(location));
  }
});

test('selected new paths reject traversal, controls, outside absolutes and escaping symlinks', (t) => {
  const ctx = context(t);
  const insight = insightOnly(ctx);
  const outside = path.join(ctx.directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(ctx.workspace, 'escape'));
  symlinkSync(path.join(outside, 'missing'), path.join(ctx.workspace, 'dangling'));
  for (const file of ['../outside/a.ts', path.join(outside, 'a.ts'), 'a\nb.ts', 'a\u0000b.ts', 'a\u007fb.ts', 'escape/a.ts', 'escape/missing/a.ts', 'dangling/a.ts']) {
    insight.location = { sourcePath: file, sourceLine: 5, repoPath: 'safe.js', line: 6 };
    assert.equal(annotations(ctx).emitted.length, 0, file);
    assert.ok(!renderSummary(ctx).includes('[Source]('), file);
    insight.location = { repoPath: file, line: 5 };
    assert.equal(annotations(ctx).emitted.length, 0, file);
  }
});

test('validated supplied GitHub href is retained exactly for insights and hotspots', (t) => {
  const ctx = context(t);
  ctx.result.tests = [];
  ctx.digest.items = [];
  const exact = `https://github.com/minebud/example/blob/${'b'.repeat(40)}/src/original%2Ets#L37`;
  for (const item of [ctx.result.diagnostics.performance.insights[0], ctx.result.diagnostics.performance.nativeProfile.top[1]]) item.githubUrl = exact;
  const summary = renderSummary(ctx);
  assert.ok(summary.split('### Top insights')[1].includes(`[Source](${exact})`));
  assert.ok(summary.split('\n').find((line) => line.startsWith('| Top hotspot |')).includes(`[Source](${exact})`));
  assert.ok(summary.split('### Script hotspots')[1].includes(`[Source](${exact})`));
});

test('unsafe supplied GitHub URLs fall back to the contained source link', (t) => {
  const ctx = context(t);
  const insight = insightOnly(ctx);
  const base = `https://github.com/minebud/example/blob/${sha}`;
  for (const url of [
    `${base}/src/a.ts?raw=1#L12`, `${base}/src/a).ts#L12`, `${base}/src/a b.ts#L12`,
    `${base}/src/%2e%2e/a.ts#L12`, `${base}/src/%2E%2E/a.ts#L12`,
    `${base}/../a.ts#L12`, `${base}/src/a.ts#L12`.replace('minebud/example', 'minebud/other'),
    `${base}/src/a.ts#L12`.replace('github.com', 'evil.example'),
    `${base}/src/a.ts#L12`.replace('https:', 'http:'),
    `${base}/src/a.ts#L12`.replace('github.com', 'user:password@github.com'),
    `${base}/src/a.ts#L12`.replace('github.com', 'github.com:443'),
    `${base}/src/a.ts?`, `${base}/src/a.ts#bad`,
    `${base}/src/a.ts#L12` + 'a'.repeat(2048),
    `${base}/src/a.ts#L12\n`, `${base}/src/a[1].ts#L12`,
    `${base}/src/a.ts#L12`.replace('github.com', 'github.enterprise.example'),
  ]) {
    insight.githubUrl = url;
    const summary = renderSummary(ctx);
    assert.ok(!summary.includes(`[Source](${url})`), url);
    assert.ok(summary.includes(`[Source](${sourceUrl('src/insight.ts', 12)})`), url);
  }
  ctx.env.GITHUB_SERVER_URL = 'https://github.enterprise.example';
  insight.githubUrl = `${base}/src/a.ts#L12`;
  assert.ok(!renderSummary(ctx).includes('[Source]('));
});

test('only hotspot-related breaches escalate the single top customer annotation', (t) => {
  const ctx = context(t);
  ctx.result.tests = [];
  ctx.result.diagnostics.performance.insights = [];
  ctx.digest.items = [];
  const top = ctx.result.diagnostics.performance.nativeProfile.top;
  top.push({ function: 'invalid-pack', packUuid: '', selfMs: 2000 },
    { function: 'invalid-number', packUuid: 'customer', selfMs: '5000' },
    { function: 'invalid-infinite', packUuid: 'customer', selfMs: Infinity },
    { function: 'second-customer', packUuid: 'customer', selfMs: 19, location: { repoPath: 'src/second.ts', line: 2 } });
  for (const [id, status, expected] of [
    ['max-mspt-p95', 'breach', 'warning'], ['max-script-hotspot-ms', 'pass', 'warning'],
    ['hotspot-regression', 'not_compared', 'warning'], ['max-script-hotspot-ms', 'breach', 'error'],
    ['hotspot-regression', 'breach', 'error'],
  ]) {
    ctx.thresholds = { checks: [{ id, status }], breached: status === 'breach' };
    const emitted = annotations(ctx).emitted;
    assert.equal(emitted.length, 1, `${id}/${status}`);
    assert.equal(emitted[0].level, expected);
    assert.ok(`${emitted[0].title} ${emitted[0].message}`.includes('hotspot-marker'));
  }
});

test('summary hotspot tile and table select finite customer entries, sort descending and cap at five', (t) => {
  const ctx = context(t);
  ctx.result.diagnostics.performance.nativeProfile.top.push(
    ...[2, 6, 1, 5, 3, 4].map((selfMs) => ({ function: `customer-${selfMs}`, packUuid: 'customer', selfMs,
      location: { repoPath: `src/customer-${selfMs}.ts`, line: selfMs } })),
    { function: 'empty-pack-marker', packUuid: '', selfMs: 200 },
    { function: 'nan-marker', packUuid: 'customer', selfMs: NaN });
  const summary = renderSummary(ctx);
  const tile = summary.split('\n').find((line) => line.startsWith('| Top hotspot |'));
  assert.ok(tile.includes('hotspot-marker'));
  assert.ok(tile.includes('20 ms'));
  assert.ok(summary.includes('Script hotspots'));
  const rows = summary.split('\n').filter((line) => line.startsWith('|') && /hotspot-marker|customer-\d/.test(line) && !line.startsWith('| Top hotspot |'));
  assert.equal(rows.length, 5);
  for (const [index, name] of ['hotspot-marker', 'customer-6', 'customer-5', 'customer-4', 'customer-3'].entries()) assert.ok(rows[index].includes(name));
  assert.ok(!summary.includes('native-marker'));
  assert.ok(!summary.includes('empty-pack-marker'));
  assert.ok(!summary.includes('nan-marker'));
});

test('digest error and warning object locations annotate kind, message and count only', (t) => {
  const ctx = context(t);
  ctx.result.tests = [];
  ctx.result.diagnostics.performance.insights = [];
  ctx.result.diagnostics.performance.nativeProfile.top = [];
  ctx.digest.items.push(
    { severity: 'info', kind: 'ignored-info', message: 'ignore', location: { repoPath: 'safe.ts', line: 1 } },
    { severity: 'notice', kind: 'ignored-notice', message: 'ignore', location: { repoPath: 'safe.ts', line: 1 } },
    { severity: 'error', kind: 'legacy-string', message: 'ignore', location: 'src/legacy.ts:1' });
  const emitted = annotations(ctx).emitted;
  assert.deepEqual(emitted.map(({ level, title, message, file, line }) => ({ level, title, message, file, line })), [
    { level: 'error', title: 'script-error', message: 'digest-error-marker (×3)', file: 'src/digest.ts', line: 18 },
    { level: 'warning', title: 'script-warning', message: 'digest-warning-marker (×2)', file: 'src/warning.ts', line: 19 },
  ]);
});

test('annotation ranking places hotspot at its severity and digest between insights and next rank', (t) => {
  const ctx = context(t);
  const markers = (output) => output.emitted.map((item) => `${item.title} ${item.message}`);
  const expected = ['step-marker', 'insight-error-marker', 'digest-error-marker', 'hotspot-marker', 'insight-warning-marker', 'digest-warning-marker', 'notice-marker'];
  for (const checks of [[], [{ id: 'hotspot-regression', status: 'breach' }]]) {
    ctx.thresholds = { checks };
    const actual = markers(annotations(ctx));
    assert.equal(actual.length, expected.length);
    expected.forEach((marker, index) => assert.ok(actual[index].includes(marker), `${marker} at ${index}`));
  }
});

test('dedupe uses level, resolved path, line, title and message before per-level caps', (t) => {
  const ctx = context(t);
  insightOnly(ctx);
  const insights = [];
  for (const severity of ['error', 'warning', 'info']) {
    for (let index = 0; index < 12; index++) {
      const item = { severity, rule: `${severity}-${index}`, message: `message-${index}`, location: { repoPath: 'src/same.ts', line: index + 1 } };
      insights.push(item, structuredClone(item));
    }
  }
  ctx.result.diagnostics.performance.insights = insights;
  const output = annotations(ctx);
  for (const level of ['error', 'warning', 'notice']) assert.equal(output.emitted.filter((item) => item.level === level).length, 10);
  assert.equal(output.overflow.filter((item) => item.reason === 'annotation limit').length, 6);
  assert.deepEqual(output.emitted.slice(0, 10).map((item) => item.title), Array.from({ length: 10 }, (_, i) => `error-${i}`));
  ctx.result.diagnostics.performance.insights = [
    { severity: 'error', rule: 'same', message: 'same', localFile: '../src/same.ts', line: 1 },
    { severity: 'error', rule: 'same', message: 'same', location: { repoPath: 'src/same.ts', line: 1 } },
    { severity: 'warning', rule: 'same', message: 'same', location: { repoPath: 'src/same.ts', line: 1 } },
    { severity: 'error', rule: 'same', message: 'different', location: { repoPath: 'src/same.ts', line: 1 } },
    { severity: 'error', rule: 'different', message: 'same', location: { repoPath: 'src/same.ts', line: 1 } },
    { severity: 'error', rule: 'same', message: 'same', location: { repoPath: 'src/same.ts', line: 2 } },
    { severity: 'error', rule: 'same', message: 'same', location: { repoPath: 'src/other.ts', line: 1 } },
  ];
  assert.equal(annotations(ctx).emitted.length, 6);
});

test('pinned SDK 0.8.0 fixtures retain legacy source annotations with optional fields absent', (t) => {
  const ctx = context(t);
  ctx.result = load('failing');
  ctx.digest = { items: [{ severity: 'error', kind: 'legacy', message: 'legacy digest', location: 'scripts/main.js:9' }] };
  const output = annotations(ctx);
  assert.equal(output.emitted.length, 1);
  assert.equal(output.emitted[0].file, 'project/tests/warps.e2e.mjs');
  assert.equal(output.emitted[0].line, 42);
  assert.equal(output.emitted[0].message, 'errors hasCount');
  assert.ok(renderSummary(ctx).includes(sourceUrl('project/tests/warps.e2e.mjs', 42)));
  ctx.result = load('passing');
  assert.equal(annotations(ctx).emitted.length, 0);
});

test('hotspot rejects unsafe supplied href and builds its workspace source link instead', (t) => {
  const ctx = context(t);
  ctx.result.tests = [];
  ctx.result.diagnostics.performance.insights = [];
  const hotspot = ctx.result.diagnostics.performance.nativeProfile.top[1];
  for (const githubUrl of [
    `https://github.com/other/repo/blob/${sha}/file.js#L15`,
    `https://github.com/minebud/example/blob/${sha}/src/%2e%2e/file.js#L15`,
    `https://user:password@github.com/minebud/example/blob/${sha}/file.js#L15`,
    `http://github.com/minebud/example/blob/${sha}/file.js#L15`,
    `https://github.com/minebud/example/blob/${sha}/file).js#L15`,
  ]) {
    hotspot.githubUrl = githubUrl;
    const summary = renderSummary(ctx);
    assert.ok(!summary.includes(`[Source](${githubUrl})`));
    assert.ok(summary.includes(`[Source](${sourceUrl('src/hotspot.ts', 15)})`));
  }
});
