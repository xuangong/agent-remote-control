import { useCallback, useSyncExternalStore } from 'react';
import { readDrafts, saveDrafts, recoveryGeneration } from './conversation-recovery.js';

/** Tab-local text recovery with subscriptions limited to the edited conversation. */
export class DraftStore {
  private readonly generation: number;
  private readonly drafts: Record<string, string>;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly scope: string) { this.drafts = readDrafts(scope); this.generation = recoveryGeneration(scope); }
  get(key: string): string { return this.drafts[key] ?? ''; }
  set(key: string, text: string): void {
    if (this.generation !== recoveryGeneration(this.scope) || this.get(key) === text) return;
    this.drafts[key] = text;
    saveDrafts(this.scope, this.drafts);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
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
