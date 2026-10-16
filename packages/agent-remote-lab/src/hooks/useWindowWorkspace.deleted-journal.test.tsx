import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient, WindowRequestError, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument } from '../session-composition.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); container = undefined;
  vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});
const windowFixture = (id: string): WorkspaceWindow => ({ schemaVersion: 2, id, revision: 0, title: id,
  selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });
const journalKey = (scope: string, id: string) => `agent-remote:recovery:${scope}:shared-window:pending:${id}`;
const cacheKey = (scope: string, id: string) => `agent-remote:recovery:${scope}:shared-window:${id}`;
function save(scope: string, selected: WorkspaceWindow, background: WorkspaceWindow) {
  for (const window of [selected, background]) localStorage.setItem(cacheKey(scope, window.id), JSON.stringify(window));
  const operation = { type: 'rename', title: 'Unconfirmed background title' };
  sessionStorage.setItem(journalKey(scope, background.id), JSON.stringify({ version: 1, committed: background, edits: [{ operation,
    revision: 0, mutation: { operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: 0, operation }, uncertain: true }] }));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function remote(selected: WorkspaceWindow) {
  const list = vi.spyOn(WindowWorkspaceClient.prototype, 'list').mockResolvedValue([selected]);
  const inspect = vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockResolvedValue({ window: selected });
  const operation = vi.spyOn(WindowWorkspaceClient.prototype, 'operation').mockRejectedValue(new WindowRequestError('Receipt expired.', 410, 'operation_expired'));
  const mutate = vi.spyOn(WindowWorkspaceClient.prototype, 'mutate');
  vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  return { list, inspect, operation, mutate };
}
async function mount(scope: string) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const documents = new Map<string, ReturnType<typeof createCompositionDocument>>();
  let current!: ReturnType<typeof useWindowWorkspace>;
  function Harness({ scope }: { scope: string }) {
    let document = documents.get(scope);
    if (!document) { document = createCompositionDocument(scope); documents.set(scope, document); }
    current = useWindowWorkspace(scope, true, true, document);
    return null;
  }
  const changeScope = async (scope: string) => { await act(async () => root!.render(<Harness scope={scope} />)); };
  await changeScope(scope);
  return { read: () => current, changeScope };
}
async function until(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 1000, interval: 1 });
}

it('cleans a confirmed deleted background journal without delaying the current Window', async () => {
  const scope = 'https://deleted-background.example/', selected = windowFixture('selected'), deleted = windowFixture('deleted');
  save(scope, selected, deleted); history.replaceState(null, '', `/?window=${selected.id}`);
  const server = remote(selected), background = deferred<WindowSnapshot>();
  server.inspect.mockImplementation(id => id === deleted.id ? background.promise : Promise.resolve({ window: selected }));
  const page = await mount(scope);
  expect(server.operation).toHaveBeenCalledWith(deleted.id, expect.any(String));
  await until(() => expect(server.inspect).toHaveBeenCalledWith(deleted.id));
  expect(page.read().window?.id).toBe(selected.id);
  expect(page.read().hasActiveWindow).toBe(true);
  expect(sessionStorage.getItem(journalKey(scope, deleted.id))).not.toBeNull();
  await act(async () => background.reject(new WindowRequestError('Window was deleted.', 404, 'window_not_found')));
  await until(() => expect(sessionStorage.getItem(journalKey(scope, deleted.id))).toBeNull());
  expect(localStorage.getItem(cacheKey(scope, deleted.id))).toBeNull();
  expect(page.read().window?.id).toBe(selected.id);
  expect(page.read().deleted).toBe(false);
  expect(page.read().deletedWindowIds).toEqual([deleted.id]);
  expect(server.mutate).not.toHaveBeenCalled();
});

it.each([403, 503, 200])('preserves a missing catalog item until inspect proves deletion (status=%s)', async status => {
  const scope = `https://unconfirmed-background-${status}.example/`, selected = windowFixture('selected'), omitted = windowFixture('omitted');
  save(scope, selected, omitted); history.replaceState(null, '', `/?window=${selected.id}`);
  const server = remote(selected);
  server.inspect.mockImplementation(async id => {
    if (id !== omitted.id) return { window: selected };
    if (status === 200) return { window: omitted };
    throw new WindowRequestError('Inspection unavailable.', status);
  });
  const page = await mount(scope);
  await until(() => expect(server.inspect).toHaveBeenCalledWith(omitted.id));
  expect(sessionStorage.getItem(journalKey(scope, omitted.id))).not.toBeNull();
  expect(localStorage.getItem(cacheKey(scope, omitted.id))).not.toBeNull();
  expect(page.read().window?.id).toBe(selected.id);
  expect(page.read().error).toBeUndefined();
  expect(page.read().deletedWindowIds).toEqual([]);
  expect(server.mutate).not.toHaveBeenCalled();
});

it('ignores a background deletion result from a previous scope', async () => {
  const firstScope = 'https://old-background-scope.example/', secondScope = 'https://new-background-scope.example/';
  const first = windowFixture('first'), second = windowFixture('second'), backgroundWindow = windowFixture('same-background-id');
  save(firstScope, first, backgroundWindow); save(secondScope, second, backgroundWindow);
  history.replaceState(null, '', `/?window=${first.id}`);
  const server = remote(first), background = deferred<WindowSnapshot>();
  server.inspect.mockImplementation(id => id === backgroundWindow.id ? background.promise : Promise.resolve({ window: id === first.id ? first : second }));
  const page = await mount(firstScope);
  await until(() => expect(server.inspect).toHaveBeenCalledWith(backgroundWindow.id));
  server.list.mockResolvedValue([second, backgroundWindow]);
  history.replaceState(null, '', `/?window=${second.id}`);
  await page.changeScope(secondScope);
  expect(page.read().window?.id).toBe(second.id);
  await act(async () => background.reject(new WindowRequestError('Old scope deletion.', 404, 'window_not_found')));
  expect(sessionStorage.getItem(journalKey(secondScope, backgroundWindow.id))).not.toBeNull();
  expect(localStorage.getItem(cacheKey(secondScope, backgroundWindow.id))).not.toBeNull();
  expect(sessionStorage.getItem(journalKey(firstScope, backgroundWindow.id))).not.toBeNull();
  expect(page.read().window?.id).toBe(second.id);
  expect(page.read().deleted).toBe(false);
  expect(page.read().deletedWindowIds).toEqual([]);
});
