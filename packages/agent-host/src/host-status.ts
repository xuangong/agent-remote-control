import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stat, statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem, type CpuInfo } from 'node:os';
import { promisify } from 'node:util';
import { HOST_STATUS_DISK_LIMIT, type HostStatus, type SessionActivityState } from '@orchardworks/agent-remote-protocol';

type Usage = { total: number; used: number };

function field(text: string, name: string): number {
  const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text);
  if (!match) throw new Error(`Missing ${name}.`);
  return Number(match[1]);
}

/** macOS used memory as Activity Monitor counts it: app memory (anonymous minus purgeable), wired and compressed. */
export function macMemory(vmStat: string, total: number): Usage {
  const page = /page size of (\d+) bytes/.exec(vmStat);
  if (!page) throw new Error('Missing page size.');
  const pages = field(vmStat, 'Anonymous pages') - field(vmStat, 'Pages purgeable') + field(vmStat, 'Pages wired down') + field(vmStat, 'Pages occupied by compressor');
  return { total, used: Math.min(total, Math.max(0, pages * Number(page[1]))) };
}

/** Linux used memory: what is not available to new work without swapping. */
export function linuxMemory(meminfo: string): Usage {
  const total = field(meminfo, 'MemTotal') * 1024;
  return { total, used: Math.max(0, total - field(meminfo, 'MemAvailable') * 1024) };
}

/** The share of time all cores were busy between two samples. */
export function cpuUsage(previous: readonly CpuInfo[], next: readonly CpuInfo[]): number {
  let busy = 0, all = 0;
  next.forEach((core, index) => {
    const before = previous[index]?.times;
    if (!before) return;
    const elapsed = (Object.keys(core.times) as Array<keyof CpuInfo['times']>).reduce((sum, key) => sum + Math.max(0, core.times[key] - before[key]), 0);
    all += elapsed;
    busy += elapsed - Math.max(0, core.times.idle - before.idle);
  });
  return all > 0 ? Math.min(1, Math.max(0, busy / all)) : 0;
}

export interface HostStatusSources {
  /** The sessions this Controller has open, with the state each shows. */
  sessions(): readonly { state: SessionActivityState }[];
  /** Directories whose volumes matter: the home directory and the workspaces. */
  paths(): Promise<readonly string[]>;
  platform?: NodeJS.Platform;
  cpus?(): CpuInfo[];
  totalmem?(): number;
  freemem?(): number;
  run?(command: string, args: readonly string[]): Promise<string>;
  readFile?(path: string): Promise<string>;
  stat?(path: string): Promise<{ dev: number | bigint }>;
  statfs?(path: string): Promise<{ blocks: number | bigint; bsize: number | bigint; bavail: number | bigint }>;
  now?(): number;
  wait?(ms: number): Promise<void>;
}

/** A first read waits this long to measure CPU; later reads measure since the previous one while it is recent. */
const CPU_SAMPLE_MS = 250;
const CPU_SAMPLE_MAX_AGE_MS = 60_000;
const run = promisify(execFile);

export function createHostStatusReader(sources: HostStatusSources) {
  const platform = sources.platform ?? process.platform;
  const readCpus = sources.cpus ?? cpus, now = sources.now ?? Date.now;
  const wait = sources.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let previous: { at: number; cores: CpuInfo[] } | undefined;

  async function cpu(): Promise<HostStatus['cpu']> {
    if (!previous || now() - previous.at > CPU_SAMPLE_MAX_AGE_MS) {
      previous = { at: now(), cores: readCpus() };
      await wait(CPU_SAMPLE_MS);
    }
    const cores = readCpus();
    const usage = cpuUsage(previous.cores, cores);
    previous = { at: now(), cores };
    return cores.length ? { cores: cores.length, usage } : undefined;
  }
  async function memory(): Promise<Usage> {
    const total = (sources.totalmem ?? totalmem)();
    if (platform === 'darwin') return macMemory(await (sources.run ?? (async (command, args) => (await run(command, [...args], { timeout: 5_000 })).stdout))('vm_stat', []), total);
    if (platform === 'linux') return linuxMemory(await (sources.readFile ?? (path => readFile(path, 'utf8')))('/proc/meminfo'));
    return { total, used: Math.max(0, total - (sources.freemem ?? freemem)()) };
  }
  async function disks(): Promise<NonNullable<HostStatus['disks']>> {
    const seen = new Set<string>(), result: NonNullable<HostStatus['disks']> = [];
    for (const path of new Set(await sources.paths())) {
      if (result.length >= HOST_STATUS_DISK_LIMIT) break;
      try {
        const device = String((await (sources.stat ?? stat)(path)).dev);
        if (seen.has(device)) continue;
        const volume = await (sources.statfs ?? statfs)(path);
        const size = Number(volume.bsize), total = Number(volume.blocks) * size;
        seen.add(device);
        result.push({ path, total, used: Math.max(0, total - Number(volume.bavail) * size) });
      } catch { /* A directory that is gone or unreadable has no volume to report. */ }
    }
    return result;
  }
  const optional = async <T>(read: () => Promise<T>): Promise<T | undefined> => { try { return await read(); } catch { return undefined; } };

  return {
    async read(): Promise<HostStatus> {
      const sessions = { running: 0, waiting: 0, idle: 0, failed: 0 };
      for (const session of sources.sessions()) sessions[session.state] += 1;
      const [cpuStatus, memoryStatus, diskStatus] = await Promise.all([optional(cpu), optional(memory), optional(disks)]);
      return { sampledAt: now(), sessions,
        ...(cpuStatus ? { cpu: cpuStatus } : {}), ...(memoryStatus ? { memory: memoryStatus } : {}), ...(diskStatus?.length ? { disks: diskStatus } : {}) };
    },
  };
}

/** The directories a Controller reports volumes for: its user's home directory, then its workspaces. */
export async function hostStatusPaths(workspaces: () => Promise<readonly string[]>): Promise<string[]> {
  let listed: readonly string[] = [];
  try { listed = await workspaces(); } catch { /* The home directory still has a volume to report. */ }
  return [homedir(), ...listed];
}
