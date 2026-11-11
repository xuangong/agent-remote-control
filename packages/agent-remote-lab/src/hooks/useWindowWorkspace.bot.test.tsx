import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowMutationUnknownError, WindowRequestError, WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { createWindowView, applyGroupOperation, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument } from '../session-composition.js';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { useWindowWorkspace, type GroupHandle } from './useWindowWorkspace.js';
import type { WorkbenchMode } from '../workbench-mode.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
const group = (id: string, section = false): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 0, title: id, views: [createWindowView('main', { hostId: 'h', providerId: 'p', nativeSessionId: id, title: id }, 'primary')], selectedPrimaryViewId: 'main', selectedViewId: 'main' }, ...(section ? { bots: { rank: 'm', members: {} }, presentation: { window: false as const } } : {}) });
async function mount(scope = 'scope', hosted = false, initialMode: WorkbenchMode = 'window') {
  let value!: ReturnType<typeof useWindowWorkspace>; let mode = initialMode, enabled = true; const sectionRoute = vi.fn(); const composition = createCompositionDocument(scope);
  function Harness() { value = useWindowWorkspace(scope, hosted, enabled, composition, true, { mode, onSectionRoute: sectionRoute }); return null; }
  root = createRoot(document.createElement('div')); await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
  return { read: () => value, sectionRoute, render: async (next: WorkbenchMode, access = true) => { mode = next; enabled = access; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>)); } };
}
function server(...initial: WindowGroup[]) {
  const groups = new Map(initial.map(group => [group.window.id, group])); const signals: AbortSignal[] = [];
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(async () => [...groups.values()]);
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => { const found = groups.get(id); if (!found) throw new WindowRequestError('Deleted', 404); return found; });
  const changes = vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => { signals.push(signal); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); });
  vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation(async (id, mutation) => { const next = applyGroupOperation(groups.get(id)!, mutation.operation); groups.set(id, next); return { ...next, result: { operationId: mutation.operationId, status: 'committed' as const, revision: next.window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000 } }; });
  return { groups, inspect, changes, signals };
}
it('keeps the open Window on screen while the next one is confirmed, instead of Opening Window', async () => {
  const backend = server(group('a'), group('b')); history.replaceState(null, '', '/?window=a'); const { read } = await mount('https://switch/', true);
  await act(async () => { await read().open('b'); }); await act(async () => { await read().open('a'); }); expect(read().window?.id).toBe('a');
  let finish!: (group: WindowGroup) => void; backend.inspect.mockImplementation(() => new Promise(done => { finish = done; }));
  let opened!: Promise<void>; await act(async () => { opened = read().open('b'); });
  expect(read().unavailable).toBe(false); expect(read().window?.id).toBe('a'); expect(read().authority).toBeDefined();
  await act(async () => { finish(group('b')); await opened; }); expect(read().window?.id).toBe('b'); expect(read().unavailable).toBe(false);
});
it('acquires, edits and watches B without choosing it over Window A', async () => {
  const a = group('a'), b = group('b', true); const backend = server(a, b); history.replaceState(null, '', '/?window=a'); const { read } = await mount('https://test/', true);
  const key = 'agent-remote:recovery:https://test/:shared-window'; const url = location.href;
  let one!: GroupHandle, two!: GroupHandle;
  await act(async () => { one = await read().acquireGroup('b'); two = await read().acquireGroup('b'); await one.operate({ type: 'rename', title: 'Section B' }); });
  expect(read().window).toEqual(a.window); expect(location.href).toBe(url); expect(sessionStorage.getItem(key)).toBe('a'); expect(localStorage.getItem(`${key}:last-window`)).toBe('a');
  expect(read().readGroup('b')?.window.title).toBe('Section B'); expect(backend.changes.mock.calls.filter(call => call[0] === 'b')).toHaveLength(1);
  one.release(); one.release(); expect(backend.signals.filter(signal => signal.aborted)).toHaveLength(0); two.release(); expect(backend.signals.filter(signal => signal.aborted)).toHaveLength(1);
});
it('shares the selected Window watch with Bot leases and keeps it mounted away from Window mode', async () => {
  const backend = server(group('a')); history.replaceState(null, '', '/?window=a'); const harness = await mount('https://same/', true); let handle!: GroupHandle;
  await act(async () => { handle = await harness.read().acquireGroup('a'); }); expect(backend.changes.mock.calls.filter(call => call[0] === 'a')).toHaveLength(1);
  history.replaceState(null, '', '/?mode=bot&section=b'); await harness.render('bot'); handle.release(); expect(harness.read().window?.id).toBe('a'); expect(location.search).toBe('?mode=bot&section=b'); expect(backend.signals.every(signal => !signal.aborted)).toBe(true);
  await harness.render('bot', false); expect(backend.signals.every(signal => signal.aborted)).toBe(true);
});
it('routes a confirmed section-only Window link without stale native attachment or creation', async () => {
  const section = group('section', true); server(section); history.replaceState(null, '', '/?window=section&host=stale&provider=p&session=old'); const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create');
  const key = 'agent-remote:recovery:https://section/:shared-window'; conversationLocalStorage.setItem(`${key}:section`, JSON.stringify({ window: section.window }));
  const { read, sectionRoute } = await mount('https://section/', true);
  expect(sectionRoute).toHaveBeenCalledWith('section'); expect(read().window).toBeUndefined(); expect(create).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).toBeNull();
  await act(async () => { await expect(read().open('section')).rejects.toThrow('section'); }); expect(read().window).toBeUndefined();
});
it('loads only sections in Bot mode and initializes a Window only when switched to it', async () => {
  const section = group('section', true); const backend = server(section); const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => { backend.groups.set(window.id, { window }); return { window }; });
  const harness = await mount('https://sections/', true, 'bot'); expect(harness.read().groups).toEqual([section]); expect(harness.read().window).toBeUndefined(); expect(create).not.toHaveBeenCalled();
  await harness.render('window'); expect(create).toHaveBeenCalledTimes(1); expect(harness.read().window).toBeDefined(); expect(backend.groups.has('section')).toBe(true);
});
it('creates local empty sections separately from Window place and uses ranked group envelopes', async () => {
  const { read } = await mount('local-sections'); const before = read().window; const url = location.href;
  let id!: string, second!: string; await act(async () => { id = await read().createSection('  First  '); second = await read().createSection('Second'); });
  expect(read().window).toBe(before); expect(location.href).toBe(url); const section = read().readGroup(id)!;
  expect(section.window.title).toBe('First'); expect(section.presentation).toEqual({ window: false }); expect(section.bots).toEqual({ rank: 'm', members: {} }); expect(section.window.views[0]?.binding).toBeUndefined(); expect(read().readGroup(second)?.bots?.rank).toBe('mm');
  await expect(read().createSection('  ')).rejects.toThrow('title'); await expect(read().createSection('x'.repeat(257))).rejects.toThrow('256');
});
it('retains an exact unsettled section request and only Retry can resubmit it', async () => {
  server(group('a')); history.replaceState(null, '', '/?window=a'); const writes: Array<{ group: WindowGroup; identity: unknown }> = [];
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'createGroup').mockImplementation(async (group, identity) => { writes.push({ group: structuredClone(group), identity }); throw new WindowMutationUnknownError(group.window.id, { ...identity!, window: group.window }, new Error('Lost')); });
  const recover = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate').mockImplementation(async (window, identity) => { throw new WindowMutationUnknownError(window.id, { ...identity, window }, new Error('Unknown')); });
  const { read } = await mount('https://creation/', true);
  await act(async () => { await expect(read().createSection('Original')).rejects.toThrow(); }); const saved = conversationSessionStorage.getItem('agent-remote:recovery:https://creation/:shared-window:pending-section-create'); expect(saved).toContain('Original');
  await act(async () => { await expect(read().createSection('Replacement')).rejects.toThrow(); }); expect(writes).toHaveLength(1); expect(recover).toHaveBeenCalled();
  expect(read().sectionCreationState).toMatchObject({ state: 'unknown', title: 'Original' }); expect(read().error).toBeUndefined();
  await act(async () => { await expect(read().retrySection()).rejects.toThrow(); }); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(create).toHaveBeenCalledTimes(2);
});
it('keeps Window save Retry and uncertain section Retry independent', async () => {
  const backend = server(group('a')); history.replaceState(null, '', '/?window=a'); const { read } = await mount('https://separate-retry/', true);
  const mutation = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockRejectedValue(new Error('Offline'));
  vi.spyOn(WindowWorkspaceClient.prototype, 'operation').mockRejectedValue(new WindowRequestError('Unknown', 404, 'operation_unknown'));
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'createGroup').mockImplementation(async (group, identity) => { throw new WindowMutationUnknownError(group.window.id, { ...identity!, window: group.window }, new Error('Lost')); });
  vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate').mockImplementation(async (window, identity) => { throw new WindowMutationUnknownError(window.id, { ...identity, window }, new Error('Unknown')); });
  let saved!: Promise<void>; await act(async () => { saved = read().operate({ type: 'rename', title: 'Window edit' }); void saved.catch(() => {}); });
  await act(async () => { await expect(read().createSection('Section')).rejects.toThrow(); }); const windowError = read().error; expect(read().saveState?.pending).toBe(1);
  const beforeRetry = create.mock.calls.length; await act(async () => read().retrySave()); expect(create).toHaveBeenCalledTimes(beforeRetry); expect(read().error).toBe(windowError);
  const mutations = mutation.mock.calls.length; await act(async () => { await expect(read().retrySection()).rejects.toThrow(); }); expect(mutation).toHaveBeenCalledTimes(mutations); expect(read().sectionCreationState.state).toBe('unknown');
  expect(backend.groups.get('a')?.window.title).toBe('a');
});
it('rejects late group acquisition after access changes', async () => {
  server(group('a')); history.replaceState(null, '', '/?window=a'); const harness = await mount('https://access/', true); let resolve!: (group: WindowGroup) => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(id => id === 'late' ? new Promise(done => { resolve = done; }) : Promise.resolve(group('a')));
  const pending = harness.read().acquireGroup('late'); const rejection = expect(pending).rejects.toThrow('scope'); await harness.render('bot', false); await act(async () => { resolve(group('late', true)); await rejection; }); expect(harness.read().readGroup('late')).toBeUndefined();
});
it('keeps a cached Window read-only, without recording it as chosen, until an explicit section route is inspected', async () => {
  const section = group('section', true); const backend = server(section); const cached = { window: section.window };
  const key = 'agent-remote:recovery:https://cached-section/:shared-window'; conversationLocalStorage.setItem(`${key}:section`, JSON.stringify(cached)); history.replaceState(null, '', '/?window=section&host=stale&provider=p&session=old');
  let finish!: (group: WindowGroup) => void; backend.inspect.mockImplementation(() => new Promise(done => { finish = done; })); const { read, sectionRoute } = await mount('https://cached-section/', true);
  expect(read().provisional).toBe(true); expect(read().hasActiveWindow).toBe(false); expect(sessionStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(`${key}:last-window`)).toBeNull();
  expect(new URL(location.href).searchParams.get('session')).toBe('old');
  await act(async () => finish(section)); expect(read().window).toBeUndefined(); expect(read().unavailable).toBe(true); expect(sectionRoute).toHaveBeenCalledWith('section');
  expect(sessionStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(`${key}:last-window`)).toBeNull();
});
it('rejects an older layout if the group changes while its operation acquires a lease', async () => {
  const { read } = await mount('local-layout-fence'); let handle!: GroupHandle; const sectionId = await read().createSection('Section');
  await act(async () => { handle = await read().acquireGroup(sectionId); }); const current = handle.getGroup(), { schemaVersion: _, id: __, revision: ___, ...layout } = current.window;
  const stale = read().operateGroup(sectionId, { type: 'layout.apply', layout: { ...layout, title: 'Stale layout' } }); const rejected = expect(stale).rejects.toThrow('changed');
  await act(async () => { await handle.operate({ type: 'rename', title: 'Fresh' }); await rejected; }); expect(read().readGroup(sectionId)?.window.title).toBe('Fresh'); handle.release();
});
it('rejects a complete layout when acquisition accepts a newer authoritative revision before enqueue', async () => {
  const original = group('a'), fresh = applyGroupOperation(original, { type: 'rename', title: 'Fresh' });
  const backend = server(original); backend.groups.set('a', fresh); vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([original]);
  const mutation = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate'); history.replaceState(null, '', '/?mode=bot'); const { read } = await mount('https://acquisition-layout/', true, 'bot');
  const source = read().readGroup('a')!, { schemaVersion: _, id: __, revision: ___, ...layout } = source.window;
  expect(source.window.revision).toBe(0);
  await act(async () => { await expect(read().operateGroup('a', { type: 'layout.apply', layout: { ...layout, title: 'Stale' } })).rejects.toThrow('changed'); });
  expect(mutation).not.toHaveBeenCalled(); expect(read().readGroup('a')?.window).toEqual(fresh.window);
  const current = read().readGroup('a')!, { schemaVersion: _version, id: _id, revision: _revision, ...currentLayout } = current.window;
  await act(async () => read().operateGroup('a', { type: 'layout.apply', layout: { ...currentLayout, title: 'Recomputed' } }));
  expect(read().readGroup('a')?.window.title).toBe('Recomputed'); expect(mutation.mock.calls[0]?.[1].baseRevision).toBe(1);
});
it('does not retire a section on catalog omission until inspect confirms deletion', async () => {
  const backend = server(group('a'), group('b', true)); history.replaceState(null, '', '/?window=a'); const { read } = await mount('https://catalog/', true);
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([group('a')]); await act(async () => read().refreshGroups()); expect(read().groups.some(g => g.window.id === 'b')).toBe(true);
  backend.groups.delete('b'); await act(async () => read().refreshGroups()); expect(read().groups.some(g => g.window.id === 'b')).toBe(false);
});
it('recovers a lost section POST over a real transport and adopts the inspected full group after reload', async () => {
  const groups = new Map<string, WindowGroup>([['a', group('a')]]), writes: any[] = []; let receiptsAvailable = false;
  const relay = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://relay/').pathname;
    if (request.method === 'POST') {
      let body = ''; for await (const part of request) body += String(part); const input = JSON.parse(body); writes.push(input);
      groups.set(input.window.id, { window: input.window, bots: input.bots, presentation: input.presentation }); response.destroy(); return;
    }
    if (path.endsWith('/changes')) return;
    response.setHeader('content-type', 'application/json');
    if (path.includes('/operations/')) {
      if (!receiptsAvailable) { response.writeHead(503); response.end(JSON.stringify({ error: 'Receipt unavailable' })); return; }
      response.end(JSON.stringify({ result: { operationId: writes[0].operationId, status: 'committed', revision: 0, committedAt: Date.now(), expiresAt: Date.now() + 86400000 } })); return;
    }
    if (path === '/v1/windows') { response.end(JSON.stringify({ windows: [groups.get('a')!.window], groups: [...groups.values()] })); return; }
    const id = path.split('/').at(-1)!; response.end(JSON.stringify(groups.get(id)));
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening'); const address = relay.address() as { port: number }, scope = `http://127.0.0.1:${address.port}/`;
  try {
    history.replaceState(null, '', '/?window=a'); const harness = await mount(scope, true);
    await vi.waitFor(async () => { await act(async () => {}); expect(harness.read().hasActiveWindow).toBe(true); }, { timeout: 3000, interval: 5 });
    await act(async () => { await expect(harness.read().createSection('Original')).rejects.toThrow(); }); expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ bots: { rank: 'm', members: {} }, presentation: { window: false }, window: { title: 'Original' } });
    await act(async () => { await expect(harness.read().createSection('Replacement')).rejects.toThrow(); }); expect(writes).toHaveLength(1);
    const id = writes[0].window.id; groups.set(id, applyGroupOperation(groups.get(id)!, { type: 'section.rank', rank: 'z' })); receiptsAvailable = true;
    await act(async () => root!.unmount()); root = undefined; const reloaded = await mount(scope, true);
    await vi.waitFor(async () => { await act(async () => {}); expect(reloaded.read().readGroup(id)?.bots?.rank).toBe('z'); expect(reloaded.read().sectionCreationState.state).toBe('idle'); }, { timeout: 3000, interval: 5 });
    expect(reloaded.read().window?.id).toBe('a'); expect(location.search).toBe('?window=a'); expect(writes).toHaveLength(1); expect(conversationSessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window:pending-section-create`)).toBeNull();
  } finally { if (root) await act(async () => root!.unmount()); root = undefined; relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve())); }
});
it('shows a cached Window read-only on a cold start until the service confirms it', async () => {
  const backend = server(group('a')); const key = 'agent-remote:recovery:https://cold/:shared-window';
  const cached = group('a'); cached.window.title = 'Cached'; conversationLocalStorage.setItem(`${key}:a`, JSON.stringify(cached)); conversationLocalStorage.setItem(`${key}:last-window`, 'a');
  let finish!: () => void; const confirmed = new Promise<void>(done => { finish = done; });
  const list = vi.mocked(WindowWorkspaceClient.prototype.listGroups).getMockImplementation()!;
  vi.mocked(WindowWorkspaceClient.prototype.listGroups).mockImplementation(async () => { await confirmed; return list(); });
  const mutate = vi.mocked(WindowWorkspaceClient.prototype.mutate);
  const { read } = await mount('https://cold/', true);
  expect(read().window?.title).toBe('Cached'); expect(read().provisional).toBe(true); expect(read().unavailable).toBe(false); expect(read().hasActiveWindow).toBe(false);
  expect(read().authority).toBeDefined(); expect(read().sessionBridge).toBeDefined();
  await act(async () => { await expect(read().operate({ type: 'rename', title: 'Edited' })).rejects.toThrow('Wait for this Window'); });
  await act(async () => { read().authority!.operate({ type: 'view.close', viewId: 'main' }); await Promise.resolve(); });
  expect(read().window?.views.map(view => view.id)).toEqual(['main']); expect(mutate).not.toHaveBeenCalled(); expect(backend.changes).not.toHaveBeenCalled();
  await act(async () => { finish(); }); await vi.waitFor(async () => { await act(async () => {}); expect(read().provisional).toBe(false); });
  expect(read().window?.title).toBe('a'); expect(read().hasActiveWindow).toBe(true); expect(new URL(location.href).searchParams.get('window')).toBe('a');
  await act(async () => { await read().operate({ type: 'rename', title: 'Edited' }); }); expect(mutate).toHaveBeenCalledTimes(1); expect(read().window?.title).toBe('Edited');
});
it('leaves a cached Window shown read-only when the service says it became a section', async () => {
  const section = group('a', true); const backend = server(section); const key = 'agent-remote:recovery:https://became-section/:shared-window';
  conversationLocalStorage.setItem(`${key}:a`, JSON.stringify(group('a'))); history.replaceState(null, '', '/?window=a');
  let finish!: (group: WindowGroup) => void; backend.inspect.mockImplementation(() => new Promise(done => { finish = done; }));
  const mutate = vi.mocked(WindowWorkspaceClient.prototype.mutate);
  const { read, sectionRoute } = await mount('https://became-section/', true);
  expect(read().window?.id).toBe('a'); expect(read().provisional).toBe(true); expect(sectionRoute).not.toHaveBeenCalled();
  await act(async () => { finish(section); }); await vi.waitFor(async () => { await act(async () => {}); expect(sectionRoute).toHaveBeenCalledWith('a'); });
  expect(read().window).toBeUndefined(); expect(read().provisional).toBe(false); expect(read().unavailable).toBe(true); expect(mutate).not.toHaveBeenCalled();
});
