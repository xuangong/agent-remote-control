import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { createHostBroker, type RelaySocket } from '../../agent-remote-hosted/src/index.js';
import type { AgentCapabilities, AgentInteractionResponse, AgentProviderAdapter, AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createCodexSessionDirectory } from './directory.js';
import { createAgentHost, createAgentHostRuntime, type AgentHostDirectory, type AgentHostUplinkDiagnostic } from './host.js';
import { CodexAppServerProvider } from '../../agent-provider-codex/src/provider.js';
import { CodexAppServerTransport } from '../../agent-provider-codex/src/app-server-transport.js';
import { createScriptedAppServer } from '../../agent-provider-codex/src/test-utils/scripted-app-server.js';

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

function operationId(label: string): string {
  let suffix = 0;
  for (const codePoint of label) suffix = (suffix * 31 + codePoint.codePointAt(0)!) >>> 0;
  return `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

class Session implements AgentSession {
  readonly capabilities: AgentCapabilities;
  disposed = false;
  observeCount = 0;
  readonly sentMessages: string[] = [];
  readonly interactionResponses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];
  private readonly queued: ProviderStreamItem[];
  private waiter: ((item: ProviderStreamItem | undefined) => void) | undefined;
  constructor(readonly providerId: string, readonly nativeSessionId: string, initial: ProviderStreamItem[] = [{ type: 'history_boundary' }], sessionCapabilities = capabilities) {
    this.queued = [...initial];
    this.capabilities = sessionCapabilities;
  }
  async *observe(): AsyncIterable<ProviderStreamItem> {
    this.observeCount += 1;
    while (true) {
      const item = this.queued.shift() ?? await new Promise<ProviderStreamItem | undefined>((resolve) => {
        if (this.disposed) resolve(undefined);
        else this.waiter = resolve;
      });
      if (!item) return;
      yield item;
    }
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle',
    persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } }; }
  async sendMessage(text: string): Promise<void> { this.sentMessages.push(text); }
  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.interactionResponses.push({ requestId, response });
  }
  emit(item: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter(item); }
    else this.queued.push(item);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }
}

function fixture(providerId: string, createSession: (nativeSessionId: string) => Session = id => new Session(providerId, id)) {
  const sessions = new Map<string, Session>();
  let creates = 0;
  const adapter: AgentProviderAdapter = { descriptor: { providerId, displayName: providerId.toUpperCase() },
    async createSession() { throw new Error('Host must supply directory sessions.'); },
    async resumeSession() { throw new Error('Host must supply directory sessions.'); } };
  const directory: AgentHostDirectory = { providerId, list: async () => [], workspaces: async () => [],
    async create() { const id = `${providerId}-${++creates}`; const session = createSession(id); sessions.set(id, session); return id; },
    async open(id) { const session = sessions.get(id) ?? new Session(providerId, id); sessions.set(id, session); return session; },
    async close() { await Promise.all([...sessions.values()].map((session) => session.dispose())); } };
  return { adapter, directory, sessions, createCount: () => creates };
}

describe('Agent Host runtime', () => {
  it('validates a prompt edit before dispatch and never reports a known rejection as an unknown mutation', async () => {
    const codex = fixture('codex');
    const validatePromptEdit = vi.fn(async () => { throw new Error('Only the first prompt of a turn can be edited.'); });
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter,
      directory: { ...codex.directory, supportsPromptEditing: true, validatePromptEdit } }] });
    try {
      const request = { method: 'POST' as const, path: '/remote/create', sessionId: 'branch', body: JSON.stringify({
        providerId: 'codex', operationId: operationId('edit-rejected'), editNativeSessionId: 'source', editTurnId: 'turn', editMessageId: 'steer',
      }) };
      const result = await host.control(request);
      expect(result.status).toBe(400); expect(JSON.parse(result.body)).toMatchObject({ code: 'operation_rejected', error: 'Only the first prompt of a turn can be edited.' });
      expect(JSON.parse((await host.control(request)).body).code).toBe('operation_rejected');
      expect(validatePromptEdit).toHaveBeenCalledOnce(); expect(codex.createCount()).toBe(0);
    } finally { await host.close(); }
  });

  it('deduplicates a complete prompt edit and rejects reuse for a different turn', async () => {
    const codex = fixture('codex');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: { ...codex.directory, supportsPromptEditing: true } }] });
    try {
      const input = { providerId: 'codex', operationId: operationId('edit'), editNativeSessionId: 'source', editTurnId: 'turn', editMessageId: 'message' };
      const request = (body: unknown) => host.control({ method: 'POST', path: '/remote/create', sessionId: 'branch', body: JSON.stringify(body) });
      expect((await request({ ...input, editMessageId: undefined })).status).toBe(400);
      const first = await request(input); expect(first.status).toBe(200);
      expect(await request(input)).toEqual(first); expect(codex.createCount()).toBe(1);
      expect((await request({ ...input, editTurnId: 'another' })).status).toBe(409); expect(codex.createCount()).toBe(1);
    } finally { await host.close(); }
  });
  it('shares only registered catalog identities and follows a replacement Host without opening sessions', async () => {
    const first = await uplinkBroker('first'), second = await uplinkBroker('second');
    const registration = fixture('codex');
    registration.directory.list = async () => [summary('codex', 'native')];
    const host = createAgentHost({ registrations: [registration], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'private-key' } });
    try {
      await host.ready;
      expect(await host.shareContext()).toEqual({ hostId: 'first', providers: [{ providerId: 'codex', displayName: 'CODEX' }] });
      const found = await host.shareCatalog({ hostId: 'first', providerId: 'codex', nativeSessionId: 'native' });
      expect(found.status).toBe(200); expect(JSON.parse(found.body).nativeSessionId).toBe('native');
      expect((await host.shareCatalog({ hostId: 'first', providerId: 'codex', nativeSessionId: 'missing' })).status).toBe(404);
      expect((await host.shareCatalog({ hostId: 'first', providerId: 'claude' })).status).toBe(400);
      await host.replaceUplink({ url: second.url, remoteKey: 'other-key' });
      expect((await host.shareContext()).hostId).toBe('second');
      await expect(host.shareCatalog({ hostId: 'first', providerId: 'codex' })).rejects.toThrow(/changed/);
      expect(registration.sessions.size).toBe(0);
      await host.close();
      await expect(host.shareContext()).rejects.toThrow(/registered/);
    } finally { await host.close(); await first.close(); await second.close(); }
  });

  it('preserves uplink diagnostics for replaced connections and explicit Host closure', async () => {
    const first = await uplinkBroker('first'), second = await uplinkBroker('second');
    const diagnostics: AgentHostUplinkDiagnostic[] = [];
    const host = createAgentHost({ registrations: [fixture('codex')], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'first-key' }, onDiagnostic(diagnostic) { diagnostics.push(diagnostic); } });
    try {
      await host.ready;
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      await host.close();
      expect(diagnostics.filter(value => value.event === 'registered').map(value => value.uplinkGeneration)).toEqual([1, 2]);
      expect(diagnostics.filter(value => value.event === 'closed')).toEqual([
        expect.objectContaining({ uplinkGeneration: 1, connectionId: 1, reason: 'client_closed' }),
        expect.objectContaining({ uplinkGeneration: 2, connectionId: 1, reason: 'client_closed' }),
      ]);
      expect(diagnostics.some(value => value.event === 'disconnected')).toBe(false);
    } finally { await host.close(); await first.close(); await second.close(); }
  });

  it('isolates rejected diagnostic callbacks from Host registration and closure', async () => {
    const broker = await uplinkBroker('host');
    const host = createAgentHost({ registrations: [fixture('codex')], installationId: 'installation', name: 'Host',
      uplink: { url: broker.url, remoteKey: 'key' }, async onDiagnostic() { throw new Error('Diagnostic sink failed'); } });
    try {
      await expect(host.ready).resolves.toEqual({ hostId: 'host' });
      await host.close();
      expect(host.state).toBe('closed');
    } finally { await host.close(); await broker.close(); }
  });

  it('preserves unknown and observed activity over the real uplink for all native providers', async () => {
    const broker = await uplinkBroker('host');
    const registrations = ['codex', 'claude', 'copilot'].map(fixture);
    let state: 'unknown' | 'idle' | 'running' | 'waiting' = 'unknown';
    for (const registration of registrations) registration.directory.list = async () => [{...summary(registration.directory.providerId, 'native'), state}];
    const host = createAgentHost({registrations, installationId: 'installation', name: 'Host', uplink: {url: broker.url, remoteKey: 'key'}});
    try {
      await host.ready;
      for (const activity of ['unknown', 'running', 'waiting', 'idle'] as const) {
        state = activity;
        for (const providerId of ['codex', 'claude', 'copilot']) {
          const result = await broker.rpc('GET', `/remote/catalog?providerId=${providerId}`);
          expect(result.status).toBe(200);
          expect(JSON.parse(result.body).items).toEqual([expect.objectContaining({providerId, state: activity})]);
        }
      }
    } finally { await host.close(); await broker.close(); }
  });

  it.each([
    { code: -32603, message: 'thread native already has an active writer' },
    { code: -32600, message: 'thread other already has an active writer' },
    { code: -32600, message: 'private native failure: test-secret-value' },
  ])('keeps unrelated native resume errors private ($code, $message)', async failure => {
    const app = createScriptedAppServer({ 'thread/resume': () => { throw Object.assign(new Error(failure.message), { code: failure.code }); } });
    const adapter = new CodexAppServerProvider({ spawn: () => app.child });
    const host = createAgentHostRuntime({ registrations: [{ adapter, directory: createCodexSessionDirectory(adapter, []) }] });
    try {
      const result = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'relay',
        body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native' }) });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ code: 'session_attach_failed', error: 'The Host could not open the native session. Check the Controller log and reopen it from the session list.', requestId: expect.any(String) });
      expect(app.child.killed).toBe(true);
    } finally { await host.close(); }
  });

  it('reports a native writer conflict over the uplink and allows attachment after the owner releases it', async () => {
    const broker = await uplinkBroker('host');
    let occupied = true;
    const apps: ReturnType<typeof createScriptedAppServer>[] = [];
    const adapter = new CodexAppServerProvider({ spawn: () => {
      const app = createScriptedAppServer({
        'thread/resume': () => {
          if (occupied) throw Object.assign(new Error('thread native already has an active writer'), { code: -32600 });
          return { thread: { id: 'native' }, cwd: '/workspace' };
        },
        'thread/read': () => ({ thread: { id: 'native', turns: [] } }),
      });
      apps.push(app); return app.child;
    } });
    const host = createAgentHost({ registrations: [{ adapter, directory: createCodexSessionDirectory(adapter, []) }],
      installationId: 'installation', name: 'Host', uplink: { url: broker.url, remoteKey: 'key' } });
    try {
      await host.ready;
      const failed = await broker.rpc('POST', '/remote/attach', 'relay', { providerId: 'codex', nativeSessionId: 'native' });
      expect(failed.status).toBe(409);
      expect(JSON.parse(failed.body)).toMatchObject({ code: 'session_in_use', error: expect.stringMatching(/another Codex client/i) });
      expect(apps[0]!.child.killed).toBe(true);
      occupied = false;
      const opened = await broker.rpc('POST', '/remote/attach', 'relay', { providerId: 'codex', nativeSessionId: 'native' });
      expect(opened.status).toBe(200);
      expect(JSON.parse(opened.body)).toEqual({ agentId: 'relay', nativeSessionId: 'native' });
      expect(apps.flatMap(app => app.requests).some(request => request.method === 'turn/start')).toBe(false);
    } finally { await host.close(); await broker.close(); }
  });

  it('advertises Codex, Claude and Copilot over real WebSockets and isolates operation identity across re-pair scopes', async () => {
    const first = await uplinkBroker('first'); const second = await uplinkBroker('second');
    const copilot = fixture('copilot');
    copilot.directory.list = async () => [summary('copilot', 'shared-native')];
    const codex = fixture('codex'); const claude = fixture('claude');
    codex.directory.list = async () => [summary('codex', 'shared-native')];
    let claudeCatalogFailed = false;
    claude.directory.list = async () => {
      if (claudeCatalogFailed) throw new Error('Claude catalog unavailable');
      return [summary('claude', 'shared-native')];
    };
    const host = createAgentHost({ registrations: [codex, claude, copilot], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'first-key' } });
    try {
      await host.ready;
      expect(first.advertisedProviders()).toEqual([{ providerId: 'codex', displayName: 'CODEX' }, { providerId: 'claude', displayName: 'CLAUDE' }, { providerId: 'copilot', displayName: 'COPILOT' }]);
      for (const providerId of ['codex', 'claude', 'copilot']) {
        const catalog = await first.rpc('GET', `/remote/catalog?providerId=${providerId}`);
        expect(JSON.parse(catalog.body).items).toEqual([summary(providerId, 'shared-native')]);
        const attached = await first.rpc('POST', '/remote/attach', `${providerId}-relay`, { providerId, nativeSessionId: 'shared-native' });
        expect(JSON.parse(attached.body)).toEqual({ agentId: `${providerId}-relay`, nativeSessionId: 'shared-native' });
        const created = await first.rpc('POST', '/remote/create', `${providerId}-created`, { providerId, operationId: operationId(`${providerId}:same-request`) });
        expect(JSON.parse(created.body)).toEqual({ agentId: `${providerId}-created`, nativeSessionId: `${providerId}-1` });
      }
      expect((await first.rpc('POST', '/remote/attach', 'codex-relay', { providerId: 'claude', nativeSessionId: 'another' })).status).toBe(409);
      expect(codex.sessions.get('shared-native')).not.toBe(claude.sessions.get('shared-native'));
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      expect(second.advertisedProviders()).toEqual(first.advertisedProviders());
      for (const provider of [codex, claude, copilot]) {
        const providerId = provider.adapter.descriptor.providerId;
        const attached = await second.rpc('POST', '/remote/attach', `${providerId}-new-proposal`, { providerId, nativeSessionId: 'shared-native' });
        expect(JSON.parse(attached.body).agentId).toBe(`${providerId}-relay`);
        const recovered = await second.rpc('POST', '/remote/create', `${providerId}-new-created`, { providerId, operationId: operationId(`${providerId}:same-request`) });
        expect(JSON.parse(recovered.body).agentId).toBe(`${providerId}-new-created`);
        expect(provider.createCount()).toBe(2);
        expect(provider.sessions.get('shared-native')!.observeCount).toBe(1);
        expect(provider.sessions.get('shared-native')!.disposed).toBe(false);
      }
      claudeCatalogFailed = true;
      expect((await second.rpc('GET', '/remote/catalog?providerId=claude')).status).toBe(503);
      expect((await second.rpc('GET', '/remote/catalog?providerId=codex')).status).toBe(200);
    } finally { await host.close(); await first.close(); await second.close(); }
    expect(codex.sessions.get('shared-native')!.disposed).toBe(true);
    expect(claude.sessions.get('shared-native')!.disposed).toBe(true);
    expect(copilot.sessions.get('shared-native')!.disposed).toBe(true);
  });

  it('disposes a Codex session whose persistence result arrives after bounded shutdown', async () => {
    const codex = fixture('codex');
    let releaseInfo!: () => void;
    let enteredInfo!: () => void;
    const blockedInfo = new Promise<void>((resolve) => { releaseInfo = resolve; });
    const infoEntered = new Promise<void>((resolve) => { enteredInfo = resolve; });
    let disposeCount = 0;
    const session: AgentSession = { capabilities, async *observe() { yield { type: 'history_boundary' }; },
      async runtimeInfo() { enteredInfo(); await blockedInfo; return { providerId: 'codex', sessionId: 'late', status: 'idle' as const,
        persistence: { providerId: 'codex', sessionId: 'late', opaque: '{}' } }; },
      async sendMessage() {}, async respondToInteraction() {}, async dispose() { disposeCount += 1; } };
    const directory = createCodexSessionDirectory({ async listSessions() { return { sessions: [] }; }, async createSession() { return session; },
      async resumeSession() { throw new Error('unexpected resume'); }, async openChildSession() { throw new Error('unexpected child'); } }, []);
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory }], shutdownTimeoutMs: 20 });
    const creating = host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay',
      body: JSON.stringify({ providerId: 'codex', operationId: operationId('late') }) });
    await infoEntered;
    await host.close();
    releaseInfo();
    expect((await creating).status).toBe(503);
    expect(disposeCount).toBe(1);
  });

  it('disposes a child session returned after bounded shutdown', async () => {
    const codex = fixture('codex');
    const child = new Session('codex', 'child');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    codex.directory.openChild = async () => { await blocked; return child; };
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], shutdownTimeoutMs: 20 });
    const attaching = host.control({ method: 'POST', path: '/remote/child/attach', sessionId: 'relay',
      body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'parent' }) });
    await host.close();
    release();
    expect((await attaching).status).toBe(503);
    expect(child.disposed).toBe(true);
  });

  it('supersedes an overlapping uplink replacement instead of reporting another connection outcome', async () => {
    const initial = await uplinkBroker('initial'); const first = await uplinkBroker('first', false); const second = await uplinkBroker('second', false);
    const codex = fixture('codex');
    const host = createAgentHost({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], installationId: 'installation', name: 'Host',
      uplink: { url: initial.url, remoteKey: 'initial-key' } });
    try {
      await host.ready;
      const replacedFirst = host.replaceUplink({ url: first.url, remoteKey: 'first-key' });
      const firstWasSuperseded = expect(replacedFirst).rejects.toThrow(/superseded/i);
      await first.connected;
      const replacedSecond = host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      await second.connected; second.register();
      await firstWasSuperseded;
      await expect(replacedSecond).resolves.toEqual({ hostId: 'second' });
    } finally { await host.close(); await initial.close(); await first.close(); await second.close(); }
  });

  it('reserves a native projection before opening and shares compatible concurrent attachment', async () => {
    const codex = fixture('codex');
    const session = new Session('codex', 'native');
    let release!: () => void;
    const opening = new Promise<void>((resolve) => { release = resolve; });
    codex.directory.open = async () => { await opening; return session; };
    codex.directory.openChild = async () => { await opening; return session; };
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }] });
    try {
      const attach = (agentId: string, parentNativeSessionId?: string) => host.control({ method: 'POST',
        path: parentNativeSessionId ? '/remote/child/attach' : '/remote/attach', sessionId: agentId,
        body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native', ...(parentNativeSessionId ? { parentNativeSessionId } : {}) }) });
      const one = attach('relay-one');
      const two = attach('relay-two');
      const conflictingParent = attach('relay-three', 'parent');
      release();
      const [first, second, conflict] = await Promise.all([one, two, conflictingParent]);
      expect(JSON.parse(first.body)).toEqual({ agentId: 'relay-one', nativeSessionId: 'native' });
      expect(second).toEqual(first);
      expect(conflict.status).toBe(409);
      expect(session.observeCount).toBe(1);
      expect(host.resolveSession('relay-one')).toBeDefined();
      expect(host.resolveSession('relay-two')).toBeUndefined();
    } finally { await host.close(); }
  });

  it('bounds shutdown when accepted native work and cleanup do not settle', async () => {
    const codex = fixture('codex');
    codex.directory.create = () => new Promise<string>(() => undefined);
    codex.directory.close = () => new Promise<void>(() => undefined);
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], shutdownTimeoutMs: 30 });
    void host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'codex', operationId: operationId('blocked') }) });
    const started = Date.now();
    await host.close();
    expect(Date.now() - started).toBeLessThan(250);
  });
  it('re-pairs over a real uplink while preserving the projected Agent identity', async () => {
    const first = await uplinkBroker('host-first'); const second = await uplinkBroker('host-second');
    const codex = fixture('codex');
    const host = createAgentHost({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'first-key' } });
    try {
      await host.ready;
      const created = await first.rpc('POST', '/remote/create', 'relay', { providerId: 'codex', operationId: operationId('re-pair-create') });
      expect(JSON.parse(created.body)).toEqual({ agentId: 'relay', nativeSessionId: 'codex-1' });
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      const attached = await second.rpc('POST', '/remote/attach', 'relay', { providerId: 'codex', nativeSessionId: 'codex-1' });
      expect(JSON.parse(attached.body)).toEqual({ agentId: 'relay', nativeSessionId: 'codex-1' });
      expect(codex.createCount()).toBe(1);
    } finally { await host.close(); await first.close(); await second.close(); }
  });
  it('preserves the native session when cloud heartbeat silence forces an uplink reconnect', async () => {
    const broker = await uplinkBroker('host', true, { intervalMs: 180, timeoutMs: 60 });
    const codex = fixture('codex');
    const host = createAgentHost({ registrations: [codex], installationId: 'installation', name: 'Host',
      uplink: { url: broker.url, remoteKey: 'key' } });
    try {
      await host.ready;
      const created = await broker.rpc('POST', '/remote/create', 'relay', { providerId: 'codex', operationId: operationId('heartbeat-create') });
      expect(JSON.parse(created.body)).toEqual({ agentId: 'relay', nativeSessionId: 'codex-1' });
      const session = codex.sessions.get('codex-1')!;
      await expect.poll(broker.heartbeatAcknowledgements, { timeout: 2000 }).toBeGreaterThan(0);
      const silentSocket = broker.pauseHeartbeat();
      expect(silentSocket.readyState).toBe(1);
      await expect.poll(() => broker.registrations() >= 2 && host.state === 'registered', { timeout: 4000 }).toBe(true);
      expect(silentSocket.readyState).toBe(3);
      expect(session.disposed).toBe(false);
      const attached = await broker.rpc('POST', '/remote/attach', 'relay', { providerId: 'codex', nativeSessionId: 'codex-1' });
      const recovered = await broker.rpc('POST', '/remote/create', 'relay', { providerId: 'codex', operationId: operationId('heartbeat-create') });
      expect(attached).toEqual(created);
      expect(recovered).toEqual(created);
      expect(codex.sessions.get('codex-1')).toBe(session);
      expect(codex.createCount()).toBe(1);
      expect(session.observeCount).toBe(1);
      expect(session.disposed).toBe(false);
    } finally { await host.close(); await broker.close(); }
  });

  it('replays lost acknowledgements through the production cache across credential and uplink replacement', async () => {
    const broker = await uplinkBroker('host');
    const approval = { kind: 'plan_approval' as const, requestId: 'approval-one', plan: 'Check the evidence.', allowedActions: ['approve' as const] };
    let session: Session | undefined;
    const codex = fixture('codex', nativeSessionId => {
      session = new Session('codex', nativeSessionId, [
        { type: 'observation', sourceKey: 'approval', occurredAt: 1, delivery: 'history',
          event: { type: 'interaction_requested', provider: 'codex', request: approval } },
        { type: 'history_boundary' },
      ], { ...capabilities, interactions: { ...capabilities.interactions, planApproval: true } });
      const respond = session.respondToInteraction.bind(session);
      session.respondToInteraction = async (requestId, response) => {
        await respond(requestId, response);
        session!.emit({ type: 'observation', sourceKey: 'approval-resolved', occurredAt: 2, delivery: 'live',
          event: { type: 'interaction_resolved', provider: 'codex', requestId, response } });
      };
      return session;
    });
    const savedCredentials: string[] = [];
    const host = createAgentHost({ registrations: [codex], installationId: 'installation', name: 'Host', operationCache: { maxEntries: 3 },
      uplink: { url: broker.url, remoteKey: 'initial-key', async onCredential(credential) { savedCredentials.push(credential); } } });
    try {
      await host.ready;
      expect((await broker.rpc('POST', '/remote/create', 'agent', {
        providerId: 'codex', operationId: operationId('integrated-create'),
      })).status).toBe(200);
      broker.openStream('lost', 'agent');
      await expect.poll(() => broker.streamOpened('lost')).toBe(true);
      broker.sendStream('lost', { protocolVersion: '1.5.0', type: 'negotiate' });
      await expect.poll(() => broker.streamMessage('lost', 'agent_snapshot')).toBeDefined();

      broker.sendStream('lost', { protocolVersion: '1.5.0', type: 'send_message', payload: {
        requestId: 'send-lost', operationId: operationId('integrated-send'), agentId: 'agent', text: 'Run once.',
      } });
      broker.sendStream('lost', { protocolVersion: '1.5.0', type: 'interaction_response', payload: {
        agentId: 'agent', requestId: approval.requestId, submissionId: 'approval-lost',
        operationId: operationId('integrated-approval'), response: { kind: 'plan_approval', action: 'approve' },
      } });
      await expect.poll(() => session?.sentMessages.length).toBe(1);
      await expect.poll(() => session?.interactionResponses.length).toBe(1);
      await expect.poll(() => broker.streamMessage('lost', 'interaction_resolved', approval.requestId)).toBeDefined();

      const fullCacheRead = await broker.rpc('GET', '/v1/sessions/agent/snapshot?protocolVersion=1.5.0', 'agent');
      expect(fullCacheRead.status).toBe(200);
      expect(JSON.parse(fullCacheRead.body).payload.pendingInteractions).toEqual([]);
      broker.issueCredential('rotated-key');
      await expect.poll(() => savedCredentials).toEqual(['rotated-key']);

      await host.replaceUplink({ url: broker.url, remoteKey: 'rotated-key', async onCredential(credential) { savedCredentials.push(credential); } });
      broker.openStream('retry', 'agent');
      await expect.poll(() => broker.streamOpened('retry')).toBe(true);
      broker.sendStream('retry', { protocolVersion: '1.5.0', type: 'negotiate' });
      await expect.poll(() => broker.streamMessage('retry', 'agent_snapshot')).toBeDefined();
      broker.sendStream('retry', { protocolVersion: '1.5.0', type: 'send_message', payload: {
        requestId: 'send-retry', operationId: operationId('integrated-send'), agentId: 'agent', text: 'Run once.',
      } });
      broker.sendStream('retry', { protocolVersion: '1.5.0', type: 'interaction_response', payload: {
        agentId: 'agent', requestId: approval.requestId, submissionId: 'approval-retry',
        operationId: operationId('integrated-approval'), response: { kind: 'plan_approval', action: 'approve' },
      } });
      await expect.poll(() => broker.streamMessage('retry', 'command_acknowledged', 'send-retry')).toBeDefined();
      await expect.poll(() => broker.streamMessage('retry', 'command_acknowledged', 'approval-retry')).toBeDefined();
      expect(session?.sentMessages).toEqual(['Run once.']);
      expect(session?.interactionResponses).toHaveLength(1);

      broker.sendStream('retry', { protocolVersion: '1.5.0', type: 'send_message', payload: {
        requestId: 'capacity', operationId: operationId('capacity-send'), agentId: 'agent', text: 'Do not dispatch.',
      } });
      await expect.poll(() => broker.streamMessage('retry', 'protocol_error', 'capacity')).toMatchObject({
        payload: { code: 'operation_capacity_exceeded' },
      });
      expect(session?.sentMessages).toEqual(['Run once.']);
    } finally { await host.close(); await broker.close(); }
  });

  it('starts a new operation-cache lifetime when the Host is recreated', async () => {
    const broker = await uplinkBroker('host');
    const codex = fixture('codex');
    const request = { providerId: 'codex', operationId: operationId('host-recreation') };
    const first = createAgentHost({ registrations: [codex], installationId: 'installation', name: 'Host',
      uplink: { url: broker.url, remoteKey: 'key' } });
    let second: ReturnType<typeof createAgentHost> | undefined;
    try {
      await first.ready;
      expect(JSON.parse((await broker.rpc('POST', '/remote/create', 'before', request)).body).nativeSessionId).toBe('codex-1');
      await first.close();
      second = createAgentHost({ registrations: [codex], installationId: 'installation', name: 'Host',
        uplink: { url: broker.url, remoteKey: 'key' } });
      await second.ready;
      expect(JSON.parse((await broker.rpc('POST', '/remote/create', 'after', request)).body).nativeSessionId).toBe('codex-2');
      expect(codex.createCount()).toBe(2);
    } finally { await second?.close(); await first.close(); await broker.close(); }
  });

  it('isolates a completed creation across a real uplink replacement with a different operation scope', async () => {
    const first = await uplinkBroker('host-first'); const second = await uplinkBroker('host-second');
    const codex = fixture('codex');
    const host = createAgentHost({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'first-key' } });
    try {
      await host.ready;
      const created = await first.rpc('POST', '/remote/create', 'broker-before', { providerId: 'codex', operationId: operationId('stable-create'), cwd: '/work' });
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      const recovered = await second.rpc('POST', '/remote/create', 'broker-after', { providerId: 'codex', operationId: operationId('stable-create'), cwd: '/work' });
      expect(recovered).not.toEqual(created);
      expect(JSON.parse(recovered.body)).toEqual({ agentId: 'broker-after', nativeSessionId: 'codex-2' });
      expect(codex.createCount()).toBe(2);
    } finally { await host.close(); await first.close(); await second.close(); }
  });

  it('preserves catalog errors through a real uplink', async () => {
    const broker = await uplinkBroker('host');
    const codex = fixture('codex'); const dsh = fixture('dsh'); const failing = fixture('failing');
    codex.directory.list = async () => [summary('codex', 'one'), summary('codex', 'two')];
    dsh.directory.list = async () => [summary('dsh', 'one'), summary('dsh', 'two')];
    failing.directory.list = async () => { throw new Error('native read failed'); };
    const host = createAgentHost({ registrations: [{ adapter: codex.adapter, directory: codex.directory }, { adapter: dsh.adapter, directory: dsh.directory },
      { adapter: failing.adapter, directory: failing.directory }],
      installationId: 'installation', name: 'Host', uplink: { url: broker.url, remoteKey: 'key' } });
    try {
      await host.ready;
      const first = await broker.rpc('GET', '/remote/catalog?providerId=codex&limit=1');
      const cursor = JSON.parse(first.body).nextCursor as string;
      const expired = await broker.rpc('GET', `/remote/catalog?providerId=dsh&cursor=${encodeURIComponent(cursor)}`);
      expect(expired).toEqual({ status: 409, body: JSON.stringify({ error: 'The catalog read view is unavailable. Refresh the catalog.', code: 'cursor_expired', requestId: 'rpc-2' }) });
      const invalidCursor = await broker.rpc('GET', '/remote/catalog?providerId=codex&cursor=invalid');
      expect(invalidCursor).toEqual({ status: 400, body: JSON.stringify({ error: 'Invalid catalog cursor.', code: 'invalid_request', requestId: 'rpc-3' }) });
      const invalidLimit = await broker.rpc('GET', '/remote/catalog?providerId=codex&limit=0');
      expect(invalidLimit).toEqual({ status: 400, body: JSON.stringify({ error: 'Catalog page size must be an integer from 1 to 100.', code: 'invalid_request', requestId: 'rpc-4' }) });
      const unavailable = await broker.rpc('GET', '/remote/catalog?providerId=failing');
      expect(unavailable).toEqual({ status: 503, body: JSON.stringify({ error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable', requestId: 'rpc-5' }) });
    } finally { await host.close(); await broker.close(); }
  });
  it('returns both identities and deduplicates a creation request', async () => {
    const codex = fixture('codex');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }] });
    try {
      const body = JSON.stringify({ providerId: 'codex', operationId: operationId('request-1'), cwd: '/work' });
      const first = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay-1', body });
      const second = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay-1', body });
      expect(JSON.parse(first.body)).toEqual({ agentId: 'relay-1', nativeSessionId: 'codex-1' });
      expect(second).toEqual(first);
      expect(codex.createCount()).toBe(1);
    } finally { await host.close(); }
  });

  it('reuses a native creation after projection fails without dispatching create again', async () => {
    const codex = fixture('codex');
    const open = codex.directory.open;
    let attempts = 0;
    codex.directory.open = async id => {
      if (++attempts === 1) throw new Error('projection unavailable');
      return open(id);
    };
    const host = createAgentHostRuntime({ registrations: [codex] });
    const request = { method: 'POST' as const, path: '/remote/create', sessionId: 'relay',
      body: JSON.stringify({ providerId: 'codex', operationId: operationId('projection-retry') }) };
    try {
      expect((await host.control(request)).status).toBe(503);
      expect(await host.control(request)).toEqual({ status: 200,
        body: JSON.stringify({ agentId: 'relay', nativeSessionId: 'codex-1' }) });
      expect(codex.createCount()).toBe(1);
      expect(attempts).toBe(2);
    } finally { await host.close(); }
  });

  it('isolates operation identities by scope and rejects new mutations when retention capacity is full', async () => {
    const codex = fixture('codex');
    const host = createAgentHostRuntime({ registrations: [codex], operationCache: { maxEntries: 2 } });
    const operation = operationId('scoped-create');
    try {
      const first = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'one', operationScope: 'scope-a',
        body: JSON.stringify({ providerId: 'codex', operationId: operation }) });
      expect(first.status).toBe(200);
      expect((await host.control({ method: 'POST', path: '/remote/create', sessionId: 'other', operationScope: 'scope-b',
        body: JSON.stringify({ providerId: 'codex', operationId: operation }) })).status).toBe(200);
      const full = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'two', operationScope: 'scope-a',
        body: JSON.stringify({ providerId: 'codex', operationId: operationId('second-create') }) });
      expect(full.status).toBe(429);
      expect(codex.createCount()).toBe(2);
    } finally { await host.close(); }
  });

  it('isolates providers and rejects request identity reuse with different settings', async () => {
    const codex = fixture('codex'); const dsh = fixture('dsh');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }, { adapter: dsh.adapter, directory: dsh.directory }] });
    try {
      const request = (providerId: string, cwd: string) => host.control({ method: 'POST', path: '/remote/create', sessionId: `${providerId}-relay`,
        body: JSON.stringify({ providerId, operationId: operationId(`${providerId}:same`), cwd }) });
      expect((await request('codex', '/one')).status).toBe(200);
      expect((await request('dsh', '/two')).status).toBe(200);
      expect((await request('codex', '/different')).status).toBe(409);
      expect((await host.control({ method: 'POST', path: '/remote/create', sessionId: 'codex-relay',
        body: JSON.stringify({ providerId: 'codex', operationId: operationId('another'), cwd: '/one' }) })).status).toBe(409);
      expect(codex.createCount()).toBe(1); expect(dsh.createCount()).toBe(1);
    } finally { await host.close(); }
  });

  it('keeps one projection for repeated attach and rejects child ownership changes', async () => {
    const codex = fixture('codex');
    codex.directory.openChild = async (_parent, child) => codex.directory.open(child);
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }] });
    try {
      const attach = (agentId: string, parentNativeSessionId?: string) => host.control({ method: 'POST', path: parentNativeSessionId ? '/remote/child/attach' : '/remote/attach', sessionId: agentId,
        body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native', ...(parentNativeSessionId ? { parentNativeSessionId } : {}) }) });
      expect(JSON.parse((await attach('relay-a')).body).agentId).toBe('relay-a');
      expect(JSON.parse((await attach('relay-b')).body).agentId).toBe('relay-a');
      expect((await attach('relay-c', 'parent')).status).toBe(409);
    } finally { await host.close(); }
  });

  it('disposes sessions only when the Host explicitly closes', async () => {
    const codex = fixture('codex');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }] });
    await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'codex', operationId: operationId('dispose') }) });
    const session = codex.sessions.get('codex-1')!;
    expect(session.disposed).toBe(false);
    await host.close(); await host.close();
    expect(session.disposed).toBe(true);
  });

  it('closes native sessions within the shutdown deadline while credential persistence is blocked', async () => {
    const broker = await uplinkBroker('host'); const codex = fixture('codex');
    let releasePersistence!: () => void;
    const persistence = new Promise<void>(resolve => { releasePersistence = resolve; });
    let persistenceStarted!: () => void;
    const started = new Promise<void>(resolve => { persistenceStarted = resolve; });
    const host = createAgentHost({ registrations: [codex], installationId: 'installation', name: 'Host', shutdownTimeoutMs: 30,
      uplink: { url: broker.url, remoteKey: 'key', onCredential: async () => { persistenceStarted(); await persistence; } } });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await host.ready;
      expect((await broker.rpc('POST', '/remote/create', 'relay', { providerId: 'codex', operationId: operationId('credential-create') })).status).toBe(200);
      const session = codex.sessions.get('codex-1')!;
      broker.issueCredential('rotated-key'); await started;
      const closed = host.close();
      expect(await Promise.race([closed.then(() => 'closed'), new Promise<string>(resolve => { deadline = setTimeout(() => resolve('blocked'), 300); })])).toBe('closed');
      expect(session.disposed).toBe(true);
      expect(host.state).toBe('closed');
      expect(host.close()).toBe(closed);
    } finally { clearTimeout(deadline); releasePersistence(); await host.close(); await broker.close(); }
  });

  it('releases its private native subprocess when the Host closes', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const transport = new CodexAppServerTransport(child);
    const codex = fixture('codex'); const host = createAgentHostRuntime({ registrations: [codex] });
    try {
      await once(child, 'spawn');
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
      await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'codex', operationId: operationId('subprocess-create') }) });
      const session = codex.sessions.get('codex-1')!, dispose = session.dispose.bind(session);
      session.dispose = async () => { await transport.dispose(); await dispose(); };
      await host.close();
      await exited;
      expect(child.signalCode).toBe('SIGTERM');
      expect(session.disposed).toBe(true);
    } finally {
      await host.close(); await transport.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});

async function uplinkBroker(hostId: string, autoRegister = true, heartbeat = { intervalMs: 30000, timeoutMs: 10000 }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let socket: WebSocket | undefined;
  let providers: unknown;
  let pausedSocket: WebSocket | undefined;
  const received: Array<Record<string, unknown>> = [];
  let registrationCount = 0, heartbeatAcknowledgementCount = 0;
  let resolveConnected!: () => void;
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
  server.on('connection', (connection) => {
    socket = connection;
    resolveConnected();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    connection.on('close', () => clearInterval(heartbeatTimer));
    connection.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown> & { type: string; providers?: unknown };
      received.push(message);
      if (message.type === 'register') { providers = message.providers; registrationCount += 1; }
      if (message.type === 'heartbeat_ack') heartbeatAcknowledgementCount += 1;
      if (message.type === 'register' && autoRegister) {
        connection.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId, heartbeat }));
        let nonce = 0;
        heartbeatTimer = setInterval(() => {
          if (connection !== pausedSocket && connection.readyState === 1)
            connection.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: String(++nonce) }));
        }, heartbeat.intervalMs);
      }
    });
  });
  const address = server.address() as { port: number };
  let sequence = 0;
  return {
    url: `ws://127.0.0.1:${address.port}/ws/remote-host`,
    connected,
    advertisedProviders: () => providers,
    registrations: () => registrationCount,
    heartbeatAcknowledgements: () => heartbeatAcknowledgementCount,
    pauseHeartbeat() { if (!socket) throw new Error('Broker has no Host connection.'); pausedSocket = socket; return socket; },
    issueCredential(credential: string) { socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_issued', credential })); },
    register() { socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId, heartbeat })); },
    openStream(streamId: string, sessionId: string) {
      socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_open', streamId, sessionId }));
    },
    closeStream(streamId: string) {
      socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }));
    },
    sendStream(streamId: string, message: object) {
      socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId, message: JSON.stringify(message) }));
    },
    streamOpened(streamId: string) {
      return received.some(message => message.type === 'stream_opened' && message.streamId === streamId);
    },
    streamMessage(streamId: string, type: string, requestId?: string): Record<string, unknown> | undefined {
      for (const frame of received) {
        if (frame.type !== 'stream_message' || frame.streamId !== streamId || typeof frame.message !== 'string') continue;
        const message = JSON.parse(frame.message) as Record<string, unknown>;
        if (message.type !== type) continue;
        const payload = message.payload;
        if (requestId === undefined || (payload && typeof payload === 'object' && 'requestId' in payload
          && (payload as { requestId?: unknown }).requestId === requestId)) return message;
      }
      return undefined;
    },
    rpc(method: 'GET' | 'POST', path: string, sessionId?: string, body?: unknown): Promise<{ status: number; body: string }> {
      const requestId = `rpc-${++sequence}`;
      return new Promise((resolve, reject) => {
        if (!socket) { reject(new Error('Broker has no Host connection.')); return; }
        const timeout = setTimeout(() => reject(new Error('RPC timed out.')), 5000);
        const receive = (data: import('ws').RawData) => {
          const response = JSON.parse(data.toString()) as { type: string; requestId?: string; status?: number; body?: string };
          if (response.type !== 'rpc_response' || response.requestId !== requestId) return;
          clearTimeout(timeout); socket!.off('message', receive); resolve({ status: response.status!, body: response.body! });
        };
        socket.on('message', receive);
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method, path,
          ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      });
    },
    close: () => new Promise<void>((resolve) => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }),
  };
}

function summary(providerId: string, nativeSessionId: string) {
  return { providerId, nativeSessionId, title: nativeSessionId, createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z', state: 'idle' as const };
}

it('stops projected native sessions and reports unsupported and failed cancellation separately', async () => {
  const registration = fixture('recorded'); let cancelled = 0;
  const originalOpen = registration.directory.open;
  registration.directory.open = async id => {
    const session = await originalOpen(id);
    if (id === 'ok' || id === 'failed' || id === 'later') {
      Object.assign(session, { capabilities: { ...capabilities, cancel: true }, cancel: async () => {
        if (id === 'failed') throw new Error('native error contains secret'); cancelled++;
      } });
    }
    return session;
  };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    for (const id of ['ok', 'unsupported', 'failed']) await host.control({ method: 'POST', path: '/remote/attach', sessionId: id, body: JSON.stringify({ providerId: 'recorded', nativeSessionId: id }) });
    const response = await host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: operationId('stop-all') }) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ results: [
      { agentId: 'ok', status: 'cancelled' }, { agentId: 'unsupported', status: 'unsupported', message: 'The native session does not support cancellation.' },
      { agentId: 'failed', status: 'failed', message: 'Native cancellation did not complete.' },
    ] });
    expect(cancelled).toBe(1); expect(response.body).not.toContain('secret');
    await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'later', body: JSON.stringify({ providerId: 'recorded', nativeSessionId: 'later' }) });
    const repeated = await host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: operationId('stop-all') }) });
    expect(repeated).toEqual(response);
    expect(cancelled).toBe(1);
    expect((await host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: operationId('invalid-stop'), unexpected: true }) })).status).toBe(400);
  } finally { await host.close(); }
});

it('returns a failed cancellation result by the local deadline when a native cancel never settles', async () => {
  const registration = fixture('recorded'); const open = registration.directory.open;
  registration.directory.open = async id => Object.assign(await open(id), {
    capabilities: { ...capabilities, cancel: true }, cancel: () => new Promise<void>(() => undefined),
  });
  const host = createAgentHostRuntime({ registrations: [registration], cancelTimeoutMs: 15 });
  try {
    await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'hung', body: JSON.stringify({ providerId: 'recorded', nativeSessionId: 'hung' }) });
    expect(JSON.parse((await host.control({ method: 'POST', path: '/remote/stop', body: JSON.stringify({ operationId: operationId('hung-stop') }) })).body)).toEqual({ results: [
      { agentId: 'hung', status: 'failed', message: 'Native cancellation did not complete.' },
    ] });
  } finally { await host.close(); }
});


it('serializes durable credential writes across uplink replacement so an old save cannot overwrite a new key', async () => {
  const first = await uplinkBroker('first'); const second = await uplinkBroker('second');
  const events: string[] = []; let release!: () => void; let saved = '';
  const host = createAgentHost({ registrations: [fixture('recorded')], installationId: 'i', name: 'Host', uplink: {
    url: first.url, remoteKey: 'first-key', onCredential: async credential => {
      events.push('old-start'); await new Promise<void>(resolve => { release = resolve; }); saved = credential; events.push('old-saved');
    },
  } });
  try {
    await host.ready; first.issueCredential('old-device'); await expect.poll(() => events.length).toBe(1);
    const replacement = host.replaceUplink({ url: second.url, remoteKey: 'next-key', onCredential: async credential => {
      saved = credential; events.push('new-saved');
    } });
    await second.connected; await expect.poll(() => second.advertisedProviders()).toBeDefined();
    second.issueCredential('new-device'); await second.rpc('GET', '/remote/workspaces?providerId=recorded');
    expect(events).toEqual(['old-start']);
    release(); await replacement; await expect.poll(() => events.length).toBe(3);
    expect(events).toEqual(['old-start', 'old-saved', 'new-saved']); expect(saved).toBe('new-device');
  } finally { release?.(); await host.close(); await first.close(); await second.close(); }
});

it('delivers the owner stop operation over the real Host uplink transport', async () => {
  const broker = await uplinkBroker('host'); const host = createAgentHost({ registrations: [fixture('recorded')], installationId: 'i', name: 'Host',
    uplink: { url: broker.url, remoteKey: 'key' } });
  try {
    await host.ready;
    await broker.rpc('POST', '/remote/attach', 'agent', { providerId: 'recorded', nativeSessionId: 'native' });
    const result = await broker.rpc('POST', '/remote/stop', undefined, { operationId: operationId('uplink-stop') });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ results: [{ agentId: 'agent', status: 'unsupported', message: 'The native session does not support cancellation.' }] });
  } finally { await host.close(); await broker.close(); }
});

it('routes workspace browsing over the uplink without disrupting heartbeats', async () => {
  const { realpath, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-folder-uplink-')));
  const broker = await uplinkBroker('host', true, { intervalMs: 1000, timeoutMs: 500 });
  const runtime = createAgentHost({ registrations: [fixture('codex')], installationId: 'folders', name: 'Host',
    uplink: { url: broker.url, remoteKey: 'key' },
    executionPolicy: { defaultWorkspace: root, allowedWorkspaceRoots: [root], lockPermissions: true } });
  try {
    await runtime.ready;
    const result = await broker.rpc('GET', '/remote/workspace-folders?providerId=codex');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ path: root, parentPath: null });
    const forbidden = await broker.rpc('GET', '/remote/workspace-folders?providerId=codex&path=%2F');
    expect(forbidden.status).toBe(403);
    const created = await broker.rpc('POST', '/remote/workspace-folders/create', undefined, { providerId: 'codex', parentPath: root, name: 'New project' });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body)).toEqual({ path: join(root, 'New project') });
    expect((await broker.rpc('POST', '/remote/workspace-folders/create', undefined, { providerId: 'codex', parentPath: root, name: 'New project' })).status).toBe(409);
    expect((await broker.rpc('POST', '/remote/workspace-folders/create', undefined, { providerId: 'codex', parentPath: '/', name: 'blocked' })).status).toBe(403);
    await expect.poll(() => broker.heartbeatAcknowledgements(), { timeout: 3000 }).toBeGreaterThan(0);
    expect(broker.registrations()).toBe(1);
    expect(runtime.state).toBe('registered');
  } finally { await runtime.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
});


it('reports a confirmed attach failure over a real uplink without classifying it as a mutation', async () => {
  const broker = await uplinkBroker('diagnostic-host');
  const registration = fixture('codex');
  registration.directory.open = async () => { throw new Error('native payload and arc_secret'); };
  const diagnostics: unknown[] = [];
  const host = createAgentHost({ registrations: [registration], installationId: 'diagnostic-installation', name: 'Host',
    uplink: { url: broker.url, remoteKey: 'test-key' }, onRequestDiagnostic: diagnostic => { diagnostics.push(diagnostic); } });
  try {
    await host.ready;
    const result = await broker.rpc('POST', '/remote/attach', 'agent', { providerId: 'codex', nativeSessionId: 'native' });
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({ code: 'session_attach_failed', requestId: 'rpc-1' });
    expect(diagnostics).toEqual([
      expect.objectContaining({ event: 'host_request_started', requestId: 'rpc-1', operation: 'session_attach' }),
      expect.objectContaining({ event: 'host_request_completed', requestId: 'rpc-1', operation: 'session_attach', code: 'session_attach_failed', status: 503, elapsedMs: expect.any(Number) }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/arc_secret|native payload/);
  } finally { await host.close(); await broker.close(); }
});


it('reuses a slow native opening after a Relay timeout over a real WebSocket', async () => {
  const broker = createHostBroker({ origin: 'http://relay.test', rpcTimeoutMs: 50 });
  const pairing = await broker.handleRequest(new Request('http://relay.test/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', async socket => {
    const prepared = await broker.prepareUpgrade(new Request('http://relay.test/ws/remote-host', { headers: { authorization: `Bearer ${key}` } }));
    if (!prepared || prepared instanceof Response) { socket.close(); return; }
    const relaySocket: RelaySocket = {
      get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
      send: data => socket.send(data), close: (code, reason) => socket.close(code, reason),
      onMessage(listener) { const receive = (data: import('ws').RawData, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => { socket.off('message', receive); }; },
      onClose(listener) { socket.on('close', listener); return () => { socket.off('close', listener); }; },
      onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; },
    };
    prepared.accept(relaySocket);
  });
  const registration = fixture('codex');
  const open = registration.directory.open;
  let release!: () => void, completed!: () => void, openings = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { completed = resolve; });
  registration.directory.open = async id => { openings++; await gate; return open(id); };
  const diagnostics: Array<{ requestId: string; event: string }> = [];
  const host = createAgentHost({ registrations: [registration], installationId: 'slow-host', name: 'Host',
    uplink: { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, remoteKey: key },
    onRequestDiagnostic(diagnostic) { diagnostics.push(diagnostic); if (diagnostic.event === 'host_request_completed') completed(); } });
  try {
    const { hostId } = await host.ready;
    const request = () => broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/attach`, {
      method: 'POST', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'slow-native' }),
    }));
    const timeout = await request();
    expect(timeout?.status).toBe(504);
    const failure = await timeout!.json();
    expect(failure.code).toBe('session_attach_timeout');
    expect(diagnostics).toContainEqual(expect.objectContaining({ requestId: failure.requestId, event: 'host_request_started' }));
    release(); await settled;
    const result = await request();
    expect(result?.status).toBe(200);
    expect(await result!.json()).toMatchObject({ nativeSessionId: 'slow-native' });
    expect(openings).toBe(1);
    expect(registration.sessions.get('slow-native')?.sentMessages).toEqual([]);
  } finally {
    release(); await host.close(); broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);


it('preserves file-limit guidance across create retries without redispatching', async () => {
  const registration = fixture('codex');
  let creates = 0;
  registration.directory.create = async () => { creates++; throw new AgentRuntimeError('native_file_limit', 'Native private details'); };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'reserved-agent',
        body: JSON.stringify({ providerId: 'codex', operationId: operationId('file-limit') }) });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body)).toMatchObject({ code: 'native_file_limit', error: expect.stringContaining('may have reached') });
      expect(result.body).not.toContain('Native private details');
    }
    expect(creates).toBe(1);
  } finally { await host.close(); }
});

it('releases an idle shared projection after grace and restores the same binding over real uplink streams', async () => {
  const broker = await uplinkBroker('idle-host');
  const registration = fixture('codex');
  registration.directory.canReleaseSession = () => true;
  registration.directory.open = async id => {
    const old = registration.sessions.get(id);
    if (old && !old.disposed) return old;
    const session = new Session('codex', id); registration.sessions.set(id, session); return session;
  };
  const host = createAgentHost({ registrations: [registration], idleGraceMs: 150,
    installationId: 'idle-host', name: 'Host', uplink: { url: broker.url, remoteKey: 'key' } });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await host.ready;
    expect((await broker.rpc('POST', '/remote/attach', 'agent', { providerId: 'codex', nativeSessionId: 'native' })).status).toBe(200);
    broker.openStream('main', 'agent'); broker.openStream('track', 'agent');
    await expect.poll(() => broker.streamOpened('track')).toBe(true);
    broker.sendStream('main', { protocolVersion: '1.5.0', type: 'negotiate' });
    broker.sendStream('track', { protocolVersion: '1.5.0', type: 'negotiate', observation: 'activity' });
    await expect.poll(() => !!broker.streamMessage('track', 'agent_activity')).toBe(true);
    const original = registration.sessions.get('native')!;
    broker.closeStream('main');
    await pause(220);
    expect(original.disposed).toBe(false);
    broker.closeStream('track');
    await pause(70);
    broker.openStream('wake', 'agent');
    await expect.poll(() => broker.streamOpened('wake')).toBe(true);
    expect(registration.sessions.get('native')).toBe(original);
    await pause(220);
    expect(original.disposed).toBe(false);
    broker.closeStream('wake');
    await expect.poll(() => original.disposed).toBe(true);
    broker.openStream('restore', 'agent');
    await expect.poll(() => broker.streamOpened('restore')).toBe(true);
    expect(registration.sessions.get('native')).not.toBe(original);
    expect((await broker.rpc('GET', '/v1/sessions/agent/snapshot?protocolVersion=1.5.0', 'agent')).status).toBe(200);
    expect(JSON.parse((await broker.rpc('POST', '/remote/attach', 'new-proposal', { providerId: 'codex', nativeSessionId: 'native' })).body).agentId).toBe('agent');
  } finally { await host.close(); await broker.close(); }
});

function idleFixture() {
  const registration = fixture('codex');
  registration.directory.canReleaseSession = () => true;
  registration.directory.open = async id => {
    const old = registration.sessions.get(id);
    if (old && !old.disposed) return old;
    const session = new Session('codex', id); registration.sessions.set(id, session); return session;
  };
  const host = createAgentHostRuntime({ registrations: [registration], idleGraceMs: 1000, idleReconcileMs: 2000 });
  const attach = (id: string, parent?: string) => host.control({ method: 'POST', path: parent ? '/remote/child/attach' : '/remote/attach', sessionId: id,
    body: JSON.stringify({ providerId: 'codex', nativeSessionId: id, ...(parent ? { parentNativeSessionId: parent } : {}) }) });
  return { host, registration, attach };
}

it('preserves sessions through extended uplink outages and resets the whole grace on registration', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  try {
    await f.attach('native');
    const session = f.registration.sessions.get('native')!;
    await vi.advanceTimersByTimeAsync(900);
    f.host.setRelayConnected(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.disposed).toBe(false);
    f.host.setRelayConnected(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(session.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(session.disposed).toBe(true);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('protects running turns, pending interactions and native recovery without any browser', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  try {
    await f.attach('native');
    const session = f.registration.sessions.get('native')!;
    let seq = 0;
    const emit = (event: Extract<ProviderStreamItem, {type: 'observation'}>['event']) => session.emit({ type: 'observation', sourceKey: String(++seq), occurredAt: Date.now(), delivery: 'live', event });
    emit({ type: 'turn_started', provider: 'codex', turnId: 'turn' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.disposed).toBe(false);
    emit({ type: 'turn_completed', provider: 'codex', turnId: 'turn' });
    emit({ type: 'interaction_requested', provider: 'codex', request: { requestId: 'approval', kind: 'tool_approval', toolCallId: 'call', toolName: 'shell', summary: 'Run', detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.disposed).toBe(false);
    emit({ type: 'interaction_invalidated', provider: 'codex', requestId: 'approval', reason: 'Resolved elsewhere' });
    emit({ type: 'runtime_updated', provider: 'codex', runtimeInfo: { ...(await session.runtimeInfo()), connection: { state: 'reconnecting' } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.disposed).toBe(false);
    emit({ type: 'runtime_updated', provider: 'codex', runtimeInfo: { ...(await session.runtimeInfo()), connection: { state: 'connected' } } });
    await vi.advanceTimersByTimeAsync(1200);
    expect(session.disposed).toBe(true);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('keeps unconfirmed mutations pinned beyond the operation-cache retention interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  try {
    await f.attach('native');
    const lease = await f.host.acquireSession('native');
    let finish!: () => void;
    const pending = f.host.executeOperation('test')(lease!.agent,
      { operationId: operationId('unknown-idle'), kind: 'send_message', parameters: { text: 'only once' } },
      { dispatch: () => new Promise<void>((_resolve, reject) => { finish = () => reject(new Error('Outcome unknown')); }) });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    lease!.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.registration.sessions.get('native')!.disposed).toBe(false);
    finish(); await rejected;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(f.registration.sessions.get('native')!.disposed).toBe(false);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('detaches idle child projections before their parent and restores the family on demand', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  f.registration.directory.openChild = async (_parent, id) => f.registration.directory.open(id);
  try {
    await f.attach('parent'); await f.attach('child', 'parent');
    const parent = f.registration.sessions.get('parent')!, child = f.registration.sessions.get('child')!;
    const lease = await f.host.acquireSession('child');
    await vi.advanceTimersByTimeAsync(5000);
    expect(parent.disposed || child.disposed).toBe(false);
    lease!.release();
    await vi.advanceTimersByTimeAsync(1200);
    expect(child.disposed).toBe(true); expect(parent.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(parent.disposed).toBe(true);
    const [first, second] = await Promise.all([f.host.acquireSession('child'), f.host.acquireSession('child')]);
    expect(first!.agent).toBe(second!.agent);
    expect(f.registration.sessions.get('child')).not.toBe(child);
    expect(f.registration.sessions.get('parent')).not.toBe(parent);
    first!.release(); second!.release();
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('does not opt private or unspecified providers into automatic disposal', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  delete f.registration.directory.canReleaseSession;
  try {
    await f.attach('native');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.registration.sessions.get('native')!.disposed).toBe(false);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('serializes a returning viewer behind an in-progress native disposal', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  let finish!: () => void;
  try {
    await f.attach('native');
    const original = f.registration.sessions.get('native')!;
    const dispose = original.dispose.bind(original);
    original.dispose = () => new Promise<void>(resolve => { finish = () => { void dispose().then(resolve); }; });
    await vi.advanceTimersByTimeAsync(1100);
    let acquired = false;
    const returning = f.host.acquireSession('native').then(lease => { acquired = true; return lease; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(acquired).toBe(false);
    expect(f.registration.sessions.get('native')).toBe(original);
    finish();
    const lease = await returning;
    expect(f.registration.sessions.get('native')).not.toBe(original);
    lease!.release();
  } finally { finish?.(); await f.host.close(); vi.useRealTimers(); }
});

it('retries a failed dormant restoration without changing the binding or poisoning later opens', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  try {
    await f.attach('native');
    await vi.advanceTimersByTimeAsync(1100);
    const open = f.registration.directory.open;
    f.registration.directory.open = async () => { throw new Error('Native socket temporarily unavailable'); };
    await expect(f.host.acquireSession('native')).rejects.toThrow('temporarily unavailable');
    f.registration.directory.open = open;
    const lease = await f.host.acquireSession('native');
    expect(lease!.agent.snapshot().payload.id).toBe('native');
    lease!.release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.registration.sessions.get('native')!.disposed).toBe(true);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it('keeps native subscriptions across a real broken uplink until renewed browser demand arrives', async () => {
  const broker = await uplinkBroker('outage-host', false);
  const registration = fixture('codex'); registration.directory.canReleaseSession = () => true;
  const host = createAgentHost({ registrations: [registration], idleGraceMs: 100, installationId: 'outage', name: 'Host',
    uplink: { url: broker.url, remoteKey: 'key' } });
  try {
    await expect.poll(() => broker.registrations()).toBe(1); broker.register(); await host.ready;
    await broker.rpc('POST', '/remote/attach', 'agent', { providerId: 'codex', nativeSessionId: 'native' });
    broker.openStream('before-sleep', 'agent');
    await expect.poll(() => broker.streamOpened('before-sleep')).toBe(true);
    const native = registration.sessions.get('native')!;
    broker.pauseHeartbeat().terminate();
    await expect.poll(() => broker.registrations(), { timeout: 4000 }).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(native.disposed).toBe(false);
    broker.register();
    await expect.poll(() => host.state, { interval: 5 }).toBe('registered');
    broker.openStream('after-sleep', 'agent');
    await expect.poll(() => broker.streamOpened('after-sleep'), { interval: 5 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(native.disposed).toBe(false);
    broker.closeStream('after-sleep');
    await expect.poll(() => native.disposed).toBe(true);
  } finally { await host.close(); await broker.close(); }
});

it('reconciles uncertain idle operations without confirming or replaying their result', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  let safe = false;
  f.registration.directory.reconcileIdleSession = async () => safe;
  try {
    await f.attach('native');
    const lease = (await f.host.acquireSession('native'))!;
    const operation = { operationId: operationId('reconciled'), kind: 'send_message' as const, parameters: { text: 'once' } };
    let dispatches = 0;
    const work = { dispatch: async () => { dispatches++; throw new Error('Lost result'); } };
    await expect(f.host.executeOperation('test')(lease.agent, operation, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    lease.release();
    const original = f.registration.sessions.get('native')!;
    await vi.advanceTimersByTimeAsync(5000);
    expect(original.disposed).toBe(false);
    safe = true;
    await vi.advanceTimersByTimeAsync(900);
    expect(original.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(original.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(original.disposed).toBe(true);
    const restored = (await f.host.acquireSession('native'))!;
    await expect(f.host.executeOperation('test')(restored.agent, operation, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(dispatches).toBe(1);
    restored.release();
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it.each(['demand', 'reconnect', 'operation'] as const)('discards reconciliation after intervening %s', async change => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  let finish: ((safe: boolean) => void) | undefined;
  f.registration.directory.reconcileIdleSession = () => new Promise(resolve => { finish = resolve; });
  try {
    await f.attach('native');
    const fail = async (id: string) => {
      const lease = (await f.host.acquireSession('native'))!;
      try { await expect(f.host.executeOperation('test')(lease.agent,
        { operationId: operationId(id), kind: 'send_message', parameters: {} },
        { dispatch: async () => { throw new Error('Lost result'); } })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
      } finally { lease.release(); }
    };
    await fail('old');
    await vi.advanceTimersByTimeAsync(2500);
    expect(finish).toBeTypeOf('function');
    if (change === 'reconnect') { f.host.setRelayConnected(false); f.host.setRelayConnected(true); }
    else if (change === 'operation') await fail('new');
    else { const lease = (await f.host.acquireSession('native'))!; lease.release(); }
    finish!(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.registration.sessions.get('native')!.disposed).toBe(false);
  } finally { finish?.(false); await f.host.close(); vi.useRealTimers(); }
});


it('keeps partial child reconciliation pinned until the complete native check succeeds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = idleFixture();
  let discovered = false;
  let verified = false;
  f.registration.directory.canReleaseSession = () => discovered;
  f.registration.directory.reconcileIdleSession = async () => { discovered = true; return verified; };
  try {
    await f.attach('native');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.registration.sessions.get('native')!.disposed).toBe(false);
    verified = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.registration.sessions.get('native')!.disposed).toBe(true);
  } finally { await f.host.close(); vi.useRealTimers(); }
});

it.each([[false, false], [true, false], [true, true]])('restarts a live turn only when independent of the Controller: shared=%s tools=%s', async (preservesWorkOnDisconnect, requiresController) => {
  const registration = { ...fixture('codex'), preservesWorkOnDisconnect };
  registration.directory.requiresController = () => requiresController!;
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'live', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'live' }) });
    registration.sessions.get('live')!.emit({ type: 'observation', sourceKey: 'start', occurredAt: Date.now(), delivery: 'live', event: { type: 'turn_started', provider: 'codex', turnId: 'turn' } });
    await expect.poll(() => host.relay.requireAgent('live').snapshot().payload.activeTurn?.turnId).toBe('turn');
    expect(host.beginControllerRestart()).toBe(preservesWorkOnDisconnect && !requiresController);
    if (preservesWorkOnDisconnect && !requiresController) {
      const result = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'late', body: JSON.stringify({ providerId: 'codex', operationId: operationId('late') }) });
      expect(result.status).toBe(503); expect(registration.createCount()).toBe(0);
    }
  } finally { await host.close(); }
});
it('does not restart shared Codex while an approval is pending', async () => {
  const registration = { ...fixture('codex'), preservesWorkOnDisconnect: true };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'approval', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'approval' }) });
    registration.sessions.get('approval')!.emit({ type: 'observation', sourceKey: 'approval', occurredAt: Date.now(), delivery: 'live', event: {
      type: 'interaction_requested', provider: 'codex', request: { requestId: 'approval', kind: 'tool_approval', toolCallId: 'call', toolName: 'shell', summary: 'Run', detail: { type: 'shell', command: 'pwd' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] },
    } });
    await expect.poll(() => host.relay.requireAgent('approval').snapshot().payload.pendingInteractions.length).toBe(1);
    expect(host.beginControllerRestart()).toBe(false);
  } finally { await host.close(); }
});
it('waits for an admitted create operation before closing mutation admission', async () => {
  const registration = { ...fixture('codex'), preservesWorkOnDisconnect: true };
  const original = registration.directory.create;
  let entered = false, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  registration.directory.create = async input => { entered = true; await blocked; return original(input); };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    const creating = host.control({ method: 'POST', path: '/remote/create', sessionId: 'new', body: JSON.stringify({ providerId: 'codex', operationId: operationId('upgrade-create') }) });
    await expect.poll(() => entered).toBe(true);
    expect(host.beginControllerRestart()).toBe(false);
    release(); expect((await creating).status).toBe(200);
    await expect.poll(() => host.beginControllerRestart()).toBe(true);
    host.cancelControllerRestart();
    expect((await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'next', body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'next' }) })).status).toBe(200);
  } finally { release(); await host.close(); }
});
it('does not restart after an unknown native create outcome', async () => {
  const registration = { ...fixture('codex'), preservesWorkOnDisconnect: true };
  registration.directory.create = async () => { throw new Error('Native create acknowledgement lost'); };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    const result = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'unknown', body: JSON.stringify({ providerId: 'codex', operationId: operationId('upgrade-unknown') }) });
    expect(JSON.parse(result.body).code).toBe('operation_outcome_unknown');
    expect(host.beginControllerRestart()).toBe(false);
  } finally { await host.close(); }
});
