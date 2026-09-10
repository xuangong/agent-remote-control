// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteHostBroker } from './remote-host-broker.js';
import type { AgentMessageOptions, AgentSession } from '@borgee/agent-provider-sdk';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(options = {}) {
  const server = createServer((_, response) => { response.statusCode = 404; response.end(); });
  const broker = createRemoteHostBroker({ origin: 'http://127.0.0.1:6175', ...options });
  broker.install(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => { await broker.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const post = (path: string, body = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { url, post };
}
async function host(url: string, key: string, installationId = 'native-installation') {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
  await once(socket, 'open');
  const registration = once(socket, 'message');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'My DSH', providerId: 'dsh' }));
  const [message] = await registration; const result = JSON.parse(message.toString());
  return { socket, id: result.hostId as string };
}
async function providerHost(url: string, key: string, installationId = 'provider-installation') {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
  await once(socket, 'open');
  const registration = once(socket, 'message');
  const providers = [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'example', displayName: 'Example' }];
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'Agent Host', providers }));
  const [message] = await registration;
  return { socket, id: JSON.parse(message.toString()).hostId as string, providers };
}
describe('Remote Host broker', () => {
  it('issues temporary keys, binds one installation, and keeps disconnected hosts visible', async () => {
    const f = await setup();
    const pair = await (await f.post('/v1/remote/pairings')).json();
    expect(pair.key).toMatch(/^arc_/); expect(Date.parse(pair.expiresAt)).toBeGreaterThan(Date.now());
    const native = await host(f.url, pair.key);
    expect(await (await fetch(f.url + '/v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: native.id, online: true, name: 'My DSH' }] });
    native.socket.close(); await once(native.socket, 'close');
    expect(await (await fetch(f.url + '/v1/remote/hosts')).json()).toMatchObject({ hosts: [{ online: false }] });
    const again = await host(f.url, pair.key); expect(again.id).toBe(native.id);
  });
  it('requires keys for uplinks and exact local origin for key creation', async () => {
    const f = await setup();
    expect((await fetch(f.url + '/v1/remote/pairings', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host');
    const rejection = await new Promise<number>((resolve) => socket.once('unexpected-response', (_, response) => { resolve(response.statusCode!); response.resume(); }));
    expect(rejection).toBe(401); socket.terminate(); socket.on('error', () => undefined);
  });
  it('forwards catalog reads and attaches with a stable browser binding', async () => {
    const f = await setup(); const pair = await (await f.post('/v1/remote/pairings')).json(); const native = await host(f.url, pair.key);
    const calls: any[] = [];
    native.socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()); calls.push(request);
      if (request.type !== 'rpc_request') return;
      const body = request.path.startsWith('/remote/catalog') ? { sessions: [{ nativeSessionId: 'cold' }], revision: 'r1' } : { nativeSessionId: 'cold' };
      native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status: 200, body: JSON.stringify(body) }));
    });
    const base = `/v1/remote/hosts/${native.id}`;
    expect(await (await fetch(f.url + base + '/catalog?limit=10')).json()).toMatchObject({ sessions: [{ nativeSessionId: 'cold' }] });
    expect(await (await fetch(f.url + base + '/models?providerId=dsh')).json()).toEqual({ models: [] });
    expect(calls.some((call) => call.path?.startsWith('/remote/models'))).toBe(false);
    const attached = await (await f.post(base + '/attach', { nativeSessionId: 'cold' })).json();
    const repeated = await (await f.post(base + '/attach', { nativeSessionId: 'cold' })).json();
    expect(repeated).toEqual(attached); expect(attached.agentId).toBeTruthy();
    expect(calls.find((call) => call.path === '/remote/attach')).toMatchObject({ sessionId: attached.agentId });
    expect((await fetch(f.url + `/v1/sessions/${attached.agentId}/snapshot?protocolVersion=1.4.0`)).status).toBe(200);
  });
  it('bounds RPC waits and never repeats an uncertain creation', async () => {
    const f = await setup({ rpcTimeoutMs: 40 }); const pair = await (await f.post('/v1/remote/pairings')).json(); const native = await host(f.url, pair.key);
    const messages: any[] = []; native.socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    const path = `/v1/remote/hosts/${native.id}/create`;
    expect((await f.post(path, { requestId: 'once', workspaceId: 'workspace' })).status).toBe(504);
    expect((await f.post(path, { requestId: 'once', workspaceId: 'workspace' })).status).toBe(504);
    expect(messages.filter((message) => message.type === 'rpc_request')).toHaveLength(1);
    expect((await f.post(path, { requestId: 'once', workspaceId: 'different' })).status).toBe(409);
  });
  it('forwards provider-scoped discovery and adopts conflict-checked Host identities', async () => {
    const f = await setup(); const pair = await (await f.post('/v1/remote/pairings')).json(); const native = await providerHost(f.url, pair.key);
    const calls: any[] = [];
    native.socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()); calls.push(request);
      if (request.type !== 'rpc_request') return;
      const requestBody = request.body ? JSON.parse(request.body) : undefined;
      const responseBody = request.path === '/remote/create'
        ? { agentId: 'host-agent', nativeSessionId: 'native-created' }
        : request.path.endsWith('/attach')
          ? { agentId: requestBody.nativeSessionId === 'native-child' ? 'host-child'
              : requestBody.nativeSessionId === 'native-parent' ? 'host-parent' : `host-${requestBody.nativeSessionId}`,
              nativeSessionId: requestBody.nativeSessionId }
          : { items: [] };
      native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status: 200, body: JSON.stringify(responseBody) }));
    });
    const base = `/v1/remote/hosts/${native.id}`;
    expect(await (await fetch(f.url + '/v1/remote/hosts')).json()).toMatchObject({ hosts: [{ providers: native.providers }] });
    await fetch(f.url + base + '/catalog?providerId=codex&limit=2');
    await fetch(f.url + base + '/workspaces?providerId=codex');
    await fetch(f.url + base + '/models?providerId=codex');
    const created = await (await f.post(base + '/create', { providerId: 'codex', requestId: 'create-one', cwd: '/tmp/project',
      workspaceId: 'project', model: 'gpt-6', reasoningEffort: 'high', planning: true })).json();
    expect(created).toEqual({ agentId: 'host-agent', nativeSessionId: 'native-created' });
    expect(calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
      '/remote/catalog?providerId=codex&limit=2', '/remote/workspaces?providerId=codex', '/remote/models?providerId=codex',
    ]);
    expect(JSON.parse(calls.find((call) => call.path === '/remote/create').body)).toEqual({ providerId: 'codex', requestId: 'create-one',
      cwd: '/tmp/project', workspaceId: 'project', model: 'gpt-6', reasoningEffort: 'high', planning: true });
    expect((await f.post(base + '/create', { providerId: 'codex', requestId: 'create-one', cwd: '/different' })).status).toBe(409);
    const parent = await (await f.post(base + '/attach', { providerId: 'codex', nativeSessionId: 'native-parent' })).json();
    const child = await (await f.post(base + '/child/attach', { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' })).json();
    expect(parent.agentId).toBe('host-parent'); expect(child.agentId).toBe('host-child');
    expect((await f.post(base + '/child/attach', { providerId: 'codex', parentNativeSessionId: 'other-parent', nativeSessionId: 'native-child' })).status).toBe(409);
    expect((await f.post(base + '/attach', { providerId: 'codex', nativeSessionId: 'native-child' })).status).toBe(409);
    const concurrent = await Promise.all([
      f.post(base + '/child/attach', { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-race' }),
      f.post(base + '/child/attach', { providerId: 'codex', parentNativeSessionId: 'other-parent', nativeSessionId: 'native-race' }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const reconnected = await providerHost(f.url, pair.key);
    expect(reconnected.id).toBe(native.id);
    const recovery: string[] = [];
    reconnected.socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type !== 'rpc_request') return;
      recovery.push(request.path);
      const body = request.body ? JSON.parse(request.body) : {};
      const agentId = body.nativeSessionId === 'native-child' ? 'host-child' : 'host-parent';
      reconnected.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status: 200,
        body: request.path.startsWith('/remote/') ? JSON.stringify({ agentId, nativeSessionId: body.nativeSessionId }) : '{}' }));
    });
    expect((await fetch(f.url + `/v1/sessions/${child.agentId}/snapshot?protocolVersion=1.4.0`)).status).toBe(200);
    expect(recovery).toEqual(['/remote/attach', '/remote/child/attach', `/v1/sessions/${child.agentId}/snapshot?protocolVersion=1.4.0`]);
  });
});

it('carries native-host discovery, creation, snapshots, and chat through the production uplink client', async () => {
  const { createAgentRemoteRelay, createRemoteHostUplinkClient } = await import('@borgee/agent-remote-relay');
  const { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } = await import('@borgee/agent-remote-web/headless');
  const { createRecordedLabProvider } = await import('./recorded.js');
  const { vi } = await import('vitest');
  const f = await setup(); const pair = await (await f.post('/v1/remote/pairings')).json();
  const provider = createRecordedLabProvider({ capabilities: { queueMessage: true } }).provider;
  const nativeSessions: AgentSession[] = [];
  const deliveries: Array<{ text: string; options?: AgentMessageOptions }> = [];
  const createSession = provider.createSession.bind(provider);
  provider.createSession = async (config) => {
    const session = await createSession(config);
    nativeSessions.push(session);
    const send = session.sendMessage.bind(session);
    session.sendMessage = async (text, options) => {
      deliveries.push({ text, options });
      await send(text);
    };
    return session;
  };
  const relay = createAgentRemoteRelay({ providers: [provider] });
  cleanup.push(() => relay.close());
  const sessions = new Set(['cold-session']); const agents = new Set<string>(); const nativeBindings = new Map<string, string>();
  const connect = () => createRemoteHostUplinkClient({
    relay, url: f.url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: pair.key,
    installationId: 'production-client', name: 'Production client',
    resolveSession: (id) => agents.has(id) ? relay.requireAgent(id) : undefined,
    async control(request) {
      if (request.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [...sessions].map((nativeSessionId) => ({ nativeSessionId, providerId: 'dsh' })), revision: '1', nextCursor: null }) };
      if (request.path === '/remote/workspaces') return { status: 200, body: JSON.stringify({ workspaces: [{ id: 'workspace', path: '/tmp/native' }] }) };
      const body = JSON.parse(request.body!);
      const bound = nativeBindings.get(body.nativeSessionId);
      if (bound && bound !== request.sessionId) return { status: 409, body: JSON.stringify({ code: 'session_already_bound' }) };
      nativeBindings.set(body.nativeSessionId, request.sessionId!);
      if (request.path === '/remote/create') sessions.add(body.nativeSessionId);
      if (!sessions.has(body.nativeSessionId)) return { status: 404, body: '{}' };
      let existing = false; try { relay.requireAgent(request.sessionId!); existing = true; } catch {}
      if (!existing) await relay.createAgent({ protocolVersion: '1.4.0', type: 'create_agent', payload: { requestId: request.sessionId!, agentId: request.sessionId!, providerId: 'recorded', config: { sessionId: body.nativeSessionId } } });
      agents.add(request.sessionId!);
      return { status: 200, body: JSON.stringify({ nativeSessionId: body.nativeSessionId }) };
    },
  });
  const uplink = connect(); cleanup.push(() => uplink.close());
  const { hostId } = await uplink.ready; const base = `/v1/remote/hosts/${hostId}`;
  expect(await (await fetch(f.url + base + '/catalog')).json()).toMatchObject({ items: [{ nativeSessionId: 'cold-session' }] });
  expect(await (await fetch(f.url + base + '/workspaces')).json()).toMatchObject({ workspaces: [{ id: 'workspace' }] });
  const opened = await (await f.post(base + '/attach', { nativeSessionId: 'cold-session' })).json();
  const created = await (await f.post(base + '/create', { requestId: 'new-native', workspaceId: 'workspace' })).json();
  expect(created.nativeSessionId).not.toBe('cold-session');
  expect(await (await f.post(base + '/attach', { nativeSessionId: created.nativeSessionId })).json()).toEqual(created);
  const transport = new HttpWebSocketTransport(f.url, { webSocketFactory: (url) => new WebSocket(url, { headers: { origin: 'http://127.0.0.1:6175' } }) as never });
  expect((await transport.fetchSnapshot(opened.agentId)).payload.id).toBe(opened.agentId);
  const replica = new AgentReplica(); const client = new RemoteSessionClient(created.agentId, transport, replica, { operationTimeoutMs: 3000 });
  cleanup.push(async () => client.stop());
  let status = ''; client.subscribeStatus((value) => { status = value; }); client.start();
  await vi.waitFor(() => expect(status).toBe('ready'));
  expect((await client.sendMessage('Across the host uplink')).type).toBe('command_acknowledged');
  await vi.waitFor(() => expect(JSON.stringify(replica.getState().timeline)).toContain('Recorded reply: Across the host uplink'));
  const queuedText = '  Keep this text\nexactly as submitted  ';
  expect((await client.sendMessage(queuedText, { delivery: 'next_turn' })).payload.command).toBe('send_message');
  expect(deliveries).toEqual([
    { text: 'Across the host uplink', options: undefined },
    { text: queuedText, options: { delivery: 'next_turn' } },
  ]);
  for (const session of nativeSessions) delete session.capabilities.queueMessage;
  await expect(client.sendMessage('Unsupported queue', { delivery: 'next_turn' })).rejects.toMatchObject({ code: 'unsupported_command', recoverable: true });
  expect(deliveries).toHaveLength(2);
  client.stop();
  await uplink.close();
  agents.clear(); nativeBindings.clear();
  const reconnected = connect(); cleanup.push(() => reconnected.close());
  expect((await reconnected.ready).hostId).toBe(hostId);
  // Native conversation state survives while the new host connection must restore its binding projection.
  const snapshot = await transport.fetchSnapshot(created.agentId);
  expect(snapshot.payload.id).toBe(created.agentId);
  client.start(); await vi.waitFor(() => expect(status).toBe('ready'));
  expect((await client.sendMessage('After reconnect')).type).toBe('command_acknowledged');
});

it('rejects expired credentials and prevents a bound key from registering another installation', async () => {
  const expired = await setup({ keyLifetimeMs: -1 });
  const expiredPair = await (await expired.post('/v1/remote/pairings')).json();
  const socket = new WebSocket(expired.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${expiredPair.key}` } });
  socket.on('error', () => undefined);
  expect(await new Promise<number>((resolve) => socket.once('unexpected-response', (_, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); }))).toBe(401);
  const f = await setup(); const pair = await (await f.post('/v1/remote/pairings')).json();
  const original = await host(f.url, pair.key, 'first-installation');
  const foreign = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${pair.key}` } });
  await once(foreign, 'open'); const closing = once(foreign, 'close');
  foreign.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'other-installation', name: 'Other', providerId: 'dsh' }));
  expect((await closing)[0]).toBe(1008);
  expect(await (await fetch(f.url + '/v1/remote/hosts')).json()).toMatchObject({ hosts: [{ id: original.id, online: true }] });
});
