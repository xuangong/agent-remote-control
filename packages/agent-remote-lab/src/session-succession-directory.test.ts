import { afterEach, expect, it, vi } from 'vitest';
import { SessionDirectoryClient, type SuccessionPrepareInput } from './directory-client.js';
import { labSessionSuccessionDirectory } from './session-succession-directory.js';
import { stubMemoryFetch } from './test/memory-fetch.js';

afterEach(() => vi.unstubAllGlobals());

it('encodes cancellation with the original request and leaves independent context queries available', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const from = { controllerId: 'controller', providerId: 'opencode', nativeSessionId: 'A' };
  const role = { id: 'role', revision: 8, origin: from, current: from, workspace: { controllerId: 'controller', canonicalCwd: '/workspace' } };
  stubMemoryFetch(({ path, body }) => {
    requests.push({ path, body: JSON.parse(body) });
    return { json: path.endsWith('/describe') ? { role, targets: [{ providerId: 'opencode', displayName: 'OpenCode' }], eligibility: { status: 'ready' } }
      : { role, record: { operationId: 'same-op', roleId: 'role', expectedRevision: 8, from, targetProviderId: 'opencode', phase: 'ready', startedAt: 'now', updatedAt: 'now' } } };
  });
  const retained: SuccessionPrepareInput = { operationId: 'same-op', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 8,
    targetProviderId: 'opencode', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } };
  const client = new SessionDirectoryClient('https://relay.example/u/owner/', fetch, 'my-host');
  const directory = labSessionSuccessionDirectory(client);
  await directory.describeSuccession('opencode', 'A', retained.preparation);
  await directory.prepareSuccession(retained);
  for (const action of ['commit', 'status', 'reconcile', 'cancel'] as const) await directory.actOnSuccession(action, retained);
  await client.successionAction('status', 'independent-op', { includeContext: true });
  expect(requests).toEqual([
    { path: '/u/owner/v1/remote/hosts/my-host/succession/describe', body: { providerId: 'opencode', nativeSessionId: 'A', preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } } },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/prepare', body: retained },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/commit', body: { operationId: 'same-op' } },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/status', body: { operationId: 'same-op' } },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/reconcile', body: { operationId: 'same-op' } },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/cancel', body: retained },
    { path: '/u/owner/v1/remote/hosts/my-host/succession/status', body: { operationId: 'independent-op', includeContext: true } },
  ]);
});
