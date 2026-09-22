import { createLaunchdAutostart } from './macos.js';
import { createSystemdAutostart } from './linux.js';
import { createWindowsAutostart } from './windows.js';

export { systemdUnavailable } from './linux.js';

interface LoginStartupOptions {
  stateDir: string; home: string; nodePath: string; cliPath: string; cwd: string; path: string;
}

export function createLoginStartup(options: LoginStartupOptions) {
  if (process.platform === 'linux') return { kind: 'systemd' as const,
    ...createSystemdAutostart({ ...options, configHome: process.env.XDG_CONFIG_HOME }) };
  if (process.platform === 'darwin') return { kind: 'launchd' as const,
    ...createLaunchdAutostart({ ...options, uid: process.getuid!() }) };
  if (process.platform === 'win32') return { kind: 'windows' as const, ...createWindowsAutostart(options) };
  return undefined;
}
