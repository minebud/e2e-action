import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAnnotations } from '../src/annotate.mjs';
import { renderSummary } from '../src/summary.mjs';
import { evaluateThresholds, topHotspot } from '../src/thresholds.mjs';

// Output of the real SDK 0.9.0 localizeResult/digest over its source-map fixture (see generatedBy):
// host severities high/medium/low, insights and scriptHotspots at the top level, digest codeLocation.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sdk-0.9.0-localized.json', import.meta.url), 'utf8'));
const env = { GITHUB_REPOSITORY: 'octo/shop-pack', GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' };

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'minebud-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspace: root, workingDirectory: root };
}

test('SDK 0.9.0 insights, hotspot and digest annotate their TypeScript sources at host severities', (t) => {
  const { emitted } = buildAnnotations(fixture.result, { ...workspace(t), digest: fixture.digest });
  const rows = emitted.map((item) => [item.level, item.title, `${item.file}:${item.line}`]);
  const high = fixture.result.insights.filter((insight) => insight.severity === 'high');
  assert.ok(high.length > 0);
  for (const insight of high) assert.ok(rows.some(([level, title, at]) => level === 'error' && title === insight.rule && at === `${insight.location.sourcePath}:${insight.location.sourceLine}`));
  assert.ok(rows.some(([level, title, at]) => level === 'error' && title === 'script_error' && at === 'src/shop.ts:12'));
  const hotspot = topHotspot(fixture.result);
  assert.equal(hotspot.selfMs, Math.max(...fixture.result.scriptHotspots.filter((row) => row.packUuid).map((row) => row.selfMs)));
  assert.ok(rows.some(([level, title, at]) => level === 'warning' && title === 'Script hotspot' && at === `${hotspot.location.sourcePath}:${hotspot.location.sourceLine}`));
  for (const [severity, level] of [['medium', 'warning'], ['low', 'notice']]) {
    assert.ok(fixture.result.insights.some((insight) => insight.severity === severity));
    assert.ok(rows.some(([seen]) => seen === level), `${severity} insight annotated as ${level}`);
  }
});

test('SDK 0.9.0 insights drive fail-on-insight-severity', () => {
  const count = (level) => evaluateThresholds(fixture.result, { baseline: 'none', 'fail-on-insight-severity': level }).checks[0].value;
  const at = (levels) => fixture.result.insights.filter((insight) => levels.includes(insight.severity)).length;
  assert.equal(count('high'), at(['high']));
  assert.equal(count('medium'), at(['high', 'medium']));
  assert.equal(count('low'), fixture.result.insights.length);
  assert.ok(count('high') > 0);
});

test('summary links SDK 0.9.0 locations to GitHub at the run commit', () => {
  const summary = renderSummary({ result: fixture.result, digest: fixture.digest, env, event: {}, sdkExitCode: 1,
    thresholds: { checks: [], breached: false, regressions: [] }, annotations: { lines: [], emitted: [], overflow: [] } });
  assert.match(summary, /- high: /);
  assert.ok(summary.includes('https://github.com/octo/shop-pack/blob/0123456789abcdef0123456789abcdef01234567/src/shop.ts#L12'));
  assert.ok(summary.includes(`| ${fixture.result.scriptHotspots[0].function} |`));
});
