// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { RemoteHostControlClient } from '../headless.js';
const work = { id: 'work/one', revision: 1, title: 'Delivery', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09', updatedAt: '2026-10-09', nextCheckAt: 0 };
it('uses scoped Host routes, validates work responses and never replays a failed mutation', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  let invalid = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    requests.push({ method: request.method, path: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(invalid ? { id: 'wrong' } : request.url!.endsWith('/tpm') ? { supported: true, works: [work] } : work));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new RemoteHostControlClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/u/tenant/`);
    expect((await client.tpmList('host/one')).works).toEqual([work]);
    expect(await client.tpmWork('host/one', work.id)).toEqual(work);
    const create = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Delivery', requirement: 'Ship', operationId: 'create-one' };
    expect(await client.tpmCreate('host/one', create)).toEqual(work);
    invalid = true;
    await expect(client.tpmAction('host/one', work.id, { action: 'pause', revision: 1, operationId: 'pause-one' })).rejects.toMatchObject({ code: 'invalid_host_response' });
    expect(requests).toEqual([
      { method: 'GET', path: '/u/tenant/v1/remote/hosts/host%2Fone/tpm', body: '' },
      { method: 'GET', path: '/u/tenant/v1/remote/hosts/host%2Fone/tpm/work?id=work%2Fone', body: '' },
      { method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/tpm/create', body: JSON.stringify(create) },
      { method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/tpm/action', body: JSON.stringify({ action: 'pause', revision: 1, operationId: 'pause-one', id: work.id }) },
    ]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10000);
it('preserves authorization and revision errors with their HTTP status and request identity', async () => {
  const client = new RemoteHostControlClient('http://relay/u/a/', { fetch: async () => Response.json({ code: 'revision_conflict', error: 'Refresh the work', requestId: 'request-one' }, { status: 409 }) });
  await expect(client.tpmAction('host', 'work', { action: 'pause', revision: 1, operationId: 'pause-one' })).rejects.toMatchObject({ status: 409, code: 'revision_conflict', requestId: 'request-one' });
});

it('aggregates all catalog pages and rejects a repeated pagination cursor', async () => {
  const requests: string[] = []; let repeated = false;
  const client = new RemoteHostControlClient('http://relay/u/a/', { fetch: async input => {
    const url = new URL(String(input)); requests.push(url.search);
    return Response.json(url.search ? { supported: true, works: [{ ...work, id: 'second' }], ...(repeated ? { nextCursor: 'first' } : {}) }
      : { supported: true, works: [work], nextCursor: 'first' });
  } });
  expect((await client.tpmList('host')).works.map(work => work.id)).toEqual([work.id, 'second']);
  expect(requests).toEqual(['', '?cursor=first']);
  repeated = true;
  await expect(client.tpmList('host')).rejects.toMatchObject({ code: 'invalid_host_response' });
});
