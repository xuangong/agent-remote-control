import { createHash } from 'node:crypto';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostedRelay } from './gateway.js';
import { hostedAuthNamespace } from './hosted-auth.js';
import { emptyRelayState } from './state.js';

const auth = { provider: 'google' as const, origin: 'https://relay.example', secret: 'window-wait-test-secret-01234567890123456789',
  google: { clientId: 'window-client', clientSecret: 'window-secret', allowedEmails: ['alice@example.com'] } };
afterEach(() => vi.useRealTimers());

it.each([
  { access: 'manager', configured: undefined, expectedWaitMs: 25000 },
  { access: 'browser', configured: undefined, expectedWaitMs: 25000 },
  { access: 'manager', configured: 10, expectedWaitMs: 10 },
  { access: 'browser', configured: 10, expectedWaitMs: 10 },
  { access: 'manager', configured: 1, expectedWaitMs: 1 },
  { access: 'browser', configured: 25000, expectedWaitMs: 25000 },
])('returns unchanged Window state after $expectedWaitMs ms for $access access (configured: $configured)', async ({ access, configured, expectedWaitMs }) => {
  const managerToken = 'm'.repeat(43), browserToken = 'b'.repeat(43);
  const initial = emptyRelayState(auth);
  const namespace = hostedAuthNamespace(auth, 'alice');
  const document: WorkspaceWindow = { schemaVersion: 2, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: 'primary', selectedViewId: 'primary', views: [createWindowView('primary', undefined, 'primary')] };
  initial.workspaceWindows = [{ subject: 'alice', id: 'window', window: document, generation: 1, receipts: [], manager: {
    session: { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Manager' }, generation: 1,
    hash: createHash('sha256').update(managerToken).digest('hex'),
  } }];
  const expiresAt = Date.now() + 3_600_000;
  initial.googleIdentities = [{ subject: 'alice', email: 'alice@example.com' }];
  initial.sessions = [{ hash: createHash('sha256').update(browserToken).digest('hex'), lastSeenAt: Date.now(), sessionExpiresAt: expiresAt,
    grant: { provider: 'google', subject: 'alice', namespace, expiresAt, sessionExpiresAt: expiresAt, authenticatedAt: Date.now() } }];
  const relay = createHostedRelay({ ...auth, windowChangesWaitMs: configured,
    storage: { initial, async commit() {} }, scheduler: { schedule() {}, cancel() {} } });
  const path = access === 'manager' ? '/v1/windows/window/changes?afterRevision=0' : `/u/${namespace}/v1/windows/window/changes?afterRevision=0`;
  const headers = access === 'manager' ? { authorization: `Bearer ${managerToken}` } : { cookie: `__Host-arc_session=${browserToken}` };
  let response: Response | undefined;
  let pending: Promise<Response | undefined> | undefined;
  try {
    const opened = await relay.fetch(new Request(auth.origin + path.replace('/changes?afterRevision=0', ''), { headers }));
    expect(opened?.status).toBe(200);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pending = relay.fetch(new Request(auth.origin + path, { headers })).then(value => { response = value; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(expectedWaitMs - 1);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ window: { id: 'window', revision: 0 } });
  } finally { await relay.close(); await pending; }
}, 10000);

it.each([0, -1, 25001, null, NaN, Infinity, 1.5, '10'])('rejects invalid Window change wait %j before starting the Relay', async windowChangesWaitMs => {
  let relay: ReturnType<typeof createHostedRelay> | undefined;
  try {
    expect(() => { relay = createHostedRelay({ ...auth, windowChangesWaitMs: windowChangesWaitMs as number,
      scheduler: { schedule() {}, cancel() {} } }); }).toThrow(/window.*wait/i);
  } finally { await relay?.close(); }
}, 10000);
