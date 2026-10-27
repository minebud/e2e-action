import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { installSdk, waitOptions } from './install.mjs';
import { buildAnnotations } from './annotate.mjs';
import { renderSummary } from './summary.mjs';
import { evaluateThresholds, metric, topHotspot } from './thresholds.mjs';
import { fetchBaseline } from './baseline.mjs';
import { parseInputs, childEnv, createExec, command, readBoundedFile, readEvent, writeOutputs, writeSummary } from './github.mjs';

export function actionFailed(sdkCode, failOnInfra, breached = false) {
  if (breached) return true;
  if (sdkCode === 0) return false;
  return [3, 4, 5].includes(sdkCode) ? failOnInfra : true;
}
function resultDocument(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.schema === 'minebud-e2e-result/1'
    && typeof value.status === 'string' && typeof value.runId === 'string' ? value : null;
}
function parseEnvelope(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value?.schema === 'minebud-e2e-cli/1' && Number.isInteger(value.exitCode) ? value : null;
  } catch { return null; }
}
function dashboardUrl(runId) {
  return typeof runId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(runId)
    ? `https://minebud.dev/dashboard/runs/run?id=${encodeURIComponent(runId)}` : '';
}

// Dependencies keep orchestration runnable with a fake CLI or an offline SDK fetch.
export async function run(deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((text) => process.stdout.write(text));
  const emit = deps.command ?? ((line) => log(`${line}\n`));
  const notice = (message) => emit(command('notice', message));
  const warning = (message) => emit(command('warning', message));
  const errorCommand = (message) => emit(command('error', message));
  const rawKey = String(env['INPUT_API-KEY'] ?? '').trim();
  const key = /^[\x21-\x7e]{1,4096}$/.test(rawKey) ? rawKey : '';
  if (key) emit(command('add-mask', key));
  const redact = (text) => key ? String(text).split(key).join('[redacted]') : String(text);
  const exec = deps.exec ?? createExec({ spawn: deps.spawn, log, signals: deps.signals, secret: key });
  const outputs = { 'run-id': '', status: 'error', 'result-path': '', 'dashboard-url': '', 'mspt-p95': '', 'script-hotspot-ms': '', regressions: '[]' };
  let inputs;
  let result = null;
  let digest = null;
  let cliError = null;
  let sdkExitCode;
  let baseline = null;
  let thresholds = { checks: [], breached: false, regressions: [] };
  let annotations = { lines: [], emitted: [], overflow: [] };
  let skipped = false;
  let note = '';
  let exitCode = 1;
  const event = await readEvent(env);
  try {
    inputs = parseInputs(env);
    if (!inputs['api-key']) {
      if (inputs['on-missing-key'] === 'fail') throw new Error('api-key is empty and on-missing-key is fail.');
      skipped = true;
      note = `Minebud E2E skipped: api-key is missing. Fork pull requests receive no secrets.${event?.pull_request?.head?.repo?.fork === true ? ' This pull request is from a fork.' : ''}`;
      notice(note);
      outputs.status = 'skipped';
      exitCode = 0;
    } else {
      if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) throw new Error('RUNNER_TEMP must be an absolute directory.');
      const baseEnv = childEnv(env);
      const installed = await (deps.installSdk ?? installSdk)({ sdk: inputs.sdk, version: inputs['sdk-version'], runnerTemp: env.RUNNER_TEMP, env: baseEnv, fetch: deps.fetch ?? globalThis.fetch, exec, warning, platform: deps.platform ?? process.platform, execPath: process.execPath });
      const sdkEnv = { ...baseEnv, ...installed.env, MINEBUD_API_KEY: inputs['api-key'] };
      const help = await exec(installed.command, [...installed.args, 'help'], { env: childEnv(sdkEnv), cwd: inputs.workingDirectory, captureStdout: true, maxStdoutBytes: 1024 * 1024, timeoutMs: 30_000 });
      if (help.code !== 0) throw new Error('Installed SDK help failed; cannot detect supported flags.');
      const wait = waitOptions(help.stdout, inputs['queue-timeout-minutes'], inputs['wait-timeout-minutes']);
      if (wait.notice) notice(wait.notice);
      const resultPath = path.join(env.RUNNER_TEMP, 'minebud', 'result.json');
      await mkdir(path.dirname(resultPath), { recursive: true });
      // A stale receipt must never be mistaken for the new SDK invocation's result.
      await rm(resultPath, { force: true });
      const args = [...installed.args, 'run', ...inputs.paths, '--config', inputs.config, '--json', '--out', resultPath,
        ...(inputs.junit ? ['--junit', inputs.junit] : []), ...wait.args, '--no-save'];
      const child = await exec(installed.command, args, { env: sdkEnv, cwd: inputs.workingDirectory, captureStdout: true, maxStdoutBytes: 64 * 1024 * 1024, forwardSignals: true });
      sdkExitCode = child.code;
      const envelope = parseEnvelope(child.stdout);
      digest = envelope?.digest ?? null;
      try { result = resultDocument(JSON.parse(await readBoundedFile(resultPath, 64 * 1024 * 1024))); } catch { /* Envelope fallback is supported by both SDKs. */ }
      const hasResultFile = !!result;
      result ??= resultDocument(envelope?.result);
      if (result && !hasResultFile) await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
      if (envelope?.error) cliError = { code: redact(envelope.error.code ?? sdkExitCode), message: redact(envelope.error.message ?? 'SDK failed.') };
      if (!result) {
        cliError ??= { code: sdkExitCode, message: envelope ? 'SDK produced no result document.' : 'SDK produced no valid JSON result or error envelope.' };
        // Only known SDK infrastructure failures may continue without a result.
        exitCode = actionFailed(sdkExitCode, inputs['fail-on-infra']) || sdkExitCode === 0 ? 1 : 0;
      } else {
        if (inputs.baseline !== 'none') baseline = await fetchBaseline({ result, inputs, env, event, fetch: deps.fetch ?? globalThis.fetch, warning });
        thresholds = evaluateThresholds(result, inputs, baseline);
        outputs['run-id'] = result.runId;
        outputs.status = result.status;
        outputs['result-path'] = resultPath;
        outputs['dashboard-url'] = dashboardUrl(result.runId);
        outputs['mspt-p95'] = metric(result, 'mspt.p95') ?? '';
        outputs['script-hotspot-ms'] = topHotspot(result)?.selfMs ?? '';
        outputs.regressions = JSON.stringify(thresholds.regressions);
        annotations = buildAnnotations(result, { workspace: inputs.workspace, workingDirectory: inputs.workingDirectory, digest, thresholds });
        if (inputs.annotations) for (const line of annotations.lines) emit(line);
        else annotations = { ...annotations, lines: [], emitted: [], overflow: [...annotations.emitted, ...annotations.overflow].map((item) => ({ ...item, reason: 'Annotations disabled.' })) };
        exitCode = actionFailed(sdkExitCode, inputs['fail-on-infra'], thresholds.breached) ? 1 : 0;
      }
      if ([3, 4, 5].includes(sdkExitCode) && !inputs['fail-on-infra']) warning(`SDK infrastructure exit ${sdkExitCode} ignored because fail-on-infra is false${cliError ? `: ${cliError.code}: ${cliError.message}` : '.'}`);
      else if (sdkExitCode !== 0) errorCommand(`SDK exit ${sdkExitCode}${cliError ? `: ${cliError.code}: ${cliError.message}` : '.'}`);
      if (thresholds.breached) errorCommand('Minebud E2E performance thresholds breached; see the job summary.');
    }
  } catch (error) {
    cliError = { code: 'action_error', message: redact(error?.message ?? 'Action failed.') };
    errorCommand(cliError.message);
    exitCode = 1;
  }
  // Reporting runs for validation/install/SDK errors too, before deciding the job result.
  const ctx = { result, digest, error: cliError, sdkExitCode, skipped, note, baseline, thresholds, annotations, env, event, workspace: inputs?.workspace, workingDirectory: inputs?.workingDirectory };
  if (inputs?.summary ?? String(env.INPUT_SUMMARY ?? 'true').trim() !== 'false') {
    try { await (deps.writeSummary ?? ((text) => writeSummary(env, text)))(renderSummary(ctx)); }
    catch { errorCommand('Could not write the job summary.'); exitCode = 1; }
  }
  try { await (deps.writeOutputs ?? ((values) => writeOutputs(env, values)))(outputs); }
  catch { errorCommand('Could not write action outputs.'); exitCode = 1; }
  return { exitCode, outputs, result, error: cliError, thresholds, annotations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(({ exitCode }) => { process.exitCode = exitCode; }).catch(() => { process.exitCode = 1; });
}
