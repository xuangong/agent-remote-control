import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type RemoteHostUplinkClientOptions } from './remote-host-uplink-client.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });
async function websocketBroker(register = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const sockets: WebSocket[] = [], acknowledgements: string[] = [];
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (register && message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host',
        heartbeat: { intervalMs: 100, timeoutMs: 40 } }));
      if (message.type === 'heartbeat_ack') acknowledgements.push(message.nonce);
    });
  });
  return { sockets, acknowledgements, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host` };
}
function client(url: string, events: RemoteHostUplinkDiagnostic[], failCallback = false,
  options: Pick<RemoteHostUplinkClientOptions, 'onCredential' | 'registrationTimeoutMs'> = {}) {
  const relay = createAgentRemoteRelay({ providers: [] }); closeables.push(() => relay.close());
  const uplink = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'pairing-secret', url,
    resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 20, registrationTimeoutMs: 80,
    ...options,
    onDiagnostic(event) {
      events.push(event);
      if (failCallback && event.event === 'connecting') throw new Error('diagnostic sink failed');
      if (failCallback && event.event === 'disconnected') return Promise.reject(new Error('asynchronous diagnostic sink failed'));
    },
  });
  closeables.push(() => uplink.close()); return uplink;
}

describe('Remote Host uplink diagnostics', () => {
  it('retains heartbeat timeout as the first cause and records recovery without logging healthy heartbeats', async () => {
    const broker = await websocketBroker(); const events: RemoteHostUplinkDiagnostic[] = [];
    const uplink = client(broker.url, events, true); await uplink.ready;
    broker.sockets[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: 'heartbeat-secret' }));
    await expect.poll(() => broker.acknowledgements.length).toBe(1);
    expect(events.map(event => event.event)).toEqual(['connecting', 'registered']);
    await expect.poll(() => events.filter(event => event.event === 'registered').length, { timeout: 2000 }).toBe(2);
    const disconnected = events.filter(event => event.event === 'disconnected');
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toMatchObject({ connectionId: 1, reason: 'heartbeat_timeout', registered: true, closeCode: 1006, heartbeatTimeoutMs: 140 });
    expect(disconnected[0]!.lastHeartbeatAgeMs).toBeGreaterThanOrEqual(130);
    expect(events.find(event => event.event === 'reconnect_scheduled')).toMatchObject({ connectionId: 1, retryAttempt: 1 });
    expect(events.find(event => event.event === 'reconnect_scheduled')!.retryDelayMs).toBeGreaterThanOrEqual(5);
    expect(events.at(-1)).toMatchObject({ event: 'registered', connectionId: 2 });
    await uplink.close();
    expect(events.at(-1)).toMatchObject({ event: 'closed', reason: 'client_closed', connectionId: 2 });
    expect(events.filter(event => event.event === 'disconnected')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/pairing-secret|heartbeat-secret/);
  });

  it('records a peer close code without retaining its arbitrary close reason', async () => {
    const broker = await websocketBroker(); const events: RemoteHostUplinkDiagnostic[] = [];
    const uplink = client(broker.url, events); await uplink.ready;
    broker.sockets[0]!.close(1008, 'private-peer-message pairing-secret');
    await expect.poll(() => events.some(event => event.event === 'disconnected')).toBe(true);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ reason: 'socket_closed', closeCode: 1008, registered: true });
    expect(events.find(event => event.event === 'disconnected')).not.toHaveProperty('peerReason');
    await delay(40);
    expect(events.some(event => event.event === 'reconnect_scheduled')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/private-peer-message|pairing-secret/);
  });

  it.each([
    ['Host heartbeat timed out', 'heartbeat_timeout'],
    ['Host heartbeat delivery failed', 'heartbeat_delivery_failed'],
    ['Host connection replaced', 'connection_replaced'],
    ['Broker closed', 'broker_closed'],
  ])('normalizes the known peer close reason %s without replacing the local cause', async (reason, peerReason) => {
    const broker = await websocketBroker(); const events: RemoteHostUplinkDiagnostic[] = [];
    const uplink = client(broker.url, events); await uplink.ready;
    broker.sockets[0]!.close(1012, reason);
    await expect.poll(() => events.some(event => event.event === 'disconnected')).toBe(true);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ reason: 'socket_closed', closeCode: 1012, peerReason });
    expect(JSON.stringify(events)).not.toContain(reason);
  });

  it('records why reconnection stops when credential persistence fails after the socket closes', async () => {
    const broker = await websocketBroker(false); const events: RemoteHostUplinkDiagnostic[] = [];
    let rejectWrite!: (error: Error) => void;
    let writing = false;
    const write = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const uplink = client(broker.url, events, false, { onCredential: () => { writing = true; return write; }, registrationTimeoutMs: 2000 });
    closeables.push(async () => { rejectWrite(new Error('private-storage-error')); });
    await expect.poll(() => broker.sockets.length).toBe(1);
    broker.sockets[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'credential_issued', credential: 'device-secret' }));
    await expect.poll(() => writing).toBe(true);
    broker.sockets[0]!.close(1012, 'Broker closed');
    await expect.poll(() => events.some(event => event.event === 'reconnect_scheduled')).toBe(true);
    rejectWrite(new Error('private-storage-error'));
    await expect(uplink.ready).rejects.toThrow(/durably save/);
    await expect.poll(() => events.some(event => event.event === 'reconnect_stopped')).toBe(true);
    expect(events.filter(event => event.event === 'disconnected')).toHaveLength(1);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ connectionId: 1, reason: 'socket_closed', closeCode: 1012 });
    expect(events.filter(event => event.event === 'reconnect_stopped')).toEqual([
      { event: 'reconnect_stopped', connectionId: 1, registered: false, reason: 'credential_persistence_failed' },
    ]);
    await delay(50);
    expect(events.filter(event => event.event === 'connecting')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/device-secret|private-storage-error/);
  });

  it('distinguishes an unacknowledged registration deadline from a later socket close', async () => {
    const broker = await websocketBroker(false); const events: RemoteHostUplinkDiagnostic[] = [];
    client(broker.url, events);
    await expect.poll(() => events.some(event => event.event === 'disconnected')).toBe(true);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ reason: 'registration_timeout', registered: false, closeCode: 1006 });
  });

  it('records an HTTP rejection status without headers or response body and does not retry credentials', async () => {
    const server = createServer();
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nX-Private: header-secret\r\nContent-Length: 11\r\n\r\nbody-secret'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closeables.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const events: RemoteHostUplinkDiagnostic[] = [];
    const uplink = client(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, events);
    await expect(uplink.ready).rejects.toThrow(/authorization was rejected/);
    await expect.poll(() => events.some(event => event.event === 'disconnected')).toBe(true);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ reason: 'http_rejected', httpStatus: 401, registered: false });
    expect(events.some(event => event.event === 'reconnect_scheduled')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/header-secret|body-secret|pairing-secret/);
  });

  it('records a bounded network error code when a connection cannot be established', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const events: RemoteHostUplinkDiagnostic[] = [];
    client(`ws://127.0.0.1:${port}/ws/remote-host`, events);
    await expect.poll(() => events.some(event => event.event === 'disconnected')).toBe(true);
    expect(events.find(event => event.event === 'disconnected')).toMatchObject({ reason: 'socket_error', errorCode: 'ECONNREFUSED', registered: false });
    expect(JSON.stringify(events)).not.toContain('pairing-secret');
  });
});
