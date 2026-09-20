import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeServerMessage,
  type AgentSnapshot,
  type HistoryPage,
} from '@agent-remote-controller/agent-remote-protocol';
import type NodeWebSocket from 'ws';

import { HttpWebSocketTransport, type HttpWebSocketTransportDependencies } from './http-websocket-transport.js';
import { RemoteOperationError } from './transport.js';
import type { RemoteProtocolObservation, RemoteTransportDiagnostic } from './transport.js';

declare const NodeWebSocketConstructor: typeof NodeWebSocket;
const require = createRequire(import.meta.url);
const NodeWebSocketRuntime = require('ws') as typeof NodeWebSocket;

const capabilities = {
  history: true, sendMessage: true, steer: true, cancel: true, readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

const snapshot: AgentSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'agent_snapshot',
  payload: {
    id: 'agent one', providerId: 'provider-neutral',
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:01.000Z',
    status: 'idle', activeTurn: null, capabilities, pendingInteractions: [],
    runtimeInfo: { providerId: 'provider-neutral', sessionId: 'session-one', status: 'idle' },
  },
};

const history: HistoryPage = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'timeline_page',
  payload: {
    requestId: 'history-one', agentId: 'agent one', direction: 'after', epoch: 'epoch-one',
    reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    startCursor: { epoch: 'epoch-one', seq: 2 }, endCursor: { epoch: 'epoch-one', seq: 2 },
    hasOlder: true, hasNewer: false, entries: [], error: null,
  },
};

describe('HttpWebSocketTransport', () => {
  it('preserves the browser receiver required by the ambient fetch implementation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function receiverSensitiveFetch(this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(encoded({
        protocolVersion: PROTOCOL_VERSION,
        type: 'provider_list',
        payload: { providers: [{ providerId: 'recorded', displayName: 'Recorded Provider' }] },
      }), { status: 200 }));
    } as typeof fetch;
    try {
      const transport = new HttpWebSocketTransport('http://relay.test', { WebSocket: FakeWebSocket });
      await expect(transport.listProviders()).resolves.toEqual([
        { providerId: 'recorded', displayName: 'Recorded Provider' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('decodes public Snapshot and Timeline values from the HTTP endpoints', async () => {
    const calls: string[] = [];
    const bodies = [encoded(snapshot), encoded(history)];
    const transport = new HttpWebSocketTransport('http://relay.test/base/', {
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(bodies.shift(), { status: 200 });
      },
      WebSocket: FakeWebSocket,
      requestId: () => 'history-one',
    });

    await expect(transport.fetchSnapshot('agent one')).resolves.toEqual(snapshot);
    await expect(transport.fetchTimeline('agent one', 'after', { epoch: 'epoch-one', seq: 1 }, 50))
      .resolves.toEqual(history);

    expect(calls).toEqual([
      'http://relay.test/base/v1/sessions/agent%20one/snapshot?protocolVersion=1.5.0',
      'http://relay.test/base/v1/sessions/agent%20one/timeline?protocolVersion=1.5.0&requestId=history-one&direction=after&limit=50&epoch=epoch-one&seq=1',
    ]);
  });

  it('observes each validated HTTP response exactly once', async () => {
    const observations: RemoteProtocolObservation[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response(encoded(snapshot), { status: 200 }),
      WebSocket: FakeWebSocket,
    });
    transport.onProtocolMessage((observation) => observations.push(observation));

    await transport.fetchSnapshot('agent one');

    expect(observations).toEqual([{
      direction: 'inbound', channel: 'http', message: snapshot,
    }]);
  });

  it('keeps HTTP decoding correct when a protocol observer throws', async () => {
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response(encoded(snapshot), { status: 200 }),
      WebSocket: FakeWebSocket,
    });
    transport.onProtocolMessage(() => { throw new Error('observer failed'); });

    await expect(transport.fetchSnapshot('agent one')).resolves.toEqual(snapshot);
  });

  it('reports malformed public responses without leaking invalid values', async () => {
    const diagnostics: RemoteTransportDiagnostic[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('{not-json', { status: 200 }),
      WebSocket: FakeWebSocket,
    });
    transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));

    await expect(transport.fetchSnapshot('agent-one')).rejects.toThrow('Relay response was invalid.');
    expect(diagnostics).toEqual([{
      source: 'http', code: 'invalid_wire_body',
      message: 'Relay response was rejected by the public protocol.', recoverable: true,
    }]);
  });

  it('stops waiting for an interrupted HTTP response body', async () => {
    const controller = new AbortController();
    let bodyActive = true;
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => undefined),
      }) as Response,
      WebSocket: FakeWebSocket,
    });

    const pending = transport.fetchSnapshot('agent one', { signal: controller.signal }).finally(() => {
      bodyActive = false;
    });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(bodyActive).toBe(false);
  });

  it('surfaces a validated HTTP protocol error with its stable operation details', async () => {
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response(encoded({
        protocolVersion: PROTOCOL_VERSION,
        type: 'protocol_error',
        payload: {
          requestId: 'snapshot-one', code: 'agent_not_found',
          message: 'Agent was not found.', recoverable: false,
        },
      }), { status: 404 }),
      WebSocket: FakeWebSocket,
    });

    await expect(transport.fetchSnapshot('agent-one')).rejects.toMatchObject({
      name: 'RemoteOperationError', code: 'agent_not_found',
      message: 'Agent was not found.', recoverable: false, requestId: 'snapshot-one',
    });
  });

  it('surfaces the strict protocol-version error emitted by a newer HTTP relay', async () => {
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response(JSON.stringify({
        protocolVersion: '2.0.0',
        type: 'protocol_error',
        payload: {
          code: 'incompatible_protocol_version',
          message: 'Protocol version 1.0.0 is incompatible with 2.0.0.',
          recoverable: false,
        },
      }), { status: 400 }),
      WebSocket: FakeWebSocket,
    });

    await expect(transport.fetchSnapshot('agent-one')).rejects.toMatchObject({
      name: 'RemoteOperationError', code: 'incompatible_protocol_version',
      message: 'Protocol version 1.0.0 is incompatible with 2.0.0.', recoverable: false,
    });
  });

  it('preserves hosted Relay errors while reading fork history', async () => {
    const transport = new HttpWebSocketTransport('https://relay.test', {
      fetch: async () => Response.json({ code: 'host_read_timeout', error: 'The Host did not return the requested data before the Relay deadline. Try reading it again.', requestId: 'history-read' }, { status: 504 }),
      WebSocket: FakeWebSocket,
    });
    await expect(transport.fetchTimeline('source', 'tail', undefined, 20_000)).rejects.toMatchObject({
      name: 'RemoteOperationError', code: 'host_read_timeout', requestId: 'history-read',
      message: 'The Host did not return the requested data before the Relay deadline. Try reading it again.',
    });
  });

  it.each([401, 403, 413, 502])('identifies HTTP %s failures without displaying a proxy HTML page', async status => {
    const transport = new HttpWebSocketTransport('https://relay.test', {
      fetch: async () => new Response('<html>Internal proxy details</html>', { status }),
      WebSocket: FakeWebSocket,
    });
    await expect(transport.fetchTimeline('source', 'tail')).rejects.toMatchObject({
      name: 'RemoteOperationError', code: `http_${status}`, message: expect.stringContaining(`HTTP ${status}`),
    });
    await expect(transport.fetchTimeline('source', 'tail')).rejects.not.toThrow('Internal proxy details');
  });

  it('encodes client values and decodes server values across the WebSocket boundary', () => {
    const sockets: FakeWebSocket[] = [];
    const messages: string[] = [];
    const diagnostics: RemoteTransportDiagnostic[] = [];
    const transport = new HttpWebSocketTransport('https://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) { super(url); sockets.push(this); }
      },
    });
    transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    const connection = transport.connect('agent one', {
      onOpen: () => messages.push('open'),
      onMessage: (message) => messages.push(message.type),
      onDisconnect: () => messages.push('closed'),
    });

    expect(sockets[0]?.url).toBe('wss://relay.test/v1/sessions/agent%20one/events');
    sockets[0]?.open();
    connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
    expect(decodeClientMessage(sockets[0]?.sent[0] ?? '')).toMatchObject({
      status: 'ok', value: { type: 'negotiate' },
    });
    sockets[0]?.message(encoded({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated' }));
    sockets[0]?.message('{bad-json');

    expect(messages).toEqual(['open', 'negotiated']);
    expect(diagnostics.at(-1)).toMatchObject({ source: 'websocket', code: 'invalid_wire_body' });
    connection.close();
    expect(messages).toEqual(['open', 'negotiated']);
  });

  it('delivers the strict protocol-version error emitted by a newer WebSocket relay', () => {
    const sockets: FakeWebSocket[] = [];
    const messages: string[] = [];
    const diagnostics: RemoteTransportDiagnostic[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) { super(url); sockets.push(this); }
      },
    });
    transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: (message) => messages.push(message.type),
      onDisconnect: () => undefined,
    });

    sockets[0]?.message(JSON.stringify({
      protocolVersion: '2.0.0',
      type: 'protocol_error',
      payload: {
        code: 'incompatible_protocol_version',
        message: 'Protocol version 1.0.0 is incompatible with 2.0.0.',
        recoverable: false,
      },
    }));

    expect(messages).toEqual(['protocol_error']);
    expect(diagnostics).toEqual([]);
  });

  it('observes validated WebSocket messages once and keeps decode failures as diagnostics', () => {
    const sockets: FakeWebSocket[] = [];
    const observations: RemoteProtocolObservation[] = [];
    const diagnostics: RemoteTransportDiagnostic[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) { super(url); sockets.push(this); }
      },
    });
    transport.onProtocolMessage((observation) => observations.push(observation));
    transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    const connection = transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: () => undefined,
      onDisconnect: () => undefined,
    });

    connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' });
    sockets[0]?.message(encoded({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated' }));
    sockets[0]?.message('{bad-json');

    expect(observations).toEqual([
      { direction: 'outbound', channel: 'websocket', message: { protocolVersion: PROTOCOL_VERSION, type: 'negotiate' } },
      { direction: 'inbound', channel: 'websocket', message: { protocolVersion: PROTOCOL_VERSION, type: 'negotiated' } },
    ]);
    expect(diagnostics).toEqual([expect.objectContaining({ source: 'websocket', code: 'invalid_wire_body' })]);
  });

  it('redacts question and form answers before protocol observers without changing native delivery', () => {
    const socket = new FakeWebSocket('ws://relay.test');
    const transport = new HttpWebSocketTransport('http://relay.test', { webSocketFactory: () => socket });
    const observations: RemoteProtocolObservation[] = [];
    transport.onProtocolMessage((observation) => observations.push(observation));
    const connection = transport.connect('agent', { onOpen() {}, onMessage() {}, onDisconnect() {} });
    connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_response', payload: { agentId: 'agent', requestId: 'secret', submissionId: 'submit-secret', operationId: '00000000-0000-4000-8000-000000000001', response: { kind: 'question', answers: [{ questionId: 'token', selectedValues: [], customText: 'do-not-log' }] } } });
    expect(socket.sent[0]).toContain('do-not-log');
    expect(JSON.stringify(observations)).not.toContain('do-not-log');
    expect(observations[0]).toHaveProperty('redacted', true);
    connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_response', payload: { agentId: 'agent', requestId: 'form', submissionId: 'submit-form', operationId: '00000000-0000-4000-8000-000000000002', response: { kind: 'form', action: 'submit', values: { token: 'do-not-log' } } } });
    expect(socket.sent[1]).toContain('do-not-log');
    expect(JSON.stringify(observations)).not.toContain('do-not-log');
  });

  it('isolates throwing protocol observers from WebSocket send and receive', () => {
    const sockets: FakeWebSocket[] = [];
    const received: string[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) { super(url); sockets.push(this); }
      },
    });
    transport.onProtocolMessage(() => { throw new Error('observer failed'); });
    const connection = transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: (message) => received.push(message.type),
      onDisconnect: () => undefined,
    });

    expect(() => connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' })).not.toThrow();
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(() => sockets[0]?.message(encoded({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated' }))).not.toThrow();
    expect(received).toEqual(['negotiated']);
  });

  it('does not observe an outbound WebSocket message when the socket write fails', () => {
    const observations: RemoteProtocolObservation[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        override send(): void { throw new Error('socket write failed'); }
      },
    });
    transport.onProtocolMessage((observation) => observations.push(observation));
    const connection = transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: () => undefined,
      onDisconnect: () => undefined,
    });

    expect(() => connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' })).toThrow('socket write failed');
    expect(observations).toEqual([]);
  });

  it('uses an injected WebSocket factory without changing the browser constructor default', () => {
    const sockets: FakeWebSocket[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      webSocketFactory: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: () => undefined,
      onDisconnect: () => undefined,
    });

    expect(sockets.map(({ url }) => url)).toEqual(['ws://relay.test/v1/sessions/agent%20one/events']);
  });

  it('consumes a Node ws error when a connecting connection is closed', async () => {
    const socket = new NodeWebSocketRuntime('ws://127.0.0.1:1');
    const uncaughtErrors: unknown[] = [];
    const onUncaughtException = (error: unknown) => uncaughtErrors.push(error);
    process.once('uncaughtException', onUncaughtException);
    try {
      const transport = new HttpWebSocketTransport('http://relay.test', {
        fetch: async () => new Response('', { status: 200 }),
        webSocketFactory: () => socket,
      });
      const disconnects: string[] = [];
      const connection = transport.connect('agent one', {
        onOpen: () => undefined,
        onMessage: () => undefined,
        onDisconnect: () => disconnects.push('closed'),
      });

      connection.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(uncaughtErrors).toEqual([]);
      expect(disconnects).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaughtException);
    }
  });

  it('reports an active WebSocket error before its close notification', () => {
    const sockets: FakeWebSocket[] = [];
    const diagnostics: RemoteTransportDiagnostic[] = [];
    const events: string[] = [];
    const transport = new HttpWebSocketTransport('http://relay.test', {
      fetch: async () => new Response('', { status: 200 }),
      WebSocket: class extends FakeWebSocket {
        constructor(url: string) { super(url); sockets.push(this); }
      },
    });
    transport.onDiagnostic((diagnostic) => {
      diagnostics.push(diagnostic);
      events.push('error');
    });
    transport.connect('agent one', {
      onOpen: () => undefined,
      onMessage: () => undefined,
      onDisconnect: () => events.push('closed'),
    });

    sockets[0]?.error(new Error('connection failed'));
    sockets[0]?.close();

    expect(diagnostics).toEqual([{
      source: 'websocket', code: 'connection_failed',
      message: 'Relay WebSocket connection failed.', recoverable: true,
    }]);
    expect(events).toEqual(['error', 'closed']);
  });

  it('accepts a Node ws factory that supplies the relay Origin', () => {
    const webSocketFactory: NonNullable<HttpWebSocketTransportDependencies['webSocketFactory']> = (url) => (
      new NodeWebSocketConstructor(url, { origin: 'http://localhost:4910' })
    );

    expect(webSocketFactory).toBeTypeOf('function');
  });
});

function encoded(message: Parameters<typeof encodeServerMessage>[0]): string {
  const result = encodeServerMessage(message);
  if (result.status === 'rejected') throw new Error('Test fixture failed to encode.');
  return result.json;
}

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}
  send(value: string): void { this.sent.push(value); }
  close(): void { this.onclose?.(); }
  open(): void { this.onopen?.(); }
  message(data: unknown): void { this.onmessage?.({ data }); }
  error(event: unknown): void { this.onerror?.(event); }
}


it('retires a silent socket when a background page becomes visible, only once', () => {
  const socket = new FakeWebSocket('ws://relay.test');
  const disconnect = vi.fn();
  const transport = new HttpWebSocketTransport('http://relay.test', { webSocketFactory: () => socket });
  const connection = transport.connect('agent', { onOpen() {}, onMessage() {}, onDisconnect: disconnect });
  try {
    socket.open();
    window.dispatchEvent(new Event('pageshow'));
    expect(disconnect).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(disconnect).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(() => connection.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' })).toThrow();
    expect(socket.sent).toEqual([]);
  } finally { connection.close(); vi.restoreAllMocks(); }
});
