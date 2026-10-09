import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteActivityClient, type RemoteActivityState } from './remote-activity-client.js';
import type { RemoteAgentTransport, RemoteTransportListener } from './transport.js';
afterEach(() => vi.useRealTimers());
it('negotiates activity only, reconnects without replaying content, and releases its socket', async () => {
  vi.useFakeTimers();
  let listener!: RemoteTransportListener;
  const send = vi.fn(), close = vi.fn(), fetchSnapshot = vi.fn(), fetchTimeline = vi.fn();
  const connect = vi.fn((_id, next) => { listener = next; return { send, close }; });
  const transport: RemoteAgentTransport = { connect, fetchSnapshot, fetchTimeline, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {} };
  const values: RemoteActivityState[] = [];
  const client = new RemoteActivityClient('agent', transport, state => values.push(state));
  client.start(); listener.onOpen();
  expect(send.mock.calls).toEqual([[{ protocolVersion: '1.7.0', type: 'negotiate', observation: 'activity' }]]);
  listener.onMessage({ protocolVersion: '1.7.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'running' } });
  expect(values.at(-1)).toEqual({ connection: 'ready', activity: 'running' });
  listener.onDisconnect();
  expect(values.at(-1)).toEqual({ connection: 'disconnected' });
  await vi.advanceTimersByTimeAsync(1000);
  listener.onOpen();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(fetchSnapshot).not.toHaveBeenCalled(); expect(fetchTimeline).not.toHaveBeenCalled();
  client.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
it('shows an unsupported Host without falling back to content or retrying forever', async () => {
  vi.useFakeTimers();
  let listener!: RemoteTransportListener;
  const connect = vi.fn((_id, next) => { listener = next; return { send: vi.fn(), close: vi.fn() }; });
  const values: RemoteActivityState[] = [];
  const client = new RemoteActivityClient('agent', { connect } as unknown as RemoteAgentTransport, state => values.push(state));
  client.start(); listener.onOpen();
  listener.onMessage({ protocolVersion: '1.7.0', type: 'protocol_error', payload: { code: 'invalid_shape', message: 'Unknown field', recoverable: false } });
  expect(values.at(-1)?.error).toContain('Update the Controller');
  await vi.advanceTimersByTimeAsync(60000);
  expect(connect).toHaveBeenCalledOnce();
  client.stop();
});

it('passes the observed content cursor without inferring one when absent', () => {
  let listener!: RemoteTransportListener;
  const transport = { connect: (_id: string, next: RemoteTransportListener) => { listener = next; return { send: vi.fn(), close: vi.fn() }; } } as unknown as RemoteAgentTransport;
  const values: RemoteActivityState[] = [];
  const client = new RemoteActivityClient('agent', transport, value => values.push(value));
  client.start(); listener.onOpen();
  listener.onMessage({ protocolVersion: '1.7.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'waiting', cursor: { epoch: 'e', seq: 8 } } });
  expect(values.at(-1)?.cursor).toEqual({ epoch: 'e', seq: 8 });
  listener.onMessage({ protocolVersion: '1.7.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'idle' } });
  expect(values.at(-1)?.cursor).toBeUndefined();
  client.stop();
});

describe('activity confirmation across page suspension', () => {
  const clients: RemoteActivityClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
    vi.restoreAllMocks();
  });

  function setup() {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const connections: RemoteTransportListener[] = [];
    const values: RemoteActivityState[] = [];
    const transport = { connect: (_id: string, listener: RemoteTransportListener) => {
      connections.push(listener);
      return { send() {}, close() {} };
    } } as unknown as RemoteAgentTransport;
    const client = new RemoteActivityClient('agent', transport, value => values.push(value));
    clients.push(client);
    client.start();
    const hide = () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); };
    const show = () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); };
    const confirm = () => connections.at(-1)!.onMessage({ protocolVersion: '1.7.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'running' } });
    return { client, connections, values, hide, show, confirm };
  }

  it('pauses confirmation while hidden and gives recovery a fresh bounded confirmation window', async () => {
    const h = setup();
    h.connections[0]!.onMessage({ protocolVersion: '1.7.0', type: 'negotiated' });
    await vi.advanceTimersByTimeAsync(19_000);
    h.hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values).toEqual([{ connection: 'connecting' }]);
    expect(h.connections).toHaveLength(1);
    h.show();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.values.at(-1)?.connection).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.values.at(-1)).toMatchObject({ connection: 'disconnected', error: expect.any(String) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.connections).toHaveLength(2);
  });

  it('keeps a background reconnect pending until foreground confirmation', async () => {
    const h = setup();
    h.confirm(); h.hide(); h.connections[0]!.onDisconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.connections).toHaveLength(2);
    expect(h.values.at(-1)?.connection).toBe('connecting');
    h.show(); await Promise.resolve(); h.confirm();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values.at(-1)).toEqual({ connection: 'ready', activity: 'running' });
    expect(h.connections).toHaveLength(2);
  });

  it.each(['before hiding', 'while hidden'])('does not restart confirmation after activity arrives %s', async when => {
    const h = setup();
    if (when === 'before hiding') h.confirm();
    h.hide();
    if (when === 'while hidden') h.confirm();
    await vi.advanceTimersByTimeAsync(60_000);
    h.show(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values).toEqual([{ connection: 'connecting' }, { connection: 'ready', activity: 'running' }]);
    expect(h.connections).toHaveLength(1);
  });

  it('does not extend a foreground confirmation deadline on repeated online events', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.values.at(-1)?.connection).toBe('disconnected');
  });

  it('pauses on pagehide even before visibilityState changes', async () => {
    const h = setup();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values).toEqual([{ connection: 'connecting' }]);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await Promise.resolve(); h.confirm();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values.at(-1)?.connection).toBe('ready');
    expect(h.connections).toHaveLength(1);
  });

  it('renews confirmation after a persisted pageshow without an observed pagehide', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(19_000);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.values).toEqual([{ connection: 'connecting' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.values.at(-1)?.connection).toBe('disconnected');
  });

  it('wakes a pending retry once and ignores callbacks from the previous connection', async () => {
    const h = setup();
    h.connections[0]!.onDisconnect();
    h.hide(); h.show(); window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(h.connections).toHaveLength(2);
    h.confirm(); h.connections[0]!.onDisconnect();
    h.connections[0]!.onMessage({ protocolVersion: '1.7.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'idle' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.connections).toHaveLength(2);
    expect(h.values.at(-1)).toEqual({ connection: 'ready', activity: 'running' });
  });

  it.each(['hide', 'stop'])('does not rearm a queued recovery after %s', async action => {
    const h = setup();
    h.hide(); h.show();
    if (action === 'hide') h.hide(); else h.client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.values).toEqual([{ connection: 'connecting' }]);
    expect(h.connections).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
