import type { SessionChannelServerMessage, SessionDraft } from '@orchardworks/agent-remote-protocol';
import type { SessionStateRef } from './session-states.js';

export type SessionDraftsFrame = Extract<SessionChannelServerMessage, { type: 'session_drafts' }>;
/** A draft shared across devices: its text (empty once cleared) and the revision the Relay gave it. */
export interface SharedDraft { text: string; revision: number }
export interface SessionDraftsView {
  /** Whether the Relay's drafts have arrived; before then, no draft does not mean none exists. */
  loaded: boolean;
  draft(session: SessionStateRef): SharedDraft | undefined;
}

const key = (session: SessionStateRef) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

/** The account's drafts the Relay shares, plus the ones this page saved; a newer revision always wins. */
export class SessionDraftStore {
  private loaded = false;
  private readonly drafts = new Map<string, SharedDraft>();
  private readonly listeners = new Set<(view: SessionDraftsView) => void>();

  apply(frame: SessionDraftsFrame): void {
    if (frame.snapshot) { this.drafts.clear(); this.loaded = true; }
    for (const draft of frame.drafts) this.take(draft);
    this.notify();
  }

  /** A draft this page saved, known before its frame arrives. */
  accept(draft: SessionDraft): void {
    if (this.take(draft)) this.notify();
  }

  view(): SessionDraftsView {
    const drafts = new Map(this.drafts), loaded = this.loaded;
    return { loaded, draft: session => { const draft = drafts.get(key(session)); return draft && { ...draft }; } };
  }

  subscribe(listener: (view: SessionDraftsView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void { this.listeners.clear(); this.drafts.clear(); this.loaded = false; }

  private take(draft: SessionDraft): boolean {
    const id = key(draft), known = this.drafts.get(id);
    if (known && known.revision >= draft.revision) return false;
    this.drafts.set(id, { text: draft.text, revision: draft.revision });
    return true;
  }

  private notify(): void {
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }
}
