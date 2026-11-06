import { expect, it } from 'vitest';
import { hostRequest, relayHostAccess, runHostRequest, type HostAccess, type HostResponse } from './host-command.js';
import { CliError } from './cli-output.js';

function access(routes: Record<string, (body?: unknown) => HostResponse>, registered: string | null = 'host-1') {
  const id = registered ?? undefined;
  const calls: string[] = [];
  const answer = (kind: string) => async (method: string, path: string, body?: unknown) => {
    calls.push(`${kind} ${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    const route = routes[`${kind} ${method} ${path}`];
    return route ? route(body) : { status: 404, data: { error: 'No such route.' } };
  };
  const value: HostAccess = { id: async () => id, host: answer('host'), relay: answer('relay'),
    describe: async () => ({ id, name: 'Mac', providers: [{ providerId: 'codex', displayName: 'Codex' }] }) };
  return { value, calls };
}

it('parses host commands, rejecting options that do not apply', () => {
  expect(hostRequest(['read', '--host', 'h'])).toEqual({ command: 'read', host: 'h' });
  expect(hostRequest(['providers', 'set', 'claude', '--enabled', 'false'])).toEqual({ command: 'providers', action: 'set', providerId: 'claude', enabled: false });
  expect(hostRequest(['workspaces', 'create', '/work', 'new'])).toEqual({ command: 'workspaces', action: 'create', parentPath: '/work', name: 'new' });
  expect(hostRequest(['tunnel', 'start', '--accept-license'])).toEqual({ command: 'tunnel', action: 'start' });
  expect(hostRequest(['stop-sessions', '--operation-id', 'stop-1']).operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(hostRequest(['stop-sessions', '--operation-id', 'stop-1']).operationId).toBe(hostRequest(['stop-sessions', '--operation-id', 'stop-1']).operationId);
  for (const args of [['tunnel', 'start'], ['list', '--host', 'h'], ['read', '--enabled', 'true'], ['providers', 'set', 'x', '--enabled', 'yes'], ['unknown']]) {
    expect(() => hostRequest(args)).toThrow(CliError);
  }
});

it('changes provider settings at the revision it read, and lists folders beside workspaces', async () => {
  const { value, calls } = access({
    'host GET provider-settings': () => ({ status: 200, data: { revision: 'r1', providers: [] } }),
    'host POST provider-settings': body => ({ status: 200, data: { revision: 'r2', changed: body } }),
    'host GET workspaces?providerId=codex': () => ({ status: 200, data: { workspaces: [{ id: 'w', name: 'w', path: '/work' }] } }),
    'host GET workspace-folders?providerId=codex&path=%2Fwork': () => ({ status: 200, data: { path: '/work', folders: [] } }),
  });
  expect(await runHostRequest({ command: 'providers', action: 'set', providerId: 'claude', enabled: false }, value))
    .toEqual({ result: { revision: 'r2', changed: { providerId: 'claude', enabled: false, revision: 'r1' } } });
  expect(await runHostRequest({ command: 'workspaces', path: '/work' }, value)).toEqual({ result: { workspaces: [{ id: 'w', name: 'w', path: '/work' }], folders: { path: '/work', folders: [] } } });
  expect(calls).toContain('host GET workspace-folders?providerId=codex&path=%2Fwork');
});

it('asks the Relay for what only it keeps, and names the Host there', async () => {
  const { value, calls } = access({
    'relay GET /v1/remote/hosts/host-1/controller-update': () => ({ status: 200, data: { state: 'idle' } }),
    'relay GET /v1/remote/controller-release': () => ({ status: 200, data: { release: { version: '0.2.76' } } }),
    'relay POST /v1/remote/hosts/host-1/previews/p1/unregister': () => ({ status: 200, data: { registration: { id: 'p1' } } }),
    'host POST stop': () => ({ status: 409, data: { code: 'operation_conflict', error: 'Used for another change.' } }),
  });
  expect(await runHostRequest({ command: 'update' }, value)).toEqual({ result: { status: { state: 'idle' }, release: { version: '0.2.76' } } });
  expect(await runHostRequest({ command: 'previews', action: 'remove', previewId: 'p1' }, value)).toEqual({ result: { registration: { id: 'p1' } } });
  expect(await runHostRequest({ command: 'stop-sessions', operationId: 'op' }, value)).toEqual({ error: { code: 'operation_conflict', message: 'Used for another change.' } });
  expect(await runHostRequest({ command: 'previews', action: 'renew', previewId: '../x' }, value)).toMatchObject({ error: { code: 'invalid_request' } });
  expect(await runHostRequest({ command: 'previews' }, access({}, null).value)).toMatchObject({ error: { code: 'host_unregistered' } });
  expect(calls).toContain('relay POST /v1/remote/hosts/host-1/previews/p1/unregister {}');
});

it('reaches another Host through the Relay with the signed-in owner', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET' });
    return Response.json(String(url).endsWith('/v1/remote/hosts') ? { hosts: [{ id: 'other', name: 'Linux', providers: [] }] } : { state: 'running' });
  }) as typeof fetch;
  const remote = relayHostAccess({ serverUrl: 'https://relay.example', basePath: '/u/alice/', cookieName: 'arc_session', token: 't'.repeat(43), expiresAt: 0 }, 'other', fetcher);
  expect(await runHostRequest({ command: 'read', host: 'other' }, remote)).toEqual({ result: { host: { id: 'other', name: 'Linux', providers: [] } } });
  expect(await runHostRequest({ command: 'tunnel', action: 'status' }, remote)).toEqual({ result: { state: 'running' } });
  expect(requests.map(request => request.url)).toEqual(['https://relay.example/u/alice/v1/remote/hosts', 'https://relay.example/u/alice/v1/remote/hosts/other/vscode-tunnel']);
  expect(await runHostRequest({ command: 'read' }, relayHostAccess({ serverUrl: 'https://relay.example', basePath: '/u/alice/', cookieName: 'arc_session', token: 't'.repeat(43), expiresAt: 0 }, 'gone', fetcher)))
    .toMatchObject({ error: { code: 'host_not_found' } });
});
