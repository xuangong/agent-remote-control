import type { OutboxEntry, SessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';
import type { SessionStateRef } from './session-states.js';

export type SessionOutboxFrame = Extract<SessionChannelServerMessage, { type: 'session_outbox' }>;
export interface SessionOutboxView {
  /** Whether the Relay's outbox has arrived; before then, no message does not mean none waits. */
  loaded: boolean;
  /** A session's messages that wait for its Host, in the order they were sent. */
  entries(session: SessionStateRef): OutboxEntry[];
  all(): OutboxEntry[];
}

const key = (session: SessionStateRef) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

/** The account's outbox the Relay shares, plus what this page queued, retried or cancelled before the Relay said so. */
export class SessionOutboxStore {
  private loaded = false;
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly listeners = new Set<(view: SessionOutboxView) => void>();

  apply(frame: SessionOutboxFrame): void {
    if (frame.snapshot) { this.entries.clear(); this.loaded = true; }
    for (const entry of frame.entries) this.entries.set(entry.id, { ...entry });
    for (const id of frame.removed ?? []) this.entries.delete(id);
    this.notify();
  }

  accept(entry: OutboxEntry): void { this.entries.set(entry.id, { ...entry }); this.notify(); }
  remove(id: string): void { if (this.entries.delete(id)) this.notify(); }

  view(): SessionOutboxView {
    const entries = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), loaded = this.loaded;
    const bySession = new Map<string, OutboxEntry[]>();
    for (const entry of entries) { const list = bySession.get(key(entry)) ?? []; list.push(entry); bySession.set(key(entry), list); }
    return { loaded, entries: session => (bySession.get(key(session)) ?? []).map(entry => ({ ...entry })), all: () => entries.map(entry => ({ ...entry })) };
  }

  subscribe(listener: (view: SessionOutboxView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void { this.listeners.clear(); this.entries.clear(); this.loaded = false; }

  private notify(): void {
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }
}
