// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { WindowMutation, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, WindowWorkspaceClient, isWindowRejection } from './window-client.js';

const window: WorkspaceWindow = {
  schemaVersion: 3, id: 'window-one', revision: 0, title: 'One', selectedPrimaryViewId: 'main', selectedViewId: 'main',
  views: [{ id: 'main', placement: 'primary', width: 440, collapsed: false, display: { mode: 'preview', lettersVisible: true } }],
};
const mutation: WindowMutation = { operationId: 'rename-one', issuedAt: 100, baseRevision: 0, operation: { type: 'rename', title: 'Renamed' } };
const receipt = (operationId: string, revision = 1) => ({ operationId, revision, status: 'committed' as const, committedAt: 101, expiresAt: 1000 });

async function withWindowServer(reply: (input: { operationId: string }, url: string) => { body: unknown; status?: number }, run: (client: WindowWorkspaceClient) => Promise<void>) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    const next = reply(body ? JSON.parse(body) : {}, request.url ?? '');
    response.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(next.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(new WindowWorkspaceClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/u/account/`)); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

type Method = 'create' | 'mutate' | 'delete';
const invoke = (client: WindowWorkspaceClient, method: Method) => method === 'mutate' ? client.mutate(window.id, mutation) : client[method](window);
it('decodes explicit history intent from the HTTP Window snapshot', async () => {
  const binding = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'past', title: 'Past', sessionIntent: 'history' as const };
  const snapshot = { ...window, views: [{ ...window.views[0]!, binding }] };
  await withWindowServer(() => ({ body: { window: snapshot } }), async client => {
    expect((await client.inspect(window.id)).window.views[0]?.binding).toEqual(binding);
  });
}, 10000);
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
it('decodes legacy server snapshots without altering the original creation request used for receipt recovery', async () => {
  const { selectedPrimaryViewId, ...base } = window;
  const legacy = { ...base, schemaVersion: 1, primaryViewId: selectedPrimaryViewId, mainMinimized: false };
  await withWindowServer(() => ({ body: { window: legacy } }), async client => {
    const snapshot = await client.inspect(window.id);
    expect(snapshot.window).toMatchObject({ schemaVersion: 3, id: window.id, revision: 0, selectedPrimaryViewId });
    expect(snapshot.window.views).toEqual(window.views);
    expect(legacy.schemaVersion).toBe(1);
  });
}, 10000);
it('keeps a legacy creation replay payload unchanged while decoding its current snapshot', async () => {
  const { selectedPrimaryViewId, ...base } = window;
  const legacy = { ...base, schemaVersion: 1, primaryViewId: selectedPrimaryViewId, mainMinimized: false };
  const operation = { operationId: 'legacy-create', issuedAt: 100 };
  await withWindowServer(input => {
    expect(input).toEqual({ ...operation, window: legacy });
    return { body: { result: receipt(operation.operationId, 0), window: { ...window, revision: 2 } } };
  }, async client => {
    const snapshot = await client.create(legacy as unknown as WorkspaceWindow, operation);
    expect(snapshot.window).toMatchObject({ schemaVersion: 3, id: window.id, revision: 2 });
  });
}, 10000);

it('accepts an empty Window in a committed close result, inspection and listing over HTTP', async () => {
  const empty = { ...window, revision: 1, views: [], selectedViewId: null, selectedPrimaryViewId: null };
  await withWindowServer(input => ({ body: { window: empty, windows: [empty], ...(input.operationId ? { result: receipt(input.operationId) } : {}) } }), async client => {
    const closed = await client.mutate(window.id, { ...mutation, operation: { type: 'view.close', viewId: 'main' } });
    expect(closed.window).toEqual(empty);
    expect((await client.inspect(window.id)).window).toEqual(empty);
    expect(await client.list()).toEqual([empty]);
  });
}, 10000);

it('creates an explicitly empty Window and migrates valid v2 server snapshots to v3', async () => {
  const empty = { ...window, views: [], selectedViewId: null, selectedPrimaryViewId: null };
  await withWindowServer(input => ({ body: { result: receipt(input.operationId, 0), window: empty } }), async client => {
    expect((await client.create(empty)).window).toEqual(empty);
  });
  await withWindowServer(() => ({ body: { window: { ...window, schemaVersion: 2 } } }), async client => {
    expect((await client.inspect(window.id)).window).toEqual(window);
  });
}, 10000);

it('lists groups with their appearances, and Windows as groups from an older Relay', async () => {
  const bots = { rank: 'm', members: {} };
  await withWindowServer(() => ({ body: { windows: [], groups: [{ window, bots, presentation: { window: false } }] } }), async client => {
    expect(await client.listGroups()).toEqual([{ window, bots, presentation: { window: false } }]);
  });
  await withWindowServer(() => ({ body: { windows: [window] } }), async client => {
    expect(await client.listGroups()).toEqual([{ window }]);
  });
  await withWindowServer(() => ({ body: { groups: [{ window, presentation: { window: false } }] } }), async client => {
    await expect(client.listGroups()).rejects.toThrow('Invalid Window list.');
  });
});

it('returns and checks the section of a snapshot', async () => {
  const bots = { rank: 'm', members: {} };
  await withWindowServer(() => ({ body: { window, bots } }), async client => {
    expect(await client.inspect(window.id)).toEqual({ window, bots });
  });
  await withWindowServer(() => ({ body: { window, bots: { rank: 'm', members: { main: { label: 'Not a bot' } } } } }), async client => {
    await expect(client.inspect(window.id)).rejects.toThrow('Invalid Window snapshot.');
  });
});

it('creates a group with its appearances', async () => {
  const bots = { rank: 'm', members: {} };
  let sent: unknown;
  await withWindowServer(input => { sent = input; return { body: { result: receipt(input.operationId, 0), window, bots, presentation: { window: false } } }; }, async client => {
    expect(await client.createGroup({ window, bots, presentation: { window: false } }, { operationId: 'create-section', issuedAt: 100 }))
      .toMatchObject({ window, bots, presentation: { window: false } });
  });
  expect(sent).toEqual({ operationId: 'create-section', issuedAt: 100, window, bots, presentation: { window: false } });
});

it('sends merges, splits and transfers to their group and returns the groups they changed', async () => {
  const urls: string[] = [];
  const section = { window: { ...window, revision: 1 }, bots: { rank: 'm', members: {} } };
  await withWindowServer((input, url) => { urls.push(url); return { body: { result: receipt(input.operationId), groups: { 'window-one': section, other: null } } }; }, async client => {
    expect(await client.merge('window-one', { operationId: 'merge', issuedAt: 100, baseRevision: 0, source: 'other', sourceRevision: 0 }))
      .toEqual({ result: receipt('merge'), groups: { 'window-one': section, other: null } });
    await client.split('window-one', { operationId: 'split', issuedAt: 100, baseRevision: 1, newId: 'other' });
    await client.transfer('window-one', { operationId: 'transfer', issuedAt: 100, baseRevision: 1, viewId: 'main', target: 'other', targetRevision: 0 });
  });
  expect(urls).toEqual(['/u/account/v1/windows/window-one/merge', '/u/account/v1/windows/window-one/split', '/u/account/v1/windows/window-one/transfer']);
  await withWindowServer(input => ({ body: { result: { ...receipt(input.operationId), status: 'rejected', code: 'bot_session_taken', message: 'This session is already a bot in "Release".' }, groups: {} } }), async client => {
    await expect(client.merge('window-one', { operationId: 'merge', issuedAt: 100, baseRevision: 0, source: 'other', sourceRevision: 0 }))
      .rejects.toMatchObject({ code: 'bot_session_taken', message: 'This session is already a bot in "Release".' });
  });
});

type Action = 'merge' | 'split' | 'transfer';
it('accepts only the groups a committed cross-group result names', async () => {
  const section = { window: { ...window, revision: 1 }, bots: { rank: 'm', members: {} } };
  const other = { window: { ...window, id: 'other', revision: 1 } };
  const requests: Record<Action, (client: WindowWorkspaceClient) => Promise<{ groups: unknown }>> = {
    merge: client => client.merge('window-one', { operationId: 'op', issuedAt: 100, baseRevision: 0, source: 'other', sourceRevision: 0 }),
    split: client => client.split('window-one', { operationId: 'op', issuedAt: 100, baseRevision: 1, newId: 'other' }),
    transfer: client => client.transfer('window-one', { operationId: 'op', issuedAt: 100, baseRevision: 1, viewId: 'main', target: 'other', targetRevision: 0 }),
  };
  // `only` limits a case to the actions for which it is the fault; a merge, for one, must answer its source as null.
  const bad: Record<string, { groups: unknown; revision?: number; only?: Action[] }> = {
    'groups missing': { groups: undefined },
    'groups null': { groups: null },
    'groups a string': { groups: 'window-one' },
    'an array': { groups: [] },
    'an empty object': { groups: {} },
    'an array of nulls': { groups: [null, null] },
    'unrelated keys': { groups: { unrelated: null } },
    'no entry for the group it was sent to': { groups: { other: null } },
    'no entry for the other group': { groups: { 'window-one': section } },
    'an extra key': { groups: { 'window-one': section, other: null, victim: null } },
    'a group under another Window id on the group it was sent to': { groups: { 'window-one': { ...section, window: { ...section.window, id: 'another' } }, other: null } },
    'a group under another Window id on the other group': { groups: { 'window-one': section, other: section }, only: ['split', 'transfer'] },
    'a group that is not a group': { groups: { 'window-one': { window: { id: 'window-one' } }, other: null } },
    'a revision the group has not reached': { groups: { 'window-one': section, other: null }, revision: 2 },
    'a merge source that is a group instead of null': { groups: { 'window-one': section, other }, only: ['merge'] },
  };
  for (const [name, { groups, revision, only }] of Object.entries(bad)) {
    for (const action of (only ?? ['merge', 'split', 'transfer']) as Action[]) {
      await withWindowServer(input => ({ body: { result: receipt(input.operationId, revision), groups } }), async client => {
        await expect(requests[action](client), `${action} with ${name}`).rejects.toMatchObject({ name: 'WindowRequestError', code: 'invalid_window_receipt', message: 'Invalid Window groups.' });
      });
    }
  }
  const good: Record<string, { groups: unknown; revision?: number; only?: Action[] }> = {
    // A retained receipt may describe an earlier revision than the group holds now.
    'a receipt for an earlier revision': { groups: { 'window-one': section, other: null }, revision: 0 },
    // A replay can reach a target that was deleted later.
    'both groups null': { groups: { 'window-one': null, other: null } },
    'a second group that a split or transfer keeps': { groups: { 'window-one': section, other }, only: ['split', 'transfer'] },
  };
  for (const [name, { groups, revision, only }] of Object.entries(good)) {
    for (const action of (only ?? ['merge', 'split', 'transfer']) as Action[]) {
      await withWindowServer(input => ({ body: { result: receipt(input.operationId, revision), groups } }), async client => {
        expect((await requests[action](client)).groups, `${action} with ${name}`).toEqual(groups);
      });
    }
  }
});

it('tells a refusal from other failures with isWindowRejection', () => {
  const rejected = { ...receipt('op', 0), status: 'rejected' as const, code: 'stale_revision', message: 'Stale.' };
  expect(isWindowRejection(new WindowRequestError('Stale.', 200, 'stale_revision', rejected))).toBe(true);
  expect(isWindowRejection(new WindowRequestError('Not found.', 404, 'window_not_found'))).toBe(true);
  expect(isWindowRejection(new WindowRequestError('Failed.', 500))).toBe(false);
  expect(isWindowRejection(new WindowRequestError('Invalid Window groups.', 200, 'invalid_window_receipt'))).toBe(false);
  expect(isWindowRejection(new Error('Network down.'))).toBe(false);
});
