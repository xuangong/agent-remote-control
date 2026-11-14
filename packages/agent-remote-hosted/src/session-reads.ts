import { isSessionReadsRequest, SESSION_READ_LIMIT, type SessionRead, type SessionReads } from '@orchardworks/agent-remote-protocol';
import { MAX_SESSION_READS, type HostedRelayState, type RelayState, type SavedSessionRead } from './state.js';

export class SessionReadsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const sessionKey = (read: Pick<SessionRead, 'hostId' | 'providerId' | 'nativeSessionId'>) => JSON.stringify([read.hostId, read.providerId, read.nativeSessionId]);

/**
 * Each account's read positions: the time of the latest reply its owner has seen in each session, shared by every
 * device. They only advance. An account starts keeping them (`since`) with its first request.
 */
export function createSessionReads(state: RelayState, now: () => number = Date.now) {
  /** Each account's view of one committed collection of positions; committed collections never change. */
  const views = new WeakMap<object, Map<string, SessionRead[]>>();
  function positions(snapshot: HostedRelayState, subject: string): SessionRead[] {
    const saved = snapshot.sessionReads;
    if (!saved) return [];
    let bySubject = views.get(saved);
    if (!bySubject) {
      bySubject = new Map();
      for (const { subject: owner, ...read } of saved) { const list = bySubject.get(owner) ?? []; list.push(read); bySubject.set(owner, list); }
      views.set(saved, bySubject);
    }
    return bySubject.get(subject) ?? [];
  }
  function read(subject: string): SessionReads {
    const snapshot = state.read();
    const since = snapshot.sessionReadAccounts?.find(account => account.subject === subject)?.since;
    return { ...(since === undefined ? {} : { since }), reads: positions(snapshot, subject).map(position => ({ ...position })) };
  }
  /** Whether the request starts the account or advances a position, judged against a state. */
  function advances(snapshot: HostedRelayState, subject: string, reads: readonly SessionRead[]) {
    if (!snapshot.sessionReadAccounts?.some(account => account.subject === subject)) return true;
    const known = new Map(positions(snapshot, subject).map(position => [sessionKey(position), position.readAt]));
    return reads.some(position => (known.get(sessionKey(position)) ?? -1) < position.readAt);
  }
  return {
    read,
    async mark(subject: string, body: unknown): Promise<SessionReads> {
      if (!isSessionReadsRequest(body)) throw new SessionReadsError(400, 'invalid_reads', 'Read positions need a session identity and a time.');
      if (!advances(state.read(), subject, body.reads)) return read(subject);
      await state.mutate(draft => {
        const accounts = draft.sessionReadAccounts ??= [];
        if (!accounts.some(account => account.subject === subject)) {
          if (accounts.length >= 4096) throw new SessionReadsError(409, 'read_accounts_limit', 'Read positions are unavailable for more accounts.');
          accounts.push({ subject, since: now() });
        }
        const saved = draft.sessionReads ??= [];
        const own = new Map<string, SavedSessionRead>();
        for (const position of saved) if (position.subject === subject) own.set(sessionKey(position), position);
        for (const position of body.reads) {
          const known = own.get(sessionKey(position));
          if (known) { if (known.readAt < position.readAt) known.readAt = position.readAt; continue; }
          // Positions are kept on a best-effort basis: past the Relay's limit, a new one is not kept.
          if (saved.length >= MAX_SESSION_READS) continue;
          const added = { subject, ...position };
          saved.push(added); own.set(sessionKey(position), added);
        }
        if (own.size > SESSION_READ_LIMIT) {
          const dropped = new Set([...own.values()].sort((a, b) => a.readAt - b.readAt).slice(0, own.size - SESSION_READ_LIMIT).map(position => sessionKey(position)));
          draft.sessionReads = saved.filter(position => position.subject !== subject || !dropped.has(sessionKey(position)));
        }
      });
      return read(subject);
    },
  };
}
