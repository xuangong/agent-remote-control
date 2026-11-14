import { nativeSessionMissing, type DirectoryError } from './directory-client.js';
import { sessionKey } from './session-tree.js';

/** How long a page trusts a Host's report that a session is missing before it may ask again on its own. */
export const UNAVAILABLE_SESSION_MS = 10 * 60_000;

type Session = { hostId?: string; providerId: string; nativeSessionId: string };
export interface UnavailableSessions {
  /** The Host's report, while the session is remembered missing. */
  get(session: Session): DirectoryError | undefined;
  /** Remembers a session its Host reported missing (`native_session_unavailable`); other failures are not remembered. */
  remember(session: Session, error: unknown): void;
  /** An explicit Retry asks the Host again. */
  forget(session: Session): void;
  /** A Host that came back is asked again for every session it reported missing. */
  forgetHost(hostId: string): void;
}

const pages = new WeakMap<object, UnavailableSessions>();
const key = (session: Session) => sessionKey({ ...session, hostId: session.hostId ?? 'local' });

/**
 * Sessions a Host reported missing, remembered for one page (its transport), so that the views mounting, moving and
 * rendering around such a session do not ask its Host again each time: a conversation moving between Bot and Window
 * mode mounts anew, and before this every mount asked. Retry, the Host coming back, or ten minutes forget it.
 */
export function unavailableSessions(page: object): UnavailableSessions {
  let sessions = pages.get(page);
  if (sessions) return sessions;
  const missing = new Map<string, { hostId: string; error: DirectoryError; at: number }>();
  sessions = {
    get(session) {
      const id = key(session), entry = missing.get(id);
      if (!entry) return undefined;
      if (Date.now() - entry.at < UNAVAILABLE_SESSION_MS) return entry.error;
      missing.delete(id); return undefined;
    },
    remember(session, error) {
      if (!nativeSessionMissing(error)) return;
      missing.set(key(session), { hostId: session.hostId ?? 'local', error: error as DirectoryError, at: Date.now() });
    },
    forget(session) { missing.delete(key(session)); },
    forgetHost(hostId) { for (const [id, entry] of missing) if (entry.hostId === hostId) missing.delete(id); },
  };
  pages.set(page, sessions);
  return sessions;
}
