import type { OpenedSession } from '../directory-client.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

export function CollapsedConversations({ sessions, entries = [], offset, onExpand }: {
  sessions: readonly OpenedSession[]; entries?: readonly SessionEntry[]; offset: number; onExpand(session: OpenedSession): void;
}) {
  if (!sessions.length) return null;
  return <nav className="lab-collapsed-conversations" aria-label={offset === 0 ? 'Earlier windows' : 'Later windows'}>
    {sessions.map((session, index) => <button key={sessionKey(session)} type="button" className="lab-collapsed-window"
      title={session.title} aria-label={`Expand window ${offset + index + 1}: ${session.title}`} onClick={() => onExpand(session)}>
      <span className="lab-window-number">{offset + index + 1}</span>
      <span className="lab-collapsed-title agent-session-title" data-session-status={entries.find(entry => sessionKey(entry) === sessionKey(session))?.status}>{session.title}</span>
      <span aria-hidden="true">›</span>
    </button>)}
  </nav>;
}
