import { describe, expect, it } from 'vitest';
import type { CpuInfo } from 'node:os';
import { isHostStatus } from '@orchardworks/agent-remote-protocol';
import { cpuUsage, createHostStatusReader, linuxMemory, macMemory, type HostStatusSources } from './host-status.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5176.
Pages active:                                 323009.
Pages inactive:                               321960.
Pages wired down:                             281213.
Pages purgeable:                                1000.
File-backed pages:                            233033.
Anonymous pages:                              412083.
Pages stored in compressor:                  1088698.
Pages occupied by compressor:                 607556.
`;
const MEMINFO = `MemTotal:       16303428 kB
MemFree:          812344 kB
MemAvailable:    9876544 kB
Buffers:          123456 kB
`;
const times = (user: number, idle: number): CpuInfo => ({ model: 'cpu', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } });

describe('memory', () => {
  it('counts macOS memory as Activity Monitor does: app memory, wired and compressed, not reclaimable cache', () => {
    expect(macMemory(VM_STAT, 25_769_803_776)).toEqual({ total: 25_769_803_776, used: (412083 - 1000 + 281213 + 607556) * 16384 });
  });
  it('counts Linux memory as total minus available', () => {
    expect(linuxMemory(MEMINFO)).toEqual({ total: 16303428 * 1024, used: (16303428 - 9876544) * 1024 });
  });
  it('rejects output it cannot read rather than guessing', () => {
    expect(() => macMemory('nothing useful', 1)).toThrow();
    expect(() => linuxMemory('MemTotal: 10 kB')).toThrow();
  });
});

it('measures CPU usage between two samples across every core', () => {
  expect(cpuUsage([times(100, 900), times(100, 900)], [times(150, 950), times(200, 900)])).toBeCloseTo(150 / 200);
  expect(cpuUsage([times(1, 1)], [times(1, 1)])).toBe(0);
});

function sources(overrides: Partial<HostStatusSources> = {}): HostStatusSources & { waits: number[] } {
  const waits: number[] = [];
  let sample = 0;
  return {
    waits,
    sessions: () => [{ state: 'running' }, { state: 'running' }, { state: 'waiting' }, { state: 'idle' }],
    paths: async () => ['/Users/xian', '/Users/xian/projects', '/Volumes/Projects', '/missing'],
    platform: 'darwin',
    cpus: () => { sample += 1; return [times(100 * sample, 900 * sample), times(100 * sample, 900 * sample)]; },
    totalmem: () => 25_769_803_776,
    freemem: () => 0,
    run: async (command: string) => { if (command !== 'vm_stat') throw new Error('unexpected command'); return VM_STAT; },
    readFile: async () => { throw new Error('not on Linux'); },
    stat: async (path: string) => { if (path === '/missing') throw new Error('ENOENT'); return { dev: path.startsWith('/Volumes') ? 2 : 1 }; },
    statfs: async (path: string) => path.startsWith('/Volumes') ? { blocks: 1000, bsize: 4096, bavail: 600 } : { blocks: 500, bsize: 4096, bavail: 20 },
    now: () => 1_000,
    wait: async (ms: number) => { waits.push(ms); },
    ...overrides,
  };
}

describe('Host status reader', () => {
  it('reports open sessions by state, CPU, memory and each volume once', async () => {
    const input = sources();
    const status = await createHostStatusReader(input).read();
    expect(status).toEqual({
      sampledAt: 1_000,
      sessions: { running: 2, waiting: 1, idle: 1, failed: 0 },
      cpu: { cores: 2, usage: 0.1 },
      memory: macMemory(VM_STAT, 25_769_803_776),
      disks: [{ path: '/Users/xian', total: 500 * 4096, used: 480 * 4096 }, { path: '/Volumes/Projects', total: 1000 * 4096, used: 400 * 4096 }],
    });
    expect(isHostStatus(status)).toBe(true);
    expect(input.waits).toHaveLength(1);
  });

  it('measures CPU since the previous read when it is recent, without waiting again', async () => {
    let clock = 1_000;
    const input = sources({ now: () => clock });
    const reader = createHostStatusReader(input);
    await reader.read();
    clock += 5_000;
    await reader.read();
    expect(input.waits).toHaveLength(1);
  });

  it('leaves out a figure it cannot read and keeps the rest', async () => {
    const status = await createHostStatusReader(sources({ run: async () => { throw new Error('vm_stat missing'); }, paths: async () => { throw new Error('no workspaces'); } })).read();
    expect(status.memory).toBeUndefined();
    expect(status.disks).toBeUndefined();
    expect(status.cpu?.cores).toBe(2);
    expect(status.sessions.running).toBe(2);
  });

  it('reads Linux memory from /proc/meminfo and other systems from total and free memory', async () => {
    expect((await createHostStatusReader(sources({ platform: 'linux', readFile: async () => MEMINFO })).read()).memory).toEqual(linuxMemory(MEMINFO));
    expect((await createHostStatusReader(sources({ platform: 'win32', totalmem: () => 100, freemem: () => 30 })).read()).memory).toEqual({ total: 100, used: 70 });
  });
});
