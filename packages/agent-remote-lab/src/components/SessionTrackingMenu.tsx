import { SessionCatchUpRing } from './SessionCatchUpRing.js';
import type { SessionCatchUp } from '../hooks/useSessionCatchUp.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
import type { SessionStar } from '../session-stars-client.js';
import { sessionKey } from '../session-tree.js';
import { observationLabel } from '../tracking-state.js';
import { SessionPopover } from './SessionPopover.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';

const activityGroups = [
  { status: 'running', label: 'Working', activities: ['running'] },
  { status: 'waiting', label: 'Pending', activities: ['waiting', 'starting'] },
  { status: 'idle', label: 'Idle', activities: ['idle'] },
  { status: 'failed', label: 'Failed', activities: ['failed'] },
  { status: 'closed', label: 'Closed', activities: ['closed'] },
  { status: 'unknown', label: 'Status unavailable', activities: ['unknown'] },
];

export function SessionTrackingMenu({ tracking, catchUp, busy, inert, onOpen }: { catchUp?: SessionCatchUp; tracking: SessionTracking; busy: boolean; inert: boolean; onOpen(session: SessionStar): void }) {
  const { root, style, handlers } = useTrackingPosition();
  const sessions = tracking.backgroundSessions;
  const counts = activityGroups.map(group => ({ ...group,
    count: sessions.filter(session => group.activities.includes(tracking.observations[sessionKey(session)]?.activity ?? 'unknown')).length,
  })).filter(group => group.count > 0);
  const changes = sessions.filter(session => tracking.observations[sessionKey(session)]?.changed).length;
  const reminders = sessions.map(session => tracking.observations[sessionKey(session)]).filter(value => value?.connection === 'ready');
  const alert = reminders.some(value => value?.attention === 'pending') ? 'pending'
    : reminders.some(value => value?.attention === 'idle') ? 'idle' : undefined;
  const alertLabel = alert === 'pending' ? 'New pending sessions need attention.' : alert === 'idle' ? 'A working session is now idle.' : '';
  const attention = sessions.some(session => ['waiting', 'failed'].includes(tracking.observations[sessionKey(session)]?.activity ?? ''));
  return <div ref={root} style={style} {...handlers} className="lab-tracking-floating" data-attention={attention} data-alert={alert} {...(inert ? { inert: '' } : {})}>
    <SessionPopover label="Tracked sessions" triggerTitle={`${alertLabel ? `${alertLabel} ` : ''}Drag to move, or focus and use arrow keys`} trigger={<><SessionCatchUpRing value={catchUp} /><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg><span className="lab-tracking-counts">{counts.length ? counts.map(group => <span key={group.status} className="lab-tracking-count agent-session-title" data-session-status={group.status} title={`${group.label}: ${group.count}`} aria-label={`${group.count} ${group.label.toLowerCase()} sessions`}>{group.count}</span>) : <span className="lab-tracking-count" title="No background sessions">0</span>}</span>{changes ? <span className="lab-tracking-badge" aria-label={`${changes} session status changes`} /> : attention ? <span className="lab-tracking-attention" aria-label="A tracked session needs attention" /> : null}</>}>
      {close => <>
        <p className="lab-control-note">Tracking on this client</p>
        {!sessions.length ? <p className="lab-control-note">{tracking.sessions.length ? 'The current session shows its status in the conversation.' : 'Choose Track in Favorites to watch a session here.'}</p> : null}
        <ul className="lab-favorite-list">{sessions.map(session => {
          const key = sessionKey(session), value = tracking.observations[key];
          return <li key={key}><div className="lab-tracked-row">
            <button type="button" className="lab-session-row" disabled={busy} onClick={() => { close(); onOpen(session); }}><strong className="agent-session-title" data-session-status={value?.activity ?? 'unknown'}>{session.title}</strong><small className="agent-session-title" data-session-status={value?.activity}>{observationLabel(value)} · {session.providerId}</small></button>
            {value?.changed ? <button type="button" className="lab-tracked-change" data-attention={value.attention}
              aria-label={`New status for ${session.title}. Mark as seen`} title={`${observationLabel(value)}. Mark as seen`}
              onClick={event => {
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.lab-session-row')?.focus();
                tracking.acknowledge(key);
              }}><span aria-hidden="true" />New</button> : null}
          </div>{value?.error ? <p className="lab-control-note" role="alert">{value.error} <button type="button" onClick={() => tracking.retry(key)}>Retry tracking</button></p> : null}</li>;
        })}</ul>
        {tracking.error ? <p className="lab-control-note" role="alert">{tracking.error}</p> : null}
      </>}
    </SessionPopover>
    <span className="agent-visually-hidden" role="status">{changes ? `${changes} tracked session status changes. ${alertLabel}`.trim() : ''}</span>
  </div>;
}
