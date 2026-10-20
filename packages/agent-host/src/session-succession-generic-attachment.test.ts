import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { AgentSession, AgentSessionExtensions, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { createAgentHostRuntime } from './host.js';
import { createCodexSessionDirectory } from './directory.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { LocalSessionSuccession } from './local-session-runtime.js';
import { SessionReferenceStore } from './session-reference.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { TpmStore } from './tpm-store.js';
import { TpmCoordinator } from './tpm.js';
import { TeamRuntime } from './team.js';
import { SessionSuccessionService } from './session-succession-service.js';

const ref = (providerId: string, nativeSessionId: string) => ({ controllerId: 'host', providerId, nativeSessionId });
async function commitGeneric(store: SessionSuccessionStore, providerId: string, cwd: string) {
  await store.ready;
  const workspace = { controllerId: 'host', canonicalCwd: cwd };
  await store.createRole({ id: 'role', origin: ref(providerId, 'A'), current: ref(providerId, 'A'), revision: 1, workspace });
  const request = { operationId: 'generic', roleId: 'role', expectedRevision: 1, from: ref(providerId, 'A') };
  await store.begin(request);
  await store.advance(request.operationId, 'preparing', { phase: 'quiescing', to: ref(providerId, 'B') });
  await store.advance(request.operationId, 'quiescing', { phase: 'transferring' });
  await store.advance(request.operationId, 'transferring', { phase: 'ready', prepared: { ...request, to: ref(providerId, 'B'), workspace, associationRevision: 0, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } });
  await store.commit(request.operationId);
}

async function seedExecutionRole(root: string, providerId: string, role: 'none' | 'team' | 'tpm') {
  const teamDirectory = join(root, 'team'), tpmDirectory = join(root, 'tpm');
  if (role === 'team') {
    const seat = { teamId: 'team', source: { hostId: 'relay-host', providerId, nativeSessionId: 'source', title: 'Source' }, member: { id: 'member', hostId: 'relay-host', providerId, nativeSessionId: 'A', role: 'leader', name: 'Role', responsibility: 'Verify', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 } };
    await mkdir(teamDirectory); await writeFile(join(teamDirectory, 'seats.json'), JSON.stringify([{ seat, creation: 'ready', receipts: {} }]));
  }
  if (role === 'tpm') {
    const store = new TpmStore(tpmDirectory); await store.ready;
    await store.insert({ version: 1, createKey: 'key', createFingerprint: 'hash', creation: 'accepted', requirement: 'Verify', dirty: false, lastReviewAt: 0, actions: {}, work: { id: 'work', revision: 1, title: 'Work', providerId, mainNativeSessionId: 'source', tpmNativeSessionId: 'A', phase: 'clarifying', waiting: 'user', paused: true, delegated: true, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', nextCheckAt: 0, outbox: [] } });
  }
}

function providerFixture(providerId: string, root: string) {
  const bound = new Map<string, AgentSessionExtensions>();
  class Native implements AgentSession {
    capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } };
    private stop?: () => void;
    constructor(readonly id: string) {}
    async runtimeInfo() { return { providerId, sessionId: this.id, cwd: root, status: 'idle', persistence: { providerId, sessionId: this.id, opaque: '{}' } }; }
    async *observe(): AsyncIterable<ProviderStreamItem> { yield { type: 'history_boundary' }; await new Promise<void>(resolve => { this.stop = resolve; }); }
    async sendMessage() {} async respondToInteraction() {} async dispose() { this.stop?.(); }
  }
  const provider = {
    descriptor: { providerId, displayName: providerId, sessionExtensions: { instructions: true, tools: true } },
    createdSessionIdMaxLength: 36,
    async createSession() { throw new Error('Native creation is outside this attachment test.'); },
    async resumeSession(handle: { sessionId: string }, extensions: AgentSessionExtensions = {}) { bound.set(handle.sessionId, extensions); return new Native(handle.sessionId); },
    async openChildSession() { throw new Error('Native child creation is outside this attachment test.'); },
    async readSessionHistory() { return { entries: [] }; }, async readSessionWorkspace() { return root; },
    async getSession(id: string) { return { id, cwd: root, title: id }; }, async renameSession() {}, async close() {},
  };
  return { provider, bound };
}

for (const providerId of ['codex', 'opencode'] as const) for (const role of ['none', 'team', 'tpm'] as const) test.each(['A', 'B'])(
  `${providerId} HTTP cold attach %s after generic succession does not require or inherit ${role} execution tools`, async nativeSessionId => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-generic-attachment-')));
    const teamDirectory = join(root, 'team'), tpmDirectory = join(root, 'tpm');
    await commitGeneric(new SessionSuccessionStore(join(root, 'roles')), providerId, root);
    await seedExecutionRole(root, providerId, role);
    const { provider, bound } = providerFixture(providerId, root), references = new SessionReferenceStore(join(root, 'references'), providerId);
    const directory = providerId === 'codex'
      ? createCodexSessionDirectory({ ...provider, listSessions: async () => ({ sessions: [] }) }, [], references)
      : createOpenCodeSessionDirectory({ ...provider, listSessions: async () => [] }, [], references, true);
    const host = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: root },
      team: { stateDirectory: teamDirectory, tickMs: 1_000_000, request: async () => [] },
      tpm: { stateDirectory: tpmDirectory, tickMs: 1_000_000 }, registrations: [{ directory, adapter: provider }] });
    const server = createServer((request, response) => { void (async () => {
      let body = ''; for await (const chunk of request) body += chunk;
      const result = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'history', body });
      response.statusCode = result.status; response.end(result.body);
    })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/remote/attach`, { method: 'POST', body: JSON.stringify({ providerId, nativeSessionId }), signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const agent = host.resolveSession(JSON.parse(body).agentId)!;
      expect(agent.snapshot().payload.runtimeInfo.sessionId).toBe(nativeSessionId);
      expect(bound.get(nativeSessionId)?.tools ?? []).toEqual([]);
      expect(() => host.executionRouting!.resolve(ref(providerId, 'A'))).toThrow(/generic succession/);
      expect(host.executionRouting!.resolve(ref(providerId, 'B')).target).toEqual(ref(providerId, 'B'));
      expect(await references.list()).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 10000);

test('local resumed generic successor has its own attachment without inherited source tools', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-local-generic-')));
  const { provider, bound } = providerFixture('codex', root);
  const local = new LocalSessionSuccession(root, 'host', [provider]);
  try {
    await local.service.ready; await commitGeneric(local.service.store, 'codex', root);
    const session = await local.providers[0]!.resumeSession({ providerId: 'codex', sessionId: 'B', opaque: '{}' });
    expect((await session.runtimeInfo()).sessionId).toBe('B');
    expect(bound.get('B')?.tools ?? []).toEqual([]);
    expect(() => local.service.executionRouting.resolve(ref('codex', 'A'))).toThrow(/generic succession/);
  } finally { await local.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 5000);


test.each(['team', 'tpm'] as const)('retained %s tools cannot execute on a predecessor after generic succession', async role => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-generic-role-')));
  await seedExecutionRole(root, 'codex', role);
  const unavailable = async (): Promise<never> => { throw new Error('No native effects are expected for role authorization.'); };
  const service = new SessionSuccessionService(root, 'host', {
    supports: async () => false, inspect: unavailable, createIdle: unavailable,
    captureTimeline: unavailable, authorizeRead: unavailable, readHistory: unavailable, reconcileDelivery: async () => undefined,
  });
  const access = { controllerId: 'host', sessionRouting: service.executionRouting, available: () => true,
    supportedProviders: () => ['codex'], acquire: unavailable, create: unavailable, execute: unavailable };
  const team = { id: 'team', operationId: 'create', title: 'Team', revision: 1, status: 'active', createdAt: 1, updatedAt: 1,
    source: { hostId: 'relay-host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' },
    members: [{ id: 'member', hostId: 'relay-host', providerId: 'codex', nativeSessionId: 'A', role: 'leader', name: 'Role', responsibility: 'Verify', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }],
    messages: [] };
  const runtime = role === 'team'
    ? new TeamRuntime(join(root, 'team'), access, async () => team, 1_000_000)
    : new TpmCoordinator({ stateDirectory: join(root, 'tpm'), tickMs: 1_000_000 }, access);
  try {
    await service.ready; await runtime.ready;
    const extensions = await runtime.extensions('codex', 'A');
    const retained = extensions!.tools!.find(tool => tool.name === (role === 'team' ? 'read_team' : 'read_work'))!;
    expect(JSON.parse(await retained.execute({})).id).toBe(role === 'team' ? 'team' : 'work');
    await commitGeneric(service.store, 'codex', root);
    await expect(retained.execute({})).rejects.toThrow(/generic succession/);
    await expect(runtime.extensions('codex', 'A')).resolves.toBeUndefined();
    await expect(runtime.extensions('codex', 'B')).resolves.toBeUndefined();
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 5000);
