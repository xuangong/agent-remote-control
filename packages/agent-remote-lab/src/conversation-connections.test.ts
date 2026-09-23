// @vitest-environment node
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AgentReplica, HttpWebSocketTransport, type RemoteSessionStatus, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { ConversationConnections } from './conversation-connections.js';
import { createRecordedValidationServer } from './server/recorded.js';

async function fixture() {
  const server = createRecordedValidationServer();
  const { url } = await server.http.listen();
  const origin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
  const sockets: WebSocket[] = [];
  const transport = new HttpWebSocketTransport(url, { webSocketFactory: address => {
    const socket = new WebSocket(address, { origin });
    sockets.push(socket);
    return socket as unknown as WebSocketLike;
  } });
  const created = await transport.createAgent('agent', 'recorded', { sessionId: 'native' });
  const session = { hostId: 'host-a', providerId: 'recorded', nativeSessionId: created.payload.sessionId };
  const connections = new ConversationConnections(transport);
  const history = vi.spyOn(transport, 'fetchTimeline');
  return { connections, session, sockets, history, server, transport,
    async close() { connections.clear(); transport.dispose(); await server.close(); },
  };
}

it('keeps a tracked subscription current over real HTTP/WebSocket without reconnecting on revisit', async () => {
  const f = await fixture();
  try {
    f.connections.retainTracked([f.session]);
    expect(f.sockets).toHaveLength(0);
    const first = f.connections.acquire('agent', new AgentReplica(), f.session);
    let status: RemoteSessionStatus = 'idle';
    first.client.subscribeStatus(value => { status = value; });
    await vi.waitFor(() => expect(status).toBe('ready'));
    first.release();
    const count = f.history.mock.calls.length;
    const seq = first.replica.getState().timeline.nextSeq;
    f.server.recorded.advance(f.session.nativeSessionId);
    await vi.waitFor(() => expect(first.replica.getState().timeline.nextSeq).toBeGreaterThan(seq));
    const again = f.connections.acquire('agent', new AgentReplica(), f.session);
    expect(again.client).toBe(first.client);
    expect(again.replica).toBe(first.replica);
    expect(status).toBe('ready');
    expect(f.sockets).toHaveLength(1);
    expect(f.history).toHaveBeenCalledTimes(count);
    f.connections.retainTracked([]);
    expect(status).toBe('ready');
    again.release();
    expect(status).toBe('idle');
    expect(f.connections.agentIds).toEqual([]);
  } finally { await f.close(); }
});

it('reuses the existing recovery after a real socket disconnect and releases untracked background sessions', async () => {
  const f = await fixture();
  try {
    f.connections.retainTracked([f.session]);
    const first = f.connections.acquire('agent', new AgentReplica(), f.session);
    let status: RemoteSessionStatus = 'idle';
    first.client.subscribeStatus(value => { status = value; });
    await vi.waitFor(() => expect(status).toBe('ready'));
    first.release();
    f.sockets[0]!.terminate();
    await vi.waitFor(() => expect(status).toBe('disconnected'));
    const again = f.connections.acquire('agent', new AgentReplica(), f.session);
    expect(again.client).toBe(first.client);
    await vi.waitFor(() => expect(status).toBe('ready'), { timeout: 4000 });
    expect(f.sockets).toHaveLength(2);
    again.release();
    f.connections.retainTracked([]);
    expect(status).toBe('idle');
    expect(f.connections.find(f.session)).toBeUndefined();
  } finally { await f.close(); }
});

it('isolates native identities and disposes retained subscriptions at scope teardown', async () => {
  const f = await fixture();
  try {
    f.connections.retainTracked([f.session]);
    const lease = f.connections.acquire('agent', new AgentReplica(), f.session);
    let status: RemoteSessionStatus = 'idle';
    lease.client.subscribeStatus(value => { status = value; });
    await vi.waitFor(() => expect(status).toBe('ready'));
    expect(f.connections.find({ ...f.session, hostId: 'host-b' })).toBeUndefined();
    expect(f.connections.find({ ...f.session, providerId: 'other' })).toBeUndefined();
    f.connections.clear();
    lease.release();
    expect(status).toBe('idle');
    expect(f.connections.agentIds).toEqual([]);
  } finally { await f.close(); }
});
