import { EventEmitter } from 'node:events';
import type { createHostBroker } from '@orchardworks/agent-relay-core';
import type { RemoteHostUplinkClientOptions, UplinkSocket } from '@orchardworks/agent-session-runtime';

import { socketPair, type FrameRecorder } from './relay-harness.js';

/**
 * Connects a real Controller to a real Relay without a listener: the uplink client's `connect` port, answered by the Relay's own
 * `prepareUpgrade` and an in-memory socket pair. The Relay decides the upgrade (its status reaches the client as an unexpected
 * response, as over HTTP) and owns the server end of the socket.
 */
type Relay = ReturnType<typeof createHostBroker>;

/** `broker` may be a function, for a test that replaces the Relay with one restored from the first one's state. */
export function connectToRelay(broker: Relay | (() => Relay), closers: Array<() => void | Promise<void>> = [], recorder?: FrameRecorder): NonNullable<RemoteHostUplinkClientOptions['connect']> {
  return (endpoint, init): UplinkSocket => {
    const client = new EventEmitter() as EventEmitter & UplinkSocket & { readyState: number };
    client.readyState = 0;
    let pair: ReturnType<typeof socketPair> | undefined;
    const end = (code: number, reason: string) => {
      if (client.readyState === 3) return;
      client.readyState = 3;
      client.emit('close', code, Buffer.from(reason));
      pair?.native.close(code, reason);
    };
    client.send = (json, callback) => {
      if (!pair || client.readyState !== 1) { callback(new Error('Socket is closed')); return; }
      pair.native.send(json); callback();
    };
    client.terminate = () => end(1006, '');
    void (async () => {
      const prepared = await (typeof broker === 'function' ? broker() : broker).prepareUpgrade(new Request(`http://relay.test${endpoint.pathname}${endpoint.search}`, { headers: { authorization: init.authorization } }));
      if (client.readyState === 3) return;
      if (!prepared || prepared instanceof Response) { client.emit('unexpected-response', undefined, { statusCode: prepared instanceof Response ? prepared.status : 404 }); end(1006, ''); return; }
      pair = socketPair(closers, (direction, json) => recorder?.frame(direction === 'toRelay' ? 'controller->relay' : 'relay->controller', json));
      pair.native.onMessage(data => { if (client.readyState === 1) client.emit('message', Buffer.from(data), false); });
      pair.native.onClose(details => end(details?.code ?? 1006, ''));
      prepared.accept(pair.server);
      client.readyState = 1;
      client.emit('open');
    })();
    return client;
  };
}

/** A browser's WebSocket to a Relay path, in memory: the Relay's `prepareUpgrade` decides, and the frames it sends arrive in `messages`. */
export async function browserStream(broker: Relay, url: string, closers: Array<() => void | Promise<void>> = []) {
  const prepared = await broker.prepareUpgrade(new Request(url, { headers: { origin: new URL(url).origin } }));
  if (!prepared || prepared instanceof Response) throw new Error(`The Relay refused the stream: ${prepared instanceof Response ? prepared.status : 'not handled'}`);
  const pair = socketPair(closers);
  const messages: any[] = [];
  pair.native.onMessage(data => { messages.push(JSON.parse(data)); });
  prepared.accept(pair.server);
  return { messages, send: (message: unknown) => pair.native.send(JSON.stringify(message)), close: () => pair.native.close(1000) };
}
