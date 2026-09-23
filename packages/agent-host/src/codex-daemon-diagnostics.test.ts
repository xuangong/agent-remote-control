import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readDaemonProcess, recordDaemonCommand } from './codex-daemon-diagnostics.js';
it.skipIf(process.platform === 'win32')('checks a real process environment without retaining values and rejects a stale PID record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-process-'));
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { env: { ...process.env, OPENAI_API_KEY: 'private-key-for-test' }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000 });
    await mkdir(join(root, 'app-server-daemon'));
    const path = join(root, 'app-server-daemon', 'app-server.pid');
    await writeFile(path, JSON.stringify({ pid: child.pid, processStartTime: stdout.trim() }));
    const snapshot = await readDaemonProcess(root, 'daemon');
    expect(snapshot).toMatchObject({ pid: child.pid, verification: 'matched', environment: { OPENAI_API_KEY: 'present' } });
    expect(JSON.stringify(snapshot)).not.toContain('private-key-for-test');
    await writeFile(path, JSON.stringify({ pid: child.pid, processStartTime: 'different process' }));
    expect(await readDaemonProcess(root, 'daemon')).toMatchObject({ verification: 'stale' });
  } finally { child.kill(); await once(child, 'exit'); await rm(root, { recursive: true, force: true }); }
}, 15000);
it('diagnostic storage failures never change command outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-log-failure-'));
  try {
    const file = join(root, 'not-a-directory'); await writeFile(file, '');
    const options = { stateDir: file, home: root, environment: {}, action: 'start' };
    expect(await recordDaemonCommand(options, async () => 4)).toBe(4);
    const original = new Error('original failure');
    await expect(recordDaemonCommand(options, async () => { throw original; })).rejects.toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
it('treats a malformed PID record as unavailable without blocking a native command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-malformed-'));
  try {
    await mkdir(join(root, 'app-server-daemon'));
    await writeFile(join(root, 'app-server-daemon', 'app-server.pid'), 'null');
    expect(await recordDaemonCommand({ stateDir: root, home: root, action: 'restart', environment: {} }, async () => 0)).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
