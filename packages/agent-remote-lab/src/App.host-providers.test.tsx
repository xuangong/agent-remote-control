import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { render } from './test/setup.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

async function setup(localProviders: 'ready' | 'empty' | 'error' = 'ready', discovered = false) {
  let online = true;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const tunnelRequests: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/vscode-tunnel')) {
      tunnelRequests.push(url.pathname);
      return Response.json({ status: 'stopped', processAlive: false, revision: 0 });
    }
    if (url.pathname === '/v1/providers') return Response.json(localProviders === 'error'
      ? { error: 'Local providers unavailable' }
      : { protocolVersion: '1.5.0', type: 'provider_list', payload: { providers: localProviders === 'empty' ? [] : [{ providerId: 'recorded', displayName: 'Recorded semantic Provider' }] } }, { status: localProviders === 'error' ? 503 : 200 });
    if (url.pathname.endsWith('/hosts')) return Response.json({ hosts: [
      { id: 'desk', name: 'Desk Host', online, providers: [
        { providerId: 'dsh', displayName: 'DeepSeek Harness' },
        { providerId: 'codex', displayName: 'Codex CLI' },
      ] },
      { id: 'studio', name: 'Studio Host', online: true, providers: [
        { providerId: 'codex', displayName: 'Codex CLI' },
        { providerId: 'example', displayName: 'Example Agent' },
      ] },
      { id: 'laptop', name: 'Laptop DSH', providerId: 'dsh', online: true },
    ] });
    if (url.pathname.endsWith('/workspaces')) return Response.json({ workspaces: [{ id: url.pathname.includes('/desk/') ? 'desk-workspace' : 'other-workspace', name: 'Project', path: '/project' }] });
    if (url.pathname.endsWith('/catalog')) return Response.json({ items: discovered ? [{ providerId: 'codex', nativeSessionId: 'native-codex', title: 'Existing Codex', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', state: 'idle' }] : [], hasMore: false, revision: '1' });
    if (url.pathname.endsWith('/attach')) return Response.json({ agentId: 'remote-codex-agent', nativeSessionId: 'native-codex' });
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
  return { container, provider, create, selectHost, requests, tunnelRequests, disconnect: () => { online = false; } };
}

it('routes Provider creation to each selected DSH Host and clears settings when switching back to local', async () => {
  const f = await setup();
  await f.selectHost('DeepSeek Harness · Desk Host');
  expect(f.container.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('desk');
  expect(f.container.querySelector('#session-mode')).toBeNull();
  const workspace = f.container.querySelector<HTMLSelectElement>('#session-workspace')!;
  await act(async () => { workspace.value = 'desk-workspace'; workspace.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/desk/create', body: { providerId: 'dsh', operationId: expect.any(String), workspaceId: 'desk-workspace' } });
  await f.selectHost('Laptop DSH');
  await act(async () => f.create().click());
  expect(f.requests[1]).toEqual({ path: '/v1/remote/hosts/laptop/create', body: { providerId: 'dsh', operationId: expect.any(String) } });
  await f.selectHost('Recorded');
  await act(async () => f.create().click());
  expect(f.requests[2]).toEqual({ path: '/v1/remote/create', body: { providerId: 'recorded', operationId: expect.any(String) } });
});

it('renders every Provider on a Host and preserves Codex creation options', async () => {
  const f = await setup();
  expect([...f.provider().options].map((option) => option.textContent)).toContain('Codex CLI · Desk Host · Online');
  await f.selectHost('Codex CLI · Desk Host');
  const set = async (selector: string, value: string) => act(async () => {
    const input = f.container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await set('#session-directory', '/tmp/codex-project');
  await set('#session-model', 'gpt-5.1-codex');
  await set('#session-effort', 'high');
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/desk/create', body: {
    providerId: 'codex', operationId: expect.any(String), cwd: '/tmp/codex-project', model: 'gpt-5.1-codex', reasoningEffort: 'high',
  } });
});

it('uses an advertised Provider when selecting a multi-provider Host directly', async () => {
  const f = await setup();
  await f.selectHost('Codex CLI · Desk Host');
  const connectedHost = f.container.querySelector<HTMLSelectElement>('#remote-host')!;
  await act(async () => { connectedHost.value = 'studio'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(f.provider().selectedOptions[0]?.textContent).toBe('Codex CLI · Studio Host · Online');
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/studio/create', body: { providerId: 'codex', operationId: expect.any(String) } });

  await act(async () => { connectedHost.value = 'desk'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { connectedHost.value = 'studio'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(f.provider().selectedOptions[0]?.textContent).toBe('Codex CLI · Studio Host · Online');
  expect(f.provider().value).not.toContain('dsh');
});

it('uses the remote Host descriptor when opening an existing session', async () => {
  const f = await setup('ready', true);
  await f.selectHost('Codex CLI · Desk Host');
  await act(async () => [...f.container.querySelectorAll<HTMLButtonElement>('.lab-session-row')].find((button) => button.textContent?.includes('Existing Codex'))!.click());
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Codex CLI · Desk Host');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).not.toContain('Online');
});

it('controls the selected Host tunnel while keeping another Host session open', async () => {
  const f = await setup('ready', true);
  await f.selectHost('Codex CLI · Desk Host');
  await act(async () => [...f.container.querySelectorAll<HTMLButtonElement>('.lab-session-row')].find(button => button.textContent?.includes('Existing Codex'))!.click());
  const panel = () => f.container.querySelector<HTMLElement>('[aria-label="Host VS Code tunnel"]')!;
  expect(panel().textContent).toContain('Desk Host');
  await act(async () => panel().querySelector<HTMLInputElement>('input[type=checkbox]')!.click());

  const connectedHost = f.container.querySelector<HTMLSelectElement>('#remote-host')!;
  await act(async () => { connectedHost.value = 'studio'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(panel().textContent).toContain('Studio Host');
  expect(panel().textContent).not.toContain('Desk Host');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Codex CLI · Desk Host');
  expect(panel().querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  f.tunnelRequests.length = 0;
  await act(async () => [...panel().querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click());
  expect(f.tunnelRequests).toEqual(['/v1/remote/hosts/studio/vscode-tunnel']);
  await act(async () => panel().querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => [...panel().querySelectorAll('button')].find(button => button.textContent === 'Start tunnel')!.click());
  expect(f.tunnelRequests.at(-1)).toBe('/v1/remote/hosts/studio/vscode-tunnel/start');

  await act(async () => { connectedHost.value = 'desk'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(panel().textContent).toContain('Desk Host');
  expect(panel().querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
});

it.each(['empty', 'error'] as const)('keeps remote Providers usable when the local catalog is %s', async (status) => {
  const f = await setup(status);
  await f.selectHost('DeepSeek Harness · Desk Host');
  expect(f.create().disabled).toBe(false);
  expect(f.container.textContent).not.toContain('No Provider is registered');
  await act(async () => f.create().click());
  expect(f.requests[0]?.path).toBe('/v1/remote/hosts/desk/create');
});

it('shows an offline Host without trapping the Provider selector or showing a false opening state', async () => {
  const f = await setup();
  await f.selectHost('DeepSeek Harness · Desk Host');
  f.disconnect();
  await act(async () => [...f.container.querySelectorAll('button')].find((button) => button.textContent === 'Retry Hosts')!.click());
  expect(f.create().disabled).toBe(true);
  expect(f.create().textContent).not.toContain('Opening');
  expect(f.provider().disabled).toBe(false);
  expect(f.provider().selectedOptions[0]?.textContent).toContain('Offline');
  await f.selectHost('Laptop DSH');
  expect(f.create().disabled).toBe(false);
});
