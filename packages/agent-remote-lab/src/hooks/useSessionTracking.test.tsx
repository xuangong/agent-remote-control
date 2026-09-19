import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteActivityClient, type RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';
import { render } from '../test/setup.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSessionTracking, type SessionTracking } from './useSessionTracking.js';
import { readTrackedSessions } from '../tracking-state.js';
import { sessionKey } from '../session-tree.js';
const star = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research', starredAt: 1 };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it('observes only background sessions while preserving the current session tracking choice', async () => {
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
  expect(connections.size).toBe(0);
  expect(tracking.backgroundSessions).toEqual([]);
  await act(async () => select(undefined));
  expect(connections.size).toBe(1);
  expect(tracking.backgroundSessions).toEqual([star]);
  await act(async () => select(sessionKey(star)));
  expect(connections.size).toBe(0);
  expect(tracking.observations).toEqual({});
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
        listener.onMessage({ protocolVersion: '1.4.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.4.0', type: 'agent_activity', payload: { agentId: id, status: 'running' } });
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
    listeners.get(id)!.onMessage({ protocolVersion: '1.4.0', type: 'agent_activity', payload: { agentId: id, status } });
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
  expect(tracking.observations[sessionKey(second)]).toBeUndefined();
  expect(tracking.backgroundSessions).toEqual([star]);
});
