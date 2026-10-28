import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAnnotations, HOTSPOT_ANNOTATION_MS } from '../src/annotate.mjs';
import { fetchBaseline } from '../src/baseline.mjs';

// Findings from running the Action on the warps demo against production (2026-10-28).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sdk-0.9.0-localized.json', import.meta.url), 'utf8'));
function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'minebud-noise-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspace: root, workingDirectory: root };
}
const hotspotRows = (result, options) => buildAnnotations(result, options).emitted.filter((item) => item.title === 'Script hotspot');

test('a small top hotspot is not annotated unless a hotspot threshold breaches', (t) => {
  const result = structuredClone(fixture.result);
  assert.ok(result.scriptHotspots.every((row) => row.selfMs < HOTSPOT_ANNOTATION_MS), 'fixture hotspots are small');
  assert.equal(hotspotRows(result, workspace(t)).length, 0);
  const breach = { checks: [{ id: 'max-script-hotspot-ms', status: 'breach' }] };
  assert.equal(hotspotRows(result, { ...workspace(t), thresholds: breach })[0]?.level, 'error');
  for (const row of result.scriptHotspots) row.selfMs += HOTSPOT_ANNOTATION_MS;
  assert.equal(hotspotRows(result, workspace(t))[0]?.level, 'warning');
});

test('baseline warnings name the reason without echoing URLs or keys', async () => {
  const result = { name: 'Warps demo', server: { type: 'endstone', speed: 'standard' } };
  const env = { GITHUB_REPOSITORY: 'minebud/e2e-demo', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main' };
  const inputs = { baseline: 'default-branch', 'api-key': 'mb_live_secret' };
  const run = async (fetch, event = { repository: { default_branch: 'main' } }) => {
    const warnings = [];
    const baseline = await fetchBaseline({ result, inputs, env, event, fetch, warning: (text) => warnings.push(text) });
    return { baseline, warnings };
  };
  const unknown = await run(() => assert.fail('no request without a branch'), {});
  assert.match(unknown.warnings[0], /baseline branch is unknown/);
  assert.match((await run(async () => new Response('{}', { status: 403 }))).warnings[0], /returned HTTP 403/);
  const network = await run(async () => { throw new Error('connect https://minebud.dev/?key=mb_live_secret failed'); });
  assert.match(network.warnings[0], /network error or timeout/);
  assert.doesNotMatch(network.warnings[0], /mb_live|https:/);
  const first = await run(async () => new Response(JSON.stringify({ baseline: null })));
  assert.deepEqual(first, { baseline: null, warnings: [] }, 'No baseline yet is normal, not a warning');
});
