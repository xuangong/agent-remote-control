import { useId, useState } from 'react';
import { useTrackedSessionDrag } from '../hooks/useTrackedSessionDrag.js';
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
  const hintId = useId();
  const [announcement, setAnnouncement] = useState('');
  const reorder = (key: string, target: string, placement: 'before' | 'after') => {
    tracking.reorder(key, target, placement);
    const source = sessions.find(session => sessionKey(session) === key);
    const destination = sessions.find(session => sessionKey(session) === target);
    if (source && destination) setAnnouncement(`Moved ${source.title} ${placement} ${destination.title}.`);
  };
  const ordering = useTrackedSessionDrag(sessions.map(sessionKey), reorder);
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
        <p className="lab-control-note">Tracking on this client · Drag to reorder</p>
        <span id={hintId} className="agent-visually-hidden">Open a session with Enter. Drag a row to reorder; on touch screens use its grip. Alt plus Up or Down also changes its position.</span>
        {!sessions.length ? <p className="lab-control-note">{tracking.sessions.length ? 'The current session shows its status in the conversation.' : 'Choose Track in Favorites to watch a session here.'}</p> : null}
        <ul ref={ordering.list} className="lab-favorite-list lab-tracked-list">{sessions.map((session, index) => {
          const key = sessionKey(session), value = tracking.observations[key];
          return <li key={key} data-tracked-key={key} data-moving={ordering.drag?.key === key}
            data-drop={ordering.drag?.target?.key === key ? ordering.drag.target.placement : undefined}><div className="lab-tracked-row">
            <button type="button" className="lab-session-row" disabled={busy} title={session.title} aria-describedby={hintId} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onPointerDown={event => { if (sessions.length > 1) ordering.start(event, key); }}
              onClick={event => { if (event.detail > 0 && ordering.consumeClick()) return; close(); onOpen(session); }}
              onKeyDown={event => {
                if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const target = sessions[index + (event.key === 'ArrowUp' ? -1 : 1)];
                if (target) reorder(key, sessionKey(target), event.key === 'ArrowUp' ? 'before' : 'after');
              }}>
              <span className="lab-tracked-description"><strong className="agent-session-title" data-session-status={value?.activity ?? 'unknown'}>{session.title}</strong><small className="agent-session-title" data-session-status={value?.activity}>{observationLabel(value)} · {session.providerId}</small></span>
              {value?.changed ? <span className="lab-tracked-change" data-attention={value.attention} aria-label={`New status for ${session.title}`}><span aria-hidden="true" />New</span> : null}
              {sessions.length > 1 ? <span className="lab-tracked-grip" aria-hidden="true" title="Drag to reorder"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="3" r="1.2" /><circle cx="11" cy="3" r="1.2" /><circle cx="5" cy="8" r="1.2" /><circle cx="11" cy="8" r="1.2" /><circle cx="5" cy="13" r="1.2" /><circle cx="11" cy="13" r="1.2" /></svg></span> : null}
            </button>
          </div>{value?.error ? <p className="lab-control-note" role="alert">{value.error} <button type="button" onClick={() => tracking.retry(key)}>Retry tracking</button></p> : null}</li>;
        })}</ul>
        {tracking.error ? <p className="lab-control-note" role="alert">{tracking.error}</p> : null}
        <span className="agent-visually-hidden" role="status">{announcement}</span>
      </>}
    </SessionPopover>
    <span className="agent-visually-hidden" role="status">{changes ? `${changes} tracked session status changes. ${alertLabel}`.trim() : ''}</span>
  </div>;
}
