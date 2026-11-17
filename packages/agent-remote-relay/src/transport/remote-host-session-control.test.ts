import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

/** A Relay on a real socket that answers the Controller's registration, acknowledging session control only when told to. */
async function relayFor(acknowledged: boolean) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const seen: { offered: string | null; closes: Array<{ code: number; reason: string }> } = { offered: null, closes: [] };
  let connection!: import('ws').WebSocket;
  server.on('connection', (socket, request) => {
    connection = socket;
    seen.offered = new URL(request.url!, 'http://relay').searchParams.get('control');
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, ...(acknowledged ? { control: 1 } : {}) }));
      if (message.type === 'stream_close') seen.closes.push({ code: message.code, reason: message.reason });
    });
  });
  const relay = createAgentRemoteRelay({ providers: [] }); closeables.push(() => relay.close());
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers: [],
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }) });
  closeables.push(() => client.close());
  await client.ready;
  return { seen, openStream: async () => {
    connection.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_open', streamId: 'stream-1', sessionId: 'session-1' }));
    for (let attempt = 0; attempt < 200 && seen.closes.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    return seen.closes[0];
  } };
}

it('offers session control and opens streams only when the Relay acknowledges it', async () => {
  const acknowledged = await relayFor(true);
  expect(acknowledged.seen.offered).toBe('1');
  // The stream passed the control gate and was then refused for its session, not for the Relay.
  expect(await acknowledged.openStream()).toEqual({ code: 1008, reason: 'Remote Session is unavailable.' });
});

it('refuses every stream of a Relay that does not own session control, and asks for the Relay to be updated', async () => {
  const unacknowledged = await relayFor(false);
  expect(unacknowledged.seen.offered).toBe('1');
  expect(await unacknowledged.openStream()).toEqual({ code: 1008, reason: 'Update the Relay to open sessions.' });
});
