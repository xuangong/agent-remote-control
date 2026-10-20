import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AgentOperationRejectedError, type AgentSession, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { jsonBytes, SUCCESSION_STORE_BYTES } from './succession-persistence.js';
import * as directoryMutation from './directory-mutation.js';
import * as fs from 'node:fs/promises';
import { SessionReferenceStore } from './session-reference.js';
import { SessionSuccessionContextStore } from './session-succession-context.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); const original = await vi.importActual<typeof fs>('node:fs/promises'); vi.mocked(fs.open).mockReset(); vi.mocked(fs.open).mockImplementation(original.open); for (const close of closeables.splice(0).reverse()) await close(); });
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
const context: TrustedSuccessionContext = { installationId: 'controller', successionEnrollmentVersion: 2,
  authority: { version: 1, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' } };
const operationId = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
class Native implements AgentSession {
  capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
  private stop?: () => void;
  private closed = false;
  constructor(readonly id: string, readonly cwd: string) {}
  async runtimeInfo() { return { providerId: 'fixture', sessionId: this.id, status: 'idle' as const, cwd: this.cwd }; }
  async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; if (!this.closed) await new Promise<void>(resolve => { this.stop = resolve; }); }
  async sendMessage() {} async respondToInteraction() {}
  async dispose() { this.closed = true; this.stop?.(); }
}
async function fixture(certificate: boolean | undefined, nativeId = 'reader', cache?: { maxResultBytes?: number; maxBytes?: number; ttlMs?: number; now?: () => number }, policy = false, fileGrants = false, shutdownTimeoutMs?: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-create-')));
  closeables.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let creates = 0, certificates = 0, granted = true, loseResult = false, rejectNative = false;
  let beforeCreate = async () => {}, beforeOpen = async (_id: string) => {};
  let closingDirectory!: () => void;
  const directoryClosing = new Promise<void>(resolve => { closingDirectory = resolve; });
  const grants: Array<{ nativeSessionId: string; sourceNativeSessionId: string }> = [];
  let references = new SessionReferenceStore(join(root, 'references'), 'fixture');
  const sessions: Native[] = [];
  const directory: AgentHostDirectory = {
    providerId: 'fixture', supportsSourceReferences: true,
    ...(certificate === undefined ? {} : { async supportsBoundedSourceCreate(input: Parameters<AgentHostDirectory['create']>[0]) {
      expect(this).toBe(directory); certificates++;
      if (policy) expect(input.cwd).toBe(root);
      expect(input.sourceNativeSessionId).toBe('source'); return certificate;
    } }),
    workspaces: () => [{ id: 'workspace', name: 'Workspace', path: root }],
    list: () => [{ providerId: 'fixture', nativeSessionId: 'source', title: 'Source', workspace: root, state: 'idle', createdAt: '2026-10-10', updatedAt: '2026-10-10' }], sessionWorkspace: async () => root,
    async create(input, evidence) {
      expect(this).toBe(directory); creates++; await beforeCreate();
      if (rejectNative) throw new AgentOperationRejectedError('operation_rejected', 'Fixture proved no effect');
      if (policy) expect(input.cwd).toBe(root);
      grants.push({ nativeSessionId: nativeId, sourceNativeSessionId: input.sourceNativeSessionId! }); evidence?.completed();
      if (fileGrants) await references.set({ sourceNativeSessionId: input.sourceNativeSessionId!, systemPrompt: '', systemPromptProvided: false,
        instructions: 'Original source instructions', handle: { providerId: 'fixture', sessionId: nativeId, opaque: 'original opaque handle' } });
      if (loseResult) throw new Error('Native result lost'); return nativeId;
    },
    sourceReferences: async () => granted ? fileGrants ? references.list() : structuredClone(grants) : [], setSourceBindingReader: () => {},
    async open(id) { await beforeOpen(id); const session = new Native(id, root); sessions.push(session); return session; },
    close: async () => { closingDirectory(); await Promise.all(sessions.map(session => session.dispose())); },
  };
  const createHost = () => createAgentHostRuntime({ controllerId: 'controller', shutdownTimeoutMs, succession: { controllerId: 'controller', stateDirectory: root, enrollment: true },
    ...(cache ? { operationCache: cache } : {}), ...(policy ? { executionPolicy: { allowedWorkspaceRoots: [root], defaultWorkspace: root, lockPermissions: true } } : {}),
    registrations: [{ directory, adapter: { descriptor: { providerId: 'fixture', displayName: 'Fixture' }, createSession: async () => { throw new Error('unexpected'); }, resumeSession: async () => { throw new Error('unexpected'); } } }] });
  let host = createHost(); closeables.push(() => host.close());
  const request = (n = 1, agentId = 'proposal', scope = 'relay:scope', extra: object = {}) => ({ method: 'POST' as const, path: '/remote/create', sessionId: agentId, operationScope: scope,
    body: JSON.stringify({ providerId: 'fixture', operationId: operationId(n), sourceNativeSessionId: 'source', ...(policy ? { workspaceId: 'workspace' } : {}), ...extra }) });
  const state = async () => JSON.parse(await readFile(join(root, 'roles', 'state.json'), 'utf8'));
  return { root, get host() { return host; }, request, state, grants, directoryClosing, counts: () => ({ creates, certificates }), setCertificate: (value: boolean) => { certificate = value; },
    missingGrant: () => { granted = false; }, loseResult: () => { loseResult = true; }, rejectNative: () => { rejectNative = true; },
    beforeCreate: (hook: typeof beforeCreate) => { beforeCreate = hook; }, beforeOpen: (hook: typeof beforeOpen) => { beforeOpen = hook; },
    restart: async () => { await host.close(); references = new SessionReferenceStore(join(root, 'references'), 'fixture'); host = createHost(); },
    attach: (agentId: string, id = nativeId) => host.control({ method: 'POST', path: '/remote/attach', sessionId: agentId, body: JSON.stringify({ providerId: 'fixture', nativeSessionId: id }) }),
  };
}

test.each([false, true])('a held grant barrier withholds the source result and barrier failure=%s preserves the admitted native operation across exact retry and reopen', async failBarrier => {
  const f = await fixture(true, 'reader', undefined, false, true), original = await vi.importActual<typeof fs>('node:fs/promises');
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === join(f.root, 'references') && args[1] === 'r') vi.spyOn(file, 'sync').mockImplementation(async () => {
      entered(); await gate; if (failBarrier) throw new Error('grant directory sync uncertain');
    });
    return file;
  });
  let returned = false;
  const creating = f.host.enrollFromRelay(f.request(), context).then(response => { returned = true; return response; });
  try {
    await enteredPromise; expect(returned).toBe(false); expect(f.counts().creates).toBe(1);
    expect((await f.state()).associationAdmissions).toHaveLength(1); expect((await f.state()).associationResults).toEqual([]);
    release(); const response = await creating; expect(response.status).toBe(failBarrier ? 503 : 200);
    const state = await f.state(); expect(state.associationResults).toHaveLength(failBarrier ? 0 : 1); expect(state.associationAdmissions).toHaveLength(failBarrier ? 1 : 0);
    expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(failBarrier ? 503 : 200); expect(f.counts().creates).toBe(1);
    vi.mocked(fs.open).mockImplementation(original.open); await f.restart();
    expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(failBarrier ? 503 : 200); expect(f.counts().creates).toBe(1);
    const key = createHash('sha256').update('reader').digest('hex');
    expect(JSON.parse(await readFile(join(f.root, 'references', `${key}.json`), 'utf8'))).toMatchObject({ sourceNativeSessionId: 'source',
      systemPromptProvided: false, instructions: 'Original source instructions', handle: { opaque: 'original opaque handle' } });
  } finally { release(); await creating; }
});

test.each(['missing', 'conflicting', 'poisoned'] as const)('a durable source result with a %s file grant remains unresolved across reopen without native replay', async change => {
  const f = await fixture(true, 'reader', undefined, false, true);
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(200);
  const path = join(f.root, 'references', `${createHash('sha256').update('reader').digest('hex')}.json`);
  if (change === 'missing') await fs.unlink(path);
  else if (change === 'poisoned') await writeFile(path, '{invalid JSON');
  else { const grant = JSON.parse(await readFile(path, 'utf8')); grant.sourceNativeSessionId = 'other'; await writeFile(path, JSON.stringify(grant)); }
  await f.restart();
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503);
  expect((await f.state()).associationResults).toHaveLength(1); expect(f.counts().creates).toBe(1);
});

test('Host close waits for a settled source mutation to publish its clean coverage', async () => {
  const f = await fixture(true), original = await vi.importActual<typeof fs>('node:fs/promises');
  const contextPath = join(f.root, 'contexts', 'context.json');
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(`${contextPath}.`) && args[1] === 'wx' && f.counts().creates === 1) { entered(); await gate; }
    return original.open(...args);
  });
  let closing: Promise<void> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(200);
    await writing;
    expect(JSON.parse(await readFile(contextPath, 'utf8')).coverage).toHaveLength(1);
    const agent = f.host.resolveSession('proposal')!, dispatch = vi.fn(async () => undefined);
    closing = f.host.close();
    await expect(f.host.executeOperation('closing')(agent, { operationId: operationId(2), kind: 'send_message', parameters: { text: 'late' }, maximumResultBytes: 1024 }, { dispatch })).rejects.toMatchObject({ code: 'controller_updating' });
    expect(dispatch).not.toHaveBeenCalled();
    const outcome = await Promise.race([
      closing.then(() => 'closed'),
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('waiting'), 100); }),
    ]);
    expect(outcome).toBe('waiting');
    release(); await closing;
    expect(JSON.parse(await readFile(contextPath, 'utf8')).coverage).toEqual([]);
    const restored = new SessionSuccessionContextStore(join(f.root, 'contexts')); await restored.ready;
    expect(restored.coverageAvailable(ref('source'))).toBe(true);
  } finally {
    if (deadline) clearTimeout(deadline);
    release(); await closing;
    await expect.poll(async () => JSON.parse(await readFile(contextPath, 'utf8')).coverage).toEqual([]);
  }
});

test('Host close evaluates pending coverage before disposing the cache that retains another unresolved mutation', async () => {
  const f = await fixture(true);
  const clear = SessionSuccessionContextStore.prototype.clearMutation;
  let entered!: () => void, release!: () => void;
  const clearing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(SessionSuccessionContextStore.prototype, 'clearMutation').mockImplementation(async function (this: SessionSuccessionContextStore, ...args) {
    entered(); await gate; return clear.apply(this, args);
  });
  let closing: Promise<void> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(200); await clearing;
    f.beforeCreate(async () => { throw new Error('Native create outcome unknown'); });
    expect((await f.host.enrollFromRelay(f.request(2, 'second'), context)).status).toBe(503);
    closing = f.host.close();
    const phase = await Promise.race([
      f.directoryClosing.then(() => 'disposing'),
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('draining'), 100); }),
    ]);
    release(); await closing;
    const restored = new SessionSuccessionContextStore(join(f.root, 'contexts')); await restored.ready;
    expect(restored.coverageAvailable(ref('source'))).toBe(false);
    expect(phase).toBe('draining');
  } finally { if (deadline) clearTimeout(deadline); release(); await closing; spy.mockRestore(); }
});

test('a coverage callback resumed after the Host shutdown deadline cannot infer clean state from a disposed cache', async () => {
  const f = await fixture(true, 'reader', undefined, false, false, 40);
  const clear = SessionSuccessionContextStore.prototype.clearMutation;
  let entered!: () => void, release!: () => void, finished!: () => void;
  const clearing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const cleared = new Promise<void>(resolve => { finished = resolve; });
  const spy = vi.spyOn(SessionSuccessionContextStore.prototype, 'clearMutation').mockImplementation(async function (this: SessionSuccessionContextStore, ...args) {
    entered(); await gate;
    try { return await clear.apply(this, args); } finally { finished(); }
  });
  try {
    expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(200); await clearing;
    f.beforeCreate(async () => { throw new Error('Native create outcome unknown'); });
    expect((await f.host.enrollFromRelay(f.request(2, 'second'), context)).status).toBe(503);
    await f.host.close(); await f.directoryClosing;
    release(); await cleared;
    const restored = new SessionSuccessionContextStore(join(f.root, 'contexts')); await restored.ready;
    expect(restored.coverageAvailable(ref('source'))).toBe(false);
  } finally { release(); await cleared; spy.mockRestore(); }
});

test('source-result directory uncertainty after the grant barrier recovers only its exact result on fresh reopen', async () => {
  const f = await fixture(true, 'reader', undefined, false, true), original = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await original.open(...args);
    if (args[0] === join(f.root, 'roles') && args[1] === 'r' && f.counts().creates === 1) vi.spyOn(file, 'sync').mockRejectedValue(new Error('complete result barrier uncertain'));
    return file;
  });
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503);
  expect((await f.state()).associationResults).toHaveLength(1); expect((await f.state()).associationAdmissions).toEqual([]);
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503); expect(f.counts().creates).toBe(1);
  vi.mocked(fs.open).mockImplementation(original.open); await f.restart();
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(200); expect(f.counts().creates).toBe(1);
});

test.each([false, undefined])('fresh trusted v2 source creation requires its own directory certificate=%s', async certificate => {
  const f = await fixture(certificate);
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(400); expect(JSON.parse(response.body).code).toBe('unsupported_configuration');
  expect(f.counts().creates).toBe(0);
  await expect(f.state()).rejects.toMatchObject({ code: 'ENOENT' });
});

test('qualified admission is persisted before any directory native effect and policy certifies the normalized owning input', async () => {
  const f = await fixture(true, '\ud800'.repeat(512), { maxResultBytes: 3074 }, true);
  f.beforeCreate(async () => {
    const saved = await f.state();
    expect(saved.associationResults).toEqual([]);
    expect(saved.associationAdmissions[0].sourceWitness).toEqual({ version: 1, scope: 'relay:scope', operationId: operationId() });
  });
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status, response.body).toBe(200); expect(JSON.parse(response.body).nativeSessionId).toBe('\ud800'.repeat(512));
  const saved = await f.state(); expect(saved.associationAdmissions).toEqual([]); expect(saved.associationResults[0].reader).toEqual(ref('\ud800'.repeat(512)));
  expect(f.counts()).toEqual({ creates: 1, certificates: 1 });
});

test('ordinary local, legacy and forged-body source paths do not require a certificate', async () => {
  const f = await fixture(undefined);
  expect((await f.host.control(f.request(1, 'local', 'relay:forged', { context, sourceWitness: { version: 1 }, successionEnrollmentVersion: 2 }))).status).toBe(200);
  expect((await f.host.enrollFromRelay(f.request(2, 'legacy'), { ...context, successionEnrollmentVersion: 1 })).status).toBe(200);
  expect(f.counts()).toEqual({ creates: 2, certificates: 0 });
  expect((await f.state()).associationResults).toHaveLength(2);
});

test('trusted create rejects another Controller installation before dispatch', async () => {
  const f = await fixture(true);
  const response = await f.host.enrollFromRelay(f.request(), { ...context, installationId: 'other' });
  expect(response.status).toBe(403); expect(f.counts().creates).toBe(0);
});

test.each(['', ' '.repeat(3), 'a'.repeat(513)])('qualified proposed Agent identity %j is rejected before producer invocation', async proposal => {
  const f = await fixture(true);
  const response = await f.host.enrollFromRelay(f.request(1, proposal), context);
  expect(response.status).toBe(400); expect(JSON.parse(response.body).code).toBe('invalid_request'); expect(f.counts().creates).toBe(0);
});

test.each(['x'.repeat(513), '\u0000', '   '])('a certified producer violating its ID bound keeps unknown admission and never repeats create', async nativeId => {
  const f = await fixture(true, nativeId);
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(503); expect(JSON.parse(response.body).code).toBe('operation_outcome_unknown');
  const saved = await f.state(); expect(saved.associationAdmissions).toHaveLength(1); expect(saved.associationResults).toEqual([]); expect(f.grants).toHaveLength(1);
  f.setCertificate(false); await f.restart();
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503); expect(f.counts().creates).toBe(1);
});

test.each(['restart', 'expiry'])('exact legacy escaped-ID recovery after %s uses actual cache bytes without a new certificate or identity rewriting', async recovery => {
  let now = 0;
  const f = await fixture(undefined, '\ud800'.repeat(512), { maxResultBytes: 3074, ttlMs: 1, now: () => now });
  const legacy = await f.host.control(f.request());
  expect(legacy.status).toBe(503); expect(JSON.parse(legacy.body).code).toBe('operation_outcome_unknown');
  expect((await f.state()).associationResults[0].reader).toEqual(ref('\ud800'.repeat(512)));
  if (recovery === 'restart') await f.restart(); else now = 2;
  const alias = 'legacy-wide-'.repeat(60);
  expect((await f.attach(alias)).status).toBe(200);
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status, response.body).toBe(200); expect(JSON.parse(response.body)).toEqual({ agentId: alias, nativeSessionId: '\ud800'.repeat(512) });
  expect(f.counts()).toEqual({ creates: 1, certificates: 0 });
});

test.each(['missing', 'conflicting'])('an exact witness with %s source grant blocks recovery without native replay', async grant => {
  const f = await fixture(false);
  expect((await f.host.control(f.request())).status).toBe(200);
  if (grant === 'missing') f.missingGrant(); else f.grants[0]!.sourceNativeSessionId = 'other';
  await f.restart();
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503);
  expect((await f.state()).associationResults).toHaveLength(1); expect(f.counts().creates).toBe(1);
});

test.each([
  { pending: false, wide: false }, { pending: true, wide: false },
  { pending: false, wide: true }, { pending: true, wide: true },
])('qualified projection checks actual canonical identity with %j and preserves unrelated pending work', async mode => {
  const f = await fixture(true), alias = mode.wide ? 'wide'.repeat(200) : 'canonical';
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  if (mode.pending) f.beforeOpen(async () => { enter(); await gate; });
  const attaching = f.attach(alias); let attached = false;
  void attaching.then(() => { attached = true; });
  if (mode.pending) await entered; else expect((await attaching).status).toBe(200);
  try {
    const creating = f.host.enrollFromRelay(f.request(), context);
    if (!mode.wide) release();
    const response = await creating;
    expect(response.status, response.body).toBe(mode.wide ? 503 : 200);
    if (mode.wide) {
      expect(JSON.parse(response.body).code).toBe('mutation_outcome_unknown');
      if (mode.pending) expect(attached).toBe(false);
    } else expect(JSON.parse(response.body).agentId).toBe(alias);
    const saved = await f.state(); expect(saved.associationResults[0].reader).toEqual(ref('reader')); expect(saved.associationAdmissions).toEqual([]);
    release(); expect((await attaching).status).toBe(200);
    expect(f.host.resolveSession(alias)).toBeDefined(); expect(f.counts().creates).toBe(1);
  } finally { release(); await attaching; }
});

test('private role-file capacity refusal is authoritative before directory create and leaves no witness admission', async () => {
  const f = await fixture(true);
  await f.host.control({ method: 'GET', path: '/remote/providers' });
  const saved: any = { version: 8, roles: [], associationAdmissions: [], associationResults: [] };
  const desired = SUCCESSION_STORE_BYTES - 1000;
  while (jsonBytes(saved) < desired - 17000) {
    const n = saved.associationResults.length;
    saved.associationResults.push({ id: `fill-${n}`, fingerprint: 'fingerprint', scope: 'x'.repeat(16384), operationId: `fill-${n}`, source: ref('other-source'), reader: ref('other-reader') });
  }
  saved.associationResults.push({ id: 'last', fingerprint: 'fingerprint', scope: 'x', operationId: 'last', source: ref('other-source'), reader: ref('other-reader') });
  saved.associationResults.at(-1).scope += 'x'.repeat(desired - jsonBytes(saved));
  const path = join(f.root, 'roles', 'state.json'); await writeFile(path, JSON.stringify(saved)); await f.restart();
  const effect = vi.spyOn(directoryMutation, 'directoryNativeEffect');
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status, response.body).toBe(429); expect(JSON.parse(response.body).code).toBe('operation_capacity_exceeded');
  expect(f.counts()).toEqual({ creates: 0, certificates: 1 }); expect(await f.state()).toEqual(saved);
  expect(effect).not.toHaveBeenCalled();
});

test('cache capacity independently refuses a qualified create before witness or native work', async () => {
  const f = await fixture(true, 'reader', { maxResultBytes: 3073 });
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(400); expect(JSON.parse(response.body).code).toBe('operation_result_too_large');
  expect(f.counts().creates).toBe(0); await expect(f.state()).rejects.toMatchObject({ code: 'ENOENT' });
});

test('legacy pending without an exact result remains unknown even when certification is absent', async () => {
  const f = await fixture(undefined); await f.host.control({ method: 'GET', path: '/remote/providers' });
  const id = createHash('sha256').update(JSON.stringify(['relay:scope', operationId()])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([JSON.stringify(['controller', 'fixture', 'source']), [['sourceNativeSessionId', 'source']]])).digest('hex');
  await writeFile(join(f.root, 'roles', 'state.json'), JSON.stringify({ version: 5, roles: [], associationResults: [], associationAdmissions: [{ id, fingerprint, source: ref('source'), sourceReader: true }] }));
  await f.restart(); const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(503); expect(f.counts()).toEqual({ creates: 0, certificates: 0 });
  expect((await f.state()).associationAdmissions[0].sourceWitness).toBeUndefined();
});

test.each(['grant', 'result'])('post-native %s uncertainty retains admission and does not become a safe refusal on restart', async failure => {
  const f = await fixture(true);
  if (failure === 'grant') f.missingGrant(); else f.loseResult();
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(503); expect(JSON.parse(response.body).code).toBe('operation_outcome_unknown');
  expect((await f.state()).associationAdmissions).toHaveLength(1);
  await f.restart(); f.setCertificate(false);
  expect((await f.host.enrollFromRelay(f.request(), context)).status).toBe(503); expect(f.counts().creates).toBe(1);
});

test('an awaited proven-no-effect native refusal removes only its matching admission', async () => {
  const f = await fixture(true); f.rejectNative();
  const response = await f.host.enrollFromRelay(f.request(), context);
  expect(response.status).toBe(400); expect(JSON.parse(response.body).code).toBe('operation_rejected');
  expect((await f.state()).associationAdmissions).toEqual([]); expect((await f.state()).associationResults).toEqual([]);
});
