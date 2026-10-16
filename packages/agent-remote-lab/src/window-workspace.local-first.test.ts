import { describe, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowMutation, type WindowOperationResult, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, type WindowCommit, type WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { WindowWorkspaceStore } from './window-workspace.js';

const initial = (): WorkspaceWindow => ({ schemaVersion: 2, id: 'local-first-window', title: 'Window', revision: 0,
  selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });
const withDock = (): WorkspaceWindow => ({ ...initial(), views: [...initial().views, createWindowView('dock')] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receipt = (mutation: WindowMutation, window: WorkspaceWindow, code?: string): WindowOperationResult => ({
  operationId: mutation.operationId, status: code ? 'rejected' : 'committed', revision: window.revision,
  committedAt: 1, expiresAt: 100, ...(code ? { code, message: `Rejected: ${code}` } : {}),
});
function remote(source = initial()) {
  let current = source;
  const requests: Array<{ mutation: WindowMutation; response: ReturnType<typeof deferred<WindowCommit>> }> = [];
  const client = {
    mutate(_id: string, mutation: WindowMutation) {
      const response = deferred<WindowCommit>();
      requests.push({ mutation: structuredClone(mutation), response });
      return response.promise;
    },
    async inspect() { return { window: current }; },
    async operation() { throw new WindowRequestError('Receipt unavailable', 404, 'operation_unknown'); },
  };
  return {
    requests, client: client as unknown as WindowWorkspaceClient,
    commit(index: number) {
      const request = requests[index]!;
      current = applyWindowOperation(current, request.mutation.operation);
      request.response.resolve({ window: current, result: receipt(request.mutation, current) });
      return current;
    },
    reject(index: number, code: string, snapshot = current) {
      current = snapshot;
      const request = requests[index]!;
      request.response.resolve({ window: current, result: receipt(request.mutation, current, code) });
    },
  };
}
const requestsReady = (server: ReturnType<typeof remote>, count: number) => vi.waitFor(() => expect(server.requests).toHaveLength(count), { timeout: 1000, interval: 1 });

describe('Window local-first operations', () => {
  it('creates and closes a pane before either background save returns', async () => {
    const server = remote();
    const store = new WindowWorkspaceStore(initial(), server.client);
    const create = store.operate({ type: 'batch', operations: [
      { type: 'view.create', view: createWindowView('new-pane') }, { type: 'view.select', viewId: 'new-pane' },
    ] });
    expect(store.getSnapshot().selectedViewId).toBe('new-pane');
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main', 'new-pane']);
    expect(store.getCommittedSnapshot()).toEqual(initial());
    const close = store.operate({ type: 'view.close', viewId: 'new-pane' });
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main']);
    expect(store.getSnapshot().selectedViewId).toBe('main');
    await requestsReady(server, 1);
    server.commit(0);
    await create;
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main']);
    await requestsReady(server, 2);
    expect(server.requests[1]!.mutation.baseRevision).toBe(1);
    server.commit(1);
    await close;
    expect(store.getCommittedSnapshot().views.map(view => view.id)).toEqual(['main']);
  });

  it('notifies subscribers and caches the visible layout immediately', async () => {
    const server = remote(withDock());
    const cached: WorkspaceWindow[] = [];
    const observed: number[] = [];
    const store = new WindowWorkspaceStore(withDock(), server.client, window => cached.push(window));
    store.subscribe(() => observed.push(store.getSnapshot().views.find(view => view.id === 'dock')!.width));
    const save = store.operate({ type: 'view.resize', viewId: 'dock', width: 720 });
    expect(observed.at(-1)).toBe(720);
    expect(cached.at(-1)?.views.find(view => view.id === 'dock')?.width).toBe(720);
    expect(store.getCommittedSnapshot().views.find(view => view.id === 'dock')?.width).toBe(440);
    await requestsReady(server, 1);
    server.commit(0);
    await save;
  });

  it('preserves a later local edit when an earlier save echoes its older value', async () => {
    const server = remote(withDock());
    const store = new WindowWorkspaceStore(withDock(), server.client);
    const first = store.operate({ type: 'view.resize', viewId: 'dock', width: 600 });
    await requestsReady(server, 1);
    const second = store.operate({ type: 'view.resize', viewId: 'dock', width: 800 });
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(800);
    const older = server.commit(0);
    await first;
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(800);
    expect(store.getCommittedSnapshot().views.find(view => view.id === 'dock')?.width).toBe(600);
    await requestsReady(server, 2);
    server.commit(1);
    await second;
    store.accept(older);
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(800);
    expect(store.getCommittedSnapshot().revision).toBe(2);
  });

  it('rebases pending local fields over unrelated remote changes', async () => {
    const server = remote(withDock());
    const store = new WindowWorkspaceStore(withDock(), server.client);
    const save = store.operate({ type: 'rename', title: 'Local title' });
    void save.catch(() => {});
    await requestsReady(server, 1);
    const incoming = applyWindowOperation(withDock(), { type: 'batch', operations: [
      { type: 'rename', title: 'Other page title' }, { type: 'view.resize', viewId: 'dock', width: 910 },
    ] });
    store.accept(incoming);
    expect(store.getSnapshot().title).toBe('Local title');
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(910);
    expect(store.getCommittedSnapshot()).toEqual(incoming);
    server.reject(0, 'revision_conflict', incoming);
    await requestsReady(server, 2);
    server.commit(1);
    await save;
    expect(store.getSnapshot().title).toBe('Local title');
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(910);
  });

  it('does not enqueue repeated selection of the already selected uncollapsed pane', async () => {
    const server = remote(withDock());
    const store = new WindowWorkspaceStore(withDock(), server.client);
    const unchanged = store.operate({ type: 'view.select', viewId: 'main' });
    await Promise.resolve();
    expect(server.requests).toHaveLength(0);
    await unchanged;
    const select = store.operate({ type: 'view.select', viewId: 'dock' });
    expect(store.getSnapshot().selectedViewId).toBe('dock');
    const again = store.operate({ type: 'view.select', viewId: 'dock' });
    await requestsReady(server, 1);
    server.commit(0);
    await Promise.all([select, again]);
    expect(server.requests).toHaveLength(1);
    expect(store.getCommittedSnapshot().selectedViewId).toBe('dock');
  });

  it('removes only a definitively rejected operation while preserving later local work', async () => {
    const server = remote(withDock());
    const store = new WindowWorkspaceStore(withDock(), server.client);
    const rename = store.operate({ type: 'rename', title: 'Rejected title' });
    const rejected = expect(rename).rejects.toThrow('rename_forbidden');
    const resize = store.operate({ type: 'view.resize', viewId: 'dock', width: 730 });
    expect(store.getSnapshot().title).toBe('Rejected title');
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(730);
    await requestsReady(server, 1);
    server.reject(0, 'rename_forbidden');
    await rejected;
    expect(store.getSnapshot().title).toBe('Window');
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(730);
    await requestsReady(server, 2);
    expect(server.requests[1]!.mutation.baseRevision).toBe(0);
    server.commit(1);
    await resize;
  });

  it('retries a definitively rejected revision with a fresh identity and current base', async () => {
    const server = remote();
    const store = new WindowWorkspaceStore(initial(), server.client);
    const save = store.operate({ type: 'rename', title: 'My title' });
    void save.catch(() => {});
    await requestsReady(server, 1);
    const incoming = applyWindowOperation(initial(), { type: 'view.create', view: createWindowView('remote-pane') });
    server.reject(0, 'revision_conflict', incoming);
    await requestsReady(server, 2);
    expect(server.requests[1]!.mutation).toMatchObject({ baseRevision: 1, operation: { type: 'rename', title: 'My title' } });
    expect(server.requests[1]!.mutation.operationId).not.toBe(server.requests[0]!.mutation.operationId);
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main', 'remote-pane']);
    expect(store.getSnapshot().title).toBe('My title');
    server.commit(1);
    await save;
    expect(store.getCommittedSnapshot()).toMatchObject({ revision: 2, title: 'My title' });
  });

  it('settles a lost reply by its receipt without replaying the completed operation', async () => {
    const server = remote(withDock());
    const committed = deferred<WindowOperationResult>();
    server.client.operation = () => committed.promise;
    const store = new WindowWorkspaceStore(withDock(), server.client);
    const create = store.operate({ type: 'view.create', view: createWindowView('one-pane') });
    void create.catch(() => {});
    await requestsReady(server, 1);
    const current = applyWindowOperation(withDock(), server.requests[0]!.mutation.operation);
    server.client.inspect = async () => ({ window: current });
    server.requests[0]!.response.reject(new Error('Reply lost'));
    committed.resolve(receipt(server.requests[0]!.mutation, current));
    await create;
    expect(server.requests).toHaveLength(1);
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main', 'dock', 'one-pane']);
    expect(store.getCommittedSnapshot()).toEqual(current);
  });

  it('retains offline edits and retries an unknown outcome with the exact original request', async () => {
    let online = false;
    let current = withDock();
    const requests: WindowMutation[] = [];
    const receiptFailures = deferred<void>();
    const client = {
      async mutate(_id: string, mutation: WindowMutation) {
        requests.push(structuredClone(mutation));
        if (!online) throw new Error('Offline');
        current = applyWindowOperation(current, mutation.operation);
        return { window: current, result: receipt(mutation, current) };
      },
      async operation() { receiptFailures.resolve(); throw new WindowRequestError('Receipt unavailable', 404, 'operation_unknown'); },
      async inspect() { return { window: current }; },
    };
    const store = new WindowWorkspaceStore(withDock(), client as unknown as WindowWorkspaceClient);
    const rename = store.operate({ type: 'rename', title: 'Offline title' });
    let settled = false;
    void rename.then(() => { settled = true; }, () => { settled = true; });
    await receiptFailures.promise;
    await vi.waitFor(() => expect(store.getSyncState().state).toBe('offline'), { timeout: 1000, interval: 1 });
    expect(settled).toBe(false);
    expect(store.getSnapshot().title).toBe('Offline title');
    expect(store.getCommittedSnapshot().title).toBe('Window');
    const resize = store.operate({ type: 'view.resize', viewId: 'dock', width: 760 });
    void resize.catch(() => {});
    expect(store.getSnapshot().views.find(view => view.id === 'dock')?.width).toBe(760);
    online = true;
    await store.retry();
    await vi.waitFor(() => expect(store.getCommittedSnapshot()).toMatchObject({ revision: 2, title: 'Offline title' }), { timeout: 1000, interval: 1 });
    expect(store.getCommittedSnapshot().views.find(view => view.id === 'dock')?.width).toBe(760);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]!.baseRevision).toBe(1);
    expect(requests[2]!.operationId).not.toBe(requests[0]!.operationId);
    await Promise.all([rename, resize]);
    expect(store.getSyncState()).toMatchObject({ state: 'saved', pending: 0 });
  });

  it('keeps a locally closed pane closed while an unknown outcome receives a newer remote snapshot', async () => {
    const server = remote(withDock());
    let current = withDock();
    let online = false;
    const store = new WindowWorkspaceStore(withDock(), server.client);
    server.client.operation = async () => { throw new WindowRequestError('Receipt unavailable', 404, 'operation_unknown'); };
    server.client.inspect = async () => ({ window: current });
    const close = store.operate({ type: 'view.close', viewId: 'dock' });
    void close.catch(() => {});
    await requestsReady(server, 1);
    server.requests[0]!.response.reject(new Error('Connection lost'));
    await vi.waitFor(() => expect(store.getSyncState().state).toBe('offline'), { timeout: 1000, interval: 1 });
    current = applyWindowOperation(withDock(), { type: 'rename', title: 'Remote title' });
    store.accept(current);
    expect(store.getSnapshot().views.map(view => view.id)).toEqual(['main']);
    expect(store.getSnapshot().title).toBe('Remote title');
    expect(store.getCommittedSnapshot()).toEqual(current);
    expect(store.getSyncState().pending).toBe(1);
    const savedIdentity = server.requests[0]!.mutation;
    server.client.mutate = async (_id, mutation) => {
      server.requests.push({ mutation: structuredClone(mutation), response: deferred<WindowCommit>() });
      if (!online) throw new Error('Offline');
      if (mutation.baseRevision !== current.revision) return { window: current, result: receipt(mutation, current, 'revision_conflict') };
      current = applyWindowOperation(current, mutation.operation);
      return { window: current, result: receipt(mutation, current) };
    };
    online = true;
    await store.retry();
    await close;
    expect(server.requests[1]!.mutation).toEqual(savedIdentity);
    expect(server.requests[2]!.mutation.operationId).not.toBe(savedIdentity.operationId);
    expect(server.requests[2]!.mutation.baseRevision).toBe(1);
    expect(store.getCommittedSnapshot().views.map(view => view.id)).toEqual(['main']);
    expect(store.getCommittedSnapshot().title).toBe('Remote title');
  });
});
