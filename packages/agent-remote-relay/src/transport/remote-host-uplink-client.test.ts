import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

async function broker(heartbeat: { intervalMs: number; timeoutMs: number }, providers?: Array<{ providerId: string; displayName: string }>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const connections: WebSocket[] = [], pings: Buffer[] = [], states: string[] = [], acknowledgements: string[] = [];
  let registrations = 0; let registeredProviders: unknown;
  const responses: Array<{ requestId: string; status: number; body: string }> = [];
  server.on('connection', socket => {
    connections.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') {
        registrations += 1;
        registeredProviders = message.providers;
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat }));
      }
      if (message.type === 'heartbeat_ack') acknowledgements.push(message.nonce);
      if (message.type === 'rpc_response') responses.push(message);
    });
    socket.on('ping', payload => { pings.push(Buffer.from(payload)); });
  });
  const relay = createAgentRemoteRelay({ providers: [] });
  closeables.push(() => relay.close());
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers,
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`,
    resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10,
    onStateChange: state => states.push(state),
  });
  closeables.push(() => client.close());
  await client.ready;
  return { client, connections, pings, states, acknowledgements, responses, registrations: () => registrations, registeredProviders: () => registeredProviders };
}

it('registers an enrollment-only Host over WebSocket with an empty provider list', async () => {
  const b = await broker({ intervalMs: 30000, timeoutMs: 10000 }, []);
  expect(b.registeredProviders()).toEqual([]);
  expect(b.states).toEqual(['connecting', 'registered']);
}, 10000);

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await delay(5);
  expect(predicate()).toBe(true);
}

describe('Remote Host uplink heartbeat', () => {
  const heartbeat = { intervalMs: 100, timeoutMs: 40 };

  it('acknowledges cloud challenges without sending native pings', async () => {
    const b = await broker(heartbeat);
    for (const nonce of ['first', 'second', 'third', 'fourth']) {
      await delay(60);
      b.connections[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce }));
      await until(() => b.acknowledgements.includes(nonce));
    }
    expect(b.acknowledgements).toEqual(['first', 'second', 'third', 'fourth']);
    expect(b.pings).toHaveLength(0);
    expect(b.registrations()).toBe(1);
  });

  it('reconnects when the cloud connection sends no heartbeat', async () => {
    const b = await broker(heartbeat);
    await until(() => b.registrations() >= 2);
    b.connections[1]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: 'reconnected' }));
    await until(() => b.acknowledgements.includes('reconnected'));
    expect(b.connections[0]!.readyState).toBe(3);
    expect(b.pings).toHaveLength(0);
  });

  it('keeps the uplink and heartbeat alive after workspace folder requests', async () => {
    const b = await broker({ intervalMs: 2000, timeoutMs: 500 });
    const socket = b.connections[0]!;
    for (const [index, query] of ['', '?providerId=codex&path=%2FUsers%2Fworkspace', '?hidden=1&search=project&offset=100'].entries()) {
      const requestId = `folders-${index}`;
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method: 'GET', path: `/remote/workspace-folders${query}` }));
      await until(() => b.responses.some(response => response.requestId === requestId));
      expect(b.responses.find(response => response.requestId === requestId)).toMatchObject({ status: 404, body: '{}' });
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: requestId }));
      await until(() => b.acknowledgements.includes(requestId));
    }
    expect(socket.readyState).toBe(1);
    expect(b.registrations()).toBe(1);
    expect(b.states).toEqual(['connecting', 'registered']);
  });

  it('does not postpone cloud silence detection for repeated registrations or business traffic', async () => {
    const b = await broker(heartbeat);
    const first = b.connections[0]!;
    const traffic = setInterval(() => {
      if (first.readyState !== 1) return;
      first.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat }));
      first.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId: 'catalog', method: 'GET', path: '/remote/catalog' }));
    }, 20);
    try {
      await delay(70);
      expect(b.registrations()).toBe(1);
      expect(first.readyState).toBe(1);
      await until(() => b.registrations() >= 2);
    }
    finally { clearInterval(traffic); }
    expect(first.readyState).toBe(3);
    expect(b.pings).toHaveLength(0);
  });

  it('cleans the cloud watchdog when actively closed and when policy rejects the connection', async () => {
    for (const rejected of [false, true]) {
      const b = await broker(heartbeat);
      if (rejected) {
        b.connections[0]!.close(1008, 'Device revoked');
        await until(() => b.states.includes('rejected'));
      } else await b.client.close();
      await delay(200);
      expect(b.registrations()).toBe(1);
      expect(b.pings).toHaveLength(0);
      expect(b.states).toEqual(['connecting', 'registered', rejected ? 'rejected' : 'closed']);
    }
  });
});
