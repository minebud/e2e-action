import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metric, topHotspot, evaluateThresholds } from '../src/thresholds.mjs';
const fixture = async (name) => JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
const options = { baseline: 'main', 'max-mspt-p95': null, 'max-script-hotspot-ms': null, 'max-script-errors': null, 'fail-on-insight-severity': 'none', 'max-regression-pct': 20, 'min-regression-ms': 2 };

test('flat dotted metrics take precedence; numeric nested metrics are supported', () => {
  assert.equal(metric({ metrics: { 'mspt.p95': 7, mspt: { p95: 99 } } }, 'mspt.p95'), 7);
  assert.equal(metric({ metrics: { mspt: { p95: 8 } } }, 'mspt.p95'), 8);
  for (const value of [null, '7', -1, NaN, Infinity]) assert.equal(metric({ metrics: { 'mspt.p95': value } }, 'mspt.p95'), null);
});
test('absolute checks breach strictly above limits, exclude engine hotspots', async () => {
  const result = await fixture('insights');
  assert.equal(topHotspot(result).selfMs, 15);
  const inputs = { ...options, baseline: 'none', 'max-mspt-p95': 7.4, 'max-script-hotspot-ms': 14, 'max-script-errors': 1 };
  const evaluated = evaluateThresholds(result, inputs);
  assert.deepEqual(evaluated.checks.map((c) => c.status), ['pass', 'breach', 'breach']);
  assert.equal(evaluated.regressions.length, 2);
  assert.equal(evaluated.breached, true);
});
test('missing customer profiler and absent metrics are not compared, never passing', () => {
  const evaluated = evaluateThresholds({}, { ...options, 'max-mspt-p95': 10, 'max-script-hotspot-ms': 10, 'max-script-errors': 0 });
  assert.equal(evaluated.breached, false);
  assert.ok(evaluated.checks.every((c) => c.status === 'not_compared'));
  assert.match(evaluated.checks[1].reason, /server\.scriptProfiler/);
});
test('insight severity is ordered and missing insights count zero', () => {
  const result = { diagnostics: { performance: { insights: [{ severity: 'info' }, { severity: 'warning' }] } } };
  assert.equal(evaluateThresholds(result, { ...options, baseline: 'none', 'fail-on-insight-severity': 'error' }).breached, false);
  assert.equal(evaluateThresholds(result, { ...options, baseline: 'none', 'fail-on-insight-severity': 'warning' }).breached, true);
  assert.deepEqual(evaluateThresholds(result, { ...options, baseline: 'none' }).checks, []);
  assert.equal(evaluateThresholds({}, { ...options, baseline: 'none', 'fail-on-insight-severity': 'error' }).checks[0].value, 0);
});
test('regression requires BOTH percentage and absolute noise floor, strict boundaries', () => {
  for (const [current, base, pct, noise, expected] of [[12, 10, 20, 1, 'pass'], [13, 10, 20, 3, 'pass'], [12.1, 10, 20, 2, 'breach'], [1.5, 1, 20, 2, 'pass'], [11, 10, 20, 0, 'pass'], [1, 0, 20, 0, 'breach']]) {
    const result = { metrics: { 'mspt.p95': current } };
    const checks = evaluateThresholds(result, { ...options, 'max-regression-pct': pct, 'min-regression-ms': noise }, { msptP95: base }).checks;
    assert.equal(checks[0].status, expected, `${current}/${base}`);
    assert.equal(checks[1].status, 'not_compared');
  }
});
test('baseline fixtures compare regressions, noise floor, and matching server dimensions', async () => {
  const result = await fixture('regression');
  const baselines = await fixture('baselines');
  assert.equal(evaluateThresholds(result, options, baselines.normal.baseline).regressions.length, 2);
  assert.ok(evaluateThresholds(result, options, baselines.mismatchedSpeed.baseline).checks.every((c) => c.status === 'not_compared'));
  result.metrics['mspt.p95'] = 7.4;
  assert.equal(evaluateThresholds(result, options, baselines.belowNoiseFloor.baseline).checks[0].status, 'pass');
  for (const baseline of [null, undefined, {}]) assert.ok(evaluateThresholds(result, options, baseline).checks.every((c) => c.status === 'not_compared'));
  assert.ok(evaluateThresholds(result, options, { ...baselines.normal.baseline, serverType: 'bedrock' }).checks.every((c) => c.status === 'not_compared'));
});
