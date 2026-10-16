import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import type { WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { useWindowManager } from './useWindowManager.js';

interface Request {
  path: string;
  method: string;
  body?: unknown;
  signal?: AbortSignal | null;
  complete(value: unknown, status?: number): void;
}
function service() {
  const requests: Request[] = [];
  const client = new WindowWorkspaceClient('https://relay.example/u/owner/', async (input, init) => new Promise<Response>(resolve => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal,
      complete: (value, status = 200) => resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })) });
  }));
  return { client, requests };
}
const session = (id: string): WindowSessionBinding => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
function snapshot(id: string, manager?: WindowSessionBinding, generation = 1) {
  const window: WorkspaceWindow = { schemaVersion: 2, id, title: id, revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [{ id: 'main', placement: 'primary', width: 480, collapsed: false, display: { mode: 'content', lettersVisible: true } }] };
  return { window, ...(manager ? { manager: { session: manager, generation } } : {}) };
}
const assigned = (manager: WindowSessionBinding, token: string, generation = 1) => ({ manager: { session: manager, generation }, token, generation });
const roots: Array<{ root: Root; element: HTMLElement }> = [];
afterEach(async () => { for (const { root, element } of roots.splice(0)) { await act(async () => root.unmount()); element.remove(); } localStorage.clear(); sessionStorage.clear(); });
interface Props { client?: WindowWorkspaceClient; windowId?: string; active: boolean }
async function mount(initial: Props) {
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element); roots.push({ root, element });
  let current!: ReturnType<typeof useWindowManager>; let props = initial;
  function Harness(input: Props) { current = useWindowManager(input.client, input.windowId, input.active); return <output>{current.status}:{current.manager?.title ?? ''}</output>; }
  const render = async (next: Partial<Props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(<Harness {...props} />)); };
  await render(); return { read: () => current, render, element };
}
const complete = async (request: Request, value: unknown, status = 200) => { await act(async () => request.complete(value, status)); };

it('loads manager state only while active and recovers a failed inspect explicitly', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: false });
  expect(s.requests).toHaveLength(0);
  await h.render({ active: true }); expect(h.read().status).toBe('loading');
  await complete(s.requests[0]!, { error: 'Unavailable' }, 503);
  expect(h.read().status).toBe('error'); expect(h.read().error).toContain('Unavailable');
  await act(async () => h.read().refresh());
  await complete(s.requests[1]!, snapshot('A', session('manager A')));
  expect(h.read().status).toBe('ready'); expect(h.read().manager?.title).toBe('manager A'); expect(h.read().error).toBeUndefined();
}, 5000);

it.each(['window', 'client'] as const)('isolates a late inspect after switching the %s', async kind => {
  const first = service(); const second = kind === 'client' ? service() : first;
  const h = await mount({ client: first.client, windowId: 'A', active: true });
  const old = first.requests[0]!;
  const id = kind === 'window' ? 'B' : 'A';
  await h.render({ client: second.client, windowId: id });
  expect(old.signal?.aborted).toBe(true); expect(h.read().manager).toBeUndefined();
  await complete(second.requests.at(-1)!, snapshot(id, session('current')));
  await complete(old, snapshot('A', session('obsolete')));
  expect(h.read().manager?.title).toBe('current');
}, 5000);

it.each(['window', 'client'] as const)('keeps late assignment grants scoped to their original %s', async kind => {
  const first = service(); const second = kind === 'client' ? service() : first;
  const h = await mount({ client: first.client, windowId: 'A', active: true });
  await complete(first.requests[0]!, snapshot('A'));
  let old!: Promise<void>; await act(async () => { old = h.read().assign(session('old manager')); });
  const oldRequest = first.requests.at(-1)!;
  const id = kind === 'window' ? 'B' : 'A';
  await h.render({ client: second.client, windowId: id });
  await complete(second.requests.at(-1)!, snapshot(id));
  let current!: Promise<void>; await act(async () => { current = h.read().assign(session('current manager')); });
  await complete(second.requests.at(-1)!, assigned(session('current manager'), 'b'.repeat(43)));
  await act(async () => current);
  await complete(oldRequest, assigned(session('old manager'), 'a'.repeat(43)));
  await act(async () => old);
  expect(h.read().manager?.title).toBe('current manager'); expect(h.read().grant).toEqual({ windowId: id, token: 'b'.repeat(43) });
  await h.render({ client: first.client, windowId: 'A', active: false });
  expect(h.read().manager?.title).toBe('old manager'); expect(h.read().grant).toEqual({ windowId: 'A', token: 'a'.repeat(43) });
}, 5000);

it('retains a private grant while hidden and after reopening without writing it to storage', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  await complete(s.requests[0]!, snapshot('A'));
  let pending!: Promise<void>; await act(async () => { pending = h.read().assign(session('manager')); });
  await h.render({ active: false });
  await complete(s.requests[1]!, assigned(session('manager'), 'g'.repeat(43), 3));
  await act(async () => pending);
  expect(h.read().grant?.token).toBe('g'.repeat(43)); expect(s.requests).toHaveLength(2);
  await h.render({ active: true });
  await complete(s.requests[2]!, snapshot('A', session('manager'), 3));
  expect(h.read().grant).toEqual({ windowId: 'A', token: 'g'.repeat(43) });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
}, 5000);

it('does not let an older inspect overwrite a completed assignment', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  const old = s.requests[0]!;
  let pending!: Promise<void>; await act(async () => { pending = h.read().assign(session('new manager')); });
  await complete(s.requests[1]!, assigned(session('new manager'), 'g'.repeat(43), 2));
  await act(async () => pending);
  await complete(old, snapshot('A', session('old manager'), 1));
  expect(h.read().manager?.title).toBe('new manager'); expect(h.read().grant?.token).toBe('g'.repeat(43));
}, 5000);

it('rejects concurrent assignment and recovers from a failed mutation without automatic replay', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  await complete(s.requests[0]!, snapshot('A'));
  let failure!: Promise<unknown>;
  await act(async () => { failure = h.read().assign(session('manager')).catch(error => error); });
  expect(h.read().pending).toBe(true);
  await expect(h.read().assign(null)).rejects.toThrow(); expect(s.requests).toHaveLength(2);
  await complete(s.requests[1]!, { error: 'Connection lost' }, 503);
  await act(async () => { expect(await failure).toBeInstanceOf(Error); });
  expect(h.read().pending).toBe(false); expect(h.read().status).toBe('error'); expect(s.requests).toHaveLength(2);
  await act(async () => h.read().refresh());
  await complete(s.requests[2]!, snapshot('A', session('committed manager'), 2));
  expect(h.read().manager?.title).toBe('committed manager'); expect(h.read().grant).toBeUndefined(); expect(h.read().error).toBeUndefined();
  let pending!: Promise<void>; await act(async () => { pending = h.read().assign(session('retry manager')); });
  await complete(s.requests[3]!, assigned(session('retry manager'), 'r'.repeat(43), 3));
  await act(async () => pending);
  expect(h.read().manager?.title).toBe('retry manager'); expect(h.read().grant?.token).toBe('r'.repeat(43));
}, 5000);

it('clears a grant when a refreshed manager generation changed outside this page', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  await complete(s.requests[0]!, snapshot('A'));
  let pending!: Promise<void>; await act(async () => { pending = h.read().assign(session('manager')); });
  await complete(s.requests[1]!, assigned(session('manager'), 'g'.repeat(43), 1));
  await act(async () => pending);
  await act(async () => h.read().refresh());
  await complete(s.requests[2]!, snapshot('A', session('manager'), 2));
  expect(h.read().manager?.title).toBe('manager'); expect(h.read().grant).toBeUndefined();
}, 5000);

it('does not let a late revocation clear another Window grant', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  await complete(s.requests[0]!, snapshot('A', session('old manager')));
  let revoke!: Promise<void>; await act(async () => { revoke = h.read().assign(null); });
  const old = s.requests[1]!;
  await h.render({ windowId: 'B' }); await complete(s.requests[2]!, snapshot('B'));
  let assign!: Promise<void>; await act(async () => { assign = h.read().assign(session('current manager')); });
  await complete(s.requests[3]!, assigned(session('current manager'), 'b'.repeat(43)));
  await act(async () => assign);
  await complete(old, { generation: 2 }); await act(async () => revoke);
  expect(h.read().manager?.title).toBe('current manager'); expect(h.read().grant?.windowId).toBe('B');
  await h.render({ windowId: 'A', active: false }); expect(h.read().manager).toBeUndefined(); expect(h.read().grant).toBeUndefined();
}, 5000);

it('ignores a late inspect after closing and reads fresh state when reopened', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  const old = s.requests[0]!;
  await h.render({ active: false });
  await complete(old, snapshot('A', session('obsolete')));
  expect(h.read().manager).toBeUndefined(); expect(old.signal?.aborted).toBe(true);
  await act(async () => h.read().refresh()); expect(s.requests).toHaveLength(1);
  await h.render({ active: true });
  await complete(s.requests[1]!, snapshot('A', session('current')));
  expect(h.read().manager?.title).toBe('current');
}, 5000);

it('does not expose an older grant after an assignment response loses its replacement token', async () => {
  const s = service(); const h = await mount({ client: s.client, windowId: 'A', active: true });
  await complete(s.requests[0]!, snapshot('A'));
  let pending!: Promise<void>; await act(async () => { pending = h.read().assign(session('manager')); });
  await complete(s.requests[1]!, assigned(session('manager'), 'g'.repeat(43), 1));
  await act(async () => pending);
  let failure!: Promise<unknown>; await act(async () => { failure = h.read().assign(session('replacement')).catch(error => error); });
  await complete(s.requests[2]!, { manager: { session: session('replacement'), generation: 2 }, generation: 2 });
  await act(async () => { expect(await failure).toBeInstanceOf(Error); });
  expect(h.read().status).toBe('error'); expect(h.read().pending).toBe(false); expect(h.read().grant).toBeUndefined();
  await act(async () => h.read().refresh());
  await complete(s.requests[3]!, snapshot('A', session('replacement'), 2));
  expect(h.read().status).toBe('ready'); expect(h.read().manager?.title).toBe('replacement');
}, 5000);
