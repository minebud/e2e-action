import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFile, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { containedPath, escapeData } from './annotate.mjs';

export const DEFAULTS = Object.freeze({
  'api-key': '', sdk: 'js', 'sdk-version': '', 'working-directory': '.', config: 'minebud-e2e.json', paths: '', junit: '',
  'queue-timeout-minutes': '15', 'wait-timeout-minutes': '30', 'on-missing-key': 'skip', 'fail-on-infra': 'true',
  annotations: 'true', summary: 'true', 'max-mspt-p95': '', 'max-script-hotspot-ms': '', 'max-script-errors': '',
  'fail-on-insight-severity': 'none', baseline: 'none', 'max-regression-pct': '20', 'min-regression-ms': '2',
});

export function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value)
    && value.split('/').every((part) => part !== '.' && part !== '..');
}
export function validRef(value) {
  return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 255
    && !/[\x00-\x1f\x7f-\x9f]/.test(value) && !value.includes('..') && !value.startsWith('-');
}
export function apiOrigin(raw) {
  let url;
  try { url = new URL(raw || 'https://minebud.dev'); } catch { throw new Error('MINEBUD_API_URL must be a valid origin.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MINEBUD_API_URL must be an origin without credentials, path, query, or fragment.');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname))) return url.origin;
  throw new Error('MINEBUD_API_URL must use HTTPS (HTTP is allowed only for localhost).');
}

export function parseInputs(env) {
  const inputs = Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => {
    const raw = env[`INPUT_${name.toUpperCase().replaceAll(' ', '_')}`];
    return [name, raw === undefined || String(raw).trim() === '' ? fallback : String(raw).trim()];
  }));
  if (inputs['api-key'] && !/^[\x21-\x7e]{1,4096}$/.test(inputs['api-key'])) throw new Error('api-key must be a single-line printable ASCII value without whitespace (maximum 4096 characters).');
  for (const [name, values] of Object.entries({ sdk: ['js', 'python'], 'on-missing-key': ['skip', 'fail'], 'fail-on-insight-severity': ['none', 'warning', 'error'] })) {
    if (!values.includes(inputs[name])) throw new Error(`${name} must be ${values.join(' or ')}.`);
  }
  if (inputs['sdk-version'] && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(inputs['sdk-version'])) throw new Error('sdk-version must be a numeric major.minor.patch version (1–4 digits per component).');
  for (const name of ['fail-on-infra', 'annotations', 'summary']) {
    if (!['true', 'false'].includes(inputs[name])) throw new Error(`${name} must be true or false.`);
    inputs[name] = inputs[name] === 'true';
  }
  for (const [name, min, max, optional] of [
    ['queue-timeout-minutes', 1, 360], ['wait-timeout-minutes', 1, 360],
    ['max-mspt-p95', 0, 1e9, true], ['max-script-hotspot-ms', 0, 1e9, true], ['max-script-errors', 0, 1e9, true],
    ['max-regression-pct', 0, 1e6], ['min-regression-ms', 0, 1e9],
  ]) {
    const value = inputs[name];
    if (optional && value === '') { inputs[name] = null; continue; }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
    inputs[name] = Number(value);
  }
  if (!['none', 'default-branch'].includes(inputs.baseline) && !validRef(inputs.baseline)) throw new Error('baseline must be none, default-branch, or a valid branch ref (1–255 bytes, no controls, .., or leading -).');
  if (inputs.baseline !== 'none' && !validRepository(env.GITHUB_REPOSITORY)) throw new Error('GITHUB_REPOSITORY is invalid for baseline lookup.');
  inputs.apiOrigin = apiOrigin(env.MINEBUD_API_URL);
  if (!env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) throw new Error('GITHUB_WORKSPACE must be an absolute directory.');
  inputs.workspace = path.resolve(env.GITHUB_WORKSPACE);
  inputs.workingDirectory = path.resolve(inputs.workspace, inputs['working-directory']);
  const context = { workspace: inputs.workspace, workingDirectory: inputs.workingDirectory };
  const safe = (file, name, base = inputs.workingDirectory) => {
    const absolute = path.resolve(base, file);
    if (containedPath(absolute, { ...context, allowRoot: true }) === null) throw new Error(`${name} must resolve inside GITHUB_WORKSPACE without escaping symlinks or control characters.`);
    return absolute;
  };
  safe(inputs.workingDirectory, 'working-directory');
  inputs.config = safe(inputs.config, 'config');
  inputs.junit = inputs.junit ? safe(inputs.junit, 'junit') : '';
  inputs.paths = inputs.paths ? inputs.paths.split(/\s+/).map((file) => safe(file, 'paths')) : [];
  return inputs;
}

export function childEnv(env, apiKey) {
  const child = Object.fromEntries(Object.entries(env).filter(([key]) => !/^INPUT_/i.test(key) && key !== 'MINEBUD_API_KEY'));
  if (apiKey) child.MINEBUD_API_KEY = apiKey;
  return child;
}

export async function readBoundedFile(file, maxBytes) {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > maxBytes) throw new Error('File exceeds size limit.');
    const chunks = [];
    let size = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      size += bytes.length;
      if (size > maxBytes) throw new Error('File exceeds size limit.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}
export async function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try { return JSON.parse(await readBoundedFile(env.GITHUB_EVENT_PATH, 1024 * 1024)); } catch { return {}; }
}
export function command(level, message) { return `::${level}::${escapeData(message)}`; }
export function outputRecord(name, value, random = randomBytes) {
  const text = String(value ?? '');
  let delimiter;
  do { delimiter = `minebud_${random(16).toString('hex')}`; } while (text.includes(delimiter));
  return `${name}<<${delimiter}\n${text}\n${delimiter}\n`;
}
export async function writeOutputs(env, values) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => outputRecord(key, value)).join(''));
}
export async function writeSummary(env, summary) {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
}

// Each child owns one stop-commands region. JSON stdout is captured, never echoed.
export function createExec({ spawn = nodeSpawn, log = (text) => process.stdout.write(text), signals = process, secret = '' } = {}) {
  return async (cmd, args, options = {}) => {
    const token = randomBytes(16).toString('hex');
    log(`::stop-commands::${token}\n`);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const emit = (text, final = false) => {
      pending += text;
      if (secret) pending = pending.split(secret).join('[redacted]');
      const count = final ? pending.length : Math.max(0, pending.length - Math.max(0, secret.length - 1));
      if (count) { log(pending.slice(0, count)); pending = pending.slice(count); }
    };
    let child;
    let timer;
    const forward = (signal) => () => child?.kill(signal);
    const interrupt = forward('SIGINT');
    const terminate = forward('SIGTERM');
    try {
      return await new Promise((resolve, reject) => {
        const { env, cwd, windowsVerbatimArguments = false, timeoutMs, captureStdout = true, maxStdoutBytes = 64 * 1024 * 1024 } = options;
        child = spawn(cmd, args, { env, cwd, shell: false, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0;
        let failure;
        if (options.forwardSignals) { signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate); }
        if (timeoutMs) timer = setTimeout(() => { failure = new Error('Child process timed out.'); child.kill('SIGTERM'); }, timeoutMs);
        child.stdout.on('data', (chunk) => {
          if (!captureStdout) { emit(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > maxStdoutBytes) { failure = new Error('SDK stdout exceeded its size limit.'); child.kill('SIGTERM'); return; }
          chunks.push(chunk);
        });
        // Stderr has its own decoder: stdout logging is used only for install processes.
        const stderrDecoder = new StringDecoder('utf8');
        child.stderr.on('data', (chunk) => emit(stderrDecoder.write(chunk)));
        child.on('error', reject);
        child.on('close', (code, signal) => {
          emit(stderrDecoder.end());
          if (failure) reject(failure);
          else resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 1), stdout: Buffer.concat(chunks).toString('utf8') });
        });
      });
    } finally {
      clearTimeout(timer);
      if (options.forwardSignals) { signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', terminate); }
      emit(decoder.end(), true);
      log(`\n::${token}::\n`);
    }
  };
}
