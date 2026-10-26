import { SESSION_STATE_STALE_MS, type SessionActivityState, type SessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';

export type SessionStatesFrame = Extract<SessionChannelServerMessage, { type: 'session_states' }>;
/** offline: the session's Host is not connected. unknown: no state confirmed recently enough to trust. */
export type SharedSessionState = SessionActivityState | 'unknown' | 'offline';
export interface SessionStateRef { hostId: string; providerId: string; nativeSessionId: string }
export interface SessionStatesView {
  state(session: SessionStateRef): { state: SharedSessionState; updatedAt?: number };
}

const key = (session: SessionStateRef) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

/**
 * The session states the Relay shares, in this page's clock. A state counts as long as its Host confirmed it within
 * SESSION_STATE_STALE_MS, by changing it or by confirming all its states; after that it reads as unknown.
 */
export class SessionStateStore {
  private readonly hosts = new Map<string, { online: boolean; confirmedAt?: number }>();
  private readonly entries = new Map<string, { state: SessionActivityState; updatedAt?: number; changedAt: number }>();
  private readonly listeners = new Set<(view: SessionStatesView) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  apply(frame: SessionStatesFrame): void {
    const at = this.now();
    if (frame.snapshot) { this.hosts.clear(); this.entries.clear(); }
    for (const host of frame.hosts ?? []) {
      this.hosts.set(host.hostId, { online: host.online, ...(host.confirmedAgeMs === undefined ? {} : { confirmedAt: at - host.confirmedAgeMs }) });
    }
    for (const { hostId, providerId, nativeSessionId, state, updatedAt, ageMs } of frame.states ?? []) {
      this.entries.set(key({ hostId, providerId, nativeSessionId }), { state, ...(updatedAt === undefined ? {} : { updatedAt }), changedAt: at - ageMs });
    }
    for (const removed of frame.removed ?? []) this.entries.delete(key(removed));
    this.notify();
  }

  view(): SessionStatesView {
    return { state: session => this.state(session) };
  }

  subscribe(listener: (view: SessionStatesView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearTimeout(this.timer); this.timer = undefined; } };
  }

  dispose(): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.listeners.clear(); this.hosts.clear(); this.entries.clear();
  }

  private state(session: SessionStateRef): { state: SharedSessionState; updatedAt?: number } {
    const host = this.hosts.get(session.hostId);
    if (!host) return { state: 'unknown' };
    if (!host.online) return { state: 'offline' };
    const entry = this.entries.get(key(session));
    if (!entry || this.now() - this.confirmedAt(entry, host) > SESSION_STATE_STALE_MS) return { state: 'unknown' };
    return { state: entry.state, ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }) };
  }

  private confirmedAt(entry: { changedAt: number }, host: { confirmedAt?: number }): number {
    return Math.max(entry.changedAt, host.confirmedAt ?? -Infinity);
  }

  private notify(): void {
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
    this.schedule();
  }

  /** Listeners learn when the next trusted state turns unknown. */
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.listeners.size) return;
    const at = this.now();
    let next = Infinity;
    for (const [id, entry] of this.entries) {
      const host = this.hosts.get((JSON.parse(id) as string[])[0]!);
      if (!host?.online) continue;
      const expiry = this.confirmedAt(entry, host) + SESSION_STATE_STALE_MS;
      if (expiry > at && expiry < next) next = expiry;
    }
    if (next !== Infinity) this.timer = setTimeout(() => this.notify(), next - at + 1);
  }
}
