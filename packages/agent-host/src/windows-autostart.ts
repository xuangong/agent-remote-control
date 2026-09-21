import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { atomicPrivate, autostartEnabled } from './autostart-state.js';

interface WindowsAutostartOptions {
  stateDir: string; home: string; nodePath: string; cliPath: string; cwd: string; path: string;
  startupDirectory?: string;
}

/** Per-user login startup, without an elevated service or credentials in the launcher. */
export function createWindowsAutostart(options: WindowsAutostartOptions) {
  const stateDir = resolve(options.stateDir);
  const label = `agent-remote-controller-${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}`;
  const directory = options.startupDirectory ?? join(process.env.APPDATA ?? join(options.home, 'AppData/Roaming'),
    'Microsoft/Windows/Start Menu/Programs/Startup');
  const startupFile = join(directory, `${label}.vbs`);
  const environment = { AGENT_HOST_STATE_DIR: stateDir, AGENT_HOST_SUPERVISOR: 'windows', PATH: options.path };
  async function installed() {
    try { await readFile(startupFile); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async function state() {
    try { return JSON.parse(await readFile(join(stateDir, 'daemon.json'), 'utf8')) as { pid: number; token: string; socket: string; supervisor?: string }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async function request(action: 'status' | 'stop') {
    const saved = await state();
    if (!saved || saved.supervisor !== 'windows') return false;
    return new Promise<boolean>((done, reject) => {
      const socket = createConnection(saved.socket); let output = '';
      socket.setTimeout(5000, () => socket.destroy(new Error('Windows login daemon did not respond.')));
      socket.on('connect', () => socket.write(JSON.stringify({ token: saved.token, action }) + '\n'));
      socket.on('data', data => { output += data; });
      socket.on('error', error => {
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) done(false);
        else reject(error);
      });
      socket.on('close', () => {
        try { const response = JSON.parse(output); if (response.error) reject(new Error(response.error)); else done(true); }
        catch { done(false); }
      });
    });
  }
  return {
    async status() { return { enabled: await autostartEnabled(stateDir), installed: await installed(), loaded: await request('status'), startupFile }; },
    async install() {
      await mkdir(directory, { recursive: true });
      // Only the encoded script is passed to WScript.Run, so percent signs in user paths are literal.
      const script = [
        ...Object.entries(environment).map(([key, value]) => `$env:${key} = ${ps(value)}`),
        `$env:AGENT_HOST_LAUNCHD = $null`, `$env:AGENT_HOST_SERVER = $null`, `$env:AGENT_HOST_REMOTE_KEY = $null`,
        `Set-Location -LiteralPath ${ps(resolve(options.cwd))}`,
        `& ${ps(resolve(options.nodePath))} ${ps(resolve(options.cliPath))} _login`,
      ].join('\r\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const command = `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
      await atomicPrivate(startupFile, `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command.replace(/"/g, '""')}", 0, False\r\n`);
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: true }));
    },
    async start() {
      if (!await autostartEnabled(stateDir)) throw new Error('Agent Host login startup is disabled. Run autostart enable first.');
      const log = await open(join(stateDir, 'agent-host.log'), 'a', 0o600);
      try {
        const child = spawn(options.nodePath, [options.cliPath, '_serve'], { cwd: options.cwd,
          env: { ...process.env, ...environment, AGENT_HOST_SERVER: undefined, AGENT_HOST_REMOTE_KEY: undefined, AGENT_HOST_LAUNCHD: undefined },
          detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
        child.unref();
        return child.pid;
      } finally { await log.close(); }
    },
    async stop() { await request('stop'); },
    async disable() {
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: false }));
      await rm(startupFile, { force: true });
      await request('stop');
    },
  };
}

function ps(value: string) {
  if (/[\x00\r\n]/.test(value)) throw new Error('Windows startup settings must not contain control characters.');
  return `'${value.replace(/'/g, "''")}'`;
}
