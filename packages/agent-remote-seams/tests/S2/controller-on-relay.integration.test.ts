import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, AgentProviderAdapter, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from '@orchardworks/agent-provider-codex';
import { createScriptedAppServer } from '@orchardworks/agent-provider-codex/testing';
import { createAgentHost, createCodexSessionDirectory, createHostProviderDiscovery, type AgentHostDirectory } from '@orchardworks/agent-remote-controller';
import { connectToRelay } from '@orchardworks/agent-remote-fixtures';
import { createHostBroker } from '@orchardworks/agent-relay-core';
import { createRemoteHostUplinkClient, type RemoteHostUplinkClientOptions } from '@orchardworks/agent-session-runtime';

/**
 * S2, Controller to Relay uplink, with the real Controller host and the real Relay joined by an in-memory socket (the uplink client's
 * `connect` port answered by the Relay's `prepareUpgrade`). What is asserted is what only the two together decide: how a Controller's
 * answer reaches the Relay's HTTP callers, and what the Relay knows of the Host afterwards. Nothing listens on a port.
 */
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

class IdleSession implements AgentSession {
  readonly capabilities = capabilities;
  disposed = false;
  private release: (() => void) | undefined;
  constructor(readonly providerId: string, readonly nativeSessionId: string) {}
  async *observe(): AsyncIterable<ProviderStreamItem> {
    yield { type: 'history_boundary' };
    if (!this.disposed) await new Promise<void>(resolve => { this.release = resolve; });
  }
  async runtimeInfo() { return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle' as const, persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } }; }
  async sendMessage(): Promise<void> {}
  async respondToInteraction(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; this.release?.(); }
}

function provider(providerId: string, open?: (nativeSessionId: string) => Promise<AgentSession>) {
  const sessions = new Map<string, IdleSession>();
  const adapter: AgentProviderAdapter = { descriptor: { providerId, displayName: providerId.toUpperCase() },
    async createSession() { throw new Error('The Host supplies directory sessions.'); }, async resumeSession() { throw new Error('The Host supplies directory sessions.'); } };
  const directory: AgentHostDirectory = { providerId, list: async () => [], workspaces: async () => [], create: async () => `${providerId}-1`,
    async open(id) { if (open) return open(id); const session = sessions.get(id) ?? new IdleSession(providerId, id); sessions.set(id, session); return session; },
    async close() { await Promise.all([...sessions.values()].map(session => session.dispose())); } };
  return { adapter, directory, sessions };
}

async function relayWith(options: Partial<Parameters<typeof createHostBroker>[0]> = {}) {
  const broker = createHostBroker({ origin: 'http://relay.test', rpcTimeoutMs: 1000, ...options });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request('http://relay.test/v1/remote/pairings', { method: 'POST', body: '{}' }), options.ownerSubject ? { principalSubject: () => options.ownerSubject } : undefined);
  const { key } = await pairing!.json();
  return { broker, key, uplink: { url: 'ws://relay.test/ws/remote-host', remoteKey: key as string }, connect: connectToRelay(broker, closers) };
}

const createUplink = (options: RemoteHostUplinkClientOptions, connect: NonNullable<RemoteHostUplinkClientOptions['connect']>) => createRemoteHostUplinkClient({ reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 40, ...options, connect });

const attach = (broker: ReturnType<typeof createHostBroker>, hostId: string, body: unknown) =>
  broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify(body) }));

describe('S2 the Controller answers a Relay caller through the uplink', () => {
  it.each(['workspace', 'resume'] as const)('preserves confirmed native session unavailability from %s through the Host and Relay uplink', async stage => {
    const relay = await relayWith();
    const nativeSessionId = '00000000-0000-4000-8000-000000000031';
    const apps: ReturnType<typeof createScriptedAppServer>[] = [];
    const adapter = new CodexAppServerProvider({ spawn: () => {
      const app = createScriptedAppServer({
        'thread/read': () => { throw Object.assign(new Error(`thread not loaded: ${nativeSessionId}`), { code: -32600 }); },
        'thread/resume': () => { throw Object.assign(new Error(`no rollout found for thread id ${nativeSessionId}`), { code: -32600 }); },
      });
      apps.push(app); return app.child;
    } });
    const diagnostics: unknown[] = [];
    const host = createAgentHost({ registrations: [{ adapter, directory: createCodexSessionDirectory(adapter, []) }], installationId: 'unavailable-host', name: 'Host',
      ...(stage === 'workspace' ? { executionPolicy: { defaultWorkspace: '/workspace', allowedWorkspaceRoots: ['/workspace'], lockPermissions: true } } : {}),
      uplink: relay.uplink, uplinkClient: options => createUplink(options, relay.connect), onRequestDiagnostic(diagnostic) { diagnostics.push(diagnostic); } });
    closers.push(() => host.close());
    const { hostId } = await host.ready;
    const response = await attach(relay.broker, hostId, { providerId: 'codex', nativeSessionId });
    expect(response?.status).toBe(404);
    const failure = await response!.json();
    expect(failure).toMatchObject({ code: 'native_session_unavailable', error: expect.stringContaining('could not find this session'), requestId: expect.any(String) });
    expect(failure.error).not.toMatch(/00000000|rollout|empty|deleted/);
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'host_request_completed', requestId: failure.requestId, operation: 'session_attach', code: 'native_session_unavailable', status: 404 }));
    const methods = apps.flatMap(app => app.requests.map(request => request.method));
    expect(methods).not.toContain('thread/start');
    expect(methods).not.toContain('turn/start');
    if (stage === 'workspace') expect(methods).toEqual(['initialize', 'thread/read']);
    else expect(methods).toContain('thread/resume');
    expect(relay.broker.snapshot().bindings).toHaveLength(0);
  });

  it('reuses a slow native opening after a Relay timeout', async () => {
    const relay = await relayWith({ rpcTimeoutMs: 50 });
    const registration = provider('codex');
    const open = registration.directory.open;
    let release!: () => void, completed!: () => void, openings = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const settled = new Promise<void>(resolve => { completed = resolve; });
    registration.directory.open = async id => { openings++; await gate; return open(id); };
    const diagnostics: Array<{ requestId: string; event: string }> = [];
    const host = createAgentHost({ registrations: [registration], installationId: 'slow-host', name: 'Host', uplink: relay.uplink, uplinkClient: options => createUplink(options, relay.connect),
      onRequestDiagnostic(diagnostic) { diagnostics.push(diagnostic); if (diagnostic.event === 'host_request_completed') completed(); } });
    closers.push(() => { release(); return host.close(); });
    const { hostId } = await host.ready;
    const request = () => attach(relay.broker, hostId, { providerId: 'codex', nativeSessionId: 'slow-native' });
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
  });
});

describe('S2 the Relay follows the providers a Controller offers', () => {
  it('discovers providers and persists owner preferences without interrupting sessions, and the Relay survives a broken socket', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'host-provider-live-'));
    closers.push(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const relay = await relayWith({ ownerSubject: 'owner' });
    const owner = { principalSubject: () => 'owner' };
    const sockets: Array<{ terminate(): void }> = [];
    const connect: typeof relay.connect = (endpoint, init) => { const socket = relay.connect(endpoint, init); sockets.push(socket); return socket; };
    let available = false;
    const codex = provider('codex'), claude = provider('claude');
    const discovery = await createHostProviderDiscovery({ stateDir, env: { AGENT_HOST_PROVIDERS: 'codex' }, create: async id => {
      if (id === 'codex') return codex;
      if (id === 'claude' && available) return claude;
      throw new Error('Not installed');
    } });
    closers.push(() => discovery.stop());
    const host = createAgentHost({ registrations: discovery.registrations, providerDiscovery: discovery, providerEnabled: discovery.enabled,
      installationId: 'provider-host', name: 'Providers', uplink: relay.uplink, uplinkClient: options => createUplink(options, connect) });
    closers.push(() => host.close());
    const { hostId } = await host.ready;
    const request = async (path: string, input?: unknown, context = owner) => relay.broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/${path}`, input ? { method: 'POST', body: JSON.stringify(input) } : {}), context);
    const providers = () => relay.broker.visibleHosts('owner')[0]!.providers.map(item => item.providerId);
    expect(providers()).toEqual(['codex']);
    const opened = await request('attach', { providerId: 'codex', nativeSessionId: 'active' });
    expect(opened?.status).toBe(200);
    const { agentId } = await opened!.json();
    available = true;
    expect((await request('provider-settings', { refresh: true }))?.status).toBe(200);
    await expect.poll(providers).toEqual(['codex', 'claude']);
    expect((await request('attach', { providerId: 'claude', nativeSessionId: 'new-provider' }))?.status).toBe(200);
    const settings = await (await request('provider-settings'))!.json();
    expect((await request('provider-settings', { providerId: 'codex', enabled: false, revision: settings.revision }))?.status).toBe(200);
    await expect.poll(providers).toEqual(['claude']);
    expect(codex.sessions.get('active')?.disposed).toBe(false);
    expect((await request('attach', { providerId: 'codex', nativeSessionId: 'another' }))?.status).toBe(400);
    expect((await request('provider-settings', undefined, { principalSubject: () => 'stranger' }))?.status).toBe(403);
    expect(host.state).toBe('registered');
    expect(relay.broker.snapshot().hosts[0]).toMatchObject({ providerManagement: true, providers: [{ providerId: 'claude' }] });
    sockets.at(-1)!.terminate();
    await expect.poll(() => sockets.length === 2 && host.state === 'registered').toBe(true);
    expect(providers()).toEqual(['claude']);
    const recovered = await relay.broker.handleRequest(new Request(`http://relay.test/v1/sessions/${agentId}/snapshot?protocolVersion=1.8.0`), owner);
    expect(recovered?.status, await recovered?.text()).toBe(200);
    expect(codex.sessions.get('active')?.disposed).toBe(false);
  });
});
