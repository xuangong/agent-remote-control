// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentProviderAdapter, AgentSession } from '@orchardworks/agent-provider-sdk';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { createProtocolValidationServer } from './server.js';

it.each([
  {sessionControl: 'shared', sessionChannels: false}, {sessionControl: 'shared', sessionChannels: true},
  {sessionControl: 'exclusive', sessionChannels: false}, {sessionControl: 'exclusive', sessionChannels: true},
] as const)('shares a $sessionControl native session with sessionChannels=$sessionChannels without transferring ownership', async ({sessionControl, sessionChannels}) => {
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let observations = 0;
  const sendMessage = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const dispose = vi.fn(async () => { finish(); });
  const session: AgentSession = {
    capabilities: { sessionControl, history: true, sendMessage: true, steer: false, cancel: true, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    async *observe() { observations += 1; yield { type: 'history_boundary' }; await completed; },
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
    async function connect(create = false, clientKind: 'web' | 'headless' = 'web', observeOnly = false) {
      let socket!: WebSocket;
      const sockets: WebSocket[] = [];
      const transport = new HttpWebSocketTransport(url, { sessionChannels, webSocketFactory: url => {
        socket = new WebSocket(url, { origin: 'http://localhost' });
        sockets.push(socket);
        socket.on('message', data => { const value = JSON.parse(data.toString()); if (value.type === 'session_control' && value.payload.token) tokens.add(value.payload.token); });
        return socket as unknown as WebSocketLike;
      } });
      transport.onProtocolMessage(event => observed.push(event));
      if (create) await transport.createAgent('agent', 'stdio-fixture', { sessionId: 'native' });
      const replica = new AgentReplica();
      const controlStates: string[] = [];
      replica.subscribe(() => { const access = replica.getState().sessionControl?.access; if (access) controlStates.push(access); });
      const client = new RemoteSessionClient('agent', transport, replica, { operationTimeoutMs: 2000, requireSessionControl: true, reconnectInitialDelayMs: 10, clientKind, observeOnly });
      let status = '';
      client.subscribeStatus(value => { status = value; });
      clients.push(client); client.start();
      await vi.waitFor(() => expect(status).toBe('ready'));
      await vi.waitFor(() => expect(['control', 'read_only']).toContain(replica.getState().sessionControl?.access));
      return { client, replica, transport, controlStates, sockets, get socket() { return sockets.find(candidate => candidate.readyState === WebSocket.OPEN) ?? socket; } };
    }
    const a = await connect(true);
    expect(a.controlStates).not.toContain('read_only');
    a.controlStates.length = 0;
    const connectionCount = a.sockets.length;
    a.socket.terminate();
    await vi.waitFor(() => expect(a.sockets.length).toBeGreaterThan(connectionCount));
    await vi.waitFor(() => expect(a.replica.getState().sessionControl?.access).toBe('control'));
    expect(a.controlStates).toContain('checking');
    expect(a.controlStates).not.toContain('read_only');
    const samePageReplica = new AgentReplica();
    const samePage = new RemoteSessionClient('agent', a.transport, samePageReplica, { requireSessionControl: true });
    clients.push(samePage); samePage.start();
    await vi.waitFor(() => expect(samePageReplica.getState().sessionControl?.access).toBe('control'));
    expect(a.replica.getState().sessionControl?.access).toBe('control');
    samePage.stop();
    const b = await connect();
    expect(a.replica.getState().sessionControl?.access).toBe('control');
    expect(b.replica.getState().sessionControl?.access).toBe('control');
    expect(b.replica.getState().sessionControl?.ownerKind).toBeUndefined();
    const observer = await connect(false, 'headless', true);
    expect(observer.replica.getState().sessionControl?.access).toBe('read_only');
    await expect(observer.client.sendMessage('observer must not write')).rejects.toMatchObject({ code: 'session_read_only' });
    expect(sendMessage).not.toHaveBeenCalled();
    await a.client.sendMessage('first page input');
    await b.client.sendMessage('second page input');
    const cli = await connect(false, 'headless');
    expect(cli.replica.getState().sessionControl?.access).toBe('control');
    await cli.client.sendMessage('remote command input');
    expect(a.replica.getState().sessionControl?.access).toBe('control');
    expect(b.replica.getState().sessionControl?.access).toBe('control');
    a.socket.terminate();
    await vi.waitFor(() => expect(a.socket.readyState).toBe(WebSocket.OPEN));
    await vi.waitFor(() => expect(a.replica.getState().sessionControl?.access).toBe('control'));
    await a.client.sendMessage('first page after reconnect');
    cli.client.stop();
    a.client.stop();
    await b.client.sendMessage('second page after the others close');
    expect(b.replica.getState().sessionControl?.access).toBe('control');
    for (const connection of [a, b, cli]) expect(connection.controlStates).not.toContain('read_only');
    expect(sendMessage.mock.calls).toEqual([
      ['first page input'], ['second page input'], ['remote command input'],
      ['first page after reconnect'], ['second page after the others close'],
    ]);
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledOnce();
    expect(observations).toBe(1);
    if (!sessionChannels) expect(tokens.size).toBeGreaterThan(1);
    for (const token of tokens) expect(JSON.stringify(observed)).not.toContain(token);
  } finally { clients.forEach(client => client.stop()); await server.close(); }
}, 15_000);
