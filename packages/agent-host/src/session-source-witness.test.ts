import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionStore, type SourceAssociationResult } from './session-succession-store.js';
import { jsonBytes, SUCCESSION_STORE_BYTES } from './succession-persistence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const widestId = '\ud800'.repeat(512);
function input(operationId = 'operation', scope = 'scope') {
  const id = createHash('sha256').update(JSON.stringify([scope, operationId])).digest('hex');
  return { id, fingerprint: 'a'.repeat(64), source: ref('source'), sourceWitness: { version: 1 as const, scope, operationId } };
}
function result(value: ReturnType<typeof input>, nativeSessionId = widestId): SourceAssociationResult {
  return { id: value.id, fingerprint: value.fingerprint, scope: value.sourceWitness.scope, operationId: value.sourceWitness.operationId, source: value.source, reader: ref(nativeSessionId) };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'source-witness-')); roots.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready;
  return { directory, store, path: join(directory, 'state.json') };
}
const admit = (store: SessionSuccessionStore, value: ReturnType<typeof input>) => store.admitAssociation(value.id, value.fingerprint, value.source, true, undefined, value.sourceWitness);
function fill(state: any, desiredBytes: number) {
  while (jsonBytes(state) < desiredBytes - 17000) {
    const index = state.associationResults.length;
    state.associationResults.push({ id: `fill-${index}`, fingerprint: 'fingerprint', scope: 'x'.repeat(16384), operationId: `fill-${index}`, source: ref('unrelated-source'), reader: ref('unrelated-reader') });
  }
  const index = state.associationResults.length;
  state.associationResults.push({ id: `fill-${index}`, fingerprint: 'fingerprint', scope: 'x', operationId: `fill-${index}`, source: ref('unrelated-source'), reader: ref('unrelated-reader') });
  state.associationResults.at(-1).scope += 'x'.repeat(desiredBytes - jsonBytes(state));
}
function fillRoles(state: any, desiredBytes: number) {
  const add = (cwd: string) => {
    const n = state.roles.length, source = ref(`ordinary-${n}`);
    state.roles.push({ role: { id: `ordinary-${n}`, revision: 1, origin: source, current: source, workspace: { controllerId: 'host', canonicalCwd: cwd } }, operations: [], associationRevision: 0, participants: [] });
  };
  for (;;) {
    const before = jsonBytes(state); add('');
    const bytes = desiredBytes - jsonBytes(state);
    if (bytes >= 12288) { state.roles.at(-1).role.workspace.canonicalCwd = '中'.repeat(4096); continue; }
    if (bytes >= 0) state.roles.at(-1).role.workspace.canonicalCwd = '中'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
    else { state.roles.pop(); state.roles.at(-1).role.id += 'x'.repeat(desiredBytes - before); }
    break;
  }
}

test.each([0, 1])('qualified admission respects its complete future witness at %i bytes below exact fit', async shortfall => {
  const f = await fixture(), value = input('escaped', 'scope-"\\'.repeat(20));
  const empty = { version: 7, roles: [], associationAdmissions: [], associationResults: [] };
  const admitted = { ...empty, associationAdmissions: [{ id: value.id, fingerprint: value.fingerprint, source: value.source, sourceReader: true, sourceWitness: value.sourceWitness }] };
  const admissionGrowth = jsonBytes(admitted) - jsonBytes(empty);
  const allowance = jsonBytes(result(value)) + 1;
  fill(empty, SUCCESSION_STORE_BYTES - admissionGrowth - allowance + shortfall);
  await writeFile(f.path, JSON.stringify(empty));
  const store = new SessionSuccessionStore(f.directory); await store.ready;
  if (shortfall) {
    await expect(admit(store, value)).rejects.toMatchObject({ code: 'succession_capacity_exceeded' });
    expect(JSON.parse(await readFile(f.path, 'utf8')).associationAdmissions).toEqual([]);
  } else {
    await admit(store, value);
    const restored = new SessionSuccessionStore(f.directory); await restored.ready;
    await expect(restored.ensureRole(ref('ordinary'), '/ordinary')).rejects.toThrow(/capacity/);
    await restored.completeSourceAssociation(result(value));
    expect(restored.sourceResult(value.id, value.fingerprint)).toEqual(result(value));
    expect(jsonBytes(JSON.parse(await readFile(f.path, 'utf8')))).toBeLessThanOrEqual(SUCCESSION_STORE_BYTES);
  }
});

test.each([[0, 1, 2], [2, 1, 0], [1, 0, 2]].map(order => [order]))('several pending witnesses survive restart and completion order %j from an empty result array', async order => {
  const f = await fixture(), values = ['first', 'second', 'third'].map(id => input(id));
  await Promise.all(values.map(value => admit(f.store, value)));
  const staged = JSON.parse(await readFile(f.path, 'utf8'));
  const allowances = values.reduce((sum, value) => sum + jsonBytes(result(value)) + 1, 0);
  fillRoles(staged, SUCCESSION_STORE_BYTES - allowances);
  expect(staged.associationResults).toEqual([]);
  await writeFile(f.path, JSON.stringify(staged));
  const store = new SessionSuccessionStore(f.directory); await store.ready;
  const outcomes = await Promise.allSettled([
    store.ensureRole(ref('competing-ordinary'), '中'.repeat(4096)),
    ...order.map(index => store.completeSourceAssociation(result(values[index]!))),
  ]);
  expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  expect(JSON.parse(await readFile(f.path, 'utf8')).associationAdmissions).toEqual([]);
  for (const value of values) expect(store.sourceResult(value.id, value.fingerprint)).toEqual(result(value));
});

test.each([
  null,
  Object.assign([], { version: 1, scope: 'scope', operationId: 'operation' }),
  { version: 2, scope: 'scope', operationId: 'operation' },
  { version: 1, scope: '', operationId: 'operation' },
  { version: 1, scope: 'x'.repeat(16385), operationId: 'operation' },
  { version: 1, scope: 'scope', operationId: 'x'.repeat(513) },
  { version: 1, scope: 'scope', operationId: 'operation', extra: true },
].map(descriptor => [descriptor]))('rejects malformed source witness descriptors before publication', async descriptor => {
  const f = await fixture(), value = input();
  await expect(f.store.admitAssociation(value.id, value.fingerprint, value.source, true, undefined, descriptor as never)).rejects.toThrow(/witness/);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('witness identity, mode and exact completion cannot be changed or extended', async () => {
  const f = await fixture(), value = input();
  await expect(f.store.admitAssociation('wrong-id', value.fingerprint, value.source, true, undefined, value.sourceWitness)).rejects.toThrow(/witness/);
  await expect(f.store.admitAssociation(value.id, value.fingerprint, value.source, false, undefined, value.sourceWitness)).rejects.toThrow(/witness/);
  await admit(f.store, value);
  for (const invalid of [
    { ...result(value), scope: 'different' }, { ...result(value), operationId: 'different' },
    { ...result(value), reader: { ...ref('reader'), providerId: 'different' } },
    { ...result(value), reader: ref('source') }, { ...result(value), extra: 'unbounded' },
  ]) await expect(f.store.completeSourceAssociation(invalid)).rejects.toThrow(/admission|result|witness/);
  expect(JSON.parse(await readFile(f.path, 'utf8')).associationAdmissions).toHaveLength(1);
});

test('version five legacy pending admissions migrate without synthetic witnesses or byte authority', async () => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify({ version: 5, roles: [], associationResults: [], associationAdmissions: [{ id: 'legacy', fingerprint: 'fingerprint', source: ref('source'), sourceReader: true }] }));
  const store = new SessionSuccessionStore(f.directory); await store.ready;
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  expect(saved.version).toBe(7); expect(saved.associationAdmissions[0].sourceWitness).toBeUndefined();
  await expect(store.admitAssociation('legacy', 'fingerprint', ref('source'), true)).rejects.toThrow(/unresolved/);
  await store.completeSourceAssociation({ id: 'legacy', fingerprint: 'fingerprint', scope: 'legacy', operationId: 'legacy', source: ref('source'), reader: ref('reader') });
  expect(store.sourceResult('legacy', 'fingerprint')!.reader).toEqual(ref('reader'));
});

test('restart rejects forged qualified identity and descriptors from old writers', async () => {
  const f = await fixture(), value = input(); await admit(f.store, value);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  saved.associationAdmissions[0].sourceWitness.scope = 'changed';
  await writeFile(f.path, JSON.stringify(saved));
  await expect(new SessionSuccessionStore(f.directory).ready).rejects.toThrow(/witness/);
  saved.associationAdmissions[0].sourceWitness.scope = 'scope'; saved.version = 5;
  await writeFile(f.path, JSON.stringify(saved));
  await expect(new SessionSuccessionStore(f.directory).ready).rejects.toThrow(/legacy|witness/);
});
