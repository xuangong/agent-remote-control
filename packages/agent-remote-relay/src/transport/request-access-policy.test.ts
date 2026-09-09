import type { IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createAgentRemoteRelay } from '../relay.js';
import { createAgentRemoteHttpServer } from './http-server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function start(authorize = (request: IncomingMessage) => request.headers.authorization === 'Bearer service-test') {
  const relay = createAgentRemoteRelay({ providers: [] });
  const server = createAgentRemoteHttpServer(relay, {
    accessPolicy: { authorize },
    websocketAuthorizer: { authenticate: () => ({ subject: 'gateway' }), authorize: () => true },
  });
  cleanup.push(async () => { await server.close(); await relay.close(); });
  return (await server.listen()).url;
}

const routes = [
  ['GET', '/v1/providers?protocolVersion=1.1.0'],
  ['GET', '/v1/sessions/private/snapshot?protocolVersion=1.1.0'],
  ['GET', '/v1/sessions/private/timeline?protocolVersion=1.1.0'],
  ['POST', '/v1/sessions'],
  ['POST', '/v1/sessions/resume'],
  ['GET', '/unknown'],
] as const;

describe('Agent Remote request access policy', () => {
  it.each(routes)('protects %s %s before routing or body decoding', async (method, path) => {
    const url = await start();
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { cookie: 'session=human' }]) {
      const response = await fetch(url + path, {
        method, headers, ...(method === 'POST' ? { body: '{invalid-json' } : {}),
        signal: AbortSignal.timeout(1500),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ type: 'protocol_error', payload: { code: 'unauthorized' } });
    }
  });

  it('allows authenticated reads and preserves typed missing-session errors', async () => {
    const url = await start();
    const headers = { authorization: 'Bearer service-test' };
    const response = await fetch(`${url}/v1/providers?protocolVersion=1.1.0`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: 'provider_list', payload: { providers: [] } });
    const missing = await fetch(`${url}/v1/sessions/private/snapshot?protocolVersion=1.1.0`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ payload: { code: 'agent_not_found' } });
  });

  it('fails closed when the policy throws', async () => {
    const url = await start(() => { throw new Error('credential lookup failed'); });
    const response = await fetch(`${url}/v1/providers?protocolVersion=1.1.0`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('credential lookup failed');
    expect(await upgrade(url, '/v1/sessions/private/events')).toBe(401);
  });

  it.each(['/v1/sessions/private/events', '/unknown'])('authenticates WebSocket upgrades before routing %s', async (path) => {
    const url = await start();
    expect(await upgrade(url, path)).toBe(401);
    expect(await upgrade(url, path, 'Bearer wrong')).toBe(401);
    expect(await upgrade(url, path, 'Bearer service-test')).toBe(path === '/unknown' ? 404 : 101);
  });
});

function upgrade(url: string, path: string, authorization?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + path, {
      ...(authorization ? { headers: { authorization } } : {}), handshakeTimeout: 1500,
    });
    socket.on('error', () => undefined);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('open', () => { resolve(101); socket.terminate(); });
    socket.once('error', reject);
  });
}
