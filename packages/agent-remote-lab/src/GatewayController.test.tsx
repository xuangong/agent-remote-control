import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from './test/setup.js';
import { GatewayController } from './GatewayController.js';
import { rememberWorkspaceAccess, forgetWorkspaceAccess } from './workspace-access.js';
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('offers gateway login without loading private controllers when the grant is missing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Sign in' }, { status: 401 })));
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login');
  expect(view.textContent).not.toContain('Private controller');
});
it('keeps the user-scoped controller mounted while renewing an expired grant', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000 })));
  const view = await render(<GatewayController>{baseUrl => <p>{baseUrl}</p>}</GatewayController>);
  expect(view.textContent).toContain(window.location.origin + '/u/' + 'a'.repeat(64) + '/');
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(view.textContent).toContain(window.location.origin + '/u/' + 'a'.repeat(64) + '/');
});

it('renews access while retaining the mounted private controller', async () => {
  vi.useFakeTimers();
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Response.json({ basePath, expiresAt: Date.now() + 5000, refreshAfterMs: 1000 });
  });
  function PrivateController() {
    const [sideOpen, setSideOpen] = useState(false);
    return <><input aria-label="Draft" defaultValue="initial" /><button onClick={() => setSideOpen(true)}>Open side conversation</button>{sideOpen ? <aside>Side conversation</aside> : null}</>;
  }
  const view = await render(<GatewayController>{() => <PrivateController />}</GatewayController>);
  await act(async () => { [...view.querySelectorAll('button')].find(button => button.textContent === 'Open side conversation')!.click(); });
  const side = view.querySelector('aside');
  const input = view.querySelector('input')!;
  input.value = 'unsent draft';
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(view.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsent draft');
  expect(view.querySelector('aside')).toBe(side);
  expect(requests.some(({ url, init }) => url === '/auth/refresh' && init?.method === 'POST' && init.body === '{}')).toBe(true);
});

it('retains the visible workspace and retries after temporary renewal failures', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/auth/status') return Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000, refreshAfterMs: 1000 });
    attempts++;
    return Response.json({}, { status: 503 });
  });
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(view.textContent).toContain('Private controller');
  expect(attempts).toBeGreaterThan(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
  expect(view.textContent).toContain('Private controller');
  const expiredAttempts = attempts;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(attempts).toBeGreaterThan(expiredAttempts);
});

it('clears private UI immediately when refresh is denied', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/status'
    ? Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000, refreshAfterMs: 1000 })
    : Response.json({}, { status: 403 }));
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(view.textContent).not.toContain('Private controller');
});

it('logs out through the relay and removes the private controller', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000 });
  });
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  const logout = [...view.querySelectorAll('button')].find(button => button.textContent === 'Sign out');
  expect(logout).toBeDefined();
  await act(async () => logout!.click());
  expect(requests).toContain('/auth/logout');
  expect(view.textContent).not.toContain('Private controller');
});

it('ignores timed-out renewal responses without removing the workspace', async () => {
  vi.useFakeTimers();
  let completeRefresh!: (response: Response) => void;
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/status'
    ? Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000, refreshAfterMs: 1000 })
    : new Promise<Response>(resolve => { completeRefresh = resolve; }));
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  await act(async () => { await vi.advanceTimersByTimeAsync(13001); });
  expect(view.textContent).toContain('Private controller');
  await act(async () => { completeRefresh(Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000, refreshAfterMs: 1000 })); });
  expect(view.textContent).toContain('Private controller');
});

it('preserves visible access after a long freeze and restores the same draft and side state after authoritative renewal', async () => {
  vi.useFakeTimers();
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  let completeRefresh!: (response: Response) => void;
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/status'
    ? Response.json({ basePath, expiresAt: Date.now() + 120000, refreshAfterMs: 60000 })
    : new Promise<Response>(resolve => { completeRefresh = resolve; }));
  function PrivateController() {
    const [sideOpen, setSideOpen] = useState(false);
    return <><input aria-label="Draft" defaultValue="initial" /><button onClick={() => setSideOpen(true)}>Open side</button>{sideOpen ? <aside>Side conversation</aside> : null}</>;
  }
  const view = await render(<GatewayController>{() => <PrivateController />}</GatewayController>);
  await act(async () => { [...view.querySelectorAll('button')].find(button => button.textContent === 'Open side')!.click(); });
  const input = view.querySelector('input')!;
  const side = view.querySelector('aside')!;
  input.value = 'unsent draft';
  vi.setSystemTime(Date.now() + 180000);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(view.querySelector('input')).toBe(input);
  expect(input.closest('[hidden], [inert]')).toBeNull();
  expect(view.textContent).not.toContain('Opening your workspace');
  await act(async () => { completeRefresh(Response.json({ basePath, expiresAt: Date.now() + 120000, refreshAfterMs: 60000 })); });
  expect(view.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsent draft');
  expect(view.querySelector('aside')).toBe(side);
  expect(input.closest('[hidden], [inert]')).toBeNull();
});

it('keeps the editor usable during in-flight renewal at lease expiry', async () => {
  vi.useFakeTimers();
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  let completeRefresh!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/auth/status') return Response.json({ basePath, expiresAt: Date.now() + 5000, refreshAfterMs: 1000 });
    signal = init?.signal;
    return new Promise<Response>(resolve => { completeRefresh = resolve; });
  });
  const view = await render(<GatewayController>{() => <input aria-label="Draft" defaultValue="unsent" />}</GatewayController>);
  const input = view.querySelector('input')!;
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(signal?.aborted).toBe(false);
  expect(input.closest('[hidden], [inert]')).toBeNull();
  await act(async () => { completeRefresh(Response.json({ basePath, expiresAt: Date.now() + 5000, refreshAfterMs: 1000 })); });
  expect(view.querySelector('input')).toBe(input);
  expect(input.closest('[hidden], [inert]')).toBeNull();
});

it('clears the paused private controller if authoritative recovery is denied', async () => {
  vi.useFakeTimers();
  let completeRefresh!: (response: Response) => void;
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/status'
    ? Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 5000, refreshAfterMs: 1000 })
    : new Promise<Response>(resolve => { completeRefresh = resolve; }));
  const view = await render(<GatewayController>{() => <input aria-label="Draft" />}</GatewayController>);
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(view.querySelector('input')?.closest('[hidden], [inert]')).toBeNull();
  await act(async () => { completeRefresh(Response.json({}, { status: 403 })); });
  expect(view.querySelector('input')).toBeNull();
  expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login');
});


it('keeps a cross-device session target on the login link', async () => {
  window.history.replaceState(null, '', '/?host=desk&agent=live&provider=claude&session=native&parent=root');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })));
  try {
    const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
    expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login?host=desk&agent=live&provider=claude&session=native&parent=root');
  } finally { window.history.replaceState(null, '', '/'); }
});

it('offers a bounded retry when the initial access check hangs and ignores its late response', async () => {
  vi.useFakeTimers();
  let finishFirst!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishFirst = resolve; }))
    .mockResolvedValue(Response.json({}, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  expect(view.querySelector('[role="status"]')?.textContent).toBe('Checking access…');
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  expect(view.querySelector('h1')?.textContent).toBe('Connection interrupted');
  await act(async () => view.querySelector<HTMLButtonElement>('.arc-access-action')!.click());
  expect(view.querySelector('h1')?.textContent).toBe('Sign in to continue');
  await act(async () => finishFirst(Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000 })));
  expect(view.textContent).not.toContain('Private controller');
});

it('preserves only the session return path for a restarted sign-in', async () => {
  window.history.replaceState(null, '', '/?host=desk&provider=claude&session=native&token=private');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })));
  const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  const link = view.querySelector<HTMLAnchorElement>('.arc-access-action')!;
  link.addEventListener('click', event => event.preventDefault());
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(sessionStorage.getItem('agent-remote-sign-in-return')).toBe('/?host=desk&provider=claude&session=native');
  sessionStorage.removeItem('agent-remote-sign-in-return');
});

it('manages browser sessions without unmounting drafts and clears private state after revoking this browser', async () => {
  const requests: Array<{ url: string; body?: BodyInit | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body });
    if (url === '/auth/status') return Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000 });
    if (url === '/auth/sessions') return Response.json({ sessions: [{ id: 'this-browser', label: 'Chrome on Mac', createdAt: 1000, lastSeenAt: 2000, expiresAt: Date.now() + 3600000, current: true }], authenticatedAt: 1000, recentAuthentication: false });
    if (url === '/auth/audit') return Response.json({ events: [] });
    return Response.json({ ok: true, current: true });
  });
  const view = await render(<GatewayController>{() => <input aria-label="Draft" defaultValue="unsent" />}</GatewayController>);
  const draft = view.querySelector('input')!;
  const recoveryKey = `agent-remote:recovery:${new URL('/u/' + 'a'.repeat(64) + '/', window.location.origin).href}:drafts`;
  sessionStorage.setItem(recoveryKey, 'private draft');
  sessionStorage.setItem('agent-remote:recovery:another-account:drafts', 'other draft');
  const button = (label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
  expect(button('Security')).toBeDefined();
  await act(async () => button('Security').click());
  expect(draft.closest('[hidden][inert]')).not.toBeNull();
  expect(view.textContent).toContain('Chrome on Mac');
  await act(async () => button('Back to conversation').click());
  expect(view.querySelector('input')).toBe(draft);
  expect(draft.closest('[hidden]')).toBeNull();
  await act(async () => button('Security').click());
  await act(async () => button('Sign out this browser').click());
  expect(requests.some(value => value.url === '/auth/sessions/revoke')).toBe(false);
  await act(async () => button('Confirm sign out').click());
  expect(requests).toContainEqual({ url: '/auth/sessions/revoke', body: JSON.stringify({ id: 'this-browser' }) });
  expect(requests.some(value => value.url === '/auth/logout')).toBe(false);
  expect(sessionStorage.getItem(recoveryKey)).toBeNull();
  expect(sessionStorage.getItem('agent-remote:recovery:another-account:drafts')).toBe('other draft');
  sessionStorage.removeItem('agent-remote:recovery:another-account:drafts');
  expect(view.querySelector('input')).toBeNull();
});

it('renews frozen access as soon as the page is shown without waiting for old timers', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 120000, refreshAfterMs: 60000 }));
  vi.stubGlobal('fetch', fetcher);
  const view = await render(<GatewayController>{() => <input defaultValue="Keep draft" />}</GatewayController>);
  const input = view.querySelector('input');
  vi.setSystemTime(Date.now() + 180000);
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(view.querySelector('input')).toBe(input);
});
it('shows the Gateway account identity without exposing authentication material', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now()+60000, user: { id: 'alice', name: 'Alice Example', email: 'alice@example.com' } }));
  const view = await render(<GatewayController>{() => <p>Conversation</p>}</GatewayController>);
  expect(view.textContent).toContain('Alice Example');
  expect(view.querySelector('[aria-label="Gateway account"]')?.getAttribute('title')).toContain('alice@example.com');
});


it('renders a recent workspace before authorization and opens business access only after checking', async () => {
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  rememberWorkspaceAccess({ basePath, expiresAt: Date.now() + 5000 });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} defaultValue="Keep typing" />}</GatewayController>);
  const draft = view.querySelector('input')!;
  expect(draft.getAttribute('aria-label')).toBe('Cached draft');
  draft.value = 'Written during checking';
  await act(async () => finish(Response.json({ basePath, expiresAt: Date.now() + 60000 })));
  expect(view.querySelector('input')).toBe(draft);
  expect(draft.getAttribute('aria-label')).toBe('Live draft');
  expect(draft.value).toBe('Written during checking');
});
it('automatically restores a returning browser through Gateway once using the current canonical target', async () => {
  rememberWorkspaceAccess({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: 1 });
  window.history.replaceState(null, '', '/?host=desk&provider=codex&session=native&token=secret');
  const navigate = vi.fn();
  vi.stubGlobal('fetch', async () => Response.json({}, { status: 401 }));
  await render(<GatewayController navigate={navigate}>{() => <p>Workspace</p>}</GatewayController>);
  expect(navigate).toHaveBeenCalledWith('/auth/login?host=desk&provider=codex&session=native');
  await render(<GatewayController navigate={navigate}>{() => <p>Workspace</p>}</GatewayController>);
  expect(navigate).toHaveBeenCalledTimes(1);
});
it('does not restore cached UI or silently sign in after explicit sign-out', async () => {
  rememberWorkspaceAccess({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: 1 });
  forgetWorkspaceAccess();
  const navigate = vi.fn();
  vi.stubGlobal('fetch', async () => Response.json({}, { status: 401 }));
  const view = await render(<GatewayController navigate={navigate}>{() => <p>Workspace</p>}</GatewayController>);
  expect(navigate).not.toHaveBeenCalled();
  expect(view.querySelector('.gateway-private')).toBeNull();
});
it('does not silently undo sign-out if the server logout failed', async () => {
  rememberWorkspaceAccess({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: 1 });
  forgetWorkspaceAccess();
  vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 60000 }));
  const view = await render(<GatewayController>{() => <p>Must stay signed out</p>}</GatewayController>);
  expect(view.querySelector('.gateway-private')).toBeNull();
  expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login');
});
it('clears the previous account display cache before showing a different confirmed account', async () => {
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  rememberWorkspaceAccess({ basePath, expiresAt: 1 });
  const oldKey = `agent-remote:recovery:${new URL(basePath, location.origin).href}:workspace`;
  localStorage.setItem(oldKey, 'private history');
  vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'b'.repeat(64) + '/', expiresAt: Date.now() + 60000 }));
  const view = await render(<GatewayController>{url => <p>{url}</p>}</GatewayController>);
  expect(localStorage.getItem(oldKey)).toBeNull();
  expect(view.textContent).toContain('/u/' + 'b'.repeat(64) + '/');
});
it('shows only the shell after a day without confirmation, then renews the display window', async () => {
  vi.useFakeTimers();
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  rememberWorkspaceAccess({ basePath, expiresAt: 1 });
  vi.setSystemTime(Date.now() + 24 * 3600000 + 1);
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const view = await render(<GatewayController>{() => <p>Private content</p>}</GatewayController>);
  expect(view.querySelector('.gateway-workspace-shell')).not.toBeNull();
  expect(view.textContent).not.toContain('Private content');
  await act(async () => finish(Response.json({ basePath, expiresAt: Date.now() + 60000 })));
  expect(view.textContent).toContain('Private content');
});
it('removes local content when another tab signs out', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 60000 }));
  const view = await render(<GatewayController>{() => <p>Private content</p>}</GatewayController>);
  expect(view.textContent).toContain('Private content');
  await act(async () => { forgetWorkspaceAccess(); window.dispatchEvent(new StorageEvent('storage', { key: 'agent-remote:signed-out', newValue: '1' })); });
  expect(view.textContent).not.toContain('Private content');
});
