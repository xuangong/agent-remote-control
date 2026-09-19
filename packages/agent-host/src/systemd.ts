import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readlink, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicPrivate, autostartEnabled } from './autostart-state.js';

interface CommandResult { code: number; stdout: string; stderr: string }
interface SystemdOptions {
  stateDir: string; home: string; nodePath: string; cliPath: string; cwd: string; path: string; configHome?: string;
  run?: (args: string[]) => Promise<CommandResult>;
}
export const systemdUnavailable = 'The systemd user manager is unavailable. Use a login session with systemctl --user access, or run foreground under your container supervisor.';

export function createSystemdAutostart(options: SystemdOptions) {
  const stateDir = resolve(options.stateDir);
  const label = `agent-remote-controller-${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}.service`;
  const configHome = options.configHome && isAbsolute(options.configHome) ? options.configHome : join(options.home, '.config');
  const directory = join(configHome, 'systemd', 'user');
  const unitFile = join(directory, label);
  const run = options.run ?? systemctl;
  async function checked(args: string[]): Promise<void> {
    const result = await run(['--user', ...args]);
    if (result.code !== 0) throw new Error(`systemctl --user ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  async function available(): Promise<boolean> { return (await run(['--user', 'show-environment'])).code === 0; }
  async function requireManager(): Promise<void> { if (!await available()) throw new Error(systemdUnavailable); }
  async function installed(): Promise<boolean> {
    try { await readFile(unitFile); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async function stop(): Promise<void> {
    if (!await available()) {
      if (await installed()) throw new Error(systemdUnavailable);
      return;
    }
    const state = await run(['--user', 'show', label, '--property=LoadState', '--value']);
    if (state.stdout.trim() === 'not-found') return;
    if (state.code !== 0) throw new Error('Could not inspect the systemd user service before stopping it.');
    await checked(['stop', label]);
  }
  return {
    available,
    async status() {
      const accessible = await available();
      return { enabled: await autostartEnabled(stateDir), installed: await installed(), available: accessible, label, unitFile,
        loaded: accessible && (await run(['--user', 'is-active', label])).code === 0,
        serviceEnabled: accessible && (await run(['--user', 'is-enabled', label])).code === 0 };
    },
    async install(): Promise<void> {
      await requireManager();
      const environment = { HOME: options.home, PATH: options.path, AGENT_HOST_STATE_DIR: stateDir, AGENT_HOST_SUPERVISOR: 'systemd' };
      const unit = ['[Unit]', 'Description=Agent Remote Controller', 'StartLimitIntervalSec=0', '', '[Service]', 'Type=simple',
        `ExecStart=${[resolve(options.nodePath), resolve(options.cliPath), '_serve'].map(value => quote(value, true)).join(' ')}`,
        `WorkingDirectory=${pathValue(resolve(options.cwd))}`,
        ...Object.entries(environment).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
        'Restart=always', 'RestartSec=10', 'TimeoutStopSec=30', 'KillMode=mixed', 'UMask=0077',
        `StandardOutput=append:${pathValue(join(stateDir, 'agent-host.log'))}`, 'StandardError=inherit',
        '', '[Install]', 'WantedBy=default.target', ''].join('\n');
      await mkdir(directory, { recursive: true });
      await atomicPrivate(unitFile, unit);
      await checked(['daemon-reload']);
      await checked(['enable', label]);
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: true }));
    },
    async start(): Promise<void> {
      if (!await autostartEnabled(stateDir)) throw new Error('Agent Host login startup is disabled. Run autostart enable first.');
      await requireManager();
      await checked(['start', label]);
    },
    stop,
    async disable(): Promise<void> {
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: false }));
      if (await available()) {
        if (await installed()) await checked(['disable', label]);
        await stop();
        await rm(unitFile, { force: true });
        await checked(['daemon-reload']);
      } else {
        const link = join(directory, 'default.target.wants', label);
        try {
          if (resolve(dirname(link), await readlink(link)) === unitFile) await rm(link);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rm(unitFile, { force: true });
      }
    },
  };
}

function quote(value: string, command = false): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths and environment must not contain a control character.');
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${command ? escaped.replace(/\$/g, () => '$$') : escaped}"`;
}

function pathValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value) || /[\s\\]$/.test(value)) throw new Error('Service paths must not contain a control character or end in whitespace or a backslash.');
  return value.replace(/%/g, '%%');
}

async function systemctl(args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    execFile('systemctl', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') { resolveResult({ code: 127, stdout: '', stderr: 'systemctl is not installed.' }); return; }
      if (error && typeof error.code !== 'number') { reject(new Error('Could not run systemctl --user within its deadline.')); return; }
      resolveResult({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}
