// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteHostClient, SessionDirectoryClient } from './directory-client.js';
import { stubMemoryFetch } from '../test/memory-fetch.js';

afterEach(() => vi.unstubAllGlobals());

it('forwards captured snapshot provenance through hosted and legacy local create requests', async () => {
  const bodies: unknown[] = [];
  stubMemoryFetch(({ body }) => { bodies.push(JSON.parse(body)); return { json: { agentId: 'new', nativeSessionId: 'created' } }; });
  const origin = 'https://relay.example';
  const creationSource = { providerId: 'codex', nativeSessionId: 'captured-source' };
  for (const hostId of ['paired-host', 'local']) {
    await new SessionDirectoryClient(origin, fetch, hostId).create('copilot', 'snapshot', { creationSource, cwd: '/workspace' });
  }
  expect(bodies).toEqual(Array(2).fill({ providerId: 'copilot', operationId: 'snapshot', creationSource, cwd: '/workspace' }));
});

it('requests fresh Controller discovery only for a manual refresh', async () => {
  const paths: string[] = [];
  stubMemoryFetch(({ path }) => { paths.push(path); return { json: { release: null } }; });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  await client.controllerRelease();
  await client.controllerRelease({ refresh: true });
  expect(paths).toEqual(['/u/tenant/v1/remote/controller-release', '/u/tenant/v1/remote/controller-release?refresh=1']);
});

it('revokes the selected Host over the user-scoped HTTP endpoint', async () => {
  const requests: Array<{ method?: string; path?: string; body: string; contentType?: string | null }> = [];
  stubMemoryFetch(({ method, path, body, headers }) => { requests.push({ method, path, body, contentType: headers.get('content-type') }); return { json: {} }; });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  await client.revoke('host/one');
  expect(requests).toEqual([{ method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/revoke', body: '{}', contentType: 'application/json' }]);
});

it('sends owner stop and rotation requests without credentials and retains fresh-auth error codes', async () => {
  const paths: string[] = [];
  stubMemoryFetch(({ method, path, body, headers }) => {
    paths.push(path);
    expect(method).toBe('POST');
    if (path.endsWith('/rotate')) expect(body).toBe('{}');
    else expect(JSON.parse(body)).toEqual({ operationId: expect.any(String) });
    expect(headers.get('authorization')).toBeNull();
    if (path.endsWith('/rotate')) return { status: 403, json: { code: 'reauthentication_required', loginUrl: 'https://untrusted.example' } };
    return { json: { results: [{ agentId: 'one', status: 'unsupported' }] } };
  });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  await expect(client.rotate('host/one')).rejects.toMatchObject({ code: 'reauthentication_required', status: 403, message: 'A recent sign-in is required.' });
  expect(await client.stop('host/one')).toEqual({ results: [{ agentId: 'one', status: 'unsupported' }] });
  expect(paths).toEqual(['/u/tenant/v1/remote/hosts/host%2Fone/rotate', '/u/tenant/v1/remote/hosts/host%2Fone/stop']);
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
  stubMemoryFetch(({ method, path, body }) => {
    requests.push({ method, path, body });
    return { json: method === 'GET' ? { pairings: [], availablePurposes: ['host-only', 'gateway-setup'] } : { ok: true } };
  });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
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
});

it('queries daemon outcomes and posts one explicit intent with no automatic replay', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  const revision = '00000000-0000-4000-8000-000000000001';
  const operationId = '00000000-0000-4000-8000-000000000002';
  let invalid = false;
  stubMemoryFetch(({ method, path, body }) => {
    requests.push({ method, path, body });
    return { json: invalid ? { phase: 'ready' } : { revision, phase: 'idle', updatedAt: 0 } };
  });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  expect((await client.codexDaemon('host/one')).phase).toBe('idle');
  invalid = true;
  await expect(client.codexDaemon('host/one', { operationId, revision })).rejects.toThrow(/could not be verified/);
  expect(requests).toEqual([
    { method: 'GET', path: '/u/tenant/v1/remote/hosts/host%2Fone/codex-daemon', body: '' },
    { method: 'POST', path: '/u/tenant/v1/remote/hosts/host%2Fone/codex-daemon', body: JSON.stringify({ operationId, revision }) },
  ]);
});

it('reads a Host status and refuses one it cannot verify', async () => {
  const requests: string[] = [];
  let body: unknown = { sampledAt: 1, sessions: { running: 1, waiting: 0, idle: 0, failed: 0 }, cpu: { cores: 4, usage: 0.5 } };
  stubMemoryFetch(({ path }) => { requests.push(path); return { json: body }; });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  expect((await client.hostStatus('host/one')).cpu).toEqual({ cores: 4, usage: 0.5 });
  body = { sampledAt: 1, sessions: { running: -1, waiting: 0, idle: 0, failed: 0 } };
  await expect(client.hostStatus('host/one')).rejects.toThrow(/could not be verified/);
  expect(requests).toEqual(['/u/tenant/v1/remote/hosts/host%2Fone/status', '/u/tenant/v1/remote/hosts/host%2Fone/status']);
});

it('exposes validated TPM Host methods through the shared control client', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  const work = { id: 'work', revision: 1, title: 'Delivery', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09', updatedAt: '2026-10-09', nextCheckAt: 0 };
  stubMemoryFetch(({ method, path, body }) => {
    requests.push({ method, path, body });
    return { json: path.endsWith('/tpm') ? { supported: true, works: [work] } : work };
  });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  expect((await client.tpmList('host')).works).toEqual([work]);
  expect(await client.tpmWork('host', 'work')).toEqual(work);
  expect(await client.tpmCreate('host', { providerId: 'codex', mainNativeSessionId: 'main', title: 'Delivery', requirement: 'Ship', operationId: 'create' })).toEqual(work);
  expect(await client.tpmAction('host', 'work', { action: 'pause', revision: 1, operationId: 'pause' })).toEqual(work);
  expect(requests.map(row => row.path)).toEqual(['/u/tenant/v1/remote/hosts/host/tpm', '/u/tenant/v1/remote/hosts/host/tpm/work?id=work', '/u/tenant/v1/remote/hosts/host/tpm/create', '/u/tenant/v1/remote/hosts/host/tpm/action']);
});

it('keeps Handoff description and all action requests scoped to one Host and operation', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  stubMemoryFetch(({ path, body }) => {
    requests.push({ path, body: JSON.parse(body) });
    const source = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
    const role = { id: 'role', revision: 8, origin: source, current: source, workspace: { controllerId: 'controller', canonicalCwd: '/workspace' } };
    return { json: path.endsWith('/describe') ? { role, targets: [{ providerId: 'opencode', displayName: 'OpenCode' }], eligibility: { status: 'ready' } }
      : { role, record: { operationId: 'same-op', roleId: 'role', expectedRevision: 8, from: source, targetProviderId: 'opencode', phase: 'ready', startedAt: 'now', updatedAt: 'now' } } };
  });
  const client = new SessionDirectoryClient('https://relay.example/u/owner/', fetch, 'my-host');
  await client.describeSuccession('opencode', 'A');
  await client.prepareSuccession({ operationId: 'same-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 8, targetProviderId: 'opencode' });
  for (const action of ['commit', 'status', 'reconcile', 'cancel'] as const) await client.successionAction(action, 'same-op');
  expect(requests.map(item => item.path)).toEqual(['describe', 'prepare', 'commit', 'status', 'reconcile', 'cancel'].map(action => `/u/owner/v1/remote/hosts/my-host/succession/${action}`));
  expect(requests[0]!.body).toEqual({ providerId: 'opencode', nativeSessionId: 'A' });
  expect(requests.slice(2).map(item => item.body)).toEqual(Array(4).fill({ operationId: 'same-op' }));
  const original = { operationId: 'same-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 8, targetProviderId: 'opencode' };
  await client.successionAction('cancel', original.operationId, { original });
  expect(requests.at(-1)).toEqual({ path: '/u/owner/v1/remote/hosts/my-host/succession/cancel', body: original });
  await expect(client.successionAction('cancel', 'replacement-op', { original })).rejects.toThrow('original Handoff identity');
  await expect(client.successionAction('commit', original.operationId, { original })).rejects.toThrow('original Handoff identity');
  expect(requests).toHaveLength(7);
});

it('exposes only the Relay origin as the install target for a tenant-scoped client', () => {
  expect(new RemoteHostClient('https://private.example:8443/u/tenant/').serverUrl).toBe('https://private.example:8443');
});

it('reads and writes the smart reading choice of a Host, sending the body of a PUT', async () => {
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  stubMemoryFetch(({ method, path, body }) => { requests.push({ method, path, body }); return { json: { providers: method === 'PUT' ? ['codex'] : [] } }; });
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  expect(await client.smartReading('host/one')).toEqual({ providers: [] });
  expect(await client.setSmartReading('host/one', 'codex', true)).toEqual({ providers: ['codex'] });
  expect(requests).toEqual([
    { method: 'GET', path: '/u/tenant/v1/remote/hosts/host%2Fone/smart-reading', body: '' },
    { method: 'PUT', path: '/u/tenant/v1/remote/hosts/host%2Fone/smart-reading', body: '{"providerId":"codex","enabled":true}' }]);
});

it('throws the refusal of smart reading with its code and status', async () => {
  stubMemoryFetch(() => ({ status: 409, json: { code: 'journals_unavailable', error: 'This Relay does not keep session journals.' } }));
  const client = new RemoteHostClient('https://relay.example/u/tenant/');
  await expect(client.setSmartReading('host', 'codex', true)).rejects.toMatchObject({ code: 'journals_unavailable', status: 409 });
});
