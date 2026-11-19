/**
 * State that belongs to a session target rather than to the component showing it. A view that is replaced (a stand-in pane giving way
 * to the Window's pane, a pane moving between docks) mounts the new composer in the same commit that unmounts the old one; both find
 * the same entry here, so the text and the waiting messages are not lost. An entry is dropped once no composer holds it any more.
 */
export class SharedByKey<T> {
  private readonly entries = new Map<string, { value: T; holders: number }>();
  /** The entry for `key`, created on first use. Safe to call while rendering. */
  get(key: string, create: () => T): T {
    let entry = this.entries.get(key);
    if (!entry) { entry = { value: create(), holders: 0 }; this.entries.set(key, entry); }
    return entry.value;
  }
  /** Keeps the entry while a mounted component uses it. The release drops it after the commit that unmounted the last holder. */
  hold(key: string): () => void {
    const entry = this.entries.get(key);
    if (!entry) return () => {};
    entry.holders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      queueMicrotask(() => { if (entry.holders === 0 && this.entries.get(key) === entry) this.entries.delete(key); });
    };
  }
  has(key: string): boolean { return this.entries.has(key); }
}
