// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentProviderAdapter, AgentSession } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type ClientMessage } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { createProtocolValidationServer } from './server.js';

it('transfers web control over real sockets without stopping a running stdio session', async () => {
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const sendMessage = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const dispose = vi.fn(async () => { finish(); });
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; await completed; },
    sendMessage, cancel, dispose, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'stdio-fixture', sessionId: 'native', status: 'running' }; },
  };
  const createSession = vi.fn(async () => session);
  const resumeSession = vi.fn(async () => session);
  const provider: AgentProviderAdapter = { descriptor: { providerId: 'stdio-fixture', displayName: 'Stdio fixture' }, createSession, resumeSession };
  const server = createProtocolValidationServer({ providers: [provider], labOrigin: 'http://localhost' });
  const clients: RemoteSessionClient[] = [];
  const observed: unknown[] = [];
  const tokens = new Set<string>();
  try {
    const { url } = await server.http.listen();
    async function connect(create = false, clientKind: 'web' | 'headless' = 'web') {
      let socket!: WebSocket;
      const sockets: WebSocket[] = [];
      const transport = new HttpWebSocketTransport(url, { sessionChannels: false, webSocketFactory: url => {
        socket = new WebSocket(url, { origin: 'http://localhost' });
        sockets.push(socket);
        socket.on('message', data => { const value = JSON.parse(data.toString()); if (value.type === 'session_control' && value.payload.token) tokens.add(value.payload.token); });
        return socket as unknown as WebSocketLike;
      } });
      transport.onProtocolMessage(event => observed.push(event));
      if (create) await transport.createAgent('agent', 'stdio-fixture', { sessionId: 'native' });
      const replica = new AgentReplica();
      const client = new RemoteSessionClient('agent', transport, replica, { operationTimeoutMs: 2000, requireSessionControl: true, reconnectInitialDelayMs: 10, clientKind });
      let status = '';
      client.subscribeStatus(value => { status = value; });
      clients.push(client); client.start();
      await vi.waitFor(() => expect(status).toBe('ready'));
      await vi.waitFor(() => expect(['control', 'read_only']).toContain(replica.getState().sessionControl?.access));
      return { client, replica, transport, get socket() { return sockets.find(candidate => candidate.readyState === WebSocket.OPEN) ?? socket; } };
    }
    const a = await connect(true);
    const samePageReplica = new AgentReplica();
    const samePage = new RemoteSessionClient('agent', a.transport, samePageReplica, { requireSessionControl: true });
    clients.push(samePage); samePage.start();
    await vi.waitFor(() => expect(samePageReplica.getState().sessionControl?.access).toBe('control'));
    expect(a.replica.getState().sessionControl?.access).toBe('control');
    samePage.stop();
    const b = await connect();
    expect(a.replica.getState().sessionControl?.access).toBe('control');
    expect(b.replica.getState().sessionControl?.access).toBe('read_only');
    expect(b.replica.getState().sessionControl?.ownerKind).toBe('web');
    await expect(b.client.sendMessage('rejected viewer')).rejects.toMatchObject({ code: 'session_read_only' });
    await a.client.sendMessage('accepted owner');
    await b.client.takeControl();
    await vi.waitFor(() => expect(a.replica.getState().sessionControl?.access).toBe('read_only'));
    await b.client.sendMessage('accepted successor');
    const rawErrors: unknown[] = [];
    a.socket.on('message', data => { const value = JSON.parse(data.toString()); if (value.type === 'protocol_error') rawErrors.push(value.payload); });
    a.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'cancel', payload: { agentId: 'agent', requestId: 'bypass', operationId: crypto.randomUUID() } } satisfies ClientMessage));
    await vi.waitFor(() => expect(rawErrors).toContainEqual(expect.objectContaining({ code: 'session_read_only', requestId: 'bypass' })));
    a.socket.terminate();
    await vi.waitFor(() => expect(a.socket.readyState).toBe(WebSocket.OPEN));
    await vi.waitFor(() => expect(a.replica.getState().sessionControl?.access).toBe('read_only'));
    await expect(a.client.cancel()).rejects.toMatchObject({ code: 'session_read_only' });
    const cli = await connect(false, 'headless');
    await cli.client.takeControl();
    await vi.waitFor(() => expect(a.replica.getState().sessionControl?.ownerKind).toBe('headless'));
    expect(b.replica.getState().sessionControl?.ownerKind).toBe('headless');
    await b.client.takeControl();
    cli.client.stop();
    const outcomes = await Promise.allSettled([a.client.takeControl(), b.client.takeControl()]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect([a, b].filter(page => page.replica.getState().sessionControl?.access === 'control')).toHaveLength(1);
    expect(sendMessage.mock.calls).toEqual([['accepted owner'], ['accepted successor']]);
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledOnce();
    expect(tokens.size).toBeGreaterThan(1);
    for (const token of tokens) expect(JSON.stringify(observed)).not.toContain(token);
  } finally { clients.forEach(client => client.stop()); await server.close(); }
}, 15_000);
