import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicWriteFile, filesystemFor } from './index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'platform files & 中文 ')); roots.push(root); return root; }

it('replaces complete private contents in a directory with spaces and Unicode', async () => {
  const root = await fixture(), path = join(root, 'settings.json');
  await atomicWriteFile(path, JSON.stringify({ revision: 1 }));
  await atomicWriteFile(path, JSON.stringify({ revision: 2 }));
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ revision: 2 });
  expect(await readdir(root)).toEqual(['settings.json']);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  await filesystemFor().syncDirectory(root);
});

it('never exposes a partially written file to concurrent readers', async () => {
  const root = await fixture(), path = join(root, 'state.json');
  const body = 'x'.repeat(64 * 1024);
  await atomicWriteFile(path, JSON.stringify({ revision: 0, body }));
  const writer = (async () => { for (let revision = 1; revision <= 12; revision++) await atomicWriteFile(path, JSON.stringify({ revision, body })); })();
  const reader = (async () => {
    for (let i = 0; i < 30; i++) {
      const data = JSON.parse(await readFile(path, 'utf8'));
      expect(data.body).toBe(body); expect(data.revision).toBeGreaterThanOrEqual(0); expect(data.revision).toBeLessThanOrEqual(12);
    }
  })();
  await Promise.all([writer, reader]);
  expect(JSON.parse(await readFile(path, 'utf8')).revision).toBe(12);
});

it('cleans temporary files after a rejected replacement and retains existing contents', async () => {
  const root = await fixture(), target = join(root, 'occupied');
  await mkdir(target); await writeFile(join(target, 'retained'), 'original');
  await expect(atomicWriteFile(target, 'replacement')).rejects.toThrow();
  expect(await readFile(join(target, 'retained'), 'utf8')).toBe('original');
  expect(await readdir(root)).toEqual(['occupied']);
});

it('does not create a missing parent directory or swallow filesystem errors', async () => {
  const root = await fixture();
  await expect(atomicWriteFile(join(root, 'missing', 'state'), 'value')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(root)).toEqual([]);
});
