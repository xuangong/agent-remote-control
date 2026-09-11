import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';

export function CollapsedConversations({ sessions, offset, onExpand }: {
  sessions: readonly OpenedSession[]; offset: number; onExpand(session: OpenedSession): void;
}) {
  if (!sessions.length) return null;
  return <nav className="lab-collapsed-conversations" aria-label={offset === 0 ? 'Earlier windows' : 'Later windows'}>
    {sessions.map((session, index) => <button key={sessionKey(session)} type="button" className="lab-collapsed-window"
      title={session.title} aria-label={`Expand window ${offset + index + 1}: ${session.title}`} onClick={() => onExpand(session)}>
      <span className="lab-window-number">{offset + index + 1}</span>
      <span className="lab-collapsed-title">{session.title}</span>
      <span aria-hidden="true">›</span>
    </button>)}
  </nav>;
}
