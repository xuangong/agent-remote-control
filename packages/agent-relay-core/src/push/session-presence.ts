/**
 * Which sessions the visible pages of each account show: the Relay's knowledge that a push would tell the person nothing new.
 *
 * A page shows a session while one of its streams of the session's conversation is open (a subscription of the session channel in
 * `session` observation, the content `journal_shown` counts) and in use: the page reports a subscription out of use when it stops showing
 * the conversation or when the page is hidden (the channel's intent reports), so a phone that locks or leaves the app stops showing it at
 * once, and a page that is gone stops showing it when its socket closes. A channel without intent reports counts its open streams.
 * Pure state; the session channel adds and releases the streams.
 */
export interface PresenceSession { readonly hostId: string; readonly providerId: string; readonly nativeSessionId: string }

const keyOf = (session: PresenceSession) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

export type SessionPresence = ReturnType<typeof createSessionPresence>;

export function createSessionPresence() {
  const streams = new Map<string, Map<object, { key: string; inUse(): boolean }>>();
  return {
    /** A page's stream of the session's conversation, which shows it while `inUse()`; the returned function releases it. */
    add(subject: string, session: PresenceSession, inUse: () => boolean): () => void {
      const token = {};
      let own = streams.get(subject);
      if (!own) streams.set(subject, own = new Map());
      own.set(token, { key: keyOf(session), inUse });
      const held = own;
      return () => {
        held.delete(token);
        if (!held.size && streams.get(subject) === held) streams.delete(subject);
      };
    },
    /** Whether a visible page of the account shows the session's conversation now. */
    shows(subject: string, session: PresenceSession): boolean {
      const key = keyOf(session);
      for (const stream of streams.get(subject)?.values() ?? []) if (stream.key === key && stream.inUse()) return true;
      return false;
    },
  };
}
