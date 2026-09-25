import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostProvider } from './components/HostPairing.js';
import { App } from './App.js';
import { render } from './test/setup.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

async function setup(localProviders: 'ready' | 'empty' | 'error' = 'ready', discovered = false) {
  let online = true;
  let deskProviders: HostProvider[] = [{ providerId: 'dsh', displayName: 'DeepSeek Harness' }, { providerId: 'codex', displayName: 'Codex CLI' }];
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
      { id: 'desk', name: 'Desk Host', online, providerId: 'dsh', providers: deskProviders },
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
  const browse = () => container.querySelector<HTMLSelectElement>('[aria-label="Browse provider"]')!;
  const selectProvider = async (id: string) => act(async () => {
    browse().value = JSON.stringify([container.querySelector<HTMLSelectElement>('#remote-host')!.value, id]);
    browse().dispatchEvent(new Event('change', { bubbles: true }));
  });
  const selectHost = async (id: string) => act(async () => {
    const hosts = container.querySelector<HTMLSelectElement>('#remote-host')!;
    hosts.value = id;
    hosts.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const refresh = async () => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry Hosts')!.click());
  return { container, provider, browse, create, selectHost, selectProvider, refresh, requests, tunnelRequests, disconnect: () => { online = false; }, setProviders: (providers: HostProvider[]) => { deskProviders = providers; } };
}

it('routes Provider creation to each selected DSH Host and clears settings when switching back to local', async () => {
  const f = await setup();
  await f.selectHost('desk');
  expect(f.container.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('desk');
  expect(f.container.querySelector('#session-mode')).toBeNull();
  const workspace = f.container.querySelector<HTMLSelectElement>('#session-workspace')!;
  await act(async () => { workspace.value = 'desk-workspace'; workspace.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/desk/create', body: { providerId: 'dsh', operationId: expect.any(String), workspaceId: 'desk-workspace' } });
  await f.selectHost('laptop');
  await act(async () => f.create().click());
  expect(f.requests[1]).toEqual({ path: '/v1/remote/hosts/laptop/create', body: { providerId: 'dsh', operationId: expect.any(String) } });
  await f.selectHost('local');
  await act(async () => f.create().click());
  expect(f.requests[2]).toEqual({ path: '/v1/remote/create', body: { providerId: 'recorded', operationId: expect.any(String) } });
});

it('renders every Provider on a Host and preserves Codex creation options', async () => {
  const f = await setup();
  await f.selectHost('desk');
  await f.selectProvider('codex');
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
  await f.selectHost('desk');
  await f.selectProvider('codex');
  const connectedHost = f.container.querySelector<HTMLSelectElement>('#remote-host')!;
  await act(async () => { connectedHost.value = 'studio'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(f.provider().selectedOptions[0]?.textContent).toBe('Codex CLI');
  await act(async () => f.create().click());
  expect(f.requests[0]).toEqual({ path: '/v1/remote/hosts/studio/create', body: { providerId: 'codex', operationId: expect.any(String) } });

  await act(async () => { connectedHost.value = 'desk'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { connectedHost.value = 'studio'; connectedHost.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(f.provider().selectedOptions[0]?.textContent).toBe('Codex CLI');
  expect(f.provider().value).not.toContain('dsh');
});

it('uses the remote Host descriptor when opening an existing session', async () => {
  const f = await setup('ready', true);
  await f.selectHost('desk');
  await f.selectProvider('codex');
  await act(async () => [...f.container.querySelectorAll<HTMLButtonElement>('.lab-session-row')].find((button) => button.textContent?.includes('Existing Codex'))!.click());
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Codex CLI · Desk Host');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).not.toContain('Online');
});

it('controls the selected Host tunnel while keeping another Host session open', async () => {
  const f = await setup('ready', true);
  await f.selectHost('desk');
  await f.selectProvider('codex');
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
  await f.selectHost('desk');
  expect(f.create().disabled).toBe(false);
  expect(f.container.textContent).not.toContain('No Provider is registered');
  await act(async () => f.create().click());
  expect(f.requests[0]?.path).toBe('/v1/remote/hosts/desk/create');
});

it('shows an offline Host without trapping the Provider selector or showing a false opening state', async () => {
  const f = await setup();
  await f.selectHost('desk');
  f.disconnect();
  await act(async () => [...f.container.querySelectorAll('button')].find((button) => button.textContent === 'Retry Hosts')!.click());
  expect(f.create().disabled).toBe(true);
  expect(f.create().textContent).not.toContain('Opening');
  expect(f.provider().disabled).toBe(false);
  expect(f.provider().selectedOptions[0]?.textContent).toBe('DeepSeek Harness');
  expect(f.container.querySelector<HTMLSelectElement>('#remote-host')?.selectedOptions[0]?.textContent).toContain('Offline');
  await f.selectHost('laptop');
  expect(f.create().disabled).toBe(false);
});

it.each([false, true])('scopes browse and creation choices to the selected Host (compact: %s)', async (compact) => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: compact && query === '(max-width: 1180px)', media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }));
  const f = await setup();
  await f.selectHost('desk');
  const names = (select: HTMLSelectElement) => [...select.options].map(option => option.textContent);
  expect(names(f.browse())).toEqual(['DeepSeek Harness', 'Codex CLI']);
  expect(names(f.provider())).toEqual(names(f.browse()));
  await f.selectHost('studio');
  expect(names(f.browse())).toEqual(['Codex CLI', 'Example Agent']);
  expect(f.browse().value).toBe('["studio","codex"]');
  await f.selectProvider('example');
  await f.selectHost('desk');
  expect(f.browse().value).toBe('["desk","dsh"]');
  await f.selectProvider('codex');
  await f.selectHost('studio');
  await f.selectHost('desk');
  expect(f.browse().value).toBe('["desk","codex"]');
});

it('reconciles discovered Providers without switching Hosts or retaining a disabled Provider', async () => {
  const f = await setup();
  await f.selectHost('desk');
  await f.selectProvider('codex');
  f.setProviders([{ providerId: 'dsh', displayName: 'DeepSeek Harness' }]);
  await f.refresh();
  expect(f.browse().value).toBe('["desk","dsh"]');
  f.setProviders([]);
  await f.refresh();
  expect(f.browse().disabled).toBe(true);
  expect(f.browse().textContent).toContain('No providers available');
  expect(f.provider().value).toBe('');
  expect(f.create().disabled).toBe(true);
  expect(f.container.querySelector<HTMLSelectElement>('#remote-host')?.value).toBe('desk');
  f.setProviders([{ providerId: 'codex', displayName: 'Codex CLI' }]);
  await f.refresh();
  expect(f.browse().value).toBe('["desk","codex"]');
  expect(f.create().disabled).toBe(false);
});
