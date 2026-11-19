import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { controllerCommandSuffix, ensureCommandLineSignedIn, journalStoreFiles, readInstance, restartInstance, stopController } from './instance-process.mjs';

const temporary: string[] = [];
const signedIn = JSON.stringify({ signedIn: true });
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const instanceIn = () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-instance-'));
  temporary.push(directory);
  return { name: 'x-1', directory, origin: 'http://localhost:1', source: '/work/checkout', state: 'running', workspace: join(directory, 'workspace') };
};
const runtime = { controllerPid: 4242, runnerPid: 4141 };

describe('stopping the Controller of the instance', () => {
  const stop = (mode: 'kill' | 'graceful', command: string, signals: Array<[number, string]> = []) => stopController(instanceIn(), {
    mode, ps: async () => command, signalProcess: (pid, signal) => { signals.push([pid, signal]); }, alive: () => false, readRuntimeFile: async () => runtime,
  });
  const own = `node ${controllerCommandSuffix('/work/checkout')}`;

  it('kills with SIGKILL and stops gracefully with SIGTERM, only the recorded Controller pid', async () => {
    const signals: Array<[number, string]> = [];
    expect((await stop('kill', own, signals)).runnerStopped).toBe(true);
    await stop('graceful', own, signals);
    expect(signals).toEqual([[4242, 'SIGKILL'], [4242, 'SIGTERM']]);
  });
  it('refuses a pid that is not this checkout\'s Controller and signals nothing', async () => {
    const signals: Array<[number, string]> = [];
    await expect(stop('kill', 'node /elsewhere/packages/agent-controller/dist/cli.js foreground', signals)).rejects.toThrow(/not this checkout's Controller/);
    expect(signals).toEqual([]);
  });
  it('refuses an unknown mode and an instance with no recorded processes', async () => {
    await expect(stopController(instanceIn(), { mode: 'term' as never })).rejects.toThrow(/Unknown/);
    await expect(stopController(instanceIn(), { mode: 'kill', readRuntimeFile: async () => undefined })).rejects.toThrow(/no recorded runner/);
  });
});

describe('restarting the instance', () => {
  it('removes only the journal store files of the instance when asked for an empty store', async () => {
    const instance = instanceIn();
    const store = join(instance.directory, 'relay', 'relay');
    mkdirSync(store, { recursive: true });
    for (const name of ['journals.sqlite', 'journals.sqlite-wal', 'accounts.json', 'journals.sqlite.bak']) writeFileSync(join(store, name), 'x');
    expect((await journalStoreFiles(instance)).map(file => file.split('/').at(-1)).sort()).toEqual(['journals.sqlite', 'journals.sqlite-wal']);
    const calls: string[][] = [];
    const outcome = await restartInstance(instance, { checkout: '/work/checkout', emptyStore: true, exec: async (file, args) => { if (file === 'pnpm') calls.push(args); return { stdout: signedIn }; } });
    expect(calls).toEqual([['--silent', 'local', 'down'], ['--silent', 'local', 'up', '--no-build']]);
    expect(outcome.removedFiles).toBe(2);
    expect(existsSync(join(store, 'accounts.json'))).toBe(true);
    expect(existsSync(join(store, 'journals.sqlite'))).toBe(false);
  });
  it('restarts from the existing build with journals on and no store removal by default', async () => {
    const seen: Array<{ args: string[]; journals: unknown }> = [];
    const outcome = await restartInstance(instanceIn(), { checkout: '/work/checkout', exec: async (file, args, options) => { if (file === 'pnpm') seen.push({ args, journals: (options?.env as Record<string, string>).ARC_LOCAL_JOURNALS }); return { stdout: signedIn }; } });
    expect(seen).toEqual([{ args: ['--silent', 'local', 'up', '--no-build'], journals: '1' }]);
    expect(outcome.removedFiles).toBe(0);
  });
  it('gives the Relay the journal limits it is asked for, and never one the caller\'s own environment holds', async () => {
    const limitsOf = async (options: object) => {
      process.env.ARC_LOCAL_JOURNAL_LIMITS = '{"sessionBytes":1}';
      let seen: unknown;
      try { await restartInstance(instanceIn(), { checkout: '/work/checkout', ...options, exec: async (file, _args, run) => { if (file === 'pnpm') seen = (run?.env as Record<string, string>).ARC_LOCAL_JOURNAL_LIMITS; return { stdout: signedIn }; } }); }
      finally { delete process.env.ARC_LOCAL_JOURNAL_LIMITS; }
      return seen;
    };
    expect(JSON.parse(await limitsOf({ journalLimits: { sessionBytes: 262144, hostBytes: 8388608 } }) as string)).toEqual({ sessionBytes: 262144, hostBytes: 8388608 });
    expect(await limitsOf({})).toBeUndefined();
  });
  it('signs the command line in again when a restart left it signed out, and gives up with an error after its attempts', async () => {
    const calls: string[][] = [];
    let state = false;
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[0] === 'login' && args[1] === 'status') return { stdout: JSON.stringify({ signedIn: state }) };
      if (args[0] === 'login') state = calls.filter(call => call[1] === 'login' && call.length === 2).length >= 2;
      return { stdout: '' };
    };
    const waits: number[] = [];
    expect(await ensureCommandLineSignedIn({ checkout: '/work/checkout', exec, waitMs: 7, wait: async ms => { waits.push(ms); } })).toBe('signed-in-again');
    expect(waits).toEqual([7]);
    const outcome = await restartInstance(instanceIn(), { checkout: '/work/checkout', exec, signInWaitMs: 0 });
    expect(outcome.commandLine).toBe('signed-in');
    await expect(ensureCommandLineSignedIn({ checkout: '/work/checkout', attempts: 2, wait: async () => {}, exec: async (_file, args) => ({ stdout: args[1] === 'status' ? '{"signedIn":false}' : '' }) })).rejects.toThrow(/stayed signed out after 2 sign-ins/);
  });
  it('reads the instance from the development command', async () => {
    const info = { instance: 'x-1', directory: '/state/x-1', origin: 'http://localhost:9', source: '/work/checkout', state: 'running' };
    expect(await readInstance({ exec: async () => ({ stdout: JSON.stringify(info) }) })).toMatchObject({ origin: 'http://localhost:9', workspace: '/state/x-1/workspace' });
  });
});
