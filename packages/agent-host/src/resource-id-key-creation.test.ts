import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// The creation path is raced and failed on purpose, so the file system calls it makes are the ones a test may interrupt.
const interruptions = vi.hoisted(() => ({ beforeLink: undefined as undefined | ((target: string) => void), chmodFails: false, writes: [] as string[] }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    linkSync: (existing: string, target: string) => { interruptions.beforeLink?.(target); return actual.linkSync(existing, target); },
    chmodSync: (path: string, mode: number) => { if (interruptions.chmodFails) throw Object.assign(new Error('Not permitted.'), { code: 'EPERM' }); return actual.chmodSync(path, mode); },
    openSync: (path: string, flags: string, mode?: number) => { if (typeof flags === 'string' && flags.includes('w')) interruptions.writes.push(String(path)); return actual.openSync(path, flags, mode); },
  };
});

const { loadResourceIdKey } = await import('./resource-id-key.js');

const roots: string[] = [];
afterEach(async () => {
  interruptions.beforeLink = undefined; interruptions.chmodFails = false; interruptions.writes.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const location = async () => { const root = await mkdtemp(join(tmpdir(), 'resource-id-key-')); roots.push(root); return join(root, 'resource-id.key'); };

it('writes the key to a staging file and links it into place, never writing the final path itself', async () => {
  const file = await location();
  const key = loadResourceIdKey(file);
  expect(interruptions.writes).toHaveLength(1);
  expect(interruptions.writes[0]).not.toBe(file);
  expect(interruptions.writes[0]).toMatch(/\.tmp$/);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
});

it('adopts the key of a Controller that created the file first, and leaves nothing behind', async () => {
  const file = await location();
  const winner = 'cd'.repeat(32);
  interruptions.beforeLink = target => { interruptions.beforeLink = undefined; writeFileSync(target, `${winner}\n`); };
  expect(loadResourceIdKey(file)).toBe(winner);
  expect(await readFile(file, 'utf8')).toBe(`${winner}\n`);
  expect(await readdir(dirname(file))).toEqual(['resource-id.key']);
});

it('stops with an error, without a key of its own, when the file that won is not a key', async () => {
  const file = await location();
  interruptions.beforeLink = target => { interruptions.beforeLink = undefined; writeFileSync(target, 'garbage'); };
  expect(() => loadResourceIdKey(file)).toThrow(/does not hold a key/);
  expect(await readFile(file, 'utf8')).toBe('garbage');
  expect(await readdir(dirname(file))).toEqual(['resource-id.key']);
});

it('keeps the key when its permissions cannot be tightened', async () => {
  const file = await location();
  const key = loadResourceIdKey(file);
  interruptions.chmodFails = true;
  expect(loadResourceIdKey(file)).toBe(key);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
});

it('creates a key even when its permissions cannot be tightened', async () => {
  const file = await location();
  interruptions.chmodFails = true;
  expect(loadResourceIdKey(file)).toMatch(/^[0-9a-f]{64}$/);
});
