import { describe, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowMutation, type WindowOperationResult, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, type WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { WindowWorkspaceStore } from './window-workspace-store.js';

const initial = (): WorkspaceWindow => ({ schemaVersion: 2, id: 'recovery-window', title: 'Before', revision: 0,
  selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary'), createWindowView('dock')] });
const receipt = (mutation: WindowMutation, window: WorkspaceWindow, code?: string): WindowOperationResult => ({
  operationId: mutation.operationId, status: code ? 'rejected' : 'committed', revision: window.revision,
  committedAt: 1, expiresAt: 100, ...(code ? { code, message: 'Rename is forbidden.' } : {}),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Window mutation recovery', () => {
  it.each(['operation', 'inspect'] as const)('does not interpret a %s authentication error as rejection of an already committed mutation', async failure => {
    let current = initial(), available = false;
    let committed!: WindowOperationResult;
    const mutate = vi.fn(async (_id: string, mutation: WindowMutation) => {
      current = applyWindowOperation(current, mutation.operation);
      committed = receipt(mutation, current);
      throw new Error('Reply was lost after commit.');
    });
    const client = {
      mutate,
      async operation() {
        if (!available && failure === 'operation') throw new WindowRequestError('Authentication expired.', 401);
        return committed;
      },
      async inspect() {
        if (!available && failure === 'inspect') throw new WindowRequestError('Authentication expired.', 401);
        return { window: current };
      },
    };
    const store = new WindowWorkspaceStore(initial(), client as unknown as WindowWorkspaceClient);
    try {
      const result = store.operate({ type: 'rename', title: 'Committed remotely' });
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      await store.retry();
      expect(current.title).toBe('Committed remotely');
      expect(store.getSnapshot().title).toBe('Committed remotely');
      expect(store.getSyncState()).toMatchObject({ state: 'offline', pending: 1 });
      expect(settled).toBe(false);
      available = true;
      await store.retry();
      await result;
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(store.getCommittedSnapshot()).toEqual(current);
      expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
    } finally { store.dispose(); }
  });

  it('keeps a recovered receipt pending until its snapshot reaches the receipt revision', async () => {
    let current = initial(), snapshot = current;
    let committed!: WindowOperationResult;
    const mutate = vi.fn(async (_id: string, mutation: WindowMutation) => {
      current = applyWindowOperation(current, mutation.operation);
      committed = receipt(mutation, current);
      throw new Error('Reply was lost after commit.');
    });
    const client = { mutate, async operation() { return committed; }, async inspect() { return { window: snapshot }; } };
    const store = new WindowWorkspaceStore(initial(), client as unknown as WindowWorkspaceClient);
    try {
      const result = store.operate({ type: 'rename', title: 'Confirmed title' });
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      await store.retry();
      expect(store.getSnapshot().title).toBe('Confirmed title');
      expect(store.getCommittedSnapshot()).toEqual(initial());
      expect(store.getSyncState()).toMatchObject({ state: 'error', pending: 1 });
      expect(settled).toBe(false);
      snapshot = current;
      await store.retry();
      await result;
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(store.getCommittedSnapshot()).toEqual(current);
    } finally { store.dispose(); }
  });

  it.each(['receipt', 'request'] as const)('starts a new save after the previous operation has settled with a %s rejection', async failure => {
    let current = initial();
    const mutate = vi.fn(async (_id: string, mutation: WindowMutation) => {
      if (mutation.operation.type === 'rename') {
        if (failure === 'request') throw new WindowRequestError('Rename is forbidden.', 403);
        return { window: current, result: receipt(mutation, current, 'rename_forbidden') };
      }
      current = applyWindowOperation(current, mutation.operation);
      return { window: current, result: receipt(mutation, current) };
    });
    const store = new WindowWorkspaceStore(initial(), { mutate } as unknown as WindowWorkspaceClient);
    try {
      await expect(store.operate({ type: 'rename', title: 'Rejected' })).rejects.toThrow('forbidden');
      await store.retry();
      expect(store.getSyncState()).toMatchObject({ state: 'error', pending: 0 });
      const result = store.operate({ type: 'view.resize', viewId: 'dock', width: 730 });
      await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 1 });
      await result;
      expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
      expect(store.getCommittedSnapshot().views[1]?.width).toBe(730);
    } finally { store.dispose(); }
  });

  it('drains a new edit enqueued by the previous caller while the background run is finishing', async () => {
    let current = initial();
    const mutate = vi.fn(async (_id: string, mutation: WindowMutation) => {
      if (mutation.operation.type === 'rename') throw new WindowRequestError('Rename is forbidden.', 403);
      current = applyWindowOperation(current, mutation.operation);
      return { window: current, result: receipt(mutation, current) };
    });
    const store = new WindowWorkspaceStore(initial(), { mutate } as unknown as WindowWorkspaceClient);
    try {
      const next = store.operate({ type: 'rename', title: 'Rejected' }).catch(() => store.operate({ type: 'view.resize', viewId: 'dock', width: 740 }));
      void next.catch(() => {});
      await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 1 });
      await next;
      expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
    } finally { store.dispose(); }
  });

  it('does not replay an unknown mutation if its Window was disposed while reading the receipt', async () => {
    const pendingReceipt = deferred<WindowOperationResult>();
    const mutation: WindowMutation = { operationId: 'restored-operation', issuedAt: Date.now(), baseRevision: 0, operation: { type: 'rename', title: 'Uncertain' } };
    const mutate = vi.fn(async () => { throw new Error('A closed Window must not dispatch.'); });
    const operation = vi.fn(() => pendingReceipt.promise);
    const store = new WindowWorkspaceStore(initial(), { mutate, operation } as unknown as WindowWorkspaceClient, undefined, undefined,
      { recovery: { version: 1, committed: initial(), edits: [{ operation: mutation.operation, revision: 0, mutation }] } });
    const saving = store.retry();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 1 });
    store.dispose();
    pendingReceipt.reject(new WindowRequestError('No receipt.', 404, 'operation_unknown'));
    await saving;
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(['future-base', 'non-head-mutation', 'orphan-uncertainty'] as const)('ignores malformed recovery with %s rather than dispatching it', async failure => {
    const mutation: WindowMutation = { operationId: 'invalid-recovery-operation', issuedAt: Date.now(), baseRevision: failure === 'future-base' ? 1 : 0, operation: { type: 'rename', title: 'Invalid restored title' } };
    const edit = { operation: mutation.operation, revision: 0, mutation };
    const edits = failure === 'non-head-mutation' ? [{ operation: { type: 'view.resize', viewId: 'dock', width: 600 }, revision: 0 }, edit]
      : failure === 'orphan-uncertainty' ? [{ operation: mutation.operation, revision: 0, uncertain: true }] : [edit];
    const mutate = vi.fn(), operation = vi.fn();
    const store = new WindowWorkspaceStore(initial(), { mutate, operation } as unknown as WindowWorkspaceClient, undefined, undefined,
      { recovery: { version: 1, committed: initial(), edits } });
    try {
      expect(store.getSnapshot()).toEqual(initial());
      expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
      await store.retry();
      expect(mutate).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    } finally { store.dispose(); }
  });
});

describe('Window saved-layout recovery', () => {
  async function blocked() {
    let current = initial();
    const mutate = vi.fn(async (_id: string, mutation: WindowMutation) => {
      if (mutation.operation.type === 'rename') throw new Error('Original result is no longer known.');
      current = applyWindowOperation(current, mutation.operation);
      return { window: current, result: receipt(mutation, current) };
    });
    const operation = vi.fn(async () => { throw new WindowRequestError('Receipt expired.', 410, 'operation_expired'); });
    const inspect = vi.fn(async () => ({ window: current }));
    const store = new WindowWorkspaceStore(initial(), { mutate, operation, inspect } as unknown as WindowWorkspaceClient);
    const original = store.operate({ type: 'rename', title: 'Unconfirmed title' });
    void original.catch(() => {});
    await store.retry();
    expect(store.getSyncState()).toMatchObject({ state: 'error', pending: 1 });
    return { store, original, mutate, operation, inspect };
  }

  it('restores the saved layout and settles only edits captured before inspection began', async () => {
    const server = await blocked();
    const inspection = deferred<{ window: WorkspaceWindow }>();
    server.inspect.mockImplementationOnce(() => inspection.promise);
    const discarded = expect(server.original).rejects.toThrow('discarded');
    try {
      const reset = server.store.discardPendingChanges();
      expect(server.store.discardPendingChanges()).toBe(reset);
      await vi.waitFor(() => expect(server.inspect).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 1 });
      const resize = server.store.operate({ type: 'view.resize', viewId: 'dock', width: 820 });
      expect(server.store.getSnapshot().views[1]?.width).toBe(820);
      await server.store.retry();
      expect(server.mutate).toHaveBeenCalledTimes(1);
      inspection.resolve({ window: initial() });
      await reset;
      await discarded;
      await resize;
      expect(server.store.getSnapshot()).toMatchObject({ title: 'Before', views: [{ id: 'main' }, { id: 'dock', width: 820 }] });
      expect(server.store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
      expect(server.mutate).toHaveBeenCalledTimes(2);
      expect(server.mutate.mock.calls[1]?.[1].operation).toEqual({ type: 'view.resize', viewId: 'dock', width: 820 });
    } finally { server.store.dispose(); }
  });

  it('does not discard local edits if the saved layout cannot be inspected', async () => {
    const server = await blocked();
    let settled = false;
    void server.original.then(() => { settled = true; }, () => { settled = true; });
    try {
      server.inspect.mockRejectedValueOnce(new WindowRequestError('Sign in again.', 401));
      await expect(server.store.discardPendingChanges()).rejects.toThrow('Sign in again');
      expect(settled).toBe(false);
      expect(server.store.getSnapshot().title).toBe('Unconfirmed title');
      expect(server.store.getSyncState()).toMatchObject({ state: 'error', pending: 1 });
      expect(server.mutate).toHaveBeenCalledTimes(1);
      const discarded = expect(server.original).rejects.toThrow('discarded');
      await server.store.discardPendingChanges();
      await discarded;
      expect(server.store.getSnapshot()).toEqual(initial());
      expect(server.store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
    } finally { server.store.dispose(); }
  });

  it('prevents a queued retry from dispatching while the saved-layout reset is running', async () => {
    const server = await blocked();
    try {
      const retry = server.store.retry();
      const reset = server.store.discardPendingChanges();
      await Promise.all([retry, reset]);
      expect(server.operation).toHaveBeenCalledTimes(1);
      expect(server.inspect).toHaveBeenCalledTimes(1);
      expect(server.mutate).toHaveBeenCalledTimes(1);
      expect(server.store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
    } finally { server.store.dispose(); }
  });

  it('does not adopt an inspection response after the Window has been disposed', async () => {
    const server = await blocked();
    const inspection = deferred<{ window: WorkspaceWindow }>();
    server.inspect.mockImplementationOnce(() => inspection.promise);
    const reset = server.store.discardPendingChanges();
    const rejected = expect(reset).rejects.toThrow('no longer active');
    await vi.waitFor(() => expect(server.inspect).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 1 });
    server.store.dispose();
    inspection.resolve({ window: initial() });
    await rejected;
    expect(server.store.getSnapshot().title).toBe('Unconfirmed title');
    expect(server.mutate).toHaveBeenCalledTimes(1);
  });

  it('only offers discarding when an unresolved save is blocked', async () => {
    const inspect = vi.fn();
    const store = new WindowWorkspaceStore(initial(), { inspect } as unknown as WindowWorkspaceClient);
    try {
      await expect(store.discardPendingChanges()).rejects.toThrow('Only blocked');
      expect(inspect).not.toHaveBeenCalled();
    } finally { store.dispose(); }
  });
});
