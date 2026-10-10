import { useCallback, useSyncExternalStore } from 'react';
import { readDrafts, saveDrafts, recoveryGeneration } from './conversation-recovery.js';
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
  constructor(private readonly scope: string) { this.drafts = readDrafts(scope); this.generation = recoveryGeneration(scope); }
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
    if (this.generation !== recoveryGeneration(this.scope) || !this.latestWrite) return;
    if (this.latestWrite.result && this.latestWrite.result.status !== 'saved') this.save();
    flushRecoveryWrites(`agent-remote:recovery:${this.scope}:drafts`);
    return this.latestWrite!.result;
  }
  private save(): void {
    const revision = this.revision;
    const handle = saveDrafts(this.scope, this.drafts);
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
