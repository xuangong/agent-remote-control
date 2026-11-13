import { getLayoutDiagnosticsStatus, recordWindowSelection } from './layout-diagnostics.js';
import {
  applyGroupOperation, decodeWindowGroup, hasBotAppearance, hasWindowAppearance, isWindowGroup, isWindowGroupMutation, isWindowGroupOperation, toWindowGroup,
  type WindowBots, type WindowGroup, type WindowGroupEdit, type WindowGroupMutation, type WindowGroupOperation, type WindowPresentation, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, type WindowCommit, type WindowWorkspaceClient } from '@orchardworks/agent-remote-web';

/** A value the store can read as a group: a Window, a group, or a Relay snapshot with its manager. */
export type WindowGroupSource = WorkspaceWindow | { window: WorkspaceWindow; bots?: WindowBots; presentation?: WindowPresentation; manager?: unknown };
export interface WindowSaveState { state: 'saved' | 'saving' | 'offline' | 'error'; pending: number; error?: string }
interface SavedEdit { operation: WindowGroupOperation; revision: number; mutation?: WindowGroupMutation; uncertain?: boolean }
export interface WindowWorkspaceRecovery { version: 2; committed: WindowGroup; edits: SavedEdit[] }
interface PendingEdit extends SavedEdit { done: Promise<void>; resolve(): void; reject(error: unknown): void }
interface Options { recovery?: unknown; persist?(value: WindowWorkspaceRecovery): void; autoRetry?: boolean; paused?: boolean }
const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const replacesLayout = (operation: WindowGroupOperation) => operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
function equivalent(first: WindowGroup, second: WindowGroup): boolean {
  return JSON.stringify({ ...first, window: { ...first.window, revision: 0 } }) === JSON.stringify({ ...second, window: { ...second.window, revision: 0 } });
}

/** An echo may already show a pending change; applying it a second time would be refused. */
function applied(group: WindowGroup, edit: WindowGroupEdit): boolean {
  switch (edit.type) {
    case 'view.create': return group.window.views.some(view => view.id === edit.view.id);
    case 'view.close': return !group.window.views.some(view => view.id === edit.viewId);
    case 'bots.add': return !!group.bots;
    case 'bots.remove': return !group.bots;
    case 'window.add': return hasWindowAppearance(group);
    case 'window.remove': return !hasWindowAppearance(group);
    case 'bots.hide': return !hasBotAppearance(group);
    case 'bots.show': return hasBotAppearance(group);
    default: return false;
  }
}
/** A subscription may echo a pending create/close before its receipt arrives. */
function project(source: WindowGroup, operation: WindowGroupOperation): WindowGroup {
  let result = source;
  for (const edit of operation.type === 'batch' ? operation.operations : [operation]) {
    if (applied(result, edit)) continue;
    result = applyGroupOperation(result, edit);
  }
  return { ...result, window: { ...result.window, revision: source.window.revision + 1 } };
}

function recovery(value: unknown, id: string): WindowWorkspaceRecovery | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as { version?: unknown; committed?: unknown; edits?: unknown };
  // Version 1 journals hold the Window alone; every one of them was written before the Bot appearance existed.
  if (saved.version !== 1 && saved.version !== 2) return;
  const committed = decodeWindowGroup(saved.committed);
  if (!committed || committed.window.id !== id || !Array.isArray(saved.edits)) return;
  const edits = saved.edits as SavedEdit[];
  if (!edits.every((edit, index) => edit && isWindowGroupOperation(edit.operation) && Number.isSafeInteger(edit.revision) && edit.revision >= 0
    && (edit.uncertain === undefined || typeof edit.uncertain === 'boolean') && (!edit.uncertain || !!edit.mutation)
    && (!edit.mutation || index === 0 && isWindowGroupMutation(edit.mutation) && edit.mutation.baseRevision <= committed.window.revision
      && JSON.stringify(edit.operation) === JSON.stringify(edit.mutation.operation)))) return;
  return copy({ version: 2, committed, edits });
}

/** Local layout is immediate; receipts and confirmed revisions belong to background persistence. */
export class WindowWorkspaceStore {
  private committed: WindowGroup;
  private snapshot: WindowGroup;
  private listeners = new Set<() => void>();
  private edits: PendingEdit[] = [];
  private running?: Promise<void>;
  private discarding?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private stopped = false;
  private paused: boolean;
  private sync: WindowSaveState = { state: 'saved', pending: 0 };
  constructor(initial: WindowGroupSource, private readonly client?: WindowWorkspaceClient, private readonly cache?: (window: WorkspaceWindow) => void,
    private readonly localCommit?: (source: WindowGroup, operation: WindowGroupOperation) => Promise<WindowGroup>, private readonly options: Options = {}) {
    const group = toWindowGroup(initial);
    const restored = recovery(options.recovery, group.window.id);
    this.committed = restored?.committed ?? group;
    this.snapshot = this.committed;
    this.paused = options.paused ?? false;
    this.edits = restored?.edits.map(edit => this.pending({ ...edit, uncertain: !!edit.mutation })) ?? [];
    this.rebuild();
    this.sync = { state: this.edits.length ? 'saving' : 'saved', pending: this.edits.length };
  }
  getSnapshot = () => this.snapshot.window;
  getCommittedSnapshot = () => this.committed.window;
  /** The group this store holds: the Window above with the appearances it is managed in. */
  getGroup = () => this.snapshot;
  getCommittedGroup = () => this.committed;
  getSyncState = () => this.sync;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private pending(saved: SavedEdit): PendingEdit {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Restored edits have no original caller, but still report failures through save state.
    void done.catch(() => {});
    return { ...saved, done, resolve, reject };
  }
  private publish(state: WindowSaveState['state'] = this.edits.length ? this.sync.state === 'offline' || this.sync.state === 'error' ? this.sync.state : 'saving' : 'saved', error?: string) {
    this.sync = { state, pending: this.edits.length, ...(error ? { error } : {}) };
    try { this.options.persist?.({ version: 2, committed: this.committed, edits: this.edits.map(({ operation, revision, mutation, uncertain }) => ({ operation, revision, ...(mutation ? { mutation } : {}), ...(uncertain ? { uncertain } : {}) })) }); }
    catch { this.sync = { ...this.sync, error: 'Local recovery storage is unavailable. Keep this page open until saving finishes.' }; }
    try { this.cache?.(this.snapshot.window); } catch { /* Cache failures never block rendering or remote persistence. */ }
    for (const listener of this.listeners) listener();
  }
  private rebuild() {
    let visible = this.committed;
    for (const edit of this.edits) {
      try { visible = project(visible, edit.operation); }
      catch { /* Preserve the request for settlement when its target changed remotely. */ }
    }
    if (JSON.stringify(visible) !== JSON.stringify(this.snapshot)) this.snapshot = visible;
  }
  private recordSelection(previous: WindowGroup, source: Parameters<typeof recordWindowSelection>[0]['source'], operation?: WindowGroupOperation) {
    if (!getLayoutDiagnosticsStatus().recording) return;
    const sameView = previous.window.selectedViewId === this.snapshot.window.selectedViewId;
    const before = previous.window.views.find(view => view.id === previous.window.selectedViewId)?.binding;
    const after = this.snapshot.window.views.find(view => view.id === this.snapshot.window.selectedViewId)?.binding;
    const bindingChanged = sameView && (!!before !== !!after || (['hostId', 'providerId', 'nativeSessionId', 'sessionIntent'] as const)
      .some(field => before?.[field] !== after?.[field]));
    if (sameView && !bindingChanged) return;
    recordWindowSelection({ source, previous: previous.window.views.findIndex(view => view.id === previous.window.selectedViewId),
      selected: this.snapshot.window.views.findIndex(view => view.id === this.snapshot.window.selectedViewId), revision: this.snapshot.window.revision,
      pending: this.edits.length, ...(bindingChanged ? { bindingChanged: true as const } : {}), ...(operation ? { operation: operation.type } : {}) }, this);
  }
  accept(value: WindowGroupSource) {
    const group = toWindowGroup(value);
    if (this.stopped || !isWindowGroup(group) || group.window.id !== this.committed.window.id || group.window.revision < this.committed.window.revision) return;
    const previous = this.snapshot;
    this.committed = group; this.rebuild(); this.recordSelection(previous, 'remote'); this.publish();
  }
  operate(operation: WindowGroupOperation): Promise<void> {
    try {
      if (this.stopped) throw new Error('This Window is no longer active in this account.');
      const next = applyGroupOperation(this.snapshot, operation);
      if (equivalent(this.snapshot, next)) return this.edits.at(-1)?.done ?? Promise.resolve();
      const first = this.edits.length === 0;
      const edit = this.pending({ operation: copy(operation), revision: replacesLayout(operation) ? this.committed.window.revision : this.snapshot.window.revision });
      const previous = this.snapshot;
      this.edits.push(edit); this.snapshot = next; this.recordSelection(previous, 'local', operation); this.publish(first ? 'saving' : undefined);
      if (this.sync.state !== 'offline' && this.sync.state !== 'error') void this.retry();
      return edit.done;
    } catch (error) { return Promise.reject(error); }
  }
  setEnabled(enabled: boolean) {
    this.paused = !enabled;
    if (enabled) void this.retry();
    else { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  }
  retry(): Promise<void> {
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    if (this.stopped || this.paused || this.discarding) return Promise.resolve();
    if (this.running) return this.running;
    const run = Promise.resolve().then(() => this.flush());
    this.running = run;
    void run.finally(() => {
      if (this.running !== run) return;
      this.running = undefined;
      if (this.edits.length && this.sync.state === 'saving') void this.retry();
    }).catch(() => {});
    return run;
  }
  /** Abandon queued local edits; this does not undo any operation already committed remotely. */
  discardPendingChanges(): Promise<void> {
    if (this.discarding) return this.discarding;
    if (this.stopped || !this.client || this.sync.state !== 'error' || !this.edits.length) {
      return Promise.reject(new Error('Only blocked local Window changes can be discarded.'));
    }
    const captured = new Set(this.edits);
    let restored = false;
    const task = Promise.resolve().then(async () => {
      // Do not inspect/reset while a prior dispatch or receipt recovery is still running.
      await this.running;
      this.ensureActive();
      const snapshot = await this.client!.inspect(this.committed.window.id);
      this.ensureActive();
      if (snapshot.window.revision >= this.committed.window.revision) this.committed = toWindowGroup(snapshot);
      const discarded = this.edits.filter(edit => captured.has(edit));
      this.edits = this.edits.filter(edit => !captured.has(edit));
      const previous = this.snapshot;
      this.rebuild(); this.recordSelection(previous, 'discarded'); this.publish(this.edits.length ? 'saving' : 'saved');
      for (const edit of discarded) edit.reject(new Error('Local Window changes were discarded in favor of the saved layout.'));
      restored = true;
    }).catch(error => {
      if (!this.stopped) this.publish('error', message(error));
      throw error;
    }).finally(() => {
      if (this.discarding === task) this.discarding = undefined;
      if (restored && this.edits.length) void this.retry();
    });
    this.discarding = task;
    return task;
  }
  private scheduleRetry() {
    if (!this.options.autoRetry || this.stopped || this.paused || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.retry(); }, Math.min(30000, 1000 * 2 ** Math.min(this.retryAttempt++, 5)));
  }
  private settle(edit: PendingEdit, error?: unknown) {
    const previous = this.snapshot;
    this.edits = this.edits.filter(item => item !== edit);
    this.rebuild(); this.recordSelection(previous, error ? 'rejected' : 'settled', edit.operation);
    this.publish(error ? 'error' : this.edits.length ? 'saving' : 'saved', error ? message(error) : undefined);
    if (error) edit.reject(error); else edit.resolve();
  }
  private ensureActive() {
    if (this.stopped) throw new Error('This Window is no longer active in this account.');
  }
  private async recover(edit: PendingEdit): Promise<WindowCommit> {
    this.ensureActive();
    const result = await this.client!.operation(this.committed.window.id, edit.mutation!.operationId);
    this.ensureActive();
    const snapshot = await this.client!.inspect(this.committed.window.id);
    // A receipt cannot confirm a layout that predates the operation it settled.
    if (result.revision > snapshot.window.revision) throw new WindowRequestError('Invalid Window receipt.', 200, 'invalid_window_receipt');
    return { ...snapshot, result };
  }
  private async send(edit: PendingEdit): Promise<WindowCommit> {
    const mutation = edit.mutation!;
    if (edit.uncertain) {
      try {
        return await this.recover(edit);
      } catch (error) {
        if (!(error instanceof WindowRequestError && error.code === 'operation_unknown')) throw error;
        // Replaying this exact identity is idempotent within the server's receipt retention.
      }
    }
    this.ensureActive();
    try { return await this.client!.mutate(this.committed.window.id, mutation); }
    catch (error) {
      if (error instanceof WindowRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      edit.uncertain = true;
      return this.recover(edit);
    }
  }
  private async flush(): Promise<void> {
    let conflicts = 0;
    while (this.edits.length && !this.stopped && !this.paused && !this.discarding) {
      const edit = this.edits[0]!;
      this.publish('saving');
      try {
        if (!edit.mutation) {
          if (replacesLayout(edit.operation) && edit.revision !== this.committed.window.revision) {
            throw new WindowRequestError('The Window changed before applying this layout. Refresh and retry.', 409, 'layout_changed');
          }
          const operation = edit.operation;
          if (operation.type === 'view.close' && !this.committed.window.views.some(view => view.id === operation.viewId)) { this.settle(edit); continue; }
          // Revalidate target preconditions after unrelated remote changes.
          try { applyGroupOperation(this.committed, edit.operation); }
          catch (error) { this.settle(edit, error); continue; }
          edit.mutation = { operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: this.committed.window.revision, operation: edit.operation };
          this.publish('saving');
        }
        if (!this.client) {
          const next = this.localCommit ? await this.localCommit(this.committed, edit.operation) : applyGroupOperation(this.committed, edit.operation);
          if (this.stopped) return;
          this.committed = next; this.settle(edit); continue;
        }
        const commit = await this.send(edit);
        if (this.stopped) return;
        if (commit.window.revision >= this.committed.window.revision) this.committed = toWindowGroup(commit);
        if (commit.result.status === 'rejected') {
          if (commit.result.code === 'revision_conflict' && !replacesLayout(edit.operation)) {
            edit.mutation = undefined; edit.uncertain = false;
            const previous = this.snapshot;
            this.rebuild(); this.recordSelection(previous, 'conflict', edit.operation); this.publish('saving');
            if (++conflicts >= 3) { this.publish('offline', 'The Window is changing on another page. Saving will retry.'); this.scheduleRetry(); return; }
            continue;
          }
          this.settle(edit, new Error(commit.result.message ?? 'Window operation rejected.')); continue;
        }
        this.retryAttempt = 0; this.settle(edit);
      } catch (error) {
        if (this.stopped) return;
        // A failed receipt/snapshot lookup says nothing about the original dispatch.
        const definitive = !edit.uncertain && error instanceof WindowRequestError && error.status >= 400 && error.status < 500
          && !['operation_unknown', 'operation_expired', 'operation_conflict', 'invalid_window_receipt'].includes(error.code ?? '')
          && error.status !== 408 && error.status !== 429;
        if (definitive || !this.client) { this.settle(edit, error); continue; }
        // An expired/invalid receipt cannot authorize a new request identity.
        const blocked = error instanceof WindowRequestError && ['operation_expired', 'operation_conflict', 'invalid_window_receipt'].includes(error.code ?? '');
        this.rebuild(); this.publish(blocked ? 'error' : 'offline', message(error));
        if (!blocked) this.scheduleRetry();
        return;
      }
    }
  }
  async synchronize(signal: AbortSignal): Promise<void> {
    if (!this.client) return;
    let initialized = false, failures = 0;
    while (!signal.aborted && !this.stopped) {
      try {
        const next = initialized ? await this.client.changes(this.committed.window.id, this.committed.window.revision, signal) : await this.client.inspect(this.committed.window.id, signal);
        if (signal.aborted || this.stopped) return;
        if (next) this.accept(next);
        initialized = true; failures = 0;
        void this.retry();
      } catch (error) {
        if (signal.aborted || this.stopped) return;
        if (error instanceof WindowRequestError && [401, 403, 404].includes(error.status)) throw error;
        initialized = false;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(10000, 250 * 2 ** Math.min(failures++, 6)));
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  dispose() {
    this.stopped = true; clearTimeout(this.retryTimer); this.retryTimer = undefined;
    for (const edit of this.edits) edit.reject(new Error('The Window page was closed before its background save settled.'));
    this.listeners.clear();
  }
}
