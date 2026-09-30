import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GatewayController } from './GatewayController.js';
import { workspaceFetch, workspaceSocket } from './workspace-access.js';
import { render } from './test/setup.js';

const basePath = '/u/' + 'a'.repeat(64) + '/';
const access = () => ({ basePath, expiresAt: Date.now() + 120_000, refreshAfterMs: 60_000 });
type ResumeEvent = 'visibility' | 'pageshow' | 'online';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function resume(kind: ResumeEvent): void {
  if (kind === 'visibility') {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
  } else if (kind === 'pageshow') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  else window.dispatchEvent(new Event('online'));
}

function nativeSockets() {
  const sockets: Array<{ close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('WebSocket', class {
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
    constructor() { sockets.push(this); }
  });
  return sockets;
}

it.each<ResumeEvent>(['visibility', 'pageshow', 'online'])('keeps confirmed access and the live socket usable during %s renewal', async kind => {
  const sockets = nativeSockets();
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(access()))
    .mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} defaultValue="Keep typing" />}</GatewayController>);
  const draft = view.querySelector('input')!;
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  await act(async () => resume(kind));
  expect(view.querySelector('input')).toBe(draft);
  expect(draft.getAttribute('aria-label')).toBe('Live draft');
  expect(sockets[0]!.close).not.toHaveBeenCalled();
  expect(() => socket.send('still authorized')).not.toThrow();
  await act(async () => finish(Response.json(access())));
  expect(sockets).toHaveLength(1);
  socket.close();
});

it('closes an expired socket before foreground listeners can send while renewal is pending', async () => {
  const sockets = nativeSockets();
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(access()))
    .mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} />}</GatewayController>);
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  const send = vi.fn(() => { expect(() => socket.send('expired command')).toThrow(/access|restoring/i); });
  window.addEventListener('online', send);
  try {
    vi.setSystemTime(Date.now() + 120_001);
    await act(async () => resume('online'));
    expect(send).toHaveBeenCalledOnce();
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(view.querySelector('input')?.getAttribute('aria-label')).toBe('Cached draft');
    await expect(workspaceFetch(new URL(basePath + 'v1/command', location.origin), { method: 'POST' })).rejects.toThrow(/restoring/i);
    await act(async () => finish(Response.json(access())));
    expect(view.querySelector('input')?.getAttribute('aria-label')).toBe('Live draft');
  } finally { window.removeEventListener('online', send); socket.close(); }
});

it('replaces a frozen renewal without interrupting still valid access or accepting its late response', async () => {
  const sockets = nativeSockets();
  const renewals: Array<{ signal?: AbortSignal | null; finish(response: Response): void }> = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(access()))
    .mockImplementation((_url: string, init?: RequestInit) => new Promise<Response>(finish => { renewals.push({ signal: init?.signal, finish }); })));
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} />}</GatewayController>);
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(renewals).toHaveLength(1);
  vi.setSystemTime(Date.now() + 20_000);
  await act(async () => resume('pageshow'));
  expect(renewals[0]!.signal?.aborted).toBe(true);
  expect(renewals).toHaveLength(2);
  expect(sockets[0]!.close).not.toHaveBeenCalled();
  await act(async () => renewals[0]!.finish(Response.json({}, { status: 403 })));
  expect(view.querySelector('input')?.getAttribute('aria-label')).toBe('Live draft');
  await act(async () => renewals[1]!.finish(Response.json(access())));
  expect(() => socket.send('authorized after renewal')).not.toThrow();
  socket.close();
});

it('immediately retires valid access when foreground renewal is denied', async () => {
  const sockets = nativeSockets();
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(access()))
    .mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
  const view = await render(<GatewayController>{() => <input aria-label="Draft" />}</GatewayController>);
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  await act(async () => resume('online'));
  expect(sockets[0]!.close).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({}, { status: 403 })));
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  expect(view.querySelector('input')).toBeNull();
  await expect(workspaceFetch(new URL(basePath + 'v1/providers', location.origin))).rejects.toThrow(/retired/i);
  socket.close();
});

it('retires the previous account socket when foreground renewal confirms a different account', async () => {
  const sockets = nativeSockets();
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(access()))
    .mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
  const view = await render(<GatewayController>{url => <p>{url}</p>}</GatewayController>);
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  await act(async () => resume('online'));
  expect(sockets[0]!.close).not.toHaveBeenCalled();
  const otherPath = '/u/' + 'b'.repeat(64) + '/';
  await act(async () => finish(Response.json({ ...access(), basePath: otherPath })));
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  expect(view.textContent).toContain(otherPath);
  await expect(workspaceFetch(new URL(basePath + 'v1/providers', location.origin))).rejects.toThrow(/retired/i);
  socket.close();
});

it('restores an expired local grant from the current relay lease without forcing an authority renewal', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (url === '/auth/status') return Response.json(access());
    return new Promise<Response>(() => {});
  });
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} />}</GatewayController>);
  const draft = view.querySelector('input');
  vi.setSystemTime(Date.now() + 180_000);
  await act(async () => resume('pageshow'));
  expect(view.querySelector('input')).toBe(draft);
  expect(draft?.getAttribute('aria-label')).toBe('Live draft');
  expect(requests).toEqual(['/auth/status', '/auth/status']);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests).toEqual(['/auth/status', '/auth/status', '/auth/refresh']);
});

it('retries a failed foreground status check without forcing an upstream renewal on a weak network', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (requests.length === 2) throw new TypeError('Network request failed');
    return Response.json(access());
  });
  const sockets = nativeSockets();
  const view = await render(<GatewayController>{(_url, _account, ready) => <input aria-label={ready ? 'Live draft' : 'Cached draft'} />}</GatewayController>);
  const draft = view.querySelector('input');
  const socket = workspaceSocket(new URL(basePath + 'v1/session-channel', location.origin).href);
  await Promise.resolve();
  await act(async () => resume('online'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(requests).toEqual(['/auth/status', '/auth/status', '/auth/status']);
  expect(view.querySelector('input')).toBe(draft);
  expect(draft?.getAttribute('aria-label')).toBe('Live draft');
  expect(sockets[0]!.close).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests.at(-1)).toBe('/auth/refresh');
  socket.close();
});
