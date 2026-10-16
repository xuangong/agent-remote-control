import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { containerEnvironment } from '../controller/entrypoint.mjs';
import { alignCodexRuntime, prepareCodexProfile } from './codex-profile.mjs';

const applicationRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function devboxConfiguration(environment = process.env) {
  const port = Number(environment.DEVBOX_PORT ?? 5910);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEVBOX_PORT must be a port from 1 to 65535.');
  const url = new URL(environment.DEVBOX_ORIGIN ?? `http://localhost:${port}`);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || Number(url.port || 80) !== port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Devbox requires a loopback HTTP origin using DEVBOX_PORT.');
  return {
    port, origin: url.origin, bind: environment.DEVBOX_BIND ?? '127.0.0.1',
    stateDir: resolve(environment.DEVBOX_STATE_DIR ?? '/data/relay'),
    webDist: resolve(environment.DEVBOX_WEB_DIST ?? join(applicationRoot, 'dist/relay/web')),
  };
}

export function controllerInvocation(environment, args) {
  const executable = environment.DEVBOX_CONTROLLER ?? 'agent-remote-controller';
  return /\.[cm]?js$/.test(executable) ? [process.execPath, [executable, ...args]] : [executable, args];
}

/** The box owns one Relay and one foreground Controller; native profiles stay durable. */
export async function startDevbox({ environment = process.env, createServer } = {}) {
  const configuration = devboxConfiguration(environment);
  const supplied = { ...environment, AGENT_HOST_SERVER: configuration.origin,
    AGENT_HOST_STATE_DIR: resolve(environment.AGENT_HOST_STATE_DIR ?? join(homedir(), '.agent-remote-control/agent-host')),
    AGENT_HOST_WORKSPACE: resolve(environment.AGENT_HOST_WORKSPACE ?? '/workspace'), AGENT_HOST_NAME: environment.AGENT_HOST_NAME ?? 'Devbox' };
  delete supplied.AGENT_HOST_REMOTE_KEY;
  delete supplied.AGENT_HOST_REMOTE_KEY_FILE;
  const nativeEnvironment = await containerEnvironment(supplied);
  await mkdir(nativeEnvironment.AGENT_HOST_STATE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(nativeEnvironment.AGENT_HOST_WORKSPACE, { recursive: true });
  // Native Codex requires an explicitly selected profile directory to exist.
  const codexHome = resolve(nativeEnvironment.AGENT_HOST_WORKSPACE, nativeEnvironment.AGENT_REMOTE_CODEX_HOME ?? nativeEnvironment.CODEX_HOME
    ?? join(nativeEnvironment.HOME ?? homedir(), '.codex'));
  // Explicit startup selections also override profile and executable settings retained by the Host.
  nativeEnvironment.CODEX_HOME = codexHome;
  if (nativeEnvironment.AGENT_REMOTE_CODEX_HOME !== undefined) nativeEnvironment.AGENT_REMOTE_CODEX_HOME = codexHome;
  nativeEnvironment.AGENT_HOST_CODEX = nativeEnvironment.AGENT_HOST_CODEX ?? nativeEnvironment.AGENT_REMOTE_CODEX_EXECUTABLE ?? 'codex';
  await prepareCodexProfile(codexHome);
  await alignCodexRuntime(codexHome, nativeEnvironment, nativeEnvironment.AGENT_HOST_WORKSPACE);
  const factory = createServer ?? (await import('../../dist/devbox/server.mjs')).createDevboxServer;
  const server = await factory(configuration);
  let callbackRoot;
  try {
    await server.listen(configuration.port, configuration.bind);
    // These are per-container runtime artifacts, regenerated from the installed branch.
    // Persistent native history and Host source grants do not live in this directory.
    callbackRoot = await mkdtemp(join(tmpdir(), 'arc-devbox-callbacks-'));
    const callbacks = join(callbackRoot, 'opencode');
    try {
      await promisify(execFile)(...controllerInvocation(nativeEnvironment, ['opencode', 'callbacks', 'setup', callbacks]),
        { env: nativeEnvironment, cwd: nativeEnvironment.AGENT_HOST_WORKSPACE, timeout: 15000, maxBuffer: 65536 });
    } catch { throw new Error('Devbox could not prepare the installed OpenCode callback plugin. Rebuild the Controller image.'); }
    nativeEnvironment.AGENT_HOST_OPENCODE_CALLBACK_CONFIG = join(callbacks, 'callback.json');
    nativeEnvironment.OPENCODE_CONFIG = join(callbacks, 'opencode-arc.json');
    if (nativeEnvironment.AGENT_HOST_SERVER) {
      const connection = await server.getConnection();
      if (connection.serverUrl !== configuration.origin || typeof connection.remoteKey !== 'string' || !connection.remoteKey)
        throw new Error('Devbox enrollment did not return a matching local Host connection.');
      nativeEnvironment.AGENT_HOST_REMOTE_KEY = connection.remoteKey;
    }
    const child = spawn(...controllerInvocation(nativeEnvironment, ['foreground']), {
      env: nativeEnvironment, cwd: nativeEnvironment.AGENT_HOST_WORKSPACE, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    let stopping = false, spawnFailed = false, timer;
    child.on('error', () => { spawnFailed = true; });
    const exited = new Promise(resolveExit => child.once('close', (code) => resolveExit(spawnFailed ? 1 : code ?? 1)));
    const done = exited.then(async code => {
      clearTimeout(timer);
      await server.close();
      await rm(callbackRoot, { recursive: true, force: true });
      return stopping ? 0 : code || 1;
    });
    return {
      origin: configuration.origin, done,
      async close() {
        if (!stopping && child.exitCode === null && child.signalCode === null) {
          stopping = true;
          child.kill('SIGTERM');
          timer = setTimeout(() => {
            try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
          }, 15000);
          timer.unref();
        }
        return done;
      },
    };
  } catch (error) {
    await server.close();
    if (callbackRoot) await rm(callbackRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let running, interrupted = false;
  const stop = () => { interrupted = true; void running?.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    running = await startDevbox();
    if (interrupted) await running.close();
    else process.stdout.write(`Devbox is available at ${running.origin}\nThe local Controller is starting. Native provider sign-in is separate.\n`);
    process.exitCode = await running.done;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
