import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, expect, it } from 'vitest';
import type { AgentManagerEvent } from '../agent-manager-events.js';
import type { AgentRemoteRelay } from '../relay.js';
import type { SessionWireAgent } from '../session-wire.js';
import { attachAgentRemoteWebSocketStream } from './websocket-stream.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function inbox(socket: WebSocket) {
  const queued: any[] = [];
  const waiters: Array<{ match: (value: any) => boolean; resolve(value: any): void }> = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(item => item.match(value));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(value); else queued.push(value);
  });
  return (match: (value: any) => boolean) => {
    const index = queued.findIndex(match);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Channel message deadline')), 1500);
      waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  };
}
async function fixture() {
  const listeners = new Map<string, Set<(event: AgentManagerEvent) => void>>();
  const snapshot = (id: string, status: 'running' | 'idle' = 'idle') => ({
    protocolVersion: '1.5.0' as const, type: 'agent_snapshot' as const,
    payload: { id, providerId: 'fake', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status,
      activeTurn: null, pendingInteractions: [], runtimeInfo: { providerId: 'fake', sessionId: id, status },
      capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        interactions: { question: false, planApproval: false, toolApproval: false } } },
  });
  const relay = { requireAgent(id: string): SessionWireAgent {
    let set = listeners.get(id); if (!set) { set = new Set(); listeners.set(id, set); }
    return { agentId: id, snapshot: () => snapshot(id), timelineCursor: () => ({ epoch: id + '-epoch', seq: 3 }), subscribe: listener => { set!.add(listener); return () => { set!.delete(listener); }; },
      fetchTimeline: () => { throw new Error('Unexpected history request'); }, sendMessage: async () => {}, respondToInteraction: async () => {} };
  } } as AgentRemoteRelay;
  const authorized: string[] = [];
  const server = createServer();
  const stream = attachAgentRemoteWebSocketStream(server, relay, { authorizer: {
    authenticate: () => ({ subject: 'alice' }), authorize: ({ agentId }) => { authorized.push(agentId); return agentId !== 'private'; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  cleanup.push(async () => { await stream.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const connect = async (mode = 'session') => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/session-channel?observation=${mode}`);
    const next = inbox(socket);
    await once(socket, 'open'); await next(value => value.type === 'ready');
    return { socket, next, send: (value: object) => socket.send(JSON.stringify({ protocolVersion: '1.5.0', ...value })) };
  };
  return { connect, authorized, listeners, update(id: string) {
    for (const listener of listeners.get(id) ?? []) listener({ type: 'agent_state', agentId: id, snapshot: snapshot(id, 'running'), cursor: { epoch: id + '-epoch', seq: 8 } });
  } };
}

it('keeps simultaneous full sessions isolated while reusing one real socket across subscription changes', async () => {
  const f = await fixture(); const c = await f.connect();
  const subscribe = (subscriptionId: number, agentId: string) => c.send({ type: 'subscribe', subscriptionId, agentId, message: { protocolVersion: '1.5.0', type: 'negotiate' } });
  subscribe(1, 'a'); subscribe(2, 'b');
  expect((await c.next(v => v.subscriptionId === 1 && v.message?.type === 'agent_snapshot')).message.payload.id).toBe('a');
  expect((await c.next(v => v.subscriptionId === 2 && v.message?.type === 'agent_snapshot')).message.payload.id).toBe('b');
  subscribe(3, 'private');
  expect((await c.next(v => v.subscriptionId === 3 && v.type === 'closed')).code).toBe(1008);
  c.send({ type: 'unsubscribe', subscriptionId: 1 });
  c.send({ type: 'ping' }); await c.next(v => v.type === 'pong');
  expect(f.listeners.get('a')?.size).toBe(0); expect(f.listeners.get('b')?.size).toBe(1);
  f.update('b');
  expect((await c.next(v => v.subscriptionId === 2 && v.message?.type === 'agent_update')).message.payload.status).toBe('running');
  subscribe(4, 'a');
  await c.next(v => v.subscriptionId === 4 && v.message?.type === 'agent_snapshot');
  expect(c.socket.readyState).toBe(WebSocket.OPEN);
  expect(f.authorized).toEqual(['a', 'b', 'private', 'a']);
  c.socket.close(); await once(c.socket, 'close');
  await expect.poll(() => [...f.listeners.values()].every(set => !set.size), { timeout: 1500 }).toBe(true);
});

it('keeps activity subscriptions separate from content and rejects content on the activity channel', async () => {
  const f = await fixture(); const c = await f.connect('activity');
  c.send({ type: 'subscribe', subscriptionId: 1, agentId: 'a', message: { protocolVersion: '1.5.0', type: 'negotiate', observation: 'activity' } });
  expect((await c.next(v => v.message?.type === 'agent_activity')).message.payload).toEqual({ agentId: 'a', status: 'idle', cursor: { epoch: 'a-epoch', seq: 3 } });
  c.send({ type: 'message', subscriptionId: 1, message: { protocolVersion: '1.5.0', type: 'timeline_subscription', payload: { requestId: 'forbidden', agentIds: ['a'] } } });
  await c.next(v => v.type === 'closed' && v.subscriptionId === 1);
  expect(c.socket.readyState).toBe(WebSocket.OPEN);
  c.socket.close();
});


it('delivers the activity content boundary over a real channel on status changes', async () => {
  const f = await fixture(); const c = await f.connect('activity');
  c.send({ type: 'subscribe', subscriptionId: 1, agentId: 'a', message: {
    protocolVersion: '1.5.0', type: 'negotiate', observation: 'activity',
  } });
  expect((await c.next(v => v.message?.type === 'agent_activity')).message.payload.cursor).toEqual({ epoch: 'a-epoch', seq: 3 });
  f.update('a');
  expect((await c.next(v => v.message?.type === 'agent_activity')).message.payload.cursor).toEqual({ epoch: 'a-epoch', seq: 8 });
  c.socket.close(); await once(c.socket, 'close');
});
