import { EventEmitter } from 'node:events';
import { createRemoteHostUplinkClient, type RemoteHostUplinkClientOptions, type UplinkSocket, type UplinkSocketInit } from './transport/remote-host-uplink-client.js';

/**
 * The Relay's side of the Controller's uplink, played by a script instead of a Relay and without a listener.
 *
 * Contract: the Controller's `uplinkClient` port (`AgentHostOptions.uplinkClient`) is `relayLink`; each connection it opens is an
 * in-memory socket whose other end is one `RelayPlayer`, chosen by the URL's host name. The player answers the registration the
 * way a Relay does (`registered` with its heartbeat, `control: 1`, and the grants the Controller asked for in the connection
 * query), then does only what a test tells it: `rpc` sends a request and waits for its response, `openStream` and `sendStream`
 * speak for a browser, `dropConnection` breaks the socket. Everything the Controller sent is in `received`, in order.
 * It never decides a Relay rule; a test that needs one belongs on the S2 seam with the real Relay.
 */
export interface RelayPlayerOptions {
  /** Answers the registration by itself; false waits for `register()`. */
  autoRegister?: boolean;
  heartbeat?: { intervalMs: number; timeoutMs: number };
  /** What a Relay adds to its `registered` answer for the grants the Controller asked for in the connection query, such as `journal: 1`. */
  grants?(query: URLSearchParams): Record<string, unknown>;
  /**
   * A service of the Relay that answers the Controller's frames of its own kind, such as the journal service: it is built per
   * connection with the way to send a frame, and `receive` returns true for a frame it took.
   */
  service?(send: (fields: Record<string, unknown>) => void): { receive(message: { type: string }): boolean | void; close(): void };
}

/** The Relay's end of one connection. */
export interface PlayerConnection {
  readonly readyState: number;
  terminate(): void;
  close(code?: number, reason?: string): void;
  send(json: string): void;
}

const OPEN = 1;
const CLOSED = 3;
let players = 0;
const registry = new Map<string, { accept(endpoint: URL, init: UplinkSocketInit): UplinkSocket }>();

class MemoryConnection extends EventEmitter implements UplinkSocket, PlayerConnection {
  readyState = 0;
  readonly server = new EventEmitter();
  constructor(readonly endpoint: URL, readonly init: UplinkSocketInit) {
    super();
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = OPEN; this.emit('open'); } });
  }
  /** The Controller writes. */
  send(json: string, callback?: (error?: Error) => void): void {
    if (this.readyState !== OPEN) { callback?.(new Error('Socket is closed')); return; }
    queueMicrotask(() => { if (this.readyState === OPEN) this.server.emit('message', json); });
    callback?.();
  }
  /** The Relay writes. */
  deliver(json: string): void {
    if (this.readyState !== OPEN) return;
    queueMicrotask(() => { if (this.readyState === OPEN) this.emit('message', Buffer.from(json), false); });
  }
  terminate(): void { this.end(1006, ''); }
  close(code = 1000, reason = ''): void { this.end(code, reason); }
  private end(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', code, Buffer.from(reason));
    this.server.emit('close');
  }
  /** The Relay's face of this connection. */
  get relaySide(): PlayerConnection & { on: EventEmitter['on']; off: EventEmitter['off'] } {
    const connection = this;
    return {
      get readyState() { return connection.readyState; },
      terminate: () => connection.terminate(), close: (code, reason) => connection.close(code, reason), send: json => connection.deliver(json),
      on: (event, listener) => connection.server.on(event, listener), off: (event, listener) => connection.server.off(event, listener),
    };
  }
}

export type RelayPlayer = ReturnType<typeof relayPlayer>;

export function relayPlayer(hostId: string, options: RelayPlayerOptions = {}) {
  const autoRegister = options.autoRegister ?? true;
  const heartbeat = options.heartbeat ?? { intervalMs: 30_000, timeoutMs: 10_000 };
  const name = `relay-${++players}.test`;
  const url = `ws://${name}/ws/remote-host`;
  const connections: MemoryConnection[] = [];
  const received: Array<Record<string, unknown>> = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  let current: MemoryConnection | undefined;
  let paused: MemoryConnection | undefined;
  let providers: unknown;
  let registrationCount = 0, heartbeatAcknowledgementCount = 0, sequence = 0, read = 0;
  let resolveConnected!: () => void;
  const connected = new Promise<void>(resolve => { resolveConnected = resolve; });

  const send = (connection: MemoryConnection | undefined, fields: Record<string, unknown>) => connection?.deliver(JSON.stringify({ uplinkVersion: 2, ...fields }));
  const registered = (connection: MemoryConnection | undefined) => send(connection, { type: 'registered', hostId, heartbeat, control: 1, ...(connection && options.grants ? options.grants(connection.endpoint.searchParams) : {}) });

  const player = {
    url,
    /** What the Controller asked for when it connected: the grants in its query string. */
    upgradeParameter: (parameter: string) => current?.endpoint.searchParams.get(parameter) ?? null,
    authorization: () => current?.init.authorization,
    connected,
    /** Every frame the Controller sent, in order, across connections. */
    received,
    advertisedProviders: () => providers,
    registrations: () => registrationCount,
    heartbeatAcknowledgements: () => heartbeatAcknowledgementCount,
    connections: () => connections.length,
    /** Stops sending heartbeats on the current connection, as a silent Relay does; returns the Relay's end of it. */
    pauseHeartbeat(): PlayerConnection {
      if (!current) throw new Error('The Relay has no Host connection.');
      paused = current; return current.relaySide;
    },
    issueCredential: (credential: string) => send(current, { type: 'credential_issued', credential }),
    register: () => registered(current),
    openStream: (streamId: string, sessionId: string) => send(current, { type: 'stream_open', streamId, sessionId }),
    closeStream: (streamId: string) => send(current, { type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }),
    sendStream: (streamId: string, message: object) => send(current, { type: 'stream_message', streamId, message: JSON.stringify(message) }),
    streamOpened: (streamId: string) => received.some(message => message.type === 'stream_opened' && message.streamId === streamId),
    streamMessage(streamId: string, type: string, requestId?: string): Record<string, unknown> | undefined {
      for (const frame of received) {
        if (frame.type !== 'stream_message' || frame.streamId !== streamId || typeof frame.message !== 'string') continue;
        const message = JSON.parse(frame.message) as Record<string, unknown>;
        if (message.type !== type) continue;
        const payload = message.payload;
        if (requestId === undefined || (payload && typeof payload === 'object' && 'requestId' in payload && (payload as { requestId?: unknown }).requestId === requestId)) return message;
      }
      return undefined;
    },
    /** A request of the Relay to the Controller, and the Controller's answer. */
    rpc(method: 'GET' | 'POST', path: string, sessionId?: string, body?: unknown): Promise<{ status: number; body: string }> {
      const requestId = `rpc-${++sequence}`;
      const connection = current;
      return new Promise((resolve, reject) => {
        if (!connection) { reject(new Error('The Relay has no Host connection.')); return; }
        const receive = (json: string) => {
          const response = JSON.parse(json) as { type: string; requestId?: string; status?: number; body?: string };
          if (response.type !== 'rpc_response' || response.requestId !== requestId) return;
          connection.server.off('message', receive); resolve({ status: response.status!, body: response.body! });
        };
        connection.server.on('message', receive);
        send(connection, { type: 'rpc_request', requestId, method, path, ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      });
    },
    /**
     * The Relay as a transcript player uses it: `send` writes one frame exactly as given, `next` is the Controller's next frame not yet
     * read through it. Nothing waits on the wall clock; it yields to the event loop between checks.
     */
    peer: {
      send: (json: string): void => current?.deliver(json),
      async next(): Promise<unknown> {
        for (let turn = 0; turn < 5_000; turn += 1) {
          if (read < received.length) return received[read++];
          await new Promise<void>(resolve => { setImmediate(resolve); });
        }
        throw new Error('The Controller sent nothing.');
      },
    },
    /** The connection breaks without a close frame. */
    dropConnection: () => current?.terminate(),
    /** The Relay sends a frame of its own. */
    sendFrame: (fields: Record<string, unknown>) => send(current, fields),
    /** The connection ends. */
    close(): Promise<void> {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const connection of connections) connection.terminate();
      registry.delete(name);
      return Promise.resolve();
    },
    /** Called for each connection the Controller opens. */
    accept(endpoint: URL, init: UplinkSocketInit): UplinkSocket {
      const connection = new MemoryConnection(endpoint, init);
      connections.push(connection); current = connection;
      resolveConnected();
      let timer: ReturnType<typeof setInterval> | undefined;
      const service = options.service?.(fields => { const { uplinkVersion: _version, ...rest } = fields; send(connection, rest); });
      connection.server.on('close', () => { service?.close(); if (timer) { clearInterval(timer); timers.delete(timer); } });
      connection.server.on('message', (json: string) => {
        const message = JSON.parse(json) as Record<string, unknown> & { type: string };
        received.push(message);
        if (message.type === 'register') { providers = message.providers; registrationCount += 1; }
        if (message.type === 'heartbeat_ack') heartbeatAcknowledgementCount += 1;
        service?.receive(message);
        if (message.type === 'register' && autoRegister) {
          registered(connection);
          let nonce = 0;
          timer = setInterval(() => { if (connection !== paused && connection.readyState === OPEN) send(connection, { type: 'heartbeat', nonce: String(++nonce) }); }, heartbeat.intervalMs);
          timers.add(timer);
        }
      });
      return connection;
    },
  };
  registry.set(name, player);
  return player;
}

/** A connection to a Relay that is not there: it fails as a refused connection does, and the client retries. */
function refused(): UplinkSocket {
  const socket = new EventEmitter() as EventEmitter & UplinkSocket;
  socket.send = (_json, callback) => callback(new Error('Socket is closed'));
  socket.terminate = () => undefined;
  setImmediate(() => { socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })); socket.emit('close', 1006, Buffer.from('')); });
  return socket;
}

/**
 * The Controller's `uplinkClient` port for tests: the real uplink client, on a socket whose other end is the player that owns the
 * connection's URL. A URL that no player owns, such as one whose player closed, is refused as a Relay that cannot be reached is.
 */
export const relayLink = (options: RemoteHostUplinkClientOptions) => createRemoteHostUplinkClient({
  // A reconnect after a drop is a test's step, not a wait: the delay is short unless the Controller's own options say otherwise.
  reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 40,
  ...options,
  connect: (endpoint, init) => {
    const player = registry.get(endpoint.hostname);
    return player ? player.accept(endpoint, init) : refused();
  },
});
