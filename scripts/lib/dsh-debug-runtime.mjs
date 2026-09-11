import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DSH_VERSION = '0.1.2-rc.1';
export const PNPM_VERSION = '10.34.5';

export function parseOptions(args, root, cwd) {
  const options = {
    yes: false, help: false, buildDsh: false, serverUrl: 'http://127.0.0.1:5910', consoleUrl: 'http://127.0.0.1:6175',
    stateDir: resolve(root, '.runtime/dsh-debug'), workspace: cwd, dshPort: 3081,
    name: 'DSH Debug', registry: 'https://mirrors.cloud.tencent.com/npm/',
  };
  const fields = { '--server-url': 'serverUrl', '--console-url': 'consoleUrl', '--state-dir': 'stateDir', '--home': 'home', '--workspace': 'workspace', '--dsh-port': 'dshPort', '--name': 'name', '--registry': 'registry', '--dsh': 'dsh', '--dsh-repo': 'dshRepo' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--yes') { options.yes = true; continue; }
    if (argument === '--build-dsh') { options.buildDsh = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    const field = fields[argument];
    if (!field) throw new Error(`Unknown option: ${argument}. Use --help.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    options[field] = value;
  }
  for (const field of ['stateDir', 'workspace', 'home', 'dsh', 'dshRepo']) if (options[field]) options[field] = resolve(cwd, options[field]);
  if (options.dsh && options.dshRepo) throw new Error('Choose either --dsh or --dsh-repo.');
  if (options.buildDsh && !options.dshRepo) throw new Error('--build-dsh requires --dsh-repo.');
  options.home ??= resolve(options.stateDir, 'home');
  options.dshPort = Number(options.dshPort);
  if (!Number.isInteger(options.dshPort) || options.dshPort < 1 || options.dshPort > 65535) throw new Error('DSH port must be an integer from 1 to 65535.');
  for (const field of ['serverUrl', 'consoleUrl', 'registry']) {
    const url = new URL(options[field]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (field !== 'registry' && url.pathname !== '/')) throw new Error(`Invalid ${field}: use an HTTP(S) URL without credentials, query, or fragment.`);
    options[field] = field === 'registry' ? url.href : url.origin;
  }
  return options;
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, signal: options.signal ?? AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.error ?? body?.message ?? response.statusText}`);
  if (!body) throw new Error(`Invalid JSON response from ${new URL(url).origin}.`);
  return body;
}

export async function waitFor(check, { timeoutMs = 60000, intervalMs = 500, signal } = {}) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    signal?.throwIfAborted();
    const result = await check();
    if (result) return result;
    await delay(intervalMs, undefined, { signal });
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

export function startProcess(command, args, { cwd, env, logFile, secrets = [], output = console.log, stopTimeoutMs = 3000, stopLeaderFirst = false } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let running = true;
  let stopping;
  const emit = (line) => {
    for (const secret of secrets) if (secret) line = line.replaceAll(secret, '[redacted]');
    if (logFile) appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
    output(line);
  };
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', emit);
  const finished = new Promise((accept) => {
    child.once('error', (error) => { running = false; accept({ code: 1, error }); });
    child.once('close', (code, signal) => { running = false; accept({ code, signal }); });
  });
  function kill(signal, leaderOnly = false) {
    if (!child.pid) return;
    try {
      if (leaderOnly || process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return {
    get running() { return running; },
    finished,
    stop() {
      stopping ??= (async () => {
        if (!running) return;
        async function waitForExit() {
          let timer;
          await Promise.race([finished, new Promise((accept) => { timer = setTimeout(accept, stopTimeoutMs); })]);
          clearTimeout(timer);
        }
        if (stopLeaderFirst) {
          kill('SIGTERM', true);
          await waitForExit();
        }
        // Reap any descendants left behind even if the leader already exited.
        kill('SIGTERM');
        if (process.platform !== 'win32') {
          const deadline = Date.now() + stopTimeoutMs;
          const groupAlive = () => {
            try { process.kill(-child.pid, 0); return true; }
            catch (error) { if (error.code === 'ESRCH') return false; throw error; }
          };
          while ((running || groupAlive()) && Date.now() < deadline) await delay(20);
          if (running || groupAlive()) kill('SIGKILL');
        } else {
          if (running) await waitForExit();
          if (running) kill('SIGKILL');
        }
        if (running) await finished;
      })();
      return stopping;
    },
  };
}
