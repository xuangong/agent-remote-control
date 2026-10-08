import { act, useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, RemoteActivityClient, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render } from '../test/setup.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSessionTracking, type SessionTracking } from './useSessionTracking.js';
import { readTrackedSessions, saveTrackedSessions } from '../tracking-state.js';
import { useSessionStars } from './useSessionStars.js';
import { SessionStarsClient } from '../session-stars-client.js';
import { sessionKey } from '../session-tree.js';
import { ConversationConnections } from '../conversation-connections.js';
const star = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('retains opened tracked clients through access renewal and collects them only after untracking', async () => {
  saveTrackedSessions('alice', [star]);
  const close = vi.fn();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('No snapshot expected before negotiation'); },
    fetchTimeline: async () => { throw new Error('No history expected before negotiation'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (_id, listener) => {
      queueMicrotask(() => listener.onOpen());
      return { close, send: () => {} };
    },
  };
  const connections = new ConversationConnections(transport);
  let tracking!: SessionTracking, accessReady!: (value: boolean) => void;
  function Fixture() {
    const [ready, setReady] = useState(true); accessReady = setReady;
    tracking = useSessionTracking('alice', transport, undefined, undefined, undefined, connections, ready);
    return null;
  }
  try {
    await render(<Fixture />);
    const opened = connections.acquire('agent', new AgentReplica(), star);
    opened.release();
    await act(async () => accessReady(false));
    expect(connections.find(star)?.client).toBe(opened.client);
    expect(close).not.toHaveBeenCalled();
    await act(async () => accessReady(true));
    const reopened = connections.acquire('agent', new AgentReplica(), star);
    expect(reopened.client).toBe(opened.client);
    reopened.release();
    await act(async () => tracking.toggle(star));
    expect(connections.find(star)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  } finally { connections.clear(); }
});

it('retries only an unbound observer after access renewal and ignores the suspended attachment result', async () => {
  saveTrackedSessions('http://localhost/u/alice/', [star]);
  const attachments: Array<{ signal?: AbortSignal; finish(value: { agentId: string }): void }> = [];
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation((_provider, _native, signal) =>
    new Promise(finish => { attachments.push({ signal, finish }); }));
  const connect = vi.fn<RemoteAgentTransport['connect']>((_id, listener) => {
    queueMicrotask(() => listener.onOpen());
    return { send: () => {}, close: () => {} };
  });
  const transport = { connect, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} } as unknown as RemoteAgentTransport;
  let accessReady!: (ready: boolean) => void;
  function Fixture() {
    const [ready, setReady] = useState(true); accessReady = setReady;
    const tracking = useSessionTracking('http://localhost/u/alice/', transport, undefined, undefined, undefined, undefined, ready);
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  expect(attachments).toHaveLength(1);
  await act(async () => accessReady(false));
  expect(attachments[0]!.signal?.aborted).toBe(true);
  await act(async () => attachments[0]!.finish({ agentId: 'stale-binding' }));
  expect(connect).not.toHaveBeenCalled();
  await act(async () => accessReady(true));
  expect(attachments).toHaveLength(2);
  await act(async () => attachments[1]!.finish({ agentId: 'live-binding' }));
  expect(connect).toHaveBeenCalledExactlyOnceWith('live-binding', expect.any(Object));
  await act(async () => accessReady(false));
  await act(async () => accessReady(true));
  expect(attach).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledOnce();
});
it('migrates only exact native identities, resolves out-of-order branches and persists the local selection', async () => {
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking;
  function Fixture() { tracking = useSessionTracking('alice', transport); return null; }
  await render(<Fixture />);
  const sameTitle = { ...star, nativeSessionId: 'unrelated' };
  await act(async () => { tracking.toggle(star); tracking.toggle(sameTitle); });
  const from = { ...star, agentId: 'one' }, to = { ...from, nativeSessionId: 'new', agentId: 'two' };
  const final = { ...from, nativeSessionId: 'latest', agentId: 'three' };
  await act(async () => {
    tracking.replace({ id: 'second', from: to, to: final, createdAt: 2 });
    tracking.replace({ id: 'first', from, to, createdAt: 1 });
    tracking.replace({ id: 'first', from, to, createdAt: 1 });
  });
  expect(tracking.sessions.map(item => item.nativeSessionId)).toEqual(['latest', 'unrelated']);
  expect(readTrackedSessions('alice').map(item => item.nativeSessionId)).toEqual(['latest', 'unrelated']);
});
it('keeps current sessions observed while excluding them from the tracking list', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockResolvedValue({ agentId: 'agent' });
  const connections = new Set<string>();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('Activity must not fetch snapshots'); },
    fetchTimeline: async () => { throw new Error('Activity must not fetch content'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (id, listener) => {
    connections.add(id); queueMicrotask(() => listener.onOpen());
    return { send: () => {}, close: () => { connections.delete(id); } };
  } };
  let tracking!: SessionTracking;
  let select!: (key: string | undefined) => void;
  function Fixture() {
    const [key, setKey] = useState<string | undefined>(sessionKey(star)); select = setKey;
    tracking = useSessionTracking('alice', transport, key);
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  await act(async () => tracking.toggle(star));
  expect(tracking.sessions).toEqual([star]);
  expect(connections.size).toBe(1);
  expect(tracking.backgroundSessions).toEqual([]);
  await act(async () => select(undefined));
  expect(connections.size).toBe(1);
  expect(tracking.backgroundSessions).toEqual([star]);
  await act(async () => select(sessionKey(star)));
  expect(connections.size).toBe(1);
  expect(tracking.observations[sessionKey(star)]?.connection).toBe('connecting');
  expect(readTrackedSessions('alice')).toEqual([star]);
});
it('restores local selections, stops observations on untrack and logout, and never stops the native session', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockResolvedValue({ agentId: 'agent' });
  const start = vi.spyOn(RemoteActivityClient.prototype, 'start').mockImplementation(() => {});
  const stop = vi.spyOn(RemoteActivityClient.prototype, 'stop').mockImplementation(() => {});
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking;
  let remount!: () => void;
  let logout!: () => void;
  function Inner() { tracking = useSessionTracking('http://localhost/u/alice/', transport); return <>{tracking.observers}</>; }
  function Fixture() { const [key, setKey] = useState(0); const [signedIn, setSignedIn] = useState(true); remount = () => setKey(value => value + 1); logout = () => setSignedIn(false); return signedIn ? <Inner key={key} /> : null; }
  await render(<Fixture />);
  await act(async () => tracking.toggle(star));
  expect(start).toHaveBeenCalledOnce();
  expect(readTrackedSessions('http://localhost/u/alice/')).toEqual([star]);
  expect(readTrackedSessions('http://localhost/u/bob/')).toEqual([]);
  await act(async () => remount());
  expect(start).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledOnce();
  expect(tracking.sessions).toEqual([star]);
  await act(async () => tracking.toggle(star));
  expect(stop).toHaveBeenCalledTimes(2);
  expect(readTrackedSessions('http://localhost/u/alice/')).toEqual([]);
  await act(async () => tracking.toggle(star));
  await act(async () => logout());
  expect(stop).toHaveBeenCalledTimes(3);
  expect(readTrackedSessions('http://localhost/u/alice/')).toEqual([star]);
});
it('aborts pending attachment when untracked and ignores the late result', async () => {
  let resolve!: (value: { agentId: string }) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation((_provider, _native, input) => { signal = input; return new Promise(done => { resolve = done; }); });
  const start = vi.spyOn(RemoteActivityClient.prototype, 'start').mockImplementation(() => {});
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking;
  function Fixture() { tracking = useSessionTracking('alice', transport); return <>{tracking.observers}</>; }
  await render(<Fixture />);
  await act(async () => tracking.toggle(star));
  await act(async () => tracking.toggle(star));
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve({ agentId: 'late' }));
  expect(start).not.toHaveBeenCalled();
  expect(tracking.observations).toEqual({});
});

it('acknowledges only the selected session and clears reminders when that session becomes current', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_provider, native) => ({ agentId: native }));
  const listeners = new Map<string, Parameters<RemoteAgentTransport['connect']>[1]>();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('Activity must not fetch content'); },
    fetchTimeline: async () => { throw new Error('Activity must not fetch content'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(id, listener) {
      listeners.set(id, listener); queueMicrotask(() => listener.onOpen());
      return { close: () => { listeners.delete(id); }, send: message => {
        if (message.type !== 'negotiate') return;
        listener.onMessage({ protocolVersion: '1.6.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
      } };
    },
  };
  let tracking!: SessionTracking;
  let select!: (key: string) => void;
  function Fixture() {
    const [key, setKey] = useState<string>(); select = setKey;
    tracking = useSessionTracking('alice', transport, key);
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  const second = { ...star, nativeSessionId: 'second' };
  await act(async () => { tracking.toggle(star); tracking.toggle(second); });
  const emit = (id: string, status: 'waiting' | 'idle') => act(async () => {
    listeners.get(id)!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: id, status } });
  });
  await emit('native', 'waiting'); await emit('second', 'idle');
  expect(tracking.observations[sessionKey(star)]?.attention).toBe('pending');
  expect(tracking.observations[sessionKey(second)]?.attention).toBe('idle');
  await act(async () => tracking.acknowledge(sessionKey(star)));
  expect(tracking.observations[sessionKey(star)]).toMatchObject({ changed: false, attention: undefined });
  expect(tracking.observations[sessionKey(second)]).toMatchObject({ changed: false, attention: 'idle' });
  await emit('native', 'waiting');
  expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
  await act(async () => select(sessionKey(second)));
  expect(tracking.observations[sessionKey(second)]).toMatchObject({ activity: 'idle', changed: false, attention: undefined });
  expect(tracking.backgroundSessions).toEqual([star]);
});


it('observes open windows without attachment or history and preserves subscriptions across focus and tracking changes', async () => {
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockRejectedValue(new Error('Open windows already have live bindings'));
  const listeners = new Map<string, Parameters<RemoteAgentTransport['connect']>[1]>();
  const connect = vi.fn<RemoteAgentTransport['connect']>((id, listener) => {
    listeners.set(id, listener); queueMicrotask(() => listener.onOpen());
    return { close: () => { listeners.delete(id); }, send: message => {
      if (message.type !== 'negotiate') return;
      expect(message.observation).toBe('activity');
      listener.onMessage({ protocolVersion: '1.6.0', type: 'negotiated' });
      listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
    } };
  });
  const fetchSnapshot = vi.fn(), fetchTimeline = vi.fn();
  const transport = { connect, fetchSnapshot, fetchTimeline, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} } as RemoteAgentTransport;
  const primary = { ...star, agentId: 'primary' };
  const side = { ...star, nativeSessionId: 'side', agentId: 'side' };
  let tracking!: SessionTracking;
  let focus!: (key: string) => void;
  let closeSide!: () => void;
  function Fixture() {
    const [key, setKey] = useState(sessionKey(primary)); focus = setKey;
    const [open, setOpen] = useState([primary, side]); closeSide = () => setOpen([primary]);
    tracking = useSessionTracking('alice', transport, key, open);
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(tracking.observations[sessionKey(primary)]).toMatchObject({ activity: 'running', changed: false });
  expect(attach).not.toHaveBeenCalled();
  await act(async () => tracking.toggle(side));
  await act(async () => focus(sessionKey(side)));
  expect(tracking.backgroundSessions).toEqual([]);
  await act(async () => listeners.get('side')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: 'side', status: 'waiting' } }));
  expect(tracking.observations[sessionKey(side)]).toMatchObject({ activity: 'waiting', changed: false, attention: undefined });
  await act(async () => tracking.toggle(side));
  expect(listeners.size).toBe(2);
  await act(async () => tracking.toggle(side));
  await act(async () => { focus(sessionKey(primary)); closeSide(); });
  expect(tracking.backgroundSessions).toEqual([side]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(attach).not.toHaveBeenCalled();
  await act(async () => tracking.toggle(side));
  expect(listeners.size).toBe(1);
  expect(fetchSnapshot).not.toHaveBeenCalled();
  expect(fetchTimeline).not.toHaveBeenCalled();
});

it('observes a minimized auxiliary Ask independently and replaces only its subscription on Clean', async () => {
  const listeners = new Map<string, Parameters<RemoteAgentTransport['connect']>[1]>();
  const fetchSnapshot = vi.fn(), fetchTimeline = vi.fn();
  const transport: RemoteAgentTransport = {
    fetchSnapshot, fetchTimeline, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(id, listener) {
      listeners.set(id, listener); queueMicrotask(() => listener.onOpen());
      return { close: () => { listeners.delete(id); }, send: message => {
        if (message.type !== 'negotiate') return;
        expect(message.observation).toBe('activity');
        listener.onMessage({ protocolVersion: '1.6.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
      } };
    },
  };
  const primary = { ...star, agentId: 'primary' };
  const ask = { ...star, nativeSessionId: 'ask', agentId: 'ask' };
  let tracking!: SessionTracking, select!: (id: string) => void, show!: (visible: boolean) => void;
  function Fixture() {
    const [id, setId] = useState('ask'); select = setId;
    const [visible, setVisible] = useState(false); show = setVisible;
    tracking = useSessionTracking('alice', transport, sessionKey(primary), [primary], [
      { session: { ...ask, nativeSessionId: id, agentId: id }, liveAgentId: id, visible },
    ]);
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  expect([...listeners.keys()]).toEqual(['primary', 'ask']);
  expect(tracking.sessions).toEqual([]);
  expect(tracking.backgroundSessions).toEqual([]);
  await act(async () => listeners.get('ask')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: 'ask', status: 'waiting' } }));
  expect(tracking.observations[sessionKey(ask)]).toMatchObject({ attention: 'pending', changed: false });
  await act(async () => show(true));
  expect(tracking.observations[sessionKey(ask)]).toMatchObject({ attention: undefined, changed: false });
  const primaryListener = listeners.get('primary');
  const oldAsk = listeners.get('ask')!;
  await act(async () => select('clean-ask'));
  expect([...listeners.keys()]).toEqual(['primary', 'clean-ask']);
  expect(listeners.get('primary')).toBe(primaryListener);
  await act(async () => oldAsk.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: 'ask', status: 'idle' } }));
  expect(tracking.observations[sessionKey({ ...ask, nativeSessionId: 'clean-ask' })]).toMatchObject({ activity: 'running', attention: undefined });
  expect(readTrackedSessions('alice')).toEqual([]);
  expect(fetchSnapshot).not.toHaveBeenCalled(); expect(fetchTimeline).not.toHaveBeenCalled();
});

it('renames only the matching tracked identity without restarting observation', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockResolvedValue({ agentId: 'agent' });
  const start = vi.spyOn(RemoteActivityClient.prototype, 'start').mockImplementation(() => {});
  const stop = vi.spyOn(RemoteActivityClient.prototype, 'stop').mockImplementation(() => {});
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking;
  function Fixture() { tracking = useSessionTracking('alice', transport); return <>{tracking.observers}</>; }
  await render(<Fixture />);
  const unrelated = { ...star, nativeSessionId: 'other' };
  await act(async () => { tracking.toggle(star); tracking.toggle(unrelated); });
  expect(start).toHaveBeenCalledTimes(2);
  await act(async () => tracking.rename({ ...star, title: 'Renamed' }));
  expect(tracking.sessions).toEqual([{ ...star, title: 'Renamed' }, unrelated]);
  expect(readTrackedSessions('alice')).toEqual(tracking.sessions);
  expect(start).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled();
});

it('prunes only confirmed non-favorites and preserves offline favorites and exact identities', async () => {
  const other = { ...star, nativeSessionId: 'other' };
  saveTrackedSessions('alice', [star, other]);
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking;
  let update!: (value: { scope: string; ready: boolean; stars: typeof star[] }) => void;
  function Fixture() {
    const [favorites, setFavorites] = useState({ scope: 'alice', ready: false, stars: [] as typeof star[] });
    update = setFavorites;
    tracking = useSessionTracking('alice', transport, undefined, undefined, undefined, undefined, true);
    useEffect(() => tracking.reconcileFavorites(favorites), [favorites.scope, favorites.ready, favorites.stars]);
    return null;
  }
  await render(<Fixture />);
  expect(tracking.sessions).toEqual([star, other]);
  await act(async () => update({ scope: 'bob', ready: true, stars: [] }));
  expect(tracking.sessions).toEqual([star, other]);
  await act(async () => update({ scope: 'alice', ready: true, stars: [star] }));
  expect(tracking.sessions).toEqual([star]);
  expect(readTrackedSessions('alice')).toEqual([star]);
  await act(async () => update({ scope: 'alice', ready: false, stars: [] }));
  expect(tracking.sessions).toEqual([star]);
  await act(async () => update({ scope: 'alice', ready: true, stars: [] }));
  expect(tracking.sessions).toEqual([]);
  expect(readTrackedSessions('alice')).toEqual([]);
});

it('waits for a successful favorites read and removes tracking only after a confirmed deletion', async () => {
  saveTrackedSessions('http://localhost/u/alice/', [star]);
  const snapshot = vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockRejectedValue(new Error('Unavailable'));
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking, favorites!: ReturnType<typeof useSessionStars>;
  function Fixture() {
    favorites = useSessionStars('http://localhost/u/alice/', true);
    tracking = useSessionTracking(favorites.scope, transport, undefined, undefined, undefined, undefined, true);
    useEffect(() => tracking.reconcileFavorites(favorites), [favorites.scope, favorites.ready, favorites.stars]);
    return null;
  }
  await render(<Fixture />);
  expect(tracking.sessions).toEqual([star]);
  snapshot.mockResolvedValue({ revision: 1, folders: [], stars: [{ ...star, favoriteId: 's', folderId: null, order: 0, available: false, online: false }] });
  await act(async () => favorites.refresh());
  expect(tracking.sessions).toEqual([star]);
  const command = vi.spyOn(SessionStarsClient.prototype, 'command').mockRejectedValue(new Error('Deletion failed'));
  await act(async () => favorites.change({ type: 'remove-session', session: star }));
  expect(tracking.sessions).toEqual([star]);
  command.mockResolvedValue({ revision: 2, folders: [], stars: [] });
  await act(async () => favorites.change({ type: 'remove-session', session: star }));
  expect(tracking.sessions).toEqual([]);
});

it('keeps migrated tracking while favorites still names the source, then cleans up a removed fork', async () => {
  saveTrackedSessions('alice', [star]);
  const transport = {} as RemoteAgentTransport;
  let tracking!: SessionTracking, refresh!: (stars: typeof star[]) => void;
  function Fixture() {
    const [stars, setStars] = useState([star]); refresh = setStars;
    tracking = useSessionTracking('alice', transport, undefined, undefined, undefined, undefined, true);
    useEffect(() => tracking.reconcileFavorites({ scope: 'alice', ready: true, stars }), [stars]);
    return null;
  }
  await render(<Fixture />);
  const from = { ...star, agentId: 'one' }, to = { ...from, nativeSessionId: 'fork', agentId: 'two' };
  await act(async () => tracking.replace({ id: 'migration', from, to, createdAt: 1 }));
  await act(async () => refresh([star]));
  expect(tracking.sessions[0]?.nativeSessionId).toBe('fork');
  await act(async () => refresh([{ ...star, nativeSessionId: 'fork' }]));
  expect(tracking.sessions[0]?.nativeSessionId).toBe('fork');
  await act(async () => refresh([]));
  expect(tracking.sessions).toEqual([]);
});

it('persists drag ordering by identity without reconnecting observers or dropping hidden sessions', async () => {
  const second = { ...star, nativeSessionId: 'second' }, hidden = { ...star, nativeSessionId: 'hidden' };
  saveTrackedSessions('alice', [star, hidden, second]);
  const attach = vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_provider, id) => ({ agentId: id }));
  const close = vi.fn();
  const connect = vi.fn<RemoteAgentTransport['connect']>((id, listener) => {
    queueMicrotask(() => listener.onOpen());
    return { close: () => close(id), send: () => {} };
  });
  const transport = { connect, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} } as unknown as RemoteAgentTransport;
  let tracking!: SessionTracking;
  function Fixture() {
    tracking = useSessionTracking('alice', transport, sessionKey(hidden));
    return <>{tracking.observers}</>;
  }
  await render(<Fixture />);
  expect(connect).toHaveBeenCalledTimes(3);
  const observations = tracking.observations;
  await act(async () => tracking.reorder(sessionKey(second), sessionKey(star), 'before'));
  expect(tracking.sessions).toEqual([second, star, hidden]);
  expect(tracking.backgroundSessions).toEqual([second, star]);
  expect(readTrackedSessions('alice')).toEqual([second, star, hidden]);
  expect(tracking.observations).toBe(observations);
  expect(connect).toHaveBeenCalledTimes(3);
  expect(attach).toHaveBeenCalledTimes(3);
  expect(close).not.toHaveBeenCalled();
  await act(async () => tracking.reorder(sessionKey(second), sessionKey(star), 'after'));
  expect(tracking.sessions).toEqual([star, second, hidden]);
  await act(async () => tracking.reorder(sessionKey(second), 'missing', 'before'));
  expect(tracking.sessions).toEqual([star, second, hidden]);
});

it('preserves a tracked branch when its source is forked again and favorites refresh is delayed', async () => {
  let tracking!: SessionTracking;
  const transport = {} as RemoteAgentTransport;
  function Fixture() { tracking = useSessionTracking('alice', transport); return null; }
  await render(<Fixture />);
  await act(async () => tracking.toggle(star));
  const from = { ...star, agentId: 'source' };
  const to = { ...from, nativeSessionId: 'first', agentId: 'first-agent' };
  await act(async () => tracking.replace({ id: 'first-edit', from, to, createdAt: 1 }));
  await act(async () => tracking.replace({ id: 'second-edit', from, to: { ...to, nativeSessionId: 'second', agentId: 'second-agent' }, createdAt: 2 }));
  expect(tracking.sessions.map(item => item.nativeSessionId)).toEqual(['first']);
  await act(async () => tracking.reconcileFavorites({ scope: 'alice', ready: true, stars: [star] }));
  expect(tracking.sessions.map(item => item.nativeSessionId)).toEqual(['first']);
  await act(async () => tracking.reconcileFavorites({ scope: 'alice', ready: true, stars: [{ ...star, nativeSessionId: 'first' }] }));
  expect(tracking.sessions.map(item => item.nativeSessionId)).toEqual(['first']);
});

it.each(['before', 'after'] as const)('acknowledges updates only after their visible replica has applied the content, acquired %s opening, never while hidden', async timing => {
  const primary = { ...star, agentId: 'native' };
  const child = { ...primary, nativeSessionId: 'child', agentId: 'child' };
  saveTrackedSessions('alice', [star]);
  const activity = new Map<string, Parameters<RemoteAgentTransport['connect']>[1]>();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('No history requested by tracking'); },
    fetchTimeline: async () => { throw new Error('No history requested by tracking'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(id, listener) {
      queueMicrotask(() => listener.onOpen());
      return { close: () => {}, send: message => {
        if (message.type !== 'negotiate' || message.observation !== 'activity') return;
        activity.set(id, listener);
        listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: id, status: 'idle', cursor: { epoch: 'content', seq: 1 } } });
      } };
    },
  };
  const page = (seq: number): import('@orchardworks/agent-remote-protocol').HistoryPage => ({
    protocolVersion: '1.6.0', type: 'timeline_page', payload: {
      requestId: 'history', agentId: 'native', direction: 'tail', epoch: 'content', reset: false, staleCursor: false, gap: false, error: null,
      window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 }, startCursor: { epoch: 'content', seq: 1 }, endCursor: { epoch: 'content', seq },
      hasOlder: false, hasNewer: false, entries: [{ providerId: 'codex', seqStart: 1, seqEnd: seq, sourceSeqRanges: [{ startSeq: 1, endSeq: seq }], collapsed: [], resources: [],
        timestamp: '2026-09-30T00:00:00Z', item: { type: 'assistant_message', text: `Output ${seq}` } }],
    },
  });
  const replica = new AgentReplica(); replica.applyHistory(page(1));
  const connections = new ConversationConnections(transport);
  let acquired = timing === 'before' ? connections.acquire(primary.agentId, replica, primary) : undefined;
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let tracking!: SessionTracking, show!: (sessions: typeof primary[]) => void;
  function Fixture() {
    const [visible, setVisible] = useState<typeof primary[]>([child]); show = setVisible;
    tracking = useSessionTracking('alice', transport, sessionKey(child), [primary, child], undefined, connections, true, visible);
    return <>{tracking.observers}</>;
  }
  const emit = (seq: number) => act(async () => activity.get('native')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity',
    payload: { agentId: 'native', status: 'idle', cursor: { epoch: 'content', seq } } }));
  try {
    await render(<Fixture />);
    await emit(2);
    expect(tracking.backgroundSessions).toEqual([star]);
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(true);
    await act(async () => show([primary]));
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(true);
    if (timing === 'after') await act(async () => { acquired = connections.acquire(primary.agentId, replica, primary); });
    await act(async () => { replica.applyHistory(page(2)); });
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
    await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    await emit(3);
    await act(async () => { replica.applyHistory(page(3)); });
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(true);
    await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
  } finally { acquired?.release(); connections.clear(); }
});

it.each([
  { leave: 'switching sessions', unseen: false },
  { leave: 'switching sessions', unseen: true },
  { leave: 'backgrounding the page', unseen: false },
  { leave: 'backgrounding the page', unseen: true },
].flatMap(scenario => [{ ...scenario, replaced: false }, { ...scenario, replaced: true }]))('remembers content seen before $leave when activity arrives later (new background content: $unseen, replaced epoch: $replaced)', async ({ leave, unseen, replaced }) => {
  const primary = { ...star, agentId: 'native' };
  const other = { ...primary, nativeSessionId: 'other', agentId: 'other' };
  saveTrackedSessions('alice', [star]);
  const activity = new Map<string, Parameters<RemoteAgentTransport['connect']>[1]>();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('Activity tracking must not load snapshots'); },
    fetchTimeline: async () => { throw new Error('Activity tracking must not load history'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(id, listener) {
      queueMicrotask(() => listener.onOpen());
      return { close: () => {}, send: message => {
        if (message.type !== 'negotiate' || message.observation !== 'activity') return;
        activity.set(id, listener);
        listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
          agentId: id, status: 'idle', cursor: { epoch: 'content', seq: 1 },
        } });
      } };
    },
  };
  const page = (seq: number, epoch = 'content'): import('@orchardworks/agent-remote-protocol').HistoryPage => ({
    protocolVersion: '1.6.0', type: 'timeline_page', payload: {
      requestId: `history-${seq}`, agentId: 'native', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false, error: null,
      window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 }, startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq },
      hasOlder: false, hasNewer: false, entries: [{ providerId: 'codex', seqStart: 1, seqEnd: seq,
        sourceSeqRanges: [{ startSeq: 1, endSeq: seq }], collapsed: [], resources: [], timestamp: '2026-10-03T00:00:00Z',
        item: { type: 'assistant_message', text: `Output ${seq}` } }],
    },
  });
  const replica = new AgentReplica(); replica.applyHistory(page(1));
  const connections = new ConversationConnections(transport);
  const acquired = connections.acquire(primary.agentId, replica, primary);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let tracking!: SessionTracking, show!: (sessions: typeof primary[]) => void;
  let renders = 0;
  function Fixture() {
    renders++;
    const [visible, setVisible] = useState<typeof primary[]>([primary]); show = setVisible;
    tracking = useSessionTracking('alice', transport, sessionKey(visible[0]!), [primary, other], undefined, connections, true, visible);
    return <>{tracking.observers}</>;
  }
  try {
    await render(<Fixture />);
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
    // The visible content channel wins the race against the independently coalesced activity channel.
    const epoch = replaced ? 'replacement' : 'content';
    const rendersBeforeContent = renders;
    await act(async () => { replica.applyHistory(page(2, epoch)); });
    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ text: 'Output 2' });
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
    expect(renders).toBe(rendersBeforeContent);
    await act(async () => {
      if (leave === 'switching sessions') show([other]);
      else { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); }
    });
    if (unseen) await act(async () => { replica.applyHistory(page(3, epoch)); });
    if (replaced) {
      await act(async () => activity.get('native')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
        agentId: 'native', status: 'idle', cursor: { epoch: 'content', seq: 1 },
      } }));
      await act(async () => activity.get('native')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
        agentId: 'native', status: 'idle', cursor: { epoch, seq: 1 },
      } }));
    }
    await act(async () => activity.get('native')!.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
      agentId: 'native', status: 'idle', cursor: { epoch, seq: unseen ? 3 : 2 },
    } }));
    expect(tracking.observations[sessionKey(star)]).toMatchObject({ activity: 'idle', changed: unseen });
  } finally { await act(async () => { acquired.release(); connections.clear(); }); }
});

it.each(['scope', 'transport'] as const)('does not reuse read content after the tracking %s changes', async boundary => {
  const primary = { ...star, agentId: 'native' };
  saveTrackedSessions('alice', [star]);
  saveTrackedSessions('bob', [star]);
  const activity = new Map<RemoteAgentTransport, Parameters<RemoteAgentTransport['connect']>[1]>();
  const makeTransport = (): RemoteAgentTransport => {
    const transport: RemoteAgentTransport = {
      fetchSnapshot: async () => { throw new Error('Activity tracking must not load snapshots'); },
      fetchTimeline: async () => { throw new Error('Activity tracking must not load history'); },
      onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
      connect(id, listener) {
        queueMicrotask(() => listener.onOpen());
        return { close: () => {}, send: message => {
          if (message.type !== 'negotiate' || message.observation !== 'activity') return;
          activity.set(transport, listener);
          listener.onMessage({ protocolVersion: '1.6.0', type: 'agent_activity', payload: {
            agentId: id, status: 'idle', cursor: { epoch: 'content', seq: 1 },
          } });
        } };
      },
    };
    return transport;
  };
  const initialTransport = makeTransport(), replacementTransport = makeTransport();
  const replica = new AgentReplica();
  replica.applyHistory({ protocolVersion: '1.6.0', type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'native', direction: 'tail', epoch: 'content', reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: 1, maxSeq: 8, nextSeq: 9 }, startCursor: { epoch: 'content', seq: 1 }, endCursor: { epoch: 'content', seq: 8 },
    hasOlder: false, hasNewer: false, entries: [{ providerId: 'codex', seqStart: 1, seqEnd: 8,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 8 }], collapsed: [], resources: [], timestamp: '2026-10-03T00:00:00Z',
      item: { type: 'assistant_message', text: 'Content seen in the initial scope' } }],
  } });
  const connections = new ConversationConnections(initialTransport);
  const acquired = connections.acquire(primary.agentId, replica, primary);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let tracking!: SessionTracking, hide!: () => void, replace!: () => void;
  function Fixture() {
    const [visible, setVisible] = useState<typeof primary[]>([primary]); hide = () => setVisible([]);
    const [replaced, setReplaced] = useState(false); replace = () => setReplaced(true);
    const scope = replaced && boundary === 'scope' ? 'bob' : 'alice';
    const transport = replaced && boundary === 'transport' ? replacementTransport : initialTransport;
    tracking = useSessionTracking(scope, transport, undefined, [primary], undefined, connections, true, visible);
    return <>{tracking.observers}</>;
  }
  const emit = (transport: RemoteAgentTransport, seq: number) => act(async () => activity.get(transport)!.onMessage({
    protocolVersion: '1.6.0', type: 'agent_activity', payload: { agentId: 'native', status: 'idle', cursor: { epoch: 'content', seq } },
  }));
  try {
    await render(<Fixture />);
    await act(async () => hide());
    await emit(initialTransport, 8);
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
    await act(async () => replace());
    const activeTransport = boundary === 'transport' ? replacementTransport : initialTransport;
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(false);
    await emit(activeTransport, 2);
    expect(tracking.observations[sessionKey(star)]?.changed).toBe(true);
  } finally { await act(async () => { acquired.release(); connections.clear(); }); }
});
