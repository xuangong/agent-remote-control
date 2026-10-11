import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { resolveNativeExecutable } from './platform/executables/index.js';

/** Login services may not inherit paths added by the native CLI installer. */
export function resolveOpenCodeExecutable(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_HOST_OPENCODE !== undefined || process.platform === 'win32')
    return resolveNativeExecutable(env.AGENT_HOST_OPENCODE ?? 'opencode', 'opencode-ai/bin/opencode', env);
  const home = env.HOME ?? homedir();
  const directories = [...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.opencode', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const directory of directories) {
    const executable = resolve(directory, 'opencode');
    try { accessSync(executable, constants.X_OK); if (statSync(executable).isFile()) return executable; } catch {}
  }
  return 'opencode';
}
