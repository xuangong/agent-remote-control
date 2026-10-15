import { WindowWorkspaceClient, WindowMutationUnknownError, WindowRequestError } from '@orchardworks/agent-remote-web';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createCompositionDocument, createCompositionSlot, createAskOwner, type CompositionDocument } from '../session-composition.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { useWindowWorkspace } from './useWindowWorkspace.js';
import { WindowWorkspaces } from '../components/WindowWorkspaces.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
async function mount(scope: string, hosted = false, initialComposition?: CompositionDocument, showControls = false) {
  const element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  let current!: ReturnType<typeof useWindowWorkspace>;
  const composition = initialComposition ?? createCompositionDocument(scope);
  function Harness() { current = useWindowWorkspace(scope, hosted, true, composition); return showControls ? <WindowWorkspaces workspace={current} /> : null; }
  await act(async () => root!.render(<Harness />));
  return () => current;
}
function windowFixture(id: string): WorkspaceWindow {
  return { schemaVersion: 1, id, revision: 0, title: id, primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
}
function hostedWindows(...windows: WorkspaceWindow[]) {
  const documents = new Map(windows.map(window => [window.id, window]));
  const list = vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockImplementation(async () => [...documents.values()]);
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => {
    const window = documents.get(id); if (!window) throw new WindowRequestError('Window deleted', 404);
    return { window };
  });
  const changes = vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => { documents.set(window.id, window); return { window }; });
  const remove = vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockImplementation(async window => { documents.delete(window.id); });
  const recover = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverDelete');
  return { documents, list, inspect, changes, create, remove, recover };
}
it('keeps independent Window identities, opens local snapshots and restores browser history targets', async () => {
  const read = await mount('local-route'); const first = read().window!.id;
  await act(async () => read().create()); const second = read().window!.id;
  expect(first).not.toBe(second); expect(new URL(location.href).searchParams.get('window')).toBe(second);
  await act(async () => read().open(first)); expect(read().window!.id).toBe(first);
  await act(async () => { history.pushState(null, '', `/?window=${second}`); dispatchEvent(new PopStateEvent('popstate')); });
  expect(read().window!.id).toBe(second);
});
it('honors an explicit legacy session link over an unrelated cached Window', async () => {
  const read = await mount('legacy-route'); const first = read().window!.id;
  await act(async () => { history.pushState(null, '', '/?host=offline&provider=codex&session=target'); dispatchEvent(new PopStateEvent('popstate')); });
  expect(read().window!.id).not.toBe(first);
  expect(read().window!.views[0]?.binding).toMatchObject({ hostId: 'offline', providerId: 'codex', nativeSessionId: 'target' });
});

it('keeps the chosen Window when an older Window operation completes', async () => {
  const read = await mount('local-pending'); const first = read().window!.id;
  await act(async () => read().create()); const second = read().window!.id;
  await act(async () => read().open(first));
  let release!: () => Promise<void>;
  const locks = { request: (_name: string, commit: () => Promise<unknown>) => new Promise(resolve => { release = async () => { resolve(await commit()); }; }) };
  vi.stubGlobal('navigator', { locks });
  const pending = read().operate({ type: 'rename', title: 'Completed in background' });
  await act(async () => { await read().open(second); });
  await act(async () => { await release(); await pending; });
  expect(read().window!.id).toBe(second);
  expect(new URL(location.href).searchParams.get('window')).toBe(second);
  expect(sessionStorage.getItem('agent-remote:recovery:local-pending:shared-window')).toBe(second);
  expect(JSON.parse(localStorage.getItem(`agent-remote:recovery:local-pending:shared-window:${first}`)!)).toMatchObject({ title: 'Completed in background' });
});

it('does not select an uncommitted hosted Window when creation fails', async () => {
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockRejectedValue(new Error('Service unavailable'));
  const read = await mount('https://example.test/', true);
  expect(read().window).toBeUndefined();
  expect(read().error).toBe('Service unavailable');
  expect(new URL(location.href).searchParams.has('window')).toBe(false);
  expect(sessionStorage.getItem('agent-remote:recovery:https://example.test/:shared-window')).toBeNull();
});

it('rejects a local operation when authoritative storage cannot save its result', async () => {
  const read = await mount('local-storage-failure');
  const before = read().window!;
  vi.spyOn(conversationLocalStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  await act(async () => { await expect(read().operate({ type: 'rename', title: 'Unsaved' })).rejects.toThrow('Storage full'); });
  expect(read().window).toEqual(before);
  await act(async () => { await expect(read().create()).rejects.toThrow('Storage full'); });
  expect(read().window).toEqual(before);
  expect(new URL(location.href).searchParams.get('window')).toBe(before.id);
});

it('preserves a newer selection when deletion of the previous Window finishes', async () => {
  const first: WorkspaceWindow = { schemaVersion: 1, id: 'first', revision: 0, title: 'First', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const second = { ...first, id: 'second', title: 'Second' }, third = { ...first, id: 'third', title: 'Third' };
  history.replaceState(null, '', '/?window=second');
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second, third]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: id === first.id ? first : id === second.id ? second : third }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  let complete!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const read = await mount('https://delete.example/', true);
  const pending = read().remove(first.id);
  await act(async () => { await read().open(third.id); });
  await act(async () => { complete(); await pending; });
  expect(read().window?.id).toBe(third.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(third.id);
  expect(sessionStorage.getItem('agent-remote:recovery:https://delete.example/:shared-window')).toBe(third.id);
  expect(read().windows.map(window => window.id)).toEqual([second.id, third.id]);
});

it('retains one exact create request across lost replies, explicit retry and page recovery', async () => {
  const writes: any[] = [];
  let lookupAvailable = false;
  const server = createServer(async (request, response) => {
    const path = request.url!;
    if (request.method === 'POST') {
      let body = ''; for await (const part of request) body += String(part);
      writes.push(JSON.parse(body)); response.destroy(); return;
    }
    if (path.includes('/changes?')) return;
    if (path.includes('/operations/') && !lookupAvailable) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Unavailable' })); return;
    }
    const window = writes[0]?.window;
    const result = writes[0] && { operationId: writes[0].operationId, status: 'committed', revision: 0, committedAt: 1, expiresAt: Date.now() + 86400000 };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(path === '/v1/windows' ? { windows: window ? [window] : [] } : path.includes('/operations/') ? { result } : { window }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const scope = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const key = `agent-remote:recovery:${scope}:shared-window`;
  try {
    let read = await mount(scope, true);
    await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); });
    await vi.waitFor(async () => { await act(async () => {}); expect(read().error).toBeTruthy(); });
    expect(read().window).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem(`${key}:pending-create`)!)).toMatchObject({ request: writes[0] });
    expect(localStorage.getItem(`${key}:pending-create`)).toBeNull();
    await act(async () => { await expect(read().create()).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    await act(async () => root!.unmount()); root = undefined;
    read = await mount(scope, true);
    await vi.waitFor(async () => { await act(async () => {}); expect(read().error).toBeTruthy(); });
    expect(writes).toHaveLength(2); expect(read().window).toBeUndefined();
    lookupAvailable = true;
    await act(async () => { await read().create(); });
    expect(writes).toHaveLength(2);
    expect(read().window?.id).toBe(writes[0].window.id);
    expect(sessionStorage.getItem(`${key}:pending-create`)).toBeNull();
  } finally {
    if (root) await act(async () => root!.unmount()); root = undefined;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);

it('does not submit a creation unless its recovery identity can be retained', async () => {
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([]);
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockRejectedValue(new Error('Unretained request'));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  const read = await mount('https://save-pending.example/', true);
  expect(create).not.toHaveBeenCalled();
  expect(read().window).toBeUndefined();
  expect(read().error).toContain('Storage full');
});

it('retains an uncertain creation when a replay is refused after its receipt expires', async () => {
  const scope = 'https://expired-create.example/';
  const key = `agent-remote:recovery:${scope}:shared-window:pending-create`;
  const window: WorkspaceWindow = { schemaVersion: 1, id: 'uncertain', revision: 0, title: 'Uncertain', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const request = { operationId: 'retained-operation', issuedAt: 1, window };
  sessionStorage.setItem(key, JSON.stringify({ request, bindings: [] }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate').mockRejectedValue(new WindowMutationUnknownError(window.id, request, new WindowRequestError('Expired', 410, 'operation_expired')));
  vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockRejectedValue(new WindowRequestError('Expired', 410, 'operation_expired'));
  const read = await mount(scope, true);
  await act(async () => { await expect(read().create()).rejects.toMatchObject({ name: 'WindowMutationUnknownError', request }); });
  expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ request });
  expect(read().window).toBeUndefined();
});

it('retains the original delete identity until its receipt can be settled', async () => {
  const window: WorkspaceWindow = { schemaVersion: 1, id: 'pending-delete', revision: 2, title: 'Pending delete', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const active = { ...window, id: 'active-window' };
  history.replaceState(null, '', `/?window=${active.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([window, active]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: id === window.id ? window : active }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const remove = vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockImplementation(async (source, identity) => {
    throw new WindowMutationUnknownError(source.id, { ...identity!, baseRevision: source.revision, operation: { type: 'delete' } }, new Error('Offline'));
  });
  const recover = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverDelete').mockImplementation(async (source, identity) => {
    throw new WindowMutationUnknownError(source.id, { ...identity, baseRevision: source.revision, operation: { type: 'delete' } }, new Error('Offline'));
  });
  const read = await mount('https://pending-delete.example/', true);
  await act(async () => { await expect(read().remove(window.id)).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
  remove.mockRejectedValueOnce(new WindowRequestError('Expired', 410, 'operation_expired'));
  await act(async () => { await expect(read().remove(window.id)).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
  expect(remove.mock.calls[1]).toEqual(remove.mock.calls[0]);
  expect(read().window?.id).toBe(active.id);
  recover.mockResolvedValueOnce(undefined);
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => ({ window }));
  await act(async () => { await read().remove(window.id); });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(recover.mock.calls[1]).toEqual(remove.mock.calls[0]);
  expect(create).not.toHaveBeenCalled();
  expect(read().window?.id).toBe(active.id);
  expect(read().windows.map(window => window.id)).toEqual([active.id]);
  expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
});

it('keeps the latest requested Window when an earlier open returns later', async () => {
  const first: WorkspaceWindow = { schemaVersion: 1, id: 'first-choice', revision: 0, title: 'First', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const second = { ...first, id: 'second-choice' }, third = { ...first, id: 'third-choice' };
  history.replaceState(null, '', `/?window=${first.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second, third]);
  let finishSecond!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => id === second.id
    ? new Promise(resolve => { finishSecond = () => resolve({ window: second }); }) : { window: id === third.id ? third : first });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const read = await mount('https://latest-choice.example/', true);
  const earlier = read().open(second.id);
  await act(async () => { await read().open(third.id); });
  await act(async () => { finishSecond(); await earlier; });
  expect(read().window?.id).toBe(third.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(third.id);
});

it('does not let initialization replace a Window explicitly opened while its read was pending', async () => {
  const first: WorkspaceWindow = { schemaVersion: 1, id: 'initial-choice', revision: 0, title: 'Initial', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const second = { ...first, id: 'manual-choice' };
  history.replaceState(null, '', `/?window=${first.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second]);
  let finishInitial!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => id === first.id
    ? new Promise(resolve => { finishInitial = () => resolve({ window: first }); }) : { window: second });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const read = await mount('https://initial-choice.example/', true);
  await act(async () => { await read().open(second.id); });
  await act(async () => { finishInitial(); });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
});


it('creates ordinary Windows, keeps them selectable, and reuses the current identity after reload', async () => {
  let read = await mount('default-route');
  const first = read().window!;
  await act(async () => read().create());
  await act(async () => read().open(first.id));
  await act(async () => root!.unmount()); root = undefined;
  read = await mount('default-route');
  expect(read().window!.id).toBe(first.id);
  expect(read().windows).toHaveLength(2);
}, 10000);

it('keeps the catalog current after renaming the same Window without changing its owners', async () => {
  const scope = 'renamed-window';
  const source = createCompositionSlot('existing-source', { hostId: 'local', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' }, scope);
  const document = createCompositionDocument(scope, [source]); document.asks.push(createAskOwner(source, scope));
  const read = await mount(scope, false, document, true);
  const before = read().window!, bindings = structuredClone(document.windowBindings), owners = structuredClone(document.asks);
  await act(async () => read().operate({ type: 'rename', title: 'Renamed workspace' }));
  expect(read().window).toMatchObject({ id: before.id, title: 'Renamed workspace', views: before.views });
  expect(read().windows.find(window => window.id === before.id)?.title).toBe('Renamed workspace');
  expect(document.windowBindings).toEqual(bindings); expect(document.asks).toEqual(owners);
  expect(globalThis.document.querySelector(`[data-window-id="${before.id}"] strong`)?.textContent).toBe('Renamed workspace');
}, 10000);

it('rejects deleting the active local Window and preserves its layout', async () => {
  const scope = 'default-delete', read = await mount(scope);
  await act(async () => read().operate({ type: 'view.create', view: createWindowView('retained-dock') }));
  const before = read().window!;
  await act(async () => { await expect(read().remove(before.id)).rejects.toThrow(); });
  expect(read().window).toEqual(before); expect(read().windows).toEqual([before]);
  expect(read().unavailable).toBe(false);
  expect(new URL(location.href).searchParams.get('window')).toBe(before.id);
  expect(JSON.parse(localStorage.getItem(`agent-remote:recovery:${scope}:shared-window:${before.id}`)!)).toEqual(before);
}, 10000);

it('keeps a missing explicit Window link as an error without creating a replacement', async () => {
  history.replaceState(null, '', '/?window=missing-window');
  const read = await mount('missing-window-link');
  expect(read().window).toBeUndefined(); expect(read().error).toContain('unavailable');
  expect(read().unavailable).toBe(true); expect(read().hasActiveWindow).toBe(false);
  expect(read().windows).toHaveLength(0);
  expect(new URL(location.href).searchParams.get('window')).toBe('missing-window');
}, 10000);

it('deletes a nonactive local Window without changing the current selection', async () => {
  const scope = 'local-target-delete', read = await mount(scope); const target = read().window!;
  await act(async () => read().create());
  await act(async () => read().operate({ type: 'view.create', view: createWindowView('retained-dock') }));
  const active = read().window!;
  await act(async () => read().remove(target.id));
  expect(read().window).toEqual(active); expect(read().windows).toEqual([active]);
  expect(read().unavailable).toBe(false);
  expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
  expect(sessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window`)).toBe(active.id);
  expect(localStorage.getItem(`agent-remote:recovery:${scope}:shared-window:${target.id}`)).toBeNull();
}, 10000);

it.each([false, true])('rejects active hosted deletion before dispatch with another Window=%s', async another => {
  const active = windowFixture('active'), target = windowFixture('other');
  const fixture = hostedWindows(active, ...(another ? [target] : []));
  history.replaceState(null, '', `/?window=${active.id}`);
  const read = await mount('https://active-delete.example/', true);
  await act(async () => { await expect(read().remove(active.id)).rejects.toThrow(); });
  await act(async () => { await expect(read().remove(undefined as unknown as string)).rejects.toThrow(); });
  expect(fixture.remove).not.toHaveBeenCalled(); expect(fixture.recover).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
  expect(read().window).toEqual(active); expect(read().windows).toHaveLength(another ? 2 : 1);
  expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
}, 10000);

it.each(['loading', 'cached', 'missing', 'deleted'] as const)('requires a valid active Window before reading a delete target when the page is %s', async state => {
  const active = windowFixture('active'), target = windowFixture('delete-target');
  const scope = `https://${state}-active-delete.example/`;
  const fixture = hostedWindows(...(state === 'missing' ? [target] : [active, target]));
  history.replaceState(null, '', `/?window=${active.id}`);
  if (state === 'cached') localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${active.id}`, JSON.stringify(active));
  if (state === 'loading' || state === 'cached') fixture.inspect.mockImplementationOnce(() => new Promise(() => {}));
  if (state === 'deleted') fixture.changes.mockImplementationOnce(async id => { fixture.documents.delete(id); throw new WindowRequestError('Window deleted', 404); });
  const read = await mount(scope, true);
  expect(read().window).toEqual(state === 'cached' ? active : undefined);
  fixture.inspect.mockClear();
  await act(async () => { await expect(read().remove(target.id)).rejects.toThrow(); });
  expect(read().hasActiveWindow).toBe(false);
  expect(fixture.inspect).not.toHaveBeenCalled(); expect(fixture.remove).not.toHaveBeenCalled(); expect(fixture.recover).not.toHaveBeenCalled();
  expect(fixture.documents.get(target.id)).toEqual(target);
  expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
}, 10000);

it('rejects an undispatched delete if the active Window disappears while its target is inspected', async () => {
  const active = windowFixture('active'), target = windowFixture('delete-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  let deleteActive!: () => void, inspectTarget!: () => void;
  fixture.changes.mockImplementationOnce((_id, _revision, signal) => new Promise((_resolve, reject) => {
    deleteActive = () => { fixture.documents.delete(active.id); reject(new WindowRequestError('Window deleted', 404)); };
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const read = await mount('https://active-disappears.example/', true);
  fixture.inspect.mockImplementationOnce(() => new Promise(resolve => { inspectTarget = () => resolve({ window: target }); }));
  const deleting = read().remove(target.id);
  await act(async () => deleteActive());
  expect(read().window).toBeUndefined(); expect(read().unavailable).toBe(true);
  await act(async () => { inspectTarget(); await expect(deleting).rejects.toThrow(); });
  expect(fixture.remove).not.toHaveBeenCalled(); expect(fixture.recover).not.toHaveBeenCalled();
  await act(async () => { await expect(read().open(target.id)).resolves.toBeUndefined(); });
  expect(read().window).toEqual(target); expect(read().unavailable).toBe(false);
}, 10000);

it('does not select an old open snapshot after its Window deletion is confirmed', async () => {
  const active = windowFixture('active'), target = windowFixture('delete-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  const read = await mount('https://deleted-open-snapshot.example/', true);
  let openTarget!: () => void;
  fixture.inspect.mockImplementationOnce(() => new Promise(resolve => { openTarget = () => resolve({ window: target }); }));
  const opening = read().open(target.id);
  await act(async () => read().remove(target.id));
  expect(fixture.remove).toHaveBeenCalledTimes(1); expect(read().windows).toEqual([active]);
  await act(async () => { openTarget(); await Promise.allSettled([opening]); });
  expect(read().window).toEqual(active); expect(read().windows).toEqual([active]); expect(read().unavailable).toBe(false);
  expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
  expect(fixture.create).not.toHaveBeenCalled();
}, 10000);

it('does not select an old open snapshot while its Window deletion is already dispatched', async () => {
  const active = windowFixture('active'), target = windowFixture('delete-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  const read = await mount('https://dispatched-open-snapshot.example/', true);
  let openTarget!: () => void, deleteTarget!: () => void;
  fixture.inspect.mockImplementationOnce(() => new Promise(resolve => { openTarget = () => resolve({ window: target }); }));
  fixture.remove.mockImplementation(window => new Promise(resolve => { deleteTarget = () => { fixture.documents.delete(window.id); resolve(); }; }));
  const opening = read().open(target.id), deleting = read().remove(target.id);
  await act(async () => { await vi.waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1)); });
  try {
    await act(async () => { openTarget(); await Promise.allSettled([opening]); });
    expect(read().window).toEqual(active); expect(read().unavailable).toBe(false);
    expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
  } finally { await act(async () => { deleteTarget(); await deleting; }); }
  expect(read().window).toEqual(active); expect(read().windows).toEqual([active]);
  expect(fixture.create).not.toHaveBeenCalled();
}, 10000);

it('shares one pending hosted delete for duplicate requests without changing the active Window', async () => {
  const active = windowFixture('active'), target = windowFixture('delete-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  let complete!: () => void;
  fixture.remove.mockImplementation(window => new Promise(resolve => { complete = () => { fixture.documents.delete(window.id); resolve(); }; }));
  const read = await mount('https://duplicate-delete.example/', true);
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = read().remove(target.id); second = read().remove(target.id); await vi.waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1)); });
  await act(async () => { complete(); await Promise.all([first, second]); });
  expect(fixture.remove).toHaveBeenCalledTimes(1); expect(fixture.remove.mock.calls[0]?.[0]).toMatchObject({ id: target.id });
  expect(read().window).toEqual(active); expect(read().windows.map(window => window.id)).toEqual([active.id]);
  expect(fixture.create).not.toHaveBeenCalled(); expect(new URL(location.href).searchParams.get('window')).toBe(active.id);
}, 10000);

it('releases an undispatched delete when an earlier navigation makes the target active', async () => {
  const active = windowFixture('active'), target = windowFixture('pending-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  const read = await mount('https://undispatched-delete.example/', true);
  let openTarget!: () => void, inspectTarget!: () => void;
  fixture.inspect.mockImplementationOnce(() => new Promise(resolve => { openTarget = () => resolve({ window: target }); }))
    .mockImplementationOnce(() => new Promise(resolve => { inspectTarget = () => resolve({ window: target }); }));
  const opening = read().open(target.id), deleting = read().remove(target.id);
  await act(async () => { openTarget(); await opening; });
  expect(read().window).toEqual(target);
  await act(async () => { inspectTarget(); await expect(deleting).rejects.toThrow(/active|switch/i); });
  expect(fixture.remove).not.toHaveBeenCalled(); expect(fixture.recover).not.toHaveBeenCalled();
  await act(async () => read().open(active.id));
  await act(async () => { await expect(read().open(target.id)).resolves.toBeUndefined(); });
  expect(read().window).toEqual(target);
}, 10000);

it('keeps the target and current selection when a nonactive deletion is rejected', async () => {
  const active = windowFixture('active'), target = windowFixture('delete-target'), fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  fixture.remove.mockRejectedValueOnce(new WindowRequestError('Delete refused', 403));
  const read = await mount('https://refused-delete.example/', true);
  await act(async () => { await expect(read().remove(target.id)).rejects.toThrow('Delete refused'); });
  expect(read().window).toEqual(active); expect(read().windows).toEqual([active, target]);
  expect(read().unavailable).toBe(false); expect(fixture.create).not.toHaveBeenCalled();
}, 10000);

it('does not apply a previous service deletion to a same-id Window after switching service', async () => {
  const firstScope = 'https://first-scope.example/', secondScope = 'https://second-scope.example/';
  const active = windowFixture('first-active'), target = windowFixture('shared-id'), replacement = { ...target, title: 'Second service Window' };
  const fixture = hostedWindows(active, target);
  history.replaceState(null, '', `/?window=${active.id}`);
  let complete!: () => void;
  fixture.remove.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  const compositions = new Map([firstScope, secondScope].map(scope => [scope, createCompositionDocument(scope)]));
  let current!: ReturnType<typeof useWindowWorkspace>;
  function Harness({ scope }: { scope: string }) { current = useWindowWorkspace(scope, true, true, compositions.get(scope)!); return null; }
  await act(async () => root!.render(<Harness scope={firstScope} />));
  let pending!: Promise<void>;
  await act(async () => { pending = current.remove(target.id); await vi.waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1)); });
  fixture.documents.clear(); fixture.documents.set(replacement.id, replacement);
  await act(async () => {
    history.replaceState(null, '', `/?window=${replacement.id}`);
    root!.render(<Harness scope={secondScope} />);
  });
  expect(current.window).toEqual(replacement);
  await act(async () => { complete(); await pending; });
  expect(current.window).toEqual(replacement); expect(current.windows).toEqual([replacement]); expect(current.unavailable).toBe(false);
  expect(new URL(location.href).searchParams.get('window')).toBe(replacement.id);
  expect(sessionStorage.getItem(`agent-remote:recovery:${secondScope}:shared-window`)).toBe(replacement.id);
}, 10000);

it.each([false, true])('invalidates an externally deleted active local Window with another Window=%s', async another => {
  const scope = 'external-local-delete'; const read = await mount(scope); const original = read().window!;
  let other: WorkspaceWindow | undefined;
  if (another) { await act(async () => read().create()); other = read().window; await act(async () => read().open(original.id)); }
  await act(async () => {
    const key = `agent-remote:recovery:${scope}:shared-window:${original.id}`;
    localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
  });
  expect(read().window).toBeUndefined(); expect(read().unavailable).toBe(true); expect(read().deleted).toBe(true);
  expect(read().authority).toBeUndefined(); expect(read().readWindow()).toBeUndefined();
  expect(read().windows.map(window => window.id)).toEqual(other ? [other.id] : []);
  expect(new URL(location.href).searchParams.get('window')).toBe(original.id);
  if (other) await act(async () => read().open(other!.id));
  else await act(async () => read().create());
  expect(read().window).toBeDefined(); expect(read().unavailable).toBe(false); expect(read().deleted).toBe(false);
  if (other) expect(read().window).toEqual(other);
}, 10000);

it.each([false, true])('invalidates an externally deleted active hosted Window with another Window=%s', async another => {
  const original = windowFixture('externally-deleted'), other = windowFixture('existing');
  const fixture = hostedWindows(original, ...(another ? [other] : []));
  fixture.changes.mockImplementationOnce(async id => { fixture.documents.delete(id); throw new WindowRequestError('Window deleted', 404); });
  history.replaceState(null, '', `/?window=${original.id}`);
  const read = await mount('https://external-delete.example/', true);
  await act(async () => { await vi.waitFor(() => expect(read().unavailable).toBe(true)); });
  expect(read().window).toBeUndefined(); expect(read().deleted).toBe(true);
  expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.remove).not.toHaveBeenCalled();
  expect(read().windows.map(window => window.id)).toEqual(another ? [other.id] : []);
  expect(new URL(location.href).searchParams.get('window')).toBe(original.id);
  if (another) await act(async () => read().open(other.id));
  else await act(async () => read().create());
  expect(read().window).toBeDefined(); expect(read().unavailable).toBe(false); expect(read().deleted).toBe(false);
  if (another) expect(read().window).toEqual(other);
}, 10000);

it('invalidates a deleted current Window after a different Window failed to open', async () => {
  const scope = 'failed-open-deletion'; const read = await mount(scope); const id = read().window!.id;
  await act(async () => { await expect(read().open('missing')).rejects.toThrow('unavailable'); });
  await act(async () => { dispatchEvent(new StorageEvent('storage', { key: `agent-remote:recovery:${scope}:shared-window:${id}`, newValue: null })); });
  expect(read().window).toBeUndefined(); expect(read().unavailable).toBe(true);
  expect(new URL(location.href).searchParams.get('window')).toBe(id);
}, 10000);

it('does not replace a missing explicit hosted Window even when its cache exists', async () => {
  const scope = 'https://cached-missing.example/';
  const cached: WorkspaceWindow = { schemaVersion: 1, id: 'cached-missing', revision: 0, title: 'Cached', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${cached.id}`, JSON.stringify(cached));
  history.replaceState(null, '', `/?window=${cached.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockRejectedValue(new WindowRequestError('Missing Window', 404));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockRejectedValue(new WindowRequestError('Missing Window', 404));
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => ({ window }));
  const read = await mount(scope, true);
  await act(async () => { await vi.waitFor(() => expect(read().error).toBe('Missing Window')); });
  expect(create).not.toHaveBeenCalled();
  expect(read().window).toBeUndefined();
  expect(new URL(location.href).searchParams.get('window')).toBe(cached.id);
}, 10000);

it('blocks externally deleted Window edits when explicit creation fails', async () => {
  const original = windowFixture('deleted-before-create'), fixture = hostedWindows(original);
  fixture.changes.mockImplementationOnce(async id => { fixture.documents.delete(id); throw new WindowRequestError('Window deleted', 404); });
  history.replaceState(null, '', `/?window=${original.id}`);
  const read = await mount('https://deleted-edit.example/', true);
  expect(read().unavailable).toBe(true); expect(read().window).toBeUndefined();
  expect(read().authority).toBeUndefined(); expect(fixture.create).not.toHaveBeenCalled();
  await expect(read().operate({ type: 'rename', title: 'Cannot edit deleted Window' })).rejects.toThrow();
  fixture.create.mockRejectedValueOnce(new WindowRequestError('Creation refused', 403));
  await act(async () => { await expect(read().create()).rejects.toThrow('Creation refused'); });
  expect(read().unavailable).toBe(true); expect(read().authority).toBeUndefined();
  expect(read().window).toBeUndefined(); expect(new URL(location.href).searchParams.get('window')).toBe(original.id);
}, 10000);

it.each(['unknown', 'committed'] as const)('leaves an unrelated %s creation untouched when the active Window is externally deleted', async outcome => {
  const scope = `https://${outcome}-prior-create.example/`;
  const original: WorkspaceWindow = { schemaVersion: 1, id: 'selected-A', revision: 0, title: 'A', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const prior = { ...original, id: 'unknown-C', views: [...original.views, createWindowView('unrelated-dock')] };
  const request = { window: prior, operationId: 'prior-create', issuedAt: Date.now() };
  sessionStorage.setItem(`agent-remote:recovery:${scope}:shared-window:pending-create`, JSON.stringify({ request, bindings: [] }));
  history.replaceState(null, '', `/?window=${original.id}`);
  const fixture = hostedWindows(original, ...(outcome === 'committed' ? [prior] : []));
  fixture.changes.mockImplementationOnce(async id => { fixture.documents.delete(id); throw new WindowRequestError('Window deleted', 404); });
  const recover = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate');
  const read = await mount(scope, true);
  expect(read().unavailable).toBe(true); expect(read().window).toBeUndefined();
  expect(fixture.create).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window:pending-create`)!)).toMatchObject({ request });
  expect(read().windows.map(window => window.id)).toEqual(outcome === 'committed' ? [prior.id] : []);
}, 10000);

it('keeps an already requested navigation valid when the current Window is externally deleted', async () => {
  const first: WorkspaceWindow = { schemaVersion: 1, id: 'deleted-before-navigation', revision: 0, title: 'First', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const second = { ...first, id: 'pending-destination', title: 'Second' };
  history.replaceState(null, '', `/?window=${first.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second]);
  let openSecond!: () => void, deleteFirst!: () => void;
  const committed = new Map([[first.id, first]]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(id => id === second.id ? new Promise(resolve => { openSecond = () => resolve({ window: second }); }) : Promise.resolve({ window: committed.get(id)! }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((id, _revision, signal) => new Promise((_resolve, reject) => {
    if (id === first.id) deleteFirst = () => reject(new WindowRequestError('Deleted', 404));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create');
  const read = await mount('https://pending-navigation.example/', true);
  const pending = read().open(second.id);
  await act(async () => deleteFirst());
  expect(read().window).toBeUndefined(); expect(read().unavailable).toBe(true);
  await act(async () => { openSecond(); await pending; });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  expect(read().unavailable).toBe(false); expect(create).not.toHaveBeenCalled();
}, 10000);

it('renders cached Window before hosted inspection completes without starting synchronization', async () => {
  const scope = 'https://deferred-cache.example/';
  const cached: WorkspaceWindow = { schemaVersion: 1, id: 'early-cache', revision: 0, title: 'Cached', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${cached.id}`, JSON.stringify(cached));
  history.replaceState(null, '', `/?window=${cached.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([cached]);
  let inspected!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: cached }).mockImplementationOnce(() => new Promise(resolve => { inspected = () => resolve({ window: cached }); }));
  const changes = vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const read = await mount(scope, true);
  expect(read().window).toEqual(cached);
  expect(changes).not.toHaveBeenCalled();
  await act(async () => inspected());
  expect(changes).toHaveBeenCalledTimes(1);
}, 10000);

it('does not change the route when a nonactive deletion finishes after unmount', async () => {
  const scope = 'https://unmounted-replacement.example/';
  const original = windowFixture('unmounted-original'), target = windowFixture('unmounted-target');
  history.replaceState(null, '', `/?window=${original.id}`);
  const fixture = hostedWindows(original, target);
  let complete!: () => void;
  fixture.remove.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const read = await mount(scope, true);
  let pending!: Promise<void>;
  await act(async () => { pending = read().remove(target.id); });
  expect(complete).toBeDefined();
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => { complete(); await pending; });
  expect(new URL(location.href).searchParams.get('window')).toBe(original.id);
  expect(sessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window`)).toBe(original.id);
  expect(fixture.create).not.toHaveBeenCalled();
}, 10000);
