import { containedPath, locationSource } from './annotate.mjs';
import { metric, topHotspot } from './thresholds.mjs';

const MAX_BYTES = 1_000_000;
const TRUNCATED = '\nSummary truncated: additional details were omitted or shortened to fit reporting limits.\n';
const EXPIRY = '\nRun details (report, profiles, artifacts) expire 24 h after the run, and the dashboard link stops working then.\n';
const array = (value) => Array.isArray(value) ? value : [];
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const failed = (value) => value === 'failed' || value === 'error';

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return '[unserializable value]'; }
}

function json(value) {
  try { return JSON.stringify(value) ?? '[unserializable value]'; } catch { return '[unserializable value]'; }
}

function githubRepository(env) {
  if (env.GITHUB_SERVER_URL != null && env.GITHUB_SERVER_URL !== 'https://github.com') return null;
  const repo = env.GITHUB_REPOSITORY;
  return typeof repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)
    && !repo.split('/').some((part) => part === '.' || part === '..') ? repo : null;
}

function githubUrl(value, ctx) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f<>"'()`\[\]{}|\\]/u.test(value)) return null;
  const repo = githubRepository(ctx.env ?? {});
  if (!repo) return null;
  try {
    const url = new URL(value);
    // Check the raw authority as well: URL normalizes explicit :443 away.
    const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)/i.exec(value);
    if (!raw || raw[1].toLowerCase() !== 'github.com' || value.includes('?')
      || url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.port || url.search
      || (url.hash && !/^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(url.hash))) return null;
    // URL removes dot segments, including percent-encoded ones, during parsing.
    // Validate before that normalization so traversal is never accepted.
    const parts = raw[2].split('/').slice(1).map((part) => decodeURIComponent(part));
    if (parts.length < 5 || parts.some((part) => !part || part.split('/').some((segment) => segment === '.' || segment === '..'))
      || parts[2] !== 'blob' || `${parts[0]}/${parts[1]}`.toLowerCase() !== repo.toLowerCase()) return null;
    return url.href;
  } catch { return null; }
}

function sourceLink(source, ctx) {
  const env = ctx.env ?? {};
  const repo = githubRepository(env);
  if (!repo) return null;
  const sha = ctx.event?.pull_request?.head?.sha ?? env.GITHUB_SHA;
  if (typeof sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return null;
  if (!integer(source?.line)) return null;
  const file = containedPath(source.file, { ...ctx, repositoryRelative: source.repositoryRelative });
  if (file === null) return null;
  // encodeURIComponent deliberately leaves punctuation such as parentheses and
  // apostrophes unescaped; encode it too so paths cannot close a Markdown link.
  const encode = (part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  try {
    return `https://github.com/${repo}/blob/${sha}/${file.split('/').map(encode).join('/')}#L${source.line}`;
  } catch { return null; }
}

export function renderSummary(ctx = {}) {
  let truncated = false;
  const escape = (value, limit = 4000) => {
    let string = text(value);
    if (string.length > limit) {
      let end = limit - 1;
      if (/[\uD800-\uDBFF]/u.test(string[end - 1] ?? '')) end--;
      string = `${string.slice(0, end)}…`;
      truncated = true;
    }
    return string.replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]+/gu, ' ')
      .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
      .replace(/\\/g, '\\\\')
      .replace(/&#39;|[`*_\[\]()#|~!{}]/g, (part) => part === '&#39;' ? part : `\\${part}`);
  };
  const number = (value, suffix = '') => finite(value) ? `${escape(value)}${suffix}` : 'unavailable';
  const location = (item, legacy) => {
    const source = locationSource(item?.location, legacy);
    const link = githubUrl(item?.githubUrl, ctx) ?? sourceLink(source, ctx);
    if (link) return `[Source](${link})`;
    return source?.file == null ? '' : `${escape(source.file, 500)}${integer(source.line) ? `:${source.line}` : ''}`;
  };
  const result = ctx.result;
  const status = ctx.skipped ? 'skipped' : !result ? 'error'
    : ['passed', 'failed', 'error', 'cancelled', 'timeout', 'rejected', 'skipped'].includes(result.status) ? result.status : 'unknown';
  const sections = [];
  let used = 0;
  const available = MAX_BYTES - Buffer.byteLength(TRUNCATED + EXPIRY);
  // Sections are added in descending priority. Whole lines are retained so a
  // byte limit can never split an entity, Unicode character, table, or link.
  const add = (heading, lines) => {
    const output = [];
    const prefix = heading ? `\n### ${heading}\n\n` : '';
    let bytes = Buffer.byteLength(prefix);
    for (const line of lines) {
      const entry = `${line}\n`;
      const length = Buffer.byteLength(entry);
      if (used + bytes + length > available) { truncated = true; break; }
      output.push(entry);
      bytes += length;
    }
    if (output.length) { sections.push(prefix + output.join('')); used += bytes; }
  };
  const header = [`## Minebud E2E`, '', `Status: ${status}`];
  if (result?.runId != null) {
    const runId = result.runId;
    header.push(`Run: ${escape(runId, 200)}${typeof runId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(runId)
      ? ` — [Dashboard](https://minebud.dev/dashboard/runs/run?id=${runId})` : ''}`);
  }
  if (ctx.note) header.push(escape(ctx.note));
  const error = ctx.error ?? result?.error;
  if (error) header.push(`CLI error: ${escape(error.code, 200)} — ${escape(error.message ?? error)}`);
  if (!result && !ctx.skipped) header.push(`SDK exit code: ${escape(ctx.sdkExitCode ?? 'unavailable', 80)}`);
  add('', header);
  if (!result || ctx.skipped) return sections.join('') + (truncated ? TRUNCATED : '') + EXPIRY;

  const tests = array(result.tests);
  const summary = result.summary ?? {};
  const passed = finite(summary.passed) ? summary.passed : tests.filter((test) => test?.status === 'passed').length;
  const failureCount = finite(summary.failed) ? summary.failed : tests.filter((test) => failed(test?.status)).length;
  const mspt = metric(result, 'mspt.p95');
  const checks = array(ctx.thresholds?.checks);
  const comparison = checks.find((check) => check?.id === 'mspt-regression' && check.status !== 'not_compared');
  let delta = ' (not compared)';
  if (comparison && finite(comparison.baseline) && finite(mspt)) {
    const difference = mspt - comparison.baseline;
    const sign = difference >= 0 ? '+' : '';
    const percent = comparison.baseline > 0 ? `${sign}${Number((difference / comparison.baseline * 100).toFixed(2))}%` : 'percentage unavailable';
    delta = ` (${sign}${Number(difference.toFixed(2))} ms / ${percent} vs baseline)`;
  }
  const hotspot = topHotspot(result);
  const hotspotLocation = hotspot ? location(hotspot, { file: hotspot.localFile, line: hotspot.line })
    || (hotspot.file == null ? '' : `${escape(hotspot.file, 500)}${integer(hotspot.line) ? `:${hotspot.line}` : ''}`) : '';
  add('Metrics', [
    '| Metric | Value |', '| --- | --- |',
    `| Tests passed / failed | ${number(passed)} / ${number(failureCount)} |`,
    `| TPS mean | ${number(metric(result, 'tps.mean') ?? (finite(result.avgTps) ? result.avgTps : null))} |`,
    `| MSPT p95 | ${number(mspt, ' ms')}${delta} |`,
    `| Memory peak (RSS) | ${number(metric(result, 'memory.rssMaxMb'), ' MB')} |`,
    `| Script errors | ${number(metric(result, 'scriptErrors.count'))} |`,
    `| Top hotspot | ${hotspot ? `${escape(hotspot.function ?? hotspot.name ?? hotspot.fn ?? 'unknown', 300)} — ${number(hotspot.selfMs, ' ms')}${hotspotLocation ? ` — ${hotspotLocation}` : ''}` : 'unavailable'} |`,
  ]);

  function* thresholdLines() {
    if (!checks.length) { yield 'No thresholds configured.'; return; }
    yield '| Check | Current | Limit | Baseline | Result |';
    yield '| --- | --- | --- | --- | --- |';
    for (const check of checks) {
      if (!check) continue;
      const verdict = check.status === 'breach' ? 'breach' : check.status === 'pass' ? 'pass' : 'not compared';
      yield `| ${escape(check.label ?? check.id, 300)} | ${escape(check.value ?? 'unavailable', 300)} | ${escape(check.limit ?? 'unavailable', 300)} | ${escape(check.baseline ?? 'not compared', 300)} | ${verdict}${check.reason ? `: ${escape(check.reason, 600)}` : ''} |`;
    }
  }

  function* failureLines() {
    const failures = tests.filter((test) => failed(test?.status) || array(test?.steps).some((step) => failed(step?.status)));
    if (!failures.length) { yield 'No failing tests.'; return; }
    for (const test of failures.slice(0, 50)) {
      yield `#### ${escape(test.name ?? test.id, 200)} (${escape(test.id, 200)})`;
      if (test.error != null) yield `Error: ${escape(test.error?.message ?? test.error)}`;
      if (test.error?.expected !== undefined) yield `Expected: ${escape(json(test.error.expected), 2000)}`;
      if (test.error?.actual !== undefined) yield `Actual: ${escape(json(test.error.actual), 2000)}`;
      const steps = array(test.steps).filter((step) => failed(step?.status));
      for (const step of steps.slice(0, 20)) {
        yield `- Step ${escape(step.id ?? step.op, 200)}: ${escape(step.error?.message ?? step.error ?? 'Step failed')}`;
        const source = location(step, step.source);
        if (source) yield `  - Source: ${source}`;
        const expected = step.error?.expected !== undefined ? step.error.expected : step.expected;
        const actual = step.error?.actual !== undefined ? step.error.actual : step.actual;
        if (expected !== undefined) yield `  - Expected: ${escape(json(expected), 2000)}`;
        if (actual !== undefined) yield `  - Actual: ${escape(json(actual), 2000)}`;
      }
      if (steps.length > 20) { truncated = true; yield `- and ${steps.length - 20} more failing steps`; }
    }
    if (failures.length > 50) { truncated = true; yield `and ${failures.length - 50} more failing tests`; }
  }
  add('Failing tests and steps', failureLines());

  function* insightLines() {
    const insights = array(result.diagnostics?.performance?.insights);
    let shown = 0, total = 0;
    for (const severity of ['error', 'warning', 'info']) {
      for (const insight of insights) {
        if (insight?.severity !== severity) continue;
        total++;
        if (shown >= 10) continue;
        shown++;
        yield `- ${severity}: ${escape(insight.rule, 200)} — ${escape(insight.message, 2000)} Fix: ${escape(insight.fix, 2000)}`;
        const source = location(insight, { file: insight.localFile, line: insight.line });
        if (source) yield `  - ${source}`;
      }
    }
    if (!total) yield 'No insights available.';
    if (total > shown) { truncated = true; yield `and ${total - shown} more insights`; }
  }
  add('Top insights', insightLines());

  function* hotspotLines() {
    const rows = array(result.diagnostics?.performance?.nativeProfile?.top)
      .filter((row) => typeof row?.packUuid === 'string' && row.packUuid.trim() && finite(row.selfMs))
      .sort((a, b) => b.selfMs - a.selfMs).slice(0, 5);
    if (!rows.length) return;
    yield '| Function | Self ms | Location |';
    yield '| --- | --- | --- |';
    for (const row of rows) {
      const source = location(row, { file: row.localFile, line: row.line })
        || (row.file == null ? '' : `${escape(row.file, 500)}${integer(row.line) ? `:${row.line}` : ''}`);
      yield `| ${escape(row.function ?? row.name ?? row.fn ?? 'unknown', 300)} | ${number(row.selfMs)} | ${source} |`;
    }
  }
  add('Script hotspots', hotspotLines());

  function* digestLines() {
    for (const item of array(ctx.digest?.items)) {
      if (!item?.location || typeof item.location !== 'object' || Array.isArray(item.location)) continue;
      const source = location(item);
      yield `- ${escape(item.severity, 30)}: ${escape(item.kind, 200)} — ${escape(item.message)}${item.count > 1 ? ` (×${escape(item.count, 100)})` : ''}${source ? ` — ${source}` : ''}`;
    }
  }
  add('Diagnostic findings', digestLines());
  add('Thresholds and regressions', thresholdLines());

  function* billingLines() {
    const billing = result.billing;
    if (!billing || !finite(billing.chargedCredits)) return;
    yield `Charged credits: ${escape(billing.chargedCredits, 200)} weighted tick credits`;
    if (billing.ticks != null) yield `Ticks: ${escape(billing.ticks, 200)}`;
    if (billing.speed != null || result.server?.speed != null) yield `Speed: ${escape(billing.speed ?? result.server.speed, 200)}`;
  }
  add('Billing', billingLines());

  function* annotationLines() {
    const overflow = array(ctx.annotations?.overflow);
    if (!overflow.length) return;
    yield `${overflow.length} annotations were not emitted (invalid source or annotation limit).`;
    for (const entry of overflow) {
      yield `- ${escape(entry.level, 30)}: ${escape(entry.title, 200)} — ${escape(entry.message)} (${escape(entry.reason, 100)})${entry.file != null ? ` — ${escape(entry.file, 500)}${integer(entry.line) ? `:${entry.line}` : ''}` : ''}`;
    }
  }
  add('Annotation overflow', annotationLines());
  return sections.join('') + (truncated ? TRUNCATED : '') + EXPIRY;
}
