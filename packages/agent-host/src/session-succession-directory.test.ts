import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { AgentOperationRejectedError, type AgentSession, type AgentSessionConfig, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { createManagedStdioDirectory } from './stdio-directory.js';
import { acquireNativeSession, type NativeSessionLease } from './native-session-owner.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 5000);
const ref = (nativeSessionId: string, providerId = 'fixture') => ({ controllerId: 'controller', providerId, nativeSessionId });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class Native implements AgentSession {
  capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
  status: 'idle' | 'running' = 'idle'; private stop?: () => void;
  constructor(readonly id: string, readonly cwd: string, readonly providerId = 'fixture') {}
  async runtimeInfo() { return { providerId: this.providerId, sessionId: this.id, status: this.status, cwd: this.cwd, persistence: { providerId: this.providerId, sessionId: this.id, opaque: '{}' } }; }
  async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await new Promise<void>(resolve => { this.stop = resolve; }); }
  async sendMessage() { return { disposition: 'started' as const }; }
  async respondToInteraction() {}
  async dispose() { this.stop?.(); }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-directory-admission-')));
  const store = new SessionSuccessionStore(join(root, 'roles')); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'controller', canonicalCwd: root } });
  const sessions = new Map(['A','B','C'].map(id => [id, new Native(id, root)]));
  const configurations: Array<Record<string, unknown>> = [], grants: Array<{ nativeSessionId: string; sourceNativeSessionId: string }> = [];
  let validateSource = async (_id: string) => {}, validateRename = async () => {}, validateEdit = async () => {};
  let renameCalls = 0, openCalls = 0, title = 'Original';
  let createFailure: 'none' | 'unknown' | 'known-local' | 'rejected' = 'none', hugeRenameResult = false;
  const directory: AgentHostDirectory = {
    providerId: 'fixture', supportsSourceReferences: true, supportsPromptEditing: true,
    list: () => [], workspaces: () => [], setSourceBindingReader() {}, sourceReferences: async () => grants,
    sessionWorkspace: async id => { await validateSource(id); return sessions.has(id) ? root : undefined; },
    validateSessionRename: async () => validateRename(), validatePromptEdit: async () => validateEdit(), sessionTitle: async () => title,
    renameSession: async (_id, requested) => { renameCalls++; title = requested; return hugeRenameResult ? 'x'.repeat(20000) : requested; },
    async create(config, evidence) {
      configurations.push(structuredClone(config));
      if (createFailure === 'rejected') throw new AgentOperationRejectedError('fixture_no_effect', 'Definite native refusal');
      const id = `new-${configurations.length}`; sessions.set(id, new Native(id, root));
      if (createFailure === 'unknown') throw new Error('Native reply lost');
      evidence?.completed();
      if (createFailure === 'known-local') throw new Error('Local grant publication failed');
      if (config.sourceNativeSessionId) grants.push({ nativeSessionId: id, sourceNativeSessionId: config.sourceNativeSessionId });
      return id;
    },
    async open(id) { openCalls++; return sessions.get(id)!; },
    close: async () => { await Promise.all([...sessions.values()].map(session => session.dispose())); },
  };
  const host = createAgentHostRuntime({ succession: { controllerId: 'controller', stateDirectory: root, native: {
    supports: async () => true, inspect: async source => ({ cwd: root, idle: sessions.get(source.nativeSessionId)?.status === 'idle', managed: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }),
    createIdle: async () => ref('B'), reconcileDelivery: async () => undefined,
  } }, registrations: [{ adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => { throw new Error('unexpected'); }, resumeSession: async () => { throw new Error('unexpected'); }, readSessionHistory: async () => ({ entries: [] }) }, directory }] });
  const server = createServer(async (request, response) => {
    let encoded = ''; for await (const chunk of request) encoded += chunk;
    const payload = encoded ? JSON.parse(encoded) : {};
    const result = await host.control({ method: request.method as 'GET' | 'POST', path: request.url!, body: encoded,
      sessionId: request.url === '/remote/create' ? `created-${payload.operationId}` : request.headers['x-agent'] as string | undefined });
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(result.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP endpoint');
  const post = async (path: string, payload: unknown, agent?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(agent ? { 'x-agent': agent } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
    return { status: response.status, data: await response.json() };
  };
  cleanup.push(async () => { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const prepare = (id = randomUUID()) => post('/remote/succession/prepare', { operationId: id, roleId: 'role', expectedRevision: 1, from: ref('A') });
  await post('/remote/attach', { providerId: 'fixture', nativeSessionId: 'A' }, 'A');
  return { root, sessions, host, post, prepare, configurations, grants, creates: () => configurations.length, renames: () => renameCalls, opens: () => openCalls,
    sourceValidation: (hook: typeof validateSource) => { validateSource = hook; }, renameValidation: (hook: typeof validateRename) => { validateRename = hook; }, editValidation: (hook: typeof validateEdit) => { validateEdit = hook; },
    failure: (mode: typeof createFailure) => { createFailure = mode; }, hugeRename: () => { hugeRenameResult = true; } };
}
const snapshot = (source = 'A', providerId = 'fixture', operationId = randomUUID()) => ({ providerId: 'fixture', operationId, creationSource: { providerId, nativeSessionId: source } });

test('HTTP snapshot create admits before source authorization; handoff refuses the opposite race order', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let first = true;
  f.sourceValidation(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
  const creating = f.post('/remote/create', snapshot());
  try {
    await entered.promise;
    expect(await f.prepare()).toMatchObject({ status: 200, data: { phase: 'rejected' } }); expect(f.creates()).toBe(0);
    release.resolve(); expect(await creating).toMatchObject({ status: 200 });
    expect(await f.prepare()).toMatchObject({ status: 200, data: { phase: 'ready' } });
  } finally { release.resolve(); await creating; }
}, 5000);

test('reserved A/B reject snapshot, prompt edit and rename with zero validation/native effects; unrelated C remains available', async () => {
  const f = await fixture(); expect((await f.prepare()).data.phase).toBe('ready');
  let validations = 0; f.sourceValidation(async () => { validations++; }); f.renameValidation(async () => { validations++; }); f.editValidation(async () => { validations++; });
  for (const id of ['A','B']) {
    expect((await f.post('/remote/create', snapshot(id))).status).toBeGreaterThanOrEqual(400);
    expect((await f.post('/remote/create', { providerId: 'fixture', operationId: randomUUID(), editNativeSessionId: id, editTurnId: 'turn', editMessageId: 'message' })).status).toBeGreaterThanOrEqual(400);
    expect((await f.post('/remote/session/rename', { providerId: 'fixture', nativeSessionId: id, operationId: randomUUID(), title: 'Blocked' })).status).toBeGreaterThanOrEqual(400);
  }
  expect(validations).toBe(0); expect(f.creates()).toBe(0); expect(f.renames()).toBe(0);
  expect((await f.post('/remote/create', snapshot('C'))).status).toBe(200);
}, 5000);

test('same-Host cross-provider snapshots authorize the concrete provider and strip provenance and tools; exact retry and changed provenance', async () => {
  const f = await fixture(); const other = new Native('X', f.root, 'other');
  f.host.addRegistration({ adapter: { descriptor: { providerId: 'other', displayName: 'Other' }, createSession: async () => other, resumeSession: async () => other, readSessionHistory: async () => ({ entries: [] }) },
    directory: { providerId: 'other', list: () => [], workspaces: () => [], setSourceBindingReader() {}, sourceReferences: async () => [], create: async () => 'unused', open: async () => other, sessionWorkspace: async id => id === 'X' ? f.root : undefined, close: async () => other.dispose() } });
  const input = snapshot('X','other');
  const initial = await f.post('/remote/create', input); expect(initial.status).toBe(200);
  expect(await f.post('/remote/create', input)).toEqual(initial); expect(f.creates()).toBe(1);
  expect(f.configurations[0]).toEqual({}); expect(f.grants).toEqual([]);
  expect((await f.post('/remote/create', { ...input, creationSource: { providerId: 'fixture', nativeSessionId: 'C' } })).data.code).toBe('operation_conflict');
}, 5000);

test('malformed, cross-Host, missing and contradictory provenance refuse before creation; legacy source tools remain intact', async () => {
  const f = await fixture();
  for (const creationSource of [null, {}, { providerId: 'fixture', nativeSessionId: 'A', controllerId: 'other' }, { providerId: 'fixture', nativeSessionId: 'A', hostId: 'other' }, { providerId: 'fixture', nativeSessionId: 'missing' }, { providerId: 'missing-provider', nativeSessionId: 'A' }]) {
    expect((await f.post('/remote/create', { ...snapshot(), creationSource })).status).toBeGreaterThanOrEqual(400);
  }
  expect((await f.post('/remote/create', { ...snapshot('C'), sourceNativeSessionId: 'A' })).status).toBe(400);
  expect(f.creates()).toBe(0);
  expect((await f.post('/remote/create', { ...snapshot(), sourceNativeSessionId: 'A' })).status).toBe(200);
  expect(f.configurations[0]).toEqual({ sourceNativeSessionId: 'A' }); expect(f.grants).toHaveLength(1);
}, 5000);

test('rename validation holds admission and exact retry reads current title without renaming again', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.renameValidation(async () => { entered.resolve(); await release.promise; });
  const input = { providerId: 'fixture', nativeSessionId: 'A', operationId: randomUUID(), title: 'First' };
  const renaming = f.post('/remote/session/rename', input);
  try { await entered.promise; expect((await f.prepare()).data.phase).toBe('rejected'); release.resolve(); expect((await renaming).data.title).toBe('First'); }
  finally { release.resolve(); await renaming; }
  f.renameValidation(async () => {});
  await f.post('/remote/session/rename', { ...input, operationId: randomUUID(), title: 'Second' });
  expect((await f.post('/remote/session/rename', input)).data.title).toBe('Second'); expect(f.renames()).toBe(2);
}, 5000);

test.each(['unknown','known-local','rejected'] as const)('native create outcome %s is independent of local publication', async mode => {
  const f = await fixture(); f.failure(mode); const input = snapshot();
  expect((await f.post('/remote/create', input)).status).toBeGreaterThanOrEqual(400);
  await f.post('/remote/create', input); expect(f.creates()).toBe(1);
  const handoff = await f.prepare();
  expect(handoff.data.phase).toBe(mode === 'unknown' ? 'rejected' : 'ready');
}, 5000);

test('known rename effect remains settled after oversized local cache publication', async () => {
  const f = await fixture(); f.hugeRename();
  const response = await f.post('/remote/session/rename', { providerId: 'fixture', nativeSessionId: 'A', operationId: randomUUID(), title: 'Known' });
  expect(response.data.title).toBe('Known'); expect(f.renames()).toBe(1);
  const handoff = await f.prepare();
  expect(handoff.status).toBe(200); expect(handoff.data.phase).toBe('ready');
}, 5000);

test('requester takeover refuses reserved source/candidate before open and admits unrelated native target', async () => {
  const f = await fixture(); expect((await f.prepare()).data.phase).toBe('ready');
  // A is already live: ordinary attachment/recovery is a read.
  expect((await f.post('/remote/attach', { providerId: 'fixture', nativeSessionId: 'A' }, 'A')).status).toBe(200);
  await f.host.relay.closeAgent('A'); const baseline = f.opens();
  for (const nativeSessionId of ['A','B']) expect((await f.post('/remote/attach', { providerId: 'fixture', nativeSessionId, takeOver: randomUUID() }, `take-${nativeSessionId}`)).status).toBeGreaterThanOrEqual(400);
  expect(f.opens()).toBe(baseline);
  const input = { providerId: 'fixture', nativeSessionId: 'C', takeOver: randomUUID() };
  const first = await f.post('/remote/attach', input, 'take-C'); expect(first.status).toBe(200);
  expect(await f.post('/remote/attach', input, 'take-C')).toEqual(first); expect(f.opens()).toBe(baseline + 1);
}, 5000);

test('ordinary authenticated owner takeover interrupts a working managed session and closes its projection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-working-owner-'))), owners = join(root, 'owners');
  const native = new Native('A', root); native.status = 'running'; let releases = 0;
  const directory = createManagedStdioDirectory('fixture','Fixture', {
    createSession: async () => native, resumeSession: async () => native, listSessions: async () => [],
    sessionWorkspace: async () => root, releaseSession: async () => { releases++; },
  }, [], { root: owners });
  const host = createAgentHostRuntime({ succession: { controllerId: 'controller', stateDirectory: root }, registrations: [{
    adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => native, resumeSession: async () => native }, directory,
  }] });
  let next: NativeSessionLease | undefined;
  cleanup.push(async () => { await next?.release(); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  expect((await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'A', body: JSON.stringify({ providerId: 'fixture', nativeSessionId: 'A' }) })).status).toBe(200);
  const { inspectNativeOwner } = await import('./native-session-owner.js');
  const owner = await inspectNativeOwner({ root: owners, providerId: 'fixture', sessionId: 'A' });
  next = await acquireNativeSession({ root: owners, providerId: 'fixture', sessionId: 'A', kind: 'native_cli', takeOver: owner!.generation, requestTimeoutMs: 1500 });
  expect(next.previousOutcome).toBe('requested'); expect(releases).toBe(1); expect(host.resolveSession('A')).toBeUndefined();
}, 5000);
