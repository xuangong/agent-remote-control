import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { supportsCodexDaemonControl } from './codex-daemon-runner.js';

/** Migrate legacy private Hosts without replacing or restarting an existing daemon. */
export async function prepareSharedCodex(stateDir: string, environment: NodeJS.ProcessEnv,
  cli = fileURLToPath(new URL('./cli.js', import.meta.url))): Promise<void> {
  const managed = environment.AGENT_HOST_BOOTSTRAP_CODEX === '1'
    || environment.AGENT_HOST_GATEWAY_SETUP === '1' && (environment.AGENT_HOST_PROVIDERS ?? 'codex').split(',').some(provider => provider.trim() === 'codex');
  if (environment.AGENT_HOST_CODEX_CONNECTION !== 'private' && !managed && environment.AGENT_HOST_CODEX_AUTO_START !== '1') return;
  const shared = {...environment, AGENT_HOST_CODEX_CONNECTION: 'shared'};
  if (!supportsCodexDaemonControl(shared)) throw new Error('Cannot migrate a custom Codex daemon configuration automatically. Configure and start the shared daemon locally.');
  if (environment.AGENT_HOST_CODEX_TRUST_SHARED === '0' && environment.AGENT_HOST_TRUSTED_FULL_CONTROL !== '1') {
    throw new Error('Shared Codex is disabled by the local trust policy. Enable trusted shared control before migrating this Host.');
  }
  const run = (action: string) => promisify(execFile)(process.execPath, [cli, 'codex', 'daemon', action], {
    env: {...environment, AGENT_HOST_STATE_DIR: stateDir}, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
  });
  try { await run('status'); }
  catch {
    try { await run('start'); await run('status'); }
    catch { throw new Error('The shared Codex daemon could not be confirmed. Start it locally with agent-remote-controller codex daemon start, then retry.'); }
  }
  environment.AGENT_HOST_CODEX_CONNECTION = 'shared';
}
