import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { FileResourceIdIndex, RESOURCE_ID_INDEX_CAPACITY } from './resource-id-index-file.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const location = async () => { const root = await mkdtemp(join(tmpdir(), 'resource-id-index-')); roots.push(root); return join(root, 'resource-id-index.json'); };
const sha256 = 'ab'.repeat(32);
const entry = (n: number, agentId = 'agent-1') => ({ agentId, resourceId: `rid_${n}`, normalizedLocator: `file-${n}.png`, readLocator: `/work/file-${n}.png`, sha256 });

it('keeps what it was given across instances, in a private file that is replaced whole', async () => {
  const file = await location();
  const index = new FileResourceIdIndex(file);
  index.put(entry(1));
  index.flush();
  expect(new FileResourceIdIndex(file).get('agent-1', 'rid_1')).toEqual(entry(1));
  expect(await readdir(dirname(file))).toEqual(['resource-id-index.json']);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('writes by itself shortly after a change, so a crash loses little', async () => {
  const file = await location();
  new FileResourceIdIndex(file).put(entry(1));
  await expect.poll(async () => readFile(file, 'utf8').catch(() => ''), { timeout: 3000 }).toContain('rid_1');
});

it('is keyed by agent and id together', async () => {
  const index = new FileResourceIdIndex(await location());
  index.put(entry(1));
  expect(index.get('agent-2', 'rid_1')).toBeUndefined();
  expect(index.get('agent-1', 'rid_2')).toBeUndefined();
});

it('drops the least recently used entries beyond its capacity, and a read counts as a use', async () => {
  const file = await location();
  const index = new FileResourceIdIndex(file, 3);
  [1, 2, 3].forEach(n => index.put(entry(n)));
  expect(index.get('agent-1', 'rid_1')).toBeDefined();
  index.put(entry(4));
  expect(index.get('agent-1', 'rid_2')).toBeUndefined();
  expect([1, 3, 4].map(n => index.get('agent-1', `rid_${n}`) !== undefined)).toEqual([true, true, true]);
  index.flush();
  expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(3);
  // The file keeps the order of use, so a smaller index drops the entries used longest ago.
  const smaller = new FileResourceIdIndex(file, 2);
  expect([1, 3, 4].map(n => smaller.get('agent-1', `rid_${n}`) !== undefined)).toEqual([false, true, true]);
});

it('is bounded at ten thousand entries by default', async () => {
  expect(RESOURCE_ID_INDEX_CAPACITY).toBe(10_000);
  const index = new FileResourceIdIndex(await location());
  for (let n = 0; n < RESOURCE_ID_INDEX_CAPACITY + 5; n += 1) index.put(entry(n));
  expect(index.get('agent-1', 'rid_0')).toBeUndefined();
  expect(index.get('agent-1', `rid_${RESOURCE_ID_INDEX_CAPACITY + 4}`)).toBeDefined();
});

it('starts empty from a damaged file or one with entries it cannot use, and keeps the good entries', async () => {
  const file = await location();
  await writeFile(file, '{not json');
  expect(new FileResourceIdIndex(file).get('agent-1', 'rid_1')).toBeUndefined();
  await writeFile(file, JSON.stringify({ version: 1, entries: [entry(1), { ...entry(2), sha256: 'short' }, { agentId: 'agent-1' }, null] }));
  const index = new FileResourceIdIndex(file);
  expect(index.get('agent-1', 'rid_1')).toBeDefined();
  expect(index.get('agent-1', 'rid_2')).toBeUndefined();
  await writeFile(file, JSON.stringify({ version: 2, entries: [entry(1)] }));
  expect(new FileResourceIdIndex(file).get('agent-1', 'rid_1')).toBeUndefined();
});

it('writes nothing for an entry it already holds', async () => {
  const file = await location();
  const index = new FileResourceIdIndex(file);
  index.put(entry(1));
  index.flush();
  await rm(file);
  index.put(entry(1));
  index.flush();
  await expect(stat(file)).rejects.toThrow();
});
