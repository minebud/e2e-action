import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchBaseline, parseBaseline } from '../src/baseline.mjs';
import { apiOrigin, validRef, validRepository } from '../src/github.mjs';
const responses = JSON.parse(await readFile(new URL('fixtures/baselines.json', import.meta.url), 'utf8'));
const params = { result: { name: 'warps-golden', server: { type: 'endstone', speed: 'standard' } }, inputs: { baseline: 'default-branch', 'api-key': 'test_ci_key' }, env: { GITHUB_REPOSITORY: 'minebud/example', MINEBUD_API_URL: 'http://127.0.0.1:8787' }, event: { repository: { default_branch: 'main' } } };

test('baseline request validates components and authenticates only the origin without redirects', async () => {
  let requested;
  const baseline = await fetchBaseline({ ...params, fetch: async (url, options) => {
    requested = new URL(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test_ci_key');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(responses.normal);
  } });
  assert.equal(baseline.msptP95, 5);
  assert.equal(requested.origin, params.env.MINEBUD_API_URL);
  assert.equal(requested.pathname, '/api/v1/e2e/ci/baseline');
  assert.deepEqual(Object.fromEntries(requested.searchParams), { repository: 'minebud/example', ref: 'main', suite: 'warps-golden', serverType: 'endstone', speed: 'standard' });
  let branch;
  await fetchBaseline({ ...params, inputs: { ...params.inputs, baseline: 'feature/performance' }, fetch: async (url) => { branch = new URL(url).searchParams.get('ref'); return Response.json({ baseline: null }); } });
  assert.equal(branch, 'feature/performance');
});
test('HTTP failures, timeout, malformed shapes, and oversized responses warn without failing comparisons', async () => {
  for (const fetch of [async () => new Response('', { status: 404 }), async () => { throw new DOMException('timeout', 'TimeoutError'); }, async () => Response.json({}), async () => Response.json({ baseline: { ...responses.normal.baseline, msptP95: '5' } }), async () => new Response('x'.repeat(65537))]) {
    const warnings = [];
    assert.equal(await fetchBaseline({ ...params, fetch, warning: (message) => warnings.push(message) }), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not compared/);
    assert.ok(!warnings[0].includes('test_ci_key'));
  }
  let called = false;
  assert.equal(await fetchBaseline({ ...params, env: { ...params.env, MINEBUD_API_URL: 'https://u:p@example.com' }, fetch: async () => { called = true; } }), null);
  assert.equal(called, false);
});
test('baseline shape ignores additive fields and normalizes optional identities and metrics', () => {
  assert.equal(parseBaseline(responses.missing), null);
  assert.equal(parseBaseline(responses.mismatchedSpeed).speed, 'fast');
  const nullable = { baseline: { ...responses.normal.baseline, runId: null, sha: null, msptP95: null, scriptHotMs: null, scriptHotFn: null, tpsMean: null } };
  assert.deepEqual(parseBaseline(nullable), nullable.baseline);
  assert.deepEqual(parseBaseline({ baseline: { finishedAt: responses.normal.baseline.finishedAt } }), {
    runId: null, sha: null, finishedAt: responses.normal.baseline.finishedAt,
    msptP95: null, scriptHotMs: null, scriptHotFn: null, tpsMean: null,
  });
  assert.deepEqual(parseBaseline({ baseline: { ...responses.normal.baseline, extra: true }, extra: { future: true } }), responses.normal.baseline);
});
test('baseline shape rejects invalid known types and requires a valid timestamp', () => {
  for (const payload of [null, [], {}, { baseline: [] }, { baseline: false }]) assert.throws(() => parseBaseline(payload), /Malformed/);
  for (const [key, values] of Object.entries({
    runId: ['', 123, false, {}, 'bad/id'],
    sha: ['', 'BAD', 123, false, {}],
    finishedAt: [undefined, null, 'yesterday', -1, 1.5, Infinity, false, {}],
    msptP95: ['5', -1, NaN, Infinity, false, {}],
    scriptHotMs: ['5', -1, NaN, Infinity, false, {}],
    tpsMean: ['20', -1, NaN, Infinity, false, {}],
    scriptHotFn: [123, false, {}, 'x'.repeat(1001)],
    serverType: [null, false, 123, '', 'bad/type'],
    speed: [null, false, 123, '', 'bad/speed'],
  })) {
    for (const value of values) assert.throws(() => parseBaseline({ baseline: { ...responses.normal.baseline, [key]: value } }), /Malformed/, `${key}: ${String(value)}`);
  }
});
test('default branch resolution prefers valid event payloads for every event type', async () => {
  for (const name of ['schedule', 'workflow_dispatch', 'push', 'pull_request']) {
    let requested;
    const warnings = [];
    await fetchBaseline({ ...params, env: { ...params.env, GITHUB_EVENT_NAME: name, GITHUB_REF_NAME: 'other' },
      fetch: async (url) => { requested = new URL(url).searchParams.get('ref'); return Response.json({ baseline: null }); },
      warning: (message) => warnings.push(message) });
    assert.equal(requested, 'main', name);
    assert.deepEqual(warnings, []);
  }
});
test('schedule alone can fall back to a valid ref name when the payload branch is absent or invalid', async () => {
  for (const event of [undefined, null, {}, { repository: {} }, { repository: { default_branch: '../invalid' } }]) {
    let requested;
    const warnings = [];
    await fetchBaseline({ ...params, event, env: { ...params.env, GITHUB_EVENT_NAME: 'schedule', GITHUB_REF_NAME: 'scheduled-main' },
      fetch: async (url) => { requested = new URL(url).searchParams.get('ref'); return Response.json({ baseline: null }); },
      warning: (message) => warnings.push(message) });
    assert.equal(requested, 'scheduled-main');
    assert.deepEqual(warnings, []);
  }
});
test('missing or invalid default branches warn without fetching or borrowing non-schedule refs', async () => {
  for (const name of ['schedule', 'workflow_dispatch', 'push', 'pull_request', undefined]) {
    for (const event of [undefined, null, {}, { repository: {} }, { repository: { default_branch: '../invalid' } }]) {
      for (const ref of name === 'schedule' ? [undefined, '', '../invalid'] : ['feature/not-default', undefined]) {
        let called = false;
        const warnings = [];
        assert.equal(await fetchBaseline({ ...params, event,
          env: { ...params.env, GITHUB_EVENT_NAME: name, GITHUB_REF_NAME: ref },
          fetch: async () => { called = true; return Response.json({ baseline: null }); },
          warning: (message) => warnings.push(message) }), null);
        assert.equal(called, false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /not compared/);
      }
    }
  }
});
test('origin, repository, and ref validation match SDK and CI boundaries', () => {
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:80', 'http://[::1]:8787', 'https://example.com/']) assert.equal(apiOrigin(origin), new URL(origin).origin);
  for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?key=a', 'https://example.com/#fragment', 'file:///tmp']) assert.throws(() => apiOrigin(origin));
  assert.equal(validRepository('minebud/e2e-action'), true);
  for (const repo of ['owner/..', 'owner/.', '../repo', 'a.b/repo', 'owner/repo/extra']) assert.equal(validRepository(repo), false);
  for (const ref of ['main', 'feature/perf', 'a'.repeat(255)]) assert.equal(validRef(ref), true);
  for (const ref of ['', '-main', '../main', 'main\n', 'é'.repeat(128)]) assert.equal(validRef(ref), false);
});
