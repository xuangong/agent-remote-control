import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startScriptedHost } from './scripted-host.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); });

/** The parts of a local-user instance a scripted Host talks to over HTTP: sign-in, a pairing key and the smart-reading switch. */
async function instanceStub(): Promise<{ origin: string; pairings: number }> {
  const state = { origin: '', pairings: 0 };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/auth/status') response.setHeader('set-cookie', 'session=local').end(JSON.stringify({ basePath: '/' }));
    else if (request.url === '/v1/remote/pairings') { state.pairings += 1; response.end(JSON.stringify({ key: 'pairing-key' })); }
    else response.end('{}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}

/** A port nothing listens on: the address a Host's uplink proxy would have if the proxy never came up. */
async function deadPort(): Promise<number> {
  const probe = createSocketServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise(resolve => probe.close(resolve));
  return port;
}

describe('a scripted Host that cannot register', () => {
  it('fails within its bound and says what its uplink last did', async () => {
    const instance = await instanceStub();
    const port = await deadPort();
    const started = Date.now();
    await expect(startScriptedHost(instance, { name: 'Smoke Dead Host', installationId: 'smoke-dead-1', uplinkVia: `http://127.0.0.1:${port}`, sessions: {}, registerWithinMs: 150 }))
      .rejects.toThrow(/Smoke Dead Host.*did not register within 150 ms.*ws:\/\/127\.0\.0\.1:\d+\/ws\/remote-host.*(socket_error|reconnect_scheduled|disconnected)/s);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(instance.pairings).toBe(1);
  });
});
