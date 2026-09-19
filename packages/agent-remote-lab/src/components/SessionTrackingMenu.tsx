import type { SessionTracking } from '../hooks/useSessionTracking.js';
import type { SessionStar } from '../session-stars-client.js';
import { sessionKey } from '../session-tree.js';
import { observationLabel } from '../tracking-state.js';
import { SessionPopover } from './SessionPopover.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';

export function SessionTrackingMenu({ tracking, busy, inert, onOpen }: { tracking: SessionTracking; busy: boolean; inert: boolean; onOpen(session: SessionStar): void }) {
  const { root, style, handlers } = useTrackingPosition();
  const sessions = tracking.backgroundSessions;
  const changes = sessions.filter(session => tracking.observations[sessionKey(session)]?.changed).length;
  const attention = sessions.some(session => ['waiting', 'failed'].includes(tracking.observations[sessionKey(session)]?.activity ?? ''));
  return <div ref={root} style={style} {...handlers} className="lab-tracking-floating" data-attention={attention} {...(inert ? { inert: '' } : {})}>
    <SessionPopover label="Tracked sessions" triggerTitle="Drag to move, or focus and use arrow keys" trigger={<><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg><span className="lab-tracking-count">{sessions.length}</span>{changes ? <span className="lab-tracking-badge" aria-label={`${changes} session status changes`}>{changes}</span> : attention ? <span className="lab-tracking-attention" aria-label="A tracked session needs attention" /> : null}</>} onOpen={tracking.acknowledge}>
      {close => <>
        <p className="lab-control-note">Tracking on this client</p>
        {!sessions.length ? <p className="lab-control-note">{tracking.sessions.length ? 'The current session shows its status in the conversation.' : 'Choose Track in Favorites to watch a session here.'}</p> : null}
        <ul className="lab-favorite-list">{sessions.map(session => {
          const key = sessionKey(session), value = tracking.observations[key];
          return <li key={key}><div className="lab-tracked-row">
            <button type="button" className="lab-session-row" disabled={busy} onClick={() => { close(); onOpen(session); }}><strong>{session.title}</strong><small className="agent-session-title" data-session-status={value?.activity}>{observationLabel(value)} · {session.providerId}</small></button>
            <button type="button" aria-label={`Untrack ${session.title}`} onClick={() => tracking.toggle(session)}>×</button>
          </div>{value?.error ? <p className="lab-control-note" role="alert">{value.error} <button type="button" onClick={() => tracking.retry(key)}>Retry tracking</button></p> : null}</li>;
        })}</ul>
        {tracking.error ? <p className="lab-control-note" role="alert">{tracking.error}</p> : null}
      </>}
    </SessionPopover>
    <span className="agent-visually-hidden" role="status">{changes ? `${changes} tracked session status changes` : ''}</span>
  </div>;
}
