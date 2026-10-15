// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { WindowMutation, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, WindowWorkspaceClient } from './window-client.js';

const window: WorkspaceWindow = {
  schemaVersion: 1, id: 'window-one', revision: 0, title: 'One', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false,
  views: [{ id: 'main', placement: 'primary', width: 440, collapsed: false, display: { mode: 'preview', lettersVisible: true } }],
};
const mutation: WindowMutation = { operationId: 'rename-one', issuedAt: 100, baseRevision: 0, operation: { type: 'rename', title: 'Renamed' } };
const receipt = (operationId: string, revision = 1) => ({ operationId, revision, status: 'committed' as const, committedAt: 101, expiresAt: 1000 });

async function withWindowServer(reply: (input: { operationId: string }) => { body: unknown; status?: number }, run: (client: WindowWorkspaceClient) => Promise<void>) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    const next = reply(body ? JSON.parse(body) : {});
    response.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(next.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(new WindowWorkspaceClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/u/account/`)); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

type Method = 'create' | 'mutate' | 'delete';
const invoke = (client: WindowWorkspaceClient, method: Method) => method === 'mutate' ? client.mutate(window.id, mutation) : client[method](window);
it('rejects a snapshot for a different Window and sends same-origin credentials', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ window: { id: 'other' } }), { status: 200 }));
  const client = new WindowWorkspaceClient('https://site.test/u/account/', fetcher as typeof fetch);
  await expect(client.inspect('one')).rejects.toThrow('Invalid Window snapshot');
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://site.test/u/account/v1/windows/one');
  expect((fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'same-origin' });
});

it('accepts a duplicate mutation receipt with its original revision and a newer current snapshot', async () => {
  await withWindowServer(input => ({ body: { result: receipt(input.operationId), window: { ...window, revision: 3, title: 'Latest' } } }), async client => {
    const settled = await client.mutate(window.id, mutation);
    expect(settled.result).toMatchObject({ operationId: 'rename-one', status: 'committed', revision: 1 });
    expect(settled.window).toMatchObject({ revision: 3, title: 'Latest' });
  });
}, 10000);

it('returns a rejected mutation receipt with the current snapshot so the caller can refresh state', async () => {
  await withWindowServer(input => ({ body: {
    result: { ...receipt(input.operationId, 2), status: 'rejected', code: 'revision_conflict', message: 'Read the current Window revision.' },
    window: { ...window, revision: 3 },
  } }), async client => {
    const settled = await client.mutate(window.id, mutation);
    expect(settled.result).toMatchObject({ operationId: 'rename-one', status: 'rejected', revision: 2, code: 'revision_conflict' });
    expect(settled.window.revision).toBe(3);
  });
}, 10000);

it.each([
  { method: 'create' as const, code: 'window_exists', message: 'Window identity is already used.' },
  { method: 'delete' as const, code: 'revision_conflict', message: 'Read the current Window revision.' },
])('reports a rejected $method settlement even when HTTP succeeds', async ({ method, code, message }) => {
  await withWindowServer(input => ({ body: { window: { ...window, revision: 3 }, result: { ...receipt(input.operationId, 3), status: 'rejected', code, message } } }), async client => {
    const error = await invoke(client, method).catch(error => error);
    expect(error).toBeInstanceOf(WindowRequestError);
    expect(error).toMatchObject({ status: 200, code, message, result: { operationId: expect.any(String), status: 'rejected', revision: 3, code } });
  });
}, 10000);

it('preserves create rejection when a deleted Window identity has no current snapshot', async () => {
  await withWindowServer(input => ({ body: { result: { ...receipt(input.operationId, 0), status: 'rejected', code: 'window_exists', message: 'Window identity is already used.' } } }), async client => {
    await expect(client.create(window)).rejects.toMatchObject({ status: 200, code: 'window_exists' });
  });
}, 10000);

it.each(['create', 'mutate', 'delete'] as const)('rejects a %s receipt belonging to another operation', async method => {
  await withWindowServer(() => ({ body: { window, result: receipt('unrelated-operation', 0) } }), async client => {
    await expect(invoke(client, method)).rejects.toMatchObject(method === 'mutate' ? { code: 'invalid_window_receipt' } : { code: 'operation_unknown', cause: { code: 'invalid_window_receipt' } });
  });
}, 10000);

it.each(['create', 'mutate', 'delete'] as const)('rejects a missing %s settlement', async method => {
  await withWindowServer(() => ({ body: { window } }), async client => {
    await expect(invoke(client, method)).rejects.toMatchObject(method === 'mutate' ? { code: 'invalid_window_receipt' } : { code: 'operation_unknown', cause: { code: 'invalid_window_receipt' } });
  });
}, 10000);

it.each(['create', 'mutate'] as const)('rejects a %s snapshot older than its settlement', async method => {
  await withWindowServer(input => ({ body: { window, result: receipt(input.operationId, 2) } }), async client => {
    await expect(invoke(client, method)).rejects.toMatchObject(method === 'mutate' ? { code: 'invalid_window_receipt' } : { code: 'operation_unknown', cause: { code: 'invalid_window_receipt' } });
  });
}, 10000);

it('accepts a committed creation and a committed deletion without a snapshot', async () => {
  await withWindowServer(input => ({ body: { window, result: receipt(input.operationId, 0) } }), async client => {
    await expect(client.create(window)).resolves.toMatchObject({ window: { id: 'window-one', revision: 0 } });
  });
  await withWindowServer(input => ({ body: { result: receipt(input.operationId) } }), async client => {
    await expect(client.delete(window)).resolves.toBeUndefined();
  });
}, 10000);

async function withLostReply(method: 'create' | 'delete', lookupAvailable: boolean, run: (client: WindowWorkspaceClient, state: { requests: string[]; writes: any[]; lookupAvailable: boolean }) => Promise<void>) {
  const state = { requests: [] as string[], writes: [] as any[], lookupAvailable };
  const server = createServer(async (request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    if (request.method !== 'GET') {
      let body = ''; for await (const part of request) body += String(part);
      state.writes.push(JSON.parse(body)); response.destroy(); return;
    }
    if (!state.lookupAvailable) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Unavailable' })); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url?.includes('/operations/') ? { result: receipt(state.writes[0].operationId, method === 'delete' ? 1 : 0) } : { window }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(new WindowWorkspaceClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/`), state); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it.each(['create', 'delete'] as const)('queries the original receipt when a committed %s response is lost', async method => {
  await withLostReply(method, true, async (client, state) => {
    const value = await client[method](window, { operationId: 'retained-operation', issuedAt: 100 });
    if (method === 'create') expect(value).toMatchObject({ window });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ operationId: 'retained-operation', issuedAt: 100 });
    expect(state.requests).toContain(`GET /v1/windows/${window.id}/operations/${state.writes[0].operationId}`);
  });
}, 10000);

it.each(['create', 'delete'] as const)('preserves the complete %s request when receipt lookup is unavailable', async method => {
  await withLostReply(method, false, async (client, state) => {
    const error = await client[method](window).catch(error => error);
    expect(error).toMatchObject({ name: 'WindowMutationUnknownError', windowId: window.id, request: state.writes[0] });
    expect(state.writes).toHaveLength(1);
    expect(state.requests).toHaveLength(2);
    state.lookupAvailable = true;
    await client[method === 'create' ? 'recoverCreate' : 'recoverDelete'](window, error.request);
    expect(state.writes).toHaveLength(1);
  });
}, 10000);
