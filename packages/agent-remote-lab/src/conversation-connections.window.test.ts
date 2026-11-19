// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { memoryRecordedRelay } from '@orchardworks/agent-relay-node/testing/memory-relay';
import { AgentReplica, HttpWebSocketTransport, type RemoteSessionState, type WebSocketLike } from '@orchardworks/agent-client';
import { waitFor } from './test/wait.js';
import { ConversationConnections } from './conversation-connections.js';

async function fixture(sessionChannels: boolean) {
  const server = memoryRecordedRelay(), net = server.net;
  const sockets: WebSocket[] = [], outbound: string[] = [];
  const transport = new HttpWebSocketTransport(net.url, { fetch: net.fetch, sessionChannels, webSocketFactory: address => {
    const socket = net.webSocket(address, { origin: process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175' });
    sockets.push(socket);
    return socket as unknown as WebSocketLike;
  } });
  transport.onProtocolMessage(event => { if (event.direction === 'outbound') outbound.push(event.message.type); });
  const created = await transport.createAgent('shared-agent', 'recorded', { sessionId: 'shared-native' });
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: created.payload.sessionId };
  const connections = new ConversationConnections(transport);
  return { server, transport, sockets, outbound, target, connections,
    async close() { connections.clear(); transport.dispose(); await server.close(); },
  };
}

it.each([false, true])('shares a live client, replica and state between two Session Views when one closes (channels=%s)', async sessionChannels => {
  const f = await fixture(sessionChannels);
  try {
    const first = f.connections.acquire('shared-agent', new AgentReplica(), f.target);
    await waitFor(() => expect(first.client.getSessionState().connection).toBe('ready'));
    const requests = [...f.outbound];
    const second = f.connections.acquire('shared-agent', new AgentReplica(), f.target);
    expect(second.client).toBe(first.client);
    expect(second.replica).toBe(first.replica);
    expect(f.outbound).toEqual(requests);
    const states: Array<RemoteSessionState | undefined> = [];
    const firstStop = first.client.subscribeSessionState(value => { states[0] = value; });
    const secondStop = second.client.subscribeSessionState(value => { states[1] = value; });
    expect(states[0]).toEqual(states[1]);
    const initialSequence = first.replica.getState().timeline.nextSeq;
    f.server.recorded.advance(f.target.nativeSessionId);
    await waitFor(() => expect(second.replica.getState().timeline.nextSeq).toBeGreaterThan(initialSequence));
    expect(second.replica.getState()).toBe(first.replica.getState());
    expect(states[0]).toEqual(states[1]);

    firstStop(); first.release();
    await Promise.resolve();
    expect(second.client.getSessionState().connection).toBe('ready');
    expect(f.connections.find(f.target)?.client).toBe(second.client);
    const sequenceBeforeClose = second.replica.getState().timeline.nextSeq;
    f.server.recorded.advance(f.target.nativeSessionId);
    await waitFor(() => expect(second.replica.getState().timeline.nextSeq).toBeGreaterThan(sequenceBeforeClose));
    expect(f.sockets).toHaveLength(1);
    secondStop(); second.release();
    await waitFor(() => expect(f.connections.agentIds).toEqual([]));
  } finally { await f.close(); }
}, 10000);

it.each([false, true])('reuses a retained Session across Windows while observing updates without a mounted view (channels=%s)', async sessionChannels => {
  const f = await fixture(sessionChannels);
  try {
    f.connections.retainSessions('window:first', [f.target]);
    f.connections.retainSessions('window:second', [f.target]);
    expect(f.sockets).toHaveLength(0);
    const first = f.connections.acquire('shared-agent', new AgentReplica(), f.target);
    await waitFor(() => expect(first.client.getSessionState().connection).toBe('ready'));
    first.release();
    await Promise.resolve();
    f.connections.retainSessions('window:first', []);
    expect(first.client.getSessionState().connection).toBe('ready');
    const before = first.replica.getState().timeline.nextSeq;
    f.server.recorded.advance(f.target.nativeSessionId);
    await waitFor(() => expect(first.replica.getState().timeline.nextSeq).toBeGreaterThan(before));
    const requests = [...f.outbound];
    const second = f.connections.acquire('shared-agent', new AgentReplica(), f.target);
    expect(second.client).toBe(first.client);
    expect(second.replica).toBe(first.replica);
    expect(second.client.getSessionState().connection).toBe('ready');
    expect(f.outbound).toEqual(requests);
    expect(f.sockets).toHaveLength(1);
    f.connections.retainSessions('window:second', []);
    expect(second.client.getSessionState().connection).toBe('ready');
    second.release();
    await waitFor(() => expect(f.connections.agentIds).toEqual([]));
  } finally { await f.close(); }
}, 10000);
