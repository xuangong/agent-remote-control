import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { render } from './test/setup.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

async function setup(localProviders: 'ready' | 'empty' | 'error' = 'ready') {
  let online = true;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/providers') return Response.json(localProviders === 'error'
      ? { error: 'Local providers unavailable' }
      : { protocolVersion: '1.3.0', type: 'provider_list', payload: { providers: localProviders === 'empty' ? [] : [{ providerId: 'recorded', displayName: 'Recorded semantic Provider' }] } }, { status: localProviders === 'error' ? 503 : 200 });
    if (url.pathname.endsWith('/hosts')) return Response.json({ hosts: [
      { id: 'desk', name: 'Desk DSH', providerId: 'dsh', online },
      { id: 'laptop', name: 'Laptop DSH', providerId: 'dsh', online: true },
    ] });
    if (url.pathname.endsWith('/workspaces')) return Response.json({ workspaces: [{ id: url.pathname.includes('/desk/') ? 'desk-workspace' : 'other-workspace', name: 'Project', path: '/project' }] });
    if (url.pathname.endsWith('/catalog')) return Response.json({ items: [], hasMore: false, revision: '1' });
    if (url.pathname.endsWith('/create')) {
      requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ code: 'invalid_request', error: 'Choose a workspace' }, { status: 400 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const container = await render(<App baseUrl="http://localhost/" />);
  const provider = () => container.querySelector<HTMLSelectElement>('#provider-select')!;
  const create = () => container.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!;
  const selectHost = async (name: string) => {
    const option = [...provider().options].find((item) => item.textContent?.includes(name));
    expect(option, `Provider option for ${name}`).toBeDefined();
    await act(async () => { provider().value = option!.value; provider().dispatchEvent(new Event('change', { bubbles: true })); });
  };
  return { container, provider, create, selectHost, requests, disconnect: () => { online = false; } };
}

it('routes Provider creation to each selected DSH Host and clears settings when switching back to local', async () => {
  const f = await setup();
  await f.selectHost('Desk DSH');
  expect(f.container.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('desk');
  expect(f.container.querySelector('#session-mode')).toBeNull();
  const workspace = f.container.querySelector<HTMLSelectElement>('#session-workspace')!;
  await act(async () => { workspace.value = 'desk-workspace'; workspace.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/desk/create', body: { providerId: 'dsh', requestId: expect.any(String), workspaceId: 'desk-workspace' } });
  await f.selectHost('Laptop DSH');
  await act(async () => f.create().click());
  expect(f.requests[1]).toEqual({ path: '/v1/remote/hosts/laptop/create', body: { providerId: 'dsh', requestId: expect.any(String) } });
  await f.selectHost('Recorded');
  await act(async () => f.create().click());
  expect(f.requests[2]).toEqual({ path: '/v1/remote/create', body: { providerId: 'recorded', requestId: expect.any(String) } });
});

it.each(['empty', 'error'] as const)('keeps remote Providers usable when the local catalog is %s', async (status) => {
  const f = await setup(status);
  await f.selectHost('Desk DSH');
  expect(f.create().disabled).toBe(false);
  expect(f.container.textContent).not.toContain('No Provider is registered');
  await act(async () => f.create().click());
  expect(f.requests[0]?.path).toBe('/v1/remote/hosts/desk/create');
});

it('shows an offline Host without trapping the Provider selector or showing a false opening state', async () => {
  const f = await setup();
  await f.selectHost('Desk DSH');
  f.disconnect();
  await act(async () => [...f.container.querySelectorAll('button')].find((button) => button.textContent === 'Retry Hosts')!.click());
  expect(f.create().disabled).toBe(true);
  expect(f.create().textContent).not.toContain('Opening');
  expect(f.provider().disabled).toBe(false);
  expect(f.provider().selectedOptions[0]?.textContent).toContain('Offline');
  await f.selectHost('Laptop DSH');
  expect(f.create().disabled).toBe(false);
});
