import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { HOST_STATUS_PROCESS_LIMIT, type HostStatus } from '@orchardworks/agent-remote-protocol';

export interface ProcessRow { pid: number; ppid: number; /** Cores' worth: 1 is one full core. */ cpu: number; /** Resident bytes. */ memory: number; command: string }
type HostProcesses = NonNullable<HostStatus['processes']>;

/** `ps -axo pid=,ppid=,pcpu=,rss=,command=`: one process per line, RSS in kilobytes. */
export function parsePosixProcesses(output: string): ProcessRow[] {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]) / 100, memory: Number(match[4]) * 1024, command: match[5]! }] : [];
  });
}

/** PowerShell lines `pid,ppid,cpuPercent,workingSetBytes,name`. */
export function parseWindowsProcesses(output: string): ProcessRow[] {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+),(\d+),([\d.]*),(\d*),(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3] || 0) / 100, memory: Number(match[4] || 0), command: match[5]! }] : [];
  });
}

const PROVIDERS = ['claude', 'codex', 'opencode', 'copilot', 'pi'];
const INTERPRETERS = /^(node|python3?|bun|deno)(\.exe)?$/i;

function name(command: string): string {
  const [first = '', second = ''] = command.split(/\s+/);
  const program = basename(first).replace(/\.exe$/i, '');
  return INTERPRETERS.test(basename(first)) && second && !second.startsWith('-') ? basename(second) : program;
}

function describeTree(command: string): Pick<HostProcesses[number], 'kind' | 'label' | 'providerId'> {
  const label = name(command), lower = command.toLowerCase();
  const providerId = PROVIDERS.find(provider => label.toLowerCase().startsWith(provider));
  if (providerId === 'codex' && lower.includes('app-server')) return { kind: 'daemon', label, providerId };
  if (lower.includes('mcp') || (providerId === 'opencode' && /\bserve\b/.test(lower))) return { kind: 'server', label, ...(providerId ? { providerId } : {}) };
  return { kind: 'session', label, ...(providerId ? { providerId } : {}) };
}

/** The Controller itself, then each child it runs with its whole process tree summed, largest memory first. */
export function summarizeProcesses(rows: readonly ProcessRow[], controllerPid: number): HostProcesses {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...children.get(row.ppid) ?? [], row]);
  const tree = (root: ProcessRow, seen = new Set<number>()): { cpu: number; memory: number } => {
    seen.add(root.pid);
    return (children.get(root.pid) ?? []).filter(child => !seen.has(child.pid)).reduce((sum, child) => {
      const below = tree(child, seen);
      return { cpu: sum.cpu + below.cpu, memory: sum.memory + below.memory };
    }, { cpu: root.cpu, memory: root.memory });
  };
  const self = rows.find(row => row.pid === controllerPid);
  const entries: HostProcesses = [
    ...self ? [{ kind: 'controller' as const, label: 'controller', cpu: self.cpu, memory: self.memory }] : [],
    ...(children.get(controllerPid) ?? []).filter(child => child.pid !== controllerPid).map(child => ({ ...describeTree(child.command), ...tree(child) })),
  ];
  return entries.sort((a, b) => b.memory - a.memory).slice(0, HOST_STATUS_PROCESS_LIMIT);
}

const WINDOWS_SCRIPT = '$c=@{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | % { $c[[int]$_.IDProcess]=$_.PercentProcessorTime }; '
  + 'Get-CimInstance Win32_Process | % { "$($_.ProcessId),$($_.ParentProcessId),$($c[[int]$_.ProcessId]),$($_.WorkingSetSize),$($_.Name)" }';
const execute = promisify(execFile);

export interface HostProcessSources {
  platform?: NodeJS.Platform;
  /** The Controller's own process id. */
  pid?: number;
  run?(command: string, args: readonly string[]): Promise<string>;
}

/** Reads the process list with one bounded command; a platform or failure it cannot read yields nothing. */
export function createHostProcessReader(sources: HostProcessSources = {}) {
  const platform = sources.platform ?? process.platform, pid = sources.pid ?? process.pid;
  const run = sources.run ?? (async (command: string, args: readonly string[]) => (await execute(command, [...args], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })).stdout);
  return {
    async read(): Promise<HostProcesses | undefined> {
      try {
        if (platform === 'darwin' || platform === 'linux') return summarizeProcesses(parsePosixProcesses(await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='])), pid);
        if (platform === 'win32') return summarizeProcesses(parseWindowsProcesses(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT])), pid);
      } catch { /* A process list that cannot be read leaves processes out of the status. */ }
      return undefined;
    },
  };
}
