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

it('bounds the owner authority response before accepting a valid lease', async () => {
  const server = createServer((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ active: true, subject: 'alice', validUntil: Date.now() + 60_000, extra: 'x'.repeat(20000) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
    const result = await queryGatewayAuthority({ origin: 'https://agents.example', issuer: `http://127.0.0.1:${address.port}`, secret: 'authority-limit-secret-01234567890123456789' }, 'user-status', { subject: 'alice' });
    expect(result).toEqual({ status: 'unavailable' });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

it.each([[503, 'authority_http_error'], [403, 'access_revoked'], [200, 'authority_invalid_response']] as const)(
  'reports safe authority failure metadata for HTTP %s', async (status, reason) => {
    const server = createServer((request, response) => {
      request.resume(); response.writeHead(status); response.end('private authority response');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
      const diagnostics: unknown[] = [];
      await queryGatewayAuthority({ origin: 'https://relay.example', issuer: `http://127.0.0.1:${address.port}`, secret: 'authority-safe-metadata-secret-0123456789' },
        'user-status', { subject: 'private-user' }, value => diagnostics.push(value));
      expect(diagnostics).toEqual([{ reason, status, durationMs: expect.any(Number) }]);
      expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret/);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10000);

it('distinguishes an authority deadline from HTTP errors without changing denial behavior', async () => {
  const server = createServer(request => request.resume());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
    const diagnostics: unknown[] = [];
    const result = await queryGatewayAuthority({ origin: 'https://relay.example', issuer: `http://127.0.0.1:${address.port}`, secret: 'authority-timeout-secret-0123456789012345' },
      'user-status', { subject: 'private-user' }, value => diagnostics.push(value));
    expect(result).toEqual({ status: 'unavailable' });
    expect(diagnostics).toEqual([{ reason: 'authority_timeout', durationMs: expect.any(Number) }]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
