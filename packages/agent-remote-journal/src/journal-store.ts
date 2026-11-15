import type { JournalChanges, JournalItem, JournalMeta, JournalState } from './types.js';

/** Persists journals incrementally: the store applies the changes a journal hands out. */
export interface JournalStore {
  load(sessionKey: string): Promise<JournalState | undefined>;
  apply(changes: JournalChanges): Promise<void>;
  delete(sessionKey: string): Promise<void>;
}

export class MemoryJournalStore implements JournalStore {
  private readonly sessions = new Map<string, { meta: JournalMeta; items: Map<string, JournalItem> }>();

  async load(sessionKey: string): Promise<JournalState | undefined> {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    const items = [...session.items.values()].map(item => structuredClone(item)).sort((left, right) => left.seqStart - right.seqStart);
    return { meta: structuredClone(session.meta), items };
  }

  async apply(changes: JournalChanges): Promise<void> {
    const existing = this.sessions.get(changes.meta.sessionKey);
    const items = existing && !changes.replaced ? existing.items : new Map<string, JournalItem>();
    for (const item of changes.upsert) items.set(item.itemKey, structuredClone(item));
    this.sessions.set(changes.meta.sessionKey, { meta: structuredClone(changes.meta), items });
  }

  async delete(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }
}
