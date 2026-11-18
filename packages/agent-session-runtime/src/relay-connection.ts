import { EventEmitter } from 'node:events';

import type { RemoteHostUplinkClientOptions, UplinkSocket } from './transport/remote-host-uplink-client.js';

/**
 * A Relay as the tests of this package and its dependents reach it without a listener: its upgrade decision and the server end of
 * a socket. The shapes are the Relay's own (`prepareUpgrade`, `RelaySocket`), restated here because this package does not know the
 * Relay's code; a Relay's `createHostBroker` result satisfies `RelayUpgrades`.
 */
export interface MemoryRelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number | undefined;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>): () => void;
  onClose(listener: (details?: { code?: number; wasClean?: boolean }) => void): () => void;
  onError(listener: () => void): () => void;
}
export interface RelayUpgrades { prepareUpgrade(request: Request): Promise<{ accept(socket: MemoryRelaySocket): void } | Response | undefined> }

type Direction = 'toPeer' | 'toRelay';
/** A tap sees each frame as it is sent; returning false drops the frame, as a lost connection does. */
type Tap = (direction: Direction, json: string) => void | boolean;

/** Two connected in-memory sockets: `server` is the Relay's end, `native` the peer's. */
export function memorySocketPair(closers: Array<() => void | Promise<void>> = [], tap?: Tap) {
  class Socket implements MemoryRelaySocket {
    readyState = 1; bufferedAmount = 0; peer!: Socket;
    messages = new Set<(data: string, binary: boolean) => void | Promise<void>>(); closes = new Set<(details?: { code?: number; wasClean?: boolean }) => void>();
    constructor(readonly direction: Direction) {}
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is closed');
      if (tap?.(this.direction, data) === false) return;
      queueMicrotask(() => { if (this.peer.readyState === 1) for (const listener of this.peer.messages) void listener(data, false); });
    }
    close(code?: number, reason?: string) {
      if (this.readyState !== 1) return;
      this.readyState = 3;
      for (const listener of this.closes) listener({ code, wasClean: true });
      this.peer.close(code, reason);
    }
    onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
    onClose(listener: (details?: { code?: number; wasClean?: boolean }) => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
    onError() { return () => undefined; }
  }
  const server = new Socket('toPeer'), native = new Socket('toRelay');
  server.peer = native; native.peer = server;
  closers.push(() => server.close());
  return { server, native };
}

export interface RelayConnectionOptions {
  /** Sees every frame of every connection with the direction a transcript names it by. */
  recorder?: { frame(direction: 'controller->relay' | 'relay->controller', json: string): void };
  /** Sees each frame before it is delivered; false drops it. */
  deliver?(direction: 'relay->controller' | 'controller->relay', json: string): boolean | void;
  /** Changes the upgrade URL before the Relay sees it, as an older Controller or a proxy would. */
  query?(endpoint: URL): void;
}

/**
 * Connects a real Controller to a real Relay without a listener: the uplink client's `connect` port, answered by the Relay's own
 * `prepareUpgrade` and an in-memory socket pair. The Relay decides the upgrade (a refusal reaches the client as an unexpected response,
 * as over HTTP) and owns the server end of the socket. `relay` may be a function, for a test that replaces the Relay with one restored
 * from the first one's state. `servers` lists the Relay's end of each connection, for a test that speaks as the Relay.
 */
export function relayConnection(relay: RelayUpgrades | (() => RelayUpgrades), closers: Array<() => void | Promise<void>> = [], options: RelayConnectionOptions = {}) {
  const servers: MemoryRelaySocket[] = [];
  const connect: NonNullable<RemoteHostUplinkClientOptions['connect']> = (endpoint, init): UplinkSocket => {
    const client = new EventEmitter() as EventEmitter & UplinkSocket & { readyState: number };
    client.readyState = 0;
    let pair: ReturnType<typeof memorySocketPair> | undefined;
    const end = (code: number, reason: string) => {
      if (client.readyState === 3) return;
      client.readyState = 3;
      client.emit('close', code, Buffer.from(reason));
      pair?.native.close(code, reason);
    };
    client.send = (json, callback) => {
      if (!pair || client.readyState !== 1) { callback?.(new Error('Socket is closed')); return; }
      pair.native.send(json); callback?.();
    };
    client.terminate = () => end(1006, '');
    void (async () => {
      const target = new URL(endpoint); options.query?.(target);
      const prepared = await (typeof relay === 'function' ? relay() : relay).prepareUpgrade(new Request(`http://relay.test${target.pathname}${target.search}`, { headers: { authorization: init.authorization } }));
      if (client.readyState === 3) return;
      if (!prepared || prepared instanceof Response) { client.emit('unexpected-response', undefined, { statusCode: prepared instanceof Response ? prepared.status : 404 }); end(1006, ''); return; }
      pair = memorySocketPair(closers, (direction, json) => {
        const named = direction === 'toRelay' ? 'controller->relay' as const : 'relay->controller' as const;
        if (options.deliver?.(named, json) === false) return false;
        options.recorder?.frame(named, json);
      });
      servers.push(pair.server);
      pair.native.onMessage(data => { if (client.readyState === 1) client.emit('message', Buffer.from(data), false); });
      pair.native.onClose(details => end(details?.code ?? 1006, ''));
      prepared.accept(pair.server);
      client.readyState = 1;
      client.emit('open');
    })();
    return client;
  };
  return { connect, servers };
}

/** `relayConnection`'s `connect` alone. */
export const connectToRelay = (relay: RelayUpgrades | (() => RelayUpgrades), closers: Array<() => void | Promise<void>> = [], recorder?: RelayConnectionOptions['recorder']) =>
  relayConnection(relay, closers, recorder ? { recorder } : {}).connect;

/** A browser's WebSocket to a Relay path, in memory: the Relay's `prepareUpgrade` decides, and the frames it sends arrive in `messages`. */
export async function browserStream(relay: RelayUpgrades, url: string, closers: Array<() => void | Promise<void>> = []) {
  const prepared = await relay.prepareUpgrade(new Request(url, { headers: { origin: new URL(url).origin } }));
  if (!prepared || prepared instanceof Response) throw new Error(`The Relay refused the stream: ${prepared instanceof Response ? prepared.status : 'not handled'}`);
  const pair = memorySocketPair(closers);
  const messages: any[] = [];
  pair.native.onMessage(data => { messages.push(JSON.parse(data)); });
  prepared.accept(pair.server);
  return { messages, send: (message: unknown) => pair.native.send(JSON.stringify(message)), close: () => pair.native.close(1000) };
}
