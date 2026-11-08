import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient, WindowRequestError, type WindowCommit, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import { applyWindowOperation, createWindowView, type WindowGroup, type WindowMutation, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
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
  return { schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: 'main', selectedViewId: 'main',
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
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(async () => [...documents.values()].map(window => ({ window })));
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => ({ window: documents.get(id)! }));
  const changes = vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const mutation = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation((id, mutation) => {
    const response = deferred<WindowCommit>();
    requests.push({ id, mutation: structuredClone(mutation) as WindowMutation, response });
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

it('retains a local section-only catalog without restoring it as the default Window', async () => {
  const scope = 'local-section-only-default', section: WindowGroup = {
    window: windowFixture('section'), bots: { rank: 'm', members: {} }, presentation: { window: false },
  };
  const key = saveCache(scope, section.window);
  localStorage.setItem(`${key}:${section.window.id}`, JSON.stringify(section));
  const read = await mount(scope, false);
  expect(read().window?.id).not.toBe(section.window.id);
  expect(read().hasActiveWindow).toBe(true);
  expect(read().groups.find(group => group.window.id === section.window.id)).toEqual(section);
  expect(read().windows.map(window => window.id)).not.toContain(section.window.id);
});

it.each(['session', 'local'] as const)('skips a saved section-only %s preference when restoring a local Window', async preference => {
  const scope = `local-section-preference-${preference}`, section: WindowGroup = {
    window: windowFixture('section'), bots: { rank: 'm', members: {} }, presentation: { window: false },
  }, window = windowFixture('window');
  const key = saveCache(scope, section.window); saveCache(scope, window);
  localStorage.setItem(`${key}:${section.window.id}`, JSON.stringify(section));
  if (preference === 'session') sessionStorage.setItem(key, section.window.id);
  else localStorage.setItem(`${key}:last-window`, section.window.id);
  const read = await mount(scope, false);
  expect(read().window?.id).toBe(window.id);
  expect(read().groups.map(group => group.window.id).sort()).toEqual(['section', 'window']);
  expect(read().windows.map(window => window.id)).toEqual(['window']);
});

it('skips a hosted section-only cache before and after the catalog responds', async () => {
  const scope = 'https://section-cache-default.example/', section: WindowGroup = {
    window: windowFixture('section'), bots: { rank: 'm', members: {} }, presentation: { window: false },
  }, window = windowFixture('window');
  const key = saveCache(scope, section.window);
  localStorage.setItem(`${key}:${section.window.id}`, JSON.stringify(section));
  localStorage.setItem(`${key}:last-window`, section.window.id);
  hostedWindows(window);
  const catalog = deferred<WindowGroup[]>();
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockReturnValue(catalog.promise);
  const read = await mount(scope);
  expect(read().window).toBeUndefined();
  expect(new URL(location.href).searchParams.get('window')).toBeNull();
  await act(async () => catalog.resolve([section, { window }]));
  await until(() => expect(read().window?.id).toBe(window.id));
  expect(read().groups.map(group => group.window.id).sort()).toEqual(['section', 'window']);
  expect(read().windows.map(window => window.id)).toEqual(['window']);
});

it('keeps a section-only preference closed when hosted catalog recovery fails', async () => {
  const scope = 'https://section-cache-offline.example/', section: WindowGroup = {
    window: windowFixture('section'), bots: { rank: 'm', members: {} }, presentation: { window: false },
  };
  const key = saveCache(scope, section.window);
  localStorage.setItem(`${key}:${section.window.id}`, JSON.stringify(section));
  sessionStorage.setItem(key, section.window.id);
  const catalog = deferred<WindowGroup[]>();
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockReturnValue(catalog.promise);
  const read = await mount(scope);
  expect(read().window).toBeUndefined();
  await act(async () => catalog.reject(new Error('Catalog offline')));
  expect(read().window).toBeUndefined();
  expect(read().error).toBe('Catalog offline');
  expect(localStorage.getItem(`${key}:${section.window.id}`)).not.toBeNull();
});

it.each([false, true])('preserves explicit section-only Window routes (hosted: %s)', async hosted => {
  const scope = `explicit-section-${hosted}`, section: WindowGroup = {
    window: windowFixture('section'), bots: { rank: 'm', members: {} }, presentation: { window: false },
  };
  const key = saveCache(scope, section.window);
  localStorage.setItem(`${key}:${section.window.id}`, JSON.stringify(section));
  history.replaceState(null, '', `/?window=${section.window.id}`);
  if (hosted) {
    hostedWindows(section.window);
    vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([section]);
    vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue(section);
  }
  const read = await mount(scope, hosted);
  expect(read().group).toEqual(section);
  expect(read().window?.id).toBe(section.window.id);
  expect(read().windows).toEqual([]);
});

it('accepts a fresher catalog appearance without discarding a background v1 journal edit', async () => {
  const scope = 'https://background-fresh-catalog.example/', selected = windowFixture('selected'), background = windowFixture('background');
  const key = saveCache(scope, selected); saveCache(scope, background);
  const operation = { type: 'rename', title: 'Unconfirmed title' };
  const mutation = { operationId: 'original-rename', issuedAt: Date.now(), baseRevision: 0, operation };
  sessionStorage.setItem(`${key}:pending:${background.id}`, JSON.stringify({ version: 1, committed: background,
    edits: [{ operation, revision: 0, mutation, uncertain: true }] }));
  const section: WindowGroup = { window: { ...background, revision: 2, title: 'Server section' },
    bots: { rank: 'm', members: {} }, presentation: { window: false } };
  history.replaceState(null, '', `/?window=${selected.id}`);
  hostedWindows(selected, background);
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([{ window: selected }, section]);
  const receipt = deferred<Awaited<ReturnType<WindowWorkspaceClient['operation']>>>();
  vi.spyOn(WindowWorkspaceClient.prototype, 'operation').mockReturnValue(receipt.promise);
  const read = await mount(scope);
  expect(read().window?.id).toBe(selected.id);
  expect(read().groups.find(group => group.window.id === background.id)).toMatchObject({
    window: { revision: 3, title: 'Unconfirmed title' }, presentation: { window: false }, bots: { rank: 'm' },
  });
  expect(read().windows.map(window => window.id)).toEqual(['selected']);
  const journal = JSON.parse(sessionStorage.getItem(`${key}:pending:${background.id}`)!);
  expect(journal.committed).toEqual(section);
  expect(journal.edits[0].mutation).toEqual(mutation);
  expect(journal.edits[0].uncertain).toBe(true);
});

it('updates the catalog when a background v1 journal recovers a section-only group', async () => {
  const scope = 'https://background-recovered-appearance.example/', selected = windowFixture('selected'), background = windowFixture('background');
  const key = saveCache(scope, selected); saveCache(scope, background);
  const operation = { type: 'rename', title: 'Unconfirmed title' };
  sessionStorage.setItem(`${key}:pending:${background.id}`, JSON.stringify({ version: 1, committed: background,
    edits: [{ operation, revision: 0, mutation: { operationId: 'original-rename', issuedAt: Date.now(), baseRevision: 0, operation }, uncertain: true }] }));
  history.replaceState(null, '', `/?window=${selected.id}`);
  const server = hostedWindows(selected, background);
  const section: WindowGroup = { window: { ...background, revision: 2, title: 'Recovered section' },
    bots: { rank: 'm', members: {} }, presentation: { window: false } };
  server.inspect.mockImplementation(async id => id === background.id ? section : { window: selected });
  const receipt = deferred<Awaited<ReturnType<WindowWorkspaceClient['operation']>>>();
  server.operation.mockReturnValue(receipt.promise);
  const read = await mount(scope);
  expect(read().windows.map(window => window.id).sort()).toEqual(['background', 'selected']);
  await act(async () => receipt.resolve({ operationId: 'original-rename', status: 'committed', revision: 1, committedAt: 1, expiresAt: Date.now() + 86400000 }));
  await until(() => expect(sessionStorage.getItem(`${key}:pending:${background.id}`)).toBeNull());
  expect(read().window?.id).toBe(selected.id);
  expect(read().groups.find(group => group.window.id === background.id)).toEqual(section);
  expect(read().windows.map(window => window.id)).toEqual(['selected']);
  expect(JSON.parse(localStorage.getItem(`${key}:${background.id}`)!)).toEqual(section);
});

it('restores a Window to the catalog when its appearance removal is refused after switching away', async () => {
  const scope = 'https://background-refused-appearance.example/', first = windowFixture('first'), second = windowFixture('second');
  const group: WindowGroup = { window: first, bots: { rank: 'm', members: {} } };
  history.replaceState(null, '', `/?window=${first.id}`);
  const server = hostedWindows(first, second);
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockResolvedValue([group, { window: second }]);
  server.inspect.mockImplementation(async id => id === first.id ? group : { window: second });
  const read = await mount(scope);
  let pending!: Promise<void>;
  await act(async () => { pending = read().operate({ type: 'window.remove' }); void pending.catch(() => {}); });
  expect(read().windows.map(window => window.id)).toEqual(['second']);
  await act(async () => read().open(second.id));
  const request = server.requests[0]!;
  await act(async () => {
    request.response.resolve({ ...group, result: { operationId: request.mutation.operationId, status: 'rejected', revision: first.revision,
      code: 'last_appearance', message: 'Appearance removal refused', committedAt: 1, expiresAt: Date.now() + 86400000 } });
    await expect(pending).rejects.toThrow('Appearance removal refused');
  });
  expect(read().window?.id).toBe(second.id);
  expect(read().groups.find(item => item.window.id === first.id)).toEqual(group);
  expect(read().windows.map(window => window.id).sort()).toEqual(['first', 'second']);
});

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
  expect(JSON.parse(localStorage.getItem(`${key}:${first.id}`)!)).toMatchObject({ window: { title: 'Background title', revision: 1 } });
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
  await until(() => expect(JSON.parse(localStorage.getItem(`${key}:${first.id}`)!)).toMatchObject({ window: { title: 'Recovered background title', revision: 1 } }));
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
    // The local workbench never re-caches this Window, so it keeps the bare layout saveCache wrote before groups.
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
