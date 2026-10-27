import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { topHotspot } from './thresholds.mjs';

const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const array = (value) => Array.isArray(value) ? value : [];
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function bounded(value, limit) {
  const string = text(value);
  if (string.length <= limit) return string;
  let end = limit - 1;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(string[end - 1])) end--;
  return `${string.slice(0, end)}…`;
}

export function escapeData(value) {
  return text(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function escapeProperty(value) {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Check both lexical containment and every existing ancestor. Missing leaf
// files are useful call sites, but must not conceal an escaping directory symlink.
export function containedPath(file, { workspace, workingDirectory, allowRoot = false, repositoryRelative = false } = {}) {
  if (typeof file !== 'string' || !file || controls.test(file)) return null;
  if (repositoryRelative && (path.isAbsolute(file) || path.win32.isAbsolute(file))) return null;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || controls.test(workspace)) return null;
  const root = path.resolve(workspace);
  const cwd = repositoryRelative ? root : workingDirectory ?? root;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || controls.test(cwd)) return null;
  const absolute = path.resolve(cwd, file);
  if (!inside(root, absolute) || (absolute === root && !allowRoot)) return null;
  try {
    const realRoot = realpathSync(root);
    let ancestor = absolute;
    for (;;) {
      let exists = false;
      try { lstatSync(ancestor); exists = true; } catch (error) {
        if (error.code !== 'ENOENT') return null;
      }
      // realpath failures on an existing entry (including dangling symlinks)
      // fail closed. Check every ancestor, even if a later link returns inside.
      if (exists && !inside(realRoot, realpathSync(ancestor))) return null;
      if (ancestor === root) break;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  } catch { return null; }
  return path.relative(root, absolute).split(path.sep).join('/');
}

// Select whole pairs before containment checks; an escaping preferred location
// stays summary-only rather than silently annotating a different file.
export function locationSource(location, legacy) {
  if (location && typeof location === 'object' && !Array.isArray(location)) {
    for (const [file, line] of [[location.sourcePath, location.sourceLine], [location.repoPath, location.line]]) {
      if (typeof file === 'string' && file && positiveInteger(line)) return { file, line, repositoryRelative: true };
    }
  }
  return legacy;
}

function candidate(level, title, message, source) {
  return { level, title: bounded(title, 200), message: bounded(message, 4000),
    file: source?.file, line: source?.line, column: source?.column, repositoryRelative: source?.repositoryRelative };
}

export function buildAnnotations(result, options = {}) {
  const candidates = [];
  for (const test of array(result?.tests)) {
    for (const step of array(test?.steps)) {
      if (step?.status !== 'failed' && step?.status !== 'error') continue;
      const message = step.error?.message ?? step.error ?? 'Step failed';
      candidates.push(candidate('error', `${text(test.name ?? test.id)}/${text(step.id ?? step.op)}`, message,
        locationSource(step.location, step.source)));
    }
  }
  const insights = array(result?.diagnostics?.performance?.insights);
  const digest = array(options.digest?.items).filter((item) => item?.location && typeof item.location === 'object' && !Array.isArray(item.location));
  const addInsights = (severity, level) => {
    for (const insight of insights) {
      if (insight?.severity !== severity) continue;
      candidates.push(candidate(level, insight.rule ?? '', `${text(insight.message)} Fix: ${text(insight.fix)}`,
        locationSource(insight.location, { file: insight.localFile, line: insight.line, column: insight.column })));
    }
  };
  const addDigest = (level) => {
    for (const item of digest) {
      if (item.severity !== level) continue;
      candidates.push(candidate(level, item.kind, `${text(item.message)}${item.count > 1 ? ` (×${text(item.count)})` : ''}`,
        locationSource(item.location)));
    }
  };
  addInsights('error', 'error');
  addDigest('error');
  const hotspot = topHotspot(result);
  const source = locationSource(hotspot?.location, { file: hotspot?.localFile, line: hotspot?.line });
  if (source?.file && positiveInteger(source.line)) {
    const escalated = array(options.thresholds?.checks).some((check) =>
      ['max-script-hotspot-ms', 'hotspot-regression'].includes(check?.id) && check.status === 'breach');
    candidates.push(candidate(escalated ? 'error' : 'warning', 'Script hotspot',
      `${text(hotspot.function ?? hotspot.name ?? hotspot.fn ?? 'unknown')} self time ${hotspot.selfMs} ms`, source));
  }
  addInsights('warning', 'warning');
  addDigest('warning');
  addInsights('info', 'notice');
  const lines = [], emitted = [], overflow = [];
  const counts = { error: 0, warning: 0, notice: 0 };
  const seen = new Set();
  for (const item of candidates) {
    const file = containedPath(item.file, { ...options, repositoryRelative: item.repositoryRelative });
    const key = JSON.stringify([item.level, file ?? item.file, item.line, item.title, item.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = file === null ? 'invalid path' : !positiveInteger(item.line) ? 'invalid line'
      : item.column != null && !positiveInteger(item.column) ? 'invalid column'
        : counts[item.level] >= 10 ? 'annotation limit' : null;
    const entry = { ...item, ...(file === null ? {} : { file }) };
    if (reason) { overflow.push({ ...entry, reason }); continue; }
    counts[item.level]++;
    emitted.push(entry);
    const column = item.column == null ? '' : `,col=${item.column}`;
    lines.push(`::${item.level} file=${escapeProperty(file)},line=${item.line}${column},title=${escapeProperty(item.title)}::${escapeData(item.message)}`);
  }
  return { lines, emitted, overflow };
}
