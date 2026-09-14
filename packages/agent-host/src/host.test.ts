import type { AgentCapabilities, AgentProviderAdapter, AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@borgee/agent-provider-sdk';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createCodexSessionDirectory } from './directory.js';
import { createAgentHost, createAgentHostRuntime, type AgentHostDirectory } from './host.js';
import { CodexAppServerProvider } from '../../agent-provider-codex/src/provider.js';
import { createScriptedAppServer } from '../../agent-provider-codex/src/test-utils/scripted-app-server.js';

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

class Session implements AgentSession {
  readonly capabilities = capabilities;
  disposed = false;
  observeCount = 0;
  private release!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.release = resolve; });
  constructor(readonly providerId: string, readonly nativeSessionId: string) {}
  async *observe(): AsyncIterable<ProviderStreamItem> { this.observeCount += 1; yield { type: 'history_boundary' }; await this.closed; }
  async runtimeInfo(): Promise<AgentRuntimeInfo> { return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle',
    persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } }; }
  async sendMessage(): Promise<void> {}
  async respondToInteraction(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; this.release(); }
}

function fixture(providerId: string) {
  const sessions = new Map<string, Session>();
  let creates = 0;
  const adapter: AgentProviderAdapter = { descriptor: { providerId, displayName: providerId.toUpperCase() },
    async createSession() { throw new Error('Host must supply directory sessions.'); },
    async resumeSession() { throw new Error('Host must supply directory sessions.'); } };
  const directory: AgentHostDirectory = { providerId, list: async () => [], workspaces: async () => [],
    async create() { const id = `${providerId}-${++creates}`; const session = new Session(providerId, id); sessions.set(id, session); return id; },
    async open(id) { const session = sessions.get(id) ?? new Session(providerId, id); sessions.set(id, session); return session; },
    async close() { await Promise.all([...sessions.values()].map((session) => session.dispose())); } };
  return { adapter, directory, sessions, createCount: () => creates };
}

describe('Agent Host runtime', () => {
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
      expect(JSON.parse(result.body)).toEqual({ code: 'mutation_outcome_unknown', error: 'Remote Host operation outcome is unknown.' });
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

  it('advertises Codex, Claude and Copilot over real WebSockets and preserves provider-scoped identities across re-pair', async () => {
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
        const created = await first.rpc('POST', '/remote/create', `${providerId}-created`, { providerId, requestId: 'same-request' });
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
        const recovered = await second.rpc('POST', '/remote/create', `${providerId}-new-created`, { providerId, requestId: 'same-request' });
        expect(JSON.parse(recovered.body).agentId).toBe(`${providerId}-created`);
        expect(provider.createCount()).toBe(1);
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
      body: JSON.stringify({ providerId: 'codex', requestId: 'late' }) });
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
    void host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'codex', requestId: 'blocked' }) });
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
      const created = await first.rpc('POST', '/remote/create', 'relay', { providerId: 'codex', requestId: 'create' });
      expect(JSON.parse(created.body)).toEqual({ agentId: 'relay', nativeSessionId: 'codex-1' });
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      const attached = await second.rpc('POST', '/remote/attach', 'relay', { providerId: 'codex', nativeSessionId: 'codex-1' });
      expect(JSON.parse(attached.body)).toEqual({ agentId: 'relay', nativeSessionId: 'codex-1' });
      expect(codex.createCount()).toBe(1);
    } finally { await host.close(); await first.close(); await second.close(); }
  });
  it('recovers a completed creation across real uplink replacement despite a new proposed Agent identity', async () => {
    const first = await uplinkBroker('host-first'); const second = await uplinkBroker('host-second');
    const codex = fixture('codex');
    const host = createAgentHost({ registrations: [{ adapter: codex.adapter, directory: codex.directory }], installationId: 'installation', name: 'Host',
      uplink: { url: first.url, remoteKey: 'first-key' } });
    try {
      await host.ready;
      const created = await first.rpc('POST', '/remote/create', 'broker-before', { providerId: 'codex', requestId: 'stable-request', cwd: '/work' });
      await host.replaceUplink({ url: second.url, remoteKey: 'second-key' });
      const recovered = await second.rpc('POST', '/remote/create', 'broker-after', { providerId: 'codex', requestId: 'stable-request', cwd: '/work' });
      expect(recovered).toEqual(created);
      expect(JSON.parse(recovered.body)).toEqual({ agentId: 'broker-before', nativeSessionId: 'codex-1' });
      expect(codex.createCount()).toBe(1);
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
      expect(expired).toEqual({ status: 409, body: JSON.stringify({ error: 'The catalog read view is unavailable. Refresh the catalog.', code: 'cursor_expired' }) });
      const invalidCursor = await broker.rpc('GET', '/remote/catalog?providerId=codex&cursor=invalid');
      expect(invalidCursor).toEqual({ status: 400, body: JSON.stringify({ error: 'Invalid catalog cursor.', code: 'invalid_request' }) });
      const invalidLimit = await broker.rpc('GET', '/remote/catalog?providerId=codex&limit=0');
      expect(invalidLimit).toEqual({ status: 400, body: JSON.stringify({ error: 'Catalog page size must be an integer from 1 to 100.', code: 'invalid_request' }) });
      const unavailable = await broker.rpc('GET', '/remote/catalog?providerId=failing');
      expect(unavailable).toEqual({ status: 503, body: JSON.stringify({ error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable' }) });
    } finally { await host.close(); await broker.close(); }
  });
  it('returns both identities and deduplicates a creation request', async () => {
    const codex = fixture('codex');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }] });
    try {
      const body = JSON.stringify({ providerId: 'codex', requestId: 'request-1', cwd: '/work' });
      const first = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay-1', body });
      const second = await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay-1', body });
      expect(JSON.parse(first.body)).toEqual({ agentId: 'relay-1', nativeSessionId: 'codex-1' });
      expect(second).toEqual(first);
      expect(codex.createCount()).toBe(1);
    } finally { await host.close(); }
  });

  it('isolates providers and rejects request identity reuse with different settings', async () => {
    const codex = fixture('codex'); const dsh = fixture('dsh');
    const host = createAgentHostRuntime({ registrations: [{ adapter: codex.adapter, directory: codex.directory }, { adapter: dsh.adapter, directory: dsh.directory }] });
    try {
      const request = (providerId: string, cwd: string) => host.control({ method: 'POST', path: '/remote/create', sessionId: `${providerId}-relay`,
        body: JSON.stringify({ providerId, requestId: 'same', cwd }) });
      expect((await request('codex', '/one')).status).toBe(200);
      expect((await request('dsh', '/two')).status).toBe(200);
      expect((await request('codex', '/different')).status).toBe(409);
      expect((await host.control({ method: 'POST', path: '/remote/create', sessionId: 'codex-relay',
        body: JSON.stringify({ providerId: 'codex', requestId: 'another', cwd: '/one' }) })).status).toBe(409);
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
    await host.control({ method: 'POST', path: '/remote/create', sessionId: 'relay', body: JSON.stringify({ providerId: 'codex', requestId: 'r' }) });
    const session = codex.sessions.get('codex-1')!;
    expect(session.disposed).toBe(false);
    await host.close(); await host.close();
    expect(session.disposed).toBe(true);
  });
});

async function uplinkBroker(hostId: string, autoRegister = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let socket: WebSocket | undefined;
  let providers: unknown;
  let resolveConnected!: () => void;
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
  server.on('connection', (connection) => {
    socket = connection;
    resolveConnected();
    connection.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { type: string; providers?: unknown };
      if (message.type === 'register') providers = message.providers;
      if (message.type === 'register' && autoRegister) connection.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId }));
    });
  });
  const address = server.address() as { port: number };
  let sequence = 0;
  return {
    url: `ws://127.0.0.1:${address.port}/ws/remote-host`,
    connected,
    advertisedProviders: () => providers,
    issueCredential(credential: string) { socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_issued', credential })); },
    register() { socket?.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId })); },
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
    if (id === 'ok' || id === 'failed') {
      Object.assign(session, { capabilities: { ...capabilities, cancel: true }, cancel: async () => {
        if (id === 'failed') throw new Error('native error contains secret'); cancelled++;
      } });
    }
    return session;
  };
  const host = createAgentHostRuntime({ registrations: [registration] });
  try {
    for (const id of ['ok', 'unsupported', 'failed']) await host.control({ method: 'POST', path: '/remote/attach', sessionId: id, body: JSON.stringify({ providerId: 'recorded', nativeSessionId: id }) });
    const response = await host.control({ method: 'POST', path: '/remote/stop', body: '{}' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ results: [
      { agentId: 'ok', status: 'cancelled' }, { agentId: 'unsupported', status: 'unsupported', message: 'The native session does not support cancellation.' },
      { agentId: 'failed', status: 'failed', message: 'Native cancellation did not complete.' },
    ] });
    expect(cancelled).toBe(1); expect(response.body).not.toContain('secret');
    expect((await host.control({ method: 'POST', path: '/remote/stop', body: '{"unexpected":true}' })).status).toBe(400);
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
    expect(JSON.parse((await host.control({ method: 'POST', path: '/remote/stop', body: '{}' })).body)).toEqual({ results: [
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
    const result = await broker.rpc('POST', '/remote/stop', undefined, {});
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ results: [{ agentId: 'agent', status: 'unsupported', message: 'The native session does not support cancellation.' }] });
  } finally { await host.close(); await broker.close(); }
});
