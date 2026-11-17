import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexDaemonRestartUnknown } from './codex-daemon-control.js';
import { readCodexDaemonRestartRejection } from './codex-daemon-restart-error.js';

export function supportsCodexDaemonControl(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (environment.AGENT_HOST_CODEX_CONNECTION === 'private') return false;
  if (platform === 'win32') return !environment.AGENT_HOST_CODEX_SOCKET && !environment.AGENT_HOST_CODEX_NOFILE;
  const home = environment.AGENT_REMOTE_CODEX_HOME ?? environment.CODEX_HOME ?? join(homedir(), '.codex');
  return !environment.AGENT_HOST_CODEX_SOCKET
    || environment.AGENT_HOST_CODEX_SOCKET === join(resolve(home), 'app-server-control', 'app-server-control.sock');
}

/** Uses the same CLI lifecycle path as local commands, including locale, key, socket and descriptor limits. */
export async function restartCodexDaemon(options: { stateDir: string; environment: NodeJS.ProcessEnv; cli?: string; timeoutMs?: number; operationId?: string }): Promise<void> {
  if (!supportsCodexDaemonControl(options.environment)) throw new Error('Shared Codex daemon management is unavailable for this Host configuration.');
  const cli = options.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  for (const action of ['restart', 'status']) {
    const timeout = options.timeoutMs ?? (action === 'status' ? 15000 : process.platform === 'win32' ? 45000 : 15 * 60000);
    try {
      await promisify(execFile)(process.execPath, [cli, 'codex', 'daemon', action], {
        env: { ...options.environment, AGENT_HOST_STATE_DIR: options.stateDir, AGENT_HOST_DAEMON_ORIGIN: 'website', AGENT_HOST_DAEMON_OPERATION_ID: options.operationId },
        timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      });
    } catch (error) {
      // Never forward native output: configuration errors can include credentials or private paths.
      if ((error as { killed?: boolean }).killed) throw new CodexDaemonRestartUnknown('The daemon operation timed out; its outcome is unknown.');
      if (action === 'restart') {
        const rejected = readCodexDaemonRestartRejection((error as { stderr?: unknown }).stderr);
        if (rejected) throw rejected;
      }
      throw new Error('Codex daemon did not confirm restart and readiness.');
    }
  }
}
