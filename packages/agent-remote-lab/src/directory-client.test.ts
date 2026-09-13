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
