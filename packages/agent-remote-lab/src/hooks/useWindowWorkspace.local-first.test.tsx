import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient, WindowRequestError, type WindowCommit, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import { applyWindowOperation, createWindowView, type WindowMutation, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument } from '../session-composition.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function windowFixture(id: string): WorkspaceWindow {
  return { schemaVersion: 2, id, revision: 0, title: id, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', undefined, 'primary'), createWindowView('dock')] };
}
function saveCache(scope: string, window: WorkspaceWindow) {
  const key = `agent-remote:recovery:${scope}:shared-window`;
  localStorage.setItem(`${key}:${window.id}`, JSON.stringify(window));
  return key;
}
async function mount(scope: string, hosted = true) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const composition = createCompositionDocument(scope);
  let current!: ReturnType<typeof useWindowWorkspace>;
  function Harness() { current = useWindowWorkspace(scope, hosted, true, composition); return null; }
  await act(async () => root!.render(<Harness />));
  return () => current;
}
function hostedWindows(...windows: WorkspaceWindow[]) {
  const documents = new Map(windows.map(window => [window.id, window]));
  const requests: Array<{ id: string; mutation: WindowMutation; response: ReturnType<typeof deferred<WindowCommit>> }> = [];
  vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockImplementation(async () => [...documents.values()]);
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: documents.get(id)! }));
  const changes = vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const mutation = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation((id, mutation) => {
    const response = deferred<WindowCommit>();
    requests.push({ id, mutation: structuredClone(mutation), response });
    return response.promise;
  });
  const operation = vi.spyOn(WindowWorkspaceClient.prototype, 'operation').mockRejectedValue(new WindowRequestError('Receipt not found', 404, 'operation_unknown'));
  return {
    documents, requests, inspect, changes, mutation, operation,
    commit(index: number) {
      const request = requests[index]!;
      const window = applyWindowOperation(documents.get(request.id)!, request.mutation.operation);
      documents.set(window.id, window);
      request.response.resolve({ window, result: { operationId: request.mutation.operationId, status: 'committed', revision: window.revision,
        committedAt: Date.now(), expiresAt: Date.now() + 86400000 } });
      return window;
    },
  };
}
async function until(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 1000, interval: 1 });
}

it('edits a cached Window while hosted inspection remains pending', async () => {
  const scope = 'https://local-first-cache.example/';
  const cached = windowFixture('cached');
  const key = saveCache(scope, cached);
  history.replaceState(null, '', `/?window=${cached.id}`);
  const server = hostedWindows(cached);
  const inspection = deferred<WindowSnapshot>();
  server.inspect.mockImplementation(() => inspection.promise);
  const read = await mount(scope);
  expect(read().window).toEqual(cached);
  let pending!: Promise<void>;
  await act(async () => { pending = read().operate({ type: 'view.create', view: createWindowView('immediate') }); void pending.catch(() => {}); });
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock', 'immediate']);
  expect(read().hasActiveWindow).toBe(false);
  expect(read().error).toBeUndefined();
  expect(JSON.parse(sessionStorage.getItem(`${key}:pending:${cached.id}`)!).edits).toMatchObject([
    { operation: { type: 'view.create', view: { id: 'immediate' } } },
  ]);
  await act(async () => inspection.resolve({ window: cached }));
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock', 'immediate']);
  await until(() => expect(server.requests).toHaveLength(1));
  await act(async () => { server.commit(0); await pending; });
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock', 'immediate']);
});

it.each(['create', 'close'] as const)('restores a pending pane %s after reload without changing its mutation identity', async action => {
  const scope = `https://local-first-reload-${action}.example/`;
  const committed = windowFixture('recover');
  const operation: WindowOperation = action === 'create'
    ? { type: 'view.create', view: createWindowView('recovered-pane') }
    : { type: 'view.close', viewId: 'dock' };
  const projected = applyWindowOperation(committed, operation);
  const key = saveCache(scope, projected);
  const original: WindowMutation = { operationId: `original-${action}`, issuedAt: Date.now(), baseRevision: committed.revision, operation };
  sessionStorage.setItem(`${key}:pending:${committed.id}`, JSON.stringify({ version: 1, committed,
    edits: [{ operation, revision: committed.revision, mutation: original, uncertain: true }] }));
  history.replaceState(null, '', `/?window=${committed.id}`);
  const server = hostedWindows(committed);
  const inspection = deferred<WindowSnapshot>();
  server.inspect.mockImplementation(() => inspection.promise);
  const read = await mount(scope);
  expect(read().window?.views).toEqual(projected.views);
  await act(async () => inspection.resolve({ window: committed }));
  expect(read().window?.views).toEqual(projected.views);
  await until(() => expect(server.requests).toHaveLength(1));
  expect(server.operation).toHaveBeenCalledWith(committed.id, original.operationId);
  expect(server.requests[0]).toMatchObject({ id: committed.id, mutation: original });
  expect(JSON.parse(sessionStorage.getItem(`${key}:pending:${committed.id}`)!).edits[0].mutation).toEqual(original);
  await act(async () => { server.commit(0); });
  await until(() => {
    expect(read().window?.views).toEqual(projected.views);
    const recovered = JSON.parse(sessionStorage.getItem(`${key}:pending:${committed.id}`) ?? 'null');
    expect(recovered?.edits ?? []).toEqual([]);
  });
  expect(server.requests).toHaveLength(1);
});

it('reuses the pending Window store across cached switches and does not duplicate its save', async () => {
  const scope = 'https://local-first-switch.example/';
  const first = windowFixture('first'), second = windowFixture('second');
  saveCache(scope, first); saveCache(scope, second);
  history.replaceState(null, '', `/?window=${first.id}`);
  const server = hostedWindows(first, second);
  const read = await mount(scope);
  let create!: Promise<void>, close!: Promise<void>;
  await act(async () => { create = read().operate({ type: 'view.create', view: createWindowView('temporary') }); void create.catch(() => {}); });
  expect(read().window?.views.at(-1)?.id).toBe('temporary');
  await until(() => expect(server.requests).toHaveLength(1));
  const original = server.requests[0]!.mutation;
  const inspections = new Map<string, ReturnType<typeof deferred<WindowSnapshot>>>();
  server.inspect.mockImplementation(id => {
    let inspection = inspections.get(id);
    if (!inspection) { inspection = deferred<WindowSnapshot>(); inspections.set(id, inspection); }
    return inspection.promise;
  });
  let openSecond!: Promise<void>, openFirst!: Promise<void>;
  await act(async () => { openSecond = read().open(second.id); void openSecond.catch(() => {}); });
  expect(read().window?.id).toBe(second.id);
  expect(read().window?.views).toEqual(second.views);
  await act(async () => { openFirst = read().open(first.id); void openFirst.catch(() => {}); });
  expect(read().window?.id).toBe(first.id);
  expect(read().window?.views.at(-1)?.id).toBe('temporary');
  expect(server.requests).toHaveLength(1);
  await act(async () => { close = read().operate({ type: 'view.close', viewId: 'temporary' }); void close.catch(() => {}); });
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock']);
  await act(async () => {
    for (const [id, inspection] of inspections) inspection.resolve({ window: server.documents.get(id)! });
  });
  await Promise.all([openSecond, openFirst]);
  expect(server.requests[0]!.mutation).toEqual(original);
  await act(async () => { server.commit(0); await create; });
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock']);
  await until(() => expect(server.requests).toHaveLength(2));
  expect(server.requests[1]!.mutation).toMatchObject({ baseRevision: 1, operation: { type: 'view.close', viewId: 'temporary' } });
  await act(async () => { server.commit(1); await close; });
  expect(read().window?.views.map(view => view.id)).toEqual(['main', 'dock']);
});

it('keeps the selected cached Window when another Window finishes saving in the background', async () => {
  const scope = 'https://local-first-background.example/';
  const first = windowFixture('first'), second = windowFixture('second');
  const key = saveCache(scope, first); saveCache(scope, second);
  history.replaceState(null, '', `/?window=${first.id}`);
  const server = hostedWindows(first, second);
  const read = await mount(scope);
  let save!: Promise<void>;
  await act(async () => { save = read().operate({ type: 'rename', title: 'Background title' }); void save.catch(() => {}); });
  await until(() => expect(server.requests).toHaveLength(1));
  const inspection = deferred<WindowSnapshot>();
  server.inspect.mockImplementation(id => id === second.id ? inspection.promise : Promise.resolve({ window: server.documents.get(id)! }));
  let open!: Promise<void>;
  await act(async () => { open = read().open(second.id); void open.catch(() => {}); });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  await act(async () => { server.commit(0); await save; });
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  expect(sessionStorage.getItem(key)).toBe(second.id);
  expect(JSON.parse(localStorage.getItem(`${key}:${first.id}`)!)).toMatchObject({ title: 'Background title', revision: 1 });
  await act(async () => { inspection.resolve({ window: second }); await open; });
  expect(read().window?.id).toBe(second.id);
  expect(read().window?.title).toBe(second.title);
});

it('resumes a different Window pending journal after reload without selecting that Window', async () => {
  const scope = 'https://local-first-background-reload.example/';
  const first = windowFixture('background'), second = windowFixture('selected');
  const key = saveCache(scope, first); saveCache(scope, second);
  const operation: WindowOperation = { type: 'rename', title: 'Recovered background title' };
  const original: WindowMutation = { operationId: 'background-original', issuedAt: Date.now(), baseRevision: first.revision, operation };
  sessionStorage.setItem(`${key}:pending:${first.id}`, JSON.stringify({ version: 1, committed: first,
    edits: [{ operation, revision: first.revision, mutation: original, uncertain: true }] }));
  history.replaceState(null, '', `/?window=${second.id}`);
  const server = hostedWindows(first, second);
  const read = await mount(scope);
  expect(read().window?.id).toBe(second.id);
  await until(() => expect(server.requests).toHaveLength(1));
  expect(server.requests[0]).toMatchObject({ id: first.id, mutation: original });
  expect(server.operation).toHaveBeenCalledWith(first.id, original.operationId);
  expect(read().window?.id).toBe(second.id);
  expect(new URL(location.href).searchParams.get('window')).toBe(second.id);
  await act(async () => { server.commit(0); });
  await until(() => expect(JSON.parse(localStorage.getItem(`${key}:${first.id}`)!)).toMatchObject({ title: 'Recovered background title', revision: 1 }));
  expect(read().window?.id).toBe(second.id);
  expect(sessionStorage.getItem(key)).toBe(second.id);
  expect(JSON.parse(sessionStorage.getItem(`${key}:pending:${first.id}`) ?? 'null')?.edits ?? []).toEqual([]);
});

it('does not promote a pending local snapshot to a committed revision when switching back', async () => {
  const scope = 'local-first-pending-revision';
  const first = windowFixture('local-first'), second = windowFixture('local-second');
  const key = saveCache(scope, first); saveCache(scope, second);
  history.replaceState(null, '', `/?window=${first.id}`);
  const read = await mount(scope, false);
  const release = deferred<void>();
  vi.stubGlobal('navigator', { locks: { async request(_name: string, commit: () => Promise<unknown>) { await release.promise; return commit(); } } });
  let pending!: Promise<void>;
  await act(async () => { pending = read().operate({ type: 'rename', title: 'Pending local title' }); void pending.catch(() => {}); });
  try {
    expect(read().window).toMatchObject({ revision: 1, title: 'Pending local title' });
    await act(async () => read().open(second.id));
    await act(async () => read().open(first.id));
    expect(read().window).toMatchObject({ revision: 1, title: 'Pending local title' });
    expect(JSON.parse(localStorage.getItem(`${key}:${first.id}`)!)).toMatchObject({ revision: 0, title: first.title });
  } finally {
    await act(async () => { release.resolve(); await pending; });
  }
  expect(read().window).toMatchObject({ revision: 1, title: 'Pending local title' });
});

it('settles a lost HTTP save response by its receipt while the pane stays immediately visible', async () => {
  let current = windowFixture('http-window');
  const writes: WindowMutation[] = [];
  const receiptReads: string[] = [];
  const releaseReply = deferred<void>();
  const server = createServer(async (request, response) => {
    const path = request.url!;
    if (path.includes('/changes?')) return;
    if (request.method === 'POST' && path.endsWith('/operations')) {
      let body = ''; for await (const part of request) body += String(part);
      const mutation: WindowMutation = JSON.parse(body);
      writes.push(mutation); current = applyWindowOperation(current, mutation.operation);
      await releaseReply.promise; response.destroy(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path.includes('/operations/')) {
      const operationId = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)); receiptReads.push(operationId);
      response.end(JSON.stringify({ result: { operationId, status: 'committed', revision: current.revision,
        committedAt: Date.now(), expiresAt: Date.now() + 86400000 } })); return;
    }
    response.end(JSON.stringify(path === '/v1/windows' ? { windows: [current] } : { window: current }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const scope = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const key = saveCache(scope, current);
  history.replaceState(null, '', `/?window=${current.id}`);
  try {
    const read = await mount(scope);
    await until(() => expect(read().hasActiveWindow).toBe(true));
    let save!: Promise<void>;
    await act(async () => { save = read().operate({ type: 'view.create', view: createWindowView('instant-http-pane') }); void save.catch(() => {}); });
    expect(read().window?.views.at(-1)?.id).toBe('instant-http-pane');
    await until(() => expect(writes).toHaveLength(1));
    expect(receiptReads).toEqual([]);
    expect(read().window?.views.at(-1)?.id).toBe('instant-http-pane');
    await act(async () => { releaseReply.resolve(); await save; });
    expect(writes).toHaveLength(1);
    expect(receiptReads).toEqual([writes[0]!.operationId]);
    expect(read().window?.views.filter(view => view.id === 'instant-http-pane')).toHaveLength(1);
    const saved = JSON.parse(sessionStorage.getItem(`${key}:pending:${current.id}`) ?? 'null');
    expect(saved?.edits ?? []).toEqual([]);
  } finally {
    releaseReply.resolve();
    if (root) await act(async () => root!.unmount()); root = undefined;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);
