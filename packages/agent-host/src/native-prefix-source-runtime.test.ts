import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { AgentSession, AgentSessionExtensions, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { createCodexSessionDirectory } from './directory.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { SessionReferenceStore } from './session-reference.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { createHostExecutionPolicy } from './execution-policy.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 5000);
for (const providerId of ['codex', 'opencode'] as const) test.each(['side', 'ask'] as const)(`${providerId} default-policy Host preserves %s source tools, release fencing and restart`, async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-prefix-source-runtime-')));
  const executionPolicy = await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: root });
  expect(executionPolicy).toBeDefined();
  let sourceWorkspace = root;
  const references = new SessionReferenceStore(join(root, 'grants'), providerId);
  await references.set({ sourceNativeSessionId: 'source', systemPrompt: 'saved source prompt', handle: { providerId, sessionId: 'A', opaque: '{}' } });
  const bound = new Map<string, AgentSessionExtensions>(); let forks = 0;
  class Native implements AgentSession {
    capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
    private stop?: () => void;
    constructor(readonly id: string) {}
    promptEditEvidence = { version: 1 as const, inspectReadiness: async () => ({ cwd: root, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }), captureValidity: () => ({}) as never, isCurrent: () => true };
    async runtimeInfo() { return { providerId, sessionId: this.id, cwd: root, status: 'idle', persistence: { providerId, sessionId: this.id, opaque: 'original' } }; }
    async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await new Promise<void>(resolve => { this.stop = resolve; }); }
    async sendMessage() {} async respondToInteraction() {} async dispose() { this.stop?.(); }
  }
  const provider = { createdSessionIdMaxLength: 36, validatePromptEdit: async () => {}, verifyPromptEditBranch: async () => {}, forkForPromptEdit: async (_target: unknown, extensions: AgentSessionExtensions = {}) => { forks++; const id = forks === 1 ? 'B' : 'source-prefix'; bound.set(id, extensions); return new Native(id); }, createSession: async () => new Native('unused'), openChildSession: async () => new Native('unused'), resumeSession: async (handle: { sessionId: string }, extensions: AgentSessionExtensions = {}) => { bound.set(handle.sessionId, extensions); return new Native(handle.sessionId); }, readSessionWorkspace: async (id: string) => id === 'source' ? sourceWorkspace : root, readSessionHistory: async () => ({ entries: [{ id: 'entry', turnId: 'turn', role: 'assistant', text: 'source history' }] }), getSession: async (id: string) => ({ id, cwd: id === 'source' ? sourceWorkspace : root, title: id }), renameSession: async () => {}, close: async () => {} };
  let latestDirectory: AgentHostDirectory;
  const make = () => {
    const directory = providerId === 'codex' ? createCodexSessionDirectory({ ...provider, listSessions: async () => ({ sessions: [] }) }, [], references) : createOpenCodeSessionDirectory({ ...provider, listSessions: async () => [] }, [], references, true);
    latestDirectory = directory;
    return createAgentHostRuntime({ executionPolicy, succession: { controllerId: 'host', stateDirectory: root, enrollment: true }, registrations: [{ directory, adapter: { descriptor: { providerId, displayName: providerId }, createSession: provider.createSession, resumeSession: provider.resumeSession, readSessionHistory: provider.readSessionHistory } }] });
  };
  let host = make();
  const http = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk;
    const result = request.url === '/enroll' ? await host.enrollFromRelay({ method: 'POST', path: '/remote/succession/enrollment', body }, context) : await host.control({ method: 'POST', path: request.url!, body, sessionId: request.headers['x-agent'] as string | undefined });
    response.statusCode = result.status; response.end(result.body);
  })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const authority = { version: 1 as const, origin, issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
  const context = { authority, installationId: 'host', successionEnrollmentVersion: 3 as const };
  const post = async (path: string, input: unknown, agent?: string) => { const response = await fetch(origin + path, { method: 'POST', headers: agent ? { 'x-agent': agent } : {}, body: JSON.stringify(input), signal: AbortSignal.timeout(3000) }); return { status: response.status, data: await response.json() }; };
  cleanup.push(async () => { http.closeIdleConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await host.close(); await rm(root, { recursive: true, force: true }); });
  expect((await post('/remote/attach', { providerId, nativeSessionId: 'A' }, 'A')).status).toBe(200);
  const stale = bound.get('A')!.tools![0]!;
  const described = await post('/enroll', { action: 'describe', providerId, nativeSessionId: 'A', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } });
  expect(described.status).toBe(200);
  const from = { controllerId: 'host', providerId, nativeSessionId: 'A' };
  const freeze = { version: 3 as const, token: 'freeze', authority, controllerId: 'host', maxProjectionBytes: 2 * 1024 * 1024, associationRevision: 0, lineage: [from], relations: [{ relationId: 'relation', kind, readerRef: from, sourceRef: { ...from, nativeSessionId: 'source' }, linked: true, revision: 0 }], request: { roleId: described.data.role.id, operationId: 'prefix', expectedRevision: 1, from, preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } } };
  const prepared = await post('/enroll', { action: 'prepare', freeze });
  expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 200, data: { record: { phase: 'ready' } } });
  await expect(bound.get('B')!.tools![0]!.execute({})).rejects.toThrow(/current|reserved|admission/);
  const activeB = bound.get('B')!.tools![0]!;
  // A different process can reconstruct the exact preparation attachment without granting execution.
  const restoredCandidate = make();
  try {
    await expect(latestDirectory!.open('B', { nativePrefix: { providerId, sessionId: 'B', opaque: 'forged' }, extensions: {} })).rejects.toThrow(/exact saved/);
    const response = await restoredCandidate.control({ method: 'POST', path: '/remote/attach', sessionId: 'candidate', body: JSON.stringify({ providerId, nativeSessionId: 'B' }) });
    expect(response.status, response.body).toBe(200);
    await expect(bound.get('B')!.tools![0]!.execute({})).rejects.toThrow(/current|reserved|admission/);
  } finally { await restoredCandidate.close(); }
  expect(await post('/enroll', { action: 'commit', freeze })).toMatchObject({ status: 200, data: { record: { phase: 'committed' } } });
  await expect(activeB.execute({})).rejects.toThrow(/reserved|admission/);
  expect((await post('/enroll', { action: 'release', freeze })).status).toBe(200);
  expect(JSON.parse(await activeB.execute({}))).toMatchObject({ sourceSessionId: 'source' });
  await host.close(); host = make();
  expect((await post('/remote/attach', { providerId, nativeSessionId: 'B' }, 'B')).status).toBe(200);
  expect(JSON.parse(await bound.get('B')!.tools![0]!.execute({}))).toMatchObject({ sourceSessionId: 'source' });
  await expect(stale.execute({})).rejects.toThrow(/current/);
  sourceWorkspace = await realpath(tmpdir());
  await expect(bound.get('B')!.tools![0]!.execute({})).rejects.toThrow(/workspace|allowed roots/i);
  sourceWorkspace = root;
  expect(JSON.parse(await bound.get('B')!.tools![0]!.execute({}))).toMatchObject({ sourceSessionId: 'source' });
  expect(forks).toBe(1); expect(await references.list()).toEqual([{ nativeSessionId: 'A', sourceNativeSessionId: 'source' }]);
  const store = new SessionSuccessionStore(join(root, 'roles')); await store.ready;
  expect(store.read(freeze.request.roleId).participants).toEqual([]);
  expect(store.read(freeze.request.roleId).enrollments![0]!.relations).toEqual(freeze.relations);
  const sourceDescription = await post('/enroll', { action: 'describe', providerId, nativeSessionId: 'source', preparation: freeze.request.preparation });
  expect(sourceDescription.status).toBe(200);
  const source = { ...from, nativeSessionId: 'source' };
  const sourceFreeze = { ...freeze, token: 'source-freeze', lineage: [source], request: { ...freeze.request, roleId: sourceDescription.data.role.id, operationId: 'source-prefix', from: source } };
  const sourcePrepared = await post('/enroll', { action: 'prepare', freeze: sourceFreeze });
  expect(sourcePrepared, JSON.stringify(sourcePrepared)).toMatchObject({ status: 200, data: { record: { phase: 'ready', prepared: { participants: [{ kind, before: from, after: from }] } } } });
  expect(await references.list()).toEqual([{ nativeSessionId: 'A', sourceNativeSessionId: 'source' }]);
  expect((await post('/enroll', { action: 'cancel', freeze: sourceFreeze })).status).toBe(200);
  expect((await post('/enroll', { action: 'release', freeze: sourceFreeze })).status).toBe(200);
}, 10000);
