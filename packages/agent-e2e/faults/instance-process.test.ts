import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { controllerCommandSuffix, journalStoreFiles, readInstance, restartInstance, stopController } from './instance-process.mjs';

const temporary: string[] = [];
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
    const outcome = await restartInstance(instance, { checkout: '/work/checkout', emptyStore: true, exec: async (_file, args) => { calls.push(args); return { stdout: '' }; } });
    expect(calls).toEqual([['--silent', 'local', 'down'], ['--silent', 'local', 'up', '--no-build']]);
    expect(outcome.removedFiles).toBe(2);
    expect(existsSync(join(store, 'accounts.json'))).toBe(true);
    expect(existsSync(join(store, 'journals.sqlite'))).toBe(false);
  });
  it('restarts from the existing build with journals on and no store removal by default', async () => {
    const seen: Array<{ args: string[]; journals: unknown }> = [];
    const outcome = await restartInstance(instanceIn(), { checkout: '/work/checkout', exec: async (_file, args, options) => { seen.push({ args, journals: (options?.env as Record<string, string>).ARC_LOCAL_JOURNALS }); return { stdout: '' }; } });
    expect(seen).toEqual([{ args: ['--silent', 'local', 'up', '--no-build'], journals: '1' }]);
    expect(outcome.removedFiles).toBe(0);
  });
  it('reads the instance from the development command', async () => {
    const info = { instance: 'x-1', directory: '/state/x-1', origin: 'http://localhost:9', source: '/work/checkout', state: 'running' };
    expect(await readInstance({ exec: async () => ({ stdout: JSON.stringify(info) }) })).toMatchObject({ origin: 'http://localhost:9', workspace: '/state/x-1/workspace' });
  });
});
