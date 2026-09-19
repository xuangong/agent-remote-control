import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicPrivate, autostartEnabled } from './autostart-state.js';

interface LaunchctlResult { code: number; stdout: string; stderr: string }
interface LaunchdOptions {
  stateDir: string; home: string; nodePath: string; cliPath: string; cwd: string; path: string; uid: number;
  run?: (args: string[]) => Promise<LaunchctlResult>;
}
export interface AutostartStatus { enabled: boolean; installed: boolean; loaded: boolean; label: string; plist: string }

export function createLaunchdAutostart(options: LaunchdOptions) {
  const stateDir = resolve(options.stateDir);
  const label = `org.agent-remote-control.${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}`;
  const directory = join(options.home, 'Library', 'LaunchAgents');
  const plist = join(directory, `${label}.plist`);
  const domain = `gui/${options.uid}`;
  const target = `${domain}/${label}`;
  const run = options.run ?? launchctl;
  async function loaded(): Promise<boolean> {
    const result = await run(['print', target]);
    if (result.code === 0) return true;
    if (result.code === 112 || result.code === 113 || result.code === 3) return false;
    throw new Error(`Could not inspect Agent Host login startup: ${result.stderr.trim()}`);
  }
  async function checked(args: string[]): Promise<void> {
    const result = await run(args);
    if (result.code !== 0) throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  async function stop(): Promise<void> { if (await loaded()) await checked(['bootout', target]); }
  return {
    async status(): Promise<AutostartStatus> {
      return { enabled: await autostartEnabled(stateDir), installed: await exists(plist), loaded: await loaded(), label, plist };
    },
    async install(): Promise<void> {
      await mkdir(directory, { recursive: true });
      const env = { HOME: options.home, PATH: options.path, AGENT_HOST_STATE_DIR: stateDir, AGENT_HOST_LAUNCHD: '1' };
      const body = `<key>Label</key>${xmlString(label)}<key>ProgramArguments</key><array>${[resolve(options.nodePath), resolve(options.cliPath), '_serve'].map(xmlString).join('')}</array>`
        + '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer>'
        + `<key>WorkingDirectory</key>${xmlString(resolve(options.cwd))}<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key>${xmlString(value)}`).join('')}</dict>`
        + `<key>StandardOutPath</key>${xmlString(join(stateDir, 'agent-host.log'))}<key>StandardErrorPath</key>${xmlString(join(stateDir, 'agent-host.log'))}`;
      await atomicPrivate(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`);
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: true }));
    },
    async start(): Promise<void> {
      if (!await autostartEnabled(stateDir)) throw new Error('Agent Host login startup is disabled. Run autostart enable first.');
      await checked(['enable', target]);
      if (!await loaded()) await checked(['bootstrap', domain, plist]);
    },
    stop,
    async disable(): Promise<void> {
      await atomicPrivate(join(stateDir, 'autostart.json'), JSON.stringify({ enabled: false }));
      await rm(plist, { force: true });
      await stop();
    },
  };
}

function xmlString(value: string): string {
  return `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</string>`;
}
async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function launchctl(args: string[]): Promise<LaunchctlResult> {
  return new Promise((resolveResult, reject) => {
    execFile('/bin/launchctl', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(new Error('Could not run launchctl.')); return; }
      resolveResult({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}
