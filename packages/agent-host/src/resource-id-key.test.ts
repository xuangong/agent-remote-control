import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

it('gives different Controllers different keys', async () => {
  expect(loadResourceIdKey(await location())).not.toBe(loadResourceIdKey(await location()));
});

it('creates the directory and leaves no staging file behind', async () => {
  const file = join(dirname(await location()), 'nested', 'resource-id.key');
  const key = loadResourceIdKey(file);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
  expect(await readdir(dirname(file))).toEqual(['resource-id.key']);
});

it('refuses to start, and leaves the file alone, when it holds something that is not a key', async () => {
  for (const content of ['not a key', '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)]) {
    const file = await location();
    await writeFile(file, content);
    expect(() => loadResourceIdKey(file), JSON.stringify(content)).toThrow(/does not hold a key/);
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(await readdir(dirname(file))).toEqual(['resource-id.key']);
  }
});

it('accepts a key without its trailing newline', async () => {
  const file = await location();
  const key = 'ab'.repeat(32);
  await writeFile(file, key);
  expect(loadResourceIdKey(file)).toBe(key);
});

it('tightens the permissions of a key file that is readable by others, without changing the key', async () => {
  const file = await location();
  const key = loadResourceIdKey(file);
  if (process.platform === 'win32') return;
  await chmod(file, 0o644);
  expect(loadResourceIdKey(file)).toBe(key);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('does not read a file it cannot open as a missing one', async () => {
  const file = await location();
  // A directory where the file belongs is neither missing nor a key.
  await mkdir(file);
  expect(() => loadResourceIdKey(file)).toThrow();
});
