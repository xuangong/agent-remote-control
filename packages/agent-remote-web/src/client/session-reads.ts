import type { SessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';
import type { SessionStateRef } from './session-states.js';

export type SessionReadsFrame = Extract<SessionChannelServerMessage, { type: 'session_reads' }>;
export interface SessionReadsView {
  /** When the account started keeping read positions; undefined until it does. */
  since?: number;
  /** The time of the latest reply the owner has seen in a session. */
  readAt(session: SessionStateRef): number | undefined;
  /** Whether a reply produced at replyAt is unread: after the session's position, or after `since` without one. */
  unread(session: SessionStateRef, replyAt: number): boolean;
}

const key = (session: SessionStateRef) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

/** The account's read positions the Relay shares, plus the ones this page advanced and has not heard back about yet. */
export class SessionReadStore {
  private since: number | undefined;
  private readonly positions = new Map<string, number>();
  private readonly listeners = new Set<(view: SessionReadsView) => void>();

  apply(frame: SessionReadsFrame): void {
    if (frame.snapshot) this.positions.clear();
    if (frame.since !== undefined) this.since = frame.since;
    for (const read of frame.reads ?? []) this.raise(key(read), read.readAt);
    this.notify();
  }

  /** Advances a position on this page at once; false when it would not move forward. */
  advance(session: SessionStateRef, readAt: number): boolean {
    if (!this.raise(key(session), readAt)) return false;
    this.notify();
    return true;
  }

  view(): SessionReadsView {
    const since = this.since, positions = new Map(this.positions);
    return {
      ...(since === undefined ? {} : { since }),
      readAt: session => positions.get(key(session)),
      unread: (session, replyAt) => {
        if (since === undefined) return false;
        return replyAt > (positions.get(key(session)) ?? since);
      },
    };
  }

  subscribe(listener: (view: SessionReadsView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void { this.listeners.clear(); this.positions.clear(); this.since = undefined; }

  private raise(id: string, readAt: number): boolean {
    if ((this.positions.get(id) ?? -1) >= readAt) return false;
    this.positions.set(id, readAt);
    return true;
  }

  private notify(): void {
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }
}
