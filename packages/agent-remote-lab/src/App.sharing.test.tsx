import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { App } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function setup({ used = 0, limit = 1, outcome = 'success', empty = false, active = false }: {
  used?: number; limit?: number; outcome?: 'success' | 'quota' | 'unknown'; empty?: boolean; active?: boolean;
} = {}) {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let quota = { used, limit };
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname === '/v1/providers') return Response.json({ protocolVersion: '1.5.0', type: 'provider_list', payload: { providers: [{ providerId: 'recorded', displayName: 'Recorded Provider' }] } });
    if (url.pathname.endsWith('/hosts')) return Response.json({ hosts: empty ? [] : [
      { id: 'owner', name: 'Owner Host', online: true, managed: true, access: 'owner', providers: [{ providerId: 'codex', displayName: 'Codex CLI' }] },
      { id: 'shared', name: 'Shared Studio', online: true, managed: false, access: 'shared', sessionQuota: quota, providers: [{ providerId: 'codex', displayName: 'Codex CLI' }] },
    ] });
    if (url.pathname.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    if (url.pathname.endsWith('/catalog')) return Response.json({ items: url.pathname.includes('/shared/') ? [{ providerId: 'codex', nativeSessionId: 'existing', title: 'Existing topic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', state: 'idle' }] : [], hasMore: false, revision: '1' });
    if (url.pathname.endsWith('/attach')) return Response.json({ agentId: 'existing-agent', nativeSessionId: 'existing' });
    if (url.pathname.endsWith('/create')) {
      quota = { ...quota, used: quota.used + 1 };
      if (outcome === 'quota') return Response.json({ code: 'session_quota_exceeded', error: 'Session creation limit reached.' }, { status: 409 });
      if (outcome === 'unknown') return Response.json({ code: 'creation_outcome_unknown', error: 'Creation outcome is unknown.' }, { status: 409 });
      return Response.json({ agentId: 'created-agent', nativeSessionId: 'created-native' });
    }
    if (url.pathname.endsWith('/timeline')) return Response.json({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: url.searchParams.get('requestId'), agentId: 'existing-agent', epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } });
    return Response.json({ error: 'Session is disconnected in this test.' }, { status: 503 });
  });
  if (active) window.localStorage.setItem('agent-remote-opened:http://localhost/', JSON.stringify([{ hostId: 'shared', providerId: 'codex', nativeSessionId: 'existing', agentId: 'existing-agent', title: 'Existing topic' }]));
  const activeProps = active ? {
    directory: new SessionDirectoryClient('http://localhost/', undefined, 'shared'),
    initialState: { ...replicaState, agent: { ...replicaState.agent!, id: 'existing-agent', providerId: 'codex', runtimeInfo: { providerId: 'codex', sessionId: 'existing', status: 'idle' as const } } },
    initialSessionStatus: 'ready' as const, actions: { sendMessage: async () => undefined },
  } : {};
  const container = await render(<App baseUrl="http://localhost/" {...activeProps} />);
  const create = () => container.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!;
  const hosts = () => container.querySelector<HTMLSelectElement>('#remote-host')!;
  const selectHost = async (id: string) => act(async () => { hosts().value = id; hosts().dispatchEvent(new Event('change', { bubbles: true })); });
  const refresh = async () => act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry Hosts')!.click());
  return { container, create, hosts, selectHost, requests, refresh, setLimit: (next: number) => { quota = { ...quota, limit: next }; } };
}

async function sideCommand(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="workbench"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '/side');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

it('selects the authorized deep-linked Host before restoring a different remembered session', async () => {
  window.history.replaceState(null, '', '/?host=shared&agent=old-agent');
  window.localStorage.setItem('agent-remote-opened:http://localhost/', JSON.stringify([{ hostId: 'owner', providerId: 'codex', nativeSessionId: 'old-native', agentId: 'old-agent', title: 'Old topic' }]));
  const f = await setup();
  expect(f.hosts().value).toBe('shared');
  expect(f.container.querySelector<HTMLSelectElement>('#provider-select')?.value).toBe('["shared","codex"]');
  expect(f.requests.some(({ path }) => path.endsWith('/attach'))).toBe(false);
  await act(async () => f.create().click());
  expect(f.requests.find(({ path }) => path.endsWith('/create'))?.path).toBe('/v1/remote/hosts/shared/create');
});

it.each([false, true])('does not substitute another Host for an unknown deep link (empty directory: %s)', async (empty) => {
  window.history.replaceState(null, '', '/?host=missing');
  const f = await setup({ empty });
  expect(f.create().disabled).toBe(true);
  expect(f.hosts().value).not.toBe('owner');
  expect(f.container.textContent).toContain('Requested Host is unavailable');
  expect(f.container.querySelector<HTMLSelectElement>('#provider-select')?.value).toBe('');
});

it('keeps existing shared sessions available when cumulative creation quota is exhausted', async () => {
  window.history.replaceState(null, '', '/?host=shared');
  const f = await setup({ used: 3, limit: 2 });
  expect(f.container.textContent).toContain('Session creation allowance used: 3 / 2');
  expect(f.create().disabled).toBe(true);
  expect([...f.container.querySelectorAll('button')].some((button) => button.textContent === 'Revoke Host')).toBe(false);
  const existing = [...f.container.querySelectorAll<HTMLButtonElement>('.lab-session-row')].find((button) => button.textContent?.includes('Existing topic'))!;
  expect(existing.disabled).toBe(false);
  await act(async () => existing.click());
  expect(f.requests.find(({ path }) => path.endsWith('/attach'))?.path).toBe('/v1/remote/hosts/shared/attach');
  expect(f.requests.some(({ path }) => path.endsWith('/create'))).toBe(false);
  await f.selectHost('owner');
  expect(f.create().disabled).toBe(false);
});

it.each(['success', 'quota'] as const)('refreshes the cumulative quota after a %s create response', async (outcome) => {
  window.history.replaceState(null, '', '/?host=shared');
  const f = await setup({ outcome });
  expect(f.create().disabled).toBe(false);
  await act(async () => f.create().click());
  expect(f.container.textContent).toContain('Session creation allowance used: 1 / 1');
  expect(f.create().disabled).toBe(true);
  expect(f.hosts().disabled).toBe(false);
  if (outcome === 'quota') expect(f.container.textContent).not.toContain('Retry keeps the same session reservation');
  f.setLimit(2);
  await f.refresh();
  expect(f.create().disabled).toBe(false);
});

it('allows retrying an uncertain creation at the limit with the same reservation', async () => {
  window.history.replaceState(null, '', '/?host=shared');
  const f = await setup({ outcome: 'unknown' });
  await act(async () => f.create().click());
  expect(f.container.textContent).toContain('Session creation allowance used: 1 / 1');
  expect(f.container.textContent).toContain('Retry keeps the same session reservation');
  expect(f.create().disabled).toBe(false);
  await act(async () => f.create().click());
  const creates = f.requests.filter(({ path }) => path.endsWith('/create'));
  expect(creates).toHaveLength(2);
  expect(creates[1]?.body?.requestId).toBe(creates[0]?.body?.requestId);
});

it('checks the source Host quota for side sessions even when a different Host is selected', async () => {
  window.history.replaceState(null, '', '/?host=shared');
  const f = await setup({ active: true, used: 1 });
  await f.selectHost('owner');
  await sideCommand(f.container);
  expect(f.requests.some(({ path }) => path.endsWith('/create'))).toBe(false);
  expect(f.container.textContent).toContain('Session creation limit reached');
  expect(f.container.querySelector('[aria-label="Side conversation"]')).toBeNull();
});

it('refreshes the shared quota after creating a side conversation', async () => {
  window.history.replaceState(null, '', '/?host=shared');
  const f = await setup({ active: true });
  await sideCommand(f.container);
  expect(f.requests.filter(({ path }) => path.endsWith('/create')).map(({ path }) => path)).toEqual(['/v1/remote/hosts/shared/create']);
  expect(f.container.querySelector('[aria-label="Side conversation"]')).not.toBeNull();
  expect(f.container.textContent).toContain('Session creation allowance used: 1 / 1');
  expect(f.create().disabled).toBe(true);
});
