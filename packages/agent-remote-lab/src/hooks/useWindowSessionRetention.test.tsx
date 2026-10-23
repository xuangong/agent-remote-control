import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createWindowView, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, HttpWebSocketTransport, type WebSocketLike } from '@orchardworks/agent-remote-web';
import { ConversationConnections } from '../conversation-connections.js';
import { createRecordedValidationServer } from '../server/recorded.js';
import { render, unmount } from '../test/setup.js';
import { useWindowSessionRetention } from './useWindowSessionRetention.js';

const windowWith = (id: string, targets: WindowSessionBinding[]): WorkspaceWindow => ({ schemaVersion: 3, id, title: id,
  revision: 0, selectedPrimaryViewId: 'primary', selectedViewId: 'primary', views: targets.length
    ? targets.map((target, index) => createWindowView(index ? `view-${index}` : 'primary', target, 'primary'))
    : [createWindowView('primary', undefined, 'primary')],
});

async function fixture() {
  const server = createRecordedValidationServer();
  const { url } = await server.http.listen();
  const sockets: WebSocket[] = [], outbound: string[] = [];
  const transport = new HttpWebSocketTransport(url, { sessionChannels: true, webSocketFactory: address => {
    const socket = new WebSocket(address, { origin: process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175' });
    sockets.push(socket); return socket as unknown as WebSocketLike;
  } });
  transport.onProtocolMessage(event => { if (event.direction === 'outbound') outbound.push(event.message.type); });
  const connections = new ConversationConnections(transport);
  return { server, transport, connections, sockets, outbound,
    async session(id: string): Promise<WindowSessionBinding> {
      const value = await transport.createAgent(`agent-${id}`, 'recorded', { sessionId: id });
      return { hostId: 'host', providerId: 'recorded', nativeSessionId: value.payload.sessionId, title: id };
    },
    acquire(target: WindowSessionBinding, source = connections) { return source.acquire(`agent-${target.nativeSessionId}`, new AgentReplica(), target); },
    async close() { connections.clear(); transport.dispose(); await server.close(); },
  };
}

async function harness(connections: ConversationConnections, window?: WorkspaceWindow, limit?: number) {
  let update!: (value: { connections: ConversationConnections; window?: WorkspaceWindow }) => void;
  let retained!: ReturnType<typeof useWindowSessionRetention>;
  function Harness() {
    const [value, setValue] = useState<{ connections: ConversationConnections; window?: WorkspaceWindow }>({ connections, window }); update = setValue;
    retained = useWindowSessionRetention(value.connections, value.window, limit);
    return null;
  }
  const container = await render(<Harness />);
  let mounted = true;
  return { read: () => retained,
    async update(window?: WorkspaceWindow, source = connections) { await act(async () => update({ connections: source, window })); },
    async close() { if (!mounted) return; mounted = false; await unmount(container); },
  };
}

it('retains a late acquired Session after its pane closes without preconnecting other Window bindings', async () => {
  const f = await fixture(), target = await f.session('opened');
  const view = await harness(f.connections, windowWith('first', [target, { ...target, nativeSessionId: 'unopened' }]));
  try {
    expect(f.sockets).toHaveLength(0);
    const opened = f.acquire(target);
    await vi.waitFor(() => expect(opened.client.getSessionState().connection).toBe('ready'));
    opened.release(); await Promise.resolve();
    expect(f.connections.find(target)?.client).toBe(opened.client);
    await view.update(windowWith('first', []));
    expect(f.connections.find(target)?.client).toBe(opened.client);
    expect(f.connections.agentIds).toEqual(['agent-opened']);
    expect(f.sockets).toHaveLength(1);
  } finally { await view.close(); await f.close(); }
}, 10000);

it('keeps updates live across Window navigation and reuses the existing Session on return', async () => {
  const f = await fixture(), target = await f.session('shared');
  const opened = f.acquire(target);
  await vi.waitFor(() => expect(opened.client.getSessionState().connection).toBe('ready'));
  const view = await harness(f.connections, windowWith('first', [target]));
  try {
    opened.release(); await Promise.resolve();
    await view.update();
    await view.update(windowWith('second', []));
    expect(f.connections.find(target)?.client).toBe(opened.client);
    const sequence = opened.replica.getState().timeline.nextSeq;
    f.server.recorded.advance(target.nativeSessionId);
    await vi.waitFor(() => expect(opened.replica.getState().timeline.nextSeq).toBeGreaterThan(sequence));
    const sent = [...f.outbound];
    await view.update(windowWith('first', [target]));
    const returned = f.acquire(target);
    expect(returned.client).toBe(opened.client);
    expect(returned.replica).toBe(opened.replica);
    expect(returned.client.getSessionState().connection).toBe('ready');
    expect(f.outbound).toEqual(sent);
    expect(f.sockets).toHaveLength(1);
    returned.release();
  } finally { await view.close(); await f.close(); }
}, 10000);

it('forgets only the deleted Window ownership and cannot revive it from a stale snapshot', async () => {
  const f = await fixture(), target = await f.session('shared');
  const opened = f.acquire(target);
  const view = await harness(f.connections, windowWith('first', [target]));
  try {
    await view.update(windowWith('second', [target]));
    opened.release(); await Promise.resolve();
    view.read().forgetWindow('first');
    expect(f.connections.find(target)?.client).toBe(opened.client);
    view.read().forgetWindow('second');
    expect(f.connections.find(target)).toBeUndefined();
    await view.update(windowWith('second', [target]));
    const reopened = f.acquire(target);
    reopened.release(); await Promise.resolve();
    expect(f.connections.find(target)).toBeUndefined();
  } finally { await view.close(); await f.close(); }
}, 10000);

it('keeps only the 24 most recently used Session identities across many Windows', async () => {
  const f = await fixture(), targets: WindowSessionBinding[] = [];
  const view = await harness(f.connections);
  try {
    for (let index = 0; index < 24; index++) {
      const target = await f.session(String(index)); targets.push(target);
      await view.update(windowWith(`window-${index}`, [target]));
      const opened = f.acquire(target); opened.release(); await Promise.resolve();
    }
    expect(f.connections.agentIds).toHaveLength(24);
    await view.update(windowWith('window-0', [targets[0]!]));
    const newest = await f.session('newest');
    await view.update(windowWith('window-newest', [newest]));
    const opened = f.acquire(newest); opened.release(); await Promise.resolve();
    expect(f.connections.agentIds).toHaveLength(24);
    expect(f.connections.find(targets[0]!)).toBeDefined();
    expect(f.connections.find(targets[1]!)).toBeUndefined();
    expect(f.connections.find(newest)).toBeDefined();
  } finally { await view.close(); await f.close(); }
}, 10000);

it('releases its retention at pool replacement and unmount without removing tracking ownership', async () => {
  const f = await fixture(), target = await f.session('recent'), tracked = await f.session('tracked');
  const next = new ConversationConnections(f.transport);
  const first = f.acquire(target), trackedLease = f.acquire(tracked);
  const view = await harness(f.connections, windowWith('first', [target, tracked]));
  try {
    f.connections.retainSessions('tracked', [tracked]);
    first.release(); trackedLease.release(); await Promise.resolve();
    expect(f.connections.find(target)?.client).toBe(first.client);
    await view.update(windowWith('first', [target]), next);
    expect(f.connections.find(target)).toBeUndefined();
    expect(f.connections.find(tracked)?.client).toBe(trackedLease.client);
    const replacement = f.acquire(target, next); replacement.release(); await Promise.resolve();
    expect(next.find(target)?.client).toBe(replacement.client);
    await view.close();
    expect(next.find(target)).toBeUndefined();
    expect(f.connections.find(tracked)?.client).toBe(trackedLease.client);
  } finally { await view.close(); next.clear(); await f.close(); }
}, 10000);

it('releases the least recently shown Window whole instead of splitting it', async () => {
  const f = await fixture(), [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.session(id)));
  const view = await harness(f.connections, undefined, 3);
  const show = async (id: string, targets: WindowSessionBinding[]) => {
    await view.update(windowWith(id, targets));
    for (const target of targets) { const opened = f.acquire(target); opened.release(); }
    await act(async () => {});
  };
  try {
    await show('pair', [a!, b!]);
    await show('single', [c!]);
    expect(f.connections.agentIds.sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
    await show('next', [d!]);
    expect(f.connections.agentIds.sort()).toEqual(['agent-c', 'agent-d']);
  } finally { await view.close(); await f.close(); }
}, 10000);

it('keeps a conversation that left its pane, such as one opened from Track, in its own place', async () => {
  const f = await fixture(), [x, a, b] = await Promise.all(['x', 'a', 'b'].map(id => f.session(id)));
  const view = await harness(f.connections, undefined, 2);
  const open = async (target: WindowSessionBinding) => { f.acquire(target).release(); await act(async () => {}); };
  try {
    await view.update(windowWith('old', [x!])); await open(x!);
    await view.update(windowWith('main', [a!])); await open(a!);
    // Replacing the pane's conversation keeps the replaced one as a unit shown more recently than the old Window.
    await view.update(windowWith('main', [b!])); await open(b!);
    await view.update(windowWith('third', []));
    expect(f.connections.agentIds.sort()).toEqual(['agent-a', 'agent-b']);
  } finally { await view.close(); await f.close(); }
}, 10000);

it('retains conversations shown without a Window workspace by when they were last shown', async () => {
  const f = await fixture(), [s, t] = await Promise.all(['s', 't'].map(id => f.session(id)));
  const view = await harness(f.connections, undefined, 1);
  try {
    const first = f.acquire(s!); first.release(); await act(async () => {});
    expect(f.connections.agentIds).toEqual(['agent-s']);
    const second = f.acquire(t!); second.release(); await act(async () => {});
    expect(f.connections.agentIds).toEqual(['agent-t']);
  } finally { await view.close(); await f.close(); }
}, 10000);
