// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openGatewayState } from './gateway-state.js';
const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function path() { const directory = mkdtempSync(join(tmpdir(), 'relay-state-')); directories.push(directory); return join(directory, 'state.json'); }
it('atomically restores private state and detects tampering or a different authority scope', () => {
  const file = path(); const state = openGatewayState<{ value: number }>(file, 'secret', 'origin');
  state.save({ value: 1 }); state.save({ value: 2 }); state.close();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const restored = openGatewayState<{ value: number }>(file, 'secret', 'origin'); expect(restored.initial).toEqual({ value: 2 }); restored.close();
  expect(() => openGatewayState(file, 'other-secret', 'origin')).toThrow('does not match');
  const content = JSON.parse(readFileSync(file, 'utf8')); content.payload = '{"value":3}'; writeFileSync(file, JSON.stringify(content));
  expect(() => openGatewayState(file, 'secret', 'origin')).toThrow('does not match');
});
it('ignores stale PID and recovery metadata while retaining one lock inode for live exclusion', () => {
  const file = path();
  writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, id: 'old-container-owner' }));
  writeFileSync(file + '.lock.recovery', '');
  const inode = statSync(file + '.lock').ino;
  const first = openGatewayState(file, 'secret', 'origin');
  try { expect(() => openGatewayState(file, 'secret', 'origin')).toThrow('Another Relay'); }
  finally { first.close(); }
  expect(statSync(file + '.lock').ino).toBe(inode);
  const next = openGatewayState(file, 'secret', 'origin'); next.close();
  expect(statSync(file + '.lock').ino).toBe(inode);
}, 10000);

function writer(file: string) {
  const module = new URL('./gateway-state.ts', import.meta.url).href;
  const source = `import { openGatewayState } from ${JSON.stringify(module)};
    try {
      const state = openGatewayState(process.env.ARC_LOCK_TEST_FILE, 'secret', 'origin');
      await state.commit({ value: 7 });
      process.send({ acquired: true });
      setInterval(() => {}, 1000);
    } catch (error) { process.send({ acquired: false, error: error.message }); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    env: { ...process.env, ARC_LOCK_TEST_FILE: file }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  const ready = new Promise<{ acquired: boolean; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Writer startup deadline exceeded')); }, 3000);
    child.once('message', value => { clearTimeout(timer); resolve(value as { acquired: boolean; error?: string }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Writer exited before reporting: ${code}`)); });
  });
  return { child, ready };
}

it('keeps competing real processes exclusive and restores committed state after SIGKILL', async () => {
  const file = path(); const candidates = [writer(file), writer(file)];
  const results = await Promise.all(candidates.map(value => value.ready));
  expect(results.filter(value => value.acquired)).toHaveLength(1);
  expect(results.find(value => !value.acquired)?.error).toContain('Another Relay');
  const owner = candidates[results.findIndex(value => value.acquired)]!.child;
  expect(() => openGatewayState(file, 'secret', 'origin')).toThrow('Another Relay');
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  const restored = openGatewayState<{ value: number }>(file, 'secret', 'origin');
  try { expect(restored.initial).toEqual({ value: 7 }); }
  finally { restored.close(); }
  const restarted = writer(file); expect((await restarted.ready).acquired).toBe(true);
}, 10000);
