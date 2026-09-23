import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createCodexDaemonControl } from './codex-daemon-control.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(restart: () => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'arc-daemon-control-')); roots.push(stateDir);
  const manager = createCodexDaemonControl({ stateDir, restart });
  return { stateDir, manager };
}
it('persists intent before dispatch and deduplicates concurrent and completed requests', async () => {
  let finish!: () => void; let calls = 0;
  const f = await setup(async () => {
    calls++;
    expect(JSON.parse(await readFile(join(f.stateDir, 'codex-daemon-operation.json'), 'utf8')).phase).toBe('restarting');
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const revision = (await f.manager.status()).revision;
  const input = { operationId: randomUUID(), revision };
  const [first, duplicate] = await Promise.all([f.manager.restart(input), f.manager.restart(input)]);
  expect(first).toMatchObject({ phase: 'restarting', operationId: input.operationId });
  expect(duplicate).toMatchObject({ operationId: input.operationId });
  await expect.poll(() => calls).toBe(1);
  await expect.poll(() => typeof finish).toBe('function');
  await expect(f.manager.restart({ operationId: randomUUID(), revision: first.revision })).rejects.toThrow(/progress/);
  finish();
  await expect.poll(async () => (await f.manager.status()).phase).toBe('ready');
  expect((await f.manager.restart(input)).phase).toBe('ready');
  expect(calls).toBe(1);
  await expect(f.manager.restart({ operationId: randomUUID(), revision })).rejects.toThrow(/changed/);
}, 10000);
it('keeps a completed outcome across Controller replacement', async () => {
  const f = await setup(async () => {});
  const input = { operationId: randomUUID(), revision: (await f.manager.status()).revision };
  await f.manager.restart(input);
  await expect.poll(async () => (await f.manager.status()).phase).toBe('ready');
  let calls = 0;
  const replacement = createCodexDaemonControl({ stateDir: f.stateDir, restart: async () => { calls++; } });
  expect((await replacement.restart(input)).phase).toBe('ready');
  expect(calls).toBe(0);
}, 10000);
it('reports interrupted intent as unknown after Controller replacement without replaying it', async () => {
  const f = await setup(() => new Promise(() => {}));
  const input = { operationId: randomUUID(), revision: (await f.manager.status()).revision };
  await f.manager.restart(input);
  let calls = 0;
  const replacement = createCodexDaemonControl({ stateDir: f.stateDir, restart: async () => { calls++; } });
  expect((await replacement.status()).phase).toBe('unknown');
  expect((await replacement.restart(input)).phase).toBe('unknown');
  expect(calls).toBe(0);
}, 10000);
it('reports failure without exposing native output or automatically retrying', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; throw new Error('secret-native-output'); });
  const input = { operationId: randomUUID(), revision: (await f.manager.status()).revision };
  await f.manager.restart(input);
  await expect.poll(async () => (await f.manager.status()).phase).toBe('failed');
  expect(JSON.stringify(await f.manager.restart(input))).not.toContain('secret-native-output');
  expect(calls).toBe(1);
}, 10000);
it('rejects malformed intents before dispatch', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; });
  for (const input of [{}, { operationId: 'bad', revision: randomUUID() }, { operationId: randomUUID(), revision: randomUUID(), command: 'stop' }]) {
    await expect(f.manager.restart(input)).rejects.toThrow();
  }
  expect(calls).toBe(0);
}, 10000);

it('never dispatches when storage is corrupt or intent cannot be persisted', async () => {
  let calls = 0;
  const corrupt = await setup(async () => { calls++; });
  await writeFile(join(corrupt.stateDir, 'codex-daemon-operation.json'), '{broken');
  await expect(corrupt.manager.status()).rejects.toThrow(/storage/);
  const f = await setup(async () => { calls++; });
  const revision = (await f.manager.status()).revision;
  const path = join(f.stateDir, 'codex-daemon-operation.json');
  await rm(path); await mkdir(path);
  await expect(f.manager.restart({ operationId: randomUUID(), revision })).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await readdir(f.stateDir)).toEqual(['codex-daemon-operation.json']);
  expect((await f.manager.status()).phase).toBe('idle');
}, 10000);
