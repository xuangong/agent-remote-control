import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SecurityPanel } from './SecurityPanel.js';
const now = Date.now();
const current = { id: 'current-id', label: 'This laptop', createdAt: now, lastSeenAt: now, expiresAt: now + 3600000, current: true };
const other = { ...current, id: 'other-id', label: 'Mobile Safari', current: false };
const list = { sessions: [current, other], authenticatedAt: now, recentAuthentication: true };
afterEach(() => vi.unstubAllGlobals());
const button = (view: HTMLElement, label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
it('revokes another browser, refreshes activity and leaves this browser signed in', async () => {
  const signedOut = vi.fn(); const calls: string[] = []; let removed = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === '/auth/sessions') return Response.json({ ...list, sessions: removed ? [current] : list.sessions });
    if (url === '/auth/audit') return Response.json({ events: [{ id: 'event', at: now, action: 'session_revoked', outcome: 'success' }] });
    expect(init?.body).toBe(JSON.stringify({ id: 'other-id' })); removed = true; return Response.json({ ok: true, current: false });
  });
  const view = await render(<SecurityPanel onClose={() => undefined} onSignedOut={signedOut} />);
  expect(document.activeElement).toBe(view.querySelector('h1'));
  await act(async () => button(view, 'Sign out browser').click());
  await act(async () => button(view, 'Confirm sign out').click());
  expect(signedOut).not.toHaveBeenCalled();
  expect(view.querySelector('[aria-label="Sign out Mobile Safari"]')).toBeNull();
  expect(view.textContent).toContain('Session revoked');
  expect(calls.filter(value => value === '/auth/audit')).toHaveLength(2);
});
it('revokes all browsers only after confirmation and signs out locally exactly once', async () => {
  const signedOut = vi.fn(); const mutations: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/auth/sessions') return Response.json(list);
    if (url === '/auth/audit') return Response.json({ events: [] });
    mutations.push(url); return Response.json({ ok: true });
  });
  const view = await render(<SecurityPanel onClose={() => undefined} onSignedOut={signedOut} />);
  await act(async () => button(view, 'Sign out all browsers').click());
  expect(mutations).toEqual([]);
  await act(async () => button(view, 'Confirm sign out').click());
  expect(mutations).toEqual(['/auth/sessions/revoke-all']);
  expect(signedOut).toHaveBeenCalledOnce();
});
it('keeps the session list after a failed mutation and exposes audit failure independently', async () => {
  const signedOut = vi.fn();
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/sessions' ? Response.json(list) : Response.json({}, { status: 503 }));
  const view = await render(<SecurityPanel onClose={() => undefined} onSignedOut={signedOut} />);
  expect(view.textContent).toContain('Security activity is unavailable');
  await act(async () => button(view, 'Sign out browser').click());
  await act(async () => button(view, 'Confirm sign out').click());
  expect(signedOut).not.toHaveBeenCalled();
  expect(view.textContent).toContain('Mobile Safari');
  expect(view.textContent).toContain('could not be completed');
  expect(button(view, 'Confirm sign out').disabled).toBe(false);
});
it('does not render malformed management rows and can retry loading', async () => {
  let malformed = true;
  vi.stubGlobal('fetch', async (url: string) => url === '/auth/sessions' ? Response.json(malformed ? { ...list, sessions: [{ ...current, expiresAt: 'invalid' }] } : list) : Response.json({ events: [] }));
  const view = await render(<SecurityPanel onClose={() => undefined} onSignedOut={() => undefined} />);
  expect(view.textContent).toContain('browser session list is invalid');
  expect(button(view, 'Sign out this browser')).toBeUndefined();
  malformed = false;
  await act(async () => button(view, 'Refresh').click());
  expect(button(view, 'Sign out this browser')).toBeDefined();
});
