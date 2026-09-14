import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { queryGatewayAuthority } from './authority.js';

it.each([301, 302, 307, 308])('rejects authority redirect %s without forwarding the service proof', async status => {
  let forwarded = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/unexpected') {
      forwarded++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ active: true, subject: 'alice', validUntil: Date.now() + 60_000 }));
    } else {
      response.writeHead(status, { location: '/unexpected' });
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing authority listener');
    const result = await queryGatewayAuthority({ origin: 'https://agents.example', issuer: `http://127.0.0.1:${address.port}`,
      secret: 'authority-redirect-secret-01234567890123456789' }, 'user-status', { subject: 'alice' });
    expect(result).toEqual({ status: 'unavailable' });
    expect(forwarded).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 10_000);
