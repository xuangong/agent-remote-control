// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { RemoteHostClient } from './directory-client.js';

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
