import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { SuccessionAssociationFreeze, SuccessionParticipant } from '@orchardworks/agent-remote-protocol';
import { SessionSuccessionStore } from './session-succession-store.js';
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); }, 5000);
const time = '2026-10-10T00:00:00.000Z';
const max = '\ud800'.repeat(512);
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const unknownRef = { controllerId: max, providerId: max, nativeSessionId: max };
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A'), targetProviderId: 'fixture' };
const capture = { epoch: 'epoch', seq: 9, capturedAt: time };
const freeze = (maxProjectionBytes: number): SuccessionAssociationFreeze => ({ version: 2, maxProjectionBytes, token: 'token', authority: { version: 1, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'host', request, associationRevision: 0, lineage: [ref('A')], relations: [] });
async function fixture() {
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(time);
  const directory = await mkdtemp(join(tmpdir(), 'arc-projection-bound-')); directories.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready;
  const role = { id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: '中\\"/workspace' } };
  await store.createRole(role);
  return { directory, store, role };
}
function ceiling(role: Awaited<ReturnType<typeof fixture>>['role'], participants: SuccessionParticipant[], associationRevision = 1, knownCapture = { epoch: max, seq: Number.MAX_SAFE_INTEGER, capturedAt: max }) {
  const prepared = { ...request, to: unknownRef, workspace: role.workspace, associationRevision, participants, capture: knownCapture };
  return Buffer.byteLength(JSON.stringify({ version: 1, role: { ...role, current: unknownRef, revision: 2 }, receipt: { ...request, phase: 'committed', startedAt: time, updatedAt: max, to: unknownRef, prepared, failureCode: max, committedRevision: 2 } }), 'utf8');
}

test('whole staged projection exact fit admits many participants and one byte short publishes nothing', async () => {
  const f = await fixture();
  const participants = Array.from({ length: 200 }, (_, index) => ({ relationId: `r-${index}`, kind: 'tpm' as const, before: ref(`r-${index}`), after: ref(`r-${index}`) }));
  const bytes = ceiling(f.role, participants);
  await expect(f.store.beginEnrolled(freeze(bytes - 1), participants, f.store.generation, true)).rejects.toMatchObject({ code: 'succession_projection_capacity_exceeded' });
  expect(f.store.read('role')).toMatchObject({ associationRevision: 0, participants: [], operations: [] });
  expect(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).roles[0].enrollments).toBeUndefined();
  await f.store.beginEnrolled(freeze(bytes), participants, f.store.generation, true);
  expect(f.store.read('role')).toMatchObject({ associationRevision: 1, participants });
  await expect(f.store.beginEnrolled(freeze(bytes + 1), [], f.store.generation, true)).rejects.toThrow(/receipt conflict/);
  await f.store.beginEnrolled(freeze(bytes), [], f.store.generation, true);
  expect(f.store.read('role').participants).toEqual(participants);
}, 10000);

test('the projection bound includes an association revision growing from nine to ten', async () => {
  const f = await fixture();
  for (let revision = 0; revision < 9; revision++) {
    const target = ref(`reader-${revision}`);
    await f.store.setParticipants('role', 1, revision, [{ relationId: `r-${revision}`, kind: 'tpm', before: target, after: target }]);
  }
  const bytes = ceiling(f.role, [], 10);
  expect(bytes).toBe(ceiling(f.role, [], 9) + 1);
  await expect(f.store.beginEnrolled(freeze(bytes - 1), [], f.store.generation, true)).rejects.toMatchObject({ code: 'succession_projection_capacity_exceeded' });
  expect(f.store.read('role')).toMatchObject({ associationRevision: 9, operations: [] });
  await f.store.beginEnrolled(freeze(bytes), [], f.store.generation, true);
  expect(f.store.read('role')).toMatchObject({ associationRevision: 10, participants: [] });
}, 10000);

test('maximal JSON escaping and optional recovery fields fit the frozen bound', async () => {
  const f = await fixture(), participants = [{ relationId: max, kind: 'tpm' as const, before: ref(max), after: ref(max) }];
  const bytes = ceiling(f.role, participants), receipt = freeze(bytes);
  await f.store.beginEnrolled(receipt, participants, f.store.generation, true);
  const largestCapture = { epoch: max, seq: Number.MAX_SAFE_INTEGER, capturedAt: max };
  await f.store.savePreparation('op', largestCapture); await f.store.startCreation('op');
  const to = ref(max); await f.store.saveCandidate('op', to);
  await f.store.settlePreparation('op', 'unknown', max); await f.store.revalidateCandidate('op');
  const state = f.store.read('role');
  await f.store.advance('op', 'transferring', { phase: 'ready', prepared: { ...request, to, workspace: state.role.workspace, associationRevision: 1, participants, capture: largestCapture } });
  const record = await f.store.commit('op');
  expect(record).toMatchObject({ phase: 'committed', failureCode: max }); expect(record.resumePhase).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify({ version: 1, role: f.store.read('role').role, receipt: record }), 'utf8')).toBeLessThanOrEqual(bytes);
}, 10000);

test('saved capture tightens the startCreation check and restart retains the exact v2 ceiling', async () => {
  const f = await fixture(), bytes = ceiling(f.role, []);
  await f.store.beginEnrolled(freeze(bytes), [], f.store.generation, true);
  await f.store.savePreparation('op', capture);
  // Corrupt allowance models a producer/budget defect; startCreation must recheck saved evidence.
  const path = join(f.directory, 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.roles[0].enrollments[0].maxProjectionBytes = ceiling(f.role, [], 1, capture) - 1;
  await writeFile(path, JSON.stringify(state));
  const reopened = new SessionSuccessionStore(f.directory); await reopened.ready;
  expect(reopened.read('role').enrollments![0]).toMatchObject({ version: 2, maxProjectionBytes: state.roles[0].enrollments[0].maxProjectionBytes });
  expect(reopened.progress('op')!.stage).toBe('not-started');
  await reopened.advance('op', 'unknown', { phase: 'preparing' });
  await expect(reopened.startCreation('op')).rejects.toMatchObject({ code: 'succession_projection_capacity_exceeded' });
  expect(reopened.progress('op')!.stage).toBe('not-started');
  state.roles[0].enrollments[0].maxProjectionBytes++;
  await writeFile(path, JSON.stringify(state));
  const fit = new SessionSuccessionStore(f.directory); await fit.ready;
  await fit.advance('op', 'unknown', { phase: 'preparing' });
  await fit.startCreation('op');
  expect(fit.progress('op')!.stage).toBe('create-started');
}, 10000);

test('v2 capacity rejection leaves an exact unenrolled cancellation and release path', async () => {
  const f = await fixture(), receipt = freeze(1);
  await expect(f.store.beginEnrolled(receipt, [], f.store.generation, true)).rejects.toMatchObject({ code: 'succession_projection_capacity_exceeded' });
  expect((await f.store.cancelUnenrolled(receipt)).phase).toBe('cancelled');
  await f.store.releaseEnrollment(receipt);
  expect(f.store.read('role').releasedEnrollments).toEqual(['token']);
}, 10000);

test('a postcommit invariant failure retains the entire committed decision across restart', async () => {
  const f = await fixture(); await f.store.beginEnrolled(freeze(ceiling(f.role, [])), [], f.store.generation, true);
  await f.store.savePreparation('op', capture); await f.store.startCreation('op'); await f.store.saveCandidate('op', ref('B'));
  await f.store.advance('op', 'transferring', { phase: 'ready', prepared: { ...request, to: ref('B'), workspace: f.role.workspace, associationRevision: 1, participants: [], capture } });
  const path = join(f.directory, 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.roles[0].enrollments[0].maxProjectionBytes = 1; await writeFile(path, JSON.stringify(state));
  const reopened = new SessionSuccessionStore(f.directory); await reopened.ready;
  await reopened.advance('op', 'unknown', { phase: 'ready' });
  await expect(reopened.commit('op')).rejects.toMatchObject({ code: 'succession_projection_invariant_failed' });
  expect(reopened.operation('op')).toMatchObject({ phase: 'committed', to: ref('B'), prepared: { capture, participants: [] } });
  expect(reopened.read('role').role).toMatchObject({ revision: 2, current: ref('B') });
  const restored = new SessionSuccessionStore(f.directory); await restored.ready;
  expect(restored.operation('op')).toEqual(reopened.operation('op'));
  await expect(restored.commit('op')).rejects.toMatchObject({ code: 'succession_projection_invariant_failed' });
}, 10000);

test('role-file v4 migrates exact legacy receipts without a ceiling and rejects disguised v2 allowances', async () => {
  const f = await fixture(); await f.store.beginEnrolled(freeze(ceiling(f.role, [])), [], f.store.generation, true);
  const path = join(f.directory, 'state.json'), original = JSON.parse(await readFile(path, 'utf8'));
  original.version=4;
  await writeFile(path,JSON.stringify(original));
  await expect(new SessionSuccessionStore(f.directory).ready).rejects.toThrow(/Legacy storage/);
  const legacy=original.roles[0].enrollments[0];legacy.version=1;delete legacy.maxProjectionBytes;
  const exact=JSON.stringify(legacy);await writeFile(path,JSON.stringify(original));
  const restored = new SessionSuccessionStore(f.directory);await restored.ready;
  expect(JSON.stringify(restored.read('role').enrollments![0])).toBe(exact);
  expect(restored.progress('op')!.stage).toBe('not-started');
  expect(restored.operation('op').phase).toBe('unknown');
  expect(JSON.parse(await readFile(path,'utf8')).version).toBe(8);
  expect(restored.read('role').enrollments![0]).not.toHaveProperty('maxProjectionBytes');
},10000);
