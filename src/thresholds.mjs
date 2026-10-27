// Result metrics are flat dotted keys; older/custom result producers may nest them.
export function metric(result, key) {
  const metrics = result?.metrics;
  const value = metrics && Object.hasOwn(metrics, key)
    ? metrics[key]
    : key.split('.').reduce((v, part) => v?.[part], metrics);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function topHotspot(result) {
  const rows = result?.diagnostics?.performance?.nativeProfile?.top;
  let top = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.packUuid !== 'string' || !row.packUuid.trim()) continue;
    if (typeof row.selfMs !== 'number' || !Number.isFinite(row.selfMs) || row.selfMs < 0) continue;
    if (!top || row.selfMs > top.selfMs) top = row;
  }
  return top;
}

export function evaluateThresholds(result, inputs, baseline) {
  const checks = [];
  const mspt = metric(result, 'mspt.p95');
  const hotspot = topHotspot(result)?.selfMs ?? null;
  function absolute(id, label, value, reason) {
    const limit = inputs[id];
    if (limit === null || limit === undefined) return;
    checks.push({ id, label, value, limit, status: value === null ? 'not_compared' : value > limit ? 'breach' : 'pass', ...(value === null ? { reason } : {}) });
  }
  absolute('max-mspt-p95', 'MSPT p95 (ms)', mspt, 'MSPT p95 is missing.');
  absolute('max-script-hotspot-ms', 'Script hotspot (ms)', hotspot, 'Customer script profile is missing; enable server.scriptProfiler.');
  absolute('max-script-errors', 'Script errors', metric(result, 'scriptErrors.count'), 'Script error count is missing.');
  const severity = inputs['fail-on-insight-severity'];
  if (severity && severity !== 'none') {
    const order = { info: 0, warning: 1, error: 2 };
    const insights = result?.diagnostics?.performance?.insights;
    const count = (Array.isArray(insights) ? insights : []).filter((i) => order[i?.severity] >= order[severity]).length;
    checks.push({ id: 'fail-on-insight-severity', label: `Insights at least ${severity}`, value: count, limit: 0, status: count > 0 ? 'breach' : 'pass' });
  }
  if (inputs.baseline && inputs.baseline !== 'none') {
    const mismatch = baseline && ((baseline.serverType !== undefined && baseline.serverType !== result?.server?.type)
      || (baseline.speed !== undefined && baseline.speed !== result?.server?.speed));
    for (const [id, label, current, key] of [
      ['mspt-regression', 'MSPT p95 regression (ms)', mspt, 'msptP95'],
      ['hotspot-regression', 'Script hotspot regression (ms)', hotspot, 'scriptHotMs'],
    ]) {
      const base = baseline?.[key];
      const validBase = typeof base === 'number' && Number.isFinite(base) && base >= 0;
      let reason;
      if (mismatch) reason = 'Baseline server type or speed does not match this run.';
      else if (!baseline) reason = 'Baseline is missing or could not be fetched.';
      else if (!validBase) reason = 'Baseline metric is missing.';
      else if (current === null) reason = key === 'scriptHotMs' ? 'Customer script profile is missing; enable server.scriptProfiler.' : 'Current MSPT p95 is missing.';
      const limit = validBase ? base * (1 + inputs['max-regression-pct'] / 100) : null;
      const breach = !reason && current > limit && current - base > inputs['min-regression-ms'];
      checks.push({ id, label, value: current, limit, baseline: validBase ? base : null, status: reason ? 'not_compared' : breach ? 'breach' : 'pass', ...(reason ? { reason } : {}) });
    }
  }
  const regressions = checks.filter((check) => check.status === 'breach');
  return { checks, breached: regressions.length > 0, regressions };
}
