import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { jsonBytes, SUCCESSION_STORE_BYTES } from './succession-persistence.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
const capture = { epoch: 'epoch', seq: 1, capturedAt: '2026-10-10T00:00:00Z' };
async function root() { const directory = await mkdtemp(join(tmpdir(), 'succession-capacity-')); roots.push(directory); return directory; }
const attachment = (id: string, text = '[]') => ({ operationId: id, roleId: id, roleRevision: 2, source: ref(`source-${id}`), target: ref(`target-${id}`), boundary: { epoch: 'epoch', seq: 1 }, capturedAt: capture.capturedAt, text, itemCount: JSON.parse(text).length });

function fillRoleState(state: any, desiredBytes: number) {
  while (jsonBytes(state) < desiredBytes - 16500) {
    const index = state.associationResults.length;
    state.associationResults.push({ id: `unrelated-${index}`, fingerprint: 'fingerprint', scope: 'x'.repeat(16384), operationId: `unrelated-${index}`, source: ref('other-A'), reader: ref('other-B') });
  }
  const index = state.associationResults.length;
  state.associationResults.push({ id: `unrelated-${index}`, fingerprint: 'fingerprint', scope: 'x', operationId: `unrelated-${index}`, source: ref('other-A'), reader: ref('other-B') });
  state.associationResults.at(-1).scope += 'x'.repeat(desiredBytes - jsonBytes(state));
}
async function contextNearCapacity(freeBytes: number) {
  const directory = await root(), store = new SessionSuccessionContextStore(directory); await store.ready;
  await store.attach(attachment('input'));
  const path = join(directory, 'context.json'), state = JSON.parse(await readFile(path, 'utf8'));
  const desired = SUCCESSION_STORE_BYTES - freeBytes;
  while (jsonBytes(state) < desired - 1024 * 1024) {
    const id = `fill-${state.attachments.length}`;
    state.attachments.push({ ...attachment(id, JSON.stringify([{ role: 'user', text: 'x'.repeat(1024 * 1024 - 100) }])), version: 2, state: 'pending', deliveries: [] });
  }
  const id = `fill-${state.attachments.length}`, last = { ...attachment(id, '[{"role":"user","text":""}]'), version: 2, state: 'pending', deliveries: [] };
  state.attachments.push(last);
  last.text = JSON.stringify([{ role: 'user', text: 'x'.repeat(desired - jsonBytes(state)) }]);
  await writeFile(path, JSON.stringify(state));
  const reopened = new SessionSuccessionContextStore(directory); await reopened.ready;
  return { directory, store: reopened };
}

test('initial role capacity failure publishes neither operation nor source reservation', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const path = join(directory, 'state.json'), state = JSON.parse(await readFile(path, 'utf8'));
  fillRoleState(state, SUCCESSION_STORE_BYTES - 8192); await writeFile(path, JSON.stringify(state));
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  await expect(reopened.begin(request, true)).rejects.toThrow(/capacity/);
  expect(reopened.read('role').operations).toEqual([]);
  expect(JSON.parse(await readFile(path, 'utf8')).roles[0].operations).toEqual([]);
});

test('concurrent unrelated role writes preserve actual participant, terminal and enrollment-release capacity', async () => {
  const directory = await root(), store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const path = join(directory, 'state.json'), before = JSON.parse(await readFile(path, 'utf8'));
  const participants = Array.from({ length: 10 }, (_, index) => ({ relationId: `${index}-引号"\\`.repeat(30), kind: 'tpm' as const, before: ref(`reader-${index}`), after: ref(`reader-${index}`) }));
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, token: 'token-中\\"'.repeat(20), authority: { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'host', request, associationRevision: 0, lineage: [ref('A')], relations: [] };
  await store.beginEnrolled(freeze, participants, store.generation, true);
  const admitted = JSON.parse(await readFile(path, 'utf8'));
  const reserved = Number(admitted.roles[0].localPreparations[0].reservedBytes), actualGrowth = jsonBytes(admitted) - jsonBytes(before);
  fillRoleState(before, SUCCESSION_STORE_BYTES - reserved - actualGrowth - 18000); await writeFile(path, JSON.stringify(before));
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  await reopened.beginEnrolled(freeze, participants, reopened.generation, true);
  const unrelated = await Promise.allSettled([reopened.ensureRole(ref('other-1'), '中'.repeat(4096)), reopened.ensureRole(ref('other-2'), '中'.repeat(4096))]);
  expect(unrelated.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  await reopened.savePreparation('op', capture); await reopened.startCreation('op');
  const target = ref('\ud800'.repeat(512)); await reopened.saveCandidate('op', target);
  const state = reopened.read('role');
  await reopened.advance('op', 'transferring', { phase: 'ready', prepared: { ...request, to: target, workspace: state.role.workspace, associationRevision: state.associationRevision, participants, capture } });
  expect((await reopened.commit('op')).phase).toBe('committed');
  await reopened.releaseEnrollment(freeze);
  expect(reopened.read('role').releasedEnrollments).toContain(freeze.token);
});

test.each(['accepted', 'rejected', 'unknown'] as const)('reserves actual escaped one-MiB input and finite %s settlement near capacity', async outcome => {
  const text = '\0'.repeat(1024 * 1024), f = await contextNearCapacity(6 * 1024 * 1024 + 1024);
  await f.store.begin('input', { operationId: 'delivery', roleId: 'input', roleRevision: 2, target: ref('target-input'), text });
  const receipt = await f.store.settle('input', 'delivery', outcome, outcome === 'accepted' ? { disposition: 'started' } : undefined);
  expect(receipt.state).toBe(outcome);
  const reopened = new SessionSuccessionContextStore(f.directory); await reopened.ready;
  expect(reopened.delivery('delivery')!.state).toBe(outcome);
});

test('a large input rejected at admission keeps context pending for a smaller explicit input', async () => {
  const f = await contextNearCapacity(1000);
  const input = { operationId: 'large', roleId: 'input', roleRevision: 2, target: ref('target-input'), text: '\0'.repeat(1024 * 1024) };
  await expect(f.store.begin('input', input)).rejects.toThrow(/capacity/);
  expect(f.store.read('input').state).toBe('pending'); expect(f.store.delivery('large')).toBeUndefined();
  await f.store.begin('input', { ...input, operationId: 'small', text: '继续' });
  expect((await f.store.settle('input', 'small', 'accepted', { disposition: 'queued' })).state).toBe('accepted');
});

test('concurrent preparations cannot spend each other target-binding reservation', async () => {
  const f = await contextNearCapacity(20000);
  const first = { ...attachment('prepared-甲', JSON.stringify([{ role: 'user', text: '引号 " \\ 与中文' }])), target: undefined };
  const { target: _target, ...preparation } = first;
  await f.store.prepare(preparation);
  const outcomes = await Promise.allSettled([
    f.store.prepare({ ...preparation, operationId: 'prepared-乙' }),
    f.store.attach(attachment('unrelated', JSON.stringify([{ role: 'user', text: 'x'.repeat(15000) }]))),
  ]);
  expect(outcomes.some(outcome => outcome.status === 'rejected')).toBe(true);
  await f.store.bind(preparation.operationId, { controllerId: '\ud800'.repeat(512), providerId: '\ud800'.repeat(512), nativeSessionId: '\ud800'.repeat(512) });
  expect(f.store.read(preparation.operationId).text).toBe(preparation.text);
});
