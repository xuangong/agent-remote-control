import { useCallback, useSyncExternalStore } from 'react';
import { readDraftsChecked, saveDrafts, recoveryGeneration, type CheckedDraftRead } from './conversation-recovery.js';
import { flushRecoveryWrites, type RecoveryWriteHandle, type RecoveryWriteResult } from './recovery-writes.js';

export interface DraftPersistenceState { revision: number; savedRevision: number; result?: RecoveryWriteResult }

/** Tab-local text recovery with subscriptions limited to the edited conversation. */
export class DraftStore {
  private readonly generation: number;
  private readonly drafts: Record<string, string>;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly persistenceListeners = new Set<() => void>();
  private readonly revisions = new Map<string, number>();
  private revision = 0;
  private savedRevision = 0;
  private latestWrite?: RecoveryWriteHandle;
  private result?: RecoveryWriteResult;
  private failed = false;
  private initialization: CheckedDraftRead;
  constructor(private readonly scope: string) {
    this.initialization = readDraftsChecked(scope);
    this.drafts = this.initialization.status === 'ready' ? this.initialization.drafts : {};
    this.generation = recoveryGeneration(scope);
  }
  inspect(key: string) {
    const current = this.generation === recoveryGeneration(this.scope);
    return { ...this.snapshot(key), status: !current ? 'cancelled' as const : this.initialization.status,
      persistence: this.persistence() };
  }
  retryRead(): boolean {
    if (this.generation !== recoveryGeneration(this.scope)) return false;
    const read = readDraftsChecked(this.scope);
    if (read.status !== 'ready') { this.initialization = read; return false; }
    for (const [key, value] of Object.entries(read.drafts)) if (!this.revisions.has(key)) {
      this.drafts[key] = value;
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
    this.initialization = read;
    if (this.revision) this.save();
    return true;
  }
  async flushCurrent(key: string, revision: number, isCurrent: () => boolean): Promise<RecoveryWriteResult> {
    const current = () => isCurrent() && this.generation === recoveryGeneration(this.scope) && this.snapshot(key).revision === revision;
    if (!current()) return { status: 'cancelled', ticket: 0 };
    if (this.initialization.status === 'failed') return { status: 'failed', ticket: 0, error: this.initialization.error, sessionWritten: false, localWritten: false };
    this.save(current);
    const write = this.latestWrite!;
    flushRecoveryWrites(`agent-remote:recovery:${this.scope}:drafts`);
    const result = await write.completion;
    return current() ? result : { status: 'cancelled', ticket: write.ticket };
  }
  get(key: string): string { return this.drafts[key] ?? ''; }
  set(key: string, text: string): void {
    if (this.generation !== recoveryGeneration(this.scope) || this.get(key) === text) return;
    this.drafts[key] = text;
    this.revisions.set(key, ++this.revision);
    this.save();
    for (const listener of this.listeners.get(key) ?? []) listener();
    if (this.failed) this.notifyPersistence();
  }
  snapshot(key: string): { text: string; revision: number } { return { text: this.get(key), revision: this.revisions.get(key) ?? 0 }; }
  persistence(): DraftPersistenceState { return { revision: this.revision, savedRevision: this.savedRevision, result: this.result }; }
  hasSaveError(key: string): boolean {
    return this.generation === recoveryGeneration(this.scope) && this.failed && (this.revisions.get(key) ?? 0) > this.savedRevision;
  }
  subscribePersistence(listener: () => void): () => void {
    this.persistenceListeners.add(listener);
    return () => { this.persistenceListeners.delete(listener); };
  }
  /** Explicit retries serialize current text, retaining the ordinary typing batch. */
  flush(): RecoveryWriteResult | undefined {
    if (this.generation !== recoveryGeneration(this.scope)) return;
    if (this.initialization.status === 'failed' && !this.retryRead()) { this.save(); return this.result; }
    if (!this.latestWrite) return this.result;
    if (this.latestWrite.result && this.latestWrite.result.status !== 'saved') this.save();
    flushRecoveryWrites(`agent-remote:recovery:${this.scope}:drafts`);
    return this.latestWrite!.result;
  }
  private save(isCurrent: () => boolean = () => true): void {
    if (this.initialization.status !== 'ready') {
      this.failed = true;
      this.result = { status: 'failed', ticket: 0, error: this.initialization.error, sessionWritten: false, localWritten: false };
      this.notifyPersistence();
      return;
    }
    const revision = this.revision;
    const handle = saveDrafts(this.scope, this.drafts, isCurrent);
    this.latestWrite = handle;
    void handle.completion.then(result => {
      if (this.generation !== recoveryGeneration(this.scope)) return;
      if (result.status === 'saved') this.savedRevision = Math.max(this.savedRevision, revision);
      if (this.latestWrite !== handle) return;
      this.result = result;
      const wasFailed = this.failed;
      if (result.status === 'saved') this.failed = false;
      else if (result.status === 'failed') this.failed = true;
      if (this.failed || wasFailed) this.notifyPersistence();
    });
  }
  private notifyPersistence(): void { for (const listener of this.persistenceListeners) listener(); }
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
}

export interface DraftBinding { store: DraftStore; key: string }
export function useBoundDraft(binding?: DraftBinding) {
  const store = binding?.store;
  const key = binding?.key ?? '';
  const subscribe = useCallback((listener: () => void) => store?.subscribe(key, listener) ?? (() => {}), [store, key]);
  const get = useCallback(() => store?.get(key), [store, key]);
  const text = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((value: string) => store?.set(key, value), [store, key]);
  return { text, set };
}
