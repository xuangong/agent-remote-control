import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, test } from 'vitest';
import { createControllerPreviews } from './previews.js';

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

async function server() {
  const instance = createServer((_request, response) => response.end('ok')); servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { instance, port: (instance.address() as import('node:net').AddressInfo).port };
}

describe('Controller previews', () => {
  test('rejects unknown routes and unsupported methods without treating them as mutations', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'controller-previews-'));
    directories.push(stateDirectory);
    const previews = createControllerPreviews({ stateDirectory });
    previews.registered({ url: 'ws://127.0.0.1:1/ws/remote-host', hostId: 'host', tunnelToken: 'token' });
    expect((await previews.control({ method: 'POST', path: '/remote/previews/nope', body: '{}' })).status).toBe(404);
    expect((await previews.control({ method: 'GET', path: '/remote/previews/unregister' })).status).toBe(405);
    await previews.close();
  });

  test('reconnects immediately when control registration replaces a pending tunnel retry', async () => {
    const relay = await server();
    const target = await server();
    const tunnels = new WebSocketServer({ server: relay.instance });
    const connections: import('ws').WebSocket[] = [];
    tunnels.on('connection', socket => connections.push(socket));
    const stateDirectory = await mkdtemp(join(tmpdir(), 'controller-previews-')); directories.push(stateDirectory);
    const previews = createControllerPreviews({ stateDirectory });
    const registration = { url: `ws://127.0.0.1:${relay.port}/ws/remote-host`, hostId: 'host', tunnelToken: 'token' };
    previews.registered(registration);
    expect((await previews.control({ method: 'POST', path: '/remote/previews', body: JSON.stringify({
      target: `http://127.0.0.1:${target.port}`, source: { sessionId: 'session', itemId: 'item' },
    }) })).status).toBe(200);
    await expect.poll(() => connections.length, { timeout: 1000 }).toBe(1);
    connections[0]!.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    previews.disconnected();
    previews.registered(registration);
    await expect.poll(() => connections.length, { timeout: 300 }).toBe(2);
    await previews.close(); tunnels.close();
  });
});
