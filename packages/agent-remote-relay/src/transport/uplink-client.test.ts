import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import * as remote from '../index.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

async function broker() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  closeables.push(() => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const connections: WebSocket[] = [], messages: any[] = [], authorizations: string[] = [];
  server.on('connection', (socket, request) => {
    connections.push(socket);
    authorizations.push(request.headers.authorization ?? '');
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  });
  const address = server.address() as { port: number };
  const relay = remote.createAgentRemoteRelay({ providers: [] });
  closeables.push(() => relay.close());
  const start = (options = {}) => {
    expect(remote.createAgentRemoteUplinkClient).toBeTypeOf('function');
    const client = remote.createAgentRemoteUplinkClient({ relay, agentId: 'agent-one', apiKey: 'test-key',
      url: `ws://127.0.0.1:${address.port}/ws/agent-remote`, reconnectDelayMs: 5, registrationTimeoutMs: 500,
      ...options });
    closeables.push(() => client.close());
    return client;
  };
  return { start, relay, connections, messages, authorizations, address };
}

describe('outbound Agent Remote uplink client', () => {
  it('registers a v2 Remote Host using its installation identity', async () => {
    const b = await broker();
    expect(remote.createRemoteHostUplinkClient).toBeTypeOf('function');
    const client = remote.createRemoteHostUplinkClient({
      relay: b.relay,
      installationId: 'installation-one',
      name: 'Desk DSH',
      remoteKey: 'remote-test-key',
      url: `ws://127.0.0.1:${b.address.port}/ws/remote-host`,
      resolveSession: () => undefined,
      control: async () => ({ status: 404, body: '{}' }),
    });
    closeables.push(() => client.close());
    await vi.waitFor(() => expect(b.messages).toContainEqual({
      uplinkVersion: 2, type: 'register', installationId: 'installation-one', name: 'Desk DSH', providerId: 'dsh',
    }));
  });

  it('does not reconnect after the broker closes a registered v2 Host for policy violation', async () => {
    const b = await broker();
    const client = remote.createRemoteHostUplinkClient({
      relay: b.relay, installationId: 'installation-one', name: 'Desk DSH', remoteKey: 'remote-test-key',
      url: `ws://127.0.0.1:${b.address.port}/ws/remote-host`, resolveSession: () => undefined,
      control: async () => ({ status: 404, body: '{}' }), reconnectBaseDelayMs: 5,
    });
    closeables.push(() => client.close());
    await vi.waitFor(() => expect(b.connections).toHaveLength(1));
    b.connections[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host-one' }));
    await client.ready;
    b.connections[0]!.close(1008, 'Remote key revoked');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(b.connections).toHaveLength(1);
  });

  it('registers with the Agent key, reconnects without closing core state, and does not replay RPCs', async () => {
    const b = await broker();
    const client = b.start();
    await vi.waitFor(() => expect(b.messages).toEqual([{ uplinkVersion: 1, type: 'register', agentId: 'agent-one' }]));
    expect(b.authorizations).toEqual(['Bearer test-key']);
    b.connections[0]!.send(JSON.stringify({ uplinkVersion: 1, type: 'registered', agentId: 'agent-one' }));
    await client.ready;
    b.connections[0]!.send(JSON.stringify({ uplinkVersion: 1, type: 'rpc_request', requestId: 'providers', method: 'GET',
      path: '/v1/providers?protocolVersion=1.4.0' }));
    await vi.waitFor(() => expect(b.messages).toContainEqual(expect.objectContaining({ type: 'rpc_response', requestId: 'providers', status: 200 })));
    b.connections[0]!.terminate();
    await vi.waitFor(() => expect(b.connections).toHaveLength(2));
    b.connections[1]!.send(JSON.stringify({ uplinkVersion: 1, type: 'registered', agentId: 'agent-one' }));
    await vi.waitFor(() => expect(b.messages.filter((m) => m.type === 'register')).toHaveLength(2));
    expect(b.messages.filter((m) => m.type === 'rpc_response')).toHaveLength(1);
    await client.close();
    expect(await remote.executeAgentRemoteHttpRequest(b.relay, { method: 'GET', path: '/v1/providers?protocolVersion=1.4.0' }))
      .toMatchObject({ status: 200 });
  });

  it('rejects a registration for another Agent and retires unregistered connections on deadline', async () => {
    const b = await broker();
    const client = b.start({ registrationTimeoutMs: 30, reconnectDelayMs: 10 });
    await vi.waitFor(() => expect(b.connections.length).toBeGreaterThan(0));
    b.connections[0]!.send(JSON.stringify({ uplinkVersion: 1, type: 'registered', agentId: 'foreign' }));
    await vi.waitFor(() => expect(b.connections.length).toBeGreaterThanOrEqual(3));
    expect(b.messages.every((m) => m.type === 'register')).toBe(true);
    await client.close();
    await expect(client.ready).rejects.toThrow(/closed/i);
  });
});
