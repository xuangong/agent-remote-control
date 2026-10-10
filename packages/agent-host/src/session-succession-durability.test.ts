import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionCoordinator } from './session-succession.js';
import { LocalSuccessionPreparation } from './local-succession-preparation.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(fs.open).mockReset(); const original = await vi.importActual<typeof fs>('node:fs/promises'); vi.mocked(fs.open).mockImplementation(original.open); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
async function root() { const directory = await fs.mkdtemp(join(tmpdir(), 'succession-durable-')); roots.push(directory); return directory; }

test('role directory-sync uncertainty poisons reads and admission until restart readback', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockRejectedValue(new Error('directory durability lost'));
    return file;
  });
  await expect(store.begin(request)).rejects.toMatchObject({ code: 'succession_publication_unknown' });
  expect(() => store.read('role')).toThrow(/unknown|restart/i);
  expect(() => store.generation).toThrow(/unknown|restart/i);
  await expect(store.begin({ ...request, operationId: 'other' })).rejects.toThrow(/unknown|restart/i);
  vi.mocked(fs.open).mockImplementation(original.open);
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  expect(reopened.operation('op').phase).toBe('unknown');
});

test('native acceptance stores only the SDK disposition and admits proof without replacing old evidence', async () => {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 1 }, text: '[]', itemCount: 0 });
  await store.begin('op', { operationId: 'input', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'work' });
  const receipt = await store.settle('op', 'input', 'accepted', { disposition: 'queued', extra: 'x'.repeat(9 * 1024 * 1024) } as never);
  expect(receipt.inputAcceptance).toEqual({ disposition: 'queued' });
  await expect(store.reconcile('op', { operationId: 'input', roleRevision: 2, target: ref('B'), outcome: 'materialized', nativeEvidence: 'x'.repeat(9 * 1024 * 1024) })).rejects.toThrow(/capacity|limit/i);
  expect(store.delivery('input')).toEqual(receipt);
});

test('a pre-rename cancellation failure preserves the durable operation and source gate', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  await store.begin(request, true);
  const coordinator = new SessionSuccessionCoordinator(store, new LocalSuccessionPreparation('host', 'fixture', {} as never));
  vi.mocked(fs.open).mockRejectedValueOnce(new Error('cannot open temporary state'));
  await expect(coordinator.cancel('op')).rejects.toMatchObject({ code: 'succession_publication_rejected' });
  expect(store.operation('op').phase).toBe('preparing');
  expect(JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8')).roles[0].operations[0].phase).toBe('preparing');
  expect(() => coordinator.assertAdmission(ref('A'))).toThrow(/reserved/);
});

test('context directory-sync uncertainty poisons reads and settlement until restart readback', async () => {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach({ operationId: 'op', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 1 }, text: '[]', itemCount: 0 });
  const original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(file, 'sync').mockRejectedValue(new Error('directory durability lost'));
    return file;
  });
  await expect(store.begin('op', { operationId: 'input', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'work' })).rejects.toMatchObject({ code: 'succession_publication_unknown' });
  expect(() => store.read('op')).toThrow(/unknown|restart/i);
  await expect(store.settle('op', 'input', 'rejected')).rejects.toThrow(/unknown|restart/i);
  vi.mocked(fs.open).mockImplementation(original.open);
  const restored = new SessionSuccessionContextStore(directory); await restored.ready;
  expect(restored.delivery('input')!.state).toBe('unknown');
});
