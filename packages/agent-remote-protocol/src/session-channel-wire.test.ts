import { describe, expect, it, vi } from 'vitest';
import * as protocol from './index.js';
import type { SessionChannelSocket } from './session-channel-wire.js';

const protocolVersion = '1.5.0' as const;
const negotiate = { protocolVersion, type: 'negotiate' as const };
const negotiated = { protocolVersion, type: 'negotiated' as const };
const tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  closed: { code?: number; reason?: string }[] = [];
  messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  closes = new Set<() => void>();
  errors = new Set<() => void>();
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed.push({ code, reason }); this.readyState = 3; for (const listener of [...this.closes]) listener(); }
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  onError(listener: () => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  receive(type: string, rest = {}) { for (const listener of [...this.messages]) void listener(JSON.stringify({ protocolVersion, type, ...rest }), false); }
  subscribe(subscriptionId: number, agentId = 'a', activity = false) { this.receive('subscribe', { subscriptionId, agentId, message: activity ? { ...negotiate, observation: 'activity' } : negotiate }); }
}
function setup(mode: 'session' | 'activity' = 'session') {
  const socket = new Socket();
  const streams = new Map<string, SessionChannelSocket>();
  const received = new Map<string, string[]>();
  const cleanup = protocol.acceptSessionChannel(socket, mode, async (agentId) => ({ accept(stream) {
    streams.set(agentId, stream); received.set(agentId, []);
    stream.onMessage((data) => { received.get(agentId)!.push(JSON.parse(data).type); stream.send(JSON.stringify(negotiated)); });
  } }));
  return { socket, streams, received, cleanup };
}

describe('session channel server adapter', () => {
  it('forwards a maximum-size image preview and keeps the channel open', async () => {
    const { socket, streams, cleanup } = setup();
    try {
      socket.subscribe(1, 'a'); await tick();
      const contentBase64 = Buffer.alloc(10 * 1024 * 1024).toString('base64');
      streams.get('a')!.send(JSON.stringify({ protocolVersion, type: 'resource_response', payload: {
        requestId: 'r', agentId: 'a', resourceId: 'image', state: { status: 'available',
          mediaType: 'image/png', byteLength: 10 * 1024 * 1024, sha256: 'a'.repeat(64), contentBase64 },
      } }));
      expect(socket.sent.at(-1)).toMatchObject({ type: 'message', subscriptionId: 1,
        message: { type: 'resource_response', payload: { state: { contentBase64 } } } });
      expect(socket.closed).toEqual([]);
      socket.receive('ping');
      expect(socket.sent.at(-1)).toMatchObject({ type: 'pong' });
    } finally { cleanup(); }
  });
  it('exports a pure socket adapter', () => { expect(protocol.acceptSessionChannel).toBeTypeOf('function'); });
  it('announces ready immediately and answers ping without opening a session', () => {
    const { socket } = setup();
    expect(socket.sent).toEqual([{ protocolVersion, type: 'ready' }]);
    socket.receive('ping');
    expect(socket.sent.at(-1)).toEqual({ protocolVersion, type: 'pong' });
  });
  it('isolates messages, stream closure and stale delivery after unsubscribe', async () => {
    const { socket, streams, received } = setup();
    socket.subscribe(1, 'a'); socket.subscribe(2, 'b'); await tick();
    expect(received.get('a')).toEqual(['negotiate']);
    expect(received.get('b')).toEqual(['negotiate']);
    socket.receive('unsubscribe', { subscriptionId: 1 });
    streams.get('a')!.send(JSON.stringify(negotiated));
    socket.receive('message', { subscriptionId: 1, message: negotiate });
    streams.get('b')!.send(JSON.stringify(negotiated)); await tick();
    expect(received.get('a')).toEqual(['negotiate']);
    expect(socket.sent.at(-1)?.subscriptionId).toBe(2);
    streams.get('b')!.close(1008, 'Revoked');
    expect(socket.sent.at(-1)).toEqual({ protocolVersion, type: 'closed', subscriptionId: 2, code: 1008, reason: 'Revoked' });
    expect(socket.closed).toEqual([]);
  });
  it('does not let a slow open block siblings and cancels an unsubscribed pending open', async () => {
    const socket = new Socket(); const pending = deferred<{ accept(socket: SessionChannelSocket): void }>();
    const attached: string[] = [];
    protocol.acceptSessionChannel(socket, 'session', async (id) => id === 'a' ? pending.promise : { accept() { attached.push(id); } });
    socket.subscribe(1, 'a'); socket.subscribe(2, 'b'); await tick();
    expect(attached).toEqual(['b']);
    socket.receive('unsubscribe', { subscriptionId: 1 });
    pending.resolve({ accept() { attached.push('a'); } }); await tick();
    expect(attached).toEqual(['b']);
  });
  it('preserves each stream order through asynchronous message handlers', async () => {
    const socket = new Socket(); const gate = deferred<void>(); const seen: string[] = [];
    protocol.acceptSessionChannel(socket, 'session', async () => ({ accept(stream) { stream.onMessage(async (data) => { const message = JSON.parse(data); if (message.type === 'negotiate') await gate.promise; seen.push(message.type); }); } }));
    socket.subscribe(1);
    socket.receive('message', { subscriptionId: 1, message: { protocolVersion, type: 'timeline_subscription', payload: { requestId: 'r', agentIds: ['a'] } } });
    await tick(); expect(seen).toEqual([]); gate.resolve(); await tick();
    expect(seen).toEqual(['negotiate', 'timeline_subscription']);
  });
  it('rejects wrong channel negotiation and activity content commands per stream', async () => {
    const activity = setup('activity'); activity.socket.subscribe(1); activity.socket.subscribe(2, 'b', true); await tick();
    expect(activity.socket.sent.some((message) => message.type === 'closed' && message.subscriptionId === 1)).toBe(true);
    activity.socket.receive('message', { subscriptionId: 2, message: { protocolVersion, type: 'timeline_subscription', payload: { requestId: 'r', agentIds: ['b'] } } }); await tick();
    expect(activity.received.get('b')).toEqual(['negotiate']);
    expect(activity.streams.get('b')!.readyState).toBe(3);
    const session = setup(); session.socket.subscribe(1, 'a', true); await tick(); expect(session.streams.size).toBe(0);
  });
  it('isolates authorization failures and thrown handlers', async () => {
    const socket = new Socket();
    protocol.acceptSessionChannel(socket, 'session', async (id) => {
      if (id === 'denied') return { code: 4403, reason: 'Denied' };
      if (id === 'error') throw new Error('Private details');
      return { accept(stream) { stream.onMessage(() => { throw new Error('Private details'); }); } };
    });
    socket.subscribe(1, 'denied'); socket.subscribe(2, 'error'); socket.subscribe(3, 'handler'); await tick();
    expect(socket.sent.filter((message) => message.type === 'closed').map((message) => message.subscriptionId).sort()).toEqual([1, 2, 3]);
    expect(JSON.stringify(socket.sent)).not.toContain('Private details'); expect(socket.closed).toEqual([]);
  });
  it('prevents subscription ID reuse without replacing the existing stream', async () => {
    const { socket, streams } = setup(); socket.subscribe(2, 'a'); await tick(); socket.subscribe(2, 'b'); socket.subscribe(1, 'c'); await tick();
    expect([...streams.keys()]).toEqual(['a']);
    expect(streams.get('a')!.readyState).toBe(1);
  });
  it('bounds active subscriptions and pending frames', async () => {
    const socket = new Socket();
    protocol.acceptSessionChannel(socket, 'session', () => new Promise(() => {}));
    for (let subscriptionId = 1; subscriptionId <= 129; subscriptionId++) socket.subscribe(subscriptionId);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'closed', subscriptionId: 129 });
    for (let index = 0; index < 65; index++) socket.receive('message', { subscriptionId: 1, message: negotiate });
    expect(socket.sent.some((message) => message.type === 'closed' && message.subscriptionId === 1)).toBe(true);
  });
  it('closes physical malformed and oversized traffic and outbound backpressure', async () => {
    for (const data of ['{', ' '.repeat(8 * 1024 * 1024 + 1)]) {
      const { socket } = setup(); for (const listener of socket.messages) void listener(data, false); expect(socket.closed).toHaveLength(1);
    }
    const { socket, streams } = setup(); socket.subscribe(1); await tick(); socket.bufferedAmount = 16 * 1024 * 1024 + 1;
    streams.get('a')!.send(JSON.stringify(negotiated)); expect(socket.closed).toHaveLength(1);
  });
  it('expires pending opens and bounds cancelled factories that never settle', async () => {
    vi.useFakeTimers();
    try {
      const socket = new Socket(); let opens = 0;
      protocol.acceptSessionChannel(socket, 'session', () => { opens++; return new Promise(() => {}); });
      socket.subscribe(1); await vi.advanceTimersByTimeAsync(35_000);
      expect(socket.sent.at(-1)).toMatchObject({ type: 'closed', subscriptionId: 1 });
      for (let id = 2; id <= 150; id++) { socket.subscribe(id); socket.receive('unsubscribe', { subscriptionId: id }); }
      expect(opens).toBeLessThanOrEqual(128);
      await vi.advanceTimersByTimeAsync(60_000);
      for (let id = 151; id <= 300; id++) { socket.subscribe(id); socket.receive('unsubscribe', { subscriptionId: id }); }
      expect(opens).toBeLessThanOrEqual(128);
    } finally { vi.useRealTimers(); }
  });
  it('unsubscribes immediately while a session handler is waiting', async () => {
    const socket = new Socket(); const gate = deferred<void>(); let stream!: SessionChannelSocket; let closed = 0;
    protocol.acceptSessionChannel(socket, 'session', async () => ({ accept(value) {
      stream = value; stream.onClose(() => { closed++; }); stream.onMessage(() => gate.promise);
    } }));
    socket.subscribe(1); await tick(); socket.receive('unsubscribe', { subscriptionId: 1 });
    expect(closed).toBe(1); expect(stream.readyState).toBe(3);
    gate.resolve(); await tick(); expect(closed).toBe(1);
  });
  it('isolates malformed server responses and prevents activity content output', async () => {
    const session = setup(); session.socket.subscribe(1, 'a'); session.socket.subscribe(2, 'b'); await tick();
    session.streams.get('a')!.send('{');
    expect(session.streams.get('a')!.readyState).toBe(3); expect(session.streams.get('b')!.readyState).toBe(1);
    const activity = setup('activity'); activity.socket.subscribe(1, 'a', true); await tick();
    activity.streams.get('a')!.send(JSON.stringify({ protocolVersion, type: 'provider_list', payload: { providers: [] } }));
    expect(activity.socket.sent.at(-1)).toMatchObject({ type: 'closed', subscriptionId: 1 });
    expect(activity.socket.sent.some((frame) => frame.message?.type === 'provider_list')).toBe(false);
  });
  it('bounds rapid completed open churn and restores the rate budget after one minute', async () => {
    vi.useFakeTimers();
    try {
      const socket = new Socket(); let opens = 0;
      protocol.acceptSessionChannel(socket, 'session', async () => { opens++; return { accept() {} }; });
      for (let id = 1; id <= 121; id++) { socket.subscribe(id); await tick(); socket.receive('unsubscribe', { subscriptionId: id }); }
      expect(opens).toBe(120); expect(socket.sent.at(-1)).toMatchObject({ type: 'closed', subscriptionId: 121 });
      await vi.advanceTimersByTimeAsync(60_000); socket.subscribe(122); await tick(); expect(opens).toBe(121);
    } finally { vi.useRealTimers(); }
  });
  it('does not attach pending opens after physical close or socket error', async () => {
    for (const failure of ['close', 'error']) {
      const socket = new Socket(); const pending = deferred<{ accept(socket: SessionChannelSocket): void }>(); let attached = false;
      protocol.acceptSessionChannel(socket, 'session', () => pending.promise); socket.subscribe(1);
      if (failure === 'close') socket.close(); else for (const listener of socket.errors) listener();
      pending.resolve({ accept() { attached = true; } }); await tick();
      expect(attached).toBe(false); expect(socket.messages.size + socket.closes.size + socket.errors.size).toBe(0);
    }
  });
  it('rejects binary traffic and checks UTF-8 byte size', () => {
    for (const [data, binary] of [['{}', true], ['界'.repeat(3 * 1024 * 1024), false]] as const) {
      const { socket } = setup(); for (const listener of socket.messages) void listener(data, binary);
      expect(socket.closed).toHaveLength(1);
    }
  });
  it('keeps capacity reserved for cancelled asynchronous handlers', async () => {
    vi.useFakeTimers();
    try {
      const socket = new Socket(); const gate = deferred<void>(); let opens = 0;
      protocol.acceptSessionChannel(socket, 'session', async (id) => {
        opens++; return { accept(stream) { if (id === 'blocked') stream.onMessage(() => gate.promise); } };
      });
      socket.subscribe(1, 'blocked'); await tick(); socket.receive('unsubscribe', { subscriptionId: 1 });
      for (let id = 2; id <= 129; id++) {
        if (id === 2 || id === 121) await vi.advanceTimersByTimeAsync(60_000);
        socket.subscribe(id, String(id)); await tick();
      }
      expect(opens).toBe(128);
      gate.resolve(); await tick(); socket.subscribe(130, 'last'); await tick(); expect(opens).toBe(129);
    } finally { vi.useRealTimers(); }
  });
  it('physical cleanup closes all virtual sockets and removes listeners exactly once', async () => {
    const { socket, streams, cleanup } = setup(); socket.subscribe(1, 'a'); socket.subscribe(2, 'b'); await tick();
    let closed = 0; for (const stream of streams.values()) stream.onClose(() => { closed++; });
    cleanup(); cleanup();
    expect(closed).toBe(2); expect(socket.messages.size + socket.closes.size + socket.errors.size).toBe(0);
    expect(socket.closed).toHaveLength(1);
  });
});
