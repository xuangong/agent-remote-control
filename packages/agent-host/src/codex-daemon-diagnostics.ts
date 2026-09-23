import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readWindowsCodexDaemon } from '@orchardworks/agent-provider-codex';
import { createDiagnosticLog } from './diagnostic-log.js';

const variables = ['OPENAI_API_KEY', 'CODEX_GATEWAY_API_KEY', 'LC_ALL'] as const;
type Presence = 'present' | 'empty' | 'missing' | 'unknown';
export function environmentPresence(environment: NodeJS.ProcessEnv): Record<string, Presence> {
  return Object.fromEntries(variables.map(key => [key, environment[key] === undefined ? 'missing' : environment[key]!.trim() ? 'present' : 'empty']));
}

/** Dedicated append-only records, shared by CLI commands and the running Controller. */
export function createDaemonDiagnostics(stateDir: string) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'codex-daemon.log');
  const log = createDiagnosticLog({ path, sink: line => appendFileSync(path, line, { mode: 0o600 }) });
  return {
    write(event: string, fields: Record<string, unknown> = {}) {
      try { log.write(JSON.stringify({ timestamp: new Date().toISOString(), ...fields, event, source: 'controller', observerPid: process.pid })); } catch {}
    },
    dispose: () => log.dispose(),
  };
}

export interface DaemonProcessSnapshot {
  state: 'observed' | 'missing' | 'unavailable' | 'unsupported';
  pid?: number;
  startedAt?: string;
  verification?: 'matched' | 'stale' | 'unknown';
  environment?: Record<string, Presence>;
}

/** Inspect only a matching PID/start-time pair. Never persist process arguments or key values. */
export async function readDaemonProcess(home: string, role: 'daemon' | 'updater'): Promise<DaemonProcessSnapshot> {
  if (process.platform === 'win32') {
    if (role === 'updater') return { state: 'unsupported' };
    try {
      const record = await readWindowsCodexDaemon(home);
      if (!record) return { state: 'missing' };
      return Number.isSafeInteger(record.nativePid) && record.nativePid > 0
        ? { state: 'observed', pid: record.nativePid, verification: 'unknown', environment: Object.fromEntries(variables.map(key => [key, 'unknown' as const])) }
        : { state: 'unavailable' };
    } catch { return { state: 'unavailable' }; }
  }
  let record: { pid?: unknown; processStartTime?: unknown };
  try { record = JSON.parse(await readFile(join(home, 'app-server-daemon', role === 'daemon' ? 'app-server.pid' : 'app-server-updater.pid'), 'utf8')); }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }; }
  if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || typeof record.processStartTime !== 'string') return { state: 'unavailable' };
  const snapshot: DaemonProcessSnapshot = { state: 'observed', pid: Number(record.pid), startedAt: record.processStartTime, verification: 'unknown' };
  const options = { timeout: 1500, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
  try {
    const { stdout: started } = await promisify(execFile)('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], options);
    if (started.trim() !== record.processStartTime.trim()) return { ...snapshot, verification: 'stale' };
    let environment: NodeJS.ProcessEnv = {};
    if (process.platform === 'linux') {
      const raw = await readFile(`/proc/${record.pid}/environ`, 'utf8');
      for (const key of variables) {
        const entry = raw.split('\0').find(value => value.startsWith(`${key}=`));
        if (entry !== undefined) environment[key] = entry.slice(key.length + 1);
      }
    } else if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('/bin/ps', ['eww', '-p', String(record.pid), '-o', 'command='], options);
      for (const key of variables) {
        const value = new RegExp(`(?:^|\\s)${key}=([^\\s]*)`).exec(stdout);
        if (value) environment[key] = value[1];
      }
    } else return snapshot;
    const { stdout: after } = await promisify(execFile)('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], options);
    if (after.trim() !== started.trim()) return { ...snapshot, verification: 'stale' };
    return { ...snapshot, verification: 'matched', environment: environmentPresence(environment) };
  } catch { return snapshot; }
}

export async function recordDaemonCommand<T>(options: {
  stateDir: string; home: string; action: string; environment: NodeJS.ProcessEnv;
  origin?: 'cli' | 'website'; operationId?: string;
}, run: (onSpawn: (pid: number) => void) => Promise<T>): Promise<T> {
  let log: ReturnType<typeof createDaemonDiagnostics> | undefined;
  try { log = createDaemonDiagnostics(options.stateDir); } catch {}
  const fields = { operationId: options.operationId ?? randomUUID(), origin: options.origin ?? 'cli', action: options.action };
  log?.write('daemon_command_started', { ...fields, environment: environmentPresence(options.environment), before: await readDaemonProcess(options.home, 'daemon') });
  try {
    const result = await run(pid => log?.write('daemon_command_dispatched', { ...fields, targetPid: pid }));
    log?.write('daemon_command_completed', { ...fields, exitCode: typeof result === 'number' ? result : 0, after: await readDaemonProcess(options.home, 'daemon') });
    return result;
  } catch (error) {
    log?.write('daemon_command_failed', { ...fields, outcome: 'unknown', after: await readDaemonProcess(options.home, 'daemon') });
    throw error;
  } finally { log?.dispose(); }
}
