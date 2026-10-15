import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import type { SuccessionPrepareInput } from '../../agent-remote-lab/src/directory-client.js';
import { ardbSessionDirectory } from '../web/session-operations.js';

afterEach(() => vi.unstubAllGlobals(), 5000);

test('a fresh adapter acts from retained identity without preparation or recovery storage', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const from = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
  const role = { id: 'role', revision: 9, origin: from, current: from, workspace: { controllerId: 'controller', canonicalCwd: '/workspace' } };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url!, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ role, record: { operationId: 'retained-op', roleId: 'role', expectedRevision: 3, from,
      targetProviderId: 'opencode', phase: 'ready', startedAt: 'now', updatedAt: 'now' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  let reads = 0;
  const unavailableStorage = { getItem() { reads += 1; throw new Error('Recovery storage is unavailable'); } };
  vi.stubGlobal('localStorage', unavailableStorage); vi.stubGlobal('sessionStorage', unavailableStorage);
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => nativeFetch(new URL(input, origin), init));
  const retained: SuccessionPrepareInput = { operationId: 'retained-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 3,
    targetProviderId: 'opencode', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } };
  try {
    const directory = ardbSessionDirectory({ agentId: 'agent', providerId: 'opencode', nativeSessionId: 'B', title: 'Current' });
    for (const action of ['status', 'reconcile', 'commit', 'cancel'] as const) {
      expect((await directory.actOnSuccession(action, retained)).record.operationId).toBe('retained-op');
    }
    expect(requests).toEqual(['status', 'reconcile', 'commit', 'cancel'].map(action => ({ path: `/__ardb/succession/${action}`,
      body: { operationId: 'retained-op', expectedRevision: 3 } })));
    expect(reads).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 5000);

test('preparation requires the described source and authoritative revision', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const from = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
  const role = { id: 'role', revision: 9, origin: from, current: from, workspace: { controllerId: 'controller', canonicalCwd: '/workspace' } };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url!, body: JSON.parse(body) });
    const value = request.url!.endsWith('/describe') ? { role, targets: [{ providerId: 'opencode', displayName: 'OpenCode' }], eligibility: { status: 'ready' } }
      : { role, record: { operationId: 'prepare-op', roleId: 'role', expectedRevision: 9, from, targetProviderId: 'opencode', phase: 'ready', startedAt: 'now', updatedAt: 'now' } };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => nativeFetch(new URL(input, origin), init));
  const input: SuccessionPrepareInput = { operationId: 'prepare-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 9,
    preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } };
  const directory = ardbSessionDirectory({ agentId: 'agent', providerId: 'opencode', nativeSessionId: 'A', title: 'Original' });
  try {
    await expect(directory.prepareSuccession(input)).rejects.toThrow('source changed before preparation');
    await expect(directory.describeSuccession('opencode', 'foreign', input.preparation)).rejects.toThrow('source changed');
    expect(requests).toEqual([]);
    await directory.describeSuccession('opencode', 'A', input.preparation);
    for (const changed of [{ ...input, providerId: 'codex' }, { ...input, nativeSessionId: 'foreign' }, { ...input, expectedRevision: 8 }]) {
      await expect(directory.prepareSuccession(changed)).rejects.toThrow('source changed before preparation');
    }
    expect(requests).toHaveLength(1);
    expect((await directory.prepareSuccession(input)).record.phase).toBe('ready');
    expect(requests).toEqual([
      { path: '/__ardb/succession/describe', body: { agentId: 'agent', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } } },
      { path: '/__ardb/succession/prepare', body: { operationId: 'prepare-op', roleId: 'role', expectedRevision: 9, from,
        preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } } },
    ]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 5000);
