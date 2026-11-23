// The real-disk contract of the state files: fsync, atomic replacement and a clean directory. The stores' rules are tested over
// `memoryStateFiles` in their own unit files; this file proves each store round-trips through the real disk once.
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { diskStateFiles, SuccessionPublicationRejected, SuccessionPublicationUnknown } from './succession-persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const root = async () => { const directory = await mkdtemp(join(tmpdir(), 'arc-state-files-')); roots.push(directory); return directory; };
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });

test('publishes a file whole, privately, and leaves no temporary file behind', async () => {
  const directory = join(await root(), 'state'), files = diskStateFiles(directory);
  await files.open();
  expect(await files.read('a.json')).toBeUndefined();
  await files.publish('a.json', '{"n":1}'); await files.publish('a.json', '{"n":2}');
  expect(await files.read('a.json')).toBe('{"n":2}');
  expect(await files.list()).toEqual(['a.json']);
  expect((await stat(join(directory, 'a.json'))).mode & 0o777).toBe(process.platform === 'win32' ? (await stat(join(directory, 'a.json'))).mode & 0o777 : 0o600);
});

test('a failed rename is reported as an unknown outcome, a failed open as a rejection, and neither leaves a temporary file', async () => {
  const directory = await root(), files = diskStateFiles(directory);
  await mkdir(join(directory, 'taken.json'));
  await expect(files.publish('taken.json', '{}')).rejects.toBeInstanceOf(SuccessionPublicationUnknown);
  await expect(diskStateFiles(join(directory, 'missing')).publish('a.json', '{}')).rejects.toBeInstanceOf(SuccessionPublicationRejected);
  expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('the succession role store restores what it published', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).roles[0].role.id).toBe('role');
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  expect(reopened.read('role').role.current).toEqual(ref('A'));
});

test('the succession context store restores what it published', async () => {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach({ operationId: 'input', roleId: 'input', roleRevision: 2, source: ref('s'), target: ref('t'), boundary: { epoch: 'epoch', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z', text: '[]', itemCount: 0 });
  const reopened = new SessionSuccessionContextStore(directory); await reopened.ready;
  expect(reopened.read('input').state).toBe('pending');
});
