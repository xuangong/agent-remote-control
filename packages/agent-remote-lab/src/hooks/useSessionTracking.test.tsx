import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteActivityClient, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render } from '../test/setup.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSessionTracking, type SessionTracking } from './useSessionTracking.js';
import { readTrackedSessions } from '../tracking-state.js';
import { sessionKey } from '../session-tree.js';
const star = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
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
        listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
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
    listeners.get(id)!.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: id, status } });
  });
  await emit('native', 'waiting'); await emit('second', 'idle');
  expect(tracking.observations[sessionKey(star)]?.attention).toBe('pending');
  expect(tracking.observations[sessionKey(second)]?.attention).toBe('idle');
  await act(async () => tracking.acknowledge(sessionKey(star)));
  expect(tracking.observations[sessionKey(star)]).toMatchObject({ changed: false, attention: undefined });
  expect(tracking.observations[sessionKey(second)]).toMatchObject({ changed: true, attention: 'idle' });
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
      listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
      listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
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
  await act(async () => listeners.get('side')!.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: 'side', status: 'waiting' } }));
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
        listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
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
  await act(async () => listeners.get('ask')!.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: 'ask', status: 'waiting' } }));
  expect(tracking.observations[sessionKey(ask)]).toMatchObject({ attention: 'pending', changed: true });
  await act(async () => show(true));
  expect(tracking.observations[sessionKey(ask)]).toMatchObject({ attention: undefined, changed: false });
  const primaryListener = listeners.get('primary');
  const oldAsk = listeners.get('ask')!;
  await act(async () => select('clean-ask'));
  expect([...listeners.keys()]).toEqual(['primary', 'clean-ask']);
  expect(listeners.get('primary')).toBe(primaryListener);
  await act(async () => oldAsk.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: 'ask', status: 'idle' } }));
  expect(tracking.observations[sessionKey({ ...ask, nativeSessionId: 'clean-ask' })]).toMatchObject({ activity: 'running', attention: undefined });
  expect(readTrackedSessions('alice')).toEqual([]);
  expect(fetchSnapshot).not.toHaveBeenCalled(); expect(fetchTimeline).not.toHaveBeenCalled();
});
