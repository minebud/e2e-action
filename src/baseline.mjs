import { apiOrigin, validRef, validRepository } from './github.mjs';

const BASELINE_KEYS = ['runId', 'sha', 'finishedAt', 'msptP95', 'scriptHotMs', 'scriptHotFn', 'tpsMean'];
export function parseBaseline(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'baseline')) throw new Error('Malformed baseline response.');
  const baseline = payload.baseline;
  if (baseline === null) return null;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('Malformed baseline fields.');
  if ((baseline.runId != null && (typeof baseline.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(baseline.runId)))
    || (baseline.sha != null && (typeof baseline.sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.sha)))) throw new Error('Malformed baseline identity.');
  const finished = baseline.finishedAt;
  if (!(typeof finished === 'number' && Number.isSafeInteger(finished) && finished >= 0)
    && !(typeof finished === 'string' && finished.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(finished) && Number.isFinite(Date.parse(finished)))) throw new Error('Malformed baseline timestamp.');
  for (const key of ['msptP95', 'scriptHotMs', 'tpsMean']) {
    if (baseline[key] != null && !(typeof baseline[key] === 'number' && Number.isFinite(baseline[key]) && baseline[key] >= 0)) throw new Error('Malformed baseline metric.');
  }
  if (baseline.scriptHotFn != null && (typeof baseline.scriptHotFn !== 'string' || baseline.scriptHotFn.length > 1000)) throw new Error('Malformed baseline hotspot.');
  for (const key of ['serverType', 'speed']) {
    if (baseline[key] !== undefined && (typeof baseline[key] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(baseline[key]))) throw new Error('Malformed baseline server settings.');
  }
  return Object.fromEntries([
    ...BASELINE_KEYS.map((key) => [key, baseline[key] ?? null]),
    ...['serverType', 'speed'].filter((key) => baseline[key] !== undefined).map((key) => [key, baseline[key]]),
  ]);
}

export async function fetchBaseline({ result, inputs, env, event = {}, fetch = globalThis.fetch, warning = () => {} }) {
  try {
    let ref = inputs.baseline;
    if (ref === 'default-branch') {
      const defaultBranch = event?.repository?.default_branch;
      ref = validRef(defaultBranch) ? defaultBranch : env.GITHUB_EVENT_NAME === 'schedule' ? env.GITHUB_REF_NAME : undefined;
    }
    if (!validRepository(env.GITHUB_REPOSITORY) || !validRef(ref)) throw new Error('Invalid baseline repository or ref.');
    const suite = result?.name;
    const serverType = result?.server?.type;
    const speed = result?.server?.speed;
    if (typeof suite !== 'string' || !/^[\x20-\x7e]{1,100}$/.test(suite)
      || typeof serverType !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(serverType)
      || typeof speed !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(speed)) throw new Error('Run suite or server settings are missing or invalid.');
    const url = new URL('/api/v1/e2e/ci/baseline', apiOrigin(env.MINEBUD_API_URL));
    url.search = new URLSearchParams({ repository: env.GITHUB_REPOSITORY, ref, suite, serverType, speed }).toString();
    const response = await fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${inputs['api-key']}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}.`);
    const chunks = [];
    let size = 0;
    if (!response.body) throw new Error('Empty response.');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); throw new Error('Response exceeds 64 KiB.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return parseBaseline(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    // Fetch errors can contain the URL or provider messages; never echo them with credentials.
    warning('Baseline unavailable (HTTP error, timeout, invalid settings, or malformed response); regression checks are not compared.');
    return null;
  }
}
