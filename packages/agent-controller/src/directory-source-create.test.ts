import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { CodexAppServerProvider } from '../../agent-provider-codex/src/provider.js';
import type { CodexAppServerProviderOptions } from '../../agent-provider-codex/src/provider.js';
import { ClaudeAgentProvider } from '../../agent-provider-claude/src/provider.js';
import { CopilotAgentProvider } from '../../agent-provider-copilot/src/provider.js';
import { OpenCodeAgentProvider } from '../../agent-provider-opencode/src/provider.js';
import { createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { createCodexSessionDirectory } from './directory.js';
import { createManagedStdioDirectory } from './stdio-directory.js';
import { createOpenCodeSessionDirectory } from './opencode-directory.js';
import { SessionReferenceStore } from './session-reference.js';

const providers = ['codex', 'claude', 'copilot', 'opencode'] as const;
type Provider = typeof providers[number];
const context: TrustedSuccessionContext = { installationId: 'controller', successionEnrollmentVersion: 2,
  authority: { version: 1, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' } };

function producerLimit(providerId: Provider): number | undefined {
  const provider = providerId === 'codex' ? new CodexAppServerProvider()
    : providerId === 'claude' ? new ClaudeAgentProvider()
    : providerId === 'copilot' ? new CopilotAgentProvider({ executable: 'copilot' })
    : new OpenCodeAgentProvider();
  return (provider as { readonly createdSessionIdMaxLength?: number }).createdSessionIdMaxLength;
}

test('Codex creation certification keeps its selected producer fixed when caller options change', () => {
  const standard: CodexAppServerProviderOptions = {}, custom: CodexAppServerProviderOptions = { spawn: async () => { throw new Error('Uncertified producer'); } };
  const declared = new CodexAppServerProvider(standard), undeclared = new CodexAppServerProvider(custom);
  standard.spawn = custom.spawn; delete custom.spawn;
  expect(declared.createdSessionIdMaxLength).toBe(36);
  expect(undeclared.createdSessionIdMaxLength).toBeUndefined();
}, 1000);

/** Actual directories and Host admission; the controlled port replaces only native process effects. */
function fixture(providerId: Provider, root: string, initialLimit = producerLimit(providerId)) {
  const nativeSessionId = providerId === 'opencode' ? 'ses_0123456789abcdefghijklmnop' : randomUUID();
  let creates = 0, limit = initialLimit, config: AgentSessionConfig | undefined;
  const native = (id: string): AgentSession => {
    let closed = false, finish: (() => void) | undefined;
    return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: false, toolApproval: false, planApproval: false } },
    async runtimeInfo() { return { providerId, sessionId: id, cwd: root, status: closed ? 'closed' : 'idle',
      persistence: { providerId, sessionId: id, opaque: JSON.stringify({ cwd: root }) } }; },
    async *observe(): AsyncIterable<ProviderStreamItem> {
      yield { type: 'history_boundary' }; if (!closed) await new Promise<void>(resolve => { finish = resolve; });
    },
    async sendMessage() {}, async respondToInteraction() {}, async dispose() { closed = true; finish?.(); } };
  };
  const adapter: AgentProviderAdapter = { descriptor: { providerId, displayName: providerId },
    async createSession(input) { creates++; config = input; return native(nativeSessionId); },
    async resumeSession(handle) { return native(handle.sessionId); },
    async readSessionHistory() { return { entries: [{ id: 'source-entry', turnId: 'source-turn', role: 'user',
      text: 'Source requirement', textOffset: 0, totalChars: 18 }] }; },
  };
  const producer = { ...adapter, get createdSessionIdMaxLength() { return limit; },
    async readSessionWorkspace() { return root; }, async sessionWorkspace() { return root; },
    async openChildSession() { throw new Error('Child creation is outside this test'); },
    async getSession(id: string) { return { id, title: id, cwd: root, updatedAt: new Date().toISOString() }; },
    async renameSession() {}, async close() {},
  };
  let directory: AgentHostDirectory;
  function openHost() {
    const references = new SessionReferenceStore(join(root, 'references'), providerId);
    const workspaces = [{ id: 'workspace', name: 'Workspace', path: root }];
    directory = providerId === 'codex'
      ? createCodexSessionDirectory({ ...producer, get createdSessionIdMaxLength() { return limit; }, listSessions: async () => ({ sessions: [] }) }, workspaces, references)
      : providerId === 'opencode'
        ? createOpenCodeSessionDirectory({ ...producer, get createdSessionIdMaxLength() { return limit; }, listSessions: async () => [] }, workspaces, references, true)
        : createManagedStdioDirectory(providerId, providerId, { ...producer, get createdSessionIdMaxLength() { return limit; }, listSessions: async () => [] }, workspaces, undefined, references);
    return createAgentHostRuntime({ controllerId: 'controller', succession: { controllerId: 'controller', stateDirectory: join(root, 'succession'), enrollment: true },
      executionPolicy: { allowedWorkspaceRoots: [root], defaultWorkspace: root, lockPermissions: true },
      registrations: [{ adapter, directory }] });
  }
  let host = openHost();
  const request = { method: 'POST' as const, path: '/remote/create', sessionId: 'proposed-agent', operationScope: 'relay:scope',
    body: JSON.stringify({ providerId, operationId: randomUUID(), sourceNativeSessionId: 'source', workspaceId: 'workspace' }) };
  return { nativeSessionId, request, get host() { return host; }, get directory() { return directory; },
    creates: () => creates, setLimit: (value: number | undefined) => { limit = value; }, config: () => config!,
    restart: async () => { await host.close(); host = openHost(); },
    close: () => host.close(),
  };
}

test.each(providers)('%s production directory admits a trusted v2 source create and recovers the exact result without native replay', async providerId => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'directory-source-create-'))), f = fixture(providerId, root);
  try {
    const result = await f.host.enrollFromRelay(f.request, context);
    expect(result.status, result.body).toBe(200);
    expect(f.creates()).toBe(1);
    expect(await f.directory.sourceReferences!()).toEqual([{ nativeSessionId: f.nativeSessionId, sourceNativeSessionId: 'source' }]);
    expect(JSON.parse(await f.config().tools!.find(tool => tool.name === 'read_source_session')!.execute({}))).toMatchObject({
      sourceSessionId: 'source', entries: [expect.objectContaining({ text: 'Source requirement' })],
    });
    const state = JSON.parse(await readFile(join(root, 'succession', 'roles', 'state.json'), 'utf8'));
    expect(state.associationResults).toHaveLength(1);
    expect(state.associationAdmissions).toEqual([]);
    f.setLimit(undefined); await f.restart();
    const restored = await f.host.enrollFromRelay(f.request, context);
    expect(restored.status, restored.body).toBe(200);
    expect(JSON.parse(restored.body).nativeSessionId).toBe(f.nativeSessionId);
    expect(f.creates()).toBe(1);
  } finally { await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);

test.each(providers)('%s directory refuses undeclared or unbounded native producers before source creation', async providerId => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'directory-source-reject-'))), f = fixture(providerId, root);
  try {
    for (const limit of [undefined, 0, -1, 1.5, NaN, 513]) {
      f.setLimit(limit);
      expect(await f.directory.supportsBoundedSourceCreate?.({ sourceNativeSessionId: 'source' })).toBe(false);
    }
    const result = await f.host.enrollFromRelay(f.request, context);
    expect(result.status).toBe(400); expect(JSON.parse(result.body).code).toBe('unsupported_configuration');
    expect(f.creates()).toBe(0);
    f.setLimit(36);
    expect(await f.directory.supportsBoundedSourceCreate?.({})).toBe(false);
    expect(await f.directory.supportsBoundedSourceCreate?.({ sourceNativeSessionId: 'source', editNativeSessionId: 'edited', editTurnId: 'turn', editMessageId: 'message' })).toBe(false);
    expect(await f.directory.supportsBoundedSourceCreate?.({ sourceNativeSessionId: 'source' })).toBe(true);
    await f.close();
    expect(await f.directory.supportsBoundedSourceCreate?.({ sourceNativeSessionId: 'source' })).toBe(false);
  } finally { await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 10000);
