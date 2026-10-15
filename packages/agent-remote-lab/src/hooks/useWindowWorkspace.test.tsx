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
  const second = { ...first, id: 'second', title: 'Second' };
  history.replaceState(null, '', '/?window=first');
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: id === first.id ? first : second }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  let complete!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  const read = await mount('https://delete.example/', true);
  const pending = read().remove();
  await act(async () => { await read().open(second.id); });
  await act(async () => { complete(); await pending; });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  expect(sessionStorage.getItem('agent-remote:recovery:https://delete.example/:shared-window')).toBe(second.id);
  expect(read().windows.map(window => window.id)).toEqual([second.id]);
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
  history.replaceState(null, '', `/?window=${window.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([window]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window });
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
  await act(async () => { await expect(read().remove()).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
  remove.mockRejectedValueOnce(new WindowRequestError('Expired', 410, 'operation_expired'));
  await act(async () => { await expect(read().remove()).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
  expect(remove.mock.calls[1]).toEqual(remove.mock.calls[0]);
  expect(read().window?.id).toBe(window.id);
  recover.mockResolvedValueOnce(undefined);
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => ({ window }));
  await act(async () => { await read().remove(); });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(recover.mock.calls[1]).toEqual(remove.mock.calls[0]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(read().window?.id).not.toBe(window.id);
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

it('replaces an explicitly deleted current Window with one new empty Window', async () => {
  const read = await mount('default-delete'); const first = read().window!.id;
  await act(async () => read().operate({ type: 'view.create', view: createWindowView('deleted-dock', { hostId: 'host', providerId: 'recorded', nativeSessionId: 'existing', title: 'Existing' }) }));
  await act(async () => read().remove());
  expect(read().window).toBeDefined();
  expect(read().window!.id).not.toBe(first);
  expect(read().window!.views).toEqual([createWindowView('main', undefined, 'primary')]);
  expect(read().windows).toHaveLength(1);
  expect(new URL(location.href).searchParams.get('window')).toBe(read().window!.id);
}, 10000);

it('keeps a missing explicit Window link as an error without creating a replacement', async () => {
  history.replaceState(null, '', '/?window=missing-window');
  const read = await mount('missing-window-link');
  expect(read().window).toBeUndefined(); expect(read().error).toContain('unavailable');
  expect(read().windows).toHaveLength(0);
  expect(new URL(location.href).searchParams.get('window')).toBe('missing-window');
}, 10000);

it('keeps a newer choice when empty replacement creation completes after deletion', async () => {
  const first: WorkspaceWindow = { schemaVersion: 1, id: 'deleted-current', revision: 0, title: 'First', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const second = { ...first, id: 'newer-choice', title: 'Second' };
  history.replaceState(null, '', `/?window=${first.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([first, second]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: id === first.id ? first : second }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockResolvedValue(undefined);
  let complete!: () => void;
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(window => new Promise(resolve => { complete = () => resolve({ window }); }));
  const read = await mount('https://replacement-race.example/', true);
  let pending!: Promise<void>;
  await act(async () => { pending = read().remove(); await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1)); });
  await act(async () => read().open(second.id));
  await act(async () => { complete(); await pending; });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  expect(sessionStorage.getItem('agent-remote:recovery:https://replacement-race.example/:shared-window')).toBe(second.id);
}, 10000);


it('replaces a selected Window removed by another local page with an empty Window', async () => {
  const scope = 'external-local-delete'; const read = await mount(scope); const id = read().window!.id;
  await act(async () => read().operate({ type: 'view.create', view: createWindowView('old-dock') }));
  await act(async () => { dispatchEvent(new StorageEvent('storage', { key: `agent-remote:recovery:${scope}:shared-window:${id}`, newValue: null })); });
  expect(read().window?.id).not.toBe(id);
  expect(read().window?.views).toEqual([createWindowView('main', undefined, 'primary')]);
}, 10000);

it('replaces a selected hosted Window after confirmed deletion without copying its layout', async () => {
  const original: WorkspaceWindow = { schemaVersion: 1, id: 'externally-deleted', revision: 0, title: 'Deleted', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', { hostId: 'host', providerId: 'recorded', nativeSessionId: 'still-alive', title: 'Native survives' }, 'primary'), createWindowView('old-dock')] };
  history.replaceState(null, '', `/?window=${original.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([original]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: original });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })).mockRejectedValueOnce(new WindowRequestError('Deleted', 404));
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => ({ window }));
  const read = await mount('https://external-delete.example/', true);
  await act(async () => { await vi.waitFor(() => expect(read().window?.id).not.toBe(original.id)); });
  expect(create).toHaveBeenCalledTimes(1);
  expect(read().window?.views).toEqual([createWindowView('main', undefined, 'primary')]);
  expect(read().windows.map(window => window.id)).not.toContain(original.id);
}, 10000);

it('replaces a deleted current Window after a different Window failed to open', async () => {
  const scope = 'failed-open-deletion'; const read = await mount(scope); const id = read().window!.id;
  await act(async () => { await expect(read().open('missing')).rejects.toThrow('unavailable'); });
  await act(async () => { dispatchEvent(new StorageEvent('storage', { key: `agent-remote:recovery:${scope}:shared-window:${id}`, newValue: null })); });
  expect(read().window?.id).not.toBe(id);
  expect(read().window?.views).toEqual([createWindowView('main', undefined, 'primary')]);
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

it('blocks deleted Window edits during empty replacement creation and after creation fails', async () => {
  const original: WorkspaceWindow = { schemaVersion: 1, id: 'replacement-pending', revision: 0, title: 'Old', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  history.replaceState(null, '', `/?window=${original.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([original]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: original });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockResolvedValue(undefined);
  let fail!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new WindowRequestError('Replacement refused', 403)); }));
  const read = await mount('https://pending-empty.example/', true);
  let pending!: Promise<void>;
  await act(async () => { pending = read().remove(); await vi.waitFor(() => expect(fail).toBeDefined()); });
  expect(read().unavailable).toBe(true);
  expect(read().authority).toBeUndefined();
  await expect(read().operate({ type: 'rename', title: 'Cannot edit deleted Window' })).rejects.toThrow();
  await act(async () => { fail(); await expect(pending).rejects.toThrow('Replacement refused'); });
  expect(read().unavailable).toBe(true);
  expect(read().authority).toBeUndefined();
}, 10000);

it.each(['unknown', 'committed'] as const)('settles an earlier %s creation without replay or adopting its layout during deletion recovery', async outcome => {
  const scope = `https://${outcome}-prior-create.example/`;
  const original: WorkspaceWindow = { schemaVersion: 1, id: 'selected-A', revision: 0, title: 'A', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  const prior = { ...original, id: 'unknown-C', views: [...original.views, createWindowView('unrelated-dock')] };
  const request = { window: prior, operationId: 'prior-create', issuedAt: Date.now() };
  sessionStorage.setItem(`agent-remote:recovery:${scope}:shared-window:pending-create`, JSON.stringify({ request, bindings: [] }));
  history.replaceState(null, '', `/?window=${original.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([original]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: original });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockResolvedValue(undefined);
  const recover = vi.spyOn(WindowWorkspaceClient.prototype, 'recoverCreate');
  if (outcome === 'unknown') recover.mockRejectedValue(new WindowMutationUnknownError(prior.id, request, new Error('Unavailable receipt')));
  else recover.mockResolvedValue({ window: prior });
  const create = vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => ({ window }));
  const read = await mount(scope, true);
  if (outcome === 'unknown') {
    await act(async () => { await expect(read().remove()).rejects.toMatchObject({ name: 'WindowMutationUnknownError' }); });
    expect(create).not.toHaveBeenCalled(); expect(read().unavailable).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window:pending-create`)!)).toMatchObject({ request });
  } else {
    await act(async () => read().remove());
    expect(create).toHaveBeenCalledTimes(1);
    expect(read().window?.id).not.toBe(prior.id);
    expect(read().window?.views).toEqual([createWindowView('main', undefined, 'primary')]);
    expect(read().windows.map(window => window.id)).toContain(prior.id);
  }
  expect(recover).toHaveBeenCalledWith(prior, request);
}, 10000);

it('keeps an already requested navigation valid while the current Window is replaced after deletion', async () => {
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
  vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(async window => { committed.set(window.id, window); return { window }; });
  const read = await mount('https://pending-navigation.example/', true);
  const pending = read().open(second.id);
  await act(async () => deleteFirst());
  await vi.waitFor(async () => { await act(async () => {}); expect(read().window?.id).not.toBe(first.id); });
  await act(async () => { openSecond(); await pending; });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
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

it('does not select a late empty replacement after the page unmounts', async () => {
  const scope = 'https://unmounted-replacement.example/';
  const original: WorkspaceWindow = { schemaVersion: 1, id: 'unmounted-original', revision: 0, title: 'Original', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
  history.replaceState(null, '', `/?window=${original.id}`);
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([original]);
  vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: original });
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  vi.spyOn(WindowWorkspaceClient.prototype, 'delete').mockResolvedValue(undefined);
  let complete!: () => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'create').mockImplementation(window => new Promise(resolve => { complete = () => resolve({ window }); }));
  const read = await mount(scope, true);
  let pending!: Promise<void>;
  await act(async () => { pending = read().remove(); });
  expect(complete).toBeDefined();
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => { complete(); await pending; });
  expect(new URL(location.href).searchParams.get('window')).toBe(original.id);
  expect(sessionStorage.getItem(`agent-remote:recovery:${scope}:shared-window`)).toBe(original.id);
}, 10000);
