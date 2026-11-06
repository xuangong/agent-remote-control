import { expect, it } from 'vitest';
import type { CommandChannel } from './cli-client.js';
import { handoffSession, namedSession, starSession } from './session-relay.js';

const credentials = { serverUrl: 'https://relay.example', basePath: '/u/alice/', cookieName: 'arc_session', token: 't'.repeat(43), expiresAt: 0 };
const ref = (nativeSessionId: string, providerId = 'codex') => ({ controllerId: 'installation', providerId, nativeSessionId });
const role = { id: 'role', revision: 4, origin: ref('old'), current: ref('old'), workspace: { controllerId: 'installation', canonicalCwd: '/work' } };
const request = { operationId: 'op', roleId: 'role', expectedRevision: 4, from: ref('old') };
const record = (phase: string, extra: Record<string, unknown> = {}) => ({ ...request, phase, startedAt: 'a', updatedAt: 'b', ...extra });

function relay(answers: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/u/alice', '');
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers[path]?.shift() ?? { status: 404, body: { error: 'missing' } };
    return Response.json(next.body, { status: next.status });
  }) as typeof fetch;
  return { calls, fetcher };
}
const session = { address: 'host-1/codex/old', hostId: 'host-1', providerId: 'codex', nativeSessionId: 'old', title: 'Old', cwd: '/work' };

it('resolves self and local addresses to the address the Relay knows', async () => {
  const channel: CommandChannel = { caller: 'session', call: async (_scope, value) => value.target === 'self'
    ? { result: { session: { address: 'host-1/codex/old', title: 'Old', cwd: '/work' } } }
    : { result: { session: { address: 'local/codex/new' } } } };
  expect(await namedSession(channel, 'self')).toEqual(session);
  await expect(namedSession(channel, 'local/codex/new')).rejects.toMatchObject({ code: 'host_unregistered' });
});

it('stars and unstars a session among the signed-in user\'s favorites', async () => {
  const { calls, fetcher } = relay({ '/v1/stars': [{ status: 200, body: { stars: [] } }, { status: 200, body: { stars: [] } }] });
  expect(await starSession(session, true, credentials, fetcher)).toEqual({ starred: true });
  expect(await starSession(session, false, credentials, fetcher)).toEqual({ starred: false });
  expect(calls).toEqual([
    { path: '/v1/stars', method: 'POST', body: { hostId: 'host-1', providerId: 'codex', nativeSessionId: 'old', title: 'Old', workspace: '/work' } },
    { path: '/v1/stars', method: 'DELETE', body: { hostId: 'host-1', providerId: 'codex', nativeSessionId: 'old' } },
  ]);
  await expect(starSession(session, true, undefined, fetcher)).rejects.toMatchObject({ code: 'signed_out' });
});

it('prepares a handoff, waits until it is ready, commits it, and continues the same operation later', async () => {
  const base = '/v1/remote/hosts/host-1/succession';
  const { calls, fetcher } = relay({
    [`${base}/status`]: [{ status: 404, body: { code: 'succession_not_found', error: 'No frozen succession operation exists.' } },
      { status: 200, body: { record: record('ready'), role } }],
    [`${base}/describe`]: [{ status: 200, body: { role, targets: [{ providerId: 'codex', displayName: 'Codex' }], eligibility: { status: 'ready' } } }],
    [`${base}/prepare`]: [{ status: 200, body: { record: record('transferring'), role } }],
    [`${base}/commit`]: [{ status: 200, body: { record: record('committed', { to: ref('new') }), role: { ...role, revision: 5, current: ref('new') },
      locator: { hostId: 'host-1', providerId: 'codex', nativeSessionId: 'new' } } }],
  });
  const slept: number[] = [];
  expect(await handoffSession(session, { operationId: 'op' }, credentials, fetcher, async ms => { slept.push(ms); }))
    .toEqual({ operationId: 'op', phase: 'committed', session: { address: 'host-1/codex/new' }, from: { address: 'host-1/codex/old' } });
  expect(calls.map(call => call.path.split('/').at(-1))).toEqual(['status', 'describe', 'prepare', 'status', 'commit']);
  expect(calls[2]!.body).toEqual({ operationId: 'op', providerId: 'codex', nativeSessionId: 'old', expectedRevision: 4, targetProviderId: 'codex' });
  expect(slept).toEqual([1000]);
});

it('reports a handoff that cannot start, and one that has not settled', async () => {
  const base = '/v1/remote/hosts/host-1/succession';
  const blocked = relay({
    [`${base}/status`]: [{ status: 404, body: { code: 'succession_not_found' } }],
    [`${base}/describe`]: [{ status: 200, body: { role, targets: [], eligibility: { status: 'blocked', code: 'session_running', reason: 'Wait for the turn to end.' } } }],
  });
  await expect(handoffSession(session, { operationId: 'op' }, credentials, blocked.fetcher, async () => {})).rejects.toMatchObject({ code: 'session_running' });
  const unknown = relay({ [`${base}/status`]: [{ status: 200, body: { record: record('unknown'), role } }] });
  await expect(handoffSession(session, { operationId: 'op' }, credentials, unknown.fetcher, async () => {})).rejects.toMatchObject({ code: 'outcome_unknown', detail: { operationId: 'op' } });
});
