import { act, useContext, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelLink } from '@orchardworks/agent-client';
import { SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-e2e/faults/connection-words.mjs';
import { render } from './test/setup.js';
import { GatewayController } from './GatewayController.js';
import type { AccountFacts } from './kernel/account.js';
import { rememberWorkspaceAccess, forgetWorkspaceAccess, RelayLinkReport } from './kernel/workspace-access.js';
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
/** The account facts as buttons, standing in for the Settings page that reads them. */
const accountButtons = (account?: AccountFacts) => account ? <>
  <span className="gateway-account-identity" aria-label="Account" title={[account.name, account.email, `User: ${account.id}`].filter(Boolean).join(' · ')}>{account.name || account.email || account.id}</span>
  <button type="button" disabled={!account.ready} onClick={account.openSecurity}>Security</button><button type="button" onClick={account.signOut}>Sign out</button></> : null;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('opens automatic local access despite an earlier sign-out and does not offer interactive account controls', async () => {
  forgetWorkspaceAccess();
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  const fetcher = vi.fn(async () => Response.json({ user: { id: 'devbox', name: 'Devbox' }, basePath, expiresAt: Date.now() + 120000 }));
  vi.stubGlobal('fetch', fetcher);
  const view = await render(<GatewayController automaticAccess>{(baseUrl, account, ready) => <><p>{ready ? baseUrl : 'Restoring'}</p>{accountButtons(account)}</>}</GatewayController>);
  expect(view.textContent).toBe(window.location.origin + basePath);
  expect(view.querySelector('button, a')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith('/auth/status', expect.any(Object));
  expect(localStorage.getItem('agent-remote:signed-out')).toBeNull();
});
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
  const view = await render(<GatewayController>{(_baseUrl, account) => <><p>Private controller</p>{accountButtons(account)}</>}</GatewayController>);
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
  expect(view.textContent).not.toContain('Opening Orchard…');
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
  // A short wait shows no words; assistive technology hears the label.
  expect(view.querySelector('[role="status"]')?.textContent).toBe('');
  expect(view.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Opening Orchard…');
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  expect(view.querySelector('h1')?.textContent).toBe('Can’t reach Orchard right now');
  await act(async () => view.querySelector<HTMLButtonElement>('.arc-access-action')!.click());
  expect(view.querySelector('h1')?.textContent).toBe('Sign in to Orchard');
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
  const view = await render(<GatewayController>{(_baseUrl, account) => <><input aria-label="Draft" defaultValue="unsent" />{accountButtons(account)}</>}</GatewayController>);
  const draft = view.querySelector('input')!;
  const recoveryKey = `agent-remote:recovery:${new URL('/u/' + 'a'.repeat(64) + '/', window.location.origin).href}:drafts`;
  sessionStorage.setItem(recoveryKey, 'private draft');
  sessionStorage.setItem('agent-remote:recovery:another-account:drafts', 'other draft');
  const button = (label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
  expect(button('Security')).toBeDefined();
  await act(async () => button('Security').click());
  expect(draft.closest('[hidden][inert]')).not.toBeNull();
  await vi.waitFor(() => expect(view.textContent).toContain('Chrome on Mac'));
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
it('shows the Account identity without exposing authentication material', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now()+60000, user: { id: 'alice', name: 'Alice Example', email: 'alice@example.com' } }));
  const view = await render(<GatewayController>{(_baseUrl, account) => <><p>Conversation</p>{accountButtons(account)}</>}</GatewayController>);
  expect(view.textContent).toContain('Alice Example');
  expect(view.querySelector('[aria-label="Account"]')?.getAttribute('title')).toContain('alice@example.com');
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

it('shows stored rows on a cached unexpired lease before the status answers, and removes them and the records when the Relay answers 401', async () => {
  const { deviceStore } = await import('@orchardworks/agent-client/device-store');
  const { saveStoredDisplay, readStoredDisplay } = await import('./kernel/stored-display.js');
  const { replicaState } = await import('./test/fixtures.js');
  const basePath = '/u/' + 'b'.repeat(64) + '/', scope = window.location.origin + basePath;
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', agentId: 'agent-1' };
  const { setWorkspaceReady } = await import('./kernel/workspace-access.js');
  setWorkspaceReady(basePath, true);
  saveStoredDisplay(scope, target, replicaState);
  rememberWorkspaceAccess({ basePath, user: { id: 'alice' }, expiresAt: Date.now() + 60_000 });
  let answer!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve; })));
  await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
  // The status has not answered: the cached lease still runs, so the stored rows show.
  expect(readStoredDisplay(scope, target)?.agent?.id).toBe('agent-1');
  await act(async () => answer(Response.json({ error: 'Sign in' }, { status: 401 })));
  expect(readStoredDisplay(scope, target)).toBeUndefined();
  await vi.waitFor(async () => expect(await deviceStore.load(scope, ['host', 'recorded', 'recorded-session'])).toBeUndefined());
});

describe('the device link indicator', () => {
  const reopen = vi.fn();
  function LinkReporter({ link }: { link: ChannelLink }) {
    const relayLink = useContext(RelayLinkReport);
    useEffect(() => { relayLink.report(link); }, [link, relayLink]);
    useEffect(() => { relayLink.setReopen(reopen); }, [relayLink]);
    return <p>Private controller</p>;
  }
  async function mount() {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => Response.json({ basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: Date.now() + 600_000, refreshAfterMs: 300_000 }));
    let setLink!: (link: ChannelLink) => void;
    function Page() { const [link, set] = useState<ChannelLink>('up'); setLink = set; return <GatewayController>{() => <LinkReporter link={link} />}</GatewayController>; }
    const view = await render(<Page />);
    return { view, setLink: async (link: ChannelLink) => { await act(async () => setLink(link)); } };
  }

  it('says Offline 5 s after the reported link goes down, never with a connection word', async () => {
    const { view, setLink } = await mount();
    await setLink('down');
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
    expect(view.querySelector('.gateway-recovery')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const banner = view.querySelector('.gateway-recovery');
    expect(banner?.textContent).toContain('Offline. Showing saved chats. Messages will be sent when this device is back online.');
    expect(banner?.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
    // Retry asks the transport to reopen the link now.
    await act(async () => view.querySelector<HTMLButtonElement>('.gateway-recovery button')!.click());
    expect(reopen).toHaveBeenCalledOnce();
    await setLink('up');
    expect(view.querySelector('.gateway-recovery')).toBeNull();
  });

  it('shows nothing when the link is back up within 5 s', async () => {
    const { view, setLink } = await mount();
    await setLink('down');
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await setLink('up');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(view.querySelector('.gateway-recovery')).toBeNull();
  });
});

describe('the access page of a session link', () => {
  const link = '?host=desk&provider=codex&session=native';
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('waits without words, then asks to sign in with the focus on its heading and the link on the same session', async () => {
    window.history.replaceState(null, '', '/' + link);
    let answer!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { answer = resolve; }));
    const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
    expect(view.querySelector('[role="status"]')?.textContent).toBe('');
    expect(view.querySelector('.gateway-workspace-shell')).not.toBeNull();
    expect(view.querySelector('h1')).toBeNull();
    await act(async () => answer(Response.json({}, { status: 401 })));
    const heading = view.querySelector('h1')!;
    expect(heading.textContent).toBe('Sign in to continue');
    expect(document.activeElement).toBe(heading);
    expect(view.querySelector('a.arc-access-action')?.getAttribute('href')).toBe('/auth/login' + link);
  });

  it('offers a retry when the Relay is unreachable that keeps the session link, and shows the sign-in card once it answers', async () => {
    window.history.replaceState(null, '', '/' + link);
    let status = 503;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
    const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
    expect(view.querySelector('h1')?.textContent).toBe('Can’t reach Orchard right now');
    expect(document.activeElement).toBe(view.querySelector('h1'));
    expect(view.querySelector('.arc-access-secondary')?.getAttribute('href')).toBe('/auth/login' + link);
    status = 401;
    await act(async () => view.querySelector<HTMLButtonElement>('button.arc-access-action')!.click());
    expect(view.querySelector('h1')?.textContent).toBe('Sign in to continue');
    expect(view.querySelector('a.arc-access-action')?.getAttribute('href')).toBe('/auth/login' + link);
  });

  it('speaks the browser\'s language on the sign-in card', async () => {
    window.history.replaceState(null, '', '/' + link);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })));
    const languages = vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-CN', 'en']);
    try {
      const view = await render(<GatewayController>{() => <p>Private controller</p>}</GatewayController>);
      expect(view.querySelector('h1')?.textContent).toBe('登录后继续');
      expect(view.querySelector('a.arc-access-action')?.textContent).toBe('登录');
    } finally { languages.mockRestore(); }
  });
});

describe('a device clock that differs from the Relay clock', () => {
  const basePath = '/u/' + 'a'.repeat(64) + '/';
  const minute = 60_000;
  const relayAnswer = (relayNow: number, lifeMs: number, extra: object = {}) =>
    Response.json({ basePath, expiresAt: relayNow + lifeMs, ...extra }, { headers: { date: new Date(relayNow).toUTCString() } });

  it('becomes ready when the device clock is 10 minutes ahead of the answer, instead of pausing and asking again', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { requests.push(url); return relayAnswer(Date.now() - 10 * minute, 2 * minute); });
    let ready = false;
    const view = await render(<GatewayController>{(baseUrl, _account, isReady) => { ready = isReady; return <p>{baseUrl}</p>; }}</GatewayController>);
    expect(view.textContent).toContain(window.location.origin + basePath);
    expect(ready).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(ready).toBe(true);
    expect(requests).toEqual(['/auth/status']);
  });

  it('renews before the real deadline when the device clock is 10 minutes behind the answer', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { requests.push(url); return relayAnswer(Date.now() + 10 * minute, 2 * minute); });
    await render(<GatewayController>{baseUrl => <p>{baseUrl}</p>}</GatewayController>);
    expect(requests).toEqual(['/auth/status']);
    await act(async () => { await vi.advanceTimersByTimeAsync(110_000); });
    expect(requests).toEqual(['/auth/status']);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(requests[1]).toBe('/auth/refresh');
  });
});
