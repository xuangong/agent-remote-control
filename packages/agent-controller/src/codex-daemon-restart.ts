import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeInvocation } from './platform/executables/index.js';
import { CodexDaemonRestartRejected } from './codex-daemon-restart-error.js';

/** Native bootstrap replaces both processes; ordinary restart can reuse an updater's stale environment. */
export async function codexDaemonRestartArgs(executable: string, home: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
  let version: string;
  try {
    ({ stdout: version } = await promisify(execFile)(...nativeInvocation(executable, ['--version']), {
      env: environment, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    }));
  } catch { throw new CodexDaemonRestartRejected('unsupported_cli'); }
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
  // Older bootstrap commands may overwrite settings or ignore the selected daemon package and features.
  if (!match || Number(match[1]) === 0 && Number(match[2]) < 156) throw new CodexDaemonRestartRejected('unsupported_cli');

  let settings: unknown;
  try { settings = JSON.parse(await readFile(join(home, 'app-server-daemon', 'settings.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') settings = {};
    else throw new CodexDaemonRestartRejected('invalid_settings');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new CodexDaemonRestartRejected('invalid_settings');
  }
  const remoteControl = (settings as Record<string, unknown>).remoteControlEnabled;
  if (remoteControl !== undefined && typeof remoteControl !== 'boolean') {
    throw new CodexDaemonRestartRejected('invalid_settings');
  }
  // Bootstrap preserves other native settings but defaults this option to false when omitted.
  return ['app-server', 'daemon', 'bootstrap', ...(remoteControl ? ['--remote-control'] : [])];
}
