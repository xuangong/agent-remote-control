import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveHostConnection, retainedHostEnvironment, type HostConnection } from './connection-config.js';

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

export async function autostartEnabled(stateDir: string): Promise<boolean> {
  try {
    const saved = JSON.parse(await readFile(join(stateDir, 'autostart.json'), 'utf8')) as { enabled?: unknown };
    if (typeof saved.enabled !== 'boolean') throw new Error();
    return saved.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new Error('Agent Host autostart preferences are invalid.');
  }
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

async function atomicPrivate(path: string, contents: string): Promise<void> {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.launchd-${randomUUID()}.tmp`);
  try { await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

interface PendingConnection { id: string; previous?: string; connection: HostConnection }
async function connectionRevision(stateDir: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(join(stateDir, 'connection.json'))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function prepareLaunchdConnection(stateDir: string, connection: HostConnection): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700);
  const pending: PendingConnection = { id: randomUUID(), previous: await connectionRevision(stateDir),
    connection: { serverUrl: connection.serverUrl, remoteKey: connection.remoteKey, environment: retainedHostEnvironment(connection.environment) } };
  await atomicPrivate(join(stateDir, 'launchd-start.json'), JSON.stringify(pending));
}

export async function resolveLaunchdConnection(stateDir: string, environment: NodeJS.ProcessEnv): Promise<{ connection: HostConnection; pendingId?: string }> {
  let pending: PendingConnection | undefined;
  try { pending = JSON.parse(await readFile(join(stateDir, 'launchd-start.json'), 'utf8')) as PendingConnection; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Private Agent Host launch settings are invalid.'); }
  if (pending && pending.previous === await connectionRevision(stateDir)) {
    if (!pending.id || !pending.connection?.serverUrl || !pending.connection.remoteKey || !pending.connection.environment)
      throw new Error('Private Agent Host launch settings are invalid.');
    return { pendingId: pending.id, connection: await resolveHostConnection(stateDir, { ...environment,
      ...retainedHostEnvironment(pending.connection.environment), AGENT_HOST_SERVER: pending.connection.serverUrl, AGENT_HOST_REMOTE_KEY: pending.connection.remoteKey }) };
  }
  return { connection: await resolveHostConnection(stateDir, environment) };
}

export async function clearLaunchdConnection(stateDir: string, pendingId: string | undefined): Promise<void> {
  if (!pendingId) return;
  const path = join(stateDir, 'launchd-start.json');
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as PendingConnection;
    if (saved.id === pendingId) await rm(path, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
