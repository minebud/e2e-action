import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, open, rm } from 'node:fs/promises';
import path from 'node:path';

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$(?![\s\S])/;
const MAX_BYTES = 32 * 1024 * 1024;

function failure(message, code = 'sdk_install_failed') {
  return Object.assign(new Error(message), { code });
}

async function download(url, destination, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let file;
    let retry = false;
    try {
      let response;
      try {
        response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
      } catch (error) {
        // A refused redirect is a policy failure, not a transient network error.
        if (/redirect/i.test(`${error.message} ${error.cause?.message ?? ''}`)) throw failure('SDK redirects are not permitted');
        retry = true;
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel();
        retry = response.status >= 500 && response.status <= 599;
        throw failure(`SDK download failed (HTTP ${response.status})`);
      }
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > MAX_BYTES) {
        await response.body?.cancel();
        throw failure('SDK download exceeds 32 MiB');
      }
      if (!response.body) throw failure('SDK download has no body');
      file = await open(destination, 'w', 0o600);
      const hash = createHash('sha256');
      let total = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          let chunk;
          try { chunk = await reader.read(); } catch (error) { retry = true; throw error; }
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MAX_BYTES) throw failure('SDK download exceeds 32 MiB');
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return hash.digest();
    } catch (error) {
      if (!retry || attempt === 2) throw error;
    } finally {
      clearTimeout(timer);
      await file?.close();
    }
  }
}

/** Windows uses cmd.exe with delayed expansion disabled. Unsafe expansion/control
 * characters in temporary paths are rejected; exec preserves the quoted command. */
export async function installSdk({ version = '', runnerTemp, env = {}, fetch: fetchImpl = globalThis.fetch,
  exec, warning = () => {}, platform = process.platform, execPath = process.execPath, pins: suppliedPins = null }) {
  if (version !== '' && (typeof version !== 'string' || !VERSION.test(version))) {
    throw failure('sdk-version must be a numeric major.minor.patch version', 'invalid_input');
  }
  const pins = suppliedPins ?? JSON.parse(await readFile(new URL('../sdk-pins.json', import.meta.url), 'utf8'));
  const pin = pins.js;
  const selected = version || pin.version;
  if (!VERSION.test(selected) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw failure('Invalid SDK integrity pin');
  const pinned = selected === pin.version;
  if (!pinned) warning(`SDK ${selected} overrides the pinned version; integrity is not verified.`);
  const root = path.join(runnerTemp, 'minebud');
  await mkdir(root, { recursive: true });
  const childEnv = { ...env };
  // Installation and probing never receive the API key, even if callers pass it.
  delete childEnv.MINEBUD_API_KEY;
  const archive = path.join(root, `minebud-e2e-${selected}.tgz`);
  const prefix = path.join(root, 'js');
  try {
    const digest = await download(`https://minebud.dev/e2e/minebud-e2e-${selected}.tgz`, archive, fetchImpl);
    if (pinned && !timingSafeEqual(digest, Buffer.from(pin.sha256, 'hex'))) {
      throw failure('SDK SHA-256 integrity mismatch', 'sdk_integrity_failed');
    }
    const args = ['install', '--no-save', '--no-audit', '--no-fund', '--offline', '--ignore-scripts', '--prefix', prefix, archive];
    let result;
    if (platform === 'win32') {
      const quote = (value) => {
        if (/["%!\x00-\x1f\x7f]/.test(value)) throw failure('Unsafe Windows installation path');
        return `"${value}"`;
      };
      result = await exec('cmd.exe', ['/d', '/s', '/v:off', '/c', `"${['npm.cmd', ...args].map(quote).join(' ')}"`], { env: childEnv, cwd: root, windowsVerbatimArguments: true });
    } else {
      result = await exec('npm', args, { env: childEnv, cwd: root, shell: false });
    }
    if (result.code !== 0) throw failure('npm SDK installation failed');
    return { command: execPath, args: [path.join(prefix, 'node_modules', '@minebud', 'e2e', 'bin', 'minebud-e2e.mjs')], env: childEnv, version: selected };
  } finally {
    await rm(archive, { force: true });
  }
}

export function waitOptions(helpText, queueMinutes, waitMinutes) {
  if (/(?:^|\s)--wait-for-slot(?=\s|[=,]|$)/m.test(helpText)) {
    return { args: ['--wait-for-slot', String(queueMinutes * 60), '--wait-timeout', String(waitMinutes * 60)], notice: null };
  }
  return { args: ['--wait-timeout', String(Math.min(waitMinutes * 60, 900))],
    notice: 'This SDK does not support --wait-for-slot; queue waiting is unavailable and --wait-timeout is capped at 900 seconds.' };
}
