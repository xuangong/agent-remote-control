import { mkdtemp, rm, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { type RelationChangeReservation } from '@orchardworks/agent-remote-protocol';
import { sourceParticipantId } from './source-participant.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSourceBindings } from './session-source-binding.js';
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const dirs: string[] = [];
afterEach(async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockReset(); vi.mocked(open).mockImplementation(original.open);
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});
const ref = (nativeSessionId: string, providerId = 'p') => ({ controllerId: 'controller', providerId, nativeSessionId });
const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-relation-change-')); dirs.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready;
  const workspace = { controllerId: 'controller', canonicalCwd: '/workspace' };
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace });
  const reader = ref('S');
  const initialBinding = new SessionSourceBindings(store, 'controller', 'p', Buffer.alloc(32, 42));
  const originalPage = await initialBinding.read(reader, ref('A'), {}, async () => ({ entries: [], nextCursor: 'page' }));
  const participant = { relationId: sourceParticipantId(reader, 'side'), kind: 'side' as const, before: reader, after: reader };
  const tpm = { relationId: 'tpm:work', kind: 'tpm' as const, before: ref('T'), after: ref('T') };
  const request = { roleId: 'role', operationId: 'succession', expectedRevision: 1, from: ref('A'), targetProviderId: 'other' };
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, authority, token: 'freeze', controllerId: 'controller', request, associationRevision: 0, lineage: [ref('A')], relations: [] };
  await store.beginEnrolled(freeze, [participant, tpm], store.generation);
  await store.advance('succession', 'preparing', { phase: 'quiescing', to: ref('A', 'other') });
  await store.advance('succession', 'quiescing', { phase: 'transferring' });
  await store.advance('succession', 'transferring', { phase: 'ready', prepared: { ...request, to: ref('A', 'other'), workspace, associationRevision: 1, participants: [participant, tpm], capture: { epoch: 'e', seq: 1, capturedAt: '2026-10-10T00:00:00.000Z' } } });
  await store.commit('succession'); await store.releaseEnrollment(freeze);
  const reservation: RelationChangeReservation = { version: 1, operationId: 'unlink', token: 'token', authority, hostId: 'authenticated-host', controllerId: 'controller', roleId: 'role', expectedRoleRevision: 2, origin: ref('A'), current: ref('A', 'other'), lineage: [ref('A'), ref('A', 'other')], associationRevision: 1, catalogRevision: 7, relationId: 'side', kind: 'side', readerRef: reader, sourceRef: ref('A'), expectedRelationRevision: 0, previousLinked: true, linked: false, previousMember: true, relations: [{ relationId: 'side', kind: 'side', readerRef: reader, sourceRef: ref('A'), linked: true, revision: 0 }] };
  const binding = new SessionSourceBindings(store, 'controller', 'p', Buffer.alloc(32, 42), { readRouted: async source => ({ entries: [{ id: 'entry', role: 'assistant', text: source.providerId }], nextCursor: 'next' }), authorizeRead: async () => {} });
  return { store, directory, reader, participant, tpm, reservation, binding, originalPage };
}
test('durably gates one reader and applies only its stable participant with exact replay', async () => {
  const f = await fixture(), before = f.store.read('role');
  const old = await f.binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }));
  const reserved = await f.store.reserveRelationChange(f.reservation, f.store.generation);
  await expect(f.binding.read(f.reader, ref('A'), { cursor: old.nextCursor }, async () => ({ entries: [] }))).rejects.toThrow(/pending|reserved/);
  const restored = new SessionSuccessionStore(f.directory); await restored.ready;
  expect(restored.readerAssociationState(f.reader).pending).toBe(true);
  expect(await restored.reserveRelationChange(f.reservation, -1)).toEqual(reserved);
  const applied = await restored.applyRelationChange(f.reservation);
  expect(await restored.applyRelationChange(f.reservation)).toEqual(applied);
  expect(restored.read('role').participants).toEqual([f.tpm]);
  expect(restored.read('role').operations).toEqual(before.operations);
  await restored.releaseRelationChange(f.reservation, applied.associationRevision);
  await restored.releaseRelationChange(f.reservation, applied.associationRevision);
  const binding = new SessionSourceBindings(restored, 'controller', 'p', Buffer.alloc(32, 42));
  await expect(binding.read(f.reader, ref('A'), { cursor: old.nextCursor }, async () => ({ entries: [] }))).rejects.toThrow(/authorized/);
  expect((await binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }))).sourceRef).toEqual(ref('A'));
});
test('rejects changed identity and stale clocks and excludes creation or succession until release', async () => {
  const f = await fixture();
  await expect(f.store.reserveRelationChange({ ...f.reservation, associationRevision: 0 }, f.store.generation)).rejects.toThrow(/revision/);
  await f.store.reserveRelationChange(f.reservation, f.store.generation);
  await expect(f.store.reserveRelationChange({ ...f.reservation, linked: true }, f.store.generation)).rejects.toThrow(/identity/);
  await expect(f.store.admitAssociation('create', 'fingerprint', ref('A', 'other'))).rejects.toThrow(/reserved/);
  await expect(f.store.releaseRelationChange(f.reservation, 1)).rejects.toThrow(/applied/);
  await expect(f.store.reserveRelationChange({ ...f.reservation, operationId: 'competing', token: 'another' }, f.store.generation)).rejects.toThrow(/reserved/);
});
test('an unlink begun while history awaits prevents successor disclosure', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const binding = new SessionSourceBindings(f.store, 'controller', 'p', Buffer.alloc(32, 42), { authorizeRead: async () => {}, readRouted: async () => { entered(); await waiting; return { entries: [{ id: 'secret', role: 'assistant', text: 'B secret' }] }; } });
  const reading = binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }));
  await reached; await f.store.reserveRelationChange(f.reservation, f.store.generation); release();
  await expect(reading).rejects.toThrow(/pending|reserved/);
});
test('unlink preserves a signed native A cursor and relink restores the full current provider', async () => {
  const f = await fixture();
  const fixed = new SessionSourceBindings(f.store, 'controller', 'p', Buffer.alloc(32, 42));
  const cursor = await fixed.read(ref('unlinked'), ref('A'), {}, async () => ({ entries: [], nextCursor: 'page' }));
  // A cursor signed for the actual reader before any role overlay remains its native fixed grant.
  const native = await f.binding.read(f.reader, ref('A'), { sourceContext: undefined }, async () => ({ entries: [] }));
  expect(native.sourceRef).toEqual(ref('A', 'other'));
  await f.store.reserveRelationChange(f.reservation, f.store.generation);
  const applied = await f.store.applyRelationChange(f.reservation); await f.store.releaseRelationChange(f.reservation, applied.associationRevision);
  const a = await f.binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }));
  expect(a.sourceRef).toEqual(ref('A'));
  expect((await f.binding.read(f.reader, ref('A'), { cursor: f.originalPage.nextCursor }, async () => ({ entries: [] }))).sourceRef).toEqual(ref('A'));
  expect((await f.binding.read(f.reader, ref('A'), { sourceContext: a.sourceContext }, async () => ({ entries: [] }))).sourceRef).toEqual(ref('A'));
  await expect(f.binding.read(f.reader, ref('A'), { cursor: cursor.nextCursor }, async () => ({ entries: [] }))).rejects.toThrow(/another read/);
  const relink = { ...f.reservation, operationId: 'relink', token: 'relink-token', associationRevision: 2, catalogRevision: 10, expectedRelationRevision: 1, previousLinked: false, previousMember: false, linked: true, relations: f.reservation.relations.map(row => ({ ...row, linked: false, revision: 1 })) };
  await f.store.reserveRelationChange(relink, f.store.generation);
  const joined = await f.store.applyRelationChange(relink); await f.store.releaseRelationChange(relink, joined.associationRevision);
  expect(f.store.read('role').participants).toEqual([f.tpm, f.participant]);
  expect((await f.binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }))).sourceRef).toEqual(ref('A', 'other'));
});

test('failed reservation publication leaves the overlay and read gate unchanged', async () => {
  const f = await fixture(), path = join(f.directory, 'state.json'), saved = await readFile(path, 'utf8');
  vi.mocked(open).mockRejectedValueOnce(new Error('Cannot create temporary state file'));
  await expect(f.store.reserveRelationChange(f.reservation, f.store.generation)).rejects.toMatchObject({ code: 'succession_publication_rejected' });
  expect(f.store.readerAssociationState(f.reader).pending).toBe(false);
  expect(f.store.relationChange('unlink')).toBeUndefined();
  expect(f.store.read('role').participants).toEqual([f.participant, f.tpm]);
  expect(await readFile(path, 'utf8')).toBe(saved);
});
test('reservation while authorization awaits closes the native dispatch boundary', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void, dispatched = false;
  const reached = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const binding = new SessionSourceBindings(f.store, 'controller', 'p', Buffer.alloc(32, 42), { authorizeRead: async () => { entered(); await waiting; }, readRouted: async () => { dispatched = true; return { entries: [] }; } });
  const reading = binding.read(f.reader, ref('A'), {}, async () => ({ entries: [] }));
  await reached; await f.store.reserveRelationChange(f.reservation, f.store.generation); release();
  await expect(reading).rejects.toThrow(/pending|reserved/); expect(dispatched).toBe(false);
});
