import { describe, expect, it } from 'vitest';
import { createHostProcessReader, parsePosixProcesses, parseWindowsProcesses, summarizeProcesses } from './host-processes.js';

const PS = `  PID  PPID  %CPU   RSS COMMAND
  100     1   1.5 20000 /usr/local/bin/node /opt/controller/host.js
  200   100  40.0 300000 /Users/x/.local/bin/claude --resume abc
  201   200  25.0 100000 /usr/bin/node /opt/mcp-server-filesystem/index.js
  300   100   0.5  50000 codex app-server --listen unix://
  400   100   2.0  70000 opencode serve --port 4096
  500   100  10.0  10000 /bin/zsh -l
  900     1  99.0 999999 /Applications/Unrelated.app/Contents/MacOS/Unrelated
`;
const WINDOWS = `100,4,0.015,20000000,node.exe
200,100,40,300000000,claude.exe
201,200,25,100000000,node.exe
900,4,99,999999999,Unrelated.exe
`;

describe('process listing', () => {
  it('parses ps output into rows with CPU as a fraction of one core and memory in bytes', () => {
    expect(parsePosixProcesses(PS)[1]).toEqual({ pid: 200, ppid: 100, cpu: 0.4, memory: 300_000 * 1024, command: '/Users/x/.local/bin/claude --resume abc' });
    expect(parsePosixProcesses(PS)).toHaveLength(7);
  });
  it('parses the Windows listing the same way', () => {
    expect(parseWindowsProcesses(WINDOWS)[1]).toEqual({ pid: 200, ppid: 100, cpu: 0.4, memory: 300_000_000, command: 'claude.exe' });
  });
  it('skips lines it cannot read', () => {
    expect(parsePosixProcesses('PID PPID\nnonsense\n  1 0 0.0 10 init\n')).toHaveLength(1);
  });
});

describe('summary of what the Controller runs', () => {
  const rows = parsePosixProcesses(PS);
  const summary = summarizeProcesses(rows, 100);
  it('sums each child tree, names it, and sorts by memory with the Controller itself', () => {
    expect(summary.map(({ kind, label }) => `${kind}:${label}`)).toEqual(['session:claude', 'server:opencode', 'daemon:codex', 'controller:controller', 'session:zsh']);
    expect(summary[0]).toMatchObject({ kind: 'session', label: 'claude', providerId: 'claude', memory: 400_000 * 1024 });
    expect(summary[0]!.cpu).toBeCloseTo(0.65);
  });
  it('leaves out processes that are not the Controller or its descendants', () => {
    expect(summary.some(entry => entry.label.includes('Unrelated'))).toBe(false);
  });
  it('lists at most 32 entries, the largest first', () => {
    const many = [{ pid: 1, ppid: 0, cpu: 0, memory: 1, command: 'node' },
      ...Array.from({ length: 40 }, (_, i) => ({ pid: 10 + i, ppid: 1, cpu: 0, memory: 100 + i, command: `tool${i}` }))];
    const listed = summarizeProcesses(many, 1);
    expect(listed).toHaveLength(32);
    expect(listed[0]!.memory).toBe(139);
  });
});

describe('process reader', () => {
  it('runs one command per read on each platform and returns nothing on a platform or failure it cannot read', async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: readonly string[]) => { calls.push([command, ...args]); return command === 'ps' ? PS : WINDOWS; };
    expect((await createHostProcessReader({ platform: 'darwin', pid: 100, run }).read())?.[0]?.label).toBe('claude');
    expect((await createHostProcessReader({ platform: 'linux', pid: 100, run }).read())?.[0]?.label).toBe('claude');
    expect((await createHostProcessReader({ platform: 'win32', pid: 100, run }).read())?.[0]?.label).toBe('claude');
    expect(calls.map(call => call[0])).toEqual(['ps', 'ps', 'powershell.exe']);
    expect(await createHostProcessReader({ platform: 'freebsd', pid: 100, run }).read()).toBeUndefined();
    expect(await createHostProcessReader({ platform: 'linux', pid: 100, run: async () => { throw new Error('timeout'); } }).read()).toBeUndefined();
  });
});
