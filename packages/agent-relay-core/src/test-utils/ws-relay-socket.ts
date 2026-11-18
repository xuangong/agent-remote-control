import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

import type { RelaySocket } from '../transport.js';

/** A `ws` server-side socket as the Relay's `RelaySocket` port, for the few tests that exercise a real loopback connection. */
export function relaySocket(socket: WebSocket): RelaySocket {
  socket.on('error', () => undefined);
  return {
    get readyState() { return socket.readyState; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage(listener) {
      const receive = (data: import('ws').RawData, binary: boolean) => {
        try { void Promise.resolve(listener(data.toString(), binary)).catch(() => socket.close(1011, 'Socket message failed')); }
        catch { socket.close(1011, 'Socket message failed'); }
      };
      socket.on('message', receive); return () => { socket.off('message', receive); };
    },
    onClose(listener) {
      const closed = (code: number) => listener({ code });
      socket.on('close', closed); return () => { socket.off('close', closed); };
    },
    onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; },
  };
}

/**
 * A Controller's WebSocket to a Relay in memory: the Relay's `prepareUpgrade` decides, and the client is the small part of `ws`
 * that tests use (`send`, `terminate`, and the `open`, `message` and `close` events). Nothing listens on a port.
 */
export function memoryHostClient(broker: { prepareUpgrade(request: Request): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> }, url: string, authorization = 'Bearer key') {
  const client = new EventEmitter() as EventEmitter & { send(data: string): void; terminate(): void; readyState: number };
  client.readyState = 0;
  const messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  const closes = new Set<(details?: { code?: number }) => void>();
  const end = (code: number) => {
    if (client.readyState === 3) return;
    client.readyState = 3; server.readyState = 3;
    for (const listener of closes) listener({ code });
    client.emit('close', code, Buffer.from(''));
  };
  const server = {
    readyState: 1, bufferedAmount: 0,
    send: (data: string) => { queueMicrotask(() => { if (client.readyState === 1) client.emit('message', Buffer.from(data), false); }); },
    close: (code?: number) => end(code ?? 1000),
    onMessage: (listener: (data: string, binary: boolean) => void | Promise<void>) => { messages.add(listener); return () => { messages.delete(listener); }; },
    onClose: (listener: (details?: { code?: number }) => void) => { closes.add(listener); return () => { closes.delete(listener); }; },
    onError: () => () => undefined,
  } satisfies RelaySocket & { readyState: number };
  client.send = data => { queueMicrotask(() => { if (client.readyState === 1) for (const listener of messages) void listener(data, false); }); };
  client.terminate = () => end(1006);
  void (async () => {
    const prepared = await broker.prepareUpgrade(new Request(url, { headers: { authorization } }));
    if (!prepared || prepared instanceof Response) { end(1006); return; }
    prepared.accept(server);
    client.readyState = 1;
    client.emit('open');
  })().catch(() => end(1011));
  return client;
}
