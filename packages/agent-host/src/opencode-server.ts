import { openCodeVersionIssue, parseOpenCodeCliVersion } from '@orchardworks/agent-provider-opencode';
import { resolveOpenCodeExecutable } from './opencode-executable.js';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { sanitizeNativeEnvironment } from './execution-policy.js';
import { nativeInvocation } from './platform/executables/index.js';
import { applyOpenCodeServerConfig, ensureOpenCodeServerConfig, OpenCodeServerError, openCodeServerLocation, openCodeServerOwners,
  probeOpenCodeServer, readOpenCodeServerConfig, readOpenCodeServerOwner, readOpenCodeServerPreference, requestOpenCodeServerOwner,
  writeOpenCodeServerPreference } from './opencode-server-state.js';
export { OpenCodeServerError } from './opencode-server-state.js';

export interface OpenCodeServerStatus {
  running: boolean; ownership: 'managed' | 'external' | 'none'; url: string; autoStart: boolean;
  version?: string; pid?: number; nativePid?: number;
}
interface ServerOptions { cli?: string; onDiagnostic?: (line: string) => void }
const pending = new Map<string, Promise<unknown>>();
async function serialized<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(directory) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(action); pending.set(directory, operation);
  try { return await operation; } finally { if (pending.get(directory) === operation) pending.delete(directory); }
}
export async function loadOpenCodeServerCredentials(stateDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const location = openCodeServerLocation(stateDir, env);
  const config = await readOpenCodeServerConfig(location.directory);
  if (config) applyOpenCodeServerConfig(config, location.url, env);
}
async function settings(stateDir: string, env: NodeJS.ProcessEnv) {
  const location = openCodeServerLocation(stateDir, env);
  if (location.managed) {
    // Do not persist guessed credentials when an existing service rejects authentication.
    if (!await readOpenCodeServerConfig(location.directory)) {
      try { await probeOpenCodeServer(location.url, env); }
      catch (error) {
        // A concurrent Controller may have published credentials and bound the port meanwhile.
        if (!await readOpenCodeServerConfig(location.directory)) throw error;
      }
    }
    await ensureOpenCodeServerConfig(location.directory, location.url, env);
  }
  else await loadOpenCodeServerCredentials(stateDir, env);
  const preference = await readOpenCodeServerPreference(location.directory);
  return { ...location, preference, autoStart: location.managed && env.AGENT_HOST_OPENCODE_AUTO_START !== '0' && preference.enabled };
}
async function status(stateDir: string, env: NodeJS.ProcessEnv): Promise<OpenCodeServerStatus> {
  const configuration = await settings(stateDir, env);
  const owner = await readOpenCodeServerOwner(join(configuration.directory, 'owner.json'));
  const control = owner && await requestOpenCodeServerOwner(owner, 'status');
  const health = await probeOpenCodeServer(configuration.url, env);
  return { ...health, url: configuration.url, autoStart: configuration.autoStart,
    ownership: control?.running === true ? 'managed' : health.running ? 'external' : 'none',
    ...(control?.running === true ? { pid: owner!.pid, nativePid: Number(control.nativePid) } : {}) };
}
async function startNativeServer(stateDir: string, env: NodeJS.ProcessEnv, options: ServerOptions): Promise<OpenCodeServerStatus> {
  const configuration = await settings(stateDir, env);
  let current = await status(stateDir, env);
  // Health can become visible before the owning supervisor publishes readiness.
  const settlingDeadline = Date.now() + 20_000;
  while (current.ownership !== 'managed') {
    const owners = await openCodeServerOwners(configuration.directory);
    const controls = await Promise.all(owners.map(owner => requestOpenCodeServerOwner(owner, 'status')));
    if (!controls.some(control => control?.phase === 'starting' || control?.phase === 'stopping' || control?.running === true)) break;
    if ((await readOpenCodeServerPreference(configuration.directory)).revision !== configuration.preference.revision)
      throw new OpenCodeServerError('opencode_lifecycle_superseded', 'Another OpenCode lifecycle command replaced this request. Check server status.');
    if (Date.now() >= settlingDeadline)
      throw new OpenCodeServerError('opencode_start_failed', 'An OpenCode startup is still pending. Check server status before retrying.');
    await delay(100);
    current = await status(stateDir, env);
  }
  if (current.running) return current;
  if (!configuration.autoStart) throw new OpenCodeServerError('opencode_start_disabled', configuration.managed
    ? 'OpenCode server auto-start is disabled. Run agent-remote-controller opencode server start to enable it.'
    : 'The external OpenCode server is not reachable. Start it externally or explicitly enable auto-start for a local endpoint.');
  if (current.ownership === 'managed') throw new OpenCodeServerError('opencode_health_unreachable', 'The managed OpenCode process is still running but is not healthy. It will not be restarted automatically.');
  const nativeEnv = sanitizeNativeEnvironment(env);
  let executable: string;
  try {
    executable = resolveOpenCodeExecutable({ ...nativeEnv, AGENT_HOST_OPENCODE: env.AGENT_HOST_OPENCODE });
    const { stdout } = await promisify(execFile)(...nativeInvocation(executable, ['--version']), { env: nativeEnv, timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true });
    const issue = openCodeVersionIssue(parseOpenCodeCliVersion(stdout));
    if (issue) throw new OpenCodeServerError(issue.code, issue.message);
  } catch (error) {
    if (error instanceof OpenCodeServerError) throw error;
    throw new OpenCodeServerError('opencode_cli_unavailable', 'The Controller could not run OpenCode CLI. Install it on the Controller PATH or configure AGENT_HOST_OPENCODE.');
  }
  if ((await readOpenCodeServerPreference(configuration.directory)).revision !== configuration.preference.revision)
    throw new OpenCodeServerError('opencode_start_cancelled', 'OpenCode startup was cancelled by another lifecycle command.');
  await mkdir(configuration.directory, { recursive: true, mode: 0o700 }); await chmod(configuration.directory, 0o700);
  const log = await open(join(configuration.directory, 'server.log'), 'a', 0o600);
  const cli = options.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  const nativeArgs = [cli, '_opencode-server', configuration.directory];
  // A systemd cgroup outlives setsid; use a separate scope without weakening Host cleanup.
  const scoped = process.platform === 'linux' && env.AGENT_HOST_SUPERVISOR === 'systemd';
  const command = scoped ? 'systemd-run' : process.execPath;
  const args = scoped ? ['--user', '--scope', '--quiet', '--collect', `--unit=arc-opencode-${randomUUID()}`, process.execPath, ...nativeArgs] : nativeArgs;
  const child = spawn(command, args, { env: { ...nativeEnv, AGENT_HOST_OPENCODE: executable, AGENT_HOST_OPENCODE_START_REVISION: configuration.preference.revision },
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  child.unref(); await log.close();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const preference = await readOpenCodeServerPreference(configuration.directory);
    if (!preference.enabled || preference.revision !== configuration.preference.revision)
      throw new OpenCodeServerError('opencode_start_cancelled', 'OpenCode startup was cancelled by another lifecycle command.');
    const owner = await readOpenCodeServerOwner(join(configuration.directory, 'owner.json'));
    const control = owner && await requestOpenCodeServerOwner(owner, 'status');
    if (control?.running === true) {
      const result = await status(stateDir, env);
      if (result.running && result.ownership === 'managed') {
        options.onDiagnostic?.(JSON.stringify({ event: 'opencode_server_ready', outcome: 'managed', nativePid: result.nativePid }));
        return result;
      }
    }
    if (spawnFailed || child.exitCode !== null || child.signalCode !== null) {
      // A competing starter may have won the fixed native endpoint.
      const starters = await openCodeServerOwners(configuration.directory);
      const active = await Promise.all(starters.map(value => requestOpenCodeServerOwner(value, 'status')));
      if (!active.some(value => value?.phase === 'starting' || value?.running === true)) break;
    }
    await delay(100);
  }
  throw new OpenCodeServerError('opencode_start_failed', 'OpenCode did not confirm startup on the requested port. Inspect the private OpenCode server log; no existing service was restarted.');
}

/** Native service maintenance is independent of Provider registrations and open Session Views. */
export async function prepareOpenCodeServer(stateDir: string, environment: NodeJS.ProcessEnv, options: ServerOptions = {}): Promise<OpenCodeServerStatus> {
  const { directory } = openCodeServerLocation(stateDir, environment);
  return serialized(directory, () => startNativeServer(stateDir, environment, options));
}
export async function openCodeServerCommand(action: 'start' | 'stop' | 'restart' | 'status', stateDir: string, env: NodeJS.ProcessEnv, options: ServerOptions = {}): Promise<OpenCodeServerStatus> {
  if (action === 'status') return status(stateDir, env);
  const location = openCodeServerLocation(stateDir, env);
  if (action === 'stop' || action === 'restart') {
    // This write intentionally bypasses the in-process start queue so it can cancel startup.
    const stopping = await writeOpenCodeServerPreference(location.directory, false);
    const assertCurrent = async () => {
      if ((await readOpenCodeServerPreference(location.directory)).revision !== stopping.revision)
        throw new OpenCodeServerError('opencode_lifecycle_superseded', 'Another OpenCode lifecycle command replaced this request. Check server status.');
    };
    await loadOpenCodeServerCredentials(stateDir, env);
    const owners = await openCodeServerOwners(location.directory);
    for (const owner of owners) {
      if (!await requestOpenCodeServerOwner(owner, 'status')) continue;
      await assertCurrent();
      const result = await requestOpenCodeServerOwner(owner, 'stop');
      if (!result || result.running !== false) throw new OpenCodeServerError('opencode_stop_failed', 'OpenCode shutdown could not be confirmed. Check server status before continuing.');
    }
    await assertCurrent();
    const remaining = await status(stateDir, env);
    if (remaining.running) throw new OpenCodeServerError('opencode_external_server', 'This OpenCode service is externally managed. The Controller will not stop or restart it.');
    if (action === 'stop') return remaining;
  }
  if (!location.managed) throw new OpenCodeServerError('opencode_external_server', 'Automatic management is limited to the default local server, or an explicitly opted-in local endpoint.');
  return serialized(location.directory, async () => {
    await writeOpenCodeServerPreference(location.directory, true);
    return startNativeServer(stateDir, { ...env, AGENT_HOST_OPENCODE_AUTO_START: '1' }, options);
  });
}
