import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionSuccessionStore } from './session-succession-store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const workspace = { controllerId: 'host', canonicalCwd: '/workspace' };
const role = { id: 'role', revision: 1, origin: source, current: source, workspace };
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: source };
const target = { ...source, nativeSessionId: 'B' };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-succession-')); directories.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready; await store.createRole(role);
  return { directory, store };
}
async function ready(store: SessionSuccessionStore, input = request, to = target) {
  await store.begin(input);
  await store.advance(input.operationId, 'preparing', { phase: 'quiescing', to });
  await store.advance(input.operationId, 'quiescing', { phase: 'transferring' });
  return store.advance(input.operationId, 'transferring', { phase: 'ready', prepared: {
    ...input, to, associationRevision: 0, workspace, participants: [],
    capture: { epoch: 'epoch', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' },
  } });
}

test('reserves one revision and deduplicates the same intent without accepting conflicting input', async () => {
  const { store } = await fixture();
  const outcomes = await Promise.allSettled([store.begin(request), store.begin({ ...request, operationId: 'other' })]);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  const first = store.operation('op');
  expect(await store.begin({ ...request, from: { nativeSessionId: 'A', providerId: 'codex', controllerId: 'host' } })).toEqual(first);
  await expect(store.begin({ ...request, from: target })).rejects.toThrow(/identity|conflict/i);
  expect(store.read('role').role.current.nativeSessionId).toBe('A');
});

test('commits role and receipt together and retains A -> B -> C history across restart', async () => {
  const { store, directory } = await fixture();
  await ready(store);
  const first = await store.commit('op');
  expect(first.committedRevision).toBe(2);
  expect(await store.commit('op')).toEqual(first);
  const next = { ...request, operationId: 'next', expectedRevision: 2, from: target };
  await ready(store, next, { ...source, nativeSessionId: 'C' }); await store.commit('next');
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.read('role').role).toMatchObject({ revision: 3, origin: source, current: { nativeSessionId: 'C' } });
  expect(restored.read('role').operations.map(op => [op.from.nativeSessionId, op.to?.nativeSessionId])).toEqual([['A', 'B'], ['B', 'C']]);
  expect(await restored.commit('op')).toEqual(first);
  await expect(restored.begin({ ...request, operationId: 'stale' })).rejects.toThrow(/revision|changed/i);
});

test('rejects commit without verified preparation and cannot rewrite a persisted target', async () => {
  const { store } = await fixture(); await store.begin(request);
  await expect(store.commit('op')).rejects.toThrow(/ready/i);
  await expect(store.advance('op', 'preparing', { phase: 'ready' })).rejects.toThrow();
  await store.advance('op', 'preparing', { phase: 'quiescing', to: target });
  await expect(store.advance('op', 'quiescing', { phase: 'transferring', to: { ...target, nativeSessionId: 'C' } })).rejects.toThrow(/target/i);
  expect(store.operation('op').phase).toBe('quiescing');
});

test('restart retains the gate and records uncertain preparation without recreating or committing', async () => {
  const { store, directory } = await fixture(); await ready(store);
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.operation('op')).toMatchObject({ phase: 'unknown', resumePhase: 'ready', to: target });
  expect(restored.read('role').role.current.nativeSessionId).toBe('A');
  await expect(restored.commit('op')).rejects.toThrow(/ready/i);
  await expect(restored.begin({ ...request, operationId: 'retry-new-id' })).rejects.toThrow(/progress|reserved/i);
  await expect(restored.advance('op', 'unknown', { phase: 'cancelled' })).rejects.toThrow(/reconcil|unknown/i);
  await restored.advance('op', 'unknown', { phase: 'ready' });
  expect((await restored.commit('op')).committedRevision).toBe(2);
});

test('rejects self succession, duplicate participant relations and mismatched preparation', async () => {
  const { store } = await fixture(); await store.begin(request);
  await expect(store.advance('op', 'preparing', { phase: 'quiescing', to: source })).rejects.toThrow(/same|target/i);
  await store.advance('op', 'preparing', { phase: 'quiescing', to: target });
  await store.advance('op', 'quiescing', { phase: 'transferring' });
  const prepared = { ...request, to: target, associationRevision: 0, workspace, participants: [],
    capture: { epoch: 'epoch', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' } };
  await expect(store.advance('op', 'transferring', { phase: 'ready', prepared: { ...prepared, from: target } })).rejects.toThrow(/prepar/i);
  const side = { relationId: 'same', kind: 'side' as const, before: target, after: target };
  await expect(store.advance('op', 'transferring', { phase: 'ready', prepared: { ...prepared, participants: [side, side] } })).rejects.toThrow(/participant/i);
});

test('a failed atomic replacement does not publish memory or damage the last saved decision', async () => {
  const { store, directory } = await fixture();
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  const saved = await readFile(join(directory, file), 'utf8');
  await rm(join(directory, file)); await mkdir(join(directory, file));
  await expect(store.begin(request)).rejects.toThrow();
  expect(() => store.read('role')).toThrow(/persistence outcome is unknown/i);
  await rm(join(directory, file), { recursive: true }); await writeFile(join(directory, file), saved);
  await writeFile(join(directory, `${file}.interrupted.tmp`), '{partial');
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.read('role').role.current.nativeSessionId).toBe('A');
  expect(restored.read('role').operations).toEqual([]);
});

test('rejects a future persisted format rather than overwriting it', async () => {
  const { directory } = await fixture();
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  const saved = JSON.parse(await readFile(join(directory, file), 'utf8')); saved.version = 999;
  await writeFile(join(directory, file), JSON.stringify(saved));
  await expect(new SessionSuccessionStore(directory).ready).rejects.toThrow(/format|version/i);
});

test('freezes association changes during preparation and rejects a stale association snapshot', async () => {
  const { store } = await fixture();
  await store.setParticipants('role', 1, 0, [{ relationId: 'ask', kind: 'ask', before: target, after: target }]);
  await ready(store);
  await expect(store.setParticipants('role', 1, 1, [])).rejects.toThrow(/progress|reserved/i);
  await expect(store.commit('op')).rejects.toThrow(/association/i);
  expect(store.read('role').role.current.nativeSessionId).toBe('A');
});

test('atomically enrolls a frozen association receipt and refuses unresolved source admissions across restart', async () => {
  const { store, directory } = await fixture();
  const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, token: 'freeze', authority, controllerId: source.controllerId, request, associationRevision: 4, lineage: [source], relations: [] };
  await store.admitAssociation('create', 'fingerprint', source);
  await expect(store.begin(request, true)).rejects.toThrow(/unresolved/);
  await expect(store.beginEnrolled(freeze, [], store.generation)).rejects.toThrow(/unresolved/);
  const reopened = new SessionSuccessionStore(directory); await reopened.ready;
  await expect(reopened.beginEnrolled(freeze, [], reopened.generation)).rejects.toThrow(/unresolved/);
  await reopened.settleAssociation('create', 'fingerprint');
  const operation = await reopened.beginEnrolled(freeze, [], reopened.generation);
  expect(operation.phase).toBe('preparing');
  expect(reopened.read('role').associationAuthority).toEqual(authority);
  expect(reopened.read('role').enrollments).toEqual([freeze]);
  await expect(reopened.admitAssociation('another', 'fingerprint', source)).rejects.toThrow(/reserved/);
  await expect(reopened.beginEnrolled({ ...freeze, token: 'forged' }, [], reopened.generation)).rejects.toThrow(/receipt/);
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(restored.operation('op').phase).toBe('unknown');
  expect(restored.read('role').enrollments).toEqual([freeze]);
});

test('migrates legacy storage explicitly and rejects admission races or authority replacement', async () => {
  const { store, directory } = await fixture();
  const path = join(directory, 'state.json');
  const legacy = JSON.parse(await readFile(path, 'utf8')); legacy.version = 1; delete legacy.associationAdmissions; delete legacy.associationResults;
  await writeFile(path, JSON.stringify(legacy));
  const restored = new SessionSuccessionStore(directory); await restored.ready;
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(7);
  const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, token: 'freeze', authority, controllerId: source.controllerId, request, associationRevision: 1, lineage: [source], relations: [] };
  const before = restored.generation;
  await restored.admitAssociation('create', 'fingerprint', source); await restored.settleAssociation('create', 'fingerprint');
  await expect(restored.beginEnrolled(freeze, [], before)).rejects.toThrow(/changed/);
  await restored.beginEnrolled(freeze, [], restored.generation);
  await restored.advance('op', 'preparing', { phase: 'cancelled' });
  await restored.releaseEnrollment(freeze);
  await expect(restored.begin({ ...request, operationId: 'local-bypass' })).rejects.toThrow(/authenticated/);
  await expect(restored.beginEnrolled({ ...freeze, token: 'replacement', authority: { ...authority, namespace: 'another' }, request: { ...request, operationId: 'new' } }, [], restored.generation)).rejects.toThrow(/authority/);
  expect(restored.read('role').operations).toHaveLength(1);
});

test('copies source identities before queued association mutations', async () => {
  const { store, directory } = await fixture();
  const input = { ...source, nativeSessionId: 'new' };
  const pending = store.ensureRole(input, '/workspace'); input.nativeSessionId = 'forged';
  const created = await pending;
  expect(created.origin.nativeSessionId).toBe('new');
  const admitted = { ...source };
  const admission = store.admitAssociation('guard', 'fingerprint', admitted); admitted.nativeSessionId = 'changed';
  await admission;
  const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  expect(saved.associationAdmissions[0].source).toEqual(source);
  admitted.nativeSessionId = 'changed-again';
  const authority={version:1 as const,origin:'https://relay.example',issuer:'https://issuer.example',namespace:'tenant',ownerSubject:'owner'};
  const freeze={version:2 as const,maxProjectionBytes:8*1024*1024,token:'alias-check',authority,controllerId:source.controllerId,request,associationRevision:0,lineage:[source],relations:[]};
  await expect(store.beginEnrolled(freeze,[],store.generation)).rejects.toThrow(/unresolved/);
  expect(store.read(created.id).role.origin.nativeSessionId).toBe('new');
});

test('accepts semantically identical frozen receipts with reordered JSON object fields', async () => {
  const { store } = await fixture();
  const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, token: 'freeze', authority, controllerId: source.controllerId, request, associationRevision: 1, lineage: [source], relations: [] };
  await store.beginEnrolled(freeze, [], store.generation);
  const reordered = { ...freeze, authority: { ownerSubject: authority.ownerSubject, namespace: authority.namespace, issuer: authority.issuer, origin: authority.origin, version: authority.version }, lineage: [{ nativeSessionId: source.nativeSessionId, providerId: source.providerId, controllerId: source.controllerId }] };
  expect((await store.beginEnrolled(reordered, [], store.generation)).operationId).toBe('op');
  await store.advance('op', 'preparing', { phase: 'cancelled' });
  await store.releaseEnrollment(reordered);
  expect((await store.beginEnrolled({ ...reordered, token: 'next', request: { ...request, operationId: 'next' } }, [], store.generation)).phase).toBe('preparing');
});


test('terminal enrolled decisions stay fenced across restart until the exact durable release', async () => {
  const {store,directory}=await fixture();
  const authority={version:1 as const,origin:'https://relay.example',issuer:'https://issuer.example',namespace:'tenant',ownerSubject:'owner'};
  const freeze={version:2 as const,maxProjectionBytes:8*1024*1024,token:'release-token',authority,controllerId:source.controllerId,request,associationRevision:0,lineage:[source],relations:[]};
  await store.beginEnrolled(freeze,[],store.generation);
  await expect(store.releaseEnrollment(freeze)).rejects.toThrow(/Unknown/);
  await store.advance('op','preparing',{phase:'cancelled'});
  const restored=new SessionSuccessionStore(directory);await restored.ready;
  await expect(restored.admitAssociation('reader','fingerprint',source)).rejects.toThrow(/reserved/);
  await expect(restored.releaseEnrollment({...freeze,token:'forged'})).rejects.toThrow(/receipt/);
  await restored.releaseEnrollment(freeze);
  await restored.releaseEnrollment(freeze);
  expect(restored.read('role').releasedEnrollments).toEqual(['release-token']);
  await restored.admitAssociation('reader','fingerprint',source);
});


test('recovered TPM evidence settles only its exact persisted admission',async()=>{
  const {store,directory}=await fixture();
  const recovery={createKey:'["scope","create-tpm"]',createFingerprint:'a'.repeat(64)};
  await store.admitAssociation('tpm','fingerprint',source,false,recovery);
  await store.admitAssociation('unrelated','other',source);
  recovery.createKey='tampered';
  const restored=new SessionSuccessionStore(directory);await restored.ready;
  const evidence={createKey:'["scope","create-tpm"]',createFingerprint:'a'.repeat(64)};
  await expect(restored.settleRecoveredAssociation({...evidence,createFingerprint:'b'.repeat(64)},source)).rejects.toThrow(/conflict/);
  await expect(restored.settleRecoveredAssociation(evidence,target)).rejects.toThrow(/conflict/);
  await restored.settleRecoveredAssociation(evidence,source);
  const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
  expect(state.associationAdmissions.map((item:{id:string})=>item.id)).toEqual(['unrelated']);
});


test('persists exact source creation result atomically with admission settlement and replays after restart',async()=>{
  const {store,directory}=await fixture();
  await store.admitAssociation('source-op','fingerprint',source,true);
  await store.completeSourceAssociation({id:'source-op',fingerprint:'fingerprint',scope:'scope',operationId:'source-op',source,reader:target});
  const restored=new SessionSuccessionStore(directory);await restored.ready;
  expect(restored.sourceResult('source-op','fingerprint')).toMatchObject({source,reader:target,operationId:'source-op'});
  expect(()=>restored.sourceResult('source-op','different')).toThrow(/identity/);
  expect(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).associationAdmissions).toEqual([]);
});


test('failed native-result persistence retains admission and never publishes a result witness',async()=>{
  const {store,directory}=await fixture();
  await store.admitAssociation('source-op','fingerprint',source,true);
  const path=join(directory,'state.json'),previous=await readFile(path,'utf8');
  await rm(path);await mkdir(path);
  await expect(store.completeSourceAssociation({id:'source-op',fingerprint:'fingerprint',scope:'scope',operationId:'source-op',source,reader:target})).rejects.toThrow();
  expect(() => store.sourceResult('source-op','fingerprint')).toThrow(/persistence outcome is unknown/i);
  await expect(store.admitAssociation('source-op','fingerprint',source,true)).rejects.toThrow(/persistence outcome is unknown/i);
  await rm(path,{recursive:true});await writeFile(path,previous);
  const restored=new SessionSuccessionStore(directory);await restored.ready;
  expect(restored.sourceResult('source-op','fingerprint')).toBeUndefined();
  await expect(restored.admitAssociation('source-op','fingerprint',source,true)).rejects.toThrow(/unresolved/);
});


test('reserves bounded native-result capacity before dispatch while keeping TPM admissions independent',async()=>{
  const {directory}=await fixture();
  const path=join(directory,'state.json'),state=JSON.parse(await readFile(path,'utf8'));
  state.associationResults=Array.from({length:1023},(_,index)=>({id:`result-${index}`,fingerprint:'fingerprint',scope:'scope',operationId:`result-${index}`,source,reader:target}));
  await writeFile(path,JSON.stringify(state));
  const restored=new SessionSuccessionStore(directory);await restored.ready;
  const outcomes=await Promise.allSettled([
    restored.admitAssociation('first','fingerprint',source,true),
    restored.admitAssociation('second','fingerprint',source,true),
  ]);
  expect(outcomes.map(item=>item.status)).toEqual(['fulfilled','rejected']);
  expect((outcomes[1] as PromiseRejectedResult).reason.message).toMatch(/result storage is full/);
  await restored.admitAssociation('tpm','fingerprint',source,false,{createKey:'tpm-create',createFingerprint:'a'.repeat(64)});
  const reopened=new SessionSuccessionStore(directory);await reopened.ready;
  await expect(reopened.admitAssociation('third','fingerprint',source,true)).rejects.toThrow(/result storage is full/);
  await expect(reopened.completeSourceAssociation({id:'tpm',fingerprint:'fingerprint',scope:'scope',operationId:'tpm',source,reader:target})).rejects.toThrow(/admission/);
  await reopened.completeSourceAssociation({id:'first',fingerprint:'fingerprint',scope:'scope',operationId:'first',source,reader:target});
  expect(JSON.parse(await readFile(path,'utf8')).associationResults).toHaveLength(1024);
  await expect(reopened.admitAssociation('fourth','fingerprint',source,true)).rejects.toThrow(/result storage is full/);
});

test('migrates valid version 2 while rejecting missing or null durable admissions and results',async()=>{
 const {directory}=await fixture(),path=join(directory,'state.json'),saved=JSON.parse(await readFile(path,'utf8'));
 saved.version=2;
 for(const field of ['associationAdmissions','associationResults'])for(const missing of ['absent','null']){
  const invalid=structuredClone(saved);if(missing==='absent')delete invalid[field];else invalid[field]=null;
  await writeFile(path,JSON.stringify(invalid));await expect(new SessionSuccessionStore(directory).ready).rejects.toThrow(/admission|result/);
 }
 await writeFile(path,JSON.stringify(saved));const migrated=new SessionSuccessionStore(directory);await migrated.ready;
 expect(JSON.parse(await readFile(path,'utf8')).version).toBe(7);expect(migrated.read('role').role.current).toEqual(source);
});
