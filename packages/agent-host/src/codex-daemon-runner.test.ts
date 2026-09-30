import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { restartCodexDaemon, supportsCodexDaemonControl } from './codex-daemon-runner.js';
import { CodexDaemonRestartRejected } from './codex-daemon-restart-error.js';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = original.execFile.bind(original);
  Object.defineProperty(execute, promisify.custom, { value: promisify(original.execFile), configurable: true });
  return { ...original, execFile: execute };
});

it('runs restart then checks readiness with the selected Controller environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-daemon-runner-'));
  try {
    const cli = join(root, 'cli.cjs'), capture = join(root, 'calls.jsonl');
    await writeFile(cli, `require('fs').appendFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),state:process.env.AGENT_HOST_STATE_DIR,home:process.env.CODEX_HOME})+'\\n');`);
    await restartCodexDaemon({ stateDir: root, environment: { CODEX_HOME: join(root, 'home'), CAPTURE: capture }, cli });
    expect((await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { args: ['codex', 'daemon', 'restart'], state: root, home: join(root, 'home') },
      { args: ['codex', 'daemon', 'status'], state: root, home: join(root, 'home') },
    ]);
    await writeFile(cli, 'process.exit(1);');
    await expect(restartCodexDaemon({ stateDir: root, environment: {}, cli })).rejects.toThrow();
    await writeFile(cli, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
    await expect(restartCodexDaemon({ stateDir: root, environment: {}, cli, timeoutMs: 250 })).rejects.toThrow(/unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

it.each([
  { platform: 'darwin', action: 'restart', elapsedMs: 60000, outcome: 'pending' },
  { platform: 'linux', action: 'restart', elapsedMs: 840000, outcome: 'pending' },
  { platform: 'linux', action: 'restart', elapsedMs: 900000, outcome: 'unknown' },
  { platform: 'linux', action: 'status', elapsedMs: 15000, outcome: 'unknown' },
  { platform: 'win32', action: 'restart', elapsedMs: 45000, outcome: 'unknown' },
  { platform: 'linux', action: 'restart', elapsedMs: 25, timeoutMs: 250, outcome: 'pending' },
  { platform: 'linux', action: 'status', elapsedMs: 250, timeoutMs: 250, outcome: 'unknown' },
] as const)('bounds $platform $action at $elapsedMs ms ($outcome)', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'arc-daemon-deadline-'));
  const cli = join(root, 'cli.cjs'), capture = join(root, 'calls.jsonl');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const custom = Object.getOwnPropertyDescriptor(execFile, promisify.custom)!;
  const native = promisify(execFile);
  const timeScale = 'timeoutMs' in scenario ? 1 : scenario.action === 'status' ? 0.05 : 0.005;
  // Run real children and signals, shortening only the maintenance wall-clock budgets.
  Object.defineProperty(execFile, promisify.custom, { ...custom,
    value: (file: string, args: string[], options: ExecFileOptions) => native(file, args, { ...options, timeout: options.timeout! * timeScale }),
  });
  let outcome: 'pending' | 'ready' | 'unknown' = 'pending';
  let operation: Promise<void> | undefined;
  const calls = async (): Promise<Array<{ action: string; pid: number }>> => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const waitUntil = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!await condition()) {
      if (Date.now() >= deadline) throw new Error('The isolated daemon fixture did not settle.');
      await sleep(10);
    }
  };
  try {
    await writeFile(cli, `const fs=require('fs'),path=require('path');const action=process.argv[4];
fs.appendFileSync(process.env.CAPTURE,JSON.stringify({action,pid:process.pid})+'\\n');
setInterval(()=>{if(fs.existsSync(path.join(process.env.AGENT_HOST_STATE_DIR,'release-'+action)))process.exit(0);},10);`);
    Object.defineProperty(process, 'platform', { ...platform, value: scenario.platform });
    operation = restartCodexDaemon({ stateDir: root, environment: { CAPTURE: capture }, cli,
      ...('timeoutMs' in scenario ? { timeoutMs: scenario.timeoutMs } : {}) }).then(
      () => { outcome = 'ready'; },
      error => { expect(error.message).toMatch(/unknown/); outcome = 'unknown'; },
    );
    await waitUntil(async () => (await calls()).some(call => call.action === 'restart'));
    if (scenario.action === 'status') {
      await writeFile(join(root, 'release-restart'), '');
      await waitUntil(async () => (await calls()).some(call => call.action === 'status'));
    }
    await sleep(scenario.elapsedMs * timeScale);
    await sleep(30);
    expect(outcome).toBe(scenario.outcome);
    expect((await calls()).map(call => call.action)).toEqual(scenario.action === 'status' ? ['restart', 'status'] : ['restart']);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    await writeFile(join(root, 'release-restart'), '');
    await writeFile(join(root, 'release-status'), '');
    await operation;
    Object.defineProperty(execFile, promisify.custom, custom);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it.each([
  { action: 'restart', stderr: 'Refreshing the Codex daemon and updater requires Codex CLI 0.156.0 or newer. Update Codex before restarting through the Controller. No lifecycle command was dispatched.', safe: true },
  { action: 'restart', stderr: 'Cannot read valid Codex daemon settings. Repair CODEX_HOME/app-server-daemon/settings.json before restarting. No lifecycle command was dispatched.', safe: true },
  { action: 'restart', stderr: 'Cannot read valid Codex daemon settings. Repair CODEX_HOME/app-server-daemon/settings.json before restarting. No lifecycle command was dispatched.\nTOKEN=secret', safe: false },
  { action: 'restart', stderr: 'TOKEN=secret /private/home/settings.json', safe: false },
  { action: 'status', stderr: 'Cannot read valid Codex daemon settings. Repair CODEX_HOME/app-server-daemon/settings.json before restarting. No lifecycle command was dispatched.', safe: false },
] as const)('only exposes complete Controller-owned restart failures ($action, safe=$safe)', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'arc-daemon-rejection-'));
  try {
    const cli = join(root, 'cli.cjs');
    await writeFile(cli, `if(process.argv[4]===${JSON.stringify(scenario.action)}){process.stderr.write(${JSON.stringify(scenario.stderr)});process.exit(1);}`);
    const error = await restartCodexDaemon({ stateDir: root, environment: {}, cli }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(scenario.safe ? scenario.stderr : 'Codex daemon did not confirm restart and readiness.');
    expect(error instanceof CodexDaemonRestartRejected).toBe(scenario.safe);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

it('only allows lifecycle management for the configured shared default daemon', () => {
  expect(supportsCodexDaemonControl({})).toBe(true);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(false);
  expect(supportsCodexDaemonControl({ CODEX_HOME: '/codex', AGENT_HOST_CODEX_SOCKET: '/unrelated.sock' })).toBe(false);
  expect(supportsCodexDaemonControl({ CODEX_HOME: '/codex', AGENT_HOST_CODEX_SOCKET: '/codex/app-server-control/app-server-control.sock' }, 'linux')).toBe(true);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_SOCKET: '/custom.sock' }, 'win32')).toBe(false);
  expect(supportsCodexDaemonControl({ AGENT_HOST_CODEX_NOFILE: '8192' }, 'win32')).toBe(false);
  expect(supportsCodexDaemonControl({}, 'win32')).toBe(true);
}, 10000);
