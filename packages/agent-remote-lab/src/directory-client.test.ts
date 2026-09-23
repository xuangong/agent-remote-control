// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { RemoteHostClient, SessionDirectoryClient } from './directory-client.js';

it('requests fresh Controller discovery only for a manual refresh', async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ release: null }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteHostClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/u/tenant/`);
    await client.controllerRelease();
    await client.controllerRelease({ refresh: true });
    expect(paths).toEqual(['/u/tenant/v1/remote/controller-release', '/u/tenant/v1/remote/controller-release?refresh=1']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('revokes the selected Host over the user-scoped HTTP endpoint', async () => {
  const requests: Array<{ method?: string; path?: string; body: string; contentType?: string }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method, path: request.url, body, contentType: request.headers['content-type'] });
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteHostClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/u/tenant/`);
    await client.revoke('host/one');
    expect(requests).toEqual([{ method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/revoke', body: '{}', contentType: 'application/json' }]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('sends owner stop and rotation requests without credentials and retains fresh-auth error codes', async () => {
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    paths.push(request.url!);
    expect(request.method).toBe('POST');
    if (request.url!.endsWith('/rotate')) expect(body).toBe('{}');
    else expect(JSON.parse(body)).toEqual({ operationId: expect.any(String) });
    expect(request.headers.authorization).toBeUndefined();
    response.setHeader('content-type', 'application/json');
    if (request.url!.endsWith('/rotate')) { response.statusCode = 403; response.end(JSON.stringify({ code: 'reauthentication_required', loginUrl: 'https://untrusted.example' })); }
    else response.end(JSON.stringify({ results: [{ agentId: 'one', status: 'unsupported' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteHostClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/u/tenant/`);
    await expect(client.rotate('host/one')).rejects.toMatchObject({ code: 'reauthentication_required' });
    expect(await client.stop('host/one')).toEqual({ results: [{ agentId: 'one', status: 'unsupported' }] });
    expect(paths).toEqual(['/u/tenant/v1/remote/hosts/host%2Fone/rotate', '/u/tenant/v1/remote/hosts/host%2Fone/stop']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


it('retains the server request ID, status and error code when opening a session', async () => {
  const client = new SessionDirectoryClient('http://localhost/', async () => Response.json({
    code: 'native_history_timeout', error: 'History deadline', requestId: 'request-123',
  }, { status: 503 }));
  await expect(client.attach('codex', 'native')).rejects.toMatchObject({
    code: 'native_history_timeout', status: 503, requestId: 'request-123', message: 'History deadline',
  });
});

it('manages pairing invitations using scoped URLs and explicit purposes', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    requests.push({ method: request.method, path: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { pairings: [], availablePurposes: ['host-only', 'gateway-setup'] } : { ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteHostClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/u/tenant/`);
    expect(await client.pairings()).toEqual({ pairings: [], availablePurposes: ['host-only', 'gateway-setup'] });
    await client.pair();
    await client.pair('gateway-setup');
    await client.revokePairing('invite/one');
    await client.deletePairing('invite/one');
    expect(requests).toEqual([
      { method: 'GET', path: '/u/tenant/v1/remote/pairings', body: '' },
      { method: 'POST', path: '/u/tenant/v1/remote/pairings', body: '{"purpose":"host-only"}' },
      { method: 'POST', path: '/u/tenant/v1/remote/pairings', body: '{"purpose":"gateway-setup"}' },
      { method: 'POST', path: '/u/tenant/v1/remote/pairings/invite%2Fone/revoke', body: '{}' },
      { method: 'DELETE', path: '/u/tenant/v1/remote/pairings/invite%2Fone', body: '' },
    ]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('queries daemon outcomes and posts one explicit intent with no automatic replay', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  const revision = '00000000-0000-4000-8000-000000000001';
  const operationId = '00000000-0000-4000-8000-000000000002';
  let invalid = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method, path: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(invalid ? { phase: 'ready' } : { revision, phase: 'idle', updatedAt: 0 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RemoteHostClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/u/tenant/`);
    expect((await client.codexDaemon('host/one')).phase).toBe('idle');
    invalid = true;
    await expect(client.codexDaemon('host/one', { operationId, revision })).rejects.toThrow(/could not be verified/);
    expect(requests).toEqual([
      { method: 'GET', path: '/u/tenant/v1/remote/hosts/host%2Fone/codex-daemon', body: '' },
      { method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/codex-daemon', body: JSON.stringify({ operationId, revision }) },
    ]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
