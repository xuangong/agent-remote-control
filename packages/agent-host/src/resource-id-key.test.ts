import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { loadResourceIdKey } from './resource-id-key.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const location = async () => { const root = await mkdtemp(join(tmpdir(), 'resource-id-key-')); roots.push(root); return join(root, 'resource-id.key'); };

it('creates a private random key the first time and returns the same key afterwards', async () => {
  const file = await location();
  const first = loadResourceIdKey(file);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(loadResourceIdKey(file)).toBe(first);
  expect(await readFile(file, 'utf8')).toBe(`${first}\n`);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('makes a new key, and keeps nothing of the old content, when the file holds something that is not a key', async () => {
  const file = await location();
  await writeFile(file, 'not a key');
  const key = loadResourceIdKey(file);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
});

it('gives different Controllers different keys', async () => {
  expect(loadResourceIdKey(await location())).not.toBe(loadResourceIdKey(await location()));
});

it('tightens the permissions of a key file that is readable by others, without changing the key', async () => {
  const file = await location();
  const key = loadResourceIdKey(file);
  if (process.platform === 'win32') return;
  await chmod(file, 0o644);
  expect(loadResourceIdKey(file)).toBe(key);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('creates the directory and leaves no staging file behind', async () => {
  const file = join(dirname(await location()), 'nested', 'resource-id.key');
  const key = loadResourceIdKey(file);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
  expect(await readdir(dirname(file))).toEqual(['resource-id.key']);
});
